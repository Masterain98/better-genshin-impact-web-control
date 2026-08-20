// ============================================================================
// Content Script —— 页面空间信息提供者（计划书 1.2.3 / 1.5.2）
// 注意：manifest 声明的 content script 运行在隔离环境且不支持 ES import，
//       因此本文件为自包含实现，协议常量在此有独立副本。
//
// 职责：
//   - 检测是否为网页云原神页面
//   - 查找游戏视频/画布元素，计算其 CSS 内容矩形（含 object-fit 黑边）
//   - 上报 devicePixelRatio / 全屏 / 可见性 / 尺寸变化
// 不承担：输入注入、账号读取、业务逻辑修改。
// ============================================================================

(() => {
  'use strict';

  const ContentMsg = {
    VIEWPORT_REPORT: 'content:viewportReport',
    PAGE_STATE: 'content:pageState',
    GET_VIEWPORT: 'content:getViewport',
  };

  let lastGeomKey = '';
  let reportScheduled = false;

  // -------------------------------------------------------------------------
  // 游戏区域检测
  // -------------------------------------------------------------------------

  /** 找到最可能的游戏渲染元素（最大的 video，退化为最大的 canvas）。 */
  function findGameElement() {
    const candidates = [
      ...document.querySelectorAll('video'),
      ...document.querySelectorAll('canvas'),
    ];
    let best = null;
    let bestArea = 0;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 100 && r.height > 100) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  /**
   * 计算元素内实际内容矩形（考虑 object-fit: contain 黑边）。
   * 对于云游戏，video 的固有分辨率与显示区域宽高比可能不同。
   */
  function computeContentRect(el, rect) {
    let intrinsicW = 0;
    let intrinsicH = 0;
    if (el.tagName === 'VIDEO') {
      intrinsicW = el.videoWidth || 0;
      intrinsicH = el.videoHeight || 0;
    } else if (el.tagName === 'CANVAS') {
      intrinsicW = el.width || 0;
      intrinsicH = el.height || 0;
    }

    // 无固有尺寸信息（如 iframe）：按 16:9 居中内切，与 SW 侧 CDP 查询保持一致
    const elRatio = rect.width / rect.height;
    const vidRatio = (intrinsicW && intrinsicH) ? intrinsicW / intrinsicH : 16 / 9;
    let cw = rect.width;
    let ch = rect.height;
    let cl = rect.left;
    let ct = rect.top;

    // object-fit: contain 计算内容区（去黑边）
    if (vidRatio > elRatio) {
      // 视频更宽：上下黑边
      ch = rect.width / vidRatio;
      ct = rect.top + (rect.height - ch) / 2;
    } else if (vidRatio < elRatio) {
      // 视频更高：左右黑边
      cw = rect.height * vidRatio;
      cl = rect.left + (rect.width - cw) / 2;
    }
    return { left: cl, top: ct, width: cw, height: ch, intrinsicW, intrinsicH };
  }

  function collectGeom() {
    const el = findGameElement();
    const dpr = window.devicePixelRatio || 1;
    const fullscreen = !!document.fullscreenElement;
    const visible = document.visibilityState === 'visible';

    if (!el) {
      return {
        valid: false,
        cssLeft: 0, cssTop: 0, cssWidth: 0, cssHeight: 0,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: dpr,
        videoWidth: 0, videoHeight: 0,
        fullscreen, visible,
      };
    }

    const rect = el.getBoundingClientRect();
    const content = computeContentRect(el, rect);
    return {
      valid: content.width > 0 && content.height > 0,
      cssLeft: content.left,
      cssTop: content.top,
      cssWidth: content.width,
      cssHeight: content.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: dpr,
      videoWidth: content.intrinsicW,
      videoHeight: content.intrinsicH,
      fullscreen,
      visible,
      tagName: el.tagName,
    };
  }

  // -------------------------------------------------------------------------
  // 上报（去抖）
  // -------------------------------------------------------------------------

  function geomKey(g) {
    return [
      Math.round(g.cssLeft), Math.round(g.cssTop),
      Math.round(g.cssWidth), Math.round(g.cssHeight),
      g.innerWidth, g.innerHeight, g.fullscreen, g.valid,
      Math.round((g.devicePixelRatio || 1) * 100),
    ].join(',');
  }

  function scheduleReport() {
    if (reportScheduled) return;
    reportScheduled = true;
    requestAnimationFrame(() => {
      reportScheduled = false;
      const g = collectGeom();
      const key = geomKey(g);
      if (key !== lastGeomKey) {
        lastGeomKey = key;
        try {
          chrome.runtime.sendMessage({ type: ContentMsg.VIEWPORT_REPORT, geom: g });
        } catch { /* SW 可能未就绪 */ }
      }
    });
  }

  // -------------------------------------------------------------------------
  // 响应 SW 主动查询
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === ContentMsg.GET_VIEWPORT) {
      sendResponse(collectGeom());
      return true;
    }
    return false;
  });

  // -------------------------------------------------------------------------
  // 监听可能导致坐标变化的事件（计划书 1.5.2）
  // -------------------------------------------------------------------------

  window.addEventListener('resize', scheduleReport, { passive: true });
  document.addEventListener('fullscreenchange', scheduleReport);
  document.addEventListener('visibilitychange', () => {
    try {
      chrome.runtime.sendMessage({
        type: ContentMsg.PAGE_STATE,
        state: { visible: document.visibilityState === 'visible' },
      });
    } catch {}
    scheduleReport();
  });

  // 用 ResizeObserver 观察 body，捕捉布局变化
  try {
    const ro = new ResizeObserver(() => scheduleReport());
    ro.observe(document.documentElement);
  } catch { /* 某些环境不支持 */ }

  // 定期兜底检测（游戏区域可能在无 DOM 事件时出现，如视频元数据加载）
  setInterval(scheduleReport, 2000);

  // 初次上报
  scheduleReport();
})();
