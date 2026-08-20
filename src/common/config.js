// ============================================================================
// 扩展配置：默认值 + 读写（chrome.storage.local）
// 对应计划书 3.13 配置设计（浏览器桥接部分）。
// ============================================================================

import { Codec, DEFAULT_LOGICAL_WIDTH, DEFAULT_LOGICAL_HEIGHT } from './protocol.js';

const STORAGE_KEY = 'bgiBridgeConfig';

/** @typedef {ReturnType<typeof defaultConfig>} BridgeConfig */

export function defaultConfig() {
  return {
    // 本地桥接服务地址（仅回环）。
    host: '127.0.0.1',
    port: 51888,
    // 一次性连接 Token；正式版应由 BetterGI 通过 Native Messaging 下发。
    token: '',

    // 画面参数
    logicalWidth: DEFAULT_LOGICAL_WIDTH,
    logicalHeight: DEFAULT_LOGICAL_HEIGHT,
    targetFps: 15,
    codec: Codec.WEBP, // 优先 WebP，兼容性问题时可切 JPEG
    quality: 0.8,      // 0~1

    // 相对鼠标灵敏度系数（计划书 2.10.3）
    relativeMouseScaleX: 1.0,
    relativeMouseScaleY: 1.0,

    // 稳定性参数
    frameTimeoutMs: 2000,   // 连续冻结告警阈值
    heartbeatMs: 1000,      // 心跳间隔
    heartbeatMiss: 3,       // 连续失联判定
    autoReconnect: true,

    // 背压：帧通道 WebSocket bufferedAmount 超过该阈值则丢弃新帧
    sendBufferHighWaterMark: 512 * 1024,
  };
}

/** 读取配置（与默认值合并）。 */
export async function loadConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...defaultConfig(), ...(stored[STORAGE_KEY] || {}) };
}

/** 保存部分配置。 */
export async function saveConfig(partial) {
  const cur = await loadConfig();
  const next = { ...cur, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** 组装帧/控制通道 WebSocket 地址。 */
export function buildWsUrl(config) {
  return `ws://${config.host}:${config.port}/bridge`;
}
