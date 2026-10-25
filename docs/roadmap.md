# 优化与新功能方向（Roadmap）

> 整理日期：2026-10-24（最后同步 2026-10-25）。各项「现状」在整理时均已核实当时代码中**不存在**对应实现；已完成项的「现状」段落保留原始核实记录，实现摘录附于标题下方。

## 总览

| # | 方向 | 类别 | 价值 | 工作量 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | Opus 编码调优 + 音乐模式 | 语音质量 | 高 | 小 | ✅ 2026-10-24 |
| 2 | 成员卡片丢包率/抖动 | 语音质量 | 中 | 小 | ✅ 2026-10-24 |
| 3 | 移动端 Wake Lock | 语音质量 | 高 | 小 | ✅ 2026-10-24 |
| 4 | 表情回应（reactions） | 聊天体验 | 高 | 中 | — |
| 5 | @提及 + 回复引用 + 未读通知 | 聊天体验 | 高 | 中 | ✅ 2026-10-25 |
| 6 | 消息撤回 | 聊天体验 | 中 | 中 | — |
| 7 | 缺省头像（昵称哈希生成） | 聊天体验 | 中 | 小 | — |
| 8 | admin 实时成员名单 | 运维管理 | 高 | 中 | ✅ 2026-10-25 |
| 9 | TURN 临时凭证（HMAC） | 运维管理 | 高 | 中 | ✅ 2026-10-25 |
| 10 | 一键备份 / 聊天记录导出 | 运维管理 | 中 | 小 | ✅ 2026-10-25 |
| 11 | 每频道聊天保留时长 | 运维管理 | 中 | 小 | ✅ 2026-10-25 |
| 12 | 信令层集成测试 | 工程质量 | 高 | 中 | ✅ 2026-10-25 |
| 13 | `channel.js` 模块拆分 | 工程质量 | 中 | 中 | ✅ 2026-10-25（部分） |

剩余未做：**4（reactions）、6（消息撤回）、7（缺省头像）**，建议按 7 → 4 → 6（工作量小→大）推进；12/1/2/3/5/8–11 已完成，13 部分完成。

---

## 一、语音链路质量

### 1. Opus 编码调优 + 音乐模式 ✅ 2026-10-24 已完成

**实现**：`webrtc.js` 新增 `mungeOpusFmtp`（对每个本地 offer/answer 的 `opus/48000/2` fmtp 行幂等合并参数）+ `_applySendBitrate`（`setParameters().encodings[0].maxBitrate` 免重协商生效）；`channel.js` 设置面板新增「高保真（音乐）模式」开关（强制关闭降噪/AGC/回声消除并置灰三个开关，随 `vc_audio_settings` 持久化）。码率上限后续改为面板滑块（24–256kbps，步进 8；语音/音乐档默认 64/192，切档按档位重置，越界值钳制，手调值跨会话保留）；切档即时调码率，stereo 随下一次 SDP 轮（ICE restart/反向 offer）生效。回归测试：`tests/test-opusFmtp.js`。

**现状**：`public/js/core/webrtc.js` 未设置任何 Opus 参数（无 `maxaveragebitrate`/`stereo`/`usedtx`），全部走浏览器默认（Opus 默认约 32–40kbps 单声道）。

**方案**：
- 在发送侧用 `RTCRtpSender.setParameters()` 设置 `maxaveragebitrate`（语音 64k，高保真 128–192k）与 `stereo: 1`（仅高保真时）。
- 音频设置面板加「高保真/音乐模式」开关：一键关闭降噪/AGC/回声消除三个约束 + 提升码率 + 开立体声，用于一起听歌场景。按浏览器本地记忆，与现有 `vc_audio_settings` 同存。
- 可选：语音模式启用 Opus DTX（`usedtx`，静默时不发包，省电省带宽）。

**涉及**：`public/js/core/webrtc.js`、`public/js/core/audio.js`、`public/js/pages/channel.js`（设置面板）、`lang/zh.json`/`lang/en.json`。

### 2. 成员卡片显示丢包率与抖动 ✅ 2026-10-24 已完成

**实现**：`webrtc.js connPath()` 顺带提取 inbound-rtp 音频报告（packetsLost/packetsReceived/jitter/bytesReceived/timestamp 累计值）；`channel.js notePeerLoss()` 在 5 秒路径轮询间差分出丢包率/接收码率，滞回判定（连续 3 次 ≥10% 亮「网络不稳」徽章，连续 2 次 ≤5% 熄灭，中间态不计数；计数器重置防护 SSRC 切换）；路径徽章内联显示当前丢包 ≥5% 时的「丢包 n%」，悬停详情补丢包/抖动/码率。`#debug` 钩子 `__vcDebug().peers[].loss` 可查。

