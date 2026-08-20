// ============================================================================
// 零依赖 WebSocket 服务端（RFC 6455 精简实现）
// 仅覆盖 demo 需要的能力：握手、文本/二进制收发、分片重组、ping/pong、close。
// 服务端发送不加掩码；客户端发送必须加掩码（此处负责解掩码）。
// ============================================================================

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OpCode = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

/** 单个 WebSocket 连接。 */
class WsConnection extends EventEmitter {
  /**
   * @param {import('net').Socket} socket
   * @param {string} path 请求路径
   */
  constructor(socket, path) {
    super();
    this.socket = socket;
    this.path = path;
    this.closed = false;

    this._buffer = Buffer.alloc(0);
    // 分片重组
    this._fragmentOpcode = null;
    this._fragments = [];

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onSocketClose());
    socket.on('error', (err) => {
      this.emit('error', err);
      this._onSocketClose();
    });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    // 循环解析可能粘连的多个帧
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const frame = this._tryParseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _tryParseFrame() {
    const buf = this._buffer;
    if (buf.length < 2) return null;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      len = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null; // 数据未收全

    let payload = buf.subarray(offset, offset + len);
    if (masked && maskKey) {
      payload = Buffer.from(payload); // 复制后原地解掩码
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }

    // 消费已解析字节
    this._buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    switch (opcode) {
      case OpCode.PING:
        this._sendRaw(OpCode.PONG, payload);
        return;
      case OpCode.PONG:
        return;
      case OpCode.CLOSE:
        this.close();
        return;
      case OpCode.CONTINUATION:
        this._fragments.push(payload);
        if (fin) this._flushFragments();
        return;
      case OpCode.TEXT:
      case OpCode.BINARY:
        if (!fin) {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
          return;
        }
        this._emitMessage(opcode, payload);
        return;
      default:
        return;
    }
  }

  _flushFragments() {
    const opcode = this._fragmentOpcode;
    const full = Buffer.concat(this._fragments);
    this._fragmentOpcode = null;
    this._fragments = [];
    this._emitMessage(opcode, full);
  }

  _emitMessage(opcode, payload) {
    if (opcode === OpCode.TEXT) {
      this.emit('message', payload.toString('utf8'), false);
    } else {
      this.emit('message', payload, true);
    }
  }

  /** 发送文本。 */
  sendText(str) {
    this._sendRaw(OpCode.TEXT, Buffer.from(str, 'utf8'));
  }

  /** 发送二进制。 */
  sendBinary(buf) {
    this._sendRaw(OpCode.BINARY, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  _sendRaw(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode，服务端不掩码
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {
      this.emit('error', e);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this._sendRaw(OpCode.CLOSE, Buffer.alloc(0)); } catch { /* noop */ }
    try { this.socket.end(); } catch { /* noop */ }
    this.emit('close');
  }

  _onSocketClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/**
 * 将一个 HTTP server 的 upgrade 请求升级为 WebSocket 连接。
 * @param {import('http').Server} httpServer
 * @param {(conn: WsConnection, req: import('http').IncomingMessage) => void} onConnection
 */
function attachWebSocket(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n');
    socket.write(headers);

    const path = (req.url || '/').split('?')[0];
    const conn = new WsConnection(socket, path);
    onConnection(conn, req);
  });
}

module.exports = { attachWebSocket, WsConnection, OpCode };
