// ============================================================================
// Offscreen Document —— 持续性媒体处理（计划书 1.2.2 / 1.5 / 1.6 / 1.7 / 1.8）
//   - 消费 tabCapture 媒体流
//   - 将视频帧绘制到 OffscreenCanvas，裁剪游戏区域并缩放至逻辑尺寸
//   - 编码 JPEG/WebP，通过「帧通道」WebSocket 发送二进制帧
//   - 背压：仅保留最新帧；统计捕获/编码/发送/丢弃帧数与冻结时间
// ============================================================================

import {
  Channel, Codec, CodecMime, PROTOCOL_VERSION, EXTENSION_VERSION,
  MsgOut, OffscreenCmd, OffscreenEvt, buildFrameMessage,
} from '../common/protocol.js';
import { cssRectToCapture } from '../common/coordinate.js';
import { RingLogger } from '../common/logger.js';

const log = new RingLogger('OFF');
const videoEl = document.getElementById('video');

const state = {
  running: false,
  sessionId: null,
  token: '',
  wsUrl: '',
  config: null,
  viewport: null,
  viewportRevision: 0,

  stream: null,
  track: null,
  ws: null,

  canvas: null,
  ctx: null,

  frameSequence: 0,
  sending: false,           // 是否有一帧正在编码/发送（背压门闩）
  captureTimer: null,

  lastSentTime: 0,
  lastFrameOkTime: 0,
  stalled: false,

  // 每秒统计
  stats: { captured: 0, encoded: 0, sent: 0, dropped: 0 },
  statsTimer: null,
  lastEncodedBytes: 0,
};

// ---------------------------------------------------------------------------
// 与 Service Worker 的消息
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.target !== 'offscreen') return;
  switch (message.cmd) {
    case OffscreenCmd.START: start(message.payload); break;
    case OffscreenCmd.STOP: stop(); break;
    case OffscreenCmd.UPDATE_VIEWPORT:
      state.viewport = message.payload.viewport;
      state.viewportRevision = message.payload.viewportRevision;
      break;
    case OffscreenCmd.UPDATE_CONFIG:
      state.config = { ...state.config, ...message.payload.config };
      restartCaptureTimer();
      break;
  }
});

function emit(evt, extra) {
  chrome.runtime.sendMessage({ source: 'offscreen', evt, ...extra }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function start(p) {
  try {
    stop(); // 清理旧会话
    state.sessionId = p.sessionId;
    state.token = p.token || '';
    state.wsUrl = p.wsUrl;
    state.config = p.config;
    state.viewport = p.viewport;
    state.viewportRevision = p.viewportRevision || 0;
    state.frameSequence = 0;
    state.tickErrorReported = false;

    // 1) 获取媒体流（tab 源）
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: p.streamId,
        },
      },
    });
    state.track = state.stream.getVideoTracks()[0];
    state.track.addEventListener('ended', () => {
      log.warn('video track ended');
      emit(OffscreenEvt.VIDEO_ENDED);
      stop();
    });

    videoEl.srcObject = state.stream;
    await videoEl.play().catch(() => {});

    // 2) 准备画布（逻辑尺寸）
    state.canvas = new OffscreenCanvas(state.config.logicalWidth, state.config.logicalHeight);
    state.ctx = state.canvas.getContext('2d', { alpha: false, desynchronized: true });

    // 3) 连接帧通道 WebSocket
    openFrameWs();

    // 4) 启动捕获定时器与统计
    state.running = true;
    state.lastFrameOkTime = performance.now();
    restartCaptureTimer();
    startStatsTimer();

    emit(OffscreenEvt.CAPTURE_STARTED);
    log.info('capture started, session', state.sessionId);
  } catch (e) {
    log.error('start failed:', e?.message || e);
    emit(OffscreenEvt.ERROR, { error: String(e?.message || e) });
    stop();
  }
}

function stop() {
  state.running = false;
  if (state.captureTimer) { clearInterval(state.captureTimer); state.captureTimer = null; }
  if (state.statsTimer) { clearInterval(state.statsTimer); state.statsTimer = null; }
  if (state.track) { try { state.track.stop(); } catch {} state.track = null; }
  if (state.stream) { try { state.stream.getTracks().forEach((t) => t.stop()); } catch {} state.stream = null; }
  videoEl.srcObject = null;
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  state.sending = false;
}

// ---------------------------------------------------------------------------
// 帧通道 WebSocket
// ---------------------------------------------------------------------------

function openFrameWs() {
  const ws = new WebSocket(state.wsUrl);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  ws.onopen = () => {
    // 帧通道握手
    ws.send(JSON.stringify({
      type: MsgOut.HELLO,
      channel: Channel.FRAME,
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: EXTENSION_VERSION,
      sessionId: state.sessionId,
      token: state.token,
    }));
    emit(OffscreenEvt.FRAME_WS_OPEN);
  };
  ws.onclose = () => { emit(OffscreenEvt.FRAME_WS_CLOSED); };
  ws.onerror = () => { emit(OffscreenEvt.ERROR, { error: 'frame ws error' }); };
}

