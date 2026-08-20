// ============================================================================
// BGI Web Cloud Bridge —— 可行性测试服务端（临时替代 BetterGI 的 BrowserBridgeServer）
//
// 作用：端到端验证 Chrome 扩展的画面捕获与 CDP 输入是否可行，不改动 BetterGI。
//
//   扩展(control+frame WS, /bridge) ──▶ demo server ──▶ 网页查看器(/viewer)  [看画面]
//   网页查看器 ──▶ demo server ──▶ 扩展 control 连接 ──▶ CDP 注入          [发指令]
//
// 仅监听回环地址 127.0.0.1。零第三方依赖，直接 `node server.js` 运行。
// ============================================================================

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { attachWebSocket } = require('./lib/miniws');
const { parseFrame, packForViewer } = require('./lib/frame');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 51888);
const PROTOCOL_VERSION = 1;

// 会话状态（首期单会话）
const state = {
  /** @type {import('./lib/miniws').WsConnection|null} 扩展控制通道 */
  control: null,
  /** @type {import('./lib/miniws').WsConnection|null} 扩展帧通道 */
  frame: null,
  /** @type {Set<import('./lib/miniws').WsConnection>} 网页查看器连接 */
  viewers: new Set(),

  sessionId: null,
  viewportRevision: 0,
  inputSequence: 0,

  stats: { framesFromExt: 0, bytesFromExt: 0, inputsToExt: 0 },
};

// ---------------------------------------------------------------------------
// 静态 HTTP（提供网页查看器）
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, 'public', path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// WebSocket 路由
// ---------------------------------------------------------------------------

attachWebSocket(httpServer, (conn, req) => {
  const p = (req.url || '/').split('?')[0];
  if (p === '/viewer') {
    onViewerConnected(conn);
  } else {
    // /bridge：等待首条 hello 判断 channel
    onBridgeConnected(conn);
  }
});

// ---------------------------------------------------------------------------
// 扩展侧连接
// ---------------------------------------------------------------------------

function onBridgeConnected(conn) {
  conn.channel = null;

  conn.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBridgeBinary(conn, data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleBridgeJson(conn, msg);
  });

  conn.on('close', () => {
    if (conn === state.control) {
      log('control', '扩展控制通道断开');
      state.control = null;
      broadcastViewer({ type: 'bridge_status', control: false });
    }
    if (conn === state.frame) {
      log('frame', '扩展帧通道断开');
      state.frame = null;
      broadcastViewer({ type: 'bridge_status', frame: false });
    }
  });

  conn.on('error', () => { /* 交由 close 处理 */ });
}

function handleBridgeJson(conn, msg) {
  // 首条 hello：认领通道并回 hello_ack
  if (msg.type === 'hello') {
    conn.channel = msg.channel || 'control';
    state.sessionId = msg.sessionId || state.sessionId;

    if (conn.channel === 'control') {
      state.control = conn;
      state.inputSequence = 0;
      log('control', `扩展握手 session=${msg.sessionId} caps=${(msg.capabilities || []).join(',')}`);
    } else {
      state.frame = conn;
      log('frame', `帧通道握手 session=${msg.sessionId}`);
    }

    // 回 hello_ack（控制通道必须；帧通道也回，无害）
    conn.sendText(JSON.stringify({
      type: 'hello_ack',
      protocolVersion: PROTOCOL_VERSION,
      bgiVersion: 'demo-0.1.0',
      accepted: true,
      logicalWidth: 1920,
      logicalHeight: 1080,
      targetFps: 15,
      frameCodec: 'webp',
    }));

    broadcastViewer({
      type: 'bridge_status',
      control: !!state.control,
      frame: !!state.frame,
      sessionId: state.sessionId,
    });
    return;
  }

  // 记录视口版本，供输入指令注入
  if (msg.type === 'viewport_changed' && typeof msg.viewportRevision === 'number') {
    state.viewportRevision = msg.viewportRevision;
  }
  if (msg.type === 'heartbeat' && typeof msg.viewportRevision === 'number') {
    state.viewportRevision = msg.viewportRevision;
  }

  // 其它状态/心跳消息：转发给查看器用于观察
  broadcastViewer({ type: 'ext_message', payload: msg });
}

