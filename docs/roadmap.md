# 优化与新功能方向（Roadmap）

> 整理日期：2026-10-24（最后同步 2026-10-26：第二轮评估 1–13 全部完成、新增 14–23；15、17–20 已按拆分后代码复核现状并细化方案，22 已完成）。各项「现状」在整理时均已核实当时代码中**不存在**对应实现；已完成项的「现状」段落保留原始核实记录，实现摘录附于标题上方。
>
> 存量代码的结构/性能债（chatStore 写路径阻塞、scryptSync 异步化、大文件拆分、依赖替换）另见 `deferred-engineering.md`——那些是认可价值、择期再做，与本文件末尾「明确不做（边界）」不同。

## 总览

| #   | 方向                             | 类别     | 价值 | 工作量 | 状态                  |
| --- | -------------------------------- | -------- | ---- | ------ | --------------------- |
| 1   | Opus 编码调优 + 音乐模式         | 语音质量 | 高   | 小     | ✅ 2026-10-24         |
| 2   | 成员卡片丢包率/抖动              | 语音质量 | 中   | 小     | ✅ 2026-10-24         |
| 3   | 移动端 Wake Lock                 | 语音质量 | 高   | 小     | ✅ 2026-10-24         |
| 4   | 表情回应（reactions）            | 聊天体验 | 高   | 中     | ✅ 2026-10-25         |
| 5   | @提及 + 回复引用 + 未读通知      | 聊天体验 | 高   | 中     | ✅ 2026-10-25         |
| 6   | 消息撤回                         | 聊天体验 | 中   | 中     | ✅ 2026-10-25         |
| 7   | 缺省头像（昵称哈希生成）         | 聊天体验 | 中   | 小     | ✅ 2026-09-29         |
| 8   | admin 实时成员名单               | 运维管理 | 高   | 中     | ✅ 2026-10-25         |
| 9   | TURN 临时凭证（HMAC）            | 运维管理 | 高   | 中     | ✅ 2026-10-25         |
| 10  | 一键备份 / 聊天记录导出          | 运维管理 | 中   | 小     | ✅ 2026-10-25         |
| 11  | 每频道聊天保留时长               | 运维管理 | 中   | 小     | ✅ 2026-10-25         |
| 12  | 信令层集成测试                   | 工程质量 | 高   | 中     | ✅ 2026-10-25         |
| 13  | `channel.js` 模块拆分            | 工程质量 | 中   | 中     | ✅ 2026-10-26（全量） |
| 14  | 「一起听」分享系统声音           | 语音功能 | 高   | 中     | ✅ 2026-10-25         |
| 15  | 触屏消息操作条（缺陷修复）       | 移动端   | 高   | 小     | —                     |
| 16  | 服务端全量消息搜索               | 聊天体验 | 高   | 中     | —                     |
| 17  | 频道置顶/公告消息                | 聊天体验 | 中   | 小     | —                     |
| 18  | 成员进出系统消息（可开关）       | 聊天体验 | 中   | 小     | —                     |
| 19  | @全体成员（仅主持人）            | 聊天体验 | 中   | 小     | —                     |
| 20  | 主持人清空频道聊天记录           | 运维管理 | 中   | 小     | —                     |
| 21  | Web Push 离线 @ 通知             | 通知     | 高   | 大     | —                     |
| 22  | PWA Service Worker               | 工程质量 | 中   | 中     | ✅ 2026-10-26         |
| 23  | 小打磨（帮助面板/DOM 上限/a11y） | 工程质量 | 低   | 小     | —                     |

第一轮（1–13）已全部完成。第二轮（14–23，2026-10-25 评估）建议推进顺序：**15**（移动端真实缺陷、工作量最小）→ **21**（对「持久化频道」价值最大，其前置 22 已完成）→ **16**；14、22 已完成，17–20、23 按实际使用场景排期。

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

### 14. 「一起听」分享系统声音 ✅ 2026-10-25 已完成

