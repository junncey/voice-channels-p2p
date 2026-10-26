# 工程质量优化：明确延后的后续任务

> 整理日期：2026-10-26。来源：2026-10-25「工程质量优化」批次（正确性修复 + 去重 + 测试补充 + ESLint/CI 工具链，194 passing）。该批次评审时识别出以下问题，**有意未在本批处理**——它们需要独立设计、基准验证或部署形态确认，不适合搭车混入行为修复。各项「现状」均已对照当时代码核实（含文件与行号）。

与 `roadmap.md` 的关系：本文件聚焦**存量代码的结构/性能债**，roadmap 聚焦功能方向；第 3 项与 roadmap #13（`channel.js` 模块拆分）直接衔接，现已**一并完成**（#13 转 ✅ 全量完成）。roadmap 末尾「明确不做（边界）」中的方向**永远不会做**，本文件各项则是**认可价值、择期再做**（现已**全部完成**）。

## 总览

| #   | 任务                                                   | 类别     | 价值 | 工作量 | 前置条件                   |
| --- | ------------------------------------------------------ | -------- | ---- | ------ | -------------------------- |
| 1   | ✅ chatStore 写路径与 sweep 的阻塞改造（已实施，见下） | 性能     | 高   | 中大   | 设计评审 + 基准验证        |
| 2   | ✅ scryptSync 异步化（已实施，见下）                   | 稳定性   | 中   | 小中   | 无（按 IP 节流已部分缓解） |
| 3   | ✅ 大文件拆分 + 行数预算规则（已实施，见下）           | 可维护性 | 高   | 大     | ~~建议配合一轮功能冻结期~~ |
| 4   | ✅ httpolyglot / colors 依赖替换（已实施，见下）        | 依赖卫生 | 低   | 小     | ~~确认部署形态（#4a）~~     |

---

## 1. chatStore 写路径与 sweep 的事件循环阻塞 —— ✅ 已实施（2026-10-26）

> **实施记录**：采用「事件行重放」方案（原方案思路第一、二、三条的组合落地），全部验收项达成（210 passing，含新增基准 `tests/test-chatstore-perf.js`）。
>
> **最终设计**（`app/src/chatStore.js`）：
>
> - **生命周期操作全部事件化**：`edit`/`remove`/`react` 不再全量重写，改为追加一行 `{"e":"edit|del|react",...}` 事件（带有限 `ts`，兼容 `restore.js` 逐行校验）；加载时按文件序重放（`applyEvent` 与在线变更逻辑互为镜像，上限/墓碑语义一致）。无效或未知事件类型安全跳过（前向兼容），且不再破坏 quarantine 判定（坏行仅在「零消息行」时才隔离，事件行文件必含基线行）。
> - **裁剪也事件化**：保留窗口/`MAX_MESSAGES` 上限的前缀裁剪追加 `{"e":"drop","n":<数量>}` 精确计数标记（不做 ts 假设）；读路径（`history`/`exportAll`）产生的裁剪经 `entry.pendingDrop` 记账并入下一个标记，磁盘重放与内存严格一致、无复活。这同时修复了原「满 300 条后每条发言都全量重写」的常驻慢路径（原文只点名了体积比例，条数上限是同类问题）。
> - **预算 enforcement 拆两级**：越过 90% 比例 → 去抖 ~1s 的合并后台压缩（`scheduleCompact`，burst 期间不阻塞交互）；只有单条追加越过硬预算（12MB）才内联收缩——磁盘上界与旧方案等同。无异步写，天然单写者，无需队列。
> - **sweep 走 stat + 尾部抽样**：`sweepState` 记录 `{size, mtimeMs, retention, minTs(最老保留行 ts)}`，文件未变、窗口未变且未到 `minTs+retention` 边界 → 纯 stat 跳过（空闲频道的周期性大停顿消除）；整文件过期凭尾部 64KB 抽样的最新 ts 直接擦除，免全量解析；仅剩的少数情况才付全量载入。`restore`/外部改动经 mtime/size 变化自动重新检查。
> - **崩溃一致性**：交互路径只剩小行 append（原子性优于旧的全量重写）；重写仅存于压缩/迁移/兜底路径，仍走 tmp+rename（残留 `.tmp` 被忽略），撕裂尾行（含撕裂事件行）容忍跳过、无误隔离。
>
> **基准结果**（`tests/test-chatstore-perf.js`，11.2MB 图片频道）：30 次编辑 + 30 次回应 + 20 条发言全程 **0 次全量重写**、单文件仅追加事件行（结构性断言，无计时抖动）；耗时断言留 75 倍余量（旧方案每次编辑全量序列化+重写约 50–100ms）。sweep 对未变空闲文件第二次起零读取（首次 sight 全量检查一次，之后 stat 跳过；外部改动自动失效）。
>
> **行为差异说明**：预算收缩从「同步即时」变为「最终一致」——越线后最多 ~1s 内文件仍可短暂超预算（硬预算越线仍内联收缩，上界不变）；磁盘保留裁剪对活跃频道同样最终一致（下个标记/压缩/sweep 收敛），与旧方案在 `history()` 只裁内存的既有行为同级。单元用例 `test-chatstore.js` describe 7 覆盖事件行、重放一致性、延迟压缩、sweep 跳过与尾部擦除、撕裂容忍与 `.tmp` 残留、restore 校验兼容。