function handleBridgeBinary(conn, buf) {
  const frame = parseFrame(buf);
  if (!frame) { log('frame', '无法解析的二进制帧，长度=' + buf.length); return; }
  state.stats.framesFromExt++;
  state.stats.bytesFromExt += frame.payload.length;

  // 转发画面给所有查看器
  const meta = {
    type: 'frame',
    codec: frame.codec,
    mime: frame.mime,
    seq: frame.frameSequence,
    ts: frame.captureTimestamp,
    width: frame.width,
    height: frame.height,
    viewportRevision: frame.viewportRevision,
    ageMs: Date.now() - frame.captureTimestamp,
  };
  const packed = packForViewer(meta, frame.payload);
  for (const v of state.viewers) v.sendBinary(packed);
}

// ---------------------------------------------------------------------------
// 查看器连接
// ---------------------------------------------------------------------------

function onViewerConnected(conn) {
  state.viewers.add(conn);
  log('viewer', `查看器已连接（当前 ${state.viewers.size}）`);

  // 首次同步一次桥接状态
  conn.sendText(JSON.stringify({
    type: 'bridge_status',
    control: !!state.control,
    frame: !!state.frame,
    sessionId: state.sessionId,
    viewportRevision: state.viewportRevision,
  }));

  conn.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleViewerCommand(msg);
  });

  conn.on('close', () => {
    state.viewers.delete(conn);
    log('viewer', `查看器断开（剩余 ${state.viewers.size}）`);
  });
  conn.on('error', () => {});
}

// 需要注入 viewportRevision 的输入类型（用于视口一致性校验）
const INPUT_TYPES = new Set([
  'key_event', 'mouse_click', 'mouse_move_absolute',
  'mouse_move_relative', 'mouse_drag', 'mouse_wheel',
]);

function handleViewerCommand(msg) {
  // 非输入类控制命令
  if (msg.type === 'release_all' || msg.type === 'start_capture' ||
      msg.type === 'stop_capture' || msg.type === 'shutdown_session' ||
      msg.type === 'ping') {
    sendToExtension({ ...msg, sessionId: state.sessionId });
    return;
  }

  if (!INPUT_TYPES.has(msg.type)) return;

  // 注入会话隔离字段：sessionId / 递增 sequence
  const out = {
    ...msg,
    sessionId: state.sessionId,
    sequence: ++state.inputSequence,
    timestamp: Date.now(),
  };
  // 拖拽携带视口版本（计划书 2.8）
  if (msg.type === 'mouse_drag' && out.viewportRevision == null) {
    out.viewportRevision = state.viewportRevision;
  }
  sendToExtension(out);
}

function sendToExtension(obj) {
  if (!state.control) {
    broadcastViewer({ type: 'server_log', level: 'warn', text: '未连接扩展控制通道，指令被丢弃：' + obj.type });
    return;
  }
  state.control.sendText(JSON.stringify(obj));
  state.stats.inputsToExt++;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function broadcastViewer(obj) {
  const s = JSON.stringify(obj);
  for (const v of state.viewers) v.sendText(s);
}

function log(tag, text) {
  const line = `[${new Date().toISOString().slice(11, 23)}] [${tag}] ${text}`;
  console.log(line);
  broadcastViewer({ type: 'server_log', level: 'info', text: `[${tag}] ${text}` });
}

// 每秒统计
setInterval(() => {
  if (state.stats.framesFromExt > 0 || state.stats.inputsToExt > 0) {
    broadcastViewer({
      type: 'server_stats',
      framesPerSec: state.stats.framesFromExt,
      kbPerSec: Math.round(state.stats.bytesFromExt / 1024),
      inputsPerSec: state.stats.inputsToExt,
    });
  }
  state.stats = { framesFromExt: 0, bytesFromExt: 0, inputsToExt: 0 };
}, 1000);

httpServer.listen(PORT, HOST, () => {
  console.log('==================================================================');
  console.log(' BGI Web Cloud Bridge - 可行性测试服务端');
  console.log(` 查看器:      http://${HOST}:${PORT}/`);
  console.log(` 扩展 WS:     ws://${HOST}:${PORT}/bridge`);
  console.log('==================================================================');
});
