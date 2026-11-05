/*
Relay upgrade — one self-contained engine of the recovery family (split out of
recovery.js at the 1000-line budget; state it needs stays owned by the engine
via injected references).

ICE nominates the first working pair, which can be the TURN relay when direct
checks were still in flight (cold DNS, slow NAT binding, coturn auth
round-trip); WebRTC never re-runs checks on a connected link, so a
connected-but-relayed path stays relayed forever. Fed by the recovery engine's
path poll: once a link sits on relay past the grace window, re-punch with an
iceRestart (chat DataChannel preserved). Glare arbitration mirrors the recovery
ladder — only the lower session-id side initiates, and the restart re-runs
checks on BOTH ends, so the peer needs no watchdog of its own. Attempts are
capped: when direct is impossible (symmetric NAT, blocked UDP) another restart
is pointless churn that only blips the audio.

🔴 The budget must survive everything the app reports about a healthy link:
the 10s recovery scan re-emits 'connected' for every peer, and a restart makes
the path read 'unknown' for a moment. Cancelling the record on either signal
resets `since`/`attempts` from inside the attempt it is supposed to bound —
which is how 1.1.5 ended up never firing (grace 12s > scan 10s). Only these
clear it: path is p2p, link broken (peerRecovery), or we left. The peer-left
case rides peerRecovery/forgetPeer → cancel().
*/

export function createRelayUpgrade({ s, peerRecovery, connPaths }) {
    const RELAY_UPGRADE_GRACE_MS = 12000; // relayed this long after connect → try re-punching
    const RELAY_UPGRADE_RETRY_MS = 10000; // after a restart, let fresh checks settle before judging
    const RELAY_UPGRADE_MAX_ATTEMPTS = 2;
    const RELAY_UPGRADE_TOTAL_MS = 45000; // hard window, also bounds restartIce deferrals
    // peerId -> { timer, attempts, since, done, busy }
    //   done = attempts exhausted, tombstone so the poll stops re-arming
    //   busy = our re-offer is in flight, don't stack a second one
    const relayUpgrades = new Map();

    function note(peerId, info) {
        if (!info || peerRecovery.has(peerId) || !s.selfUuid || s.selfUuid >= peerId) {
            // link gone, or this side isn't the one allowed to re-punch
            cancel(peerId);
            return;
        }
        if (info.type === 'p2p') {
            // direct — the upgrade landed (or was never needed): start clean next time
            cancel(peerId);
            return;
        }
        // 'unknown' is transitional: our own restart is re-checking, or the candidate
        // reports aren't readable yet. Keep the budget — cancelling here would reset
        // the attempt counter from inside the restart it is supposed to bound.
        if (info.state !== 'connected' || info.type !== 'relay') return;

        let rec = relayUpgrades.get(peerId);
        if (!rec) {
            rec = { timer: null, attempts: 0, since: Date.now(), done: false, busy: false };
            relayUpgrades.set(peerId, rec);
        }
        if (rec.done || rec.timer || rec.busy) return; // exhausted / armed / offer in flight
        const due = Math.max(RELAY_UPGRADE_GRACE_MS - (Date.now() - rec.since), 0);
        rec.timer = setTimeout(() => relayUpgradeTick(peerId), due);
    }

    function relayUpgradeTick(peerId) {
        const rec = relayUpgrades.get(peerId);
        if (!rec) return;
        rec.timer = null;
        if (rec.busy) {
            // the previous offer hasn't settled — let it, then judge again
            scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
            return;
        }
        // Peer gone, broken link, or not our turn to initiate: nothing left to judge.
        if (!s.mesh?.entries.has(peerId) || peerRecovery.has(peerId) || !s.selfUuid || s.selfUuid >= peerId) {
            cancel(peerId);
            return;
        }
        // connPaths is written only by the 5s path poll, so this snapshot can still
        // describe the restart that just finished (state 'connecting', type
        // 'unknown'). Only a proven 'p2p' ends the cycle — treating "no verdict yet"
        // as "upgrade not needed" would drop the record and hand the link a fresh
        // 2 attempts, which is how a slow-settling restart turns into an endless
        // renegotiation loop. Unknown waits for the next poll instead.
        const info = connPaths.get(peerId);
        if (info?.type === 'p2p') {
            cancel(peerId);
            return;
        }
        const relayed = info?.state === 'connected' && info.type === 'relay';
        if (rec.attempts >= RELAY_UPGRADE_MAX_ATTEMPTS || Date.now() - rec.since >= RELAY_UPGRADE_TOTAL_MS) {
            if (relayed) console.warn('[mesh] relay upgrade: giving up, link stays on TURN', peerId);
            // tombstone: stay in the map so the poll doesn't re-arm a fresh cycle
            rec.done = true;
            return;
        }
        if (!relayed) {
            // no verdict yet (restart still settling / candidates unreadable): look again
            scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
            return;
        }
        rec.busy = true;
        // restartIce resolves false (never rejects) when the pc is mid-negotiation
        // or closed; the catch arm only guards a future signature change.
        s.mesh.restartIce(peerId).then(
            (sent) => {
                rec.busy = false;
                if (!relayUpgrades.has(peerId)) return; // cancelled while the offer was in flight
                if (!sent) {
                    // mid-negotiation (reverse offer in flight): retry soon, don't burn an attempt
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

    /** Teardown / path-monitor stop: cancel every pending cycle. */
    function cancelAll() {
        for (const peerId of [...relayUpgrades.keys()]) cancel(peerId);
    }

    return { note, cancel, cancelAll };
}
