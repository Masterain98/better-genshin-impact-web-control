// ============================================================================
// Service Worker —— 扩展控制中心（计划书 1.2.1）
// 职责：
//   - 绑定/解绑云原神标签页，管理 sessionId
//   - 建立并维护「控制通道」WebSocket（JSON）
//   - chrome.debugger 附加与 CDP 输入派发
//   - 创建/管理 Offscreen Document（媒体处理与帧通道）
//   - 心跳、状态机、生命周期监控、断线安全释放（ReleaseAll）
// ============================================================================

import {
  PROTOCOL_VERSION, EXTENSION_VERSION, CLOUD_GENSHIN_URL_PATTERN,
  SessionState, INPUT_ALLOWED_STATES, Channel, CAPABILITIES,
  MsgIn, MsgOut, OffscreenCmd, OffscreenEvt, UiCmd, ContentMsg,
  generateSessionId,
} from '../common/protocol.js';
import { loadConfig, buildWsUrl } from '../common/config.js';
import { viewportGeometryChanged } from '../common/coordinate.js';
import { RingLogger } from '../common/logger.js';
import { CdpInput } from './cdp-input.js';

const log = new RingLogger('SW');
const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

/** 全局会话（首期：单会话）。 */
const session = {
  state: SessionState.DISCONNECTED,
  sessionId: null,
  tabId: null,
  token: '',
  config: null,
  /** @type {import('../common/coordinate.js').GameViewport|null} */
  viewport: null,
  viewportRevision: 0,
  /** @type {CdpInput|null} */
  cdp: null,
  /** @type {WebSocket|null} */
  ws: null,
  lastInputSequence: -1,
  heartbeatTimer: null,
  viewportTimer: null,
  heartbeatMissed: 0,
  lastFrameSequence: 0,
  captureStats: null,
  lastError: null,
  connecting: false,
};

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

function setState(next, reason) {
  if (session.state === next) return;
  log.info(`state: ${session.state} -> ${next}${reason ? ' (' + reason + ')' : ''}`);
  session.state = next;
  broadcastStatus();
}

// 基础放行：状态允许 + CDP 已附加。键盘等不依赖坐标的输入用此判断。
function inputAllowed() {
  return INPUT_ALLOWED_STATES.has(session.state) && !!session.cdp?.attached;
}

// 鼠标类需要可用视口几何（有效或有整页回退尺寸）。
function mouseInputAllowed() {
  const vp = session.viewport;
  return inputAllowed() && !!vp && vp.cssWidth > 0 && vp.cssHeight > 0;
}

// ---------------------------------------------------------------------------
// 连接主流程（计划书 1.4 标签页绑定流程）
// ---------------------------------------------------------------------------

async function connect() {
  if (session.connecting || session.state !== SessionState.DISCONNECTED) {
    return { ok: false, error: 'already active' };
  }
  session.connecting = true;
  try {
    const tab = await getActiveCloudTab();
    if (!tab) throw new Error('当前标签页不是云原神页面');

    session.config = await loadConfig();
    session.token = session.config.token || '';
    session.sessionId = generateSessionId();
    session.tabId = tab.id;
    session.viewportRevision = 0;
    session.lastInputSequence = -1;
    session.lastFrameSequence = 0;
    session.lastError = null;
    setState(SessionState.CONNECTING, 'user connect');

    // 1) 附加调试器（若上次会话遗留了附加状态，先释放，避免 "already attached"）
    //    suppressDetach：本扩展主动解绑期间不让 onDetach 监听器重启/中断会话
    session.suppressDetach = true;
    try {
      if (session.cdp && session.cdp.attached) {
        try { await session.cdp.detach(); } catch { /* 忽略 */ }
      }
      session.cdp = new CdpInput(tab.id, log);
      await session.cdp.attach();
    } finally {
      session.suppressDetach = false;
    }

    // 2) 获取标签页几何（视口）
    await refreshViewport(true);

    // 3) 申请 tabCapture 媒体流 ID（必须在 SW 内、由用户手势触发）
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

    // 4) 创建 Offscreen 并启动捕获 + 帧通道
    await ensureOffscreen();
    await sendToOffscreen(OffscreenCmd.START, {
      streamId,
      sessionId: session.sessionId,
      token: session.token,
      wsUrl: buildWsUrl(session.config),
      config: session.config,
      viewport: session.viewport,
      viewportRevision: session.viewportRevision,
    });
    setState(SessionState.CAPTURING, 'offscreen started');

    // 5) 建立控制通道 WebSocket 并握手
    await openControlWs();

    return { ok: true, sessionId: session.sessionId };
  } catch (e) {
    log.error('connect failed:', e?.message || e);
    session.lastError = String(e?.message || e);
    await stop('connect failed');
    return { ok: false, error: session.lastError };
  } finally {
    session.connecting = false;
  }
}

