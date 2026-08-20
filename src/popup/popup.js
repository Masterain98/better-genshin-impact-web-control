// ============================================================================
// Popup 控制界面（计划书 1.2.4）
// ============================================================================

import { UiCmd, SessionState } from '../common/protocol.js';

const $ = (id) => document.getElementById(id);

const stateLabels = {
  [SessionState.DISCONNECTED]: '未连接',
  [SessionState.CONNECTING]: '连接中',
  [SessionState.CAPTURING]: '捕获中',
  [SessionState.INPUT_READY]: '就绪',
  [SessionState.RUNNING]: '运行中',
  [SessionState.SUSPENDED]: '已暂停',
  [SessionState.RECOVERING]: '恢复中',
  [SessionState.FAILED]: '失败',
  [SessionState.STOPPING]: '停止中',
};

function send(cmd, extra) {
  return chrome.runtime.sendMessage({ cmd, ...extra });
}

function render(status) {
  if (!status) return;
  const badge = $('state-badge');
  badge.textContent = stateLabels[status.state] || status.state;
  badge.className = 'badge ' + String(status.state || 'disconnected').toLowerCase();

  $('bgi-conn').textContent = status.connected ? '已连接' : '未连接';
  $('tab').textContent = status.tabId != null ? ('#' + status.tabId) : '—';
  $('cdp').textContent = status.cdpAttached ? '已附加' : '未附加';

  const vp = status.viewport;
  $('viewport').textContent = vp
    ? (vp.valid ? `${Math.round(vp.cssWidth)}×${Math.round(vp.cssHeight)} (rev${status.viewportRevision})` : '未检测到')
    : '—';

  const cs = status.captureStats;
  $('resolution').textContent = cs?.sourceWidth ? `${cs.sourceWidth}×${cs.sourceHeight} → ${cs.logicalWidth}×${cs.logicalHeight}` : '—';
  $('fps').textContent = cs ? `${cs.fps ?? 0} fps` : '—';
  $('drop').textContent = cs ? `丢${cs.droppedFps ?? 0} / 缓${Math.round((cs.wsBuffered || 0) / 1024)}KB` : '—';
  $('error').textContent = status.lastError || '—';

  const connected = status.connected;
  $('btn-connect').disabled = connected;
  $('btn-recalibrate').disabled = !connected;
  $('btn-release').disabled = !connected;
  $('btn-stop').disabled = !connected;
}

async function refresh() {
  try {
    const status = await send(UiCmd.GET_STATUS);
    render(status);
  } catch { /* SW 可能刚被唤醒 */ }
}

// 事件绑定
$('btn-connect').addEventListener('click', async () => {
  $('btn-connect').disabled = true;
  const r = await send(UiCmd.CONNECT);
  if (!r?.ok) $('error').textContent = r?.error || '连接失败';
  refresh();
});

$('btn-recalibrate').addEventListener('click', async () => { await send(UiCmd.RECALIBRATE); refresh(); });
$('btn-release').addEventListener('click', async () => { await send(UiCmd.RELEASE_ALL); refresh(); });
$('btn-stop').addEventListener('click', async () => { await send(UiCmd.STOP); refresh(); });

$('link-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('link-export').addEventListener('click', async (e) => {
  e.preventDefault();
  const r = await send(UiCmd.EXPORT_DIAGNOSTICS);
  if (r?.ok) {
    const blob = new Blob([JSON.stringify(r.diagnostics, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bridge-diagnostic-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
});

// 监听 SW 主动推送的状态
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.source === 'sw' && message.evt === 'status') render(message.status);
});

// 定时刷新兜底
refresh();
setInterval(refresh, 1000);
