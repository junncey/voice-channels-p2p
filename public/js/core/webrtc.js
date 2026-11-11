/**
 * Mesh WebRTC manager — one RTCPeerConnection per remote peer.
 *
 * Signaling protocol (server relays, never touches media):
 *   relaySDP        { peer_id, session_description }
 *   relayICE        { peer_id, ice_candidate }
 *   sessionDescription / iceCandidate / addPeer / removePeer  (incoming)
 *
 * Chat rides a per-connection DataChannel (P2P, never relayed).
 *
 * Negotiation model (avoids offer glare in an audio-only mesh):
 *  - The joiner (should_create_offer=true) creates the DataChannel and sends
 *    the initial offer.
 *  - The other side attaches its mic BEFORE answering, so an offer with an
 *    audio m-line gets a sendrecv answer and media flows as soon as ICE
 *    connects (attaching after 'connected' cost a full reverse-offer round
 *    before this side became audible). A text-only joiner's DC-only offer
 *    stays DC-only; the later voice-enable rides the standard addTrack →
 *    negotiationneeded → reverse-offer path (replaceAudioTrack/_addLocalTracks).
 *  - Colliding offers (both sides recovering at once) break the tie with
 *    perfect-negotiation roles: the LOWER session uuid is impolite (keeps its
 *    offer), the higher rolls back and answers (see handleSessionDescription).
 */

const CHAT_DC_LABEL = 'mirotalk_chat_channel';
// renegotiation retry ladder: the first delay clears the usual reverse-offer
// window, the second one catches a slow settle — after that the change waits
// for whatever SDP round comes naturally
const RENEGOTIATE_RETRIES = 2;
const RENEGOTIATE_RETRY_DELAYS = [2500, 7000];
// budget a not-yet-open DataChannel may buffer for ONE peer — an image
// transfer into a link whose channel never opens must not sit in memory
// until the peer finally leaves. Frames: one full image is ~137 12KB chunks,
// so the cap must hold at least that burst. Bytes: frame caps alone don't
// bound memory (image chunks are ~12k chars each) — the byte budget does.
// Exceeding either refuses the frame (see sendChat) so a multi-frame image
// batch aborts coherently instead of half-queueing.
const DC_QUEUE_MAX_FRAMES = 512;
const DC_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
// SCTP low-water mark for the image-transfer pump (see drainChat): below it
// the channel may be fed another burst of chunks, above it the pump waits —
// the data shares its ICE 5-tuple (and its bandwidth) with the voice packets
const DC_BUFFER_LOW = 128 * 1024;
const DRAIN_WAIT_MS = 60; // pump poll cadence
const DRAIN_MAX_MS = 5000; // one wait never stalls a transfer for long

/**
 * Merge Opus fmtp parameters into every opus/48000/2 fmtp line of an SDP.
 * Idempotent (same-key values are replaced, not duplicated) — safe to run on
 * each re-offer of the ICE-restart ladder. A param explicitly set to null is
 * REMOVED, so a mode dict can state its full desired state and a mid-call
 * mode switch cannot leave the other mode's params in later re-offers.
 * Only OUR local descriptions are munged: send-side caps
 * (maxaveragebitrate/usedtx) configure the local encoder, and stereo travels
 * end-to-end once both peers munge their own offer/answer (Chrome reads its
 * local fmtp for encoder config).
 * Exported for tests (tests/test-opusFmtp.js).
 * @param {string} sdp
 * @param {object} params e.g. { maxaveragebitrate: 64000, usedtx: 1, stereo: null }
 */
export function mungeOpusFmtp(sdp, params) {
    const payloadTypes = new Set();
    for (const match of sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2(?=\s|$)/g)) payloadTypes.add(match[1]);
    if (!payloadTypes.size) return sdp;
    return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, pt, existing) => {
        if (!payloadTypes.has(pt)) return line;
        const merged = {};
        for (const pair of existing.split(';')) {
            const eq = pair.indexOf('=');
            if (eq === -1) {
                if (pair.trim()) merged[pair.trim()] = '';
            } else merged[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
        for (const [key, value] of Object.entries(params)) {
            if (value === null) delete merged[key];
            else merged[key] = value;
        }
        const text = Object.entries(merged)
            .map(([key, value]) => (value === '' ? key : `${key}=${value}`))
            .join(';');
        return text ? `a=fmtp:${pt} ${text}` : `a=fmtp:${pt}`;
    });
}