// ---------------------------------------------------------------------------
// 控制通道 WebSocket
// ---------------------------------------------------------------------------

function openControlWs() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const url = buildWsUrl(session.config);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return reject(e);
    }
    session.ws = ws;

    ws.onopen = () => {
      log.info('control ws open', url);
      sendControl({
        type: MsgOut.HELLO,
        channel: Channel.CONTROL,
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: EXTENSION_VERSION,
        sessionId: session.sessionId,
        token: session.token,
        browser: 'Chrome',
        browserVersion: navigator.userAgent,
        capabilities: CAPABILITIES,
      });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === MsgIn.HELLO_ACK) {
        if (!settled) { settled = true; resolve(); }
      }
      handleControlMessage(msg);
    };

    ws.onerror = (e) => {
      log.error('control ws error', e?.message || 'error');
      if (!settled) { settled = true; reject(new Error('无法连接 BetterGI 本地服务')); }
    };

    ws.onclose = () => {
      log.warn('control ws closed');
      if (!settled) { settled = true; reject(new Error('BetterGI 连接被关闭')); }
      onControlWsClosed();
    };

    // 连接超时
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        reject(new Error('连接 BetterGI 超时'));
      }
    }, 5000);
  });
}

function sendControl(obj) {
  const ws = session.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

async function onControlWsClosed() {
  stopHeartbeat();
  stopViewportPolling();
  // WebSocket 断开 -> ReleaseAll，进入断开状态（计划书 1.9）
  if (session.state !== SessionState.DISCONNECTED && session.state !== SessionState.STOPPING) {
    await safeReleaseAll('control ws closed');
    setState(SessionState.DISCONNECTED, 'control ws closed');
  }
}

// ---------------------------------------------------------------------------
// 处理 BetterGI 下发的控制消息（计划书 4.5）
// ---------------------------------------------------------------------------

async function handleControlMessage(msg) {
  switch (msg.type) {
    case MsgIn.HELLO_ACK:
      onHelloAck(msg);
      return;
    case MsgIn.PING:
      sendControl({ type: MsgOut.HEARTBEAT, sessionId: session.sessionId, pong: true });
      return;
    case MsgIn.START_CAPTURE:
      setState(SessionState.RUNNING, 'start_capture');
      return;
    case MsgIn.STOP_CAPTURE:
      setState(SessionState.SUSPENDED, 'stop_capture');
      return;
    case MsgIn.UPDATE_CONFIG:
      if (msg.config) {
        session.config = { ...session.config, ...msg.config };
        sendToOffscreen(OffscreenCmd.UPDATE_CONFIG, { config: session.config });
      }
      return;
    case MsgIn.RELEASE_ALL:
      await safeReleaseAll('release_all cmd');
      sendControl({ type: MsgOut.RELEASE_ALL_ACK, sessionId: session.sessionId });
      return;
    case MsgIn.SHUTDOWN_SESSION:
      await stop('shutdown_session');
      return;
    default:
      // 输入类消息
      await handleInputMessage(msg);
  }
}

function onHelloAck(msg) {
  if (msg.accepted === false) {
    log.error('handshake rejected:', msg.error);
    session.lastError = 'handshake rejected: ' + (msg.error || '');
    stop('handshake rejected');
    return;
  }
  // 应用 BetterGI 协商结果
  if (msg.logicalWidth) session.config.logicalWidth = msg.logicalWidth;
  if (msg.logicalHeight) session.config.logicalHeight = msg.logicalHeight;
  if (msg.targetFps) session.config.targetFps = msg.targetFps;
  sendToOffscreen(OffscreenCmd.UPDATE_CONFIG, { config: session.config });

  setState(SessionState.INPUT_READY, 'hello_ack');
  startHeartbeat();
  startViewportPolling();
}

// 定期用 CDP 复测视口（游戏可能在握手后才加载出 video/iframe）。
function startViewportPolling() {
  stopViewportPolling();
  session.viewportTimer = setInterval(() => { refreshViewport(false); }, 2000);
}

function stopViewportPolling() {
  if (session.viewportTimer) {
    clearInterval(session.viewportTimer);
    session.viewportTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 输入消息 -> CDP（含会话/序号/版本校验，计划书 4.7）
// ---------------------------------------------------------------------------

const INPUT_TYPES = new Set([
  MsgIn.KEY_EVENT, MsgIn.MOUSE_CLICK, MsgIn.MOUSE_MOVE_ABSOLUTE,
  MsgIn.MOUSE_MOVE_RELATIVE, MsgIn.MOUSE_DRAG, MsgIn.MOUSE_WHEEL,
  MsgIn.MOUSE_DOWN, MsgIn.MOUSE_UP,
]);

async function handleInputMessage(msg) {
  if (!INPUT_TYPES.has(msg.type)) return;

  // 会话隔离校验
  if (msg.sessionId && msg.sessionId !== session.sessionId) {
    log.warn('drop input: sessionId mismatch', msg.sessionId);
    return;
  }
  // 序号防重放/防倒退
  if (typeof msg.sequence === 'number') {
    if (msg.sequence <= session.lastInputSequence) {
      log.warn('drop input: stale sequence', msg.sequence);
      return;
    }
    session.lastInputSequence = msg.sequence;
  }
  // 视口版本校验（拖拽等要求匹配，计划书 2.8）
  if (typeof msg.viewportRevision === 'number' && msg.viewportRevision !== session.viewportRevision) {
    log.warn('drop input: viewportRevision mismatch', msg.viewportRevision, 'cur', session.viewportRevision);
    sendControl({ type: MsgOut.SESSION_ERROR, sessionId: session.sessionId, error: 'viewport_revision_mismatch' });
    return;
  }
  if (!inputAllowed()) {
    log.warn('drop input: state not ready', session.state, 'cdp', !!session.cdp?.attached);
    return;
  }
  const isMouse = msg.type !== MsgIn.KEY_EVENT;
  if (isMouse && !mouseInputAllowed()) {
    log.warn('drop mouse input: viewport unavailable', JSON.stringify(session.viewport));
    return;
  }

  const cdp = session.cdp;
  const vp = session.viewport;
  try {
    switch (msg.type) {
      case MsgIn.KEY_EVENT: await cdp.handleKeyEvent(msg); break;
      case MsgIn.MOUSE_CLICK: await cdp.handleMouseClick(msg, vp); break;
      case MsgIn.MOUSE_MOVE_ABSOLUTE: await cdp.handleMouseMoveAbsolute(msg, vp); break;
      case MsgIn.MOUSE_MOVE_RELATIVE:
        await cdp.handleMouseMoveRelative(msg, vp, session.config.relativeMouseScaleX, session.config.relativeMouseScaleY);
        break;
      case MsgIn.MOUSE_DRAG:
        await cdp.handleMouseDrag(msg, vp, () => msg.viewportRevision != null && msg.viewportRevision !== session.viewportRevision);
        break;
      case MsgIn.MOUSE_WHEEL: await cdp.handleMouseWheel(msg, vp); break;
      case MsgIn.MOUSE_DOWN: await cdp.handleMouseDown(msg, vp); break;
      case MsgIn.MOUSE_UP: await cdp.handleMouseUp(msg, vp); break;
    }
    // 输入确认（可选）
    if (msg.sequence != null) {
      sendControl({ type: MsgOut.INPUT_STATUS, sessionId: session.sessionId, ackSequence: msg.sequence });
    }
  } catch (e) {
    log.error('input dispatch failed:', msg.type, e?.message || e);
    sendControl({ type: MsgOut.SESSION_ERROR, sessionId: session.sessionId, error: 'input_failed', detail: String(e?.message || e) });
  }
}

// ---------------------------------------------------------------------------
// 心跳（计划书 4.8）
// ---------------------------------------------------------------------------

function startHeartbeat() {
  stopHeartbeat();
  session.heartbeatMissed = 0;
  const interval = session.config.heartbeatMs || 1000;
  session.heartbeatTimer = setInterval(() => {
    const snap = session.cdp?.snapshotPressed() || { pressedKeys: [], pressedButtons: [] };
    const ok = sendControl({
      type: MsgOut.HEARTBEAT,
      sessionId: session.sessionId,
      captureState: session.captureStats?.state || 'unknown',
      inputState: inputAllowed() ? 'ready' : 'not_ready',
      lastFrameSequence: session.lastFrameSequence,
      pressedKeys: snap.pressedKeys,
      viewportRevision: session.viewportRevision,
    });
    if (!ok) {
      session.heartbeatMissed++;
      if (session.heartbeatMissed >= (session.config.heartbeatMiss || 3)) {
        log.error('heartbeat lost, stopping');
        stop('heartbeat lost');
      }
    } else {
      session.heartbeatMissed = 0;
    }
  }, interval);
}

function stopHeartbeat() {
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 视口（Content Script 提供几何，SW 维护 revision）
// ---------------------------------------------------------------------------

async function refreshViewport(initial = false) {
  if (session.tabId == null) return;
  let geom = null;

  // 优先用 CDP 查询（可拿到 iframe 矩形，游戏常在 iframe 内且 Content Script 可能拿不到）
  if (session.cdp?.attached) {
    geom = await session.cdp.queryViewport();
  }
  // 回退：Content Script（顶层页面）
  if (!geom || !geom.valid) {
    try {
      const g2 = await chrome.tabs.sendMessage(session.tabId, { type: ContentMsg.GET_VIEWPORT });
      if (g2 && (g2.valid || !geom)) geom = g2;
    } catch (e) {
      log.warn('content getViewport failed:', e?.message || e);
    }
  }
  applyViewport(geom, initial);
}

function applyViewport(geom, initial = false) {
  const vp = normalizeViewport(geom);
  const changed = initial || viewportGeometryChanged(session.viewport, vp);
  if (changed) {
    session.viewportRevision++;
    vp.revision = session.viewportRevision;
    session.viewport = vp;
    sendToOffscreen(OffscreenCmd.UPDATE_VIEWPORT, { viewport: vp, viewportRevision: session.viewportRevision });
    sendControl({
      type: MsgOut.VIEWPORT_CHANGED,
      sessionId: session.sessionId,
      viewportRevision: session.viewportRevision,
      viewport: vp,
    });
    log.info('viewport updated rev', session.viewportRevision, vp.valid ? 'valid' : 'INVALID');
  } else {
    vp.revision = session.viewportRevision;
    session.viewport = vp;
  }
}

function normalizeViewport(geom) {
  const cfg = session.config || {};
  const g = geom || {};
  return {
    revision: session.viewportRevision,
    logicalWidth: cfg.logicalWidth || 1920,
    logicalHeight: cfg.logicalHeight || 1080,
    cssLeft: g.cssLeft || 0,
    cssTop: g.cssTop || 0,
    cssWidth: g.cssWidth || g.innerWidth || 0,
    cssHeight: g.cssHeight || g.innerHeight || 0,
    innerWidth: g.innerWidth || 0,
    innerHeight: g.innerHeight || 0,
    devicePixelRatio: g.devicePixelRatio || 1,
    videoWidth: g.videoWidth || 0,
    videoHeight: g.videoHeight || 0,
    fullscreen: !!g.fullscreen,
    valid: !!g.valid,
  };
}

// ---------------------------------------------------------------------------
// Offscreen 管理（计划书 1.2.2）
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  const has = await hasOffscreen();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: '持续消费 tabCapture 媒体流并向 BetterGI 传输画面帧。',
  });
}

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  return false;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (e) { log.warn('closeOffscreen', e?.message || e); }
  }
}

