/*
Signaling/media self-healing — the recovery engine for the channel page.

  - recovery ladder: per-peer ICE-restart rounds → signaling reconnect (B1)
  - "connecting…" badge for ghost members whose offer will never be answered
  - connection path monitor (P2P vs TURN relay badge + rtt)
  - inbound link quality (loss/jitter diffing → "unstable" badge)
  - relay upgrade: re-punch a connected-but-relayed link while direct checks
    may still succeed

A coturn restart destroys every TURN allocation while signaling stays up, so
links die without the app noticing. Recovery runs per peer (a mesh can be
half-broken):

  disconnected → 5s grace (ICE often self-heals; acting sooner breaks it)
  failed       → act at once
  → up to 3 ICE-restart rounds (3/6/12s backoff, lower session id initiates
    so both sides never re-offer at once) → signaling reconnect (rebuilds
    every link) → after 2 silent reconnects: visible "reload" prompt.
A 10s scan re-checks every connectionState in case a webview swallows the
connectionstatechange event.

The same ladder heals links after a SIGNALING drop (VPN/accelerator switch):
the server parks the session as a ghost, this side keeps its peer
connections, the resume addPeer reuses them, and ICE restarts re-punch the
new network path — no renegotiation, the DataChannel survives.

All state here is private to the engine; shared page state (socket, mesh,
selfUuid…) arrives via the `s` accessor object, cross-module calls via the
late-bound `x` surface, both owned by channel.js.
*/

