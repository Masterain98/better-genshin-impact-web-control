// ============================================================================
// CDP 输入注入 —— 对应计划书 第二章「网页云原神的操控」
// 通过 chrome.debugger 向指定标签页派发 CDP Input 事件。
//
// 设计要点（计划书 1.4 / 2.5 / 2.8）：
//   - 每个 KeyDown 必对应 KeyUp；每个 MouseDown 必对应 MouseUp。
//   - 维护 pressedKeys / pressedButtons，支持幂等 ReleaseAll。
//   - 重复 KeyDown 默认忽略（除非 repeat=true）。
//   - 拖拽/相对移动携带 viewportRevision，版本不匹配拒绝执行。
// ============================================================================

import { resolveKey, isMovementKey, MouseButton } from '../common/keymap.js';
import { bgiLogicalToCss } from '../common/coordinate.js';

const CDP_VERSION = '1.3';

export class CdpInput {
  /**
   * @param {number} tabId
   * @param {import('../common/logger.js').RingLogger} logger
   */
  constructor(tabId, logger) {
    this.tabId = tabId;
    this.log = logger;
    this.attached = false;

    /** @type {Set<string>} 已按下的 DOM code */
    this.pressedKeys = new Set();
    /** @type {Set<string>} 已按下的鼠标按钮名 */
    this.pressedButtons = new Set();

    /** 相对鼠标使用的虚拟光标（CSS 坐标）。 */
    this.virtualCursor = null;
    /** 是否正在拖拽 */
    this.dragging = false;
  }

  get target() { return { tabId: this.tabId }; }

  /** 当前按下的鼠标按钮位掩码（用于 mouseMoved 的 buttons 字段）。 */
  _buttonsMask() {
    let m = 0;
    for (const b of this.pressedButtons) m |= MouseButton[b]?.mask || 0;
    return m;
  }

  async attach() {
    if (this.attached) return;
    try {
      await chrome.debugger.attach(this.target, CDP_VERSION);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      if (/already attached/i.test(msg)) {
        // 多半是上次会话未正确 detach（或并发 connect）。先解绑本扩展的调试器再重试一次。
        this.log.warn('CDP 已附加，尝试先 detach 再重连：', msg);
        try { await chrome.debugger.detach(this.target); } catch { /* 可能本扩展并未附加，忽略 */ }
        await delay(120); // 等待 onDetach 生效，避免状态竞态
        await chrome.debugger.attach(this.target, CDP_VERSION);
      } else {
        throw e;
      }
    }
    this.attached = true;
    this.log.info('CDP attached to tab', this.tabId);
  }

  async detach() {
    if (!this.attached) return;
    try {
      await this.releaseAll();
    } catch (e) {
      this.log.warn('releaseAll during detach failed:', e?.message || e);
    }
    try {
      await chrome.debugger.detach(this.target);
    } catch (e) {
      this.log.warn('detach failed:', e?.message || e);
    }
    this.attached = false;
    this.log.info('CDP detached from tab', this.tabId);
  }

  async _send(method, params) {
    if (!this.attached) throw new Error('CDP not attached');
    return chrome.debugger.sendCommand(this.target, method, params || {});
  }

  // -------------------------------------------------------------------------
  // 键盘（计划书 2.4）
  // -------------------------------------------------------------------------