function sendToOffscreen(cmd, payload) {
  return chrome.runtime.sendMessage({ target: 'offscreen', cmd, payload }).catch(() => { /* offscreen 可能未就绪 */ });
}

// ---------------------------------------------------------------------------
// 停止与安全释放
// ---------------------------------------------------------------------------

async function safeReleaseAll(reason) {
  log.info('ReleaseAll:', reason);
  try { await session.cdp?.releaseAll(); } catch (e) { log.warn('releaseAll err', e?.message || e); }
}

async function stop(reason) {
  if (session.state === SessionState.DISCONNECTED && !session.cdp && !session.ws) return;
  setState(SessionState.STOPPING, reason);
  stopHeartbeat();
  stopViewportPolling();

  // 通知 BetterGI（连接关闭前尽力发送）
  sendControl({ type: MsgOut.SESSION_ERROR, sessionId: session.sessionId, error: 'stopping', reason: reason || '' });

  await safeReleaseAll(reason || 'stop');

  try { await session.cdp?.detach(); } catch (e) { log.warn(e?.message || e); }
  session.cdp = null;

  await sendToOffscreen(OffscreenCmd.STOP, {});
  await closeOffscreen();

  if (session.ws) {
    try { session.ws.close(); } catch { /* noop */ }
    session.ws = null;
  }

  session.tabId = null;
  session.sessionId = null;
  session.viewport = null;
  session.captureStats = null;
  setState(SessionState.DISCONNECTED, reason);
}