/**
 * Reorder audio codec capabilities so audio/red (REDundant audio, RFC 2198
 * style — Chrome ships it as the UEP wrapper around Opus) is offered FIRST.
 * Codec order decides what a Chrome sender actually encodes with: RED in the
 * lead means every packet re-carries the previous frame, so a single lost
 * packet costs nothing audible — a much stronger loss defense than inband FEC
 * (which only softens Opus-internal frame losses). Browsers without audio/red
 * in their capabilities get the list back untouched, and negotiation stays
 * safe either way: if the ANSWER omits red the sender falls back to plain
 * Opus. Exported for tests (tests/test-red-codecs.js).
 * @param {Array} codecs RTCRtpReceiver.getCapabilities('audio').codecs
 * @returns {Array} new array, red entries first, everything else in order
 */
export function redFirstCodecs(codecs) {
    if (!Array.isArray(codecs) || !codecs.length) return codecs || [];
    const red = codecs.filter((codec) => codec?.mimeType?.toLowerCase() === 'audio/red');
    if (!red.length) return codecs;
    return [...red, ...codecs.filter((codec) => codec?.mimeType?.toLowerCase() !== 'audio/red')];
}

/** Identity of an iceServers payload: URLs + credential username. REST-mode
 *  usernames are unix expiry timestamps, so a minted set always differs. */
function iceServersStamp(iceServers) {
    return iceServers.map((server) => `${server?.urls}|${server?.username || ''}`).join(';');
}

export class Mesh {
    /**
     * @param {object}   options
     * @param {object}   options.signaling     socket.io client (needs .emit)
     * @param {object}   options.handlers      { onRemoteStream, onChat, onPeerState }
     * @param {function} [options.getOpusFmtp] () => Opus fmtp params for OUR local
     *                                            offer/answer (null = leave defaults)
     * @param {function} [options.getSelfId]   () => our session uuid — enables the
     *                                            polite/impolite glare roles below
     */
    constructor({ signaling, handlers = {}, getOpusFmtp = null, getSelfId = null }) {
        this.signaling = signaling;
        this.handlers = handlers;
        this.getOpusFmtp = getOpusFmtp;
        this.getSelfId = getSelfId;
        this.localStream = null;
        /** newest iceServers payload (TURN REST credentials age out mid-session) */
        this.iceServers = [];
        /** identity of the current iceServers payload (dedupes join storms) */
        this.iceStamp = '';
        /** peerId -> { pc, dc, dcTimer, pendingIce, queue, queueBytes, tracksAdded, offering, bitrateFloor, jitterTarget, renegotiateTimer } */
        this.entries = new Map();
    }

    /** Set/replace the local mic stream (call before peers connect, or to enable voice later). */
    setLocalStream(stream) {
        this.localStream = stream;
        if (stream) {
            for (const entry of this.entries.values()) {
                if (entry.pc.connectionState === 'connected') this._addLocalTracks(entry);
            }
        }
    }

    getLocalStream() {
        return this.localStream;
    }

    /**
     * Swap the outgoing audio track on every live connection (mic switch or
     * constraint change). sender.replaceTrack keeps the negotiation untouched.
     * @param {MediaStreamTrack} track track from the NEW local stream
     * @param {MediaStream} [stream] the new local stream (updates this.localStream)
     */
    replaceAudioTrack(track, stream) {
        if (stream) this.localStream = stream;
        for (const entry of this.entries.values()) {
            if (entry.pc.connectionState === 'closed') continue;
            if (!entry.tracksAdded) {
                // this link came up while we were text-only and voice got
                // enabled since (the on-connect attach already ran with no
                // stream to add) — attach NOW: addTrack fires
                // negotiationneeded and the standard reverse-offer round
                // carries the track to the peer. Skipping here (the old
                // "will pick the current stream on connect") left a
                // mid-call voice enabler transmitting to nobody.
                this._addLocalTracks(entry);
                continue;
            }
            const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
            if (sender) sender.replaceTrack(track).catch((err) => console.error('[mesh] replaceTrack failed', err));
            else {
                entry.pc.addTrack(track, this.localStream);
                this._applySendBitrate(entry); // a fresh sender must not sit at the browser default
            }
        }
    }

