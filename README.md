# BetterGI Web Cloud Bridge（better-genshin-impact-web-control）

让 **BetterGI（better-genshin-impact）** 能够后台驱动 **网页云原神** 的 Chrome 扩展与桥接生态。

网页云原神（<https://ys.mihoyo.com/cloud/#/>）运行在浏览器标签页中，BetterGI 原本无法直接读取其画面或注入操作。本项目提供一个 **Manifest V3 Chrome 扩展**，在用户主动选择的云原神标签页上建立「画面回传 + 输入注入」的双向桥接：BetterGI 侧通过本地回环 WebSocket 接收标准化画面帧，并把键鼠操作经 CDP 注入到该标签页，从而实现对网页云原神的后台自动化控制。

本仓库同时附带一个零依赖的 **Node 测试台（位于 `demo/`）**，用于在不接入完整 BetterGI 的情况下验证扩展的画面捕获与输入链路。

---

## 它解决什么问题

| 痛点 | 本项目的做法 |
| --- | --- |
| BetterGI 无法获取云原神画面 | 通过 `chrome.tabCapture` 捕获标签页画面，裁剪黑边并缩放为标准 1920×1080，经 Offscreen Document 编码为 WebP/JPEG 帧流回传 |
| BetterGI 无法操作云原神 | 通过 Chrome DevTools Protocol（CDP）向标签页注入键盘、绝对点击、拖拽、滚轮等输入 |
| 后台运行与资源占用 | 仅在用户主动绑定的标签页上工作，断线/关闭时幂等释放所有按键与鼠标状态 |
| 安全与隐私 | 调试权限仅附加到用户选择的标签页，停止会话后立即 detach，不读取历史、不导出 Cookie、不开放远程调试端口 |
| BGI 只能控制本机运行的云原神 | 桥接通道基于本地回环 WebSocket，BGI 与扩展可部署在不同机器上：将扩展装入远端运行网页云原神的机器，BGI 侧经可控转发连回该机器即可远程驱动非本机的网页云原神（控制端与被控端解耦，互不要求同机） |

---

## 核心能力

- **标签页绑定与会话管理**：生成 `sessionId`，监控 tab / CDP / WebSocket 生命周期，会话隔离（sessionId / sequence / viewportRevision 校验）。
- **后台画面捕获**：`chrome.tabCapture` + Offscreen Document 持续处理，自动裁剪黑边并缩放至 1920×1080。
- **低带宽帧传输**：自定义二进制帧头 + WebSocket，仅保留最新帧（背压控制），支持 JPEG / WebP。
- **CDP 输入注入**：键盘、绝对鼠标点击、拖拽、滚轮，以及相对鼠标（视角控制，见下方说明）。
- **安全释放**：断线 / detach / 关闭时幂等 `ReleaseAll`，避免按键卡死。
- **握手与心跳**：`hello`/`hello_ack` 握手，1 秒心跳，连续 3 次失联自动停止。
- **状态面板与诊断**：Popup 实时状态、Options 高级设置、诊断信息导出。

> **相对鼠标（视角控制）为实验实现**：当前通过虚拟光标 + `mouseMoved` 近似模拟，Pointer Lock 相对量驱动仍需在真实云原神页面进一步验证。

---

## 目录结构

```
better-genshin-impact-web-control/
├── manifest.json                  # 扩展清单（Manifest V3）
├── README.md                      # 本文件
├── CONTRIBUTING.md                # 开发指南
├── script/
│   └── package-extension.ps1      # 打包脚本（排除 demo/）
├── src/                           # Chrome 扩展源码
│   ├── background/
│   │   ├── service-worker.js      # 控制中心：会话、控制通道 WS、握手/心跳、生命周期
│   │   └── cdp-input.js           # CDP 输入注入（键盘/鼠标/滚轮/相对/ReleaseAll）
│   ├── offscreen/
│   │   ├── offscreen.html         # Offscreen 容器（隐藏 <video>）
│   │   └── offscreen.js           # tabCapture 消费、裁剪缩放编码、帧通道 WS、背压
│   ├── content/
│   │   └── content-script.js      # 游戏视口几何检测与上报
│   ├── popup/                     # 控制界面
│   ├── options/                   # 高级设置
│   └── common/                    # 协议常量、配置、坐标、键映射、日志
└── demo/                          # Node 测试台（详见 demo/README.md）
    ├── server.js                  # HTTP + WebSocket 测试服务端
    ├── package.json
    ├── lib/                       # miniws.js（WS）、frame.js（帧解析）
    └── public/                    # 浏览器端查看器
```

