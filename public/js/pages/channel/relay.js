/*
Relay 升级 —— 恢复家族中一个自成一体的引擎（1000 行预算时
从 recovery.js 拆出；所需状态经注入的引用仍归引擎自有）。

ICE 提名的第一对可用候选可能就是 TURN relay——当直连检查
还在半路时（DNS 冷启动、NAT 绑定慢、coturn 鉴权往返）；
WebRTC 在已连接的链路上绝不会再跑检查，于是「已连接但走
relay」的路径会永远停在 relay。引擎由恢复路径轮询喂养：
链路在 relay 上停留超过宽限窗口后，用 iceRestart 重新打洞
（聊天 DataChannel 保留）。Glare 仲裁与恢复阶梯一致 ——
只有 session-id 较低的一方发起，且 restart 会在两端都重跑
检查，所以对端不需要自己的看门狗。尝试次数有上限：
当直连根本不可能（对称 NAT、UDP 被封）时，再 restart 只是
无意义的折腾，还会让声音一闪一闪。

🔴 这份预算必须扛得住应用对「健康链路」的一切上报：
10s 恢复扫描会对每个对端重发 'connected'，一次 restart 也会让
路径短暂读作 'unknown'。任一信号都取消记录的话，等于在它本该
约束的那次尝试内部重置 `since`/`attempts`——
1.1.5 就是这样变成永不触发的（宽限 12s > 扫描 10s）。
只有这些能清除它：路径为 p2p、链路损坏（peerRecovery）、
或我们已离开。对端离开的情形走 peerRecovery/forgetPeer →
cancel()。
*/