**实现**：新增 `public/js/pages/channel/share.js`（getDisplayMedia 编排：`selfBrowserSurface:'exclude'` 防回声循环、视频轨到手即丢、音轨 `ended` 自动收尾、无音轨时引导重选）+ `AudioHub.attachShare/detachShare`（混入麦克风管线的 MediaStreamAudioDestination，同一条音频 m-line、零重协商，`attachMic` 重建管线时自动重挂）。分享期间麦克风静音改为门控**原始采集轨**（混音发送轨保持常开，音乐不断，PTT 同理）；Opus 发送上限自动抬至 ≥192kbps + stereo（stereo 随下一轮 SDP 生效；刻意不动麦克风降噪/AEC 开关——外放时 AEC 正好压住泄漏）。`peerStatus` 新增 `share` 元素（服务端白名单 + `getRoomPeers` 下发 `peer_share`），成员卡音符徽章 + 语音工具栏按钮（on 态高亮、teardown/离场自动停止并广播）。回归：tests/test-server.js 新增「share 状态中继 + 后加入者可见 + 未知元素不中继」用例。限制（已在 UI 文案说明）：Safari/Firefox 无显示音频捕获；桌面软件声音只能整屏分享，单独分享仅限浏览器标签页。

**现状**：全库无任何 `getDisplayMedia` 引用；看视频/听歌连麦只能靠麦克风外放拾音，音质差且依赖环境安静。

**方案**：

- 成员区/设置入口发起 `getDisplayMedia({ video: true, audio: true })`，**只取 audio 轨**（video 轨拿到后立即 stop，不恢复视频能力），经 AudioContext 与麦克风混音或单独替换发送轨。
- 自动套用音乐模式参数（立体声、192kbps，可手调），共享期间成员卡片挂「正在分享声音」标记，结束即恢复原链路。
- 兼容性：Chrome/Edge（Windows/macOS/Linux PipeWire）支持；Safari/Firefox 不支持显示音频捕获，入口静默降级并提示。
- 回声风险：若共享内容包含远端成员的声音会形成回环，UI 提示戴耳机。
- 权限：与麦克风权限同一套交互；_DisplayMedia 权限策略需确认服务端 `Permissions-Policy` 不阻拦。

**涉及**：`public/js/core/webrtc.js`、`public/js/core/audio.js`、`public/js/pages/channel.js`、`public/css/channel.css`、词典。

---

## 二、聊天体验

### 4. 表情回应（reactions）✅ 2026-10-25 已完成

**实现**：hover 操作条表情按钮弹出面板；回应以胶囊形式挂在气泡下方，全员实时同步（服务器广播 `chatReact`，仅文字成员也收到）并随行持久化（emoji→昵称数组，≤8 emoji/50 人，按 ts+name 定位）；点击胶囊再次切换。超出原方案：原定「不入服务器历史、仅在线可见」，最终落地为服务端 single writer 持久化（chatStore 行结构 `reactions` 字段）。

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

### 6. 消息撤回 ✅ 2026-10-25 已完成

**实现**：本人随时可撤（未设限时）、主持人可撤任何人的；服务器广播 `chatDelete`（含仅文字成员），chatStore 行变墓碑（保留 ts 稳分页游标），全员渲染「撤回了一条消息」墓碑占位、不重排。配套的消息编辑（`chatEdit`，仅本人、标注「已编辑」）同批落地。

**现状**：消息一经发送不可撤回（P2P 直发 + 服务端历史副本均无删除路径）。

**方案**：

- 普通成员限时自撤（如 2 分钟），主持人不限时——权限模型与现有「静音/移出/重命名」一致，走 host JWT 校验。
- DataChannel 广播 `recall` 事件（按 ts 定位），服务端在 `chatStore` 同步删除该条；历史分页游标按 ts，删除后需确认游标边界行为（同 ts 消息组不切开的原则不变）。
- 撤回后气泡原地变为「xx 撤回了一条消息」占位，不重排。

