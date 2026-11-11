/*
Link quality engines — the self-healing family's quality half (split out of
recovery.js at the 1000-line budget, same family as channel/relay.js; the state
it needs stays page-owned via injected references).

Fed by the recovery engine's path poll (checkPeerPath -> note(info)):

  - inbound link quality: cumulative RTP counters say nothing about a RATE, so
    every poll diffs packetsLost/packetsReceived/jitter/concealment. Sustained
    high loss flips the "unstable" member-card badge (hysteresis so a single
    bad poll doesn't flicker it); the per-poll values feed the path-badge hover
    detail (the path-badge rendering lives here too).
  - outbound loss adaptation: the peer's receiver report (fractionLost) about
    OUR stream floors that link's send bitrate until the report cleans up,
    climbing back on a probe ladder.
  - jitter/concealment boost: raise the receive-side playout-buffer target
    while the glitch the listener HEARS persists (NetEQ concealment ratio is
    the ground truth), restore the browser default once it calms.
  - zombie + quality restart: a link that STAYS connected while media dies
    (zero inbound RTP / severe sustained loss / outbound black hole) gets one
    iceRestart — the route itself needs a re-punch, adaptation only eases the
    symptoms. Cooldown'd and glare-safe (see pokeIce).

peerRecovery membership is respected everywhere: a link already riding the
recovery ladder is left to it.
*/

export function createLinkQuality({ s, members, peerRecovery, connPaths, $, el, t }) {
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
    // restart refused mid-negotiation (reverse offer in flight) → retry once after this
    const POKE_RETRY_MS = 6000;
    // peerId -> { last, loss, jitter, kbps, conceal, jbDelay, outLoss, outJitter, outKbps, outLast, outTarget, bad, good, unstable, outTs, obad, ogood, adapted, probing, floorBps, floorWarned, rbad, osev, restartAt, jbad, jgood, jbBoost, jbLevel, zombie, zombieAt, pokeTimer }
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
            pokeTimer: null,
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
        // the signal lives ONLY on this side (the sender sees a healthy link):
        // the detector acts regardless of session-id order
        pokeIce(peerId, rec, '[mesh] zombie link: connected but no inbound RTP, restarting ICE', {
            detectorOnly: true,
        });
    }

    /**
     * The last rung the quality engines can reach: a link that STAYS connected
     * while loss runs severe has a route problem, not a load problem — the
     * bitrate floor and buffer boost only ease the symptoms. One iceRestart
     * re-runs the checks that nominated the pair (a degraded relay path or a
     * rebindable NAT often has a better alternative). Fired for sustained
     * inbound severe loss (detector-side, see pokeIce) and for the outbound
     * black hole (lower-uuid arbitration — the peer's own streak fires there
     * too); a link already riding the recovery ladder is left to it.
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
        // inbound severe loss is detector-only (see pokeIce); the outbound
        // black hole is symmetric — the peer's own rbad streak fires there —
        // so it keeps the lower-uuid arbitration against double restarts
        pokeIce(
            peerId,
            rec,
            `[mesh] quality restart: path unusable, re-punching (${inSevere ? 'inbound loss' : 'outbound black hole'})`,
            { detectorOnly: inSevere && !outBlackhole }
        );
    }

    /** iceRestart with ONE deferred retry: these engines fire on 30-90s
     *  cooldowns, and a restart refused mid-negotiation burns one for nothing.
     *  detectorOnly marks the ASYMMETRIC signals — zombie (the peer's view of
     *  its own link is healthy, it will never restart on its own) and inbound
     *  severe loss (the sender's receiver report never crosses ITS thresholds)
     *  — where waiting for the lower uuid means waiting forever whenever the
     *  receiver IS the higher uuid. The detector acts; a colliding offer from
     *  the peer resolves through the standard perfect-negotiation glare path,
     *  and an iceRestart offer restarts the checks on BOTH ends anyway. */
    function pokeIce(peerId, rec, warnMsg, { detectorOnly = false } = {}) {
        if (!s.selfUuid || (!detectorOnly && s.selfUuid >= peerId)) return;
        console.warn(warnMsg, peerId);
        Promise.resolve(s.mesh?.restartIce(peerId).catch(() => false)).then((sent) => {
            if (sent || rec.pokeTimer) return;
            rec.pokeTimer = setTimeout(() => {
                rec.pokeTimer = null;
                if (s.joined && s.mesh?.entries.has(peerId) && !peerRecovery.has(peerId)) {
                    s.mesh.restartIce(peerId).catch(() => {});
                }
            }, POKE_RETRY_MS);
        });
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
    /** Forget a departing member's quality record (deferred-retry timer included). */
    function forget(peerId) {
        const rec = lossStreaks.get(peerId);
        if (rec?.pokeTimer) clearTimeout(rec.pokeTimer);
        lossStreaks.delete(peerId);
    }

    return {
        note: notePeerLoss,
        updateBadge: updatePeerPathBadge,
        pathBadgeNode,
        forget,
        reset: () => lossStreaks.clear(),
        lossStreaks,
    };
}