export function createRelayUpgrade({ s, peerRecovery, connPaths, ghostGraceUntil, timings = {} }) {
    const RELAY_UPGRADE_GRACE_MS = timings.graceMs ?? 12000; // 连接后 relay 持续这么久 → 尝试重新打洞
    const RELAY_UPGRADE_RETRY_MS = timings.retryMs ?? 10000; // restart 之后先让新检查沉淀再下判断
    const RELAY_UPGRADE_MAX_ATTEMPTS = 2;
    const RELAY_UPGRADE_TOTAL_MS = 45000; // 硬窗口，同时约束 restartIce 的推迟
    // peerId -> { timer, attempts, since, done, busy }
    //   done = 尝试次数耗尽，墓碑标记让轮询停止重新武装
    //   busy = 我方的 re-offer 正在途，不再叠加第二个
    const relayUpgrades = new Map();

    function note(peerId, info) {
        if (!info || peerRecovery.has(peerId) || !s.selfUuid || s.selfUuid >= peerId) {
            // 链路已不在，或这一侧无权发起重新打洞
            cancel(peerId);
            return;
        }
        if (info.type === 'p2p') {
            // 直连 —— 升级已成功（或本就无需）：下次从干净状态开始
            cancel(peerId);
            return;
        }
        // 'unknown' 是过渡态：我方的 restart 正在重查，或候选上报
        // 还读不出来。保留预算 —— 在这里取消等于在它本该约束的
        // 那次 restart 内部重置尝试计数。
        if (info.state !== 'connected' || info.type !== 'relay') return;

        let rec = relayUpgrades.get(peerId);
        if (!rec) {
            rec = { timer: null, attempts: 0, since: Date.now(), done: false, busy: false };
            relayUpgrades.set(peerId, rec);
        }
        if (rec.done || rec.timer || rec.busy) return; // 已耗尽 / 已武装 / offer 在途
        const due = Math.max(RELAY_UPGRADE_GRACE_MS - (Date.now() - rec.since), 0);
        rec.timer = setTimeout(() => relayUpgradeTick(peerId), due);
    }

    function relayUpgradeTick(peerId) {
        const rec = relayUpgrades.get(peerId);
        if (!rec) return;
        rec.timer = null;
        if (rec.busy) {
            // 上一个 offer 还没落定 —— 等它，然后再判一次
            scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
            return;
        }
        // 对端已走、链路损坏、或轮不到我方发起：没什么可判的了。
        if (!s.mesh?.entries.has(peerId) || peerRecovery.has(peerId) || !s.selfUuid || s.selfUuid >= peerId) {
            cancel(peerId);
            return;
        }
        // 对端 ghost 宽限内（恢复引擎 presence 探测的快照）：服务器会
        // 丢弃发往它的一切 SDP——此刻 restart 的 offer 只会被吞，
        // 而「已发出」照样烧掉一次尝试额度，两次烧完的 done 墓碑
        // 会挡死这条链路之后的 relay 升级（直到下一次链路事件）。
        // 顺延到宽限之后；期间恢复梯子的探测继续刷新快照
        const graceLeft = (ghostGraceUntil?.get(peerId) || 0) - Date.now();
        if (graceLeft > 0) {
            scheduleRelayUpgradeRetry(peerId, Math.min(graceLeft + 500, RELAY_UPGRADE_RETRY_MS));
            return;
        }
        // connPaths 只由 5s 路径轮询写入，所以这份快照描述的可能
        // 还是刚结束的那次 restart（state 'connecting'、type
        // 'unknown'）。只有确证的 'p2p' 才终结本轮 —— 把「暂无
        // 结论」当成「无需升级」会丢掉记录、给链路重新发 2 次
        // 尝试额度，慢沉淀的 restart 就这样变成无休止的重协商
        // 循环。unknown 改为等待下一轮轮询。
        const info = connPaths.get(peerId);
        if (info?.type === 'p2p') {
            cancel(peerId);
            return;
        }
        const relayed = info?.state === 'connected' && info.type === 'relay';
        if (rec.attempts >= RELAY_UPGRADE_MAX_ATTEMPTS || Date.now() - rec.since >= RELAY_UPGRADE_TOTAL_MS) {
            if (relayed) console.warn('[mesh] relay upgrade: giving up, link stays on TURN', peerId);
            // 墓碑：留在 map 里，轮询就不会再武装新一轮
            rec.done = true;
            return;
        }
        if (!relayed) {
            // 暂无结论（restart 还在沉淀 / 候选读不出）：再看一轮
            scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
            return;
        }
        rec.busy = true;
        // PC 处于协商中或已关闭时，restartIce 以 false resolve（绝不
        // reject）；catch 分支只是防将来签名变化。
        s.mesh.restartIce(peerId).then(
            (sent) => {
                rec.busy = false;
                if (!relayUpgrades.has(peerId)) return; // offer 在途期间已被取消
                if (!sent) {
                    // 协商中（对向 offer 在途）：尽快重试，不烧尝试次数
                    scheduleRelayUpgradeRetry(peerId, 6000);
                    return;
                }
                rec.attempts += 1;
                console.log(
                    '[mesh] relay upgrade: ice restart sent',
                    peerId,
                    `${rec.attempts}/${RELAY_UPGRADE_MAX_ATTEMPTS}`
                );
                scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
            },
            () => {
                rec.busy = false;
                if (relayUpgrades.has(peerId)) scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
            }
        );
    }

    function scheduleRelayUpgradeRetry(peerId, delay) {
        const rec = relayUpgrades.get(peerId);
        if (!rec) return;
        clearTimeout(rec.timer);
        rec.timer = setTimeout(() => relayUpgradeTick(peerId), delay);
    }

    function cancel(peerId) {
        const rec = relayUpgrades.get(peerId);
        if (!rec) return;
        clearTimeout(rec.timer);
        relayUpgrades.delete(peerId);
    }

    /** 拆除 / 路径监视停止：取消所有未决周期。 */
    function cancelAll() {
        for (const peerId of [...relayUpgrades.keys()]) cancel(peerId);
    }

    return { note, cancel, cancelAll };
}
