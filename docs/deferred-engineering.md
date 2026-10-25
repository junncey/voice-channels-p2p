# 工程质量优化：明确延后的后续任务

> 整理日期：2026-10-26。来源：2026-10-25「工程质量优化」批次（正确性修复 + 去重 + 测试补充 + ESLint/CI 工具链，194 passing）。该批次评审时识别出以下问题，**有意未在本批处理**——它们需要独立设计、基准验证或部署形态确认，不适合搭车混入行为修复。各项「现状」均已对照当时代码核实（含文件与行号）。

与 `roadmap.md` 的关系：本文件聚焦**存量代码的结构/性能债**，roadmap 聚焦功能方向；第 3 项与 roadmap #13（`channel.js` 模块拆分，部分完成）直接衔接。roadmap 末尾「明确不做（边界）」中的方向**永远不会做**，本文件各项则是**认可价值、择期再做**。

## 总览

| #   | 任务                                | 类别     | 价值 | 工作量 | 前置条件                   |
| --- | ----------------------------------- | -------- | ---- | ------ | -------------------------- |
| 1   | chatStore 写路径与 sweep 的阻塞改造 | 性能     | 高   | 中大   | 设计评审 + 基准验证        |
| 2   | scryptSync 异步化                   | 稳定性   | 中   | 小中   | 无（按 IP 节流已部分缓解） |
| 3   | server.js / channel.js 大文件拆分   | 可维护性 | 中   | 大     | 建议配合一轮功能冻结期     |
| 4   | httpolyglot / colors 依赖替换       | 依赖卫生 | 低   | 小     | 确认部署形态（#4a）        |

---

## 1. chatStore 写路径与 sweep 的事件循环阻塞

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

## 2. scryptSync 异步化

**现状**（`app/src/channelStore.js`）：`hashPassword`/`verifyPassword` 用 `crypto.scryptSync`（N=16384，单次约 50–100ms），同步运行在三处热路径：host 登录（`verifyHost`）、admin 建频道的哈希、**socket join 的频道密码校验**（`verifyChannelPassword`）。错误密码的 join 洪水可直接占住事件循环。2026-10-25 批次已把 join 防爆破改为**按 IP 计数**（10 次/60s 冷却，`server.js` `recordJoinFailure`），单一来源的同步 scrypt 次数已被封顶，但分布式来源（多 IP）仍可叠加阻塞。

**为什么延后**：签名从同步改 Promise 牵动 channelStore 全部对外 API 与 45 个既有用例，收益（DoS 面收窄）在按 IP 节流落地后已部分兑现，不急于本批。

**方案思路**：

- 换用 `crypto.scrypt`（回调/Promise 化）封装 `hashPassword`/`verifyPasswordCompat`；调用方（REST 处理器与 join 处理器）本就多为 async，传播成本低；`channelStore` 单测需批量 `await` 化。
- N=16384 是安全参数，不为性能调低。
- 可选加固：登录类端点复用按 IP 失败计数（现在仅 socket join 有），进一步压缩可触发面。

**涉及**：`app/src/channelStore.js`、`app/src/server.js`（调用点）、`tests/test-channelStore.js`。

**验收**：全量回归绿；新增压力用例——并发 N 个错误密码 join 期间，`/api/version` 仍能在阈值内响应（证明校验不再独占事件循环）。

## 3. server.js / channel.js 大文件拆分

**现状**：`app/src/server.js` 2317 行、`public/js/pages/channel.js` 3461 行，两者约占全部 JS+CSS 的 38%。2026-10-25 批次做了**内部**收敛（`limits.js` 常量单一来源、`roomSender` 公共前导、`makeRateGuard` 限流工厂、`collectBackupEntries` 备份条目、前端 `toast`/`validReply`/`DATA_URL_RE` 去重），但文件量级未变。`channel.js` 的前一轮拆分（roadmap #13）只移出了 wakeLock 与 debug 钩子。

**为什么延后**：纯移动的大 diff 回归面最广（信令 + 音频管线），收益是可维护性而非行为；本轮优先修行为问题，结构重构单独成批更可控。

**方案思路**：

- `server.js` 首选切口：socket 聊天生命周期处理器（`chat`/`chatPage`/`chatEdit`/`chatDelete`/`chatReact` 及批次组装，约 200 行，边界清晰、test-server 覆盖充分）→ 独立模块与 `chatStore` 并列；其次备份/恢复 REST（`collectBackupEntries` 已就绪）。
- `channel.js` 按 roadmap #13 的既定方向继续：信令恢复状态机（recovery ladder / path monitor / relay upgrade 五张 per-peer Map 及其三处清理点）、成员列表 UI、设置面板逐个成 `js/pages/channel/` 子模块，页面控制器只留装配与共享状态。
- 约束：纯移动、无行为变更；前端模块拆分后按 AGENTS 约定复制 `.mjs` 做 `node --check`；`#debug` 钩子保持在入口文件尾。

**涉及**：`app/src/server.js`、`public/js/pages/channel.js` → 新子模块、`tests/test-server.js`（回归）。

**验收**：全量回归绿；拆分前后 `git diff --stat` 证明无逻辑改动（仅移动 + import）；`#debug` 钩子可用性人工核验一次。

## 4. httpolyglot / colors 依赖替换

**现状**：两个事实上无上游维护的运行时依赖——`httpolyglot@0.1.2`（约 2017 年起无更新，仅 `server.js` 一处：同端口 HTTP+HTTPS 自适应）与 `colors@1.4.x`（仅 `app/src/logs.js` 一处：日志着色）。

**为什么延后**：纯依赖卫生、无现实缺陷；替换 httpolyglot 牵涉**部署形态**（是否真有人依赖「同端口双协议」——反代后部署并不需要），需先确认使用场景再动。

**方案思路**：

- **#4a httpolyglot**：确认部署形态后三选一——(a) 全部反代后部署 → 直接 `http.createServer(app)`；(b) 需要原生 HTTPS → `https.createServer`（证书缺失时报错退出并给明确指引）；(c) 确有双协议需求 → 保留并在 README 标注「冻结依赖」。现行为参考：`ssl/key.pem`/`cert.pem` 缺失时启动直接抛错。
- **#4b colors**：`logs.js` 是唯一使用方，替换为裸 ANSI 常量（零依赖取向）或 chalk；保留 `LOGS_COLORS` 开关语义与现有输出格式。

**涉及**：`app/src/server.js`、`app/src/logs.js`、`package.json`、（若 #4a 选 (b)）`docs/self-hosting.md`。

**验收**：全量回归绿（`tests/test-logs.js` 覆盖 JSON 日志路径）；#4a 需在 HTTP 与 HTTPS 两种监听下各人工核验一次页面与 websocket 升级。