**涉及**：`app/src/chatStore.js`（+回归测试）、`app/src/server.js`、`public/js/core/chat.js`、词典。

### 7. 缺省头像（昵称哈希生成）✅ 2026-09-29 已完成

**实现**：`utils.js avatarColor(name)` 按昵称哈希均匀取色，`chat.js avatarNode` 无自定义头像时渲染「首字母 + 色块」确定性头像（同一昵称全员渲染一致）；收到对方自定义头像后仍优先自定义并重渲染其历史行（`setAvatar`）。

**现状**：自定义头像仅存上传者本浏览器、实时同步给在线成员；新加入的成员回看历史时，从未「见过」发送者的头像位置是空的（`chat.js` 的 `avatarFor(name)` 只查本浏览器存储）。

**方案**：

- 无自定义头像时按昵称哈希生成确定性「首字母 + 色块」头像（同一昵称在所有人设备上渲染一致，HSL 均匀取色）。
- 在线收到对方自定义头像后仍优先用自定义的；本地记忆也按昵称存。

**涉及**：`public/js/core/chat.js`（或 utils 新增生成器）、`public/css/channel.css`。

### 15. 触屏消息操作条（缺陷修复）

**现状**（2026-10-26 复核，CSS 拆分后原引用行号已迁移）：回复/表情/编辑/撤回操作条由 `.msg:hover .msg-actions, .msg:focus-within .msg-actions` 显示（`channel-messages.css` 约 105 行）；`:focus-within` 在触屏救不了场——操作条按钮本身 `display:none` 不可聚焦，多数消息行内没有可聚焦元素（唯一例外：带回应胶囊的行点胶囊会经焦点偶然唤出，非设计路径）。`@media (pointer: coarse)` 块（同文件约 326 行）只覆盖成员卡（`.member.open` 手风琴，`members.js` 点按切换、同列表互斥收起）。触屏上这四个消息操作基本不可用。

**方案**：

- 仿成员卡 open 模式：`pointer: coarse` 下常驻一个「⋯」小按钮，点按展开/收起操作条（整行点按会与引用块点击跳转、回应胶囊点击冲突，常驻小按钮更稳）；操作条由 `chat.js rowActionsNode()` 生成，展开逻辑在 buildMessage 一侧挂。
- 展开态互斥（同时只开一条）+ 点空白收起，照抄成员卡既有行为。
- 可选长按唤出（`pointerdown` 计时 + 移动阈值取消以区分滚动手势；`contextmenu` 在 Android 长按可用、iOS 需 preventDefault）。
- 桌面 hover 路径不变：CSS 经 `@media (pointer: coarse)` 隔离，或 JS `matchMedia('(pointer: coarse)')` 分支绑定。

**涉及**：`public/css/channel-messages.css`、`public/js/core/chat.js`（操作条与事件绑定）、词典（如需提示文案）。

### 16. 服务端全量消息搜索

**现状**：聊天面板顶部的搜索框只过滤**已加载**的消息（README 口径：上翻加载多少搜多少）；`server.js` 无任何搜索端点，而 JSONL 全量历史就在服务端。

**方案**：

- 新增 socket 事件 `chatSearch`（ack 回包，仅本频道成员），`chatStore` 从最新行倒序扫描、匹配 `text`（跳过墓碑行），返回命中摘要 + ts 游标。
- 节流复用 `chatPage` 的每 socket 30 次/10s 模式；结果条数与字节预算设上限。
- 客户端：命中已加载消息直接滚动定位（复用回复引用的定位+闪烁）；未加载的先经 `chatPage` 回拉到该 ts 再定位。

**涉及**：`app/src/chatStore.js`（+回归测试）、`app/src/server.js`、`public/js/pages/channel.js`、`public/js/core/chat.js`、词典。

### 17. 频道置顶/公告消息

**现状**（2026-10-26 复核）：channelStore/chatStore 仍无 pin/公告概念（全库无对应字段）。

**方案**：

