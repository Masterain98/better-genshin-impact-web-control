// ============================================================================
// BGI Web Cloud Bridge - 通信协议定义
// 对应计划书 第四章「整体的系统集成」
// 该模块被 Service Worker / Offscreen / Popup 以 ES Module 方式复用。
// 注意：Content Script 无法直接 import，本文件的常量在其内部有独立副本。
// ============================================================================

/** 桥接协议版本，major.minor。major 不同拒绝连接，minor 不同协商能力。 */
export const PROTOCOL_VERSION = 1;

/** 扩展版本（与 manifest 保持一致的语义版本）。 */
export const EXTENSION_VERSION = '0.1.0';

/** 二进制帧头魔数 'BGIF' (0x42 0x47 0x49 0x46) 小端读取值。 */
export const FRAME_MAGIC = 0x46494742;

/** 云原神网页地址匹配。 */
export const CLOUD_GENSHIN_URL_PATTERN = /^https:\/\/ys\.mihoyo\.com\/cloud(\/|#|$)/i;

/** 逻辑分辨率（BetterGI 期望的标准画面）。 */
export const DEFAULT_LOGICAL_WIDTH = 1920;
export const DEFAULT_LOGICAL_HEIGHT = 1080;

/** 编码格式枚举（写入帧头 codec 字段）。 */
export const Codec = Object.freeze({ JPEG: 0, WEBP: 1 });
export const CodecName = Object.freeze({ 0: 'jpeg', 1: 'webp' });
export const CodecMime = Object.freeze({ 0: 'image/jpeg', 1: 'image/webp' });

/** WebSocket 逻辑通道。可共用一个连接，本实现拆成两个连接。 */
export const Channel = Object.freeze({ CONTROL: 'control', FRAME: 'frame' });

/**
 * 操控会话状态机（计划书 2.12）。
 * 只有 InputReady 和 Running 状态允许发送实际输入。
 */
export const SessionState = Object.freeze({
  DISCONNECTED: 'Disconnected',
  CONNECTING: 'Connecting',
  CAPTURING: 'Capturing',
  INPUT_READY: 'InputReady',
  RUNNING: 'Running',
  SUSPENDED: 'Suspended',
  RECOVERING: 'Recovering',
  FAILED: 'Failed',
  STOPPING: 'Stopping',
});

/** 允许下发输入的状态集合。 */
export const INPUT_ALLOWED_STATES = new Set([
  SessionState.INPUT_READY,
  SessionState.RUNNING,
]);

/** 扩展 -> BetterGI 消息类型（计划书 4.5）。 */
export const MsgOut = Object.freeze({
  HELLO: 'hello',
  FRAME: 'frame',
  CAPTURE_STATUS: 'capture_status',
  VIEWPORT_CHANGED: 'viewport_changed',
  TAB_STATUS: 'tab_status',
  INPUT_STATUS: 'input_status',
  HEARTBEAT: 'heartbeat',
  VIDEO_STALLED: 'video_stalled',
  DEBUGGER_DETACHED: 'debugger_detached',
  SESSION_ERROR: 'session_error',
  RELEASE_ALL_ACK: 'release_all_ack',
});

/** BetterGI -> 扩展 消息类型（计划书 4.5）。 */
export const MsgIn = Object.freeze({
  HELLO_ACK: 'hello_ack',
  START_CAPTURE: 'start_capture',
  STOP_CAPTURE: 'stop_capture',
  KEY_EVENT: 'key_event',
  MOUSE_CLICK: 'mouse_click',
  MOUSE_MOVE_ABSOLUTE: 'mouse_move_absolute',
  MOUSE_MOVE_RELATIVE: 'mouse_move_relative',
  MOUSE_DRAG: 'mouse_drag',
  MOUSE_WHEEL: 'mouse_wheel',
  MOUSE_DOWN: 'mouse_down',
  MOUSE_UP: 'mouse_up',
  RELEASE_ALL: 'release_all',
  PING: 'ping',
  UPDATE_CONFIG: 'update_config',
  SHUTDOWN_SESSION: 'shutdown_session',
});

/** 握手失败错误码（计划书 4.4）。 */
export const HandshakeError = Object.freeze({
  PROTOCOL_VERSION_UNSUPPORTED: 'PROTOCOL_VERSION_UNSUPPORTED',
  EXTENSION_VERSION_TOO_OLD: 'EXTENSION_VERSION_TOO_OLD',
  TOKEN_INVALID: 'TOKEN_INVALID',
  SESSION_ALREADY_ACTIVE: 'SESSION_ALREADY_ACTIVE',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
});

/** 扩展能力声明。 */
export const CAPABILITIES = Object.freeze([
  'tab_capture',
  'absolute_mouse',
  'keyboard',
  'mouse_wheel',
  'relative_mouse',
]);

/** SW <-> Offscreen 内部消息（chrome.runtime）。 */
export const OffscreenCmd = Object.freeze({
  START: 'offscreen:start',
  STOP: 'offscreen:stop',
  UPDATE_VIEWPORT: 'offscreen:updateViewport',
  UPDATE_CONFIG: 'offscreen:updateConfig',
});
export const OffscreenEvt = Object.freeze({
  READY: 'offscreen:ready',
  CAPTURE_STARTED: 'offscreen:captureStarted',
  CAPTURE_STATUS: 'offscreen:captureStatus',
  VIDEO_STALLED: 'offscreen:videoStalled',
  VIDEO_RESUMED: 'offscreen:videoResumed',
  VIDEO_ENDED: 'offscreen:videoEnded',
  FRAME_WS_OPEN: 'offscreen:frameWsOpen',
  FRAME_WS_CLOSED: 'offscreen:frameWsClosed',
  ERROR: 'offscreen:error',
});

/** Popup / Content <-> SW 内部消息。 */
export const UiCmd = Object.freeze({
  GET_STATUS: 'ui:getStatus',
  CONNECT: 'ui:connect',
  STOP: 'ui:stop',
  RELEASE_ALL: 'ui:releaseAll',
  RECALIBRATE: 'ui:recalibrate',
  EXPORT_DIAGNOSTICS: 'ui:exportDiagnostics',
  GET_LOGS: 'ui:getLogs',
});
export const ContentMsg = Object.freeze({
  VIEWPORT_REPORT: 'content:viewportReport',
  PAGE_STATE: 'content:pageState',
  GET_VIEWPORT: 'content:getViewport',
});

// ---------------------------------------------------------------------------
// 二进制帧编码 / 解码
// 帧头（小端）：
//   magic(uint32) protocolVersion(uint16) codec(uint8) flags(uint8)
//   frameSequence(uint32) captureTimestamp(float64)
//   width(uint16) height(uint16) viewportRevision(uint32)
//   sessionIdLen(uint16) sessionId(utf8...) payloadLength(uint32) payload(...)
// ---------------------------------------------------------------------------

// 注意：必须包含 payloadLength(uint32) 的 4 字节，否则 buffer 会小 4 字节导致构建抛错
const FIXED_HEADER_BYTES = 4 + 2 + 1 + 1 + 4 + 8 + 2 + 2 + 4 + 2 + 4; // = 34

/**
 * 构建二进制帧消息。
 * @param {object} p
 * @param {string} p.sessionId
 * @param {number} p.frameSequence
 * @param {number} p.captureTimestamp  毫秒
 * @param {number} p.width
 * @param {number} p.height
 * @param {number} p.codec  Codec.*
 * @param {number} p.viewportRevision
 * @param {ArrayBuffer|Uint8Array} p.payload  编码后的图像字节
 * @returns {ArrayBuffer}
 */
export function buildFrameMessage(p) {
  const enc = new TextEncoder();
  const sid = enc.encode(p.sessionId || '');
  const payload = p.payload instanceof Uint8Array ? p.payload : new Uint8Array(p.payload);

  const total = FIXED_HEADER_BYTES + sid.length + payload.byteLength;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, FRAME_MAGIC, true); o += 4;
  dv.setUint16(o, p.protocolVersion ?? PROTOCOL_VERSION, true); o += 2;
  dv.setUint8(o, p.codec); o += 1;
  dv.setUint8(o, 0); o += 1; // flags 预留
  dv.setUint32(o, p.frameSequence >>> 0, true); o += 4;
  dv.setFloat64(o, p.captureTimestamp, true); o += 8;
  dv.setUint16(o, p.width, true); o += 2;
  dv.setUint16(o, p.height, true); o += 2;
  dv.setUint32(o, (p.viewportRevision ?? 0) >>> 0, true); o += 4;
  dv.setUint16(o, sid.length, true); o += 2;
  new Uint8Array(buf, o, sid.length).set(sid); o += sid.length;
  dv.setUint32(o, payload.byteLength >>> 0, true); o += 4;
  new Uint8Array(buf, o, payload.byteLength).set(payload);
  return buf;
}

/** 生成随机一次性 sessionId。 */
export function generateSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