    /**
     * @param {string}  peerId
     * @param {boolean} shouldCreateOffer true for the joiner side
     * @param {Array}   iceServers from the addPeer payload
     */
    addPeer(peerId, shouldCreateOffer, iceServers = []) {
        // a fresh credential set rides on EVERY addPeer (rejoin storms too) —
        // apply it at once to every live connection (a recovery iceRestart
        // racing the refresh timer would otherwise gather with credentials
        // that already age out), deduped so a join storm doesn't churn
        // setConfiguration O(n²)
        if (iceServers?.length && iceServersStamp(iceServers) !== this.iceStamp) this.updateIceServers(iceServers);
        if (this.entries.has(peerId)) return;

        // iceCandidatePoolSize pre-allocates host candidates: first join and
        // every restart gather a beat faster (audio-only — the cost is negligible)
        const pc = new RTCPeerConnection({
            iceServers: iceServers.length ? iceServers : this.iceServers,
            iceCandidatePoolSize: 2,
        });
        const entry = { pc, dc: null, pendingIce: [], queue: [], queueBytes: 0, tracksAdded: false, offering: false };
        this.entries.set(peerId, entry);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.signaling.emit('relayICE', { peer_id: peerId, ice_candidate: event.candidate });
            }
        };

        pc.ontrack = (event) => {
            // a rebuild carried a jitter-buffer target over but the fresh PC had
            // no receivers yet — apply it to the track's receiver as it lands
            if (entry.jitterTarget !== null && entry.jitterTarget !== undefined && event.receiver) {
                this._applyJitterTarget(event.receiver, entry.jitterTarget);
            }
            const stream = event.streams[0];
            if (stream && this.handlers.onRemoteStream) this.handlers.onRemoteStream(peerId, stream);
        };

        pc.onconnectionstatechange = () => {
            // Fallback attach: a stream that arrived after the answer (voice
            // enabled on a link that connected while we were text-only) hooks
            // in here — idempotent when the pre-answer attach already ran.
            if (pc.connectionState === 'connected') this._addLocalTracks(entry);
            if (this.handlers.onPeerState) this.handlers.onPeerState(peerId, pc.connectionState);
        };

        const initiateOffer = async () => {
            if (entry.offering || pc.signalingState !== 'stable') return;
            entry.offering = true;
            try {
                this._preferCodecs(pc);
                const offer = await pc.createOffer();
                this._mungeLocalSdp(offer);
                await pc.setLocalDescription(offer);
                this.signaling.emit('relaySDP', { peer_id: peerId, session_description: pc.localDescription });
            } catch (err) {
                console.error('[mesh] offer failed', peerId, err);
            } finally {
                entry.offering = false;
            }
        };
        pc.onnegotiationneeded = initiateOffer;

        if (shouldCreateOffer) {
            this._attachChat(peerId, entry, pc.createDataChannel(CHAT_DC_LABEL));
            if (this.localStream) {
                this._addLocalTracks(entry); // fires negotiationneeded -> initial offer
            } else {
                // text-only joiner: no track to trigger negotiationneeded, so
                // kick the initial (recvonly, data-channel) offer manually —
                // the remote mic arrives via the reverse offer once connected
                initiateOffer();
            }
        } else {
            pc.ondatachannel = (event) => {
                if (event.channel.label === CHAT_DC_LABEL) this._attachChat(peerId, entry, event.channel);
            };
        }
    }

    async handleSessionDescription({ peer_id, session_description }) {
        const entry = this.entries.get(peer_id);
        if (!entry || !session_description) return;
        const pc = entry.pc;
        try {
            await this._applySessionDescription(peer_id, entry, session_description);
        } catch (err) {
            // Glare: both sides may re-offer at once (e.g. both recovering a
            // dead link). Perfect-negotiation roles keep it deterministic —
            // the LOWER session uuid (the side the recovery ladder already
            // trusts to initiate) is impolite: it IGNORES the colliding offer
            // and waits for the answer to its own. The higher uuid rolls back
            // and answers. Without roles both sides would roll back, each
            // answer would land on a rolled-back offer, and BOTH negotiations
            // die (the old always-polite behavior). Without getSelfId the
            // polite rollback stays as the safe default.
            if (session_description.type === 'offer' && pc.signalingState === 'have-local-offer') {
                const selfId = this.getSelfId?.();
                if (selfId && selfId < peer_id) {
                    console.log('[mesh] glare: impolite, keeping our offer', peer_id);
                    return;
                }
                try {
                    await pc.setLocalDescription({ type: 'rollback' });
                    await this._applySessionDescription(peer_id, entry, session_description);
                    return;
                } catch (retryErr) {
                    console.error('[mesh] glare rollback failed', peer_id, retryErr);
                    return;
                }
            }
            console.error('[mesh] session description failed', peer_id, err);
        }
    }

    async _applySessionDescription(peer_id, entry, session_description) {
        const pc = entry.pc;
        await pc.setRemoteDescription(session_description);
        // flush ICE candidates that arrived before the remote description
        for (const candidate of entry.pendingIce.splice(0)) {
            try {
                await pc.addIceCandidate(candidate);
            } catch {
                /* stale candidate, ignore */
            }
        }
        if (session_description.type === 'offer') {
            // attach our mic BEFORE answering: an offer that carries an audio
            // m-line is answered sendrecv at once, so media flows the moment
            // ICE connects — no reverse-offer round (≈ one extra signaling
            // RTT + renegotiation settle, 1-3s) before this side is audible.
            // A DC-only offer (text-only joiner) gains no m-line in the answer;
            // addTrack queues its negotiationneeded until after the answer,
            // which produces exactly that reverse offer through the normal
            // path. The on-connect attach below remains as the idempotent
            // fallback for streams that arrive later.
            this._addLocalTracks(entry);
            this._preferCodecs(pc);
            const answer = await pc.createAnswer();
            this._mungeLocalSdp(answer);
            await pc.setLocalDescription(answer);
            this.signaling.emit('relaySDP', { peer_id, session_description: pc.localDescription });
        }
        this._restampAdaptiveState(entry);
    }

    /**
     * Re-establish the media path WITHOUT rebuilding the PeerConnection
     * (e.g. the TURN allocation died on a coturn restart). Sends a re-offer
     * with iceRestart; the remote side answers through the normal path and
     * the chat DataChannel is preserved.
     * @param {string} peerId
     * @returns {Promise<boolean>} true when a re-offer went out
     */
    async restartIce(peerId) {
        return this._sendOffer(peerId, { iceRestart: true });
    }

    /**
     * Renegotiate a live link WITHOUT touching ICE (e.g. an fmtp-only change
     * such as stereo/usedtx after a music-mode toggle — setParameters cannot
     * move those, and a healthy link never produces another SDP round on its
     * own). Reuses the fmtp munging and glare guards of the offer path.
     * A refusal (mid-negotiation: the reverse offer from the answer side is
     * still in flight) retries on a short ladder — unlike the recovery paths
     * there is no cadence that would retry by itself, and a lost round here
     * strands the link in the wrong mode (music caps with speech DTX…) until
     * some unrelated SDP event.
     * @param {string} peerId
     * @returns {Promise<boolean>} true when the offer went out
     */
    async renegotiate(peerId) {
        const sent = await this._sendOffer(peerId, {});
        if (!sent) this._scheduleRenegotiateRetry(peerId, 1);
        return sent;
    }

    /** Bounded retry for a renegotiation the offer path refused (see renegotiate). */
    _scheduleRenegotiateRetry(peerId, attempt) {
        if (attempt > RENEGOTIATE_RETRIES) return;
        const entry = this.entries.get(peerId);
        if (!entry || entry.renegotiateTimer) return;
        entry.renegotiateTimer = setTimeout(
            () => {
                entry.renegotiateTimer = null;
                if (!this.entries.has(peerId)) return; // peer left while waiting
                this._sendOffer(peerId, {}).then((sent) => {
                    if (!sent) this._scheduleRenegotiateRetry(peerId, attempt + 1);
                });
            },
            RENEGOTIATE_RETRY_DELAYS[attempt - 1]
        );
    }

    /** Renegotiate every stable link — mode toggles apply to the whole mesh. */
    renegotiateAll() {
        for (const peerId of this.entries.keys()) this.renegotiate(peerId).catch(() => {});
    }

    /**
     * Last rung before a signaling reconnect: rebuild ONE link — close the old
     * PeerConnection (fresh ICE + DTLS) and re-offer through the normal joiner
     * path. The remote keeps its entry and simply answers: an offer from a new
     * PC carries new ice-ufrag, which forces both agents to regenerate their
     * credentials — a full re-check, the same negotiation shape as a
     * leave+rejoin without the server round-trip. ontrack fires again on this
     * side, so the existing attachRemoteAudio re-hooks playback.
     * @param {string} peerId
     * @returns {boolean} whether a fresh entry (and its offer) went out
     */
    rebuildPeer(peerId) {
        const prev = this.entries.get(peerId);
        if (!prev) return false;
        // carry the adaptive state over: a rebuilt link is at its most fragile
        // right after the swap — losing a boosted jitter target or a loss-driven
        // bitrate floor here would fall back to browser defaults exactly when
        // the deep buffer was earned (the recovery engine's streak records
        // survive, but they only re-apply on the next state CHANGE, which may
        // never come). jitterTarget is re-applied per receiver in ontrack.
        const carry = { jitterTarget: prev.jitterTarget ?? null, bitrateFloor: prev.bitrateFloor || null };
        this.removePeer(peerId);
        this.addPeer(peerId, true, this.iceServers);
        const entry = this.entries.get(peerId);
        if (entry) {
            entry.bitrateFloor = carry.bitrateFloor;
            entry.jitterTarget = carry.jitterTarget;
        }
        return this.entries.has(peerId);
    }

    /** Offer core shared by ice restarts and plain renegotiations. */
    async _sendOffer(peerId, offerOptions) {
        const entry = this.entries.get(peerId);
        if (!entry) return false;
        const pc = entry.pc;
        // mid-negotiation (reverse offer in flight): let that settle first,
        // the caller's cadence retries on its next tick
        if (pc.connectionState === 'closed' || pc.signalingState !== 'stable') return false;
        entry.offering = true;
        try {
            this._preferCodecs(pc);
            const offer = await pc.createOffer(offerOptions);
            this._mungeLocalSdp(offer);
            await pc.setLocalDescription(offer);
            this.signaling.emit('relaySDP', { peer_id: peerId, session_description: pc.localDescription });
            if (offerOptions.iceRestart) console.log('[mesh] ice restart offer sent', peerId);
            this._restampAdaptiveState(entry);
            return true;
        } catch (err) {
            console.error('[mesh] offer failed', peerId, err);
            return false;
        } finally {
            entry.offering = false;
        }
    }

    /**
     * Swap in a fresh ICE server list (TURN REST credentials age out — in that
     * mode the username IS the expiry timestamp). setConfiguration feeds the
     * ICE agent of every live connection, so the NEXT iceRestart gathers relay
     * candidates with credentials that still authenticate; established
     * allocations keep running on the old ones either way.
     * @param {Array} iceServers
     * @returns {number} how many live connections refused setConfiguration
     */
    updateIceServers(iceServers) {
        if (!Array.isArray(iceServers) || !iceServers.length) return 0;
        this.iceServers = iceServers;
        this.iceStamp = iceServersStamp(iceServers);
        let refused = 0;
        for (const entry of this.entries.values()) {
            if (entry.pc.connectionState === 'closed') continue;
            try {
                entry.pc.setConfiguration({ iceServers });
            } catch {
                refused += 1; // rare mid-negotiation edge — caller re-applies shortly
            }
        }
        return refused;
    }

    async handleIceCandidate({ peer_id, ice_candidate }) {
        const entry = this.entries.get(peer_id);
        if (!entry || !ice_candidate) return;
        if (!entry.pc.remoteDescription) {
            entry.pendingIce.push(ice_candidate);
            return;
        }
        try {
            await entry.pc.addIceCandidate(ice_candidate);
        } catch {
            /* ignore late/duplicate candidates */
        }
    }

    /**
     * Inspect the live ICE path of a connection from getStats(): 'p2p' when
     * the selected candidate pair is direct on both ends (host/srflx/prflx —
     * hole punching succeeded), 'relay' when media flows through a TURN
     * server (either end sits on a relay candidate). The inbound audio RTP
     * report rides along (cumulative counters — the caller diffs between
     * polls for loss % and bitrate), plus the OUTBOUND loss the peer's
     * receiver report attributes to our stream (fractionLost, as %) — the
     * signal any send-side adaptation must react to.
     * @param {string} peerId
     * @returns {Promise<?object>} { state, type, local, remote, rtt, inbound, outboundLoss, outboundTs, outboundJitter, outbound } — null when the peer is unknown
     */
    async connPath(peerId) {
        const entry = this.entries.get(peerId);
        if (!entry) return null;
        const pc = entry.pc;
        const state = pc.connectionState;
        if (state !== 'connected') {
            return {
                state,
                type: 'unknown',
                local: null,
                remote: null,
                rtt: null,
                inbound: null,
                outboundLoss: null,
                outboundTs: null,
                outboundJitter: null,
                outbound: null,
            };
        }
        const stats = await pc.getStats();
        const candidates = new Map();
        let pair = null; // explicit selected marker (standard/Firefox)…
        let fallback = null; // …Chromium: the newest succeeded + nominated pair
        let inbound = null; // inbound audio RTP (one audio track per connection)
        let outboundLoss = null; // % of OUR stream the peer reports lost (0..1 → %)
        let outboundTs = null; // timestamp of that receiver report (dedupe identity)
        let outboundJitter = null; // the peer's view of OUR stream's jitter (ms)
        let outbound = null; // OUR outbound audio RTP counters (diffed by the caller)
        stats.forEach((report) => {
            if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                candidates.set(report.id, report);
                return;
            }
            if (report.type === 'inbound-rtp' && !inbound) {
                // links in this app are audio-only: the first inbound-rtp IS the
                // audio stream even when the browser omits `kind` (older Firefox
                // reported it as `mediaType`) — without the fallback the whole
                // inbound quality monitor silently goes dark
                const kind = report.kind || report.mediaType;
                if (!kind || kind === 'audio') {
                    inbound = {
                        packetsLost: report.packetsLost ?? 0,
                        packetsReceived: report.packetsReceived ?? 0,
                        jitter: typeof report.jitter === 'number' ? report.jitter : null,
                        bytesReceived: report.bytesReceived ?? 0,
                        timestamp: report.timestamp ?? Date.now(),
                        // cumulative NetEQ counters — the concealment-ratio ground
                        // truth the recovery engine's jitter boost reacts to; null
                        // where the browser doesn't report them
                        concealedSamples: typeof report.concealedSamples === 'number' ? report.concealedSamples : null,
                        totalSamplesReceived:
                            typeof report.totalSamplesReceived === 'number' ? report.totalSamplesReceived : null,
                        // cumulative playout-buffer counters — diffed into the
                        // achieved delay that CLOSES the jitter-boost loop (did the
                        // raised target actually land?)
                        jitterBufferDelay:
                            typeof report.jitterBufferDelay === 'number' ? report.jitterBufferDelay : null,
                        jitterBufferEmittedCount:
                            typeof report.jitterBufferEmittedCount === 'number'
                                ? report.jitterBufferEmittedCount
                                : null,
                    };
                }
                return;
            }
            if (report.type === 'remote-inbound-rtp') {
                // RTCP receiver report about our (single) outbound audio track;
                // some browsers omit the field — null means "no verdict", the
                // caller must treat it as neither good nor bad
                if (typeof report.fractionLost === 'number') {
                    outboundLoss = Math.round(report.fractionLost * 1000) / 10;
                    // report identity: RRs repeat across path polls (audio's
                    // reporting interval can exceed the 5s cadence) — a stale
                    // read must not double-feed the caller's loss streaks
                    outboundTs = typeof report.timestamp === 'number' ? report.timestamp : null;
                }
                // the peer's view of our stream's jitter — the outbound twin
                // of the inbound signal the jitter boost reacts to
                if (typeof report.jitter === 'number') outboundJitter = Math.round(report.jitter * 1000);
                return;
            }
            if (report.type === 'outbound-rtp') {
                // OUR encoder's actual output (same audio-only first-report
                // fallback as inbound): the caller diffs bytesSent into the
                // real send bitrate, and targetBitrate says whether an
                // adaptive floor (setParameters) actually landed — the one
                // readback the loss adaptation never had
                const kind = report.kind || report.mediaType;
                if (!kind || kind === 'audio') {
                    outbound = {
                        bytesSent: report.bytesSent ?? 0,
                        timestamp: report.timestamp ?? Date.now(),
                        targetBitrate: typeof report.targetBitrate === 'number' ? report.targetBitrate : null,
                    };
                }
                return;
            }
            if (report.type !== 'candidate-pair') return;
            if (report.selected) {
                pair = report;
                return;
            }
            if (
                report.state === 'succeeded' &&
                report.nominated &&
                (!fallback || (report.lastPacketReceivedTimestamp || 0) > (fallback.lastPacketReceivedTimestamp || 0))
            ) {
                fallback = report;
            }
        });
        const inboundOut = inbound ?? null;
        if (!pair) pair = fallback;
        if (!pair)
            return {
                state,
                type: 'unknown',
                local: null,
                remote: null,
                rtt: null,
                inbound: inboundOut,
                outboundLoss,
                outboundTs,
                outboundJitter,
                outbound,
            };
        const local = candidates.get(pair.localCandidateId)?.candidateType ?? null;
        const remote = candidates.get(pair.remoteCandidateId)?.candidateType ?? null;
        const rtt = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
        // without both candidate reports the path is unproven — never claim 'p2p'
        if (!local || !remote)
            return {
                state,
                type: 'unknown',
                local,
                remote,
                rtt,
                inbound: inboundOut,
                outboundLoss,
                outboundTs,
                outboundJitter,
                outbound,
            };
        const type = local === 'relay' || remote === 'relay' ? 'relay' : 'p2p';
        return {
            state,
            type,
            local,
            remote,
            rtt,
            inbound: inboundOut,
            outboundLoss,
            outboundTs,
            outboundJitter,
            outbound,
        };
    }

    removePeer(peerId) {
        const entry = this.entries.get(peerId);
        if (!entry) return;
        clearTimeout(entry.dcTimer);
        clearTimeout(entry.renegotiateTimer);
        try {
            entry.pc.close();
        } catch {
            /* already closed */
        }
        this.entries.delete(peerId);
    }

    /**
     * Broadcast a JSON payload over every chat DataChannel (queued until open).
     * @throws {Error} 'dc-send-failed' when an open channel refused the frame
     *         (send buffer full / channel closing) OR a connecting channel's
     *         queue is over budget — callers abort multi-frame transfers
     *         instead of silently losing the remaining frames.
     */
    sendChat(payload) {
        const raw = JSON.stringify(payload);
        let failed = false;
        for (const [peerId, entry] of this.entries) {
            if (!entry.dc) continue;
            if (entry.dc.readyState === 'open') {
                try {
                    entry.dc.send(raw);
                } catch {
                    failed = true;
                }
            } else if (
                entry.dc.readyState === 'connecting' &&
                entry.queue.length < DC_QUEUE_MAX_FRAMES &&
                entry.queueBytes + raw.length <= DC_QUEUE_MAX_BYTES
            ) {
                entry.queue.push(raw);
                entry.queueBytes += raw.length;
            } else if (entry.dc.readyState === 'connecting') {
                // channel that never opens (zombie link): refuse instead of
                // buffering without bound — chat text has the server copy, but
                // a half-queued image batch would render as a corrupt transfer,
                // so the shared abort path (the throw below) is the honest move
                console.warn('[mesh] dc send queue over budget, refusing frame', peerId);
                failed = true;
            }
        }
        if (failed) throw new Error('dc-send-failed');
    }

    /** Close all peer connections but keep the instance usable (reconnect scenario). */
    clear() {
        for (const peerId of [...this.entries.keys()]) this.removePeer(peerId);
    }

    /**
     * Wait until every OPEN chat channel's SCTP buffer is below the low-water
     * mark (bounded — a stuck buffer releases the pump, sendChat's throw path
     * is the real failure mode). The image-transfer pump calls this between
     * chunk bursts: an unpaced ~1.6MB dump competes with the voice packets
     * sharing the same transport and audibly glitches the call on weak links.
     * @returns {Promise<void>}
     */
    async drainChat() {
        const deadline = Date.now() + DRAIN_MAX_MS;
        for (;;) {
            let busy = false;
            for (const entry of this.entries.values()) {
                if (entry.dc?.readyState === 'open' && entry.dc.bufferedAmount > DC_BUFFER_LOW) busy = true;
            }
            if (!busy || Date.now() >= deadline) return;
            await new Promise((resolve) => setTimeout(resolve, DRAIN_WAIT_MS));
        }
    }

    close() {
        this.clear();
        this.localStream = null;
    }

    _addLocalTracks(entry) {
        if (!this.localStream || entry.tracksAdded) return;
        entry.tracksAdded = true;
        for (const track of this.localStream.getTracks()) {
            entry.pc.addTrack(track, this.localStream);
        }
        this._applySendBitrate(entry);
    }

    /** Stamp the configured Opus fmtp caps onto a description we are about to
     *  set as LOCAL (offer or answer) — see mungeOpusFmtp for the semantics. */
    _mungeLocalSdp(desc) {
        const fmtp = this.getOpusFmtp?.();
        if (fmtp && desc?.sdp) desc.sdp = mungeOpusFmtp(desc.sdp, fmtp);
    }

    /**
     * Codec preference for the audio transceivers of a connection, applied
     * before every offer/answer this side generates: speech mode (fmtp dict
     * carries usedtx=1 — the same signal the loss adaptation gates on) puts
     * audio/red first for packet-level redundancy; every other mode restores
     * the browser's default order so music/share bandwidth isn't doubled.
     * Re-running at each SDP round keeps a mid-call mode toggle honest — the
     * renegotiation it already triggers reorders codecs both ways. Browsers
     * without transceiver.setCodecPreferences or without audio/red in their
     * capabilities are silently left on defaults.
     */
    _preferCodecs(pc) {
        for (const transceiver of pc.getTransceivers()) {
            const kind = transceiver.sender?.track?.kind || transceiver.receiver?.track?.kind;
            if (kind !== 'audio' || typeof transceiver.setCodecPreferences !== 'function') continue;
            try {
                const codecs = RTCRtpReceiver?.getCapabilities?.('audio')?.codecs;
                if (!Array.isArray(codecs) || !codecs.length) continue;
                if (this.getOpusFmtp?.()?.usedtx === 1) {
                    const red = redFirstCodecs(codecs);
                    if (red !== codecs) transceiver.setCodecPreferences(red); // no red → leave untouched
                } else {
                    // restore the browser's default order by handing back the
                    // UNTOUCHED capability list (it IS that order) — the spec's
                    // undefined/empty-list resets are newer surface some engines
                    // reject, and a swallowed refusal here would strand a
                    // speech→music toggle on RED's doubled bandwidth
                    transceiver.setCodecPreferences(codecs);
                }
            } catch {
                /* invalid preference (apt chain the browser rejects): defaults stay */
            }
        }
    }

    /** Whether OUR negotiated audio section leads with audio/red — i.e. the
     *  encoder actually wraps packets in redundancy (Chrome lists red in the
     *  m-line by default; only when it is the FIRST payload does the sender
     *  use it. getStats' outbound codecId misleadingly reports the wrapped
     *  opus — bytes-per-packet ~2× the cap is the wire-level tell). */
    redNegotiated(peerId) {
        const sdp = this.entries.get(peerId)?.pc.localDescription?.sdp;
        if (typeof sdp !== 'string') return null;
        let firstPayload = null; // first payload type of the audio section
        for (const line of sdp.split(/\r?\n/)) {
            if (line.startsWith('m=audio')) {
                firstPayload = line.split(' ')[3] ?? null;
            } else if (line.startsWith('m=')) {
                if (firstPayload !== null) break; // audio section ended without a red rtpmap
            } else if (firstPayload !== null && new RegExp(`^a=rtpmap:${firstPayload} red/`).test(line)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Push the effective send bitrate onto a connection's audio sender via
     * setParameters — takes effect WITHOUT a renegotiation. The value is the
     * configured fmtp cap, or a temporary loss-driven floor the recovery
     * engine placed on this link (see setPeerBitrateFloor).
     */
    _applySendBitrate(entry) {
        const maxBitrate = entry.bitrateFloor || this.getOpusFmtp?.()?.maxaveragebitrate;
        if (!maxBitrate) return;
        const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = maxBitrate;
            sender.setParameters(params).catch(() => {
                /* browser refuses audio setParameters — the fmtp cap still applies */
            });
        } catch {
            /* get/setParameters unsupported for audio — nothing to do */
        }
    }

    /**
     * Temporary per-link send-bitrate floor, set by the recovery engine when
     * the peer's receiver report shows sustained outbound loss (a smaller
     * offered load helps congestion even though Opus sits near its cap).
     * Pass null to lift the floor and re-apply the configured cap.
     * @param {string} peerId
     * @param {?number} bps floor in bit/s, or null
     */
    setPeerBitrateFloor(peerId, bps) {
        const entry = this.entries.get(peerId);
        if (!entry) return;
        entry.bitrateFloor = bps || null;
        this._applySendBitrate(entry);
    }

    /**
     * Re-apply the configured send bitrate on every live connection. A user
     * action (slider / mode toggle) — any adaptive floor is dropped in its favor.
     */
    setSendBitrate() {
        for (const entry of this.entries.values()) {
            entry.bitrateFloor = null;
            this._applySendBitrate(entry);
        }
    }

    /**
     * Receive-side playout smoothing for one link: raise the audio jitter
     * buffer target while the path poll sees sustained jitter/loss, drop back
     * to the browser's adaptive default (null) once it settles. Feature-detected
     * — browsers without receiver buffer control are left on their defaults.
     * @param {string} peerId
     * @param {?number} ms target depth in milliseconds, or null for browser auto
     */
    setPeerJitterTarget(peerId, ms) {
        const entry = this.entries.get(peerId);
        if (!entry || entry.jitterTarget === ms) return;
        for (const receiver of entry.pc.getReceivers()) {
            if (receiver.track?.kind !== 'audio') continue;
            this._applyJitterTarget(receiver, ms);
        }
        entry.jitterTarget = ms;
    }

    /**
     * Re-stamp the adaptive link state (send-bitrate cap/floor + jitter-buffer
     * target) after every SDP round: a negotiation that rewrites the audio
     * section can drop sender encoding params and receiver buffer hints, and
     * this app generates plenty of renegotiations an otherwise healthy link
     * would never see (recovery restarts, relay re-punches, mode switches) —
     * each one silently resetting a link the adaptive engines had already
     * tuned back to browser defaults. rebuildPeer carries the state across a
     * PC swap; this is the same insurance for the plain re-offer paths.
     */
    _restampAdaptiveState(entry) {
        this._applySendBitrate(entry);
        if (entry.jitterTarget === null || entry.jitterTarget === undefined) return;
        for (const receiver of entry.pc.getReceivers()) {
            if (receiver.track?.kind !== 'audio') continue;
            this._applyJitterTarget(receiver, entry.jitterTarget);
        }
    }

    /** Push a playout-buffer target onto ONE receiver — feature-detected. */
    _applyJitterTarget(receiver, ms) {
        try {
            if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
            else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = ms;
        } catch {
            /* refusal keeps the browser default for this receiver */
        }
    }

    _attachChat(peerId, entry, dc) {
        clearTimeout(entry.dcTimer); // a peer-recreated channel just landed
        entry.dc = dc;
        dc.onopen = () => {
            const queued = entry.queue.splice(0);
            entry.queueBytes = 0;
            for (const item of queued) {
                if (dc.readyState === 'open') dc.send(item);
            }
        };
        dc.onmessage = (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            if (this.handlers.onChat) this.handlers.onChat(peerId, data);
        };
        dc.onclose = () => {
            if (entry.dc === dc) entry.dc = null;
            // PC alive but SCTP dead (rare transport reset): chat and image
            // transfer would silently die while voice keeps flowing, and the
            // recovery ladder only watches connectionState. Give a recreating
            // peer a moment to land its own channel, then rebuild ours — the
            // renegotiation that follows re-establishes it on both ends.
            if (entry.pc.connectionState !== 'connected' || this.entries.get(peerId) !== entry) return;
            clearTimeout(entry.dcTimer);
            entry.dcTimer = setTimeout(() => {
                if (entry.dc || entry.pc.connectionState !== 'connected' || this.entries.get(peerId) !== entry) return;
                console.warn('[mesh] chat channel died on a live link, renegotiating', peerId);
                this._attachChat(peerId, entry, entry.pc.createDataChannel(CHAT_DC_LABEL));
            }, 1000);
        };
    }
}