- `channelStore` 频道字段加 `pinnedChat: { ts, name, text }`，接入照抄 `chatRetentionHours` 的全套模式（validateDefinition 校验、sanitize 透出、admin 编辑器）。设置/取消走 host REST `POST /api/host/:channelId/pin`（body 为消息定位 `{ts,name}` 或 null 清除；host JWT + verifyHost 资格复核，同 export 端点模式，`adminApi.js`）。
- 下发：join 时随 `serverInfo` 顺带当前 pin（`signaling.js`，侵入最小）；变更后经 rooms 的频道 socket 表向房间广播 `chatPin` 实时同步（adminApi 已注入 rooms）。
- 客户端聊天面板顶部常驻可点击置顶条：消息已加载则滚动定位（复用回复引用的定位+闪烁），未加载先经 `chatPage` 回拉到该 ts 再定位。
- 失效联动：撤回命中所置顶行时同步清空并广播（`chatGateway` 的 chatDelete 处理器已注入 channelStore，顺带判定即可）；保留期裁剪把置顶行裁掉后 pin 悬空——点击回拉到头仍未命中则提示「原消息已删除」并自动解绑。

**涉及**：`app/src/channelStore.js`（+回归测试）、`app/src/adminApi.js`、`app/src/signaling.js`、`app/src/chatGateway.js`（撤回联动）、`public/js/pages/channel.js`/`socketEvents.js`、`public/js/core/chat.js`、`public/css/channel-messages.css`、词典。

### 18. 成员进出系统消息（可开关）

**现状**（2026-10-26 复核）：进出仍只有音效与审计留痕（`audit.js` 的 join/leave/ghost 过期/踢人行）；拆分后广播点在 `signaling.js`（join 成功、主动 leave）与 `rooms.js`（`broadcastRemovePeer` 是 ghost 过期与踢出的统一出口）。服务器是历史存储 single writer，但系统行应刻意**不入 chat_history**（临时性信息，新进成员回看不重放——不持久化即天然满足）。

**方案**：

- 与 removePeer 广播同点 emit `chatSystem` `{ kind, name }`：join（`signaling.js`，chatHistory 下发之后）、主动 leave/kick、ghost 宽限过期（`rooms.js`）。
- 关键坑：**挂点必须在「真正移除」的判定处**——ghost 宽限期内同 uuid resume 本就不广播 removePeer，挂对了 resume 天然不发「离开」；挂到断线事件上则会误发。
- 客户端 `socketEvents.js` 监听 → `chat.js` 新增居中灰色小字系统行（纯本地渲染，不进消息数据结构、不占分页游标）。
- 频道页设置开关（默认关，防高频频道刷屏），localStorage 新键（记得同步 AGENTS.md 键清单）。

**涉及**：`app/src/signaling.js`、`app/src/rooms.js`、`public/js/pages/channel/socketEvents.js`、`public/js/core/chat.js`、`public/js/pages/channel/settings.js`、词典。

### 19. @全体成员（仅主持人）

**现状**（2026-10-26 复核）：提及高亮按在线成员名单（`chat.js mentionSegments` + 控制器注入的 `mentionNames`），@补全菜单在 `channel/composer.js`；`channel/notify.js` 按文本匹配自身昵称触发桌面通知/title 计数。无「全体」概念（词典亦无对应文案）。

**方案**：

- 主持人输入 @ 时补全列表追加「全体成员」项（主持人身份前端自知：成员状态含 `peer_presenter`），渲染为区别于普通 mention 的高亮样式。
- 防滥用的正确门控在**接收端**：实时消息走 DataChannel P2P，服务器碰不到实时文本——接收端按发送者的 `peer_presenter`（getRoomPeers 已随 serverInfo/addPeer 下发，按昵称在成员表反查，与提及高亮同套解析）门控渲染，非主持人发的 @全体按普通文本显示。服务端只在**存储路径**同步校验（chat 事件的发送者是否在 `presenters` 表，同 chatDelete 的判定方式），保证历史回放渲染一致，并供第 21 项 Web Push 的服务端 @ 检测复用。
- 命中 @全体 时对全员触发桌面通知/提示音（`notify.js` 的 mentionsMe 扩展全体分支）。

