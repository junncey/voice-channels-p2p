import { createRelayUpgrade } from '/js/pages/channel/relay.js';
import { createLinkQuality } from '/js/pages/channel/quality.js';

/*
信令/媒体自愈 —— 频道页的恢复引擎。

  - 恢复阶梯：按对端的 ICE-restart 轮次 → 按链路的 PC 重建 →
    信令重连（B1）
  - 抖动捷径：5 分钟内自愈 ≥4 次断线的链路不再逐轮爬梯 ——
    一次 restart 后直接跳到重建阶（否则边缘 WiFi 会以
    「周期性闪断」的形式永远折腾下去）
  - 僵尸链路：已连接、对端声称在发送、却连续 30s 零 RTP →
    抢先做一次 ICE restart（针对 ICE consent 存活、
    媒体却被 DPI/策略黑洞化的情形）
  - 网络恢复快路径：'online'/回到可见页时一次性扫描所有链路，
    跳过已在阶梯中的链路的宽限，
    并截断 socket 退避的尾巴
  - presence 探测：服务器确认已死的会话从阶梯中除名
  - 「连接中…」徽章：offer 永远无人应答的幽灵成员
  - 让路：对端整条链路重建（来 offer 的 DTLS 指纹换了）时以既有
    PC 应答，自己的重建顺延一个窗口——双方同时重建的相撞里，
    跟着重建会让两端各执一份无人应答的 offer
  - 连接路径监视（P2P 与 TURN relay 徽章 + rtt）
  - 入向链路质量 / 出向丢包适应 / 抖动加深 /
    僵尸+质量重启（引擎拆到 channel/quality.js ——
    同族）
  - relay 升级：直连检查仍可能成功时，对已连接但走 relay 的
    链路重新打洞（引擎拆到 channel/relay.js —— 同族）

coturn 重启会销毁全部 TURN 分配，而信令仍然在线，于是链路
就这样在应用毫无察觉时死掉。恢复按对端进行
（mesh 可能只断了一半）：

  disconnected → 5s 宽限（ICE 常能自愈；过早行动反而坏事）
  failed       → 立即行动
  → 至多 3 轮 ICE-restart（3/6/12s 退避，session id 低的一方
    先手；等待方超过 9s 仍未见对端 re-offer 即破例自行发起——
    单侧 consent 失效时低 uuid 方对断链无感，干等只会空转）
  → 当 mesh 其余部分健康时，仅给该链路一个全新 PeerConnection
    （全新 ICE+DTLS，远端经正常路径应答）→ 信令重连（重建所有
    链路）→ 静默重连 2 次后：显示「重载」提示。
  对端探测为 ghost（宽限内可能 resume）时，restart 轮次与
    升级动作一并让路到宽限之后——ghost 期间任何重协商都投不
    进去，resume 的原地恢复比 B1 核爆便宜一个数量级。
一次 10s 扫描复查所有 connectionState，以防 webview 吞掉
connectionstatechange 事件。

同一阶梯也治愈信令断开后的链路（VPN/加速器切换）：服务器把
会话挂起为幽灵，这一侧保留自己的对端连接，resume 的 addPeer
复用它们，ICE restart 重打新网络路径的洞 —— 无需重协商，
DataChannel 存活。

引擎内所有状态私有；共享页面状态（socket、mesh、selfUuid…）
经 `s` 存取器对象到达，跨模块调用走晚绑定的 `x` 调用面，
两者都归 channel.js 所有。
*/

