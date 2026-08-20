// ============================================================================
// 网页查看器 —— 显示扩展画面 + 向扩展发送输入指令（经 demo 服务器中转）
// 坐标空间：画面按 1920×1080 逻辑尺寸显示，输入以 bgi-logical 空间下发。
// ============================================================================

'use strict';

const LOGICAL_W = 1920;
const LOGICAL_H = 1080;

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false });

let ws = null;
let frameCount = 0;
let lastImageBitmap = null;
const pressedButtonsUi = new Set();

// ---------------------------------------------------------------------------
// WebSocket 连接（自动重连）
// ---------------------------------------------------------------------------

function connect() {
  const url = `ws://${location.host}/viewer`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setBadge('ws-badge', true, '测试台已连接');
    logLine('info', '已连接测试服务端');
  };
  ws.onclose = () => {
    setBadge('ws-badge', false, '测试台未连接');
    setBadge('ctrl-badge', false, '控制通道');
    setBadge('frame-badge', false, '帧通道');
    setTimeout(connect, 1000);
  };
  ws.onerror = () => {};
  ws.onmessage = onMessage;
}

function onMessage(ev) {
  if (ev.data instanceof ArrayBuffer) {
    onFrameBinary(ev.data);
    return;
  }
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  onServerJson(msg);
}

function onServerJson(msg) {
  switch (msg.type) {
    case 'bridge_status':
      if ('control' in msg) setBadge('ctrl-badge', !!msg.control, '控制通道');
      if ('frame' in msg) setBadge('frame-badge', !!msg.frame, '帧通道');
      if (msg.sessionId) $('session').textContent = 'session: ' + msg.sessionId.slice(0, 12);
      if (typeof msg.viewportRevision === 'number') $('m-rev').textContent = msg.viewportRevision;
      break;
    case 'server_stats':
      $('m-kb').textContent = msg.kbPerSec ?? 0;
      $('m-inputs').textContent = msg.inputsPerSec ?? 0;
      break;
    case 'ext_message':
      onExtMessage(msg.payload);
      break;
    case 'server_log':
      logLine(msg.level || 'info', msg.text);
      break;
  }
}

function onExtMessage(p) {
  if (!p) return;
  if (p.type === 'capture_status') {
    if (p.viewportRevision != null) $('m-rev').textContent = p.viewportRevision;
  } else if (p.type === 'viewport_changed') {
    $('m-rev').textContent = p.viewportRevision;
    logLine('info', `扩展: 视口更新 rev=${p.viewportRevision} valid=${p.viewport?.valid}`);
  } else if (p.type === 'video_stalled') {
    logLine('warn', '扩展: 画面冻结 video_stalled');
  } else if (p.type === 'debugger_detached') {
    logLine('err', '扩展: CDP detach ' + (p.reason || ''));
  } else if (p.type === 'session_error') {
    logLine('err', '扩展: session_error ' + (p.error || '') + ' ' + (p.detail || ''));
  } else if (p.type === 'release_all_ack') {
    logLine('info', '扩展: ReleaseAll 已确认');
  }
}

// ---------------------------------------------------------------------------
// 画面帧解码显示
// ---------------------------------------------------------------------------

async function onFrameBinary(ab) {
  const dv = new DataView(ab);
  const metaLen = dv.getUint32(0, true);
  const metaStr = new TextDecoder().decode(new Uint8Array(ab, 4, metaLen));
  let meta;
  try { meta = JSON.parse(metaStr); } catch { return; }
  const payload = new Uint8Array(ab, 4 + metaLen);

  $('m-seq').textContent = meta.seq;
  $('m-age').textContent = Math.max(0, Math.round(meta.ageMs || 0));
  $('overlay-hint').style.display = 'none';

  try {
    const blob = new Blob([payload], { type: meta.mime || 'image/webp' });
    const bmp = await createImageBitmap(blob);
    if (lastImageBitmap) lastImageBitmap.close();
    lastImageBitmap = bmp;
    if (canvas.width !== meta.width || canvas.height !== meta.height) {
      canvas.width = meta.width || LOGICAL_W;
      canvas.height = meta.height || LOGICAL_H;
    }
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    frameCount++;
  } catch (e) {
    logLine('err', '解码帧失败: ' + (e?.message || e));
  }
}

// 每秒统计显示 fps
setInterval(() => {
  $('m-fps').textContent = frameCount;
  frameCount = 0;
}, 1000);

// ---------------------------------------------------------------------------
// 指令发送
// ---------------------------------------------------------------------------

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

