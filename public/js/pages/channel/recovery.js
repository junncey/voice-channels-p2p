import { createRelayUpgrade } from '/js/pages/channel/relay.js';

/*
Signaling/media self-healing — the recovery engine for the channel page.

  - recovery ladder: per-peer ICE-restart rounds → per-link PC rebuild →
    signaling reconnect (B1)
  - flap shortcut: a link that healed ≥4 breaks inside 5 minutes stops riding
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
  - inbound link quality (loss/jitter/concealment diffing → "unstable" badge)
  - outbound loss adaptation (the peer's receiver report floors OUR send
    bitrate for that link until the report cleans up)
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
                notePeerLoss(peerId, info);
                updatePeerPathBadge(peerId);
                relayUpgrade.note(peerId, info);
            })
            .catch(() => {
                connPaths.delete(peerId);
                updatePeerPathBadge(peerId); // don't leave a stale "P2P"/relay badge behind
                relayUpgrade.cancel(peerId);
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
            if (quality.conceal !== null && quality.conceal > 0)
                parts.push(t('channel.pathConceal', { n: quality.conceal }));
            // achieved playout-buffer depth — whether a boost target landed
            if (quality.jbDelay !== null && quality.jbDelay > 0)
                parts.push(t('channel.pathPlayout', { n: quality.jbDelay }));
            if (quality.kbps !== null) parts.push(t('channel.pathBitrate', { n: quality.kbps }));
            // outbound twins (what the peer reports about OUR stream + our
            // encoder's actual output) — the send-side half of the picture
            if (quality.outLoss !== null && quality.outLoss > 0)
                parts.push(t('channel.pathOutLoss', { n: quality.outLoss }));
            if (quality.outJitter !== null && quality.outJitter >= 5)
                parts.push(t('channel.pathOutJitter', { n: quality.outJitter }));
            if (quality.outKbps !== null) parts.push(t('channel.pathOutBitrate', { n: quality.outKbps }));
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
    // outbound loss (the peer's receiver report about OUR stream) → send-side
    // adaptation, same thresholds/hysteresis shape as the badge
    const ADAPT_BAD_POLLS = 3;
    const ADAPT_GOOD_POLLS = 2;
    const ADAPT_FLOOR_MIN_BPS = 24000; // never adapt below the voice bitrate floor
    // receive-side playout boost: NetEQ self-tunes but minimizes delay, so a
    // jittery link keeps glitching — sustained trouble justifies asking for a
    // deeper jitter buffer target until the path calms down again. Two stages:
    // mild first (less added latency when a moderate target already suffices),
    // deep only when the mild one rode along and the glitches persisted
    const JITTER_BAD_MS = 40;
    const JITTER_OK_MS = 25;
    const JITTER_BOOST_MILD_MS = 60;
    const JITTER_BOOST_MS = 120;
    // NetEQ concealment ratio: the fraction of received audio NetEQ had to
    // synthesize (PLC) — the glitch the listener actually HEARS. Network jitter
    // can look calm while a shallow buffer still conceals on bursts/reordering
    // (Wi-Fi power save), so it joins as a ground-truth trigger for the boost.
    const CONCEAL_BAD_PCT = 3;
    const CONCEAL_OK_PCT = 1.5;
    // the deep boost scales with the measured jitter instead of a fixed 120ms —
    // a 90ms-jitter link needs more than twice that to stop concealing
    const JITTER_BOOST_MAX_MS = 240;
    const JITTER_HONORED_TOL_MS = 15; // achieved delay within this of the target = honored
    // quality restart: severe sustained loss on a link that STAYS connected —
    // adaptation (bitrate floor / buffer boost) eases the symptoms, but when
    // the route itself degraded only a re-punch helps. Both directions count:
    // inbound severe loss, and the outbound black hole (the peer's receiver
    // report says nearly everything we send dies — they hear nothing while ICE
    // consent stays green; the zombie engine only catches EXACT zero inbound).
    const LOSS_SEVERE_PCT = 20;
    const SEVERE_BAD_POLLS = 6; // ~30s at the 5s poll cadence
    const OUT_SEVERE_PCT = 90;
    const OUT_BLACKHOLE_POLLS = 3; // ~15s
    const QUALITY_RESTART_COOLDOWN_MS = 90000;
    // zombie links: connected + the peer broadcasts that it's sending, yet
    // exactly zero RTP bytes AND packets across this many polls → the media
    // path is black-holed while ICE consent survives (some DPI/policy changes
    // do exactly that). Opus DTX silence still emits comfort-noise packets
    // (~every 400ms), a muted/PTT peer flips peer_audio_status off — a live
    // sender never sits at exact zero for long, so the streak can't false-fire
    // on quiet talkers. The cooldown keeps a truly dead path from looping
    // restarts forever; ICE consent eventually failing hands it to the ladder.
    const ZOMBIE_POLLS = 6; // ~30s at the 5s poll cadence
    const ZOMBIE_COOLDOWN_MS = 60000;
    // peerId -> { last, loss, jitter, kbps, conceal, jbDelay, outLoss, outJitter, outKbps, outLast, outTarget, bad, good, unstable, outTs, obad, ogood, adapted, probing, floorBps, floorWarned, rbad, osev, restartAt, jbad, jgood, jbBoost, jbLevel, zombie, zombieAt }
    const lossStreaks = new Map();

    function notePeerLoss(peerId, info) {
        const rec = lossStreaks.get(peerId) || {
            last: null,
            loss: null,
            jitter: null,
            kbps: null,
            conceal: null,
            jbDelay: null,
            outLoss: null,
            outJitter: null,
            outKbps: null,
            outLast: null,
            outTarget: null,
            bad: 0,
            good: 0,
            unstable: false,
            outTs: null,
            obad: 0,
            ogood: 0,
            adapted: false,
            probing: false,
            floorBps: null,
            floorWarned: false,
            rbad: 0,
            osev: 0,
            restartAt: 0,
            jbad: 0,
            jgood: 0,
            jbBoost: false,
            jbLevel: 0,
            zombie: 0,
            zombieAt: 0,
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
                    // NetEQ concealment ratio over the same window; either counter
                    // unreported → null, which every consumer treats as "no verdict"
                    rec.conceal =
                        prev.concealedSamples !== null &&
                        inbound.concealedSamples !== null &&
                        prev.totalSamplesReceived !== null &&
                        inbound.totalSamplesReceived !== null &&
                        inbound.totalSamplesReceived - prev.totalSamplesReceived > 0
                            ? Math.round(
                                  ((inbound.concealedSamples - prev.concealedSamples) /
                                      (inbound.totalSamplesReceived - prev.totalSamplesReceived)) *
                                      1000
                              ) / 10
                            : null;
                    // achieved playout-buffer delay over the same window — closes
                    // the jitter-boost loop: a target the browser actually honored
                    // shows up here (delay is cumulative seconds, count cumulative
                    // frames; their per-window ratio is the average depth in ms)
                    rec.jbDelay =
                        prev.jitterBufferDelay !== null &&
                        inbound.jitterBufferDelay !== null &&
                        prev.jitterBufferEmittedCount !== null &&
                        inbound.jitterBufferEmittedCount !== null &&
                        inbound.jitterBufferEmittedCount - prev.jitterBufferEmittedCount > 0
                            ? Math.round(
                                  ((inbound.jitterBufferDelay - prev.jitterBufferDelay) /
                                      (inbound.jitterBufferEmittedCount - prev.jitterBufferEmittedCount)) *
                                      1000
                              )
                            : null;
                    if (loss >= LOSS_BAD_PCT) {
                        rec.bad += 1;
                        rec.good = 0;
                    } else if (loss <= LOSS_OK_PCT) {
                        rec.good += 1;
                        rec.bad = 0;
                    }
                    // severe-loss streak for the quality restart (see its constants)
                    if (loss >= LOSS_SEVERE_PCT) rec.rbad += 1;
                    else if (loss <= LOSS_OK_PCT) rec.rbad = 0;
                    noteZombie(peerId, rec, info, inbound.bytesReceived - prev.bytesReceived, dRecv);
                } else {
                    rec.zombie = 0; // SSRC/counter reset (rebuild): rebase the streak
                    rec.conceal = null;
                    rec.jbDelay = null;
                    rec.rbad = 0;
                }
            }
            rec.last = inbound;
        }
        // outbound loss (the peer's receiver report about OUR stream) rides RTCP
        // and may REPEAT between path polls — the same stale report must not
        // double-feed the streaks below. Each report counts once: a timestamp
        // identical to the previous poll's is a re-read, not a new verdict.
        const outTs = info?.outboundTs;
        const freshReport = outTs === null || outTs === undefined || outTs !== rec.outTs;
        if (outTs !== null && outTs !== undefined) rec.outTs = outTs;
        const outbound = freshReport ? info?.outboundLoss : null;
        if (freshReport && info?.outboundLoss !== null && info?.outboundLoss !== undefined) {
            rec.outLoss = info.outboundLoss;
        }
        rec.outJitter = info?.outboundJitter ?? null;
        // our encoder's actual output, diffed like the inbound counters — the
        // ground truth for "did the bitrate floor actually land" (below)
        const outb = info?.outbound;
        if (outb) {
            const prevOut = rec.outLast;
            if (prevOut && outb.timestamp > prevOut.timestamp) {
                const dBytes = outb.bytesSent - prevOut.bytesSent;
                const dSec = (outb.timestamp - prevOut.timestamp) / 1000;
                rec.outKbps = dBytes >= 0 && dSec > 0 ? Math.round((dBytes * 8) / dSec / 1000) : null;
            }
            rec.outLast = outb;
            rec.outTarget = outb.targetBitrate;
        } else {
            rec.outKbps = null;
            rec.outTarget = null;
        }
        // outbound black-hole streak — counted in EVERY mode: music/share links
        // where the bitrate floor refuses to act still deserve the re-punch
        if (outbound !== null && outbound !== undefined) {
            if (outbound >= OUT_SEVERE_PCT) rec.osev += 1;
            else if (outbound <= LOSS_OK_PCT) rec.osev = 0;
        }
        const was = rec.unstable;
        if (!rec.unstable && rec.bad >= UNSTABLE_BAD_POLLS) rec.unstable = true;
        else if (rec.unstable && rec.good >= UNSTABLE_GOOD_POLLS) rec.unstable = false;
        lossStreaks.set(peerId, rec);
        if (was !== rec.unstable) updatePeerUnstable(peerId);
        noteOutboundAdaptation(peerId, outbound, rec);
        noteJitterBoost(peerId, rec);
        noteQualityRestart(peerId, info, rec);
    }

    /** Zero-RTP streak on a link that claims to be alive (see ZOMBIE_POLLS). */
    function noteZombie(peerId, rec, info, dBytes, dPackets) {
        if (info.state !== 'connected' || members.get(peerId)?.peer_audio_status !== true) {
            rec.zombie = 0;
            return;
        }
        if (dBytes !== 0 || dPackets !== 0) {
            rec.zombie = 0;
            return;
        }
        rec.zombie += 1;
        if (rec.zombie < ZOMBIE_POLLS || Date.now() - rec.zombieAt < ZOMBIE_COOLDOWN_MS) return;
        rec.zombie = 0;
        rec.zombieAt = Date.now();
        // same arbitration as the restart rounds: the lower session id acts
        if (s.selfUuid && s.selfUuid < peerId) {
            console.warn('[mesh] zombie link: connected but no inbound RTP, restarting ICE', peerId);
            s.mesh?.restartIce(peerId).catch(() => {});
        }
    }

    /**
     * The last rung the quality engines can reach: a link that STAYS connected
     * while loss runs severe has a route problem, not a load problem — the
     * bitrate floor and buffer boost only ease the symptoms. One iceRestart
     * re-runs the checks that nominated the pair (a degraded relay path or a
     * rebindable NAT often has a better alternative). Fired for sustained
     * inbound severe loss and for the outbound black hole; cooldown + lower-
     * uuid arbitration mirror the zombie engine, and a link already riding the
     * recovery ladder is left to it.
     */
    function noteQualityRestart(peerId, info, rec) {
        if (info?.state !== 'connected' || peerRecovery.has(peerId)) return;
        const now = Date.now();
        if (now - rec.restartAt < QUALITY_RESTART_COOLDOWN_MS) return;
        const inSevere = rec.rbad >= SEVERE_BAD_POLLS;
        const outBlackhole = rec.osev >= OUT_BLACKHOLE_POLLS;
        if (!inSevere && !outBlackhole) return;
        rec.rbad = 0;
        rec.osev = 0;
        rec.restartAt = now;
        // same arbitration as the restart rounds: the lower session id acts
        if (s.selfUuid && s.selfUuid < peerId) {
            console.warn(
                '[mesh] quality restart: connected but path is unusable, re-punching',
                peerId,
                inSevere ? 'inbound loss' : 'outbound black hole'
            );
            s.mesh?.restartIce(peerId).catch(() => {});
        }
    }

    /**
     * Send-side answer to sustained OUTBOUND loss (mesh links are
     * independent: the inbound badge says the peer is hard to hear, while
     * fractionLost in the peer's receiver report says OUR stream is the one
     * dropping). Floor this link's encoder cap at half the configured bitrate
     * until the report cleans up — setParameters, no renegotiation involved.
     * The way back up is a probe ladder (floor → 3/4 cap → full cap): jumping
     * straight from the floor to the configured cap is exactly the load that
     * floored the link, and re-triggering it oscillates forever.
     * Speech mode only (usedtx caps): music/share fidelity is an explicit user
     * choice, the badge alone tells them the link is bad.
     */
    function noteOutboundAdaptation(peerId, outbound, rec) {
        const fmtp = s.mesh?.getOpusFmtp?.();
        if (fmtp?.usedtx === 1 && fmtp?.maxaveragebitrate && outbound !== null && outbound !== undefined) {
            if (outbound >= LOSS_BAD_PCT) {
                rec.obad += 1;
                rec.ogood = 0;
            } else if (outbound <= LOSS_OK_PCT) {
                rec.ogood += 1;
                rec.obad = 0;
            }
            if (!rec.adapted && rec.obad >= ADAPT_BAD_POLLS) {
                rec.adapted = true;
                rec.probing = false;
                const floor = Math.max(ADAPT_FLOOR_MIN_BPS, Math.floor(fmtp.maxaveragebitrate / 2));
                rec.floorBps = floor;
                s.mesh.setPeerBitrateFloor(peerId, floor);
                console.warn('[mesh] loss adaptation: send bitrate floored', peerId, `${floor / 1000}kbps`);
            } else if (rec.adapted && !rec.probing && rec.ogood >= ADAPT_GOOD_POLLS) {
                // clean long enough to risk a probe: step UP to 3/4 of the cap,
                // one bad report puts the floor straight back
                rec.probing = true;
                rec.ogood = 0;
                const probe = Math.floor((fmtp.maxaveragebitrate * 3) / 4);
                rec.floorBps = probe;
                s.mesh.setPeerBitrateFloor(peerId, probe);
                console.log('[mesh] loss adaptation: probing higher bitrate', peerId, `${probe / 1000}kbps`);
            } else if (rec.probing && rec.obad >= 1) {
                rec.probing = false;
                const floor = Math.max(ADAPT_FLOOR_MIN_BPS, Math.floor(fmtp.maxaveragebitrate / 2));
                rec.floorBps = floor;
                s.mesh.setPeerBitrateFloor(peerId, floor);
                console.warn('[mesh] loss adaptation: probe failed, floor re-applied', peerId);
            } else if (rec.probing && rec.ogood >= ADAPT_GOOD_POLLS) {
                rec.adapted = false;
                rec.probing = false;
                rec.floorBps = null;
                s.mesh.setPeerBitrateFloor(peerId, null);
                console.log('[mesh] loss adaptation: bitrate restored', peerId);
            }
        } else if (rec.adapted && fmtp?.usedtx !== 1) {
            // mode left speech (music/share): the user's caps rule the link again
            rec.adapted = false;
            rec.probing = false;
            rec.floorBps = null;
            s.mesh.setPeerBitrateFloor(peerId, null);
        }
        // readback: while a floor/probe is in force the encoder's reported
        // target should sit near it — a setParameters the browser resolved
        // but ignored leaves this whole engine running on air. Warn-once per
        // floor; the generous tolerance absorbs speech-mode RED roughly
        // doubling the wire rate over the encoder's own target.
        if (rec.floorBps && rec.outTarget !== null && rec.outTarget > rec.floorBps * 2.5 && !rec.floorWarned) {
            rec.floorWarned = true;
            console.warn(
                '[mesh] loss adaptation: encoder target ignores the floor',
                peerId,
                `target=${Math.round(rec.outTarget / 1000)}kbps`
            );
        } else if (!rec.floorBps) {
            rec.floorWarned = false;
        }
    }

    /**
     * Receive-side answer to a jittery/lossy/glitching inbound link: raise that
     * link's audio playout buffer target while the trouble lasts (mesh.
     * setPeerJitterTarget — receiver-side, no renegotiation), restore the
     * browser's adaptive default once it calms. Same hysteresis shape as the
     * other engines; unlike the send-side bitrate floor this carries no
     * fidelity trade, so it runs in every mode (music glitches cut worse).
     */
    function noteJitterBoost(peerId, rec) {
        const jitterBad = rec.jitter !== null && rec.jitter >= JITTER_BAD_MS;
        const lossBad = rec.loss !== null && rec.loss >= LOSS_BAD_PCT;
        // concealment is the audible symptom the two network-level signals above
        // can miss — it joins both sides of the hysteresis
        const glitchBad = rec.conceal !== null && rec.conceal >= CONCEAL_BAD_PCT;
        const calm =
            (rec.jitter === null || rec.jitter <= JITTER_OK_MS) &&
            (rec.loss === null || rec.loss <= LOSS_OK_PCT) &&
            (rec.conceal === null || rec.conceal <= CONCEAL_OK_PCT);
        if (jitterBad || lossBad || glitchBad) {
            rec.jbad += 1;
            rec.jgood = 0;
        } else if (calm) {
            rec.jgood += 1;
            rec.jbad = 0;
        } else {
            return; // in between: hold the current state
        }
        if (!rec.jbBoost && rec.jbad >= ADAPT_BAD_POLLS) {
            rec.jbBoost = true;
            rec.jbLevel = 1;
            s.mesh?.setPeerJitterTarget(peerId, JITTER_BOOST_MILD_MS);
            console.warn('[mesh] jitter boost: playout target raised', peerId, `${JITTER_BOOST_MILD_MS}ms`);
        } else if (rec.jbBoost && rec.jbLevel === 1 && rec.jbad >= ADAPT_BAD_POLLS * 2) {
            // closed loop via the achieved delay: only stack a deeper target
            // when the mild one actually landed (or is unobservable) — a
            // browser that ignored 60ms will ignore 120ms just the same
            const honored = rec.jbDelay === null || rec.jbDelay >= JITTER_BOOST_MILD_MS - JITTER_HONORED_TOL_MS;
            if (!honored) return;
            rec.jbLevel = 2;
            // scale the deep target with the measured jitter (rounded to 10ms),
            // clamped to sane audio bounds — a 90ms-jitter link needs more than
            // a fixed 120ms to stop concealing, a 35ms one doesn't need more
            const deep = Math.min(
                JITTER_BOOST_MAX_MS,
                Math.max(JITTER_BOOST_MS, Math.ceil(((rec.jitter || 0) * 3) / 10) * 10)
            );
            s.mesh?.setPeerJitterTarget(peerId, deep);
            console.warn('[mesh] jitter boost: sustained trouble, deep target', peerId, `${deep}ms`);
        } else if (rec.jbBoost && rec.jgood >= ADAPT_GOOD_POLLS) {
            rec.jbBoost = false;
            rec.jbLevel = 0;
            s.mesh?.setPeerJitterTarget(peerId, null);
            console.log('[mesh] jitter boost: playout target restored', peerId);
        }
    }

    function updatePeerUnstable(peerId) {
        const node = $(`#memberList .member[data-id="${peerId}"]`);
        if (node) node.classList.toggle('unstable', !!lossStreaks.get(peerId)?.unstable);
    }

    // -------------------------------------------------------------------------
    // (relay upgrade engine lives in channel/relay.js — injected above as
    //  relayUpgrade; this file keeps only the wiring in checkPeerPath /
    //  stopPathMonitor / forgetPeer)
    // -------------------------------------------------------------------------

    /** Forget every per-peer records of a departing member (all seven maps). */
    function forgetPeer(peerId) {
        cancelPeerRecovery(peerId);
        relayUpgrade.cancel(peerId);
        clearConnectingBadge(peerId);
        clearTimeout(pathEarlyTimers.get(peerId));
        pathEarlyTimers.delete(peerId);
        connPaths.delete(peerId);
        lossStreaks.delete(peerId);
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