export function createRecovery({ s, x, members, channelId, $, el, t, timings = {} }) {
    const RECOVERY_GRACE_MS = 5000;
    // 梯子节拍可经 timings 注入（毫秒级单测用）——与下方
    // RECOVERY_B1_RESET_MS 的注入先例同款
    const RECOVERY_ROUND_DELAYS = timings.roundDelays ?? [3000, 6000, 12000];
    const RECOVERY_TOTAL_MS = timings.totalMs ?? 20000; // 信令重连前的按对端窗口（轮次用完后的复查对准窗口终点）
    const RECOVERY_MAX_B1 = 2; // 询问用户之前的自动信令重连次数
    const RECOVERY_SCAN_MS = 10000;
    // 稳定这么久 → B1 预算回满（可经 timings.b1ResetMs 注入，测试用——
    // 与服务端 GHOST_GRACE_MS 的注入先例同款）
    const RECOVERY_B1_RESET_MS = timings.b1ResetMs ?? 60000;
    // 抖动捷径：窗口内自愈这么多次的链路不再信任 restart 轮次
    // （每轮 = 一次可闻的咔哒声），只做一轮立即轮次
    // 就升级到重建阶
    const FLAP_WINDOW_MS = 5 * 60 * 1000;
    const FLAP_HEAL_THRESHOLD = 4;
    const FLAP_ESCALATE_MS = 6000; // 抖动窗口：一轮 + 一次沉淀节拍，然后升级
    // 非对称断链（单侧 consent 失效：只有一方看得到链路断了，
    // 对端的 PC 仍 connected、毫不知情）的破例窗口：高 uuid
    // 等待方让出这么久仍未见对端 re-offer，即自行 restart——
    // 低 uuid 方对断链无感时永远不会发起，无限等待只会把链路
    // 逼进 B1 全 mesh 重建。约等于让出两个先手轮次（3s + 6s）
    const BREAK_TIE_MS = 9000;
    // rejoin（resume）解卡的最小 offer 年龄：对端极短闪断时
    // answer 可能仍在路上，刚发出的 offer 不急于判死
    //（见 retryStuckOffer）
    const REJOIN_RETRY_MIN_AGE_MS = 2000;

    const peerRecovery = new Map(); // peerId -> { timer, attempts, lastState, brokenAt, escalated, flappy }
    // 本成员纪元内连接成功过的对端——同 NAT 判定（mesh.sameNatWith）
    // 只对「从未连上」的链路升级为 relay-only 重建（见
    // specs/same-nat-relay-recovery.md）：曾连上又断线的链路维持既有
    // 梯子行为（直连路径存在过，普通重建仍值得一试）。例外是上次就
    // 靠 relay-only 连上的链路（entry.relayOnly）：它没有过直连路径
    const everConnected = new Set();
    const flapHeals = new Map(); // peerId -> FLAP_WINDOW_MS 内的 [healedAt, ...]
    let recoveryScanTimer = null;
    let b1Attempts = 0; // 自上个稳定期以来的自动信令重连次数
    let b1InFlight = false;
    let b1Timer = null;
    let b1ResetTimer = null;
    let selfReconnecting = false; // 自己的 B1 重连时抑制「已断开」提示

    function notePeerState(peerId, state) {
        const rec = peerRecovery.get(peerId);
        if (rec && rec.lastState === state) return;

        if (state === 'connected' || state === 'closed') {
            if (state === 'connected') {
                everConnected.add(peerId); // relay-only 升级只留给从未连上的链路
                // 一次已自愈的断线（10s 扫描重报健康对端时没有恢复记录
                // —— rec 还在即意味着真实的一次周期）
                if (rec) countFlapHeal(peerId);
            }
            clearConnectingBadge(peerId);
            cancelPeerRecovery(peerId);
            // 🔴 这里绝不能重置 relay 升级预算：10s 恢复扫描会给每个
            // 健康对端重报 'connected'，本分支里一次 cancel 就会在
            // 12s 宽限定时器有机会触发前杀掉它（1.1.5 正是带着这个
            // bug 发布的 —— 升级从未运行）。真正的断线改为经由
            // peerRecovery 清预算；见 noteRelayUpgrade。
            // 横幅收起与预算回填同一语义：都要求「真正的稳定」——
            // 全部链路都不在恢复阶梯上（先取消本对端的记录，再看
            // 余账）。无条件收起时，健康链路每 10s 扫描的重报会把
            // B1 进行中的「恢复中」横幅、乃至预算耗尽后的「请重载」
            // 终态横幅悄悄藏掉；无条件武装时，同一批重报会在坏链路
            // 挂账期间（rec 建立时解除武装后 ≤10s 内）重新武装，
            // 60s 后预算回零——escalated 链路的重试随即第三次核爆
            // 整个房间，永动 B1 循环每 ~80-90s 打断全房间媒体一次
            if (state === 'connected' && peerRecovery.size === 0) {
                hideOutageBanner();
                armB1Reset();
            }
            return;
        }
        if (state !== 'disconnected' && state !== 'failed') return; // new/checking/connecting
        if (!s.mesh?.entries.has(peerId)) {
            cancelPeerRecovery(peerId);
            return;
        }

        if (!rec) {
            clearTimeout(b1ResetTimer); // 不稳定：别回填 B1 预算
            b1ResetTimer = null; // 解除武装——恢复后从那一刻起算完整稳定期
            const flappy = flapCount(peerId) >= FLAP_HEAL_THRESHOLD;
            peerRecovery.set(peerId, {
                timer: null,
                attempts: 0,
                lastState: state,
                brokenAt: Date.now(),
                escalated: false,
                flappy,
            });
            if (flappy) console.warn('[mesh] recovery: flapping link, fast-tracking', peerId);
            scheduleRecoveryTick(peerId, state === 'failed' || flappy ? 0 : RECOVERY_GRACE_MS);
            updatePeerCardRecovery(peerId);
            return;
        }
        rec.lastState = state;
        // 宽限窗口内 disconnected 降级为 failed —— 跳过等待
        if (state === 'failed' && rec.attempts === 0 && rec.timer) scheduleRecoveryTick(peerId, 0);
    }

    function scheduleRecoveryTick(peerId, delay) {
        const rec = peerRecovery.get(peerId);
        if (!rec) return;
        clearTimeout(rec.timer);
        rec.timer = setTimeout(() => recoveryTick(peerId), delay);
    }

    function recoveryTick(peerId) {
        const rec = peerRecovery.get(peerId);
        if (!rec) return;
        rec.timer = null;
        const state = s.mesh?.entries.get(peerId)?.pc.connectionState;
        if (!s.mesh?.entries.has(peerId) || state === 'connected' || state === 'closed') {
            cancelPeerRecovery(peerId);
            return;
        }
        // 已升级到信令重连的链路：escalate 时 B1 可能发不出去
        //（socket 已死/未 join——网络分区、服务器重启），而梯子
        // 一旦 escalated 就再无自驱动。低频重试直到 B1 真正落地
        //（落地即拆全部对端、rec 随 forgetPeer 取消）或链路被
        // 对端治愈（'connected' → 取消）；否则 socket 恢复后
        // 双方的梯子都死着，媒体静默死亡且无任何提示。
        if (rec.escalated) {
            attemptSignalingReconnect();
            if (peerRecovery.get(peerId) === rec) scheduleRecoveryTick(peerId, RECOVERY_SCAN_MS);
            return;
        }
        // 抖动链路用压缩窗口：只做一轮立即轮次抓简单的路由变更，
        // 然后升级 —— 历史表明 restart 只能在下次闪断前
        // 换来几秒钟
        const windowMs = rec.flappy ? FLAP_ESCALATE_MS : RECOVERY_TOTAL_MS;
        if (Date.now() - rec.brokenAt >= windowMs) {
            // 对端探测为 ghost 且宽限未过：resume（原地恢复，复用
            // 既有 PC 与 DataChannel）仍可能落地，而 B1 是主动断开
            // ——对端 ghost 会话被真正移除，resume 通道一并被毁，
            // 全 mesh 还要重协商。ping-timeout 型断链的宽限（30s）
            // 本就长于恢复窗口（20s），没有这道闸，移动端唤醒的
            // resume 还在路上 B1 就先核爆了。快照由每轮的
            // presence 探测刷新；宽限一过（resume 已 connected
            // 或 removePeer 已到）照常升级
            probePeerPresence(peerId); // 让路醒来也探测：对端已 resume 时快照被 'live' 分支作废，免得傻等旧终点后才升级
            const graceLeft = (ghostGraceUntil.get(peerId) || 0) - Date.now();
            if (graceLeft > 0) {
                scheduleRecoveryTick(peerId, Math.min(graceLeft + 500, RECOVERY_SCAN_MS));
                return;
            }
            escalatePeerRecovery(peerId);
            return;
        }
        const roundLimit = rec.flappy ? 1 : RECOVERY_ROUND_DELAYS.length;
        if (state === 'disconnected' || state === 'failed') {
            if (rec.attempts < roundLimit) {
                probePeerPresence(peerId); // 每轮都问：'gone' 能让死会话早一轮落定
                // 对端探测为 ghost（快照来自回执或上一轮探测）：
                // 宽限内服务器会丢弃发往它的一切 SDP（与 escalate
                // 层同一语义，见上方窗口分支）——此刻 restart 只是
                // 把自己卡进 have-local-offer、再靠 8s unstick 爬
                // 出来。不烧轮次，顺延到宽限之后；期间探测继续
                // 刷新快照。轮 1 尚无快照时照发一次：被吞的回执
                // （force 探测）恰好为轮 2 建起快照
                const graceLeft = (ghostGraceUntil.get(peerId) || 0) - Date.now();
                if (graceLeft > 0) {
                    scheduleRecoveryTick(peerId, Math.min(graceLeft + 500, RECOVERY_SCAN_MS));
                    return;
                }
                // glare 仲裁：双方都断时，先让 session id 较低的一方
                // re-offer。但等待不是无限的单——单侧 consent 失效
                // （对端看链路仍 connected、根本不在恢复中）时低 uuid
                // 方永远不会发起：超过 BREAK_TIE_MS 仍未见对端
                // re-offer 就破例自行 restart。iceRestart 在两端都
                // 重跑检查，对端以 stable 状态正常应答；
                // 真的相撞也由完美协商的 glare 路径兜底
                const lowUuidSide = s.selfUuid < peerId;
                const breakTie = !lowUuidSide && Date.now() - rec.brokenAt >= BREAK_TIE_MS;
                if (lowUuidSide || breakTie) {
                    if (breakTie) {
                        console.warn(
                            '[mesh] recovery: peer not re-offering, breaking tie with our own restart',
                            peerId
                        );
                    }
                    rec.attempts += 1; // 只计真实发起的轮次——等待不烧预算
                    s.mesh.restartIce(peerId).then(
                        async (sent) => {
                            if (sent || peerRecovery.get(peerId) !== rec) return;
                            // offer 卡死（对端 ghost 吞掉了我们上一份
                            // offer 的 answer，PC 停在 have-local-offer）：
                            // 回滚陈旧 offer 解卡并立刻重发——这一轮才算数
                            if (await s.mesh.unstickStaleOffer(peerId)) {
                                if (await s.mesh.restartIce(peerId)) return;
                            }
                            // 协商仍在收敛（反向 offer 在途等）：不烧这一轮，
                            // 短延迟再试——与 relay/quality 引擎的 !sent
                            // 语义对齐（此前这里白烧预算，链路被过早
                            // 逼进重建/B1 阶）
                            rec.attempts -= 1;
                            scheduleRecoveryTick(peerId, 2000);
                        },
                        () => {}
                    );
                    scheduleRecoveryTick(peerId, rec.flappy ? 3000 : RECOVERY_ROUND_DELAYS[rec.attempts - 1]);
                } else {
                    console.log('[mesh] recovery: waiting for peer re-offer', peerId);
                    // 等待不烧轮次：等待方的全部价值在 BREAK_TIE 之后。
                    // 节拍对准破例准点——轮次边界（3s/6s）落在 9s 破例
                    // 窗内时，破例本要等到 12s 的下一个边界，整个
                    // 20s 窗口就只剩一次真实 restart 机会
                    const tieIn = BREAK_TIE_MS - (Date.now() - rec.brokenAt);
                    scheduleRecoveryTick(peerId, Math.max(tieIn + 100, 1000));
                }
                return;
            }
            // 轮次用完但窗口未结束：继续观察链路——节拍对准窗口准点。
            // 固定 12s 会把 flappy 的 6s 快车道推迟到 ~15s 才升级
            //（捷径「一轮 + 一次沉淀节拍」的契约被静默击穿），
            // 常规链路也因此在第 3 轮后白等 6s
            scheduleRecoveryTick(
                peerId,
                Math.min(
                    RECOVERY_ROUND_DELAYS[RECOVERY_ROUND_DELAYS.length - 1],
                    windowMs - (Date.now() - rec.brokenAt) + 100
                )
            );
            return;
        }
        // 过渡态（new/checking/connecting）：一次 restart 正在评估 ——
        // 稍后复查，不再烧一轮
        scheduleRecoveryTick(peerId, 3000);
    }

    /** 记录一次已自愈的断线，统计仍在抖动窗口内的自愈次数。 */
    function countFlapHeal(peerId) {
        const now = Date.now();
        const heals = (flapHeals.get(peerId) || []).filter((ts) => now - ts < FLAP_WINDOW_MS);
        heals.push(now);
        flapHeals.set(peerId, heals);
    }

    function flapCount(peerId) {
        const now = Date.now();
        const heals = (flapHeals.get(peerId) || []).filter((ts) => now - ts < FLAP_WINDOW_MS);
        if (heals.length) flapHeals.set(peerId, heals);
        else flapHeals.delete(peerId);
        return heals.length;
    }

    function escalatePeerRecovery(peerId) {
        const rec = peerRecovery.get(peerId);
        if (!rec || rec.escalated) return;
        // B1 大锤之前最后的按链路一阶：健康 mesh 里唯一断掉的链路
        // 拿到全新 PeerConnection（完整 ICE+DTLS 重查）——
        // 若用 B1，mesh 里其他所有链路都要为这一条陪葬。
        // 两条以上链路同时失败则像是全网问题：仍用 B1。
        //
        // 例外——同 NAT 对等（双方 srflx 同公网 IP——同一路由器/
        // CGNAT 下的两台设备）：host 直连被拦、srflx 回环过不了
        // CGNAT，普通全候选矩阵里唯一可行的 relay 配对又在重建
        // 风暴中永远等不到缓慢的收集。这次重建直接换成
        // relay-only PC（只收集 TURN 候选、检查全部从 relay 分配
        // 发出）。事实归 mesh（sameNatWith），这里只做策略；
        // 未配置 TURN 时由 mesh 的降级守卫静默回退普通策略。
        // 适用对象（specs/same-nat-relay-recovery.md）：本纪元从未
        // 连上的链路，以及上次就靠 relay-only 才连上的链路
        // （entry.relayOnly——它没有过直连路径，退回全候选只是
        // 重演连不上的那 20s）
        const relayOnly =
            !!s.mesh?.sameNatWith?.(peerId) && (!everConnected.has(peerId) || !!s.mesh?.entries.get(peerId)?.relayOnly);
        // relay-only 能生效时不受 onlyBrokenLink 约束：同 NAT 是逐对端
        // 的拓扑证据，不是「本端掉线」——第三台同网设备的每条链路都该
        // 各自重建，而不是直落 B1。无 TURN 时它只是伪装的普通重建，
        // 多链路同时失败的既有判定照旧
        if (!rec.rebuilt && ((relayOnly && s.mesh.relayOnlyAvailable()) || onlyBrokenLink(peerId))) {
            rec.rebuilt = true;
            rec.brokenAt = Date.now(); // 给重建的链路一个新的沉淀窗口
            // 全新 PC = 全新 ICE+DTLS，等价初次加入——配齐整副
            // restart 梯子。不重置的话，rebuild 的 offer 再被吞
            // （对端恰好入 ghost）时一轮解卡机会都没有，
            // 只能干等窗口耗尽落 B1
            rec.attempts = 0;
            // 与 restart 轮次不同，这里不设 uuid 仲裁：rebuildPeer
            // 对对端零要求（全新 PC 的 offer 走正常应答路径），
            // 而能走到这一阶的高 uuid 方已在 restart 层等完了
            // 先手窗口与破例轮次——对端仍无动作（单侧 consent
            // 失效时它根本不在恢复中，此前这里要白等 20s 才落到
            // B1）。双方同时耗尽轮次而同时重建时，后到一方由
            // notePeerRebuilt 让路（见下方）
            if (s.mesh?.rebuildPeer(peerId, { relayOnly })) {
                console.warn(
                    '[mesh] recovery: rebuilding the peer connection' + (relayOnly ? ' (relay-only, same NAT)' : ''),
                    peerId
                );
                scheduleRecoveryTick(peerId, 3000);
                return;
            }
            // rebuildPeer 拒绝（条目已不在）—— 落到 B1
        }
        rec.escalated = true;
        console.warn('[mesh] recovery: ICE restarts exhausted, falling back to signaling reconnect', peerId);
        showOutageBanner('recovering');
        attemptSignalingReconnect();
    }

    /** peerId 是唯一处于恢复中的链路 —— 按链路重建可以治愈它；
     *  多条同时失败则指向我们自己的网络。 */
    function onlyBrokenLink(peerId) {
        for (const id of peerRecovery.keys()) if (id !== peerId) return false;
        return true;
    }

    /** 对端刚刚整条链路重建（Mesh 事实：来 offer 的 DTLS 指纹换了，
     *  见 webrtc.js 的 onPeerRebuilt）。我们以既有 PC 应答它——这本身
     *  就是一次全新 ICE+DTLS 的按链路重建，自己的重建因此没有意义：
     *  给这份新协商一个完整的沉淀窗口。不停下的话，升级节拍恰好落在
     *  旧 PC 应答这份 offer 的间隙里时会跟着重建——旧 PC 的 answer 随
     *  close 作废，而新 PC 的 offer 又被 impolite 的对端按完美协商忽略，
     *  两端各执一份无人应答的 offer，直到双双落到 B1
     *  （specs/p2p-recovery-boundaries.md §2）。rebuilt 不置位：这份
     *  协商若仍失败，本端自己的重建仍是下一阶。已 escalated 的梯子
     *  不动——B1 仍是出路，对端重建成功则 connected 照常取消记录。 */
    function notePeerRebuilt(peerId) {
        const rec = peerRecovery.get(peerId);
        if (!rec || rec.escalated) return;
        rec.brokenAt = Date.now();
        rec.attempts = 0;
    }

    // -------------------------------------------------------------------------
    // presence 探测 —— 断连窗口内漏掉的 removePeer 广播（我们的
    // socket 下线久于目标的幽灵宽限）会留下一张任何阶梯都治不好
    // 的成员卡片：每次 offer 都中继进虚空，直到 B1 核爆整个
    // mesh。一次廉价的服务器 ack 即可落定：'gone' = 根本没有
    // 会话 → 立即移除卡片；'ghost'/'live' = 继续治愈
    // （原地恢复仍可能到来）。冷却时间约束抖动链路的探测流量。
    // -------------------------------------------------------------------------

    // 仅按轮去重（探测是对一个 memoized 服务器的廉价 ack）：
    // 每个 restart 轮次可问一次，
    // 抖动链路也无法连珠炮式追问
    const PRESENCE_COOLDOWN_MS = 2000;
    const presenceProbed = new Map(); // peerId -> 上次探测的时间戳
    // peerId -> 最近一次探测得知的 ghost 宽限终点（epoch ms）。
    // escalate 在它之前让路（见 recoveryTick）：宽限内 resume
    // 仍可能落地，而 ghost 期间任何重协商都投不进去
    const ghostGraceUntil = new Map();

    function probePeerPresence(peerId, { force = false, undelivered = false } = {}) {
        if (!s.socket?.connected || !s.joined) return;
        const last = presenceProbed.get(peerId) || 0;
        // 冷却只约束阶梯的常规轮询（探测是对 memoized 服务器的廉价
        // ack，每个轮次可问一次）；force 留给 relayUndelivered 回执
        // ——回执紧跟发出它的那个轮次的探测到达（RTT 级 < 2s），
        // 不绕过冷却就会被整个吞掉，它携带的可是
        // 「上一份 offer 已死」的新证据
        if (!force && Date.now() - last < PRESENCE_COOLDOWN_MS) return;
        presenceProbed.set(peerId, Date.now());
        s.socket.timeout(5000).emit('peerPresence', { room_id: channelId, peer_id: peerId }, (err, res) => {
            if (err || !res || typeof res.present !== 'string') return;
            if (res.present === 'gone') {
                ghostGraceUntil.delete(peerId);
                const name = members.get(peerId)?.peer_name || '';
                x.dropPeer(peerId);
                if (s.joined && name) s.chat?.add({ text: t('chat.left', { name }), system: true });
                console.warn('[mesh] recovery: session gone server-side, member dropped', peerId);
                return;
            }
            // 'ghost'：服务器把 resume 窗口的剩余时间随身携带——
            // 记下来让 escalate 让路。旧服务器不带 graceLeftMs
            //（undefined）则维持原行为：不推迟，窗口一到即升级
            const left = Number(res.graceLeftMs);
            if (res.present === 'ghost' && Number.isFinite(left) && left > 0) {
                ghostGraceUntil.set(peerId, Date.now() + left);
            } else if (res.present === 'live') {
                ghostGraceUntil.delete(peerId);
                // 回执触发的探测返回 live：造成回执的那份 offer 从未
                // 到达对端（服务器已判定不可投递，answer 不可能在途）
                // ——卡在 have-local-offer 的它确定死了，立即解卡
                // 重发（零年龄下限），免 OFFER_STUCK_MS 盲等。常规
                // 探测的 live 不碰 offer：answer 可能真的在路上
                if (undelivered) retryStuckOffer(peerId, 0);
            }
        });
    }

    /** relaySDP 不可投递的服务器回执（见 signaling.js）：目标此刻
     *  吞不进信令——立刻 presence 分流（force 绕过轮询冷却：回执
     *  是「上一份 offer 已死」的新证据，而非又一次例行提问），
     *  'gone' 提前落定（免等阶梯的下一轮探测时机），'ghost' 记下
     *  宽限好让 escalate 让路（见 ghostGraceUntil），'live' 说明
     *  对端恰在服务器判定之后 resume——被吞的 offer 立即解卡重发
     *  （见 probePeerPresence 的 live 分支）。刻意不在这里直接重发
     *  offer：ghost 期间重发只会再次被吞，恢复时机由 resume 的
     *  addPeer(rejoin)（见 retryStuckOffer）或宽限后的下一轮
     *  recoveryTick 决定。 */
    function onRelayUndelivered(peerId) {
        if (!peerId || !s.joined || !s.mesh?.entries.has(peerId)) return;
        probePeerPresence(peerId, { force: true, undelivered: true });
    }

    /** rejoin（resume）时机的解卡：addPeer(rejoin) 证明对端 socket
     *  已活、此刻的信令必能投递——曾被它 ghost 窗口吞掉 answer 的
     *  offer 不必再等 OFFER_STUCK_MS 判死，立即回滚重发。只碰
     *  卡在 have-local-offer 的链路，其余状态原样返回
     *  （'new' 的等待方由对端 resume 后的 offer 照常启动）。
     *  最小年龄 2s 防极短闪断里在途 answer 与重发 offer 交错；
     *  调用方若已证明 answer 不可能在途（relayUndelivered 回执 +
     *  presence 'live'），可传 0 豁免。 */
    function retryStuckOffer(peerId, minAgeMs = REJOIN_RETRY_MIN_AGE_MS) {
        if (!s.mesh?.entries.has(peerId)) return;
        s.mesh
            .unstickStaleOffer(peerId, minAgeMs)
            .then((rolled) => {
                if (rolled) return s.mesh.restartIce(peerId).catch(() => {});
                return null;
            })
            .catch(() => {});
    }

    /** 本地移除全部远端对端与 mesh 条目（用于主动断连之前：
     *  B1 全量重建与 join 错误重置 —— 传输层 'disconnect' 处理器
     *  刻意保留状态，好让原地恢复能治愈它）。 */
    function resetLocalMesh() {
        s.mesh?.clear();
        for (const peerId of [...members.keys()]) {
            if (peerId !== s.selfUuid) x.dropPeer(peerId, { silent: true });
        }
    }

    /** 最后的回退：经全新信令重建整个会话。 */
    function attemptSignalingReconnect({ manual = false } = {}) {
        if (!s.socket || !s.joined) return;
        if (b1InFlight) return;
        if (!manual && b1Attempts >= RECOVERY_MAX_B1) {
            showOutageBanner('failed');
            return;
        }
        b1Attempts += 1;
        b1InFlight = true;
        selfReconnecting = true;
        console.warn('[mesh] recovery: signaling reconnect', { manual, attempt: b1Attempts });
        // B1 是全量重建：先拆 mesh 再断开（服务器把这次主动断连
        // 当成真正的离开，所有人拆除自己的链路）—— 然后以全新
        // 会话重新 join，让 addPeer 风暴
        // 用全新 ICE 重建每条链路
        resetLocalMesh();
        s.socket.disconnect();
        s.socket.connect();
        clearTimeout(b1Timer);
        b1Timer = setTimeout(() => {
            b1InFlight = false;
            selfReconnecting = false;
        }, 15000);
    }

    function armB1Reset() {
        // 🔴 幂等武装：10s 恢复扫描会对每个健康对端重报 'connected'
        // （此时无恢复记录，早退挡不住），无条件重设会让 60s 定时器
        // 永不到期——b1Attempts 永不回零，一次故障耗尽预算后
        // 稳定运行再久也只肯给用户「手动重载」。已武装则不重设：
        // 60s 自最后一次不稳定（rec 创建时取消武装）起算
        if (b1ResetTimer) return;
        b1ResetTimer = setTimeout(() => {
            b1Attempts = 0;
            b1ResetTimer = null;
        }, RECOVERY_B1_RESET_MS);
    }

    /** 一次成功的（重）join 落地：任何未决的自愈重连就此了结；
     *  重连（resume）复用的既有链路若仍断着，此刻信令已恢复、
     *  B1 也发得出了——立刻重扫，别让 escalated 后死掉的梯子
     *  把链路永远晾在断线状态（见 recoveryTick 的 escalated 分支）。 */
    function markSessionRestored() {
        b1InFlight = false;
        selfReconnecting = false;
        clearTimeout(b1Timer);
        rescanLinks();
    }

    function cancelPeerRecovery(peerId) {
        const rec = peerRecovery.get(peerId);
        if (!rec) return;
        clearTimeout(rec.timer);
        peerRecovery.delete(peerId);
        ghostGraceUntil.delete(peerId); // 链路已恢复/移除：宽限快照随之作废
        updatePeerCardRecovery(peerId);
    }

    function clearPeerRecovery() {
        for (const peerId of [...peerRecovery.keys()]) cancelPeerRecovery(peerId);
    }

    function startRecoveryScan() {
        if (recoveryScanTimer) return;
        recoveryScanTimer = setInterval(() => {
            if (!s.joined || !s.mesh) return;
            for (const [peerId, entry] of s.mesh.entries) notePeerState(peerId, entry.pc.connectionState);
        }, RECOVERY_SCAN_MS);
    }

    function stopRecoveryScan() {
        clearInterval(recoveryScanTimer);
        recoveryScanTimer = null;
    }

    // -------------------------------------------------------------------------
    // 网络恢复快路径 —— 'online' 与回到可见页是环境确实发生了
    // 变化的两个时刻。一次性扫描所有链路（被节流的后台标签页
    // 可能错过了状态事件），跳过已在阶梯中的链路的宽限
    // （它们的 ICE 候选对随旧路由一起过期），并在传输层仍未
    // 恢复时截断 socket 退避尾巴（移动端唤醒：被节流的心跳
    // 让服务器把它判死；同 uuid 重新 join 在宽限结束前原地
    // 恢复幽灵）。
    // -------------------------------------------------------------------------

    function onNetworkBack() {
        if (!s.joined || !s.mesh) return;
        if (s.socket && !s.socket.connected) s.socket.connect();
        rescanLinks();
    }

    /** 一次性复查所有链路：错过的状态事件补报（后台标签页
     *  被节流），已在阶梯中的链路立刻走下一跳——包括 escalated
     *  而没能发出 B1 的（socket 恢复由调用方保证，见
     *  markSessionRestored）。 */
    function rescanLinks() {
        if (!s.joined || !s.mesh) return;
        for (const [peerId, entry] of s.mesh.entries) {
            notePeerState(peerId, entry.pc.connectionState);
            if (peerRecovery.has(peerId)) scheduleRecoveryTick(peerId, 0);
        }
    }

    window.addEventListener('online', onNetworkBack);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') onNetworkBack();
    });

    /** 成员卡片：链路损坏时名字/头像变红，恢复启动后显示徽章。 */
    function updatePeerCardRecovery(peerId) {
        const node = $(`#memberList .member[data-id="${peerId}"]`);
        if (node) node.classList.toggle('lost', peerRecovery.has(peerId));
    }

    // -------------------------------------------------------------------------
    // 「连接中…」徽章 —— 幽灵成员（socket 已死，等待服务器心跳
    // 收割）永远不会应答 SDP offer，它的卡片停在 new/connecting
    // 看似正常，而链路永远不会起来。真实链路 2-8s 内落定
    // （relay 的更慢），所以过了宽裕窗口才标记。
    // -------------------------------------------------------------------------

    const CONNECTING_BADGE_MS = 12000;
    const connectingTimers = new Map(); // peerId -> 定时器；存在 = 尚未观察到 'connected'
    const stuckConnecting = new Set(); // 窗口已过而链路仍未起来

    function armConnectingBadge(peerId) {
        if (connectingTimers.has(peerId) || stuckConnecting.has(peerId)) return;
        connectingTimers.set(
            peerId,
            setTimeout(() => {
                connectingTimers.delete(peerId);
                const state = s.mesh?.entries.get(peerId)?.pc.connectionState;
                if (!members.has(peerId) || state === 'connected' || state === 'closed') return;
                stuckConnecting.add(peerId);
                updatePeerCardConnecting(peerId, true);
                // offer 可能根本没有落脚处（我们离线时成员离开了）——
                // 先问服务器再显示那个永远无人应答的徽章
                probePeerPresence(peerId);
            }, CONNECTING_BADGE_MS)
        );
    }

    function clearConnectingBadge(peerId) {
        const timer = connectingTimers.get(peerId);
        if (timer) clearTimeout(timer);
        connectingTimers.delete(peerId);
        if (stuckConnecting.delete(peerId)) updatePeerCardConnecting(peerId, false);
    }

    function updatePeerCardConnecting(peerId, on) {
        const node = $(`#memberList .member[data-id="${peerId}"]`);
        if (node) node.classList.toggle('connecting', on);
    }

    // -------------------------------------------------------------------------
    // 连接路径监视 —— 按对端的徽章，区分 P2P（打洞成功）与
    // TURN relay。每几秒经 mesh.connPath() 从选中的 ICE 候选对
    // 读取：翻转路径的 ICE restart 也会被捕捉到。
    // 仅客户端 —— 在 mesh 里，谁（包括服务器）都
    // 看不到别人的媒体路径，只能看到自己的。
    // -------------------------------------------------------------------------

    const PATH_POLL_MS = 5000;
    const PATH_FIRST_CHECK_MS = 1200; // 刚连接：让选中候选对沉淀，然后立即读取
    const connPaths = new Map(); // peerId -> 来自 mesh.connPath() 的 { type, local, remote, rtt }
    const pathChecks = new Set(); // getStats 往返在途的对端
    const pathEarlyTimers = new Map(); // peerId -> 连接后的一次性检查
    let pathPollTimer = null;
    // relay 重打洞引擎（见 channel/relay.js）—— 读取恢复状态
    // （peerRecovery）、ghost 宽限快照（ghostGraceUntil）与
    // 本监视器的 connPaths 快照，均为注入
    const relayUpgrade = createRelayUpgrade({ s, peerRecovery, connPaths, ghostGraceUntil });
    // 链路质量引擎（见 channel/quality.js）—— 同样的注入
    // （外加 ghost 宽限快照：其质量重启的 poke 与 relay 升级一样
    // 在宽限内让路），由下方 checkPeerPath 喂养；其 lossStreaks
    // 支撑不稳定徽章与 #debug
    const quality = createLinkQuality({ s, members, peerRecovery, connPaths, ghostGraceUntil, $, el, t });

    function startPathMonitor() {
        if (pathPollTimer) return;
        pathPollTimer = setInterval(() => {
            if (!s.joined || !s.mesh) return;
            for (const peerId of s.mesh.entries.keys()) checkPeerPath(peerId);
        }, PATH_POLL_MS);
    }

    function stopPathMonitor() {
        clearInterval(pathPollTimer);
        pathPollTimer = null;
        for (const timer of pathEarlyTimers.values()) clearTimeout(timer);
        pathEarlyTimers.clear();
        connPaths.clear();
        quality.reset();
        relayUpgrade.cancelAll();
    }

    function checkPeerPath(peerId, delay = 0) {
        if (delay) {
            if (pathEarlyTimers.has(peerId)) return;
            pathEarlyTimers.set(
                peerId,
                setTimeout(() => {
                    pathEarlyTimers.delete(peerId);
                    checkPeerPath(peerId);
                }, delay)
            );
            return;
        }
        if (pathChecks.has(peerId)) return;
        if (!s.mesh?.entries.has(peerId)) return;
        pathChecks.add(peerId);
        s.mesh
            .connPath(peerId)
            .then((info) => {
                if (!info || !s.mesh?.entries.has(peerId)) return; // 对端在此期间离开
                connPaths.set(peerId, info);
                quality.note(peerId, info);
                quality.updateBadge(peerId);
                relayUpgrade.note(peerId, info);
            })
            .catch(() => {
                connPaths.delete(peerId);
                quality.updateBadge(peerId); // 别留下过期的「P2P」/relay 徽章
                relayUpgrade.cancel(peerId);
            })
            .finally(() => pathChecks.delete(peerId));
    }

    // -------------------------------------------------------------------------
    // （relay 升级与链路质量引擎在 channel/relay.js 与
    //  channel/quality.js —— 上方以 relayUpgrade/quality 注入；
    //  本文件只保留 checkPeerPath / stopPathMonitor / forgetPeer 的接线）
    // -------------------------------------------------------------------------

    /** 遗忘离场成员的全部按对端记录（各引擎的 map
     *  加本文件自己的）。 */
    function forgetPeer(peerId) {
        cancelPeerRecovery(peerId);
        relayUpgrade.cancel(peerId);
        quality.forget(peerId);
        clearConnectingBadge(peerId);
        everConnected.delete(peerId);
        clearTimeout(pathEarlyTimers.get(peerId));
        pathEarlyTimers.delete(peerId);
        connPaths.delete(peerId);
        presenceProbed.delete(peerId);
        ghostGraceUntil.delete(peerId);
        flapHeals.delete(peerId);
    }

    function showOutageBanner(mode) {
        $('#outageBanner').classList.remove('hidden');
        $('#outageBanner').dataset.mode = mode;
        $('#outageTitle').textContent = t(mode === 'failed' ? 'channel.outageFailedTitle' : 'channel.outageTitle');
        $('#outageHint').textContent = t(mode === 'failed' ? 'channel.outageFailedHint' : 'channel.outageRecovering');
        $('#outageActionBtn').textContent = t(mode === 'failed' ? 'channel.outageReload' : 'channel.outageRejoin');
    }

    function hideOutageBanner() {
        $('#outageBanner').classList.add('hidden');
    }

    /** 拆除用的全量重置：定时器、徽章、B1 预算与断线横幅。 */
    function resetForTeardown() {
        for (const timer of connectingTimers.values()) clearTimeout(timer);
        connectingTimers.clear();
        stuckConnecting.clear();
        everConnected.clear();
        flapHeals.clear();
        ghostGraceUntil.clear();
        hideOutageBanner();
        b1Attempts = 0;
        b1InFlight = false;
        selfReconnecting = false;
        clearTimeout(b1Timer);
        clearTimeout(b1ResetTimer);
        b1ResetTimer = null;
    }

    return {
        notePeerState,
        checkPeerPath,
        armConnectingBadge,
        startRecoveryScan,
        stopRecoveryScan,
        startPathMonitor,
        stopPathMonitor,
        clearPeerRecovery,
        resetLocalMesh,
        attemptSignalingReconnect,
        markSessionRestored,
        onRelayUndelivered,
        retryStuckOffer,
        notePeerRebuilt,
        get selfReconnecting() {
            return selfReconnecting;
        },
        forgetPeer,
        showOutageBanner,
        hideOutageBanner,
        resetForTeardown,
        pathBadgeNode: quality.pathBadgeNode,
        PATH_FIRST_CHECK_MS,
        // 成员渲染器与 #debug 探针读取的 map
        peerRecovery,
        stuckConnecting,
        get lossStreaks() {
            return quality.lossStreaks;
        },
        connPaths,
        debugState: () => ({ connPaths, lossStreaks: quality.lossStreaks, peerRecovery, b1Attempts, b1InFlight }),
    };
}