---

## 安装与加载（开发者模式）

1. 打开 Chrome，访问 `chrome://extensions`。
2. 右上角开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本仓库根目录（含 `manifest.json`）。
4. 打开 <https://ys.mihoyo.com/cloud/#/> 并进入云原神。
5. 在 BetterGI 侧启动本地桥接服务（默认 `ws://127.0.0.1:51888/bridge`）。
6. 点击扩展图标 → 「连接 BetterGI」。

> `debugger` 权限会显示较强的安全提示，调试仅附加到用户主动选择的云原神标签页，停止会话后立即 detach。

**环境要求**：Chrome 116+（用于 WebSocket 保活 Service Worker 与 `chrome.runtime.getContexts`）。

---

## 通信协议摘要（供 BetterGI 侧对接）

WebSocket 端点：`ws://127.0.0.1:<port>/bridge`（仅回环）。扩展建立两条连接，通过 `channel` 字段区分：

- `channel: "control"`（Service Worker）：JSON 控制通道，承载握手 / 输入 / 心跳 / 状态。
- `channel: "frame"`（Offscreen）：二进制画面帧 + `capture_status`。

### 握手

扩展发送 `hello`：

```json
{
  "type": "hello",
  "channel": "control",
  "protocolVersion": 1,
  "extensionVersion": "0.1.0",
  "sessionId": "…",
  "token": "…",
  "browser": "Chrome",
  "capabilities": ["tab_capture","absolute_mouse","keyboard","mouse_wheel","relative_mouse"]
}
```

BetterGI 返回 `hello_ack`：

```json
{
  "type": "hello_ack",
  "protocolVersion": 1,
  "accepted": true,
  "logicalWidth": 1920,
  "logicalHeight": 1080,
  "targetFps": 15
}
```

### 二进制帧头（小端）

```
magic(uint32='BGIF') protocolVersion(uint16) codec(uint8:0=jpeg,1=webp) flags(uint8)
frameSequence(uint32) captureTimestamp(float64,ms)
width(uint16) height(uint16) viewportRevision(uint32)
sessionIdLen(uint16) sessionId(utf8...) payloadLength(uint32) payload(...)
```

### 消息类型

- 扩展 → BetterGI：`hello` `frame(二进制)` `capture_status` `viewport_changed` `tab_status` `input_status` `heartbeat` `video_stalled` `debugger_detached` `session_error` `release_all_ack`
- BetterGI → 扩展：`hello_ack` `start_capture` `stop_capture` `key_event` `mouse_click` `mouse_move_absolute` `mouse_move_relative` `mouse_drag` `mouse_wheel` `release_all` `ping` `update_config` `shutdown_session`

输入消息应携带 `sessionId`、递增 `sequence`；坐标类默认使用 `bgi-logical`（1920×1080）坐标空间，拖拽类可带 `viewportRevision`，版本不匹配将被拒绝执行。

---

## 打包发布

使用 `script/package-extension.ps1` 将扩展打包为 zip（自动排除 `demo/` 等无关内容）：

```powershell
pwsh ./script/package-extension.ps1
```

输出 `better-genshin-impact-web-control.zip`，可直接在 `chrome://extensions` 通过「打包扩展程序」或拖入加载。

---

## 已知限制

- 相对鼠标视角控制为实验实现，需在真实云原神页面验证 Pointer Lock 行为。
- Native Messaging 端口发现与 Token 下发尚未接入，当前使用固定端口 + 可选 Token（Options 配置）。
- Chrome 窗口最小化下的实际行为需进一步验收。
- 图标暂未提供（使用 Chrome 默认扩展图标）。

---

## 相关文档

- [CONTRIBUTING.md](./CONTRIBUTING.md) — 开发环境、目录结构、协议约定与提交流程。
- [demo/README.md](./demo/README.md) — Node 测试台用法，用于独立验证扩展链路。
