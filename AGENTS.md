# AGENTS.md — voice-channels-p2p（持久化语音频道）

基于 MiroTalk P2P 深度定制：仅语音 + 文字聊天的持久化频道系统（mesh WebRTC P2P、网页管理后台、按频道配置主持人、临时房间、P2P 图片消息）。前端为原生 HTML/CSS/JS + ES Modules，**无构建步骤**。

## 常用命令

- 启动：`npm start`（prestart 自动从 config.template.js 创建 app/src/config.js）
- 测试：`npx mocha tests/ --exit`（当前 194 passing；含 test-server.js 信令集成测试——起真实 :3100 实例、自动备份/还原 channels.json 与 chat_history（`process.on('exit')` 兜底崩溃还原）、审计重定向到临时文件；改动 channelStore/chatStore/server.js 信令/校验逻辑必须回归）
- 检查：`npm run lint` = `eslint . && prettier --check . && node scripts/check-file-size.js`（只查不改，CI 同款）；格式化：`npm run format`（prettier --write）。ESLint flat config 在 `eslint.config.js`（CJS 服务端 + ESM 前端分组，rules 极简 + `max-lines` 预算）
- 测试实例约定：`PORT=3100 CHANNEL_ADMIN_PASSWORD=pw CHANNEL_ADMIN_JWT_SECRET=sec node app/src/server.js`
  **绝不杀 3000 端口进程——那是用户自己的实例。** 测试后删除 `app/src/channels.json` 与临时日志。
- PWA 图标重新生成：`node scripts/gen-pwa-icons.js`（手写 PNG 编码，无图像依赖）

## 目录与架构边界

