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
 *  - The other side answers WITHOUT local tracks, then attaches its mic after
 *    the connection reaches 'connected' — which triggers a clean reverse
 *    renegotiation offer from a stable state.
 *  - Colliding offers (both sides recovering at once) break the tie with
 *    perfect-negotiation roles: the LOWER session uuid is impolite (keeps its
 *    offer), the higher rolls back and answers (see handleSessionDescription).
 */

const CHAT_DC_LABEL = 'mirotalk_chat_channel';

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
        /** peerId -> { pc, dc, dcTimer, pendingIce, queue, tracksAdded, offering, bitrateFloor, jitterTarget } */
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
            if (!entry.tracksAdded) continue; // will pick the current stream on connect
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
        const entry = { pc, dc: null, pendingIce: [], queue: [], tracksAdded: false, offering: false };
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
            // Answer side: attach the local mic once the link is up — this fires
            // onnegotiationneeded from a stable state and produces a reverse offer.
            if (pc.connectionState === 'connected') this._addLocalTracks(entry);
            if (this.handlers.onPeerState) this.handlers.onPeerState(peerId, pc.connectionState);
        };

        const initiateOffer = async () => {
            if (entry.offering || pc.signalingState !== 'stable') return;
            entry.offering = true;
            try {
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
            const answer = await pc.createAnswer();
            this._mungeLocalSdp(answer);
            await pc.setLocalDescription(answer);
            this.signaling.emit('relaySDP', { peer_id, session_description: pc.localDescription });
        }
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
     * @param {string} peerId
     * @returns {Promise<boolean>} true when the offer went out
     */
    async renegotiate(peerId) {
        return this._sendOffer(peerId, {});
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
            const offer = await pc.createOffer(offerOptions);
            this._mungeLocalSdp(offer);
            await pc.setLocalDescription(offer);
            this.signaling.emit('relaySDP', { peer_id: peerId, session_description: pc.localDescription });
            if (offerOptions.iceRestart) console.log('[mesh] ice restart offer sent', peerId);
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
     * @returns {Promise<?object>} { state, type, local, remote, rtt, inbound, outboundLoss } — null when the peer is unknown
     */
    async connPath(peerId) {
        const entry = this.entries.get(peerId);
        if (!entry) return null;
        const pc = entry.pc;
        const state = pc.connectionState;
        if (state !== 'connected') {
            return { state, type: 'unknown', local: null, remote: null, rtt: null, inbound: null, outboundLoss: null };
        }
        const stats = await pc.getStats();
        const candidates = new Map();
        let pair = null; // explicit selected marker (standard/Firefox)…
        let fallback = null; // …Chromium: the newest succeeded + nominated pair
        let inbound = null; // inbound audio RTP (one audio track per connection)
        let outboundLoss = null; // % of OUR stream the peer reports lost (0..1 → %)
        stats.forEach((report) => {
            if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                candidates.set(report.id, report);
                return;
            }
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                inbound = {
                    packetsLost: report.packetsLost ?? 0,
                    packetsReceived: report.packetsReceived ?? 0,
                    jitter: typeof report.jitter === 'number' ? report.jitter : null,
                    bytesReceived: report.bytesReceived ?? 0,
                    timestamp: report.timestamp ?? Date.now(),
                };
                return;
            }
            if (report.type === 'remote-inbound-rtp') {
                // RTCP receiver report about our (single) outbound audio track;
                // some browsers omit the field — null means "no verdict", the
                // caller must treat it as neither good nor bad
                if (typeof report.fractionLost === 'number') {
                    outboundLoss = Math.round(report.fractionLost * 1000) / 10;
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
            return { state, type: 'unknown', local: null, remote: null, rtt: null, inbound: inboundOut, outboundLoss };
        const local = candidates.get(pair.localCandidateId)?.candidateType ?? null;
        const remote = candidates.get(pair.remoteCandidateId)?.candidateType ?? null;
        const rtt = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
        // without both candidate reports the path is unproven — never claim 'p2p'
        if (!local || !remote) return { state, type: 'unknown', local, remote, rtt, inbound: inboundOut, outboundLoss };
        const type = local === 'relay' || remote === 'relay' ? 'relay' : 'p2p';
        return { state, type, local, remote, rtt, inbound: inboundOut, outboundLoss };
    }

    removePeer(peerId) {
        const entry = this.entries.get(peerId);
        if (!entry) return;
        clearTimeout(entry.dcTimer);
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
     *         (send buffer full / channel closing) — callers abort multi-frame
     *         transfers instead of silently losing the remaining frames.
     */
    sendChat(payload) {
        const raw = JSON.stringify(payload);
        let failed = false;
        for (const entry of this.entries.values()) {
            if (!entry.dc) continue;
            if (entry.dc.readyState === 'open') {
                try {
                    entry.dc.send(raw);
                } catch {
                    failed = true;
                }
            } else if (entry.dc.readyState === 'connecting') entry.queue.push(raw);
        }
        if (failed) throw new Error('dc-send-failed');
    }

    /** Close all peer connections but keep the instance usable (reconnect scenario). */
    clear() {
        for (const peerId of [...this.entries.keys()]) this.removePeer(peerId);
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