// ---------------------------------------------------------------------------
// 生命周期监控（计划书 1.4）
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === session.tabId) {
    log.warn('bound tab removed');
    stop('tab removed');
  }
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  if (removed === session.tabId) {
    log.warn('bound tab replaced');
    stop('tab replaced');
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== session.tabId) return;
  if (changeInfo.status === 'loading' && changeInfo.url) {
    // 页面导航：可能离开游戏页
    if (!CLOUD_GENSHIN_URL_PATTERN.test(changeInfo.url)) {
      log.warn('bound tab navigated away from cloud genshin');
      stop('tab navigated away');
    } else {
      // 刷新/内部导航：暂停任务，等待重新绑定（计划书 1.9）
      setState(SessionState.SUSPENDED, 'tab reloading');
      safeReleaseAll('tab reloading');
    }
  }
  if (changeInfo.status === 'complete' && session.state === SessionState.SUSPENDED) {
    // 重新确认视口
    setTimeout(() => refreshViewport(true), 500);
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === session.tabId) {
    // 仅标记「未附加」；是否中断由下方逻辑决定
    if (session.cdp) session.cdp.attached = false;
    // 主动 detach（stop / connect 重试 / 重连清理）期间不触发中断，避免自相矛盾地重启会话
    if (session.suppressDetach ||
        session.state === SessionState.STOPPING ||
        session.state === SessionState.DISCONNECTED) {
      log.info('debugger detached (本扩展主动解绑或正在拆除)，忽略中断');
      return;
    }
    log.warn('debugger detached (外部):', reason);
    sendControl({ type: MsgOut.DEBUGGER_DETACHED, sessionId: session.sessionId, reason });
    // DevTools 抢占等导致 detach：立即停止输入（计划书 1.9 / 2.3.2）
    stop('debugger detached: ' + reason);
  }
});

