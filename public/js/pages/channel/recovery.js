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
    发起，双方绝不同时 re-offer）→ 当 mesh 其余部分健康时，
    仅给该链路一个全新 PeerConnection（全新 ICE+DTLS，远端经
    正常路径应答）→ 信令重连（重建所有链路）→ 静默重连 2 次
    后：显示「重载」提示。
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

export function createRecovery({ s, x, members, channelId, $, el, t }) {
    const RECOVERY_GRACE_MS = 5000;
    const RECOVERY_ROUND_DELAYS = [3000, 6000, 12000];
    const RECOVERY_TOTAL_MS = 20000; // 信令重连前的按对端窗口（第3轮 +12s = 21s）
    const RECOVERY_MAX_B1 = 2; // 询问用户之前的自动信令重连次数
    const RECOVERY_SCAN_MS = 10000;
    const RECOVERY_B1_RESET_MS = 60000; // 稳定这么久 → B1 预算回满
    // 抖动捷径：窗口内自愈这么多次的链路不再信任 restart 轮次
    // （每轮 = 一次可闻的咔哒声），只做一轮立即轮次
    // 就升级到重建阶
    const FLAP_WINDOW_MS = 5 * 60 * 1000;
    const FLAP_HEAL_THRESHOLD = 4;
    const FLAP_ESCALATE_MS = 6000; // 抖动窗口：一轮 + 一次沉淀节拍，然后升级

    const peerRecovery = new Map(); // peerId -> { timer, attempts, lastState, brokenAt, escalated, flappy }
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
                hideOutageBanner();
                armB1Reset();
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
            return;
        }
        if (state !== 'disconnected' && state !== 'failed') return; // new/checking/connecting
        if (!s.mesh?.entries.has(peerId)) {
            cancelPeerRecovery(peerId);
            return;
        }

        if (!rec) {
            clearTimeout(b1ResetTimer); // 不稳定：别回填 B1 预算
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
        // 抖动链路用压缩窗口：只做一轮立即轮次抓简单的路由变更，
        // 然后升级 —— 历史表明 restart 只能在下次闪断前
        // 换来几秒钟
        const windowMs = rec.flappy ? FLAP_ESCALATE_MS : RECOVERY_TOTAL_MS;
        if (Date.now() - rec.brokenAt >= windowMs) {
            escalatePeerRecovery(peerId);
            return;
        }
        const roundLimit = rec.flappy ? 1 : RECOVERY_ROUND_DELAYS.length;
        if (state === 'disconnected' || state === 'failed') {
            if (rec.attempts < roundLimit) {
                rec.attempts += 1;
                probePeerPresence(peerId); // 每轮都问：'gone' 能让死会话早一轮落定
                // glare 仲裁：双方都断时，只有 session id 较低的
                // 一方 re-offer；另一方只应答
                if (s.selfUuid < peerId) {
                    s.mesh.restartIce(peerId).catch(() => {});
                } else {
                    console.log('[mesh] recovery: waiting for peer re-offer', peerId);
                }
                scheduleRecoveryTick(peerId, rec.flappy ? 3000 : RECOVERY_ROUND_DELAYS[rec.attempts - 1]);
                return;
            }
            // 轮次用完但窗口未结束：继续观察链路
            scheduleRecoveryTick(peerId, RECOVERY_ROUND_DELAYS[RECOVERY_ROUND_DELAYS.length - 1]);
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
        if (!rec.rebuilt && onlyBrokenLink(peerId)) {
            rec.rebuilt = true;
            rec.brokenAt = Date.now(); // 给重建的链路一个新的沉淀窗口
            // 与 restart 轮次相同的仲裁：session id 较低的一方重建
            if (s.selfUuid < peerId) {
                if (s.mesh?.rebuildPeer(peerId)) {
                    console.warn('[mesh] recovery: rebuilding the peer connection', peerId);
                    scheduleRecoveryTick(peerId, 3000);
                    return;
                }
            } else {
                console.log('[mesh] recovery: waiting for peer to rebuild its link', peerId);
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

    function probePeerPresence(peerId) {
        if (!s.socket?.connected || !s.joined) return;
        const last = presenceProbed.get(peerId) || 0;
        if (Date.now() - last < PRESENCE_COOLDOWN_MS) return;
        presenceProbed.set(peerId, Date.now());
        s.socket.timeout(5000).emit('peerPresence', { room_id: channelId, peer_id: peerId }, (err, res) => {
            if (err || res?.present !== 'gone') return; // live/ghost/无应答：阶梯继续尝试
            const name = members.get(peerId)?.peer_name || '';
            x.dropPeer(peerId);
            if (s.joined && name) s.chat?.add({ text: t('chat.left', { name }), system: true });
            console.warn('[mesh] recovery: session gone server-side, member dropped', peerId);
        });
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
        clearTimeout(b1ResetTimer);
        b1ResetTimer = setTimeout(() => (b1Attempts = 0), RECOVERY_B1_RESET_MS);
    }

    /** 一次成功的（重）join 落地：任何未决的自愈重连就此了结。 */
    function markSessionRestored() {
        b1InFlight = false;
        selfReconnecting = false;
        clearTimeout(b1Timer);
    }

    function cancelPeerRecovery(peerId) {
        const rec = peerRecovery.get(peerId);
        if (!rec) return;
        clearTimeout(rec.timer);
        peerRecovery.delete(peerId);
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
    // （peerRecovery）与本监视器的 connPaths 快照，均为注入
    const relayUpgrade = createRelayUpgrade({ s, peerRecovery, connPaths });
    // 链路质量引擎（见 channel/quality.js）—— 同样的注入，
    // 由下方 checkPeerPath 喂养；其 lossStreaks 支撑不稳定徽章与 #debug
    const quality = createLinkQuality({ s, members, peerRecovery, connPaths, $, el, t });

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
        clearTimeout(pathEarlyTimers.get(peerId));
        pathEarlyTimers.delete(peerId);
        connPaths.delete(peerId);
        presenceProbed.delete(peerId);
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
        flapHeals.clear();
        hideOutageBanner();
        b1Attempts = 0;
        b1InFlight = false;
        selfReconnecting = false;
        clearTimeout(b1Timer);
        clearTimeout(b1ResetTimer);
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
