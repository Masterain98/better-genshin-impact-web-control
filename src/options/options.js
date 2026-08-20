// ============================================================================
// Options 高级设置页
// ============================================================================

import { loadConfig, saveConfig, defaultConfig } from '../common/config.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = ['host', 'token'];
const NUM_FIELDS = [
  'port', 'logicalWidth', 'logicalHeight', 'quality',
  'relativeMouseScaleX', 'relativeMouseScaleY', 'frameTimeoutMs', 'heartbeatMs',
];

function fill(cfg) {
  for (const f of TEXT_FIELDS) $(f).value = cfg[f] ?? '';
  for (const f of NUM_FIELDS) $(f).value = cfg[f] ?? '';
  $('targetFps').value = String(cfg.targetFps ?? 15);
  $('codec').value = String(cfg.codec ?? 1);
  $('autoReconnect').checked = !!cfg.autoReconnect;
}

function collect() {
  const cfg = {};
  for (const f of TEXT_FIELDS) cfg[f] = $(f).value.trim();
  for (const f of NUM_FIELDS) cfg[f] = Number($(f).value);
  cfg.targetFps = Number($('targetFps').value);
  cfg.codec = Number($('codec').value);
  cfg.autoReconnect = $('autoReconnect').checked;
  return cfg;
}

async function init() {
  fill(await loadConfig());
}

$('save').addEventListener('click', async () => {
  await saveConfig(collect());
  $('saved').textContent = '已保存 ✓';
  setTimeout(() => ($('saved').textContent = ''), 2000);
});

$('reset').addEventListener('click', async () => {
  const def = defaultConfig();
  fill(def);
  await saveConfig(def);
  $('saved').textContent = '已恢复默认 ✓';
  setTimeout(() => ($('saved').textContent = ''), 2000);
});

init();