**现状**：每 5 秒已在轮询 `getStats`（`channel.js` 链路可见功能），但只取了 RTT 与候选对类型，丢包率、jitter 数据拿得到却没展示。

**方案**：
- 悬停详情里补 packetsLost（近 N 秒差分算百分比）、jitter、音频码率。
- 「连接中断」徽章的判定可引入持续高丢包阈值（如 >10% 持续 15s 显示「不稳定」），不再只依赖断链事件。

**涉及**：`public/js/pages/channel.js`（stats 轮询与卡片渲染）、词典。

### 3. 移动端 Wake Lock ✅ 2026-10-24 已完成

**实现**：`channel.js` 的 `syncWakeLock/releaseWakeLock` 状态机——join 成功且非仅文字时申请 `navigator.wakeLock.request('screen')`；`visibilitychange` 回前台自动重申请（后台被系统释放的 sentinel 由 `release` 事件摘除）；离开频道/teardown 释放；仅文字模式升级语音（`reacquireMic`）时补申请；不支持或被拒时静默降级。

**现状**：全代码无任何 Wake Lock 引用。手机锁屏/切后台后 WebRTC 语音常被系统杀掉，是移动端最大痛点。

**方案**：
- 频道内且已连麦时申请 `navigator.wakeLock.request('screen')`（Safari 16.4+、Chrome 均支持）；离开频道或全部断链时释放。
- 监听 `visibilitychange` 在 `released` 后回前台自动重新申请。
- 不支持或被拒时静默降级，不影响现有 `<audio>` 元件回退逻辑。

**涉及**：`public/js/pages/channel.js`。

---

## 二、聊天体验

### 4. 表情回应（reactions）

**现状**：`public/js/core/chat.js` 消息结构只有文字/图片两种，无任何 reaction 概念。

**方案**：
- 消息气泡上（长按/右键或 hover 出现小按钮）加 emoji 回应，漂浮动效显示在成员卡片上方。
- 走现有 `mirotalk_chat_channel` DataChannel 广播（新消息类型 `reaction`），不入服务器历史、仅在线成员可见（与「实时消息仅在线可见」的既有口径一致）。
- XSS 约定：emoji 走白名单集合，不引入自由文本。

**涉及**：`public/js/core/chat.js`、`public/js/pages/channel.js`、`public/css/channel.css`、词典。

### 5. @提及 + 回复引用 + 未读通知 ✅ 2026-10-25 已完成

**实现**：chat.js 富文本渲染（mentionSegments 按在线成员名高亮、自身名字加强样式）+ 回复引用块（气泡内摘要、点击滚动定位并闪烁）+ 行内回复按钮；channel.js 新增 @补全菜单（输入 @ 触发、方向键/Tab/Enter 选择）、回复条状态机（reply:{name,text≤80,ts} 随 DataChannel 与历史事件携带，服务端校验并持久化）、document.title 未读计数（后台时累加、回前台清零）、Notification 桌面通知（被 @ 且后台时弹出，设置开关 vc_notify，权限请求在开关时发起）。

**现状**：无提及、无回复引用；标签页在后台时无任何未读提示（无 `document.title` 计数、无 `Notification` 引用）。

**方案**：
- 输入 `@` 弹出在线成员昵称补全；消息中的 `@昵称` 渲染高亮，命中自己时播放提示音（复用 `vc_sound_settings` 机制）。
- 消息支持「回复」引用：气泡内展示被引消息摘要，点击滚动定位。
- 后台标签页：`document.title` 显示「(n) 未读」；被 @ 或（可选）有人加入时发 `Notification`（首次进入频道时请求权限，可全局开关）。
- 消息结构扩展需向前兼容：旧客户端收到未知类型的 DataChannel 消息应忽略而不是报错。

**涉及**：`public/js/core/chat.js`、`public/js/core/sound.js`、`public/js/pages/channel.js`、词典（新 UI 文案 zh/en 同步）。

### 6. 消息撤回

**现状**：消息一经发送不可撤回（P2P 直发 + 服务端历史副本均无删除路径）。

**方案**：
- 普通成员限时自撤（如 2 分钟），主持人不限时——权限模型与现有「静音/移出/重命名」一致，走 host JWT 校验。
- DataChannel 广播 `recall` 事件（按 ts 定位），服务端在 `chatStore` 同步删除该条；历史分页游标按 ts，删除后需确认游标边界行为（同 ts 消息组不切开的原则不变）。
- 撤回后气泡原地变为「xx 撤回了一条消息」占位，不重排。