**原始分析**（2026-10-25 评审，留档）：

**现状**（`app/src/chatStore.js`）：

- 编辑/撤回/回应走 `persistIf()` → `save()`：每次 `chatEdit`/`chatDelete`/`chatReact` 都对整个频道历史做 `serializeLines` 全量序列化 + `writeFileSync` 原子重写。单频道磁盘预算 `MAX_FILE_BYTES` 为 12MB（图片历史为主），即一次编辑最坏可阻塞事件循环数十毫秒。
- 追加快路径要求 `fileSize < maxBytes * COMPACT_AT_RATIO(0.9)`：频道一旦逼近 12MB 预算，**每条新消息**也退化为全量重写，阻塞从「编辑偶发」变为「发言常态」。
- `sweep()` 每 10 分钟（`SWEEP_INTERVAL_MS`）对每个不在内存的频道 `loadFile()` 全量 `readFileSync`（单文件最高 12MB）只为做保留窗口裁剪——空闲频道多时是周期性的大停顿。

**为什么延后**：这是唯一的磁盘数据单写者路径，撕裂写/崩溃一致性都靠现有「append 一行 + 全量重写」语义保证；改写策略牵扯数据完整性，需要独立设计并跑基准，不适合与行为修复混在同一批。

**方案思路**（供设计评审起点，非定案）：

- 编辑/撤回/回应的重写做**合并与延迟**：内存行标记 dirty，短窗口（如 500ms）内的多次生命周期事件合并为一次重写；或改「追加编辑事件行 + 加载时重放」，把重写彻底移出交互路径。
- 逼近预算的常驻慢路径：把压缩改为后台/空闲时段执行，交互路径只追加 + 记账。
- sweep 改 `stat + 尾部抽样`：先 `stat` 判断 mtime/size 决定是否值得读；需要裁剪时优先只读文件尾部若干行取最新 ts 判断窗口，而非全量载入。
- 若引入异步写，必须串行化（单写者队列），避免与 `appendLine` 的 O(1) 追加交错。

**涉及**：`app/src/chatStore.js`（主体）、`tests/test-chatstore.js`、`tests/test-server.js`。

**验收**：全量回归绿；新增基准用例——构造 12MB 频道，断言编辑/发言期间事件循环停顿（如并发期间 `/api/version` 的 p99 响应）在约定阈值内；崩溃注入（重写中途 kill）后重启无撕裂、无 quarantine 误报。

## 2. scryptSync 异步化 —— ✅ 已实施（2026-10-26）

