# AGENTS.md — voice-channels-p2p（持久化语音频道）

基于 MiroTalk P2P 深度定制：仅语音 + 文字聊天的持久化频道系统（mesh WebRTC P2P、网页管理后台、按频道配置主持人、临时房间、P2P 图片消息）。前端为原生 HTML/CSS/JS + ES Modules，**无构建步骤**。

## 常用命令

- 启动：`npm start`（prestart 自动从 config.template.js 创建 app/src/config.js）
- 测试：`npx mocha tests/ --exit`（当前 115 passing；改动 channelStore/chatStore/校验逻辑必须回归）
- 格式化：`npm run lint`（prettier --write，提交前按需）
- 测试实例约定：`PORT=3100 CHANNEL_ADMIN_PASSWORD=pw CHANNEL_ADMIN_JWT_SECRET=sec node app/src/server.js`
  **绝不杀 3000 端口进程——那是用户自己的实例。** 测试后删除 `app/src/channels.json` 与临时日志。

## 目录与架构边界

- `app/src/server.js` — Express + socket.io 信令（join→addPeer→relaySDP/relayICE→removePeer mesh 协议）、REST API、`/c/:id` 路由
- `app/src/channelStore.js` — 频道注册表（channels.json 原子写）+ 临时房间（仅内存）；ID 规则 `^[a-zA-Z0-9_-]{3,32}$`，空 ID 自动生成
- `app/src/chatStore.js` — 聊天历史留存（`chat_history/<id>.json` 原子写，按 settings.chatRetentionHours 清理，0=不保留；临时房间仅内存、随房间销毁）。聊天实时收发仍走 DataChannel P2P，仅发送端向服务器 `chat` 事件同步一份副本存储（带图片时 1 个 head 事件 + 每图 1 个事件，服务端组装，单图上限 1.6MB 字符），join 时以 `chatHistory` 事件下发（按条数 200 + 2MB 字节预算截断）
- `app/src/version.js` — 前端版本信息：package.json 版本 + `public/` 内容 sha256 指纹（启动时算，memoized），经 `GET /api/version` 下发；前端 `js/core/version.js` 每 5 分钟轮询（`CHECK_MS`，切回标签页立即查），build 变了在顶部弹软提示条（`base.css .update-banner`，可关闭，同 build 折叠）
- `app/src/config.js` — 仅 7 个存活配置块；改配置须同步 `config.template.js` 与 `.env.template`
- `public/` — 前端全部在此：
  - `js/core/`（api/socket 内联于页面/webrtc mesh/audio WebAudio 管线/chat/images/dropdown/i18n/sound 操作音效/utils/version 版本检测）
  - `js/pages/`（index/channel/admin 页面控制器，channel.js 是核心）
  - `lang/zh.json`、`lang/en.json` 扁平键词典；`t(key, {name})` 占位符为 `{name}` 形式
- `tests/` — mocha + should（channelStore/chatStore/validate/xss/version）

## 关键约定与坑

- **XSS 防护**：全部用户文本走 `textContent`/el() 工具；图片仅允许 `data:image/` URL（regex 白名单）。新增渲染代码必须遵守。
- **Chromium 远端流 WebAudio 静音 bug**：远端 WebRTC 流必须挂一个 muted `<audio>` 预热元件（见 `audio.js _prime`），否则 GainNode 抽头无声；AudioContext 被挂起时播放/发送走 `<audio>` 元件回退，恢复后由 `statechange` 自动迁移（`channel.js onCtxStateChange`/`syncMicPipeline`）。
- **localStorage 键**：`vc_nick`、`vc_audio_settings`、`vc_peer_volumes`（按昵称记忆）、`vc_sound_settings`（操作音效，可含自定义音效 data:audio/ URL，上限 512KB）、`vc_host_token_<channelId>`（主持人凭据，30 天）；首页「清除全部」会一并清理。
- **管理后台**：未配置 `CHANNEL_ADMIN_PASSWORD`+`CHANNEL_ADMIN_JWT_SECRET` 时 /admin 与 API 全部 404（无不安全默认值）；host 登录 JWT 用 `CHANNEL_HOST_JWT_EXP`（默认 30d）。
- **语法检查前端 ES Modules**：`node --check` 需先复制为 `.mjs`。
- **i18n**：改 UI 文案须同时更新 zh/en 两个词典（JSON 4 空格缩进，结尾单个换行）。
- **临时房间**：仅在内存（channelStore.temps），最后一人离开即删（聊天历史随之删除）；`TEMP_ROOMS_ENABLED=false` 可关闭；未注册 ID 的元数据走"虚拟预览"（server.js `/api/channels/:id`）。

## Git 与环境

- 分支 `main`（`master` 是上游镜像分支，仅用于对照，不在上面提交）。提交信息用 conventional-commit 风格，中文描述可用。
- remote：`origin` = 本仓库、`upstream` = [miroslavpejic85/mirotalk](https://github.com/miroslavpejic85/mirotalk)（只读参考）、`legacy` = 拆分前的旧仓库。
- 本仓库是 MiroTalk P2P 的衍生作品（AGPL-3.0），来源与分叉基线见 `README.md`「来源与版本」与 `NOTICE`。
- 版本号自 **v1.0.0** 独立计数，不要沿用上游 `2.0.30` 序列；**只推指定 tag**，别用 `git push --tags`。
- 镜像标签纪律：每次构建只推「版本号 + `latest`」，**不要恢复短 SHA 标签**（每次构建多一个 tag，仓库会迅速膨胀）。公开库 `b1at-public/voice-channels` 只保留最新 **3** 个版本标签，超出需在 ACR 控制台手动删（个人版无删除 API、无生命周期规则）；`ACR_USER=… ACR_PASS=… ./scripts/acr-tags.sh` 可只读列出待删标签。
- Shell 为 Windows Git Bash（本机推送遇网络问题时，可临时加 `git -c http.proxy=…`）。

## 浏览器自动化备忘（实测坑）

- `playwright.evaluate` 只接受表达式——语句需包 IIFE；`fill/press` 不可靠，用 evaluate 内 `element.click()`/`form.requestSubmit()`。
- CDP 点击不构成 Chrome 用户激活（AudioContext resume 等手势要求会失败）；后台标签 `setTimeout` 被深度节流（测量循环失效），改为外部节拍轮询或 `osc.stop(ctx.currentTime + s)` 音频时钟排程。
- 同一 IAB 各标签共享 localStorage——多身份测试必须用 `?name=` 参数，重载会互相覆盖 `vc_nick`。
- `location.hash === '#debug'` 门控的 `window.__vcDebug()/__vcTone()/__vcStats()` 检查钩子在 channel.js 文件尾，音频问题先用它定位。

## 敏感区改动前先读

- WebRTC/音频链路：`public/js/core/audio.js`、`webrtc.js` 头部注释
- 部署/环境变量：`.env.template`、`docs/self-hosting.md`、`docs/coturn.md`
- 上游差异与功能清单：`README.md`
