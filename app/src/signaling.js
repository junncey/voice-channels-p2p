/*
Socket.IO signaling — mesh P2P protocol core (unchanged protocol).

join → addPeer → relaySDP/relayICE → removePeer, plus the room-scoped peer
event relays. The join path enforces the session-uuid identity model and the
ghost/resume semantics implemented in rooms.js. Everything here moved out of
server.js verbatim (pure extraction — room state comes via `rooms`, chat
handlers via `chatGateway`).
*/

'use strict';

const Validate = require('./validate');
const ChannelStore = require('./channelStore');
const limits = require('./limits');
const { sanitizeExceptSecrets, toJson } = require('./payload');

// ---------------------------------------------------------------------------
// Join authentication cooldown (brute-force guard)
// ---------------------------------------------------------------------------

// Consecutive failed join authentications (invalid id, bad/missing host token,
// wrong channel or room password) per client IP. Keyed by IP, NOT socket.id:
// a reconnecting client mints a fresh socket (and a fresh counter), which made
// the old per-socket limit trivially bypassable. At JOIN_FAIL_LIMIT further
// joins from that IP are ignored for JOIN_FAIL_COOLDOWN_MS — the join path
// must not become a password brute-force oracle. The counter resets on a
// successful join; the limit sits above the old per-socket 5 so a NAT
// household collectively mistyping one password does not lock itself out.
const JOIN_FAIL_LIMIT = 10;
const JOIN_FAIL_COOLDOWN_MS = 60 * 1000;
const JOIN_FAIL_SWEEP_AT = 1024;
const joinFailures = new Map(); // normalized ip -> { count, ts } (ts = last failure)

function joinFailKey(ip) {
    // normalize so IPv6 rotation inside one /64 cannot mint fresh counters
    return ChannelStore.normalizeIp(ip) || String(ip || '');
}

function isJoinThrottled(ip) {
    const entry = joinFailures.get(joinFailKey(ip));
    if (!entry || entry.count < JOIN_FAIL_LIMIT) return false;
    // the window is measured from the last failure; once it elapses the source
    // gets a fresh attempt (a new failure re-arms the cooldown)
    return Date.now() - entry.ts < JOIN_FAIL_COOLDOWN_MS;
}

function recordJoinFailure(ip) {
    const key = joinFailKey(ip);
    const entry = joinFailures.get(key) || { count: 0, ts: 0 };
    entry.count++;
    entry.ts = Date.now();
    joinFailures.set(key, entry);
    // IPs that never come back must not accumulate forever
    if (joinFailures.size > JOIN_FAIL_SWEEP_AT) {
        const now = Date.now();
        for (const [stale, e] of joinFailures) {
            if (e.count < JOIN_FAIL_LIMIT || now - e.ts >= JOIN_FAIL_COOLDOWN_MS) joinFailures.delete(stale);
        }
    }
}

/**
 * Wire the signaling protocol onto the socket.io server. Dependencies come
 * from server.js (the assembly point): room state (`rooms`), the chat socket
 * domain (`chatGateway`), the channel/chat stores and the host-token helpers.
 */
