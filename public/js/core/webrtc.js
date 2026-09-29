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
 */

const CHAT_DC_LABEL = 'mirotalk_chat_channel';

export class Mesh {
    /**
     * @param {object}   options
     * @param {object}   options.signaling     socket.io client (needs .emit)
     * @param {object}   options.handlers      { onRemoteStream, onChat, onPeerState }
     */
    constructor({ signaling, handlers = {} }) {
        this.signaling = signaling;
        this.handlers = handlers;
        this.localStream = null;
        /** peerId -> { pc, dc, pendingIce, queue, tracksAdded, offering } */
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
     * @param {string}  peerId
     * @param {boolean} shouldCreateOffer true for the joiner side
     * @param {Array}   iceServers from the addPeer payload
     */
    addPeer(peerId, shouldCreateOffer, iceServers = []) {
        if (this.entries.has(peerId)) return;

        const pc = new RTCPeerConnection({ iceServers });
        const entry = { pc, dc: null, pendingIce: [], queue: [], tracksAdded: false, offering: false };
        this.entries.set(peerId, entry);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.signaling.emit('relayICE', { peer_id: peerId, ice_candidate: event.candidate });
            }
        };

        pc.ontrack = (event) => {
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
            this._addLocalTracks(entry); // fires negotiationneeded -> initial offer
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
                await pc.setLocalDescription(answer);
                this.signaling.emit('relaySDP', { peer_id, session_description: pc.localDescription });
            }
        } catch (err) {
            console.error('[mesh] session description failed', peer_id, err);
        }
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

    removePeer(peerId) {
        const entry = this.entries.get(peerId);
        if (!entry) return;
        try {
            entry.pc.close();
        } catch {
            /* already closed */
        }
        this.entries.delete(peerId);
    }

    /** Broadcast a JSON payload over every chat DataChannel (queued until open). */
    sendChat(payload) {
        const raw = JSON.stringify(payload);
        for (const entry of this.entries.values()) {
            if (!entry.dc) continue;
            if (entry.dc.readyState === 'open') entry.dc.send(raw);
            else if (entry.dc.readyState === 'connecting') entry.queue.push(raw);
        }
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
    }

    _attachChat(peerId, entry, dc) {
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
        };
    }
}
