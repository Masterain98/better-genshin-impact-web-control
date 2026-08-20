// ============================================================================
// 二进制帧头解析 —— 必须与扩展 src/common/protocol.js 的 buildFrameMessage 一致
// 帧头（小端）：
//   magic(uint32=0x46494742 'BGIF') protocolVersion(uint16) codec(uint8) flags(uint8)
//   frameSequence(uint32) captureTimestamp(float64,ms)
//   width(uint16) height(uint16) viewportRevision(uint32)
//   sessionIdLen(uint16) sessionId(utf8...) payloadLength(uint32) payload(...)
// ============================================================================

'use strict';

const FRAME_MAGIC = 0x46494742;
const CODEC_MIME = { 0: 'image/jpeg', 1: 'image/webp' };

/**
 * 解析扩展发来的二进制帧。
 * @param {Buffer} buf
 * @returns {null | {
 *   protocolVersion:number, codec:number, mime:string, frameSequence:number,
 *   captureTimestamp:number, width:number, height:number, viewportRevision:number,
 *   sessionId:string, payload:Buffer
 * }}
 */
function parseFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 34) return null; // 固定头 34 字节（含 payloadLength）
  let o = 0;
  const magic = buf.readUInt32LE(o); o += 4;
  if (magic !== FRAME_MAGIC) return null;
  const protocolVersion = buf.readUInt16LE(o); o += 2;
  const codec = buf.readUInt8(o); o += 1;
  o += 1; // flags
  const frameSequence = buf.readUInt32LE(o); o += 4;
  const captureTimestamp = buf.readDoubleLE(o); o += 8;
  const width = buf.readUInt16LE(o); o += 2;
  const height = buf.readUInt16LE(o); o += 2;
  const viewportRevision = buf.readUInt32LE(o); o += 4;
  const sessionIdLen = buf.readUInt16LE(o); o += 2;

  if (buf.length < o + sessionIdLen + 4) return null;
  const sessionId = buf.subarray(o, o + sessionIdLen).toString('utf8'); o += sessionIdLen;
  const payloadLength = buf.readUInt32LE(o); o += 4;
  if (buf.length < o + payloadLength) return null;
  const payload = buf.subarray(o, o + payloadLength);

  return {
    protocolVersion, codec, mime: CODEC_MIME[codec] || 'image/webp',
    frameSequence, captureTimestamp, width, height, viewportRevision,
    sessionId, payload,
  };
}

/**
 * 封装转发给网页查看器的消息：metaLen(uint32 LE) + metaJson + payload。
 * @param {object} meta
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function packForViewer(meta, payload) {
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(metaBuf.length, 0);
  return Buffer.concat([head, metaBuf, payload]);
}

module.exports = { parseFrame, packForViewer, FRAME_MAGIC, CODEC_MIME };
