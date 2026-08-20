// ============================================================================
// 轻量日志：控制台输出 + 环形缓冲（用于 Popup 展示与诊断包导出）
// 每个执行上下文（SW/Offscreen/Popup）各自持有实例。
// ============================================================================

export class RingLogger {
  constructor(tag, capacity = 500) {
    this.tag = tag;
    this.capacity = capacity;
    /** @type {{t:number,level:string,msg:string}[]} */
    this.buffer = [];
  }

  _push(level, args) {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    const entry = { t: Date.now(), level, msg };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    const line = `[${this.tag}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    return entry;
  }

  info(...a) { return this._push('info', a); }
  warn(...a) { return this._push('warn', a); }
  error(...a) { return this._push('error', a); }

  dump() {
    return this.buffer.map(
      (e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase()} ${e.msg}`
    );
  }

  clear() { this.buffer = []; }
}

function safeStringify(o) {
  try { return JSON.stringify(o); } catch { return String(o); }
}