/** canvas 坐标 -> bgi-logical 坐标。 */
function toLogical(e) {
  const rect = canvas.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width;
  const ny = (e.clientY - rect.top) / rect.height;
  return {
    x: Math.round(clamp01(nx) * LOGICAL_W),
    y: Math.round(clamp01(ny) * LOGICAL_H),
  };
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ---------------------------------------------------------------------------
// 键盘：按钮 + 本页键盘捕获
// ---------------------------------------------------------------------------

function keyEvent(action, code, vk, repeat) {
  send({ type: 'key_event', action, physicalCode: code, virtualKey: vk, repeat: !!repeat });
  logLine('in', `key ${action} ${code}`);
}

// 长按类按钮（按下 down，松开 up）
document.querySelectorAll('button.hold').forEach((btn) => {
  const code = btn.dataset.code;
  const vk = Number(btn.dataset.vk);
  const down = (e) => { e.preventDefault(); btn.classList.add('active'); keyEvent('down', code, vk); };
  const up = () => { btn.classList.remove('active'); keyEvent('up', code, vk); };
  btn.addEventListener('mousedown', down);
  btn.addEventListener('mouseup', up);
  btn.addEventListener('mouseleave', () => { if (btn.classList.contains('active')) up(); });
  btn.addEventListener('touchstart', down, { passive: false });
  btn.addEventListener('touchend', up);
});

// 短按类按钮（down 后短延迟 up）
document.querySelectorAll('button.tap').forEach((btn) => {
  const code = btn.dataset.code;
  const vk = Number(btn.dataset.vk);
  btn.addEventListener('click', () => {
    keyEvent('down', code, vk);
    setTimeout(() => keyEvent('up', code, vk), 60);
  });
});

// 本页键盘捕获（开关）
const kbdPressed = new Set();
window.addEventListener('keydown', (e) => {
  if (!$('kbd-capture').checked) return;
  e.preventDefault();
  if (kbdPressed.has(e.code)) { keyEvent('down', e.code, e.keyCode, true); return; }
  kbdPressed.add(e.code);
  keyEvent('down', e.code, e.keyCode);
});
window.addEventListener('keyup', (e) => {
  if (!$('kbd-capture').checked) return;
  e.preventDefault();
  kbdPressed.delete(e.code);
  keyEvent('up', e.code, e.keyCode);
});

// ---------------------------------------------------------------------------
// 鼠标：点击 / 拖拽 / 滚轮 / 相对移动
// ---------------------------------------------------------------------------

let dragStart = null;
let dragging = false;

canvas.addEventListener('mousedown', (e) => {
  if (relMouseActive()) return; // 相对模式由 pointerlock 处理
  e.preventDefault();
  dragStart = { ...toLogical(e), clientX: e.clientX, clientY: e.clientY, button: btnName(e.button) };
  dragging = false;
});

canvas.addEventListener('mousemove', (e) => {
  if (relMouseActive()) {
    // Pointer Lock 相对移动
    if (document.pointerLockElement === canvas) {
      send({ type: 'mouse_move_relative', dx: e.movementX, dy: e.movementY });
    }
    return;
  }
  if (dragStart) {
    const dx = e.clientX - dragStart.clientX;
    const dy = e.clientY - dragStart.clientY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragging = true;
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (relMouseActive()) return;
  if (!dragStart) return;
  e.preventDefault();
  const end = toLogical(e);
  if (dragging) {
    send({
      type: 'mouse_drag', button: dragStart.button,
      from: { x: dragStart.x, y: dragStart.y }, to: { x: end.x, y: end.y },
      durationMs: 300, steps: 20,
    });
    logLine('in', `drag ${dragStart.x},${dragStart.y} -> ${end.x},${end.y}`);
  } else {
    send({ type: 'mouse_click', button: dragStart.button, x: end.x, y: end.y, coordinateSpace: 'bgi-logical', holdMs: 50 });
    logLine('in', `click ${dragStart.button} ${end.x},${end.y}`);
  }
  dragStart = null;
  dragging = false;
});

// 阻止右键菜单，便于测试右键点击
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = toLogical(e);
  send({ type: 'mouse_wheel', deltaX: e.deltaX, deltaY: e.deltaY, x: p.x, y: p.y });
  logLine('in', `wheel ${Math.round(e.deltaY)}`);
}, { passive: false });

// 相对鼠标：Pointer Lock
function relMouseActive() { return $('rel-mouse').checked; }
$('rel-mouse').addEventListener('change', () => {
  if (relMouseActive()) {
    canvas.classList.add('rel-active');
    logLine('info', '相对鼠标：点击画面进入 Pointer Lock');
  } else {
    canvas.classList.remove('rel-active');
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
});
canvas.addEventListener('click', () => {
  if (relMouseActive() && document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  }
});
document.addEventListener('pointerlockchange', () => {
  logLine('info', document.pointerLockElement === canvas ? '已进入 Pointer Lock' : '已退出 Pointer Lock');
});

function btnName(b) { return b === 2 ? 'right' : b === 1 ? 'middle' : 'left'; }

// ---------------------------------------------------------------------------
// 会话操作
// ---------------------------------------------------------------------------

$('btn-release').addEventListener('click', () => {
  send({ type: 'release_all' });
  kbdPressed.clear();
  document.querySelectorAll('button.active').forEach((b) => b.classList.remove('active'));
  logLine('in', 'release_all');
});
$('btn-clearlog').addEventListener('click', () => { $('log').textContent = ''; });

// ---------------------------------------------------------------------------
// 日志 / 徽标
// ---------------------------------------------------------------------------

function setBadge(id, on, text) {
  const el = $(id);
  el.className = 'badge ' + (on ? 'on' : 'off');
  if (text) el.textContent = text;
}

function logLine(level, text) {
  const el = $('log');
  const div = document.createElement('div');
  div.className = level;
  div.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.childElementCount > 300) el.removeChild(el.firstChild);
}

connect();