// ---------------------------------------------------------------------------
// 捕获循环
// ---------------------------------------------------------------------------

function restartCaptureTimer() {
  if (state.captureTimer) clearInterval(state.captureTimer);
  const fps = Math.max(1, Math.min(30, state.config?.targetFps || 15));
  state.captureTimer = setInterval(() => { captureTick(); }, Math.round(1000 / fps));
}

async function captureTick() {
  if (!state.running || !state.track) return;

  // 视频尚未就绪
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) { checkStall(); return; }

  state.stats.captured++;

  // 背压：上一帧仍在发送则丢弃本帧（只保留最新帧，计划书 1.8）
  if (state.sending) { state.stats.dropped++; return; }

  // 帧通道未就绪
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) { return; }
  if (ws.bufferedAmount > (state.config.sendBufferHighWaterMark || 512 * 1024)) {
    state.stats.dropped++;
    return;
  }

  state.sending = true;
  try {
    // 计算裁剪区域
    const vp = state.viewport;
    let crop;
    if (vp && vp.valid) {
      crop = cssRectToCapture(vp, vw, vh);
    } else {
      crop = { left: 0, top: 0, width: vw, height: vh };
    }

    const lw = state.config.logicalWidth;
    const lh = state.config.logicalHeight;
    if (state.canvas.width !== lw || state.canvas.height !== lh) {
      state.canvas.width = lw;
      state.canvas.height = lh;
    }

    state.ctx.drawImage(videoEl, crop.left, crop.top, crop.width, crop.height, 0, 0, lw, lh);

    const codec = state.config.codec ?? Codec.WEBP;
    const blob = await state.canvas.convertToBlob({
      type: CodecMime[codec] || 'image/webp',
      quality: state.config.quality ?? 0.8,
    });
    const payload = new Uint8Array(await blob.arrayBuffer());
    state.stats.encoded++;
    state.lastEncodedBytes = payload.byteLength;

    state.frameSequence++;
    const buf = buildFrameMessage({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: state.sessionId,
      frameSequence: state.frameSequence,
      captureTimestamp: Date.now(),
      width: lw,
      height: lh,
      codec,
      viewportRevision: state.viewportRevision,
      payload,
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(buf);
      state.stats.sent++;
      state.lastSentTime = performance.now();
      state.lastFrameOkTime = performance.now();
      if (state.stalled) {
        state.stalled = false;
        emit(OffscreenEvt.VIDEO_RESUMED); // 通知 SW 从 Recovering 恢复
      }
    }
  } catch (e) {
    log.error('captureTick failed:', e?.message || e);
    // 首次异常上报给 SW，便于 Popup/诊断包定位（避免每帧刷屏）
    if (!state.tickErrorReported) {
      state.tickErrorReported = true;
      emit(OffscreenEvt.ERROR, { error: 'captureTick: ' + String(e?.message || e) });
    }
  } finally {
    state.sending = false;
    checkStall();
  }
}

function checkStall() {
  const timeout = state.config?.frameTimeoutMs || 2000;
  if (!state.stalled && performance.now() - state.lastFrameOkTime > timeout) {
    state.stalled = true;
    log.warn('video stalled (no frame for', timeout, 'ms)');
    emit(OffscreenEvt.VIDEO_STALLED);
  }
}

// ---------------------------------------------------------------------------
// 每秒统计与 capture_status 上报（计划书 1.7 控制消息 / 1.8）
// ---------------------------------------------------------------------------

function startStatsTimer() {
  if (state.statsTimer) clearInterval(state.statsTimer);
  state.statsTimer = setInterval(() => {
    const s = state.stats;
    const stats = {
      state: state.running ? (state.stalled ? 'stalled' : 'running') : 'stopped',
      fps: s.sent,
      capturedFps: s.captured,
      encodedFps: s.encoded,
      droppedFps: s.dropped,
      lastFrameSequence: state.frameSequence,
      lastFrameBytes: state.lastEncodedBytes,
      wsBuffered: state.ws ? state.ws.bufferedAmount : 0,
      sourceWidth: videoEl.videoWidth,
      sourceHeight: videoEl.videoHeight,
      logicalWidth: state.config?.logicalWidth,
      logicalHeight: state.config?.logicalHeight,
      viewportRevision: state.viewportRevision,
    };

    // 上报给 SW（用于 popup 展示与心跳）
    emit(OffscreenEvt.CAPTURE_STATUS, { stats });

    // 同时通过帧通道发送 capture_status 给 BetterGI
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: MsgOut.CAPTURE_STATUS,
        sessionId: state.sessionId,
        ...stats,
      }));
    }

    // 重置计数
    state.stats = { captured: 0, encoded: 0, sent: 0, dropped: 0 };
  }, 1000);
}

emit(OffscreenEvt.READY);
log.info('offscreen loaded');
