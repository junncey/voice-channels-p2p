# 打洞恢复的边界：会话纪元 / 同时重建 / 未落座探测

三处曾被遗漏的边界，共同点是「信令层的一次会话边界没有传导到打洞层」。
恢复阶梯的其余语义不变（见 `public/js/pages/channel/recovery.js` 头注）。

## 1. addPeer 的会话纪元：复用只对 resume 成立

### 问题

`Mesh.addPeer` 对已知 peerId 空操作——这是 resume（原地恢复）的基石：
幽灵宽限内同一 uuid 重新 join 时，双方早已持有对端连接，带
`rejoin:true` 的 `addPeer` 只是一个同步事件。同一个空操作却也吞掉了
**非恢复**的 `addPeer`（`rejoin:false`）命中既有条目的情形。

服务器只在 `resumeOrReap` 判定为 resume 时才给 `rejoin:true`。其余
一切 join 之前，旧会话要么已不存在、要么已被收割并广播 removePeer——
对端手里通向那个旧条目的 PC 必然已被拆除。能走到「非恢复 + 命中
既有条目」的只有两类：

| 场景                                                   | 何时发生                                                                                    |
| :----------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| 本端离线超过幽灵宽限后重新 join                        | 旧会话已过期移除；对端收到 removePeer 后为「新成员」建了全新 PC（应答方），在等我们的 offer |
| 本端离线期间对端重新 join（我们错过了它的 removePeer） | 对端同上，本地条目同样是遗物                                                                |

复用遗物的后果按其状态分两档：