- `app/src/server.js` — Express + socket.io 信令（join→addPeer→relaySDP/relayICE→removePeer mesh 协议）、REST API、`/c/:id` 路由。**房间成员身份 = 会话 `peer_uuid`（join 时严格校验 uuid 形状，防碰撞 lock/password 等元键）**：异常断线（VPN/加速器切换、网络抖动）先挂起为幽灵会话（15s 宽限，ping-timeout 检出者 5s；宽限常量可经 `GHOST_GRACE_MS`/`GHOST_GRACE_LATE_MS` 注入，测试用），期间不广播 removePeer；同 uuid 重连即原地 resume（addPeer 带 `rejoin:true`，双方复用既有 PC，靠 ICE-restart 恢复阶梯治愈，不重协商），宽限过期才真正移除。主动断开（leave/kick/evict/客户端 B1）仍立即广播。管理/导出 API：`/api/admin/channels` 附每频道成员名单（含 ghost 标记）、`/api/admin/kick` 远程移出、`/api/admin/backup` tar.gz 备份（tar 写入器在 `app/src/backup.js`）、`/api/admin/restore` 上传恢复（校验+全量替换逻辑在 `app/src/restore.js`）、`/api/admin/stats` 统计、`/api/admin/audit` 审计尾部、`/api/host/:id/export` 主持人 Markdown 导出。聊天生命周期事件 `chatEdit`/`chatDelete`/`chatReact`（撤回：本人或主持人；编辑：仅本人）走服务器广播（含仅文字成员），服务器是历史存储的 single writer。`/api/*` 挂全局 IP 限流（600/5min，登录端点除外），`chatPage` 每 socket 30/10s 节流。定时滚动备份：`CHANNEL_BACKUP_INTERVAL_HOURS`/`CHANNEL_BACKUP_KEEP`/`CHANNEL_BACKUP_DIR`（env 直读，不经 config.js）。TURN 支持 REST/HMAC 临时凭证（`TURN_SERVER_SECRET`，coturn use-auth-secret，半衰期重铸；未设 secret 走静态账号）。**server.js 只是装配点**（express/io/TURN/stores/中间件/页面路由/公共 API），协议与 REST 分域在旁：`rooms.js`（房间状态 + 会话/幽灵生命周期 + 收发助手，工厂注入 stores）、`chatGateway.js`（聊天生命周期五处理器 + 限流 + 图片批次）、`signaling.js`（join/relay/roomAction/peer* + join 防爆破）、`adminApi.js`（/api/admin/* + /api/host/* + 备份恢复 + 定时备份）、`payload.js`（密码例外清洗等共享工具）；模块经依赖注入协作，`getIceServers`/token 签发等由 server.js 传入
- `app/src/audit.js` — 审计 JSONL（`audit.jsonl`，`VC_AUDIT_FILE` 可重定向）：join/leave/ghost 过期/踢人/频道增删改/备份恢复，>5MB 轮转 `.1`，内存尾部 2000 行供 admin tail
- `app/src/limits.js` — 服务端共享线格式常量单一来源：频道 ID 正则（含可内嵌的 source 形式）、data-URL 图片白名单、昵称 24/正文 500/引用 80/emoji 16 上限、单图 1.6MB、头像 96KB、默认人数 8。server/chatStore/channelStore/restore 一律引这里；前端镜像常量在 `public/js/core/images.js`（`MAX_TRANSFER_CHARS`/`DATA_URL_RE`），改动须两侧同步
- `app/src/channelStore.js` — 频道注册表（channels.json 原子写）+ 临时房间（仅内存）；ID 规则 `^[a-zA-Z0-9_-]{3,32}$`，空 ID 自动生成；频道字段含可选 `chatRetentionHours`（空=继承全局设置）。**密码全部原文哈希/比对（绝不过 checkXSS——DOMPurify 会改写含 `<`/`>`/`&` 的密钥）**；存量旧哈希经 `legacySanitize`（server.js 注入）回退兼容，`verifyPasswordCompat` 为入口。`sanitize()` 的 `includePrivate:true` 才输出 hosts 用户名（仅 admin 台使用，公共端点不泄露）
- `app/src/chatStore.js` — 聊天历史留存（**JSONL 追加写 + 事件行重放** `chat_history/<id>.jsonl`：新消息 append 一行 appendSync O(1)；编辑/撤回/回应追加 `{"e":"edit|del|react",...}` 事件行、保留窗口/上限裁剪追加 `{"e":"drop","n":<数量>}` 前缀丢弃标记（均带有限 `ts` 以过 restore 逐行校验），加载时按序重放，交互路径**零全量重写**；全量重写仅发生在：跨过 90% 预算后 ~1s 的合并后台压缩、单条追加越过硬预算的内联收缩、旧 `<id>.json` 迁移、append 失败兜底；空闲频道 sweep 走 stat+尾部抽样（`sweepState` 记账：文件未变且未到保留期边界直接跳过，整文件过期凭尾部 ts 擦除免全量解析）；撕裂尾行容忍跳过；基准用例见 `tests/test-chatstore-perf.js`）。保留时长按频道解析：频道 `chatRetentionHours` 覆盖 → 全局 `settings.chatRetentionHours`，0=不保留；临时房间仅内存、随房间销毁。行结构 `{ts,name,text,imgs?,reply?,edited?,deleted?,reactions?}`（reply=回复引用摘要 `{name,text≤80,ts}`；deleted 行变墓碑保留 ts 以稳游标；reactions=emoji→昵称数组，≤8 emoji/50 人；`edit`/`remove`/`react` 按 ts+name 定位；`exportAll(id)` 供主持人导出；`reload()` 清内存缓存与 sweepState 供恢复用）。聊天实时收发仍走 DataChannel P2P（typing 指示也走 DC，`{type:'typing'}`），仅发送端向服务器 `chat` 事件同步一份副本存储（带图片时 1 个 head 事件 + 每图 1 个事件，服务端组装，单图上限 1.6MB 字符），历史分页下发：join 时 `chatHistory` 事件只带最近 `CHAT_PAGE_SIZE`(10) 条，客户端滚到顶部经 `chatPage`（socket.io ack）按 `before` ts 游标逐页回拉，每页 2MB 字节预算、页边界不切同 ts 消息组）
- `app/src/version.js` — 前端版本信息：package.json 版本 + `public/` 内容 sha256 指纹（启动时算，memoized），经 `GET /api/version` 下发；前端 `js/core/version.js` 每 5 分钟轮询（`CHECK_MS`，切回标签页立即查），build 变了在顶部弹软提示条（`base.css .update-banner`，可关闭，同 build 折叠）
- `app/src/config.js` — 仅 7 个存活配置块；改配置须同步 `config.template.js` 与 `.env.template`（定时备份三个 env 直读、不经 config.js，老 config.js 无需重建）
- `public/` — 前端全部在此：
    - `js/core/`（api/socket 内联于页面/webrtc mesh/audio WebAudio 管线/chat 消息列表/emoji 调色板+选择器/images/dropdown/i18n 含 `setLang`/sound 操作音效/theme 三态 dark|light|auto/utils/version 版本检测）
    - `js/pages/`（index/channel/admin 页面控制器，channel.js 是核心但**只留共享状态与装配**；`js/pages/channel/` 子模块：recovery（自愈状态机）、members、voice、settings、composer、notify、offline（离线横幅）、hostAuth、socketEvents、wakeLock、share（一起听）、debug 钩子——子模块为工厂函数，共享可重赋值状态经控制器的 `s` 存取器、跨模块调用经晚绑定 `x` 面，改接口先看 channel.js 尾部的 `Object.assign(x, …)`）
    - `lang/zh.json`、`lang/en.json` 扁平键词典；`t(key, {name})` 占位符为 `{name}` 形式
    - `manifest.webmanifest` + `images/icon-*.png` — PWA 安装（图标由 `scripts/gen-pwa-icons.js` 生成）；`sw.js` — service worker（导航 network-first 且双键缓存「路由 URL + shell 资产路径」，`/images/**` cache-first，其余同源 GET SWR；`/api/**`、`/socket.io/**`、非 GET、跨域直通；**版本横幅的重载前必经 version.js 的 `vc-purge-static` 消息清静态缓存**，改缓存策略须同步 bump 缓存名后缀），注册在 `js/core/theme-boot.js`
- `tests/` — mocha + should（channelStore/chatStore/validate/xss/version/opusFmtp/backup 含 tar reader/restore/audit/logs/i18n 词典对齐/embedHeaders CSP/server 信令集成）。**测试文件里不得提前 require `app/src/config.js`**——config 按 env 缓存，会污染 test-server.js 的 env 预置（参见 test-embed-headers.js 的缓存自清理）

## 关键约定与坑

- **XSS 防护**：全部用户文本走 `textContent`/el() 工具；图片仅允许 `data:image/` URL（regex 白名单）。新增渲染代码必须遵守。**密码类字段例外**：绝不过 checkXSS（见 channelStore 条目）。
- **服务器 join 加固**：`peer_name` 服务端强制 ≤24 且非空；join 处理器整体 try/catch，失败时回滚已写入的房间状态并 emit `joinError`；防爆破计数按 IP（`normalizeIp` 归一，10 次/60s 冷却）。
- **Chromium 远端流 WebAudio 静音 bug**：远端 WebRTC 流必须挂一个 muted `<audio>` 预热元件（见 `audio.js _prime`），否则 GainNode 抽头无声；AudioContext 被挂起时播放/发送走 `<audio>` 元件回退，恢复后由 `statechange` 自动迁移（`channel.js onCtxStateChange`/`syncMicPipeline`）。
- **localStorage 键**：`vc_nick`、`vc_audio_settings`（含音乐模式/码率滑块）、`vc_peer_volumes`（按昵称记忆）、`vc_avatar`（自定义头像 data URL）、`vc_send_key`（Enter/Ctrl+Enter 发送偏好）、`vc_sound_settings`（操作音效，可含自定义音效 data:audio/ URL，上限 512KB）、`vc_notify`（被 @ 桌面通知开关）、`vc_fav_channels`（首页收藏）、`vc_recent_channels`（首页最近访问）、`vc_lang`（语言 zh/en）、`vc_host_token_<channelId>`（主持人凭据，默认 30 天）、`vc_chan_pw_<channelId>`（记住的频道密码）；首页「清除全部」会一并清理（`vc_theme` 主题偏好刻意保留，值域 dark/light/auto）。
- **管理后台**：未配置 `CHANNEL_ADMIN_PASSWORD`+`CHANNEL_ADMIN_JWT_SECRET` 时 /admin 与 API 全部 404（无不安全默认值）；host 登录 JWT 用 `CHANNEL_HOST_JWT_EXP`（默认 30d）。恢复备份是全量替换：备份里没有的频道其历史会被清除。
- **语法检查前端 ES Modules**：`node --check` 需先复制为 `.mjs`。
- **i18n**：改 UI 文案须同时更新 zh/en 两个词典（JSON 4 空格缩进，结尾单个换行）。
- **临时房间**：仅在内存（channelStore.temps），最后一人离开即删（聊天历史随之删除）；`TEMP_ROOMS_ENABLED=false` 可关闭；未注册 ID 的元数据走"虚拟预览"（server.js `/api/channels/:id`）。
- **静态缓存**：`public/images/**` 长缓存 7 天 immutable，其余 js/css 5 分钟 + must-revalidate（HTML 一律 no-cache；版本更新横幅兜底）。
- **文件行数预算**：所有 JS ≤1000 行（ESLint `max-lines` 强制）、所有 CSS ≤1000 行（`scripts/check-file-size.js`，都在 `npm run lint`/CI 里）。超限就按域拆模块；CSS 拆分必须按**连续段落**切、靠 channel.html 的 `<link>` 顺序保持级联次序（现状参照：channel.css / channel-widgets.css / channel-messages.css）。

## Git 与环境

- 分支 `main`（`master` 是上游镜像分支，仅用于对照，不在上面提交）。提交信息用 conventional-commit 风格，中文描述可用。
- remote：`origin` = 本仓库、`upstream` = [miroslavpejic85/mirotalk](https://github.com/miroslavpejic85/mirotalk)（只读参考）、`legacy` = 拆分前的旧仓库。
- 本仓库是 MiroTalk P2P 的衍生作品（AGPL-3.0），来源与分叉基线见 `README.md`「来源与版本」与 `NOTICE`。
- 版本号自 **v1.0.0** 独立计数，不要沿用上游 `2.0.30` 序列；**只推指定 tag**，别用 `git push --tags`。
- 镜像标签纪律：每次构建只推「版本号 + `latest`」，**不要恢复短 SHA 标签**（每次构建多一个 tag，仓库会迅速膨胀）。镜像同时推 **ACR**（`b1at-public/voice-channels`，部署用）与 **GHCR**（`ghcr.io/junncey/voice-channels`，归档用），两边都只留最新 **3** 个版本：GHCR 由 `prune-ghcr` 任务自动删（`scripts/ghcr-prune.py`），ACR 个人版无删除 API、只能控制台手删（构建后 `Tag audit` 步骤会打印待删清单）。
- Shell 为 Windows Git Bash（本机推送遇网络问题时，可临时加 `git -c http.proxy=…`）。

## 浏览器自动化备忘（实测坑）

- `playwright.evaluate` 只接受表达式——语句需包 IIFE；`fill/press` 不可靠，用 evaluate 内 `element.click()`/`form.requestSubmit()`。
- CDP 点击不构成 Chrome 用户激活（AudioContext resume 等手势要求会失败）；后台标签 `setTimeout` 被深度节流（测量循环失效），改为外部节拍轮询或 `osc.stop(ctx.currentTime + s)` 音频时钟排程。
- 同一 IAB 各标签共享 localStorage——多身份测试必须用 `?name=` 参数，重载会互相覆盖 `vc_nick`。
- `location.hash === '#debug'` 门控的 `window.__vcDebug()/__vcTone()/__vcStats()` 检查钩子在 `js/pages/channel/debug.js`（由 channel.js 尾部安装，活快照读控制器状态），音频问题先用它定位。

## 敏感区改动前先读

- WebRTC/音频链路：`public/js/core/audio.js`、`webrtc.js` 头部注释
- 部署/环境变量：`.env.template`、`docs/self-hosting.md`、`docs/coturn.md`
- 上游差异与功能清单：`README.md`
