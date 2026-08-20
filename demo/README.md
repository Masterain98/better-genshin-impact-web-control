# Demo · BetterGI Web Cloud Bridge 测试台

零依赖的 **Node 测试服务端**，用于在不接入完整 BetterGI 的前提下，端到端验证
`better-genshin-impact-web-control` 扩展的 **画面捕获** 与 **CDP 输入** 链路是否可行。

它临时扮演 BetterGI 侧的 `BrowserBridgeServer` 角色：接收扩展回传的画面帧、把查看器
发出的键鼠指令注入 `sessionId` / `sequence` 后转发给扩展。所有逻辑仅用 Node.js 内置
模块实现，无需 `npm install`。

> Node.js 18+ 即可。仅监听回环地址 `127.0.0.1`，不对外暴露。

---

## 它验证什么

- **画面链路**：扩展能否持续捕获网页云原神标签页画面并经 WebSocket 回传。
- **输入链路**：扩展能否通过 CDP 把键盘、绝对点击、拖拽、滚轮等输入注入到云原神。
- **后台健壮性**：标签页切走 / 窗口被遮挡 / 最小化时，捕获与输入是否仍工作。
- **断线释放**：服务端断开后，扩展是否幂等 `ReleaseAll`，避免按键卡死。

---

## 架构与数据流

```
云原神标签页
   │ (tabCapture)
   ▼
Chrome 扩展 ──frame WS（二进制帧）──▶ demo 服务端 ──▶ 网页查看器（看画面）
Chrome 扩展 ◀─control WS（JSON 指令）─ demo 服务端 ◀─ 网页查看器（发指令）
```

`server.js` 监听 `127.0.0.1:51888`，提供三条端点：

| 端点 | 用途 |
| --- | --- |
| `ws://127.0.0.1:51888/bridge` | 扩展连接（control + frame 两条，按 `hello.channel` 区分） |
| `ws://127.0.0.1:51888/viewer` | 网页查看器连接 |
| `http://127.0.0.1:51888/` | 网页查看器页面 |

服务端职责：

- 收到扩展 `hello` 后回 `hello_ack`（逻辑分辨率 1920×1080，目标 15 FPS）。
- 解析二进制帧头，转发画面给所有查看器。
- 把查看器指令自动注入 `sessionId` / 递增 `sequence`，拖拽类附带 `viewportRevision`，再转发给扩展。
- 实时广播桥接状态、`capture_status`、`viewport_changed`、`video_stalled`、`debugger_detached`、`session_error`、`release_all_ack` 等事件，便于诊断。

---

## 运行步骤

1. **启动测试服务端**

   ```bash
   cd demo
   node server.js
   # 或 npm start
   ```

   > 端口可用环境变量覆盖：`PORT=51888 node server.js`（需与扩展 Options 中端口一致）。

2. **加载扩展**：在 `chrome://extensions` 开发者模式加载本仓库根目录（含 `manifest.json`）。

3. **打开云原神**：访问 <https://ys.mihoyo.com/cloud/#/> 并进入游戏画面。

4. **连接**：点击扩展图标 →「连接 BetterGI」。扩展会连到本测试服务端。

5. **打开测试台**：浏览器访问 <http://127.0.0.1:51888/>。
   - 应能看到云原神实时画面（验证画面链路）。
   - 顶部「控制通道 / 帧通道」徽标变绿表示扩展已连上。

6. **测试输入**（验证 CDP 输入链路）：
   - 点击画面 → 绝对点击；按住拖动 → 拖拽；滚轮 → 缩放。
   - 移动 / 常用键按钮：`W/A/S/D`/空格为长按，`F/E/Q/Esc/1-4` 为短按。
   - 勾选「捕获本页键盘」→ 直接用键盘操作。
   - 勾选「画面内启用相对鼠标」→ 点击画面进入 Pointer Lock，移动鼠标测试视角。
   - `ReleaseAll` 释放所有按键。

---

## 验证清单

| 验证项 | 观察点 |
| --- | --- |
| 后台标签页持续捕获 | 切到别的标签页，测试台画面是否继续更新 |
| Chrome 被遮挡 | 用其他窗口盖住 Chrome，画面是否继续 |
| Chrome 最小化 | 最小化后画面 / 帧率变化（重点观察） |
| 键盘输入 | `W` 前进、`F` 交互、`Esc` 菜单等是否生效 |
| 绝对点击 | 点击传送点 / 对话选项是否命中 |
| 拖拽 / 滚轮 | 地图拖动与缩放是否正常 |
| 相对鼠标 | Pointer Lock 下视角是否旋转（核心风险项） |
| 断线释放 | 关闭测试服务端 / 打开 DevTools，扩展是否 `ReleaseAll` |

服务端日志与查看器内的「状态 / 日志」面板会显示上述扩展回传事件，便于定位问题。

---

## 文件结构

```
demo/
├── server.js            HTTP + WebSocket 服务器与消息路由
├── package.json         脚本与 engines（Node >=18）
├── lib/
│   ├── miniws.js        零依赖 WebSocket 服务端（RFC6455 精简实现）
│   └── frame.js         二进制帧头解析（与扩展 protocol 对齐）
└── public/
    ├── index.html       测试台页面
    ├── viewer.js        画面显示与指令发送
    └── viewer.css       样式
```

---

## 注意事项

- 这是**可行性验证工具**，不是生产实现；Token 认证、Native Messaging 端口发现、
  多会话等将在 BetterGI 正式集成时实现。
- 相对鼠标（视角）为实验实现：若在此 demo 中无法稳定驱动，对应核心技术风险，
  需进一步研究 Pointer Lock / 页面注入 / 协议路线。
- 本目录在打包扩展时被 `script/package-extension.ps1` 排除，不会进入发布产物。