**涉及**：`public/js/pages/channel/composer.js`（补全）、`public/js/core/chat.js`（渲染门控）、`public/js/pages/channel/notify.js`、`app/src/chatGateway.js`（存储校验）、词典。

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

### 20. 主持人清空本频道聊天记录

**现状**（2026-10-26 复核）：只能整频道删除（admin）或逐条撤回；chatStore 全量重写已收敛到唯一入口 `save()`（tmp+rename，单文件 bind-mount 走内容拷贝），`reload()` 清内存缓存与 sweepState，restore 全量替换是现成先例——缺的只是面向单频道的清空方法与入口。

**方案**：

- `chatStore.clear(id)`：清空行列表后过 `save()` 全量重写 + `reload()`；回归测试覆盖持久/临时房间、清空后再 append、与备份/恢复的先后交互。
- REST：`POST /api/host/:channelId/clear-chat`（`adminApi.js`，host JWT + verifyHost 资格复核，同 export 模式）。
- 广播 `chatClear`（adminApi 已注入 rooms 的频道 socket 表，直接向房间 emit）：在线成员清空消息视图与本地分页游标，显示「主持人清空了聊天记录」提示行（可与 18 的系统行渲染复用）。
- 审计留痕（谁/何时/哪个频道，`audit.record`）；前端入口在频道页主持人区（「导出聊天」旁，`#exportChatBtn` 同款按主持人显隐），二次确认。

**涉及**：`app/src/chatStore.js`（+回归测试）、`app/src/adminApi.js`、`public/js/pages/channel.js`/`socketEvents.js`、词典。

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

### 13. `channel.js` 模块拆分 ✅ 2026-10-26 全量完成

**实现**：新建 public/js/pages/channel/ 子目录，wake lock（createWakeLock，含 visibilitychange 自管理）与 #debug 检查钩子（installDebugHooks + 活快照 getter）各成独立 ES Module；channel.js 从 3140 行降至约 2970 行。

**全量完成（2026-10-26）**：channel.js 3461 → 932 行，信令恢复状态机（recovery.js）、成员列表（members.js）、语音控制（voice.js）、设置面板（settings.js）、聊天输入区（composer.js）、通知（notify.js）、主持人登录（hostAuth.js）、socket 事件装配（socketEvents.js）全部成子模块；控制器只留共享状态（经 `s` 存取器暴露）与装配（跨模块调用经晚绑定 `x` 面）。详见 `docs/deferred-engineering.md` 第 3 项实施记录（含 server.js 同批拆分与 ≤1000 行预算规则）。

**现状**：`public/js/pages/channel.js` 已达约 2700 行，信令恢复、UI 渲染、音频管线、聊天逻辑、调试钩子全部在一个文件里，每次加功能都在加剧。

**方案**：

- 按「信令/恢复状态机」「成员列表 UI」「聊天面板 UI」「音频设置面板」拆为 `js/pages/channel/` 下的多个 ES Module，页面控制器只留装配与共享状态。
- 纯移动、无行为变更；`node --check` 需复制为 `.mjs` 的语法检查流程不变；`#debug` 检查钩子保持在入口文件尾。

**涉及**：`public/js/pages/channel.js` → `public/js/pages/channel/`、`channel.html` 引用。

### 23. 小打磨合集

- **快捷键帮助面板**：`?` 呼出浮层列出 Ctrl/Cmd+M 静音、按住 V 说话等，目前这些快捷键没有任何可发现性。
- **聊天列表 DOM 上限**：长会话 + 历史回拉后消息节点与 data-URL 图片持续累积，可考虑超出视口若干屏后回收/懒渲染（真遇到卡顿再做不迟）。
- **无障碍**：新消息 `aria-live` 播报、操作条按钮补 `aria-label`。

**涉及**：`public/js/pages/channel.js`、`public/js/core/chat.js`、`public/css/channel.css`、词典。

