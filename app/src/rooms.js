/*
Room state + session lifecycle for the signaling server.

peers/presenters are keyed by the SESSION uuid (peer_uuid from join), not
socket.id: a page reconnecting after a network flap re-joins with the same
uuid and RESUMES its session — the other members never saw a removePeer, so
their peer connections stay alive and heal with an ICE restart instead of a
full renegotiation. Each entry carries the socket_id it is bound to.

This module owns the in-memory maps, the membership reads (public/admin peer
views), the room-scoped emit helpers, and the ghost/session lifecycle
(park → resume | expire). Stores and the audit trail are injected so it owns
no config wiring; signaling.js drives it from the socket protocol.
*/

'use strict';

const checkXSS = require('./xss.js');
const Validate = require('./validate');
const { toJson } = require('./payload');

// Abnormal disconnects (VPN/accelerator switch, Wi-Fi flap, sleep) park the
// session as a GHOST: the peers entry (and presenter role) survive a grace
// window so the same uuid can rejoin and resume. Only when the grace expires
// do the remaining members get the removePeer broadcast. Ping-timeout deaths
// were already unreachable for ~pingInterval+pingTimeout, so their window is
// shorter (the recovery ladder on the other members' side escalates into its
// own signaling reconnect long before detection+15s).
const GHOST_GRACE_MS = Number(process.env.GHOST_GRACE_MS) || 15000;
const GHOST_GRACE_LATE_MS = Number(process.env.GHOST_GRACE_LATE_MS) || 5000;