  /** @param {{action:'down'|'up', physicalCode:string, virtualKey?:number, repeat?:boolean}} msg */
  async handleKeyEvent(msg) {
    const code = msg.physicalCode;
    if (!code) throw new Error('key_event missing physicalCode');
    const info = resolveKey(code, msg.virtualKey);

    if (msg.action === 'down') {
      if (this.pressedKeys.has(code) && !msg.repeat) {
        // 已按下且非显式重复：忽略（计划书 2.5）
        return;
      }
      this.pressedKeys.add(code);
      await this._send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        code,
        key: info.key,
        windowsVirtualKeyCode: info.windowsVirtualKeyCode,
        nativeVirtualKeyCode: info.windowsVirtualKeyCode,
        autoRepeat: !!msg.repeat,
      });
      // 非移动键的可打印字符补一个 char 事件（部分页面依赖）。
      if (!isMovementKey(code) && info.text) {
        await this._send('Input.dispatchKeyEvent', {
          type: 'char',
          code,
          key: info.key,
          text: info.text,
          unmodifiedText: info.text,
          windowsVirtualKeyCode: info.windowsVirtualKeyCode,
        });
      }
    } else {
      // up：即使无对应 down 也发送释放并清理（计划书 2.5）
      this.pressedKeys.delete(code);
      await this._send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        code,
        key: info.key,
        windowsVirtualKeyCode: info.windowsVirtualKeyCode,
        nativeVirtualKeyCode: info.windowsVirtualKeyCode,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 绝对点击（计划书 2.7）
  // -------------------------------------------------------------------------

  /** @param {{button?:string,x:number,y:number,coordinateSpace?:string,holdMs?:number}} msg @param {object} vp */
  async handleMouseClick(msg, vp) {
    const btn = MouseButton[msg.button || 'left'] || MouseButton.left;
    const { x, y } = this._toCss(msg, vp);
    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: this._buttonsMask() });
    this.virtualCursor = { x, y };
    await this._send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: btn.name, buttons: btn.mask, clickCount: msg.clickCount || 1,
    });
    if (msg.holdMs) await delay(msg.holdMs);
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: btn.name, buttons: 0, clickCount: msg.clickCount || 1,
    });
  }

  /** 按下指定鼠标按钮并保持（对应 BetterGI 的 LeftButtonDown 等；解决 mouse_click 无法表达“按住”的问题，计划书 2.7 补充）。 */
  async handleMouseDown(msg, vp) {
    const btn = MouseButton[msg.button || 'left'] || MouseButton.left;
    const { x, y } = this._toCss(msg, vp);
    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: this._buttonsMask() });
    this.virtualCursor = { x, y };
    await this._send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: btn.name, buttons: btn.mask, clickCount: 1,
    });
    this.pressedButtons.add(btn.name);
  }

  /** 释放指定鼠标按钮（对应 BetterGI 的 LeftButtonUp 等）。未提供坐标时使用虚拟光标当前位置。 */
  async handleMouseUp(msg, vp) {
    const btn = MouseButton[msg.button || 'left'] || MouseButton.left;
    const pos = (msg.x != null && msg.y != null) ? this._toCss(msg, vp)
      : (this.virtualCursor || { x: (vp.logicalWidth || 1920) / 2, y: (vp.logicalHeight || 1080) / 2 });
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: pos.x, y: pos.y, button: btn.name, buttons: 0, clickCount: 1,
    });
    this.pressedButtons.delete(btn.name);
  }

  /** 绝对移动（不按键） */
  async handleMouseMoveAbsolute(msg, vp) {
    const { x, y } = this._toCss(msg, vp);
    this.virtualCursor = { x, y };
    await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: this._buttonsMask() });
  }

  // -------------------------------------------------------------------------
  // 拖拽（计划书 2.8）
  // -------------------------------------------------------------------------

  /** @param {{button?:string,from:{x,y},to:{x,y},durationMs?:number,steps?:number}} msg */
  async handleMouseDrag(msg, vp, isCancelled) {
    const btn = MouseButton[msg.button || 'left'] || MouseButton.left;
    const from = this._toCss(msg.from, vp);
    const to = this._toCss(msg.to, vp);
    const steps = Math.max(1, msg.steps || 20);
    const totalMs = msg.durationMs || 400;
    const stepDelay = totalMs / steps;

    this.dragging = true;
    this.pressedButtons.add(btn.name);
    try {
      await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 });
      await this._send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: from.x, y: from.y, button: btn.name, buttons: btn.mask, clickCount: 1,
      });
      for (let i = 1; i <= steps; i++) {
        if (isCancelled && isCancelled()) break; // 视口变化/中断则停止（计划书 2.8）
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        await this._send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: btn.name, buttons: btn.mask });
        this.virtualCursor = { x, y };
        if (stepDelay > 0) await delay(stepDelay);
      }
      await this._send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: to.x, y: to.y, button: btn.name, buttons: 0, clickCount: 1,
      });
    } finally {
      this.pressedButtons.delete(btn.name);
      this.dragging = false;
    }
  }

  // -------------------------------------------------------------------------
  // 滚轮（计划书 2.9）
  // -------------------------------------------------------------------------

  async handleMouseWheel(msg, vp) {
    let x, y;
    if (msg.x != null && msg.y != null) ({ x, y } = this._toCss(msg, vp));
    else if (this.virtualCursor) ({ x, y } = this.virtualCursor);
    else ({ x, y } = this._toCss({ x: (vp.logicalWidth || 1920) / 2, y: (vp.logicalHeight || 1080) / 2 }, vp));

    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0,
    });
  }

  // -------------------------------------------------------------------------
  // 相对鼠标 / 视角控制（计划书 2.10）—— 首期实验方案
  // 通过虚拟光标 + mouseMoved 近似；真正的 Pointer Lock 相对量需后续研究。
  // -------------------------------------------------------------------------

  async handleMouseMoveRelative(msg, vp, scaleX, scaleY) {
    if (!this.virtualCursor) {
      // 初始化到游戏区域中心
      this.virtualCursor = {
        x: vp.cssLeft + vp.cssWidth / 2,
        y: vp.cssTop + vp.cssHeight / 2,
      };
    }
    let nx = this.virtualCursor.x + (msg.dx || 0) * (scaleX ?? 1);
    let ny = this.virtualCursor.y + (msg.dy || 0) * (scaleY ?? 1);
    // 夹取在游戏区域内
    nx = clamp(nx, vp.cssLeft, vp.cssLeft + vp.cssWidth);
    ny = clamp(ny, vp.cssTop, vp.cssTop + vp.cssHeight);
    this.virtualCursor = { x: nx, y: ny };
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: nx, y: ny, buttons: this._buttonsMask(),
      movementX: (msg.dx || 0) * (scaleX ?? 1),
      movementY: (msg.dy || 0) * (scaleY ?? 1),
    });
  }

  // -------------------------------------------------------------------------
  // 安全释放（计划书 1.4 / 2.5）—— 幂等
  // -------------------------------------------------------------------------

  async releaseAll() {
    if (!this.attached) {
      this.pressedKeys.clear();
      this.pressedButtons.clear();
      this.dragging = false;
      return;
    }
    // 释放所有按键
    for (const code of Array.from(this.pressedKeys)) {
      const info = resolveKey(code, 0);
      try {
        await this._send('Input.dispatchKeyEvent', {
          type: 'keyUp', code, key: info.key,
          windowsVirtualKeyCode: info.windowsVirtualKeyCode,
        });
      } catch (e) { this.log.warn('releaseAll key fail', code, e?.message || e); }
    }
    this.pressedKeys.clear();

    // 释放所有鼠标按钮
    const pos = this.virtualCursor || { x: 0, y: 0 };
    for (const name of Array.from(this.pressedButtons)) {
      const btn = MouseButton[name] || MouseButton.left;
      try {
        await this._send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: pos.x, y: pos.y, button: btn.name, buttons: 0, clickCount: 1,
        });
      } catch (e) { this.log.warn('releaseAll button fail', name, e?.message || e); }
    }
    this.pressedButtons.clear();
    this.dragging = false;
  }

  snapshotPressed() {
    return {
      pressedKeys: Array.from(this.pressedKeys),
      pressedButtons: Array.from(this.pressedButtons),
    };
  }

  /** 通过 CDP Runtime.evaluate 在目标页执行表达式并取回值。 */
  async evaluate(expression) {
    const r = await this._send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    return r?.result?.value;
  }

  /**
   * 通过 CDP 直接向目标标签页查询游戏视口几何。
   * 比 Content Script 更可靠：能拿到顶层 iframe 的矩形（游戏常在 iframe 内）。
   * 返回与 content-script collectGeom() 同构的对象。
   */
  async queryViewport() {
    const expr = `(() => {
      const TARGET_RATIO = 16 / 9; // 无固有分辨率时按 BGI 逻辑比例内切
      const els = Array.from(document.querySelectorAll('video,canvas,iframe'));
      let best = null, area = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > area && r.width > 100 && r.height > 100) { best = el; area = a; }
      }
      const r = best ? best.getBoundingClientRect()
                     : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      let vw = 0, vh = 0;
      if (best && best.tagName === 'VIDEO') { vw = best.videoWidth || 0; vh = best.videoHeight || 0; }
      else if (best && best.tagName === 'CANVAS') { vw = best.width || 0; vh = best.height || 0; }

      // 计算内容矩形（去黑边）：
      //   有固有分辨率 -> object-fit: contain 数学；
      //   无固有分辨率(iframe) -> 按 16:9 居中内切，保证帧不被拉伸变形。
      let cl = r.left, ct = r.top, cw = r.width, ch = r.height;
      if (cw > 0 && ch > 0) {
        const contentRatio = (vw > 0 && vh > 0) ? vw / vh : TARGET_RATIO;
        const elRatio = cw / ch;
        if (contentRatio > elRatio) {
          // 内容更宽：上下黑边
          ch = cw / contentRatio;
          ct = r.top + (r.height - ch) / 2;
        } else if (contentRatio < elRatio) {
          // 内容更高：左右黑边
          cw = ch * contentRatio;
          cl = r.left + (r.width - cw) / 2;
        }
      }
      return {
        valid: cw > 0 && ch > 0,
        cssLeft: cl, cssTop: ct, cssWidth: cw, cssHeight: ch,
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        videoWidth: vw, videoHeight: vh,
        fullscreen: !!document.fullscreenElement,
        tagName: best ? best.tagName : 'NONE',
      };
    })()`;
    try {
      return await this.evaluate(expr);
    } catch (e) {
      this.log.warn('queryViewport failed:', e?.message || e);
      return null;
    }
  }

  _toCss(pt, vp) {
    // 默认按 bgi-logical 处理；若声明为 css 则直接使用。
    if (pt.coordinateSpace === 'css') return { x: pt.x, y: pt.y };
    return bgiLogicalToCss(pt.x, pt.y, vp);
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