| 遗物状态                                       | 后果                                                                                                                                                                                                                                                |
| :--------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed` / `disconnected`                      | 梯子接管、重发 restart offer——能好，但白绕一轮解卡                                                                                                                                                                                                  |
| `new` + `have-local-offer`（offer 发出后断线） | **永久卡死**：断线期间缓冲的 offer 在重连时先于 join 冲刷、被服务器丢弃（见第 3 节）；PC 停在过渡态，而梯子对过渡态不动作，`retryStuckOffer` 又只在 rejoin 时调用。应答侧同理：本端是 impolite（较低 uuid）时会按完美协商**忽略**对端新 PC 的 offer |

### 规则

```
addPeer 命中既有条目 ∧ rejoin !== true  →  条目属于已终结的会话纪元  →  换新
```

- 换新 = `rec.forgetPeer` + `mesh.removePeer`，随后按服务器指定的角色走
  全新 addPeer 路径：`should_create_offer` 原样生效（加入方立刻发初始
  offer，既有成员成为没有待决 offer 的干净应答方），代次账本延续。
- 换新的链路重新武装「连接中…」徽章。
- `rejoin:true` 的行为不变（复用条目 + `retryStuckOffer`）。

### 接口

| 位置                                  | 变更           |
| :------------------------------------ | :------------- |
| `socketEvents.js` 的 `addPeer` 处理器 | 陈旧判定与换新 |

### 验收场景（`tests/test-p2p-recovery.js` — addPeer on a stale entry）

1. 非恢复 addPeer 命中 `have-local-offer` 的条目：旧 PC 关闭、新 PC 立刻发 offer（代次 +1）、旧恢复记录清账、徽章重新武装。
2. 应答侧（`should_create_offer:false`）同样换新，且不多发 offer。
3. `rejoin:true` 仍复用条目并解卡。
4. 全新对端走原路径，无清账。

## 2. 对端重建检测与「双方同时重建」相撞

### 问题

`rebuildPeer` 曾称双方同时重建的相撞「由完美协商兜底，代价只是一方白建
一个 PC」。完美协商只保证**一份** offer 胜出，不保证它有人应答。对称
故障下两端 `failed` 几乎同时、窗口同为 20s，双方梯子到达重建阶的时刻
常常只差亚秒。后到一方 B 的升级节拍若落在它**旧 PC 正在应答先到一方 A
的重建 offer** 的间隙里（`setRemoteDescription` 已落、`createAnswer` /
`setLocalDescription` 未返回）：

```
A 重建 → offer(A') ──▶ B 旧 PC：sRD ✓ … createAnswer …
                              │
                       B 的节拍：rebuildPeer → 旧 PC close()
                              │
B 旧 PC 的 setLocalDescription 抛 InvalidStateError → answer 从未发出
B 新 PC 的 offer(B') ──▶ A'：have-local-offer 且 A 是 impolite → 忽略
```

A' 永远停在 `have-local-offer`，B' 也是——两端各执一份无人应答的
offer，梯子对 `new` 过渡态只会每 3s 复查，直到窗口耗尽双双落到 B1。

### 判定（事实层，归 `Mesh`）

- `sdpFingerprint(sdp)`：取 SDP 的 `a=fingerprint` 值（大写归一），
  读不出返回 `null`。纯函数，为测试导出。
- 一份 **offer** 落座后，其指纹与本 PC 此前已协商的远端指纹不同 ⇒
  对端换了全新的 PeerConnection（全新证书）。ICE restart 只换
  ice-ufrag、指纹不变，两者由此区分。任一侧读不出指纹、本 PC 尚无
  远端描述、或来的是 answer ⇒ 无结论。
- `handlers.onPeerRebuilt(peerId)`：上述事实成立时，在
  `setRemoteDescription` 成功之后、应答之前通知。

### 策略（归恢复梯子）

`notePeerRebuilt(peerId)`：存在恢复记录且未 escalated 时，
`brokenAt = now`、`attempts = 0`——给这份新协商一个完整的沉淀窗口。

- 既有 PC 应答对端的重建 offer，本身就是一次「全新 ICE + DTLS」的
  按链路重建，自己的重建因此没有意义。
- `rec.rebuilt` 不置位：这份协商若仍失败，本端自己的重建仍是下一阶。
- 已 escalated 的梯子不动（B1 仍是出路）；对端的重建若成功，
  `connected` 照常取消记录。
- 两侧对称：无论谁先重建，后到一方都让路。

### 接口

| 位置                           | 变更                                                                         |
| :----------------------------- | :--------------------------------------------------------------------------- |
| `webrtc.js`                    | 导出 `sdpFingerprint`；`_applySessionDescription` 检测并通知 `onPeerRebuilt` |
| `recovery.js`                  | 导出 `notePeerRebuilt`                                                       |
| `channel.js` 的 `meshHandlers` | 接线 `onPeerRebuilt → rec.notePeerRebuilt`                                   |

### 验收场景（`tests/test-p2p-recovery.js`）

1. `sdpFingerprint` 解析（大小写、CRLF/LF、缺失）。
2. 指纹不同 → 通知；ICE restart（同指纹）→ 不通知；本 PC 的首份 offer、无指纹 → 不通知；answer → 不通知。
3. 梯子：`notePeerRebuilt` 重置窗口与轮次；escalated 记录不动；无记录无动作。
4. **双 Mesh + 双梯子仿真**：A 先重建，B 在应答间隙走到升级点——B 不重建，旧 PC 的 answer 送达 A 的新 PC，无人落 B1。

### 取舍

- 死锁窗口只有毫秒级，但一旦触发代价是双方 B1；让路的成本只是 B 的
  重建晚一个窗口（多数情况下根本不需要）。
- 指纹比对依赖对端不改写 SDP 指纹（本应用两端都是本代码，无 munge）。

## 3. 未落座发送者的信令语义

### 问题

socket.io-client 在传输重连时的顺序是 `onconnect → emitBuffered()`
（冲刷断线期间缓冲的全部 emit），**先于** `connect` 事件——客户端在
`connect` 处理器里才发 `join`。断线期间恢复梯子发出的 `relaySDP`
因此会以「未加入任何频道的 socket」的身份到达服务器。

| 事件           | 修复前                     | 后果                                             |
| :------------- | :------------------------- | :----------------------------------------------- |
| `relaySDP`     | 回 `relayUndelivered`      | 客户端立刻 presence 探测                         |
| `peerPresence` | `sharedRoom` 为空 → `gone` | 恢复引擎的 gone 分支 = `dropPeer` + 播「已离开」 |

`join` 无密码时只跨微任务，探测包到达前早已落座；**有频道密码时**
join 要等线程池 scrypt（约 50–100ms），探测包落在同一间隙——`gone`
是必然而非竞态（`test-server.js` 可确定性复现）。梯子自身的探测节拍与
「连接中…」徽章的探测同样能落进去。

### 规则

| 事件                        | 发送者状态     | 行为                                                                                                         |
| :-------------------------- | :------------- | :----------------------------------------------------------------------------------------------------------- |
| `relaySDP`                  | 未加入任何频道 | 静默丢弃，不回执——回执语义是「合法载荷投不进对端」，这里投不出去的原因在发送者自己                           |
| `peerPresence` 带 `room_id` | 未在该频道落座 | 回 `{ present: 'unknown', graceLeftMs: 0 }`；客户端的 gone / ghost / live 三个分支都不命中，旧客户端同样安全 |
| 其余                        | —              | 不变：已落座成员探测陌生会话仍是 `gone`                                                                      |

### 验收场景（`tests/test-server.js`）

1. 未 join 的 socket 发合法 `relaySDP`：无回执。
2. 频道密码 join 在途时的探测 → `unknown`；落座后同一探测 → `live`。
3. 已落座成员探测陌生会话 → `gone`。

### 取舍

- 不缓冲重投：被丢弃的那份 offer 由既有的 resume 路径解卡
  （`rejoin:true` → `retryStuckOffer`），或由第 1 节的换新路径重发。
- `relaySDP` 载荷没有 `room_id`，只能按「零频道」判定；多频道 socket
  （`socketMaxChannels > 1`）第二个频道 join 在途时回执仍会发出，但
  随后的探测得到 `unknown`，无害。
