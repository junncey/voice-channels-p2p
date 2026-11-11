import { createRelayUpgrade } from '/js/pages/channel/relay.js';
import { createLinkQuality } from '/js/pages/channel/quality.js';

/*
Signaling/media self-healing — the recovery engine for the channel page.

  - recovery ladder: per-peer ICE-restart rounds → per-link PC rebuild →
    signaling reconnect (B1)
  - flap shortcut: a link healing ≥4 breaks inside 5 minutes stops riding
    the round ladder — one restart, then straight to the rebuild rung (edge
    WiFi flaps as "periodic blips" otherwise, forever)
  - zombie links: connected, the peer claims to be sending, but zero RTP for
    30s → preemptive ICE restart (DPI/policy black holes that ICE consent
    survives)
  - network-back fast path: 'online'/return-to-visible scans every link at
    once, skips the grace for links already in the ladder, and cuts the
    socket backoff tail
  - presence probe: server-confirmed dead sessions drop out of the ladder
  - "connecting…" badge for ghost members whose offer will never be answered
  - connection path monitor (P2P vs TURN relay badge + rtt)
  - inbound link quality / outbound loss adaptation / jitter boost / the
    zombie+quality restarts (engine split into channel/quality.js — same
    family)
  - relay upgrade: re-punch a connected-but-relayed link while direct checks
    may still succeed (engine split into channel/relay.js — same family)

A coturn restart destroys every TURN allocation while signaling stays up, so
links die without the app noticing. Recovery runs per peer (a mesh can be
half-broken):

  disconnected → 5s grace (ICE often self-heals; acting sooner breaks it)
  failed       → act at once
  → up to 3 ICE-restart rounds (3/6/12s backoff, lower session id initiates
    so both sides never re-offer at once) → when the rest of the mesh is
    healthy, ONE fresh PeerConnection for just that link (new ICE+DTLS, the
    remote answers through the normal path) → signaling reconnect (rebuilds
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

export function createRecovery({ s, x, members, channelId, $, el, t }) {
    const RECOVERY_GRACE_MS = 5000;
    const RECOVERY_ROUND_DELAYS = [3000, 6000, 12000];
    const RECOVERY_TOTAL_MS = 20000; // per-peer window before the signaling reconnect (round3 +12s = 21s)
    const RECOVERY_MAX_B1 = 2; // automatic signaling reconnects before asking the user
    const RECOVERY_SCAN_MS = 10000;
    const RECOVERY_B1_RESET_MS = 60000; // stable for this long → the B1 budget refills
    // flap shortcut: a link healing this many times inside the window stops
    // trusting restart rounds (each round = one audible blip) and escalates
    // to the rebuild rung after a single immediate round
    const FLAP_WINDOW_MS = 5 * 60 * 1000;
    const FLAP_HEAL_THRESHOLD = 4;
    const FLAP_ESCALATE_MS = 6000; // flappy window: one round + a settle beat, then escalate

    const peerRecovery = new Map(); // peerId -> { timer, attempts, lastState, brokenAt, escalated, flappy }
    const flapHeals = new Map(); // peerId -> [healedAt, ...] inside FLAP_WINDOW_MS
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
                // a break that HEALED (the 10s scan re-reports healthy peers with
                // no recovery record — rec existing here means a real cycle)
                if (rec) countFlapHeal(peerId);
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
        // a flapping link gets a compressed window: ONE immediate round to catch
        // a simple route change, then escalate — its history says restarts only
        // ever buy seconds before the next blip
        const windowMs = rec.flappy ? FLAP_ESCALATE_MS : RECOVERY_TOTAL_MS;
        if (Date.now() - rec.brokenAt >= windowMs) {
            escalatePeerRecovery(peerId);
            return;
        }
        const roundLimit = rec.flappy ? 1 : RECOVERY_ROUND_DELAYS.length;
        if (state === 'disconnected' || state === 'failed') {
            if (rec.attempts < roundLimit) {
                rec.attempts += 1;
                probePeerPresence(peerId); // every round: 'gone' settles a dead session one round sooner
                // glare arbitration: with both sides broken, only the lower
                // session id re-offers; the other just answers
                if (s.selfUuid < peerId) {
                    s.mesh.restartIce(peerId).catch(() => {});
                } else {
                    console.log('[mesh] recovery: waiting for peer re-offer', peerId);
                }
                scheduleRecoveryTick(peerId, rec.flappy ? 3000 : RECOVERY_ROUND_DELAYS[rec.attempts - 1]);
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

    /** Record a healed break and count the heals still inside the flap window. */
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
        // Final per-link rung before the B1 sledgehammer: one broken link in a
        // healthy mesh gets a fresh PeerConnection (full ICE+DTLS re-check) —
        // B1 would tear down every OTHER link of the mesh to heal this one.
        // Two or more links failing at once smells mesh-wide: B1 stays the tool.
        if (!rec.rebuilt && onlyBrokenLink(peerId)) {
            rec.rebuilt = true;
            rec.brokenAt = Date.now(); // fresh settle window for the rebuilt link
            // same arbitration as the restart rounds: the lower session id rebuilds
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
            // rebuildPeer refused (entry already gone) — fall through to B1
        }
        rec.escalated = true;
        console.warn('[mesh] recovery: ICE restarts exhausted, falling back to signaling reconnect', peerId);
        showOutageBanner('recovering');
        attemptSignalingReconnect();
    }

    /** peerId is the ONLY link under active recovery — a per-link rebuild can
     *  heal it; several failing together point at our own network instead. */
    function onlyBrokenLink(peerId) {
        for (const id of peerRecovery.keys()) if (id !== peerId) return false;
        return true;
    }

    // -------------------------------------------------------------------------
    // presence probe — a removePeer broadcast missed inside a disconnect window
    // (our socket down longer than the target's ghost grace) leaves a member
    // card no ladder can heal: every offer relays into the void until B1 nukes
    // the whole mesh. One cheap server ack settles it: 'gone' = no session at
    // all → drop the card now; 'ghost'/'live' = keep healing (a resume may
    // still land). The cooldown bounds probe traffic from a flapping link.
    // -------------------------------------------------------------------------

    // per-round dedupe only (the probe is a cheap ack against a memoized
    // server): every restart round may ask once, a flapping link still can't
    // machine-gun it
    const PRESENCE_COOLDOWN_MS = 2000;
    const presenceProbed = new Map(); // peerId -> ts of the last probe

    function probePeerPresence(peerId) {
        if (!s.socket?.connected || !s.joined) return;
        const last = presenceProbed.get(peerId) || 0;
        if (Date.now() - last < PRESENCE_COOLDOWN_MS) return;
        presenceProbed.set(peerId, Date.now());
        s.socket.timeout(5000).emit('peerPresence', { room_id: channelId, peer_id: peerId }, (err, res) => {
            if (err || res?.present !== 'gone') return; // live/ghost/no answer: the ladder keeps trying
            const name = members.get(peerId)?.peer_name || '';
            x.dropPeer(peerId);
            if (s.joined && name) s.chat?.add({ text: t('chat.left', { name }), system: true });
            console.warn('[mesh] recovery: session gone server-side, member dropped', peerId);
        });
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

    // -------------------------------------------------------------------------
    // network-back fast path — 'online' and a return to a visible tab are the
    // two moments the environment demonstrably changed. Scan every link at
    // once (a throttled background tab may have missed state events), skip the
    // grace for links already in the ladder (their ICE pairs went stale with
    // the old route), and cut the socket backoff tail if the transport is
    // still down (mobile wake: throttled heartbeats got it killed server-side;
    // rejoining with the same uuid resumes the ghost before the grace ends).
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
                // the offer may simply have nowhere to land (member left while we
                // were offline) — ask the server before showing an unanswerable badge
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
    // relay re-punch engine (see channel/relay.js) — reads the recovery state
    // (peerRecovery) and this monitor's connPaths snapshot, both injected
    const relayUpgrade = createRelayUpgrade({ s, peerRecovery, connPaths });
    // link-quality engine (see channel/quality.js) — same injections, fed by
    // checkPeerPath below; its lossStreaks back the unstable badge + #debug
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
                if (!info || !s.mesh?.entries.has(peerId)) return; // peer left meanwhile
                connPaths.set(peerId, info);
                quality.note(peerId, info);
                quality.updateBadge(peerId);
                relayUpgrade.note(peerId, info);
            })
            .catch(() => {
                connPaths.delete(peerId);
                quality.updateBadge(peerId); // don't leave a stale "P2P"/relay badge behind
                relayUpgrade.cancel(peerId);
            })
            .finally(() => pathChecks.delete(peerId));
    }

    // -------------------------------------------------------------------------
    // (the relay-upgrade and link-quality engines live in channel/relay.js and
    //  channel/quality.js — injected above as relayUpgrade/quality; this file
    //  keeps only the wiring in checkPeerPath / stopPathMonitor / forgetPeer)
    // -------------------------------------------------------------------------

    /** Forget every per-peer record of a departing member (each engine's map
     *  plus this file's own). */
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

    /** Full reset for teardown: timers, badges, B1 budget and the outage banner. */
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
        // maps read by the member renderer and the #debug probes
        peerRecovery,
        stuckConnecting,
        get lossStreaks() {
            return quality.lossStreaks;
        },
        connPaths,
        debugState: () => ({ connPaths, lossStreaks: quality.lossStreaks, peerRecovery, b1Attempts, b1InFlight }),
    };
}