function registerSignaling(
    io,
    {
        rooms,
        chatGateway,
        channelStore,
        chatStore,
        audit,
        log,
        channelsCfg,
        tempRoomsEnabled,
        getIceServers,
        verifyConsoleToken,
        safeEqualStrings,
        trustProxy,
    }
) {
    const {
        channels,
        sockets,
        peers,
        presenters,
        roomMetaKeys,
        ghosts,
        ghostKey,
        getPeerCount,
        getRoomPeers,
        isPeerInRoom,
        roomSessionUuid,
        roomSender,
        sharedRoom,
        liveSessionSocket,
        sendToRoom,
        sendToPeer,
        reapSession,
        releaseRoomEntry,
        broadcastRemovePeer,
        detachAsGhost,
        removePeerFrom,
    } = rooms;

    function getSocketIP(socket) {
        if (trustProxy) {
            // Node lowercases incoming header names — the camel-case lookup was
            // dead code
            const forwarded = socket.handshake.headers['x-forwarded-for'];
            if (forwarded) return forwarded.split(',')[0].trim();
        }
        return socket.handshake.address;
    }

    io.sockets.on('connect', async (socket) => {
        log.debug('[' + socket.id + '] connection accepted', {
            host: socket.handshake.headers.host.split(':')[0],
        });

        socket.channels = {};
        sockets[socket.id] = socket;

        /**
         * On peer disconnected
         */
        socket.on('disconnect', async (reason) => {
            // Intentional leaves (leave(), kickOut, admin evict, our own B1
            // rebuild) tear the session down at once. Everything else
            // (VPN/accelerator switch, network flap, sleep) becomes a ghost: the
            // session entry survives its grace window so the same uuid can
            // resume seamlessly.
            const intentional = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';
            for (const channel of Object.keys(socket.channels)) {
                if (intentional) await removePeerFrom(channel, socket, reason);
                else await detachAsGhost(channel, socket, reason);
            }
            log.debug('[' + socket.id + '] disconnected', { reason });
            delete sockets[socket.id];
            chatGateway.onDisconnect(socket);
        });

        /**
         * On peer join — channel must exist in the persistent registry.
         * Presenter rights come ONLY from a valid host JWT for this channel.
         */
        socket.on('join', async (cfg) => {
            // set once room state has been written, so the catch below can roll a
            // half-joined socket back out (and skip rollback when a concurrent
            // same-uuid join owns the slot instead)
            let claimed = null;
            const handleJoin = async () => {
                const peer_ip = getSocketIP(socket);
                // channel_password stays raw — it is hash-verified, and a sanitizer
                // would silently change the effective secret (pre-fix stored hashes
                // keep verifying via channelStore's verifyPasswordCompat fallback)
                const config = sanitizeExceptSecrets(cfg, ['channel_password']);

                if (!Validate.isValidData(config)) return;
                // never log credentials (host JWT / room password)
                const { peer_token, channel_password, ...joinLogData } = config;
                log.debug('[' + socket.id + '] join', joinLogData);

                const { channel, peer_uuid } = config;

                // Brute-force guard: a source with too many consecutive failed
                // join authentications is silently ignored for the cooldown window
                if (isJoinThrottled(peer_ip)) {
                    log.warn('[' + socket.id + '] join dropped: auth-failure cooldown', { channel });
                    return;
                }

                if (!Validate.isValidRoomName(channel) || !channelStore.isValidId(channel)) {
                    log.warn('[' + socket.id + '] invalid channel id', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('unauthorized');
                }

                // peer_uuid becomes the room-state key for this session (resume
                // matching, relay targets) — a strict uuid shape keeps it from ever
                // colliding with the room meta keys or polluting object prototypes
                if (!Validate.isValidSessionUuid(peer_uuid)) {
                    log.warn('[' + socket.id + '] invalid peer_uuid', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('unauthorized');
                }

                // The join name rides every membership broadcast — require a real
                // string and cap it like every other name path (peerName/peerRename
                // cap at PEER_NAME_MAX), so a scripted join cannot push a
                // socket-packet-sized name into room state and member cards
                if (typeof config.peer_name !== 'string' || !config.peer_name.trim()) {
                    log.warn('[' + socket.id + '] invalid peer_name', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('unauthorized');
                }
                const peer_name = config.peer_name.slice(0, limits.PEER_NAME_MAX);

                if (Object.hasOwn(socket.channels, channel)) {
                    return log.debug('[' + socket.id + '] [Warning] already joined', channel);
                }

                // one page = one channel; a socket juggling several live channels at
                // once is a scripted client, not a browser visitor (admin-tunable:
                // settings.socketMaxChannels)
                const socketMaxChannels = channelStore.settings.socketMaxChannels;
                if (Object.keys(socket.channels).length >= socketMaxChannels) {
                    log.warn('[' + socket.id + '] socket channel limit reached', {
                        channel,
                        joined: Object.keys(socket.channels),
                    });
                    return socket.emit('channelLimitReached', { max: socketMaxChannels });
                }

                // Channel must be registered — or, with temporary rooms enabled, any
                // valid id MAY become an ephemeral in-memory room. Temp creation is
                // DEFERRED until every auth check passed so a rejected join (bad
                // token/password) can never spawn (and later leak) an empty room.
                let channelDef = channelStore.get(channel);
                const wouldCreateTemp = !channelDef && tempRoomsEnabled();
                if (!channelDef && !wouldCreateTemp) {
                    log.warn('[' + socket.id + '] channel not found in registry', { channel });
                    return socket.emit('channelNotFound');
                }

                // Presenter: valid host JWT issued for THIS channel, and the host must
                // still be configured (token may predate a config change). Fallback
                // tokens (via: 'default-moderator', issued by host login for channels
                // without configured hosts) stay valid only while the channel is STILL
                // hostless and the shared default-moderator feature is enabled.
                let is_presenter = false;
                if (peer_token) {
                    const payload = verifyConsoleToken(peer_token);
                    const fallbackModeratorOk =
                        payload?.via === 'default-moderator' &&
                        Boolean(channelsCfg.defaultModerator) &&
                        channelStore.isHostless(channel);
                    if (
                        payload &&
                        payload.role === 'host' &&
                        payload.channelId === channel &&
                        payload.username &&
                        (channelStore.isHost(channel, payload.username) || fallbackModeratorOk)
                    ) {
                        is_presenter = true;
                        log.debug('[' + socket.id + '] joining as host', {
                            channel,
                            username: payload.username,
                            via: payload.via || 'configured',
                        });
                    } else {
                        log.warn('[' + socket.id + '] invalid host token for channel', { channel });
                        recordJoinFailure(peer_ip);
                        return socket.emit('unauthorized');
                    }
                }

                // Persistent channel password (set in the admin console). Hosts
                // authenticate with their own credentials and always pass. A pending
                // temp room (channelDef still null) has no password yet.
                // Verification is async (threadpool scrypt) — a wrong-password
                // join flood must not stall the event loop.
                if (
                    !is_presenter &&
                    channelDef?.passwordHash &&
                    !(await channelStore.verifyChannelPassword(channel, channel_password))
                ) {
                    log.debug('[' + socket.id + '] [Warning] channel password required/invalid', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('channelPasswordRequired');
                }

                // Session resume: a rejoin carrying the SAME peer_uuid is this page's
                // session reconnecting (each join() mints a fresh uuid). While the
                // previous socket's entry is still in its ghost grace window, REBIND
                // it to the new socket and keep the session — the other members never
                // saw a removePeer, their peer connections stay up and heal via ICE
                // restart instead of a full renegotiation. A name change or a still
                // LIVE old socket is not a resume: evict the old session and rebuild.
                // (Never matches a second tab — it would have its own uuid.)
                let is_rejoin = false;
                let resumed = false;
                let keepJoinedAt = Date.now();
                const existingEntry = Object.hasOwn(peers, channel) ? peers[channel][peer_uuid] : null;
                if (existingEntry && !roomMetaKeys.has(peer_uuid)) {
                    const nameMatches = existingEntry.peer_name === peer_name;
                    if (existingEntry.ghost && nameMatches) {
                        is_rejoin = true;
                        resumed = true;
                        keepJoinedAt = existingEntry.joined_at;
                        clearTimeout(ghosts.get(ghostKey(channel, peer_uuid)));
                        ghosts.delete(ghostKey(channel, peer_uuid));
                        delete channels[channel]?.[existingEntry.socket_id];
                        if (sockets[existingEntry.socket_id]) delete sockets[existingEntry.socket_id].channels[channel]; // dead socket bookkeeping
                        existingEntry.ghost = false;
                        existingEntry.socket_id = socket.id;
                        log.debug('[' + socket.id + '] session resumed in grace window', { channel });
                    } else {
                        is_rejoin = nameMatches; // same session returning under a live socket: capacity/lock bypass parity
                        await reapSession(channel, peer_uuid, existingEntry);
                        log.debug('[' + socket.id + '] reaped stale session on rejoin', { channel, resumed: false });
                    }
                }

                // Capacity hard check (hosts may always join to manage their channel)
                const maxParticipants = channelDef?.maxParticipants || limits.DEFAULT_MAX_PARTICIPANTS;
                if (!is_presenter && !is_rejoin && getPeerCount(channel) >= maxParticipants) {
                    log.debug('[' + socket.id + '] channel is full', {
                        channel,
                        count: getPeerCount(channel),
                        maxParticipants,
                    });
                    return socket.emit('roomIsBusy', { maxParticipants });
                }

                // Room-level locks (read before any room structure is created so a
                // rejected join never leaves an empty room behind). The room password
                // is stored verbatim by roomAction and compared verbatim here.
                const roomLocked =
                    peers[channel]?.['lock'] === true &&
                    !safeEqualStrings(peers[channel]?.['password'], channel_password);
                if (roomLocked) {
                    log.debug('[' + socket.id + '] [Warning] room is locked', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('roomIsLocked');
                }

                const isPresenterNow = is_presenter || presenters[channel]?.[peer_uuid]?.is_presenter === true;

                // Room-level join lock blocks NEW joiners only — a reconnecting
                // member (same uuid, resumed or reaped above) was already inside.
                const joinLocked = peers[channel]?.['joinLock'] === true && !is_rejoin && !isPresenterNow;
                if (joinLocked) {
                    log.debug('[' + socket.id + '] [Warning] room is join-locked', { channel });
                    return socket.emit('roomIsJoinLocked');
                }

                // Auth passed — only now materialize a pending temporary room, so a
                // rejected join never leaves one behind (getOrCreateTemp returns null
                // at the global / per-IP caps)
                if (!channelDef) {
                    if (channelStore.getTemp(channel)) {
                        // joining a room someone already spawned: no creation, no quota
                    } else {
                        const quota = channelStore.checkTempQuota(peer_ip);
                        if (!quota.ok) {
                            log.warn('[' + socket.id + '] temp room quota exceeded', { channel, reason: quota.reason });
                            return socket.emit('tempRoomLimitReached', {
                                reason: quota.reason,
                                max: channelStore.settings.tempMaxPerIp,
                            });
                        }
                        channelDef = channelStore.getOrCreateTemp(channel, { creatorIp: peer_ip });
                        if (!channelDef) {
                            log.warn('[' + socket.id + '] temp room cap reached', { channel });
                            return socket.emit('channelNotFound');
                        }
                    }
                }

                // Auth passed — safe to create the room structures now
                if (!Object.hasOwn(channels, channel)) channels[channel] = {};
                if (!Object.hasOwn(peers, channel)) peers[channel] = {};
                if (!Object.hasOwn(presenters, channel)) presenters[channel] = {};

                if (is_presenter) {
                    // keyed by session uuid: the presenter role survives reconnects
                    // (the ghost grace keeps the entry) and can only ever be held by
                    // a session that presented valid host credentials at join time
                    presenters[channel][peer_uuid] = { peer_ip, peer_name, is_presenter: true };
                    log.debug('[' + socket.id + '] joining as host', {
                        channel,
                        username: peer_name,
                    });
                }

                const isPresenter = isPresenterNow;

                peers[channel][peer_uuid] = {
                    peer_name: peer_name,
                    peer_presenter: isPresenter,
                    peer_audio: config.peer_audio === true,
                    peer_audio_status: config.peer_audio === true,
                    joined_at: keepJoinedAt,
                    socket_id: socket.id,
                    ghost: false,
                };
                claimed = { channel, uuid: peer_uuid };

                await addPeerTo(channel, socket, peer_uuid, { rejoin: resumed });

                // Same-uuid race: a concurrent join may have claimed (or reaped and
                // replaced) the slot while addPeerTo awaited. If the uuid no longer
                // points at THIS socket, the other session won — stand down without
                // touching room state. The mesh self-heals: peer connections are
                // uuid-keyed, so the winner's addPeer supersedes ours.
                if (peers[channel]?.[peer_uuid]?.socket_id !== socket.id) {
                    claimed = null;
                    log.warn('[' + socket.id + '] concurrent same-uuid join lost the race, standing down', { channel });
                    return socket.emit('kickOut', { peer_kicked_reason: 'session superseded' });
                }

                channels[channel][socket.id] = socket;
                socket.channels[channel] = { uuid: peer_uuid, name: peer_name };

                // info (not debug): membership is the one thing an operator must be
                // able to reconstruct from default logs, plus the audit trail
                log.info('[join] peer joined', {
                    channel,
                    name: peer_name,
                    uuid: peer_uuid,
                    presenter: isPresenter,
                    resumed,
                    peers: getPeerCount(channel),
                });
                audit.record('join', {
                    channel,
                    name: peer_name,
                    presenter: isPresenter,
                    resumed,
                    ip: getSocketIP(socket),
                });

                joinFailures.delete(joinFailKey(peer_ip)); // a successful join resets the failure counter

                // Catch the newcomer up on the persisted chat history BEFORE
                // serverInfo, so it renders above the "you joined" line. Emitted on
                // every (re)join — possibly empty — so the client sees exactly one
                // block per join and can ignore the replays after reconnects. Only
                // the newest page rides along; the client pulls older ones via
                // 'chatPage' when it scrolls to the top. chatStore.history() applies
                // the page-size AND payload budgets and reports hasMore.
                const chatPage = chatStore.history(channel, { persistent: !channelStore.isTemp(channel) });
                await sendToPeer(socket.id, sockets, 'chatHistory', chatPage);

                // Send room info to the joined peer
                await sendToPeer(socket.id, sockets, 'serverInfo', {
                    peers_count: getPeerCount(channel),
                    peers: getRoomPeers(channel),
                    is_presenter: isPresenter,
                    join_locked: peers[channel]['joinLock'] === true,
                    room_locked: peers[channel]['lock'] === true,
                    maxRoomParticipants: maxParticipants,
                });
            };

            try {
                await handleJoin();
            } catch (err) {
                // a failed join must never leave half-built room state behind (the
                // global unhandledRejection net only logs) — tell the client and
                // roll back whatever this join had claimed
                log.error('Join handler failed', { socket_id: socket.id, error: err.message, stack: err.stack });
                if (
                    claimed &&
                    Object.hasOwn(peers, claimed.channel) &&
                    peers[claimed.channel][claimed.uuid]?.socket_id === socket.id
                ) {
                    delete socket.channels[claimed.channel];
                    delete channels[claimed.channel]?.[socket.id];
                    releaseRoomEntry(claimed.channel, claimed.uuid);
                    broadcastRemovePeer(claimed.channel, claimed.uuid, socket.id);
                    log.warn('Join rolled back after handler error', { channel: claimed.channel, uuid: claimed.uuid });
                }
                socket.emit('joinError', { error: 'join failed' });
            }
        });

        /**
         * Relay ICE to peers (peer_id = target session uuid)
         */
        socket.on('relayICE', async (config) => {
            if (!Validate.isValidData(config)) return;
            const { peer_id, ice_candidate } = config;
            const channel = sharedRoom(socket, peer_id);
            const target = channel && liveSessionSocket(channel, peer_id);
            if (!target) return;
            target.emit('iceCandidate', {
                peer_id: socket.channels[channel].uuid,
                ice_candidate: ice_candidate,
            });
        });

        /**
         * Relay SDP to peers (peer_id = target session uuid)
         */
        socket.on('relaySDP', async (config) => {
            if (!Validate.isValidData(config)) return;
            const { peer_id, session_description } = config;
            const channel = sharedRoom(socket, peer_id);
            const target = channel && liveSessionSocket(channel, peer_id);
            if (!target) return;
            log.debug('[' + socket.id + '] relay SessionDescription to [' + peer_id + ']', {
                type: session_description.type,
            });
            target.emit('sessionDescription', {
                peer_id: socket.channels[channel].uuid,
                session_description: session_description,
            });
        });

        /**
         * Handle Room action (presenter gated): lock/unlock/joinLock.
         * (A former `checkPassword` action was removed: nothing in the client used
         * it and it let any socket probe the room password unauthenticated.)
         */
        socket.on('roomAction', async (cfg) => {
            // the room lock password is stored/compared verbatim (memory-only, so
            // no legacy form exists) — sanitize everything EXCEPT the secret
            const config = sanitizeExceptSecrets(cfg, ['password']);
            if (!Validate.isValidData(config)) return;

            const { room_id, password, action } = config;

            // the sender must be a joined member of the room (also blocks probes
            // against arbitrary or inherited map keys)
            const senderUuid = roomSessionUuid(socket, room_id);
            if (!senderUuid) return;

            const isPresenter = presenters[room_id]?.[senderUuid]?.is_presenter === true;
            const peer_name = peers[room_id][senderUuid].peer_name;

            try {
                switch (action) {
                    case 'lock':
                        if (!isPresenter) return;
                        peers[room_id]['lock'] = true;
                        peers[room_id]['password'] = password;
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    case 'unlock':
                        if (!isPresenter) return;
                        delete peers[room_id]['lock'];
                        delete peers[room_id]['password'];
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    case 'joinLockOn':
                        if (!isPresenter) return;
                        peers[room_id]['joinLock'] = true;
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    case 'joinLockOff':
                        if (!isPresenter) return;
                        delete peers[room_id]['joinLock'];
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    default:
                        break;
                }
            } catch (err) {
                log.error('Room action', toJson(err));
            }
        });

        /**
         * Relay NAME to peers
         */
        socket.on('peerName', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_name_old } = config;
            // same 24-char cap as the join path (see handleJoin)
            const peer_name_new =
                typeof config.peer_name_new === 'string'
                    ? config.peer_name_new.slice(0, limits.PEER_NAME_MAX)
                    : config.peer_name_new;

            const entry = Object.hasOwn(peers, room_id) ? peers[room_id][senderUuid] : null;
            if (!entry) return;

            entry['peer_name'] = peer_name_new;
            if (presenters[room_id] && presenters[room_id][senderUuid]) {
                presenters[room_id][senderUuid]['peer_name'] = peer_name_new;
            }
            log.debug('[' + socket.id + '] peer profile changed', { peer_name_old, peer_name_new });

            await sendToRoom(room_id, socket.id, 'peerName', {
                peer_id: senderUuid,
                peer_name: peer_name_new,
            });
        });

        /**
         * Host renames another peer (moderation). The renamed peer receives the
         * same peerName broadcast as everyone else and accepts the new name.
         */
        socket.on('peerRename', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_id } = config;

            if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) {
                log.debug('peerRename blocked: sender is not the presenter', { room_id, socket_id: socket.id });
                return;
            }

            const name =
                typeof config.peer_name_new === 'string'
                    ? config.peer_name_new.trim().slice(0, limits.PEER_NAME_MAX)
                    : '';
            // the rename target must be a joined member of the room
            if (!name || !isPeerInRoom(room_id, peer_id)) return;

            const old = peers[room_id][peer_id]['peer_name'];
            peers[room_id][peer_id]['peer_name'] = name;
            if (presenters[room_id] && presenters[room_id][peer_id]) {
                presenters[room_id][peer_id]['peer_name'] = name;
            }
            log.info('[' + socket.id + '] host renamed peer', { room_id, peer_id, from: old, to: name });

            // everyone INCLUDING the host gets the update — the host's member list
            // and the chat notice must follow too (sendToRoom would skip the sender)
            for (const sock of Object.values(channels[room_id] || {})) {
                sock.emit('peerName', { peer_id, peer_name: name, peer_name_old: old });
            }
        });

        /**
         * Set/clear a peer's custom avatar. The data URL never goes through
         * checkXSS (DOMPurify strips data: URIs) — it is validated against a
         * strict whitelist + size cap instead, exactly like the DataChannel
         * image protocol, and is only ever rendered as an <img src>.
         */
        socket.on('peerAvatar', async (cfg) => {
            const ctx = roomSender(socket, cfg, { sanitize: false }); // data URLs never ride checkXSS
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, avatar } = config;

            const valid =
                typeof avatar === 'string' &&
                avatar.length > 0 &&
                avatar.length <= limits.AVATAR_MAX_CHARS &&
                limits.IMAGE_DATA_URL_RE.test(avatar);
            if (valid) {
                peers[room_id][senderUuid]['peer_avatar'] = avatar;
            } else {
                delete peers[room_id][senderUuid]['peer_avatar'];
            }

            const peer_name = peers[room_id][senderUuid]['peer_name'];
            log.debug('[' + socket.id + '] peer avatar ' + (valid ? 'set' : 'cleared'), { room_id });

            // everyone INCLUDING the sender — the sender's own DOM is already
            // up to date, the echo just keeps the room in lockstep
            for (const sock of Object.values(channels[room_id] || {})) {
                sock.emit('peerAvatar', {
                    peer_id: senderUuid,
                    peer_name,
                    avatar: valid ? avatar : null,
                });
            }
        });

        /**
         * Relay audio/deafen/share status to peers. 'audio' is the mic state;
         * 'deafen' marks a member who silenced ALL remote audio locally;
         * 'share' marks a member whose captured system/tab sound is mixed into
         * their outgoing stream ("listen together").
         */
        socket.on('peerStatus', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, element, status } = config;

            if (element === 'audio') peers[room_id][senderUuid]['peer_audio_status'] = status === true;
            else if (element === 'deafen') peers[room_id][senderUuid]['peer_deafen'] = status === true;
            else if (element === 'share') peers[room_id][senderUuid]['peer_share'] = status === true;
            else return;

            await sendToRoom(room_id, socket.id, 'peerStatus', {
                peer_id: senderUuid,
                peer_name: peers[room_id][senderUuid]['peer_name'],
                element,
                status: status === true,
            });
        });

        chatGateway.register(socket);

        /**
         * Relay actions to peers (presenter gated for moderation actions).
         * peer_id (when targeted) is the target's session uuid.
         */
        socket.on('peerAction', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_id, peer_action, send_to_all } = config;

            // Only the presenter may run moderation actions
            const presenterActions = ['muteAudio', 'ejectAll'];
            if (presenterActions.includes(peer_action)) {
                if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) return;
            }

            const targetName = isPeerInRoom(room_id, peer_id) ? peers[room_id][peer_id].peer_name : config.peer_name;
            const data = { peer_id, peer_name: targetName, peer_action };

            if (send_to_all) {
                await sendToRoom(room_id, socket.id, 'peerAction', data);
            } else {
                // targeted action: the target must share a room with the sender
                // (same membership gate as the SDP/ICE relay)
                const channel = sharedRoom(socket, peer_id);
                const target = channel && liveSessionSocket(channel, peer_id);
                if (!target) return;
                target.emit('peerAction', data);
            }
        });

        /**
         * Kick out peer from room (presenter only). peer_id is the TARGET's
         * session uuid; the caller's identity is the server-bound session, not
         * anything the client supplies.
         */
        socket.on('kickOut', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_id, peer_kicked_reason } = config;

            if (!isPeerInRoom(room_id, peer_id)) return;

            if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) return;

            const target = liveSessionSocket(room_id, peer_id);
            if (!target) return;
            log.info('[' + socket.id + '] kick out peer [' + peer_id + '] from room [' + room_id + ']', {
                by: peers[room_id][senderUuid].peer_name,
                target: peers[room_id][peer_id]?.peer_name,
            });
            audit.record('hostKick', {
                channel: room_id,
                by: peers[room_id][senderUuid].peer_name,
                target: peers[room_id][peer_id]?.peer_name,
                reason: peer_kicked_reason,
            });
            target.emit('kickOut', {
                peer_name: peers[room_id][senderUuid].peer_name,
                peer_kicked_reason: peer_kicked_reason,
            });
        });

        /**
         * Add peers to channel (mesh: notify every existing peer + the newcomer).
         * Peer ids are SESSION uuids — on a resume both sides already carry the
         * peer connection (the client's mesh.addPeer no-ops for known ids), so
         * this costs a sync event, not a renegotiation.
         * @param {string} channel channel id
         * @param {object} joiner the joining socket
         * @param {string} joinerUuid its session uuid
         * @param {object} [opts] { rejoin } — true suppresses the client-side join announcement
         */
        async function addPeerTo(channel, joiner, joinerUuid, { rejoin = false } = {}) {
            const roomPeers = getRoomPeers(channel);
            for (const [id, sock] of Object.entries(channels[channel] || {})) {
                if (id === joiner.id) continue; // joiner is told about everyone below
                const memberUuid = sock.channels?.[channel]?.uuid;
                if (!memberUuid || memberUuid === joinerUuid) continue;
                sock.emit('addPeer', {
                    peer_id: joinerUuid,
                    peers: roomPeers,
                    should_create_offer: false,
                    rejoin,
                    iceServers: getIceServers(),
                });
                joiner.emit('addPeer', {
                    peer_id: memberUuid,
                    peers: roomPeers,
                    should_create_offer: true,
                    rejoin,
                    iceServers: getIceServers(),
                });
                log.debug('[' + joiner.id + '] emit addPeer [' + memberUuid + ']');
            }
        }
    });
}

module.exports = { registerSignaling };
