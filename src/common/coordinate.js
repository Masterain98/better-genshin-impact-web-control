// ============================================================================
// 坐标转换 —— 对应计划书 2.6「绝对坐标点击」的坐标链路
//   BGI Logical Space -> ... -> CSS Viewport Space -> CDP Input Space
// CDP Input.dispatchMouseEvent 使用 CSS 像素（相对页面布局视口）。
// 因此对输入而言，只需将 BGI 逻辑坐标映射到游戏区域的 CSS 矩形内。
// ============================================================================

/**
 * @typedef {object} GameViewport
 * @property {number} revision            视口版本号
 * @property {number} logicalWidth        BGI 逻辑宽（1920）
 * @property {number} logicalHeight       BGI 逻辑高（1080）
 * @property {number} cssLeft             游戏内容区左（CSS px，相对页面）
 * @property {number} cssTop              游戏内容区上
 * @property {number} cssWidth            游戏内容区宽
 * @property {number} cssHeight           游戏内容区高
 * @property {number} innerWidth          标签页 window.innerWidth
 * @property {number} innerHeight         标签页 window.innerHeight
 * @property {number} devicePixelRatio
 * @property {number} videoWidth          视频固有宽（可为 0）
 * @property {number} videoHeight         视频固有高
 * @property {boolean} fullscreen
 * @property {boolean} valid              是否检测到有效游戏区域
 */

/**
 * BGI 逻辑坐标 -> CSS 视口坐标（CDP 输入坐标）。
 */
export function bgiLogicalToCss(x, y, vp) {
  const nx = clamp01(x / (vp.logicalWidth || 1920));
  const ny = clamp01(y / (vp.logicalHeight || 1080));
  return {
    x: vp.cssLeft + nx * vp.cssWidth,
    y: vp.cssTop + ny * vp.cssHeight,
  };
}

/**
 * 计算裁剪矩形：将游戏内容区(CSS)映射到 tabCapture 捕获视频像素。
 *
 * 重要：捕获视频的宽高比不一定等于标签页视口比例（例如窗口被分屏为窄高形状时，
 * Chrome 会把标签页内容**等比缩放并居中**放入捕获画面，四周留黑边）。
 * 因此必须使用统一缩放系数 + 居中偏移（aspect-fit），
 * 而不能对 X/Y 各自独立缩放（那会在比例不一致时产生画面变形与点击偏移）。
 */
export function cssRectToCapture(vp, capturedWidth, capturedHeight) {
  const iw = vp.innerWidth || capturedWidth;
  const ih = vp.innerHeight || capturedHeight;
  // 等比缩放：标签页内容以 min 比例放入捕获画面并居中
  const s = Math.min(capturedWidth / iw, capturedHeight / ih);
  const offsetX = (capturedWidth - iw * s) / 2;
  const offsetY = (capturedHeight - ih * s) / 2;

  let left = Math.round(offsetX + vp.cssLeft * s);
  let top = Math.round(offsetY + vp.cssTop * s);
  let width = Math.round(vp.cssWidth * s);
  let height = Math.round(vp.cssHeight * s);
  // 夹取到捕获范围内，避免 drawImage 越界。
  left = Math.max(0, Math.min(left, capturedWidth - 1));
  top = Math.max(0, Math.min(top, capturedHeight - 1));
  width = Math.max(1, Math.min(width, capturedWidth - left));
  height = Math.max(1, Math.min(height, capturedHeight - top));
  return { left, top, width, height };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 判断两个视口几何是否有实质变化（超过阈值需要提升 revision）。 */
export function viewportGeometryChanged(a, b, epsilon = 1.5) {
  if (!a || !b) return true;
  const keys = ['cssLeft', 'cssTop', 'cssWidth', 'cssHeight', 'innerWidth', 'innerHeight'];
  for (const k of keys) {
    if (Math.abs((a[k] || 0) - (b[k] || 0)) > epsilon) return true;
  }
  if (a.fullscreen !== b.fullscreen) return true;
  if (Math.abs((a.devicePixelRatio || 1) - (b.devicePixelRatio || 1)) > 0.01) return true;
  return false;
}