> **实施记录**：按原方案思路落地，全部验收项达成（212 passing，原 210 + 新增 2 条压力用例）。
>
> **最终设计**：
>
> - **哈希层全部异步**：新增 `scryptAsync`（`crypto.scrypt` 的 Promise 封装，跑 libuv 线程池），`hashPassword`/`verifyPassword`/`verifyPasswordCompat` 及类方法 `create`/`update`/`verifyHost`/`verifyChannelPassword` 改为 async；畸形 stored 哈希保留同步快速拒绝路径（不付 scrypt）。N=16384 安全参数未动。
> - **create/update「先哈希、后变更」**：全部密钥哈希经 `Promise.all` 预计算完成后，注册表变更 + 原子写仍是一段同步代码——`await` 不落在校验与保存之间，并发 API 调用无法交错出半写状态。
> - **调用点**（`server.js`）：host 登录与 admin 建频道/更新频道处理器 async 化；socket join 密码校验改为 `await verifyChannelPassword`（join 处理器本就 async）。restore/backup 不经哈希路径，零改动。
> - **可选加固核实**：admin/host 登录端点本就挂 `loginLimiter`（按 IP 的 express-rate-limit），原「复用按 IP 失败计数」已由现状覆盖，无需重复建设。
> - **验收用例**：(a) 结构用例（test-channelStore describe 0）——5ms 定时器**先排程**再触发 16 个并发错误密码校验，断言定时器漂移 <200ms；(b) 集成用例（test-server describe 4）——9 个并发错误密码 join（第 10 次失败会触发按 IP 冷却被静默丢弃，故上限取 9）期间轮询 `/api/version`，断言最坏延迟 <250ms，用例前后各做一次成功 join 复位失败计数、不透支后续用例的 join 预算。两条用例均做过**反向验证**：临时还原同步 scrypt 后结构用例漂移 506ms、集成用例 299ms，双双失败——测试确实守得住该行为。

**原始分析**（2026-10-25 评审，留档）：

**现状**（`app/src/channelStore.js`）：`hashPassword`/`verifyPassword` 用 `crypto.scryptSync`（N=16384，单次约 50–100ms），同步运行在三处热路径：host 登录（`verifyHost`）、admin 建频道的哈希、**socket join 的频道密码校验**（`verifyChannelPassword`）。错误密码的 join 洪水可直接占住事件循环。2026-10-25 批次已把 join 防爆破改为**按 IP 计数**（10 次/60s 冷却，`server.js` `recordJoinFailure`），单一来源的同步 scrypt 次数已被封顶，但分布式来源（多 IP）仍可叠加阻塞。

**为什么延后**：签名从同步改 Promise 牵动 channelStore 全部对外 API 与 45 个既有用例，收益（DoS 面收窄）在按 IP 节流落地后已部分兑现，不急于本批。

**方案思路**：

- 换用 `crypto.scrypt`（回调/Promise 化）封装 `hashPassword`/`verifyPasswordCompat`；调用方（REST 处理器与 join 处理器）本就多为 async，传播成本低；`channelStore` 单测需批量 `await` 化。
- N=16384 是安全参数，不为性能调低。
- 可选加固：登录类端点复用按 IP 失败计数（现在仅 socket join 有），进一步压缩可触发面。

**涉及**：`app/src/channelStore.js`、`app/src/server.js`（调用点）、`tests/test-channelStore.js`。

**验收**：全量回归绿；新增压力用例——并发 N 个错误密码 join 期间，`/api/version` 仍能在阈值内响应（证明校验不再独占事件循环）。

## 3. 大文件拆分 + 行数预算规则 —— ✅ 已实施（2026-10-26）