// ---------------------------------------------------------------------------
// 消息路由（Popup / Content / Offscreen）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 来自 Offscreen 的事件
  if (message && message.source === 'offscreen') {
    handleOffscreenEvent(message);
    return false;
  }
  // 来自 Content Script 的主动上报：仅作为"页面可能变化"的信号，
  // 用 CDP 在顶层 frame 重新测量（避免 iframe 内上报的相对坐标污染）。
  if (message && message.type === ContentMsg.VIEWPORT_REPORT) {
    if (sender.tab && sender.tab.id === session.tabId) refreshViewport(false);
    return false;
  }
  if (message && message.type === ContentMsg.PAGE_STATE) {
    if (sender.tab && sender.tab.id === session.tabId) {
      sendControl({ type: MsgOut.TAB_STATUS, sessionId: session.sessionId, ...message.state });
    }
    return false;
  }
  // 来自 Popup 的命令
  if (message && message.cmd) {
    handleUiCommand(message, sendResponse);
    return true; // 异步响应
  }
  return false;
});

function handleOffscreenEvent(message) {
  switch (message.evt) {
    case OffscreenEvt.CAPTURE_STATUS:
      session.captureStats = message.stats;
      session.lastFrameSequence = message.stats?.lastFrameSequence || session.lastFrameSequence;
      broadcastStatus();
      break;
    case OffscreenEvt.VIDEO_STALLED:
      log.warn('video stalled');
      sendControl({ type: MsgOut.VIDEO_STALLED, sessionId: session.sessionId });
      setState(SessionState.RECOVERING, 'video stalled');
      break;
    case OffscreenEvt.VIDEO_RESUMED:
      log.info('video resumed');
      if (session.state === SessionState.RECOVERING) {
        setState(SessionState.INPUT_READY, 'video resumed');
      }
      break;
    case OffscreenEvt.VIDEO_ENDED:
      log.warn('video track ended');
      stop('video ended');
      break;
    case OffscreenEvt.FRAME_WS_OPEN:
      log.info('frame ws open');
      break;
    case OffscreenEvt.FRAME_WS_CLOSED:
      log.warn('frame ws closed');
      break;
    case OffscreenEvt.ERROR:
      log.error('offscreen error:', message.error);
      session.lastError = message.error;
      break;
  }
}