export function createRecovery({ s, x, members, $, el, t }) {
    const RECOVERY_GRACE_MS = 5000;
    const RECOVERY_ROUND_DELAYS = [3000, 6000, 12000];
    const RECOVERY_TOTAL_MS = 20000; // per-peer window before the signaling reconnect (round3 +12s = 21s)
    const RECOVERY_MAX_B1 = 2; // automatic signaling reconnects before asking the user
    const RECOVERY_SCAN_MS = 10000;
    const RECOVERY_B1_RESET_MS = 60000; // stable for this long → the B1 budget refills

    const peerRecovery = new Map(); // peerId -> { timer, attempts, lastState, brokenAt, escalated }
    let recoveryScanTimer = null;
    let b1Attempts = 0; // automatic signaling reconnects since the last stable period
    let b1InFlight = false;
    let b1Timer = null;
    let b1ResetTimer = null;
    let selfReconnecting = false; // suppress the "disconnected" toast on our own B1 reconnect

    function notePeerState(peerId, state) {
        const rec = peerRecovery.get(peerId);
        if (rec && rec.lastState === state) return;

        if (state === 'connected' || state === 'closed') {
            if (state === 'connected') {
                hideOutageBanner();
                armB1Reset();
            }
            clearConnectingBadge(peerId);
            cancelPeerRecovery(peerId);
            // 🔴 Nothing may reset the relay-upgrade budget here: the 10s recovery
            // scan re-reports 'connected' for every healthy peer, so a cancel in this
            // branch kills the 12s grace timer before it can ever fire (1.1.5 shipped
            // with exactly that bug — the upgrade never ran). A real break clears the
            // budget through peerRecovery instead; see noteRelayUpgrade.
            return;
        }
        if (state !== 'disconnected' && state !== 'failed') return; // new/checking/connecting
        if (!s.mesh?.entries.has(peerId)) {
            cancelPeerRecovery(peerId);
            return;
        }

        if (!rec) {
            clearTimeout(b1ResetTimer); // instability: don't refill the B1 budget
            peerRecovery.set(peerId, {
                timer: null,
                attempts: 0,
                lastState: state,
                brokenAt: Date.now(),
                escalated: false,
            });
            scheduleRecoveryTick(peerId, state === 'failed' ? 0 : RECOVERY_GRACE_MS);
            updatePeerCardRecovery(peerId);
            return;
        }
        rec.lastState = state;
        // disconnected degraded to failed while still in the grace window — skip the wait
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
        if (Date.now() - rec.brokenAt >= RECOVERY_TOTAL_MS) {
            escalatePeerRecovery(peerId);
            return;
        }
        if (state === 'disconnected' || state === 'failed') {
            if (rec.attempts < RECOVERY_ROUND_DELAYS.length) {
                rec.attempts += 1;
                // glare arbitration: with both sides broken, only the lower
                // session id re-offers; the other just answers
                if (s.selfUuid < peerId) {
                    s.mesh.restartIce(peerId).catch(() => {});
                } else {
                    console.log('[mesh] recovery: waiting for peer re-offer', peerId);
                }
                scheduleRecoveryTick(peerId, RECOVERY_ROUND_DELAYS[rec.attempts - 1]);
                return;
            }
            // rounds spent but the window isn't over: keep watching the link
            scheduleRecoveryTick(peerId, RECOVERY_ROUND_DELAYS[RECOVERY_ROUND_DELAYS.length - 1]);
            return;
        }
        // transitional (new/checking/connecting): a restart is being evaluated —
        // re-check shortly without burning another round
        scheduleRecoveryTick(peerId, 3000);
    }

    function escalatePeerRecovery(peerId) {
        const rec = peerRecovery.get(peerId);
        if (!rec || rec.escalated) return;
        rec.escalated = true;
        console.warn('[mesh] recovery: ICE restarts exhausted, falling back to signaling reconnect', peerId);
        showOutageBanner('recovering');
        attemptSignalingReconnect();
    }

    /** Drop every remote peer + mesh entry locally (before intentional
     *  disconnects: the B1 full rebuild and join-error resets — the transport
     *  'disconnect' handler deliberately KEEPS state so a resume can heal it). */
    function resetLocalMesh() {
        s.mesh?.clear();
        for (const peerId of [...members.keys()]) {
            if (peerId !== s.selfUuid) x.dropPeer(peerId, { silent: true });
        }
    }

    /** Last-resort fallback: rebuild the whole session over fresh signaling. */
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
        // B1 is a FULL rebuild: drop the mesh BEFORE disconnecting (the server
        // treats the intentional disconnect as a real leave, everyone tears their
        // links down) — then re-join as a fresh session and let the addPeer storm
        // rebuild every link with fresh ICE
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

    /** A successful (re)join landed: any pending self-reconnect is resolved. */
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

    /** Member card: red name/avatar while the link is broken, badge once recovery runs. */
    function updatePeerCardRecovery(peerId) {
        const node = $(`#memberList .member[data-id="${peerId}"]`);
        if (node) node.classList.toggle('lost', peerRecovery.has(peerId));
    }

    // -------------------------------------------------------------------------
    // "connecting…" badge — a ghost member (socket dead, waiting for the server
    // heartbeat to reap it) never answers the SDP offer, so its card sits in
    // new/connecting looking normal while the link will never come up. Real links
    // settle in 2-8s (relayed ones slower), so only flag past a generous window.
    // -------------------------------------------------------------------------

    const CONNECTING_BADGE_MS = 12000;
    const connectingTimers = new Map(); // peerId -> timeout; present = 'connected' not yet observed
    const stuckConnecting = new Set(); // window expired with the link still not up

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
    // connection path monitor — per-peer badge telling P2P (hole punching
    // succeeded) apart from TURN relay. Read from the selected ICE candidate
    // pair via mesh.connPath() every few seconds: an ICE restart that flips the
    // path gets picked up too. Client-side only — in a mesh no one (not even the
    // server) sees anyone's media path but their own.
    // -------------------------------------------------------------------------

    const PATH_POLL_MS = 5000;
    const PATH_FIRST_CHECK_MS = 1200; // just-connected: let the selected pair settle, then read at once
    const connPaths = new Map(); // peerId -> { type, local, remote, rtt } from mesh.connPath()
    const pathChecks = new Set(); // peers with a getStats round-trip in flight
    const pathEarlyTimers = new Map(); // peerId -> post-connect one-shot check
    let pathPollTimer = null;

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
        lossStreaks.clear();
        for (const peerId of [...relayUpgrades.keys()]) cancelRelayUpgrade(peerId);
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
                if (!info || !s.mesh?.entries.has(peerId)) return; // peer left meanwhile
                connPaths.set(peerId, info);
                notePeerLoss(peerId, info);
                updatePeerPathBadge(peerId);
                noteRelayUpgrade(peerId, info);
            })
            .catch(() => {
                connPaths.delete(peerId);
                updatePeerPathBadge(peerId); // don't leave a stale "P2P"/relay badge behind
                cancelRelayUpgrade(peerId);
            })
            .finally(() => pathChecks.delete(peerId));
    }

    function pathBadgeNode(peerId) {
        const node = el('span', { class: 'badge path-badge' });
        fillPathBadge(node, peerId);
        return node;
    }

    function updatePeerPathBadge(peerId) {
        const node = $(`#memberList .member[data-id="${peerId}"] .path-badge`);
        if (node) fillPathBadge(node, peerId);
    }

    function fillPathBadge(node, peerId) {
        const info = connPaths.get(peerId);
        const known = !!info && (info.type === 'p2p' || info.type === 'relay');
        node.classList.toggle('on', known);
        node.classList.toggle('relay', known && info.type === 'relay');
        node.textContent = known ? t(info.type === 'p2p' ? 'channel.pathP2p' : 'channel.pathRelay') : '';
        if (!known) {
            node.removeAttribute('title');
            return;
        }
        // inline latency right after the link label; null = the selected pair
        // report didn't expose currentRoundTripTime — badge stays label-only.
        // the lone space text node is swallowed by the flex layout (gap: 4px
        // already separates) but keeps "P2P 45ms" as the badge's text content
        const quality = lossStreaks.get(peerId);
        if (info.rtt !== null) node.append(' ', el('span', { class: 'rtt', text: `${info.rtt}ms` }));
        // current loss marker: noticeable at a glance without hovering
        if (quality && quality.loss !== null && quality.loss >= 5)
            node.append(
                ' ',
                el('span', { class: 'loss', text: t('channel.pathLoss', { n: Math.round(quality.loss) }) })
            );
        // hover detail: candidate types on both ends (host/srflx/prflx/relay) + RTT
        // + inbound quality (loss / jitter / bitrate, diffed between polls)
        const parts = [t(info.type === 'p2p' ? 'channel.pathP2pTitle' : 'channel.pathRelayTitle')];
        if (info.local && info.remote) parts.push(`${info.local} ↔ ${info.remote}`);
        if (info.rtt !== null) parts.push(t('channel.pathRtt', { n: info.rtt }));
        if (quality) {
            if (quality.loss !== null) parts.push(t('channel.pathLoss', { n: quality.loss }));
            if (quality.jitter !== null) parts.push(t('channel.pathJitter', { n: quality.jitter }));
            if (quality.kbps !== null) parts.push(t('channel.pathBitrate', { n: quality.kbps }));
        }
        node.title = parts.join(' · ');
    }

    // -------------------------------------------------------------------------
    // inbound link quality — cumulative RTP counters say nothing about a RATE, so
    // every path poll diffs packetsLost/packetsReceived since the previous one.
    // Sustained high loss flips an "unstable" badge on the member card (with
    // hysteresis so a single bad poll doesn't flicker it); the per-poll values
    // feed the path-badge hover detail. Only an ALIVE link is judged — a broken
    // one already shows the recovery badge.
    // -------------------------------------------------------------------------

    const LOSS_BAD_PCT = 10; // a poll at/above this counts as bad
    const LOSS_OK_PCT = 5; // at/below this counts as good (in between: neither)
    const UNSTABLE_BAD_POLLS = 3; // ~15s at the 5s poll cadence → badge on
    const UNSTABLE_GOOD_POLLS = 2; // clean polls before the badge clears
    // peerId -> { last, loss, jitter, kbps, bad, good, unstable }
    const lossStreaks = new Map();

    function notePeerLoss(peerId, info) {
        const rec = lossStreaks.get(peerId) || {
            last: null,
            loss: null,
            jitter: null,
            kbps: null,
            bad: 0,
            good: 0,
            unstable: false,
        };
        const inbound = info?.inbound;
        if (inbound) {
            const prev = rec.last;
            rec.jitter = inbound.jitter !== null ? Math.round(inbound.jitter * 1000) : null;
            if (prev && inbound.timestamp > prev.timestamp) {
                const dLost = inbound.packetsLost - prev.packetsLost;
                const dRecv = inbound.packetsReceived - prev.packetsReceived;
                const dSec = (inbound.timestamp - prev.timestamp) / 1000;
                // negative deltas = counter reset (SSRC switch): skip the rate, rebase
                if (dLost >= 0 && dRecv >= 0) {
                    const total = dLost + dRecv;
                    const loss = total > 0 ? (dLost / total) * 100 : 0;
                    rec.loss = Math.round(loss * 10) / 10;
                    rec.kbps =
                        dSec > 0 ? Math.round(((inbound.bytesReceived - prev.bytesReceived) * 8) / dSec / 1000) : null;
                    if (loss >= LOSS_BAD_PCT) {
                        rec.bad += 1;
                        rec.good = 0;
                    } else if (loss <= LOSS_OK_PCT) {
                        rec.good += 1;
                        rec.bad = 0;
                    }
                }
            }
            rec.last = inbound;
        }
        const was = rec.unstable;
        if (!rec.unstable && rec.bad >= UNSTABLE_BAD_POLLS) rec.unstable = true;
        else if (rec.unstable && rec.good >= UNSTABLE_GOOD_POLLS) rec.unstable = false;
        lossStreaks.set(peerId, rec);
        if (was !== rec.unstable) updatePeerUnstable(peerId);
    }

    function updatePeerUnstable(peerId) {
        const node = $(`#memberList .member[data-id="${peerId}"]`);
        if (node) node.classList.toggle('unstable', !!lossStreaks.get(peerId)?.unstable);
    }

    // -------------------------------------------------------------------------
    // relay upgrade — ICE nominates the first working pair, which can be the TURN
    // relay when direct checks were still in flight (cold DNS, slow NAT binding,
    // coturn auth round-trip); WebRTC never re-runs checks on a connected link, so
    // a connected-but-relayed path stays relayed forever. Fed by the path poll:
    // once a link sits on relay past RELAY_UPGRADE_GRACE_MS, re-punch with an
    // iceRestart (chat DataChannel preserved). Glare arbitration mirrors the
    // recovery ladder — only the lower session-id side initiates, and the restart
    // re-runs checks on BOTH ends, so the peer needs no watchdog of its own.
    // Attempts are capped: when direct is impossible (symmetric NAT, blocked UDP)
    // another restart is pointless churn that only blips the audio.
    //
    // 🔴 The budget must survive everything the app reports about a healthy link:
    // the 10s recovery scan re-emits 'connected' for every peer, and a restart makes
    // the path read 'unknown' for a moment. Cancelling the record on either signal
    // resets `since`/`attempts` from inside the attempt it is supposed to bound —
    // which is how 1.1.5 ended up never firing (grace 12s > scan 10s).
    // Only these clear it: path is p2p, peer left / link broken (peerRecovery), the
    // peer left the room, or we left.
    // -------------------------------------------------------------------------

    const RELAY_UPGRADE_GRACE_MS = 12000; // relayed this long after connect → try re-punching
    const RELAY_UPGRADE_RETRY_MS = 10000; // after a restart, let fresh checks settle before judging
    const RELAY_UPGRADE_MAX_ATTEMPTS = 2;
    const RELAY_UPGRADE_TOTAL_MS = 45000; // hard window, also bounds restartIce deferrals
    // peerId -> { timer, attempts, since, done, busy }
    //   done = attempts exhausted, tombstone so the poll stops re-arming
    //   busy = our re-offer is in flight, don't stack a second one
    const relayUpgrades = new Map();

    function noteRelayUpgrade(peerId, info) {
        if (!info || peerRecovery.has(peerId) || !s.selfUuid || s.selfUuid >= peerId) {
            // link gone, or this side isn't the one allowed to re-punch
            cancelRelayUpgrade(peerId);
            return;
        }
        if (info.type === 'p2p') {
            // direct — the upgrade landed (or was never needed): start clean next time
            cancelRelayUpgrade(peerId);
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
            cancelRelayUpgrade(peerId);
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
            cancelRelayUpgrade(peerId);
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

    function cancelRelayUpgrade(peerId) {
        const rec = relayUpgrades.get(peerId);
        if (!rec) return;
        clearTimeout(rec.timer);
        relayUpgrades.delete(peerId);
    }

    /** Forget every per-peer record of a departing member (all five maps). */
    function forgetPeer(peerId) {
        cancelPeerRecovery(peerId);
        cancelRelayUpgrade(peerId);
        clearConnectingBadge(peerId);
        clearTimeout(pathEarlyTimers.get(peerId));
        pathEarlyTimers.delete(peerId);
        connPaths.delete(peerId);
        lossStreaks.delete(peerId);
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

    /** Full reset for teardown: timers, badges, B1 budget and the outage banner. */
    function resetForTeardown() {
        for (const timer of connectingTimers.values()) clearTimeout(timer);
        connectingTimers.clear();
        stuckConnecting.clear();
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
        pathBadgeNode,
        PATH_FIRST_CHECK_MS,
        // maps read by the member renderer and the #debug probes
        peerRecovery,
        stuckConnecting,
        lossStreaks,
        connPaths,
        debugState: () => ({ connPaths, lossStreaks, peerRecovery, b1Attempts, b1InFlight }),
    };
}