---

## 五、通知与离线

### 21. Web Push 离线 @ 通知

**现状**：桌面通知（Notification API）只在页面开着时生效，人不在时被 @ 收不到任何提醒——对「持久化频道」产品这是最能提升粘性的缺口（Discord 类产品的核心闭环）。

**方案**：

- VAPID 密钥对经 env 配置；新增 `public/sw.js` 处理 `push` 与通知点击（直达 `/c/<id>`）。
- 服务端存推送订阅（REST 注册/注销，按频道+昵称关联）；`chat` 事件落库时检测 @命中（含未来的 @全体）对**不在线**的被提及者推送（payload 按 Web Push 规范加密）。
- 退订/失效订阅自动清理；频率限制防轰炸。
- iOS 16.4+ 需先安装 PWA 才能收推送，与现有 PWA 支持衔接。
- 依赖第 22 项（service worker）。边界说明：服务器只**中继**提及通知，不产生聊天内容，不属于「明确不做」中的服务端推送消息。

**涉及**：`app/src/server.js`、新增 `public/sw.js`、`public/js/pages/channel.js`、`app/src/config.js`、`.env.template`（web-push 依赖或手写 VAPID+aes128gcm，倾向后者以维持零依赖取向，需评估工作量）。

### 22. PWA Service Worker ✅ 2026-10-26 已完成

**实现**：新增 `public/sw.js`（纯运行时缓存、零预缓存清单）：导航 **network-first**，成功时同时缓存在「路由 URL + shell 资产路径」双键下，离线回退 `/c/<id>`→`/channel.html`、`/admin`→`/admin.html`、其余→`/index.html`；`/images/**` cache-first；其余同源 GET stale-while-revalidate；`/api/**`、`/socket.io/**`、非 GET、跨域一律直通。版本更新横幅的 `reloadNow`（version.js）重载前先经 MessageChannel 发 `vc-purge-static` 让 SW 清空静态缓存（400ms 超时兜底），消除 SWR 固有的「要二次重载才拿到新代码」问题。注册在 `theme-boot.js`（全部页面共用，window load 后、失败静默）。离线提示条：新增 `channel/offline.js`（`navigator.onLine` 翻转即挂/摘，复用 `.update-bar` 布局 + `.offline-bar` 危险色变体），词典键 `channel.offline`（zh/en）。CSP `script-src 'self'` 天然覆盖同源 SW 注册，helmet 无需改动。

**现状**：PWA 只有 `manifest.webmanifest` + 图标（`public/` 下无 sw.js、无任何 `serviceWorker` 注册），装到主屏幕后无离线外壳、二次打开无缓存加速。

**方案**：

- 最小 service worker：HTML **network-first**（保住版本更新横幅依赖的 no-cache 语义）；`public/images/**` cache-first（本来就是 7 天 immutable）；其余 js/css stale-while-revalidate 并尊重 must-revalidate。
- 离线时频道页给「已离线」提示条。
- 是第 21 项的前置；注册逻辑放 `theme-boot.js` 或页面入口，注意版本更新刷新流程不被缓存干扰。

**涉及**：新增 `public/sw.js`、`public/index.html`/`channel.html`（注册）、词典（离线提示）。

---

## 明确不做（边界）

以下方向经评估**不纳入**，避免后续重复讨论：

- **屏幕共享 / 视频** — 分叉时已明确移除会议功能，偏离「轻量持久语音频道」定位；
- **服务端语音转写/录音** — 媒体不经服务器是本项目的核心承诺，转写/录音若做只能是本地（价值低、复杂度高）；
- **SQLite 等存储引擎替换** — channels.json + 按频道 JSON 的原子写方案在当前规模足够，引入依赖违背无构建/轻依赖取向；
- **服务端机器人/推送消息** — 服务器不产生聊天内容，保持纯信令定位（第 21 项 Web Push 仅中继 @ 提及通知、不产生内容，不在此边界内）。
