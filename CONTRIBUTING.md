# 开发指南（CONTRIBUTING）

本文档面向希望参与 **BetterGI Web Cloud Bridge（better-genshin-impact-web-control）** 开发的贡献者，介绍开发环境、目录结构、桥接协议约定与提交流程。

---

## 1. 开发环境

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Chrome / Chromium | 116+ | 加载并调试 Manifest V3 扩展（WebSocket 保活 Service Worker、`chrome.runtime.getContexts`） |
| Node.js | 18+ | 运行 `demo/` 测试台（仅用于本地验证，非扩展运行依赖） |
| PowerShell | 7+（`pwsh`） | 运行 `script/package-extension.ps1` 打包脚本（Windows 环境） |

无需任何第三方 npm 依赖：扩展为原生 JS（ES Module），测试台为零依赖 CommonJS。

---

## 2. 本地调试流程

1. 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」选择本仓库根目录（含 `manifest.json`）。
3. 打开 <https://ys.mihoyo.com/cloud/#/> 并进入云原神。
4. 启动桥接服务端：
   - 生产路径：BetterGI 内置 `BrowserBridgeServer`（默认 `ws://127.0.0.1:51888/bridge`）。
   - 本地验证：进入 `demo/` 执行 `node server.js`（详见 `demo/README.md`）。
5. 点击扩展图标 →「连接 BetterGI」，`popup` 实时显示连接状态。

修改 `src/` 后，回到 `chrome://extensions` 点击扩展卡片上的「刷新」按钮即可重新加载；Service Worker 的调试入口在卡片的「检查视图」（`service-worker.js`）。

---

## 3. 目录结构与模块职责

```
src/
  background/
    service-worker.js   控制中心：会话管理、control WS、握手/心跳、生命周期、路由
    cdp-input.js        CDP 输入注入（键盘/鼠标/滚轮/相对鼠标/ReleaseAll）
  offscreen/
    offscreen.html       Offscreen 容器（隐藏 <video>）
    offscreen.js         tabCapture 消费、裁剪缩放编码、frame WS、背压与统计
  content/
    content-script.js    游戏视口几何检测与上报（自包含，无 import）
  popup/                 控制界面（html/css/js）
  options/               高级设置（html/js）
  common/                协议与工具（被 SW/Offscreen/Popup 以 ES Module 复用）
    protocol.js          协议常量 + 二进制帧编码（唯一权威定义）
    config.js            默认配置与读写
    coordinate.js        坐标/裁剪转换
    keymap.js            DOM code -> CDP 键参数
    logger.js            环形日志
```

> **约定**：`common/protocol.js` 是协议唯一权威来源。Content Script 无法直接 `import` ES Module，因此 `content-script.js` 内对协议常量保留了独立副本，修改协议时两边需同步。

---

## 4. 桥接协议约定

扩展与 BetterGI 通过本地回环 WebSocket 通信，端点 `ws://127.0.0.1:<port>/bridge`，建立两条连接并通过 `channel` 字段区分：

- `control`：JSON 控制通道（握手 / 输入 / 心跳 / 状态）。
- `frame`：二进制画面帧 + `capture_status`。

关键约定：

- **协议版本**：`protocolVersion` 为 `major.minor`，major 不同拒绝连接，minor 不同协商能力。当前 `PROTOCOL_VERSION = 1`。
- **会话隔离**：所有输入消息须携带 `sessionId` 与递增 `sequence`；拖拽类可带 `viewportRevision`，不匹配将被拒绝执行。
- **坐标空间**：坐标类默认使用 `bgi-logical`（1920×1080）逻辑坐标空间。
- **心跳**：1 秒一次，连续 3 次失联自动停止会话并 `ReleaseAll`。
- **安全释放**：断线 / detach / 关闭时必须幂等释放所有按键与鼠标状态，避免卡键。

完整消息类型与二进制帧头定义见根 `README.md` 的「通信协议摘要」与 `src/common/protocol.js`。

---

## 5. 提交与协作规范

- 分支策略：从 `main`（或项目约定的主干）切出特性分支，PR 合并回主干。
- 提交信息：采用简洁的祈使句，说明「做了什么」与「为什么」。
- 协议变更：修改 `common/protocol.js` 必须同步更新 `content-script.js` 的协议副本，并在 `README.md` 协议摘要中标注。
- 打包：发布前使用 `script/package-extension.ps1` 生成 zip，脚本会自动排除 `demo/`、`script/`、`.git/` 等无关内容，避免无意义体积。
- 测试台：属于验证工具（`demo/`），不纳入扩展发布包；其功能变更不影响扩展主体逻辑。

---

## 6. 常见问题

- **画面不更新**：确认云原神标签页未被关闭，检查 `popup` 的 `capture_status` 与 `video_stalled` 事件。
- **输入无效**：确认握手 `hello_ack.accepted` 为 `true`，且会话处于 `InputReady`/`Running` 状态。
- **相对鼠标（视角）异常**：该能力为实验实现，依赖页面 Pointer Lock 行为，需在新版云原神页面重新验证。
