# 同 NAT 对等的 relay-only 恢复

## 问题

同一公网出口后的两台设备（同一路由器 / 同一 CGNAT）互相通话时，三类候选通常都走不通：

| 候选  | 为什么不行                                                                       |
| :---- | :------------------------------------------------------------------------------- |
| host  | 各自内网地址，跨 NAT 不可达（同 LAN 时例外）                                     |
| srflx | 公网 IP 相同、端口不同 → 需要 NAT 回环（hairpin），家用路由器与 CGNAT 多数不支持 |
| relay | **唯一可行**：两端都经 TURN 分配端口                                             |

而恢复梯子在「从未连上」时做的是普通全候选重建：每个新 PC 都要等一轮 STUN 收集，重建风暴下 relay 配对永远等不到候选齐备。表现为「同网两台设备怎么都连不上」，且日志里只看到反复重建。

## 判定（事实层，归 `Mesh`）

- `candidateSrflxIp(candidate)`：从 SDP candidate 串解析 srflx 的地址；非 srflx（host / relay / prflx / mDNS）或畸形串返回 `null`。纯函数，为测试导出。
- `Mesh.localSrflxIps`：本端 srflx 公网 IP 集合，随 `onicecandidate` 累积。
- `Mesh.remoteSrflxIps: Map<peerId, Set>`：对端 srflx 集合。**在 `remoteDescription` 落座前就记录** —— 恢复梯子最需要该判定的时刻，链路恰恰还没协商完。
- 生命周期对齐 `sdpSeqs`：跨 `clear()` / `rebuildPeer` 存活（重建后对端候选会重新 trickle，知识自动刷新），仅 `close()` 清空。
- `Mesh.sameNatWith(peerId)`：两侧集合均非空且有交集 → `true`；任一侧 srflx 尚未收集到（无 STUN / DNS 失败）→ `false`，行为与未启用该判定时完全一致。

## 策略（归恢复梯子 `public/js/pages/channel/recovery.js`）

```
relayOnly = 本成员纪元内从未 connected  ∧  mesh.sameNatWith(peerId)
```

- **只对「从未连上」的链路升级**：曾连上又断线的链路说明直连路径存在过，普通重建仍值得一试。
- **例外：经 relay-only 才连上的链路保持 relay-only**。它的「曾连上」并不代表直连路径存在过——退回全候选策略只会重演当初连不上的那 20s，然后落到 B1。当前条目的 `entry.relayOnly` 即为证据。
- **不受 `onlyBrokenLink` 约束**。梯子的「多条链路同时失败 = 本端网络问题 → 直接 B1」是通用启发式；同 NAT 是逐对端的拓扑证据，与几条链路断开无关。第三台同网设备入房时它的每条链路都到不了彼此，修复前全部跳过按链路重建直落 B1——而 B1 之后一切照旧，直到预算耗尽。
- **仅当 relay-only 能真正生效时才破例**：未配置 TURN（`Mesh.relayOnlyAvailable()` 为假）时 relay-only 会经降级守卫退化成普通重建，多条链路断开的既有判定原样保留（仍走 B1）。
- 无 TURN 配置时由 `hasTurnServer()` 守卫**静默回退普通策略** —— 强制 `iceTransportPolicy: 'relay'` 而没有 TURN 会收集不到任何候选，连接必死。
- 触发点在梯子耗尽普通轮次后的 `rebuildPeer` 一步，日志：`[mesh] recovery: rebuilding the peer connection (relay-only, same NAT) <peerId>`。

## 接口

| 位置                                                                 | 变更                                                                                                                   |
| :------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `Mesh.addPeer(peerId, shouldCreateOffer, iceServers, { relayOnly })` | 生效时 PC 以 `iceTransportPolicy: 'relay'` 创建                                                                        |
| `Mesh.rebuildPeer(peerId, { relayOnly })`                            | 透传给 `addPeer`，自适应状态（`jitterTarget` / `bitrateFloor`）照旧搬运                                                |
| `entry.relayOnly`                                                    | 记录**实际生效**标志（有 TURN 且请求了 relay-only），供其它模块读取                                                    |
| `Mesh.relayOnlyAvailable()`                                          | 当前 iceServers 里是否配有 TURN——策略层判断「relay-only 能否生效」的事实入口                                           |
| `relay.js` 的 `note()`                                               | 跳过 `relayOnly` 链路：其 PC 没有 host/srflx 候选，重新打洞在定义上不可能产出直连，只会换来两次徒劳 restart 的音频闪断 |

## 验收场景（`tests/test-same-nat.js`、`test-recovery.js`、`test-relay.js`）

1. `candidateSrflxIp` 取出 srflx 地址；host / relay / prflx / mDNS / 畸形串 → `null`。
2. Mesh 记录本端 srflx；对端 srflx 在 `remoteDescription` 之前也可读。
3. `sameNatWith` 要求两侧非空且有交集；`clear()` 后对端知识仍在（页面内 B1 重连）。
4. `rebuildPeer({relayOnly})` 在有 TURN 时落到 `iceTransportPolicy: 'relay'`；无 TURN 回退普通策略；不带选项时行为不变。
5. 恢复梯子：同 NAT 且从未连上 → 请求 relay-only 重建；曾连上 → 普通重建；跨网对端 → 不请求。
6. relay 升级引擎对 relay-only 链路从不武装。
7. 另有链路同在梯子上（`onlyBrokenLink` 为假）时，同 NAT 链路仍请求 relay-only 重建、不落 B1；无 TURN 时保持 B1。
8. 曾连上且当前条目为 relay-only 的链路，后续重建仍请求 relay-only。

线上判据：同网两台设备入房后，成员卡链路徽章显示「中转」，console 出现上述 relay-only 日志，且该链路**不再**出现 `relay upgrade: ice restart sent`。

## 已知取舍

- 同 LAN 的两台设备本可 host 直连。升级为 relay-only 后强制走 TURN，媒体双向约 220 kbit/s（≈100 MB/小时）由服务器承担 —— 「能连上」优先于「省流量」。
- `sameNatWith` 只认 srflx：无 STUN 或 DNS 失败时永不判定同 NAT，退化为旧行为（不误伤，但也不修复）。
- 判定基于公网 IP 相同，多出口/双线网络下可能漏判（各自的 srflx 落在不同 IP）。