> **实施记录**：范围在原方案（server.js / channel.js）基础上扩大为**全部超预算源文件**（用户指令），并新增**行数预算规则**防止回弹。全部验收项达成（212 passing、lint 三件套绿、`#debug` 钩子浏览器实测可用）。
>
> **最终形态**：
>
> - **规则（防回弹）**：所有 JS 文件 ≤1000 行（ESLint `max-lines`，`eslint.config.js`，CI 同款 `npm run lint` 强制）；所有 CSS 文件 ≤1000 行（`scripts/check-file-size.js`，并入 `npm run lint`）。超预算必须拆分，CSS 拆分须按段落切、以 `<link>` 顺序保持级联次序。
> - **server.js 2319 → 620 行**，按域拆为 5 个模块：`rooms.js`（房间状态 + 会话/幽灵生命周期 + 房间收发助手，工厂注入 stores）、`chatGateway.js`（chat/chatPage/chatEdit/chatDelete/chatReact 五处理器 + 限流守卫 + 图片批次组装，即原方案首选切口）、`signaling.js`（join/addPeer/relaySDP/relayICE/roomAction/peer* 协议处理器 + join 防爆破）、`adminApi.js`（/api/admin/* + /api/host/* REST + 备份/恢复 + 定时备份，即原方案次选切口）、`payload.js`（sanitizeExceptSecrets/sanitizeChannelPayload/toJson 共享工具）。server.js 只留装配：express/io/TURN/stores/中间件/页面路由/公共 API。
> - **channel.js 3461 → 932 行**，按 roadmap #13 既定方向拆出 8 个 `js/pages/channel/` 子模块：`recovery.js`（恢复阶梯 + path monitor + 丢包徽章 + relay upgrade + 断连横幅，五张 per-peer Map 与清理点收敛为 `forgetPeer`/`resetForTeardown`）、`members.js`（成员列表 UI + 名册同步 + 主持人操作）、`voice.js`（麦克风/PTT/增益管线/远端播放）、`settings.js`（设置弹窗 + 设备 + 外观 + 头像）、`composer.js`（回复/编辑/typing/@补全/发送/图片托盘/搜索）、`notify.js`（未读角标 + 桌面通知）、`hostAuth.js`（主持人登录 + 频道密码持久化）、`socketEvents.js`（socket 事件装配 + 历史分页）。控制器只留共享状态与装配；`#debug` 钩子保持在入口文件尾（快照字段与 debug.js 完全对齐）。
> - **联动拆分**：`chat.js` 1115 → 996 行（emoji 调色板/正则/选择器 → `core/emoji.js`）；`channel.css` 1902 → 883 + 653 + 378 行（`channel.css` / `channel-widgets.css` / `channel-messages.css`，**连续段落切分**保证级联次序与单文件时代完全一致，channel.html 按序引用）。
> - **拆分模式（前端）**：子模块工厂 + 两件共享件——`s`（对控制器可重赋值 `let` 的 get/set 存取器，消除闭包快照失效）与 `x`（晚绑定跨模块调用面，装配完成后统一 `Object.assign` 填充，天然解模块间环）。移动纪律：函数体逐字保留，仅把共享 `let` 改为 `s.*`、跨模块调用改为 `x.*`/`mem.*`/`rec.*` 属性访问；ESLint `no-undef` 兜底抓漏改的裸引用（`x.*`/`s.*` 属性名由人工核对 + 浏览器 smoke 覆盖）。
>
> **回归与核验**：mocha 212 passing（含 test-server 信令集成，拆分零行为差异）；`npm run lint`（eslint max-lines + prettier + CSS 预算）全绿；全部新模块过 `.mjs` 语法检查；:3100 实例浏览器 smoke——页面渲染/自动加入/成员卡、`requestSubmit` 发消息、设置弹窗（4 滑杆/12 开关/设备下拉）、刷新后历史回落（socketEvents + chatStore 端到端）、`__vcDebug()`/`__vcStats()` 探针含 recovery 状态全部实测通过。

**原始分析**（2026-10-25 评审，留档）：

**现状**：`app/src/server.js` 2317 行、`public/js/pages/channel.js` 3461 行，两者约占全部 JS+CSS 的 38%。2026-10-25 批次做了**内部**收敛（`limits.js` 常量单一来源、`roomSender` 公共前导、`makeRateGuard` 限流工厂、`collectBackupEntries` 备份条目、前端 `toast`/`validReply`/`DATA_URL_RE` 去重），但文件量级未变。`channel.js` 的前一轮拆分（roadmap #13）只移出了 wakeLock 与 debug 钩子。

**为什么延后**：纯移动的大 diff 回归面最广（信令 + 音频管线），收益是可维护性而非行为；本轮优先修行为问题，结构重构单独成批更可控。

**方案思路**：

- `server.js` 首选切口：socket 聊天生命周期处理器（`chat`/`chatPage`/`chatEdit`/`chatDelete`/`chatReact` 及批次组装，约 200 行，边界清晰、test-server 覆盖充分）→ 独立模块与 `chatStore` 并列；其次备份/恢复 REST（`collectBackupEntries` 已就绪）。
- `channel.js` 按 roadmap #13 的既定方向继续：信令恢复状态机（recovery ladder / path monitor / relay upgrade 五张 per-peer Map 及其三处清理点）、成员列表 UI、设置面板逐个成 `js/pages/channel/` 子模块，页面控制器只留装配与共享状态。
- 约束：纯移动、无行为变更；前端模块拆分后按 AGENTS 约定复制 `.mjs` 做 `node --check`；`#debug` 钩子保持在入口文件尾。

**涉及**：`app/src/server.js`、`public/js/pages/channel.js` → 新子模块、`tests/test-server.js`（回归）。

**验收**：全量回归绿；拆分前后 `git diff --stat` 证明无逻辑改动（仅移动 + import）；`#debug` 钩子可用性人工核验一次。

## 4. httpolyglot / colors 依赖替换 —— ✅ 已实施（2026-10-26）

> **实施记录**：两项依赖全部移除（运行时依赖 13 → 11），全部验收项达成（214 passing，新增 2 条 ANSI 开关用例；HTTP 与 HTTPS 两种监听下页面与 websocket 升级各人工核验一次）。
>
> **最终设计**：
>
> - **#4a httpolyglot → 按证书存在性选协议**（`server.js`）：部署形态经仓库证据确认为「反代终止 TLS 为主」——`docker-compose.template.yml` 以端口直出 + 注释掉的 Traefik/Let's Encrypt 段为预期生产形态，README 与本 fork 文档均无原生 TLS 工作流。落地取原方案 (a)+(b) 合一：`app/ssl/key.pem` + `cert.pem` 同时存在 → 原生 `https.createServer`（该端口**仅 HTTPS**，不经反代直接暴露的形态）；缺失 → 纯 `http.createServer`（默认/反代形态）。启动日志新增 `tls` 字段明示当前模式，「server started」消息的协议改由实际监听协议得出（替换原先按 host 是否含 localhost 的猜测显示）。上游随仓库分发的**演示自签名证书一并删除**（仓库内提交私钥文件本身就是依赖卫生问题），使「证书存在」成为部署者的主动动作；`app/ssl/README.md` 重写、`docs/self-hosting.md` 新增「TLS 与部署形态」一节（两种形态、Docker 挂载路径 `/src/app/ssl/`、`TRUST_PROXY` 提示、getUserMedia 安全上下文提醒）。同端口 HTTP+HTTPS 双协议能力随依赖退役——文档已标注，需要双协议的场景交给反代。
> - **#4b colors → 裸 ANSI 常量**（`logs.js`）：取零依赖取向。`ansi(code)` 工厂生成 yellow(33)/green(32)/red(31)/magenta(35)/cyan(36) 包装函数，输出与 colors@1.4 **逐字节一致**（同 SGR 开码 + `\x1b[39m` 默认前景关闭码）；`LOGS_COLORS=false` 时包装退化为恒等函数，对应原 `colors.disable()` 语义。`util.inspect` 的对象着色本就走其自带 `colors` 选项（`options.colors: LOGS_COLORS`），与 colors 库无关、行为不变。
> - **核验**：:3100 HTTP 实例——页面 200、`/api/version` 正常、socket.io 经 websocket 传输握手成功、`tls: off`；:3101 HTTPS 实例（临时自签证书）——TLS 页面 200、websocket over TLS 握手成功、裸 HTTP 打 TLS 端口被拒（HTTPS-only 语义正确）、`tls: native`。核验后临时证书与辅助脚本均已删除。新增 `tests/test-logs.js` 第二个 describe：断言 `LOGS_COLORS=false` 时输出零 ANSI 转义、`true` 时出现与 colors@1.4 一致的 `\x1b[33m…\x1b[39m` 等着色序列（沿用既有「钉住 env 后重 require」模式）。

**原始分析**（2026-10-25 评审，留档）：

**现状**：两个事实上无上游维护的运行时依赖——`httpolyglot@0.1.2`（约 2017 年起无更新，仅 `server.js` 一处：同端口 HTTP+HTTPS 自适应）与 `colors@1.4.x`（仅 `app/src/logs.js` 一处：日志着色）。

**为什么延后**：纯依赖卫生、无现实缺陷；替换 httpolyglot 牵涉**部署形态**（是否真有人依赖「同端口双协议」——反代后部署并不需要），需先确认使用场景再动。

**方案思路**：

- **#4a httpolyglot**：确认部署形态后三选一——(a) 全部反代后部署 → 直接 `http.createServer(app)`；(b) 需要原生 HTTPS → `https.createServer`（证书缺失时报错退出并给明确指引）；(c) 确有双协议需求 → 保留并在 README 标注「冻结依赖」。现行为参考：`ssl/key.pem`/`cert.pem` 缺失时启动直接抛错。
- **#4b colors**：`logs.js` 是唯一使用方，替换为裸 ANSI 常量（零依赖取向）或 chalk；保留 `LOGS_COLORS` 开关语义与现有输出格式。

**涉及**：`app/src/server.js`、`app/src/logs.js`、`package.json`、（若 #4a 选 (b)）`docs/self-hosting.md`。

**验收**：全量回归绿（`tests/test-logs.js` 覆盖 JSON 日志路径）；#4a 需在 HTTP 与 HTTPS 两种监听下各人工核验一次页面与 websocket 升级。