**涉及**：`app/src/chatStore.js`（+回归测试）、`app/src/server.js`、`public/js/core/chat.js`、词典。

### 7. 缺省头像（昵称哈希生成）

**现状**：自定义头像仅存上传者本浏览器、实时同步给在线成员；新加入的成员回看历史时，从未「见过」发送者的头像位置是空的（`chat.js` 的 `avatarFor(name)` 只查本浏览器存储）。

**方案**：
- 无自定义头像时按昵称哈希生成确定性「首字母 + 色块」头像（同一昵称在所有人设备上渲染一致，HSL 均匀取色）。
- 在线收到对方自定义头像后仍优先用自定义的；本地记忆也按昵称存。

**涉及**：`public/js/core/chat.js`（或 utils 新增生成器）、`public/css/channel.css`。

---

## 三、运维与管理

### 8. admin 实时成员名单 ✅ 2026-10-25 已完成

**实现**：GET /api/admin/channels 每个频道附 members[]（uuid/昵称/主持人/麦况/ghost 宽限标记/加入时间）；POST /api/admin/kick 按会话 uuid 移出（在线成员 emit kickOut + 延迟 100ms 断开保证包冲刷；幽灵/死连接立即过期并广播 removePeer）。admin.js 在线数字可点开成员子行，逐个移出。

**现状**：管理后台「频道」列表只有每频道在线人数（`server.js` 约 508 行 `onlineOf`），看不到**谁**在哪个频道，也不能从后台直接移出成员。

**方案**：
- admin API 返回每频道的在线成员列表（昵称、加入时间、是否幽灵宽限期内、是否主持人登录态）。
- 后台频道行展开显示名单，支持单个「移出」（复用现有 kick 信令路径）。
- 注意：名单里幽灵会话仍属成员（宽限期内），标注状态即可，不要当成异常。

**涉及**：`app/src/server.js`、`public/js/pages/admin.js`、`public/css/admin.css`、词典。

### 9. TURN 临时凭证（HMAC / REST API）✅ 2026-10-25 已完成

**实现**：新增 TURN_SERVER_SECRET / TURN_CREDENTIAL_TTL_SEC 配置（默认 12h）；设置 secret 后服务端为每个进程铸造 coturn REST 凭证（username=unix 过期时间，password=base64(hmac-sha1(secret,username))），半衰期自动重铸，随 addPeer 下发；静态账号模式完全兼容保留。配置说明见 .env.template 与 docs/coturn.md。

**现状**：TURN 使用静态账号密码（`.env.template` 的 `TURN_SERVER_USERNAME/CREDENTIAL`），凭据长期有效，泄露即被白嫖中转流量。

**方案**：
- 支持 coturn `use-auth-secret` 模式：新增 `TURN_SERVER_SECRET` 配置，前端 join 时经服务端接口按 RFC 8489 标准算法生成限时凭证（username 为 `expiry:nonce`，password 为 HMAC-SHA1），有效期如 12 小时，覆盖绝大多数通话时长。
- 兼容保留静态凭据模式（现有部署零改动）；改配置须同步 `config.template.js`、`.env.template` 与 `docs/coturn.md`。

**涉及**：`app/src/config.js`、`app/src/server.js`（签发接口）、`public/js/pages/channel.js`/`webrtc.js`（iceServers 获取）。

### 10. 一键备份 / 聊天记录导出 ✅ 2026-10-25 已完成