function createRooms({ channelStore, chatStore, audit, log }) {
    const channels = {}; // channelId -> { socketId: socket } (live signaling sockets)
    const sockets = {}; // socketId -> socket
    const peers = {}; // channelId -> { sessionUuid: peerInfo(+socket_id, ghost), 'lock', 'password', 'joinLock' }
    const presenters = {}; // channelId -> { sessionUuid: {peer_ip, peer_name, is_presenter} }

    const roomMetaKeys = new Set(['lock', 'password', 'joinLock']);

    const ghosts = new Map(); // ghostKey(channel, uuid) -> expiry timer

    const ghostKey = (channel, uuid) => channel + '|' + uuid;

    function getPeerCount(roomId) {
        if (!peers[roomId]) return 0;
        return Object.keys(peers[roomId]).filter((k) => !roomMetaKeys.has(k)).length;
    }

    /** Public peer list for a room, keyed by session uuid (drops the room meta
     *  keys). Ghosts stay listed: they are still members until their grace
     *  expires, and dropping them here would make every live client's member
     *  reconciliation tear down the very peer connection a resume would heal. */
    function getRoomPeers(roomId) {
        const room = peers[roomId] || {};
        const list = {};
        for (const [uuid, info] of Object.entries(room)) {
            if (roomMetaKeys.has(uuid)) continue;
            list[uuid] = {
                peer_name: info.peer_name,
                peer_presenter: !!info.peer_presenter,
                peer_audio: !!info.peer_audio,
                peer_audio_status: !!info.peer_audio_status,
                peer_deafen: !!info.peer_deafen,
                peer_share: !!info.peer_share,
                peer_avatar: info.peer_avatar || null,
                joined_at: info.joined_at,
            };
        }
        return list;
    }

    /** Admin view of a room's membership: who is in, since when, in which state
     *  (ghost = abnormally disconnected, still inside its resume grace window). */
    function getRoomMembers(roomId) {
        const room = peers[roomId];
        if (!room) return [];
        return Object.entries(room)
            .filter(([uuid]) => !roomMetaKeys.has(uuid))
            .map(([uuid, info]) => ({
                uuid,
                name: info.peer_name,
                presenter: !!info.peer_presenter,
                audio: !!info.peer_audio_status,
                ghost: !!info.ghost,
                joined_at: info.joined_at || 0,
            }))
            .sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0));
    }

    /**
     * Check if a session uuid is a joined member of the given room. Ghosts count
     * as members — they are still inside their grace window.
     */
    function isPeerInRoom(room_id, peer_uuid) {
        if (!room_id || !peer_uuid || !Object.hasOwn(peers, room_id)) return false;
        // room meta keys ('lock'/'password'/'joinLock') are never members
        return Object.hasOwn(peers[room_id], peer_uuid) && !roomMetaKeys.has(peer_uuid);
    }

    /**
     * The sender's session uuid in a room, when the sender has actually joined
     * it (server-side state — clients cannot claim another session's identity).
     */
    function roomSessionUuid(socket, roomId) {
        const uuid = socket.channels?.[roomId]?.uuid;
        return uuid && isPeerInRoom(roomId, uuid) ? uuid : null;
    }

    /**
     * Shared preamble of the room-scoped socket handlers: sanitize the payload
     * (callers carrying fields that must stay raw — images, emoji — opt out and
     * sanitize their text fields individually), drop malformed packets, and
     * resolve the sender's joined-session uuid for the room the packet names.
     * Returns null when the packet must be dropped silently.
     */
    function roomSender(socket, raw, { sanitize = true } = {}) {
        const config = sanitize ? checkXSS(raw) : raw;
        if (!Validate.isValidData(config)) return null;
        const senderUuid = roomSessionUuid(socket, config.room_id);
        return senderUuid ? { config, senderUuid } : null;
    }

    /**
     * First room shared by the sender and the target session uuid (relay gate:
     * a socket can only signal peers it joined with). Null when unrelated.
     */
    function sharedRoom(socket, peerUuid) {
        if (!peerUuid || typeof peerUuid !== 'string') return null;
        for (const channel of Object.keys(socket.channels || {})) {
            if (isPeerInRoom(channel, peerUuid)) return channel;
        }
        return null;
    }

    /** Live socket of a session uuid in a room — null for ghosts / dead sockets. */
    function liveSessionSocket(channel, peerUuid) {
        if (!isPeerInRoom(channel, peerUuid)) return null;
        const sock = sockets[peers[channel][peerUuid].socket_id];
        return sock && sock.connected ? sock : null;
    }

    /** Send async data to all peers in the same room except yourself */
    async function sendToRoom(room_id, socket_id, msg, config = {}) {
        // Object.hasOwn keeps inherited keys ('constructor' etc.) out of the lookup
        const room = room_id && Object.hasOwn(channels, room_id) ? channels[room_id] : {};
        for (const [peer_id, sock] of Object.entries(room)) {
            if (peer_id != socket_id) {
                sock.emit(msg, config);
            }
        }
    }

    /** Send async data to EVERY member of a room, sender included — used by
     * chat lifecycle events (edit/recall/react) where the sender's DOM must
     * follow the server-persisted result like everyone else's. */
    async function broadcastToRoom(room_id, msg, config = {}) {
        for (const sock of Object.values(channels[room_id] || {})) {
            sock.emit(msg, config);
        }
    }

    /** Send async data to specified peer */
    async function sendToPeer(peer_id, sockets, msg, config = {}) {
        if (peer_id && Object.hasOwn(sockets, peer_id)) {
            sockets[peer_id].emit(msg, config);
        }
    }

    /**
     * Park an abnormally-disconnected session as a ghost: the peers entry (and
     * presenter role) survive the grace window while the dead socket leaves the
     * delivery maps. Members keep their peer connections — a resume inside the
     * window heals them with an ICE restart instead of a full renegotiation.
     */
    function detachAsGhost(channel, socket, reason) {
        const session = socket.channels[channel];
        const entry = session && isPeerInRoom(channel, session.uuid) ? peers[channel][session.uuid] : null;
        if (!entry) {
            // join never completed for this channel — plain removal
            return removePeerFrom(channel, socket, reason);
        }
        entry.ghost = true;
        delete channels[channel]?.[socket.id];
        const delay = reason === 'ping timeout' ? GHOST_GRACE_LATE_MS : GHOST_GRACE_MS;
        const key = ghostKey(channel, session.uuid);
        clearTimeout(ghosts.get(key));
        ghosts.set(
            key,
            setTimeout(() => expireGhost(channel, session.uuid), delay)
        );
        log.debug('[' + socket.id + '] session ghosted', { channel, reason, resume_window_ms: delay });
    }

    /** Grace expired with no resume — the session is really gone. */
    function expireGhost(channel, uuid) {
        ghosts.delete(ghostKey(channel, uuid));
        const entry = Object.hasOwn(peers, channel) ? peers[channel][uuid] : null;
        if (!entry || !entry.ghost) return;
        const socketId = entry.socket_id;
        const name = entry.peer_name;
        releaseRoomEntry(channel, uuid);
        broadcastRemovePeer(channel, uuid, socketId);
        log.info('[ghost] grace expired, session removed', { channel, uuid, name });
        audit.record('ghostExpire', { channel, name });
    }

    /**
     * Drop a session's room registration (peers/presenters) and clean up an
     * emptied room. No signaling — callers decide whether to broadcast.
     */
    function releaseRoomEntry(channel, uuid) {
        if (!Object.hasOwn(peers, channel)) return;
        try {
            delete peers[channel][uuid];
            delete presenters[channel]?.[uuid];

            if (getPeerCount(channel) === 0) {
                delete peers[channel];
                delete presenters[channel];
                delete channels[channel]; // clean up to prevent memory leaks
                // an empty temporary room is gone for good — its (memory-only)
                // chat history goes with it
                if (channelStore.removeTempIfEmpty(channel, 0)) {
                    chatStore.removeChannel(channel);
                }
            }
        } catch (err) {
            log.error('Release room entry', toJson(err));
        }
    }

    /** Broadcast removePeer for a session to everyone left in the room. */
    function broadcastRemovePeer(channel, uuid, socketId) {
        for (const [id, sock] of Object.entries(channels[channel] || {})) {
            sock.emit('removePeer', { peer_id: uuid });
            log.debug('emit removePeer [' + uuid + '] -> [' + id + ']');
        }
        if (socketId && Object.hasOwn(sockets, socketId)) {
            sockets[socketId].emit('removePeer', { peer_id: uuid });
        }
    }

    /**
     * Teardown for a session entry about to be replaced by a rejoining same-uuid
     * socket: a LIVE old socket leaves through the normal removePeer path; a
     * ghost (or already-dead socket) is expired on the spot. Used by the join
     * handler's reconciliation of a pre-existing entry and of a slot claimed by
     * a concurrent same-uuid join.
     */
    async function reapSession(channel, uuid, entry) {
        const oldSocket = sockets[entry.socket_id];
        if (oldSocket && oldSocket.connected) {
            await removePeerFrom(channel, oldSocket, 'reconnected');
            return;
        }
        clearTimeout(ghosts.get(ghostKey(channel, uuid)));
        ghosts.delete(ghostKey(channel, uuid));
        releaseRoomEntry(channel, uuid);
        broadcastRemovePeer(channel, uuid, entry.socket_id);
    }

    /**
     * Remove a socket's session from a channel: release the room entry and
     * broadcast removePeer to the room.
     * @param {string} channel channel id
     * @param {object} socket the (possibly already dead) member socket
     * @param {string} reason disconnect reason (logging only)
     */
    function removePeerFrom(channel, socket, reason = 'unknown') {
        const session = socket.channels[channel];
        if (!session) {
            return log.debug('[' + socket.id + '] [Warning] not in ', channel);
        }
        delete socket.channels[channel];
        delete channels[channel]?.[socket.id];
        clearTimeout(ghosts.get(ghostKey(channel, session.uuid)));
        ghosts.delete(ghostKey(channel, session.uuid));
        releaseRoomEntry(channel, session.uuid);
        broadcastRemovePeer(channel, session.uuid, socket.id);
        log.info('[leave] peer removed', {
            channel,
            reason,
            name: session.name,
            uuid: session.uuid,
            peers_left: getPeerCount(channel),
        });
        audit.record('leave', { channel, name: session.name, reason });
    }

    return {
        channels,
        sockets,
        peers,
        presenters,
        roomMetaKeys,
        ghosts,
        ghostKey,
        GHOST_GRACE_MS,
        GHOST_GRACE_LATE_MS,
        getPeerCount,
        getRoomPeers,
        getRoomMembers,
        isPeerInRoom,
        roomSessionUuid,
        roomSender,
        sharedRoom,
        liveSessionSocket,
        sendToRoom,
        broadcastToRoom,
        sendToPeer,
        detachAsGhost,
        expireGhost,
        releaseRoomEntry,
        broadcastRemovePeer,
        reapSession,
        removePeerFrom,
    };
}

module.exports = { createRooms, GHOST_GRACE_MS, GHOST_GRACE_LATE_MS };