async function handleUiCommand(message, sendResponse) {
  try {
    switch (message.cmd) {
      case UiCmd.GET_STATUS:
        sendResponse(getStatus());
        break;
      case UiCmd.CONNECT: {
        const r = await connect();
        sendResponse(r);
        break;
      }
      case UiCmd.STOP:
        await stop('user stop');
        sendResponse({ ok: true });
        break;
      case UiCmd.RELEASE_ALL:
        await safeReleaseAll('user releaseAll');
        sendResponse({ ok: true });
        break;
      case UiCmd.RECALIBRATE:
        await refreshViewport(true);
        sendResponse({ ok: true, viewport: session.viewport });
        break;
      case UiCmd.GET_LOGS:
        sendResponse({ ok: true, logs: log.dump() });
        break;
      case UiCmd.EXPORT_DIAGNOSTICS:
        sendResponse({ ok: true, diagnostics: buildDiagnostics() });
        break;
      default:
        sendResponse({ ok: false, error: 'unknown cmd' });
    }
  } catch (e) {
    log.error('ui cmd failed:', message.cmd, e?.message || e);
    sendResponse({ ok: false, error: String(e?.message || e) });
  }
}

// ---------------------------------------------------------------------------
// 状态 / 诊断
// ---------------------------------------------------------------------------

function getStatus() {
  const snap = session.cdp?.snapshotPressed() || { pressedKeys: [], pressedButtons: [] };
  return {
    state: session.state,
    sessionId: session.sessionId,
    tabId: session.tabId,
    connected: session.state !== SessionState.DISCONNECTED,
    cdpAttached: !!session.cdp?.attached,
    viewportRevision: session.viewportRevision,
    viewport: session.viewport,
    captureStats: session.captureStats,
    lastFrameSequence: session.lastFrameSequence,
    pressed: snap,
    lastError: session.lastError,
    config: session.config ? { host: session.config.host, port: session.config.port, targetFps: session.config.targetFps } : null,
  };
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ source: 'sw', evt: 'status', status: getStatus() }).catch(() => { /* 无 popup 监听 */ });
}

function buildDiagnostics() {
  return {
    extensionVersion: EXTENSION_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    userAgent: navigator.userAgent,
    status: getStatus(),
    logs: log.dump(),
  };
}

async function getActiveCloudTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !CLOUD_GENSHIN_URL_PATTERN.test(tab.url)) return null;
  return tab;
}

log.info('service worker loaded, ext', EXTENSION_VERSION, 'proto', PROTOCOL_VERSION);