**实现**：GET /api/admin/backup（admin JWT）下发 tar.gz（channels.json + chat_history/*.json，tar 由 app/src/backup.js 零依赖实现）；GET /api/host/:id/export（host JWT，与 join 同样的主持人资格复核）导出 Markdown。前端：admin 工具栏「下载备份」；频道页主持人可见「导出聊天」。tests/test-backup.js 验证 tar 结构 + 系统 tar 读取。

**现状**：换服务器/重建容器需手工拷贝 `channels.json` 与 `chat_history/`（README 明确提醒挂载卷），无导出功能；频道聊天记录无法导出留存。

**方案**：
- admin「服务器设置」加「下载备份」按钮：打包 `channels.json` + `chat_history/*.json` 为 zip 流式下载（纯内存拼 zip 或用 node 内置能力，不引依赖则手写 zip 头）。
- 频道维度：主持人可导出本频道历史为 Markdown（图片 data: URL 落为附件文件或内联），走 host JWT 鉴权。

**涉及**：`app/src/server.js`、`public/js/pages/admin.js`、词典。

### 11. 每频道聊天保留时长 ✅ 2026-10-25 已完成

**实现**：channelStore 频道字段 chatRetentionHours（0..2160，空/null=继承全局；validateDefinition 校验、sanitize 透出、admin 编辑器留空继承）；chatStore.retentionMs(id) 按频道解析（append/history/prune/sweep 全链路传入频道 id）；服务端构造 chatStore 时以 channelStore.get(id)?.chatRetentionHours ?? 全局设置 作为解析器。测试覆盖创建/清除/非法值/重载存活。

**现状**：保留时长是全局服务器设置（`settings.chatRetentionHours`），无法按频道差异化管理。

**方案**：
- `channelStore` 频道记录加可选 `chatRetentionHours` 字段（缺省回落全局值），`chatStore` 清理任务按频道各自的时长执行。
- admin 编辑频道处加输入框；临时房间维持仅内存不变。

**涉及**：`app/src/channelStore.js`、`app/src/chatStore.js`（+两处回归测试）、`public/js/pages/admin.js`、词典。

---

## 四、工程质量

### 12. 信令层集成测试 ✅ 2026-10-25 已完成

**实现**：tests/test-server.js（18 用例）——真实 server + socket.io-client：join/addPeer 握手、relaySDP 门控、聊天历史落盘与回放（含 reply）、chatPage 分页、幽灵宽限（异常断线不广播 / 同 uuid resume / 过期移除）、主动离开、uuid/密码/人数上限/临时房间、admin 成员名单与在线/幽灵踢出、备份魔数、host 导出鉴权。宽限常量经 GHOST_GRACE_MS 环境变量注入；套件自动备份/还原 channels.json 与 chat_history。**过程中发现并修复真 bug：chat 事件处理器用 socket.id 索引 peers（应按会话 uuid），导致文字聊天历史从未落盘。**

**现状**：现有测试（channelStore/chatStore/validate/xss/version）全部不覆盖 `server.js` 的信令协议——join→addPeer、幽灵宽限、同 uuid resume、主动断开立即广播、中转升级仲裁等逻辑零测试；而最近的提交全部集中在这个热区，回归风险最高。

**方案**：
- 新增 `tests/test-server.js`：用 `socket.io-client` 起真实 server 实例（遵守测试实例约定 `PORT=3100` + 专用密码/JWT secret），覆盖：
  - 两端 join 互收 `addPeer`、relaySDP/relayICE 转发；
  - 模拟异常断线（`disconnect()` 不发 leave）进入幽灵宽限、期间不广播 `removePeer`；
  - 宽限期内同 uuid 重连 resume（`addPeer` 带 `rejoin:true`）；
  - 宽限过期后真正移除；
  - 主动 leave/kick 立即广播；
  - 人数上限、密码、lock 等元键校验（uuid 防碰撞）。
- 时钟相关用例（宽限 15s）用伪造定时器或可注入的宽限常量，避免真实等待。

**涉及**：`tests/test-server.js`（新）、`app/src/server.js`（可能需要把宽限时常量提为可注入）。

### 13. `channel.js` 模块拆分 ✅ 2026-10-25 部分完成

**实现**：新建 public/js/pages/channel/ 子目录，wake lock（createWakeLock，含 visibilitychange 自管理）与 #debug 检查钩子（installDebugHooks + 活快照 getter）各成独立 ES Module；channel.js 从 3140 行降至约 2970 行。信令恢复/成员 UI/音频管线仍在主文件——继续拆分随功能开发逐步推进。

**现状**：`public/js/pages/channel.js` 已达约 2700 行，信令恢复、UI 渲染、音频管线、聊天逻辑、调试钩子全部在一个文件里，每次加功能都在加剧。

**方案**：
- 按「信令/恢复状态机」「成员列表 UI」「聊天面板 UI」「音频设置面板」拆为 `js/pages/channel/` 下的多个 ES Module，页面控制器只留装配与共享状态。
- 纯移动、无行为变更；`node --check` 需复制为 `.mjs` 的语法检查流程不变；`#debug` 检查钩子保持在入口文件尾。

**涉及**：`public/js/pages/channel.js` → `public/js/pages/channel/`、`channel.html` 引用。

---

## 明确不做（边界）

以下方向经评估**不纳入**，避免后续重复讨论：

- **屏幕共享 / 视频** — 分叉时已明确移除会议功能，偏离「轻量持久语音频道」定位；
- **服务端语音转写/录音** — 媒体不经服务器是本项目的核心承诺，转写/录音若做只能是本地（价值低、复杂度高）；
- **SQLite 等存储引擎替换** — channels.json + 按频道 JSON 的原子写方案在当前规模足够，引入依赖违背无构建/轻依赖取向；
- **服务端机器人/推送消息** — 服务器不产生聊天内容，保持纯信令定位。
