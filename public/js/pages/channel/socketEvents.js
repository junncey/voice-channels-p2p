/*
Socket event wiring — maps every socket.io event of the signaling protocol
onto page actions, plus the scroll-up pagination for the persisted chat
history (cursor = ts of the oldest row we already have; the server replays
the newest page on every join, older pages are pulled via chatPage acks).

Lives at module scope (not inside a page controller): bindHistoryPaging()
binds the scroll listener in boot() before the socket handlers are wired.
Shared page state arrives via the `s` accessor object, cross-module calls
via the late-bound `x` surface (both owned by channel.js); member-list
helpers through `mem`, recovery through `rec`.
*/

export function createSocketEvents({
    s,
    x,
    rec,
    mem,
    members,
    avatars,
    peerVolumes,
    channelId,
    NICK_KEY,
    AVATAR_MAX_CHARS,
    DATA_URL_RE,
    validReply,
    screenLock,
    playSound,
    toast,
    t,
    $,
}) {
    // the server replays the persisted chat history on EVERY join (reconnects
    // included) — only the first block of a page load is ever rendered
    let chatHistorySeen = false;
    // scroll-up pagination for that history: cursor = ts of the oldest row we
    // already have, hasMore mirrors the server's report, loading guards the
    // single in-flight chatPage request
    let historyCursor = null;
    let historyHasMore = false;
    let historyLoading = false;
    // mirror of chat.js nearBottom(): fetch one page before hitting the top
    const CHAT_LOAD_THRESHOLD = 80;

    // transport-level drops (VPN switch, network flap) usually reconnect within a
    // couple of seconds — hold the "disconnected" toast until it sticks
    const DISCONNECT_TOAST_MS = 3000;
    let disconnectToastTimer = null;

    /** Server history rows -> renderable rows (shared by join + paging). */
    function parseHistoryRows(messages) {
        const rows = [];
        for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;
            const name = String(msg.name || '?').slice(0, 24);
            let text = typeof msg.text === 'string' ? msg.text : '';
            const imgs = Array.isArray(msg.imgs) ? msg.imgs : []; // prependHistory re-validates each URL
            // legacy rows (≤ voice.21) kept only the image count — show it as a placeholder
            const legacyCount = Number.isInteger(msg.imgs) && msg.imgs > 0 ? msg.imgs : 0;
            if (legacyCount) text = [text, `[${t('chat.image')}×${legacyCount}]`].filter(Boolean).join(' ');
            if (!text && !imgs.length && msg.deleted !== true) continue;
            const ts = typeof msg.ts === 'number' && msg.ts > 0 ? msg.ts : 0;
            const reply = validReply(msg.reply);
            const deleted = msg.deleted === true;
            const reactions =
                msg.reactions && typeof msg.reactions === 'object' && !Array.isArray(msg.reactions)
                    ? msg.reactions
                    : null;
            rows.push({
                name,
                text,
                imgs: deleted ? [] : imgs,
                reply,
                deleted,
                edited: msg.edited === true,
                reactions,
                self: name === s.selfName,
                time: ts ? new Date(ts) : new Date(),
            });
        }
        return rows;
    }

    function bindHistoryPaging(box) {
        box.addEventListener('scroll', maybeLoadOlder, { passive: true });
    }

    /** Fire a page fetch whenever the list is scrolled near its top. */
    function maybeLoadOlder() {
        if (!s.socket || !historyHasMore || historyLoading) return;
        const box = $('#chatMessages');
        if (!box || box.scrollTop > CHAT_LOAD_THRESHOLD) return;
        loadOlderPage();
    }

    function loadOlderPage() {
        if (historyLoading || !historyHasMore) return;
        historyLoading = true;
        s.chat.setHistoryFooter('loading');
        // ack keeps request and response paired; the timeout un-sticks the
        // flag when the answer never comes so a later scroll can retry
        s.socket.timeout(8000).emit('chatPage', { room_id: channelId, before: historyCursor ?? 0 }, (err, res) => {
            historyLoading = false;
            s.chat.setHistoryFooter(null);
            if (err) return;
            const messages = Array.isArray(res?.messages) ? res.messages : [];
            historyHasMore = res?.hasMore === true;
            if (messages.length) {
                const first = messages[0]; // oldest of the page, again
                if (first && typeof first.ts === 'number' && first.ts > 0) historyCursor = first.ts;
                s.chat.prependHistory(parseHistoryRows(messages), { imageAlt: t('chat.image') });
            }
            if (historyHasMore)
                maybeLoadOlder(); // viewport may still not be full
            else s.chat.setHistoryFooter('end');
        });
    }

    function emitJoin() {
        s.socket.emit('join', {
            channel: channelId,
            peer_uuid: s.selfUuid,
            peer_name: s.selfName,
            peer_token: s.hostToken || undefined,
            channel_password: s.channelPassword || undefined,
            peer_audio: x.onAir(),
        });
    }

    function peerIdSafe(id) {
        return typeof id === 'string' ? id : '';
    }

    function registerSocketHandlers() {
        const socket = s.socket;

        socket.on('connect', () => {
            // back within the flap window — the "disconnected" toast never fired
            clearTimeout(disconnectToastTimer);
            disconnectToastTimer = null;
            emitJoin();
        });

        socket.on('serverInfo', (cfg) => {
            // a successful (re)join resolves any pending self-reconnect
            rec.markSessionRestored();
            if (!s.joined) {
                s.joined = true;
                rec.startRecoveryScan();
                rec.startPathMonitor();
                screenLock.sync();
                s.isPresenter = !!cfg.is_presenter;
                s.joinLockOn = !!cfg.join_locked;
                $('#joinOverlay').classList.add('hidden');
                x.updateHeaderActions();
                mem.syncMembers(cfg.peers || {});
                s.chat.add({ text: t('chat.joined', { name: s.selfName }), system: true, self: true });
                x.syncPttHoldButton();
                x.applyDeafenState(); // reflects the (session-local) state on the fresh member card
                // password accepted — keep it for the next auto-join
                if (s.channelPassword) x.saveChannelPw(s.channelPassword);
                // tell everyone in the room which avatar we carry (peers list only
                // flows joiner <- room, this is the joiner -> room direction)
                if (s.selfAvatar) socket.emit('peerAvatar', { room_id: channelId, avatar: s.selfAvatar });
            } else {
                s.isPresenter = !!cfg.is_presenter;
                s.joinLockOn = !!cfg.join_locked;
                x.updateHeaderActions();
            }
            mem.updateOnlineCount();
        });

        socket.on('chatAck', ({ ts } = {}) => {
            // server-assigned timestamp for the row we rendered optimistically —
            // without it edit/recall/reaction would look up a ts nobody else has
            s.chat.bindServerTs(ts);
        });

        socket.on('chatHistory', (cfg) => {
            // reconnect replays are ignored: the live DOM already holds the
            // recent context, rendering again would duplicate every row
            if (chatHistorySeen) return;
            chatHistorySeen = true;
            // newest page of the persisted history; older pages are pulled on
            // demand when the user scrolls to the top
            historyHasMore = cfg?.hasMore === true;
            const messages = Array.isArray(cfg?.messages) ? cfg.messages : [];
            const first = messages[0]; // server sends oldest first
            if (first && typeof first.ts === 'number' && first.ts > 0) historyCursor = first.ts;
            const rows = parseHistoryRows(messages);
            if (!rows.length) return;
            s.chat.addHistory(rows, { dividerText: t('chat.historyDivider'), imageAlt: t('chat.image') });
            maybeLoadOlder(); // keep going while the viewport isn't filled yet
        });

        socket.on('addPeer', (cfg) => {
            const known = s.mesh.entries.has(cfg.peer_id);
            s.mesh.addPeer(cfg.peer_id, cfg.should_create_offer, cfg.iceServers || []);
            mem.syncMembers(cfg.peers || {});
            // should_create_offer=false means: WE are the old member and someone
            // else just joined — announce them (the joiner gets one event per
            // existing member and must not re-announce everyone). rejoin=true is
            // a resumed session coming back from a network flap: its card never
            // left, no announcement, no sound.
            if (s.joined && cfg.should_create_offer === false && !cfg.rejoin) {
                const name = members.get(cfg.peer_id)?.peer_name || '';
                if (name) s.chat.add({ text: t('chat.joined', { name }), system: true });
                playSound('peerJoin');
            }
            // resumed session with an existing (possibly broken) link: the mesh
            // entry was reused so NO offer went out — put the recovery ladder on
            // it now instead of waiting for the next 10s scan
            if (known && cfg.should_create_offer === true) {
                const state = s.mesh.entries.get(cfg.peer_id)?.pc.connectionState;
                if (state && state !== 'connected' && state !== 'closed') rec.notePeerState(cfg.peer_id, state);
            }
            mem.updateOnlineCount();
        });

        socket.on('removePeer', ({ peer_id }) => {
            const name = members.get(peer_id)?.peer_name || '';
            mem.dropPeer(peerIdSafe(peer_id));
            if (s.joined && name) {
                s.chat.add({ text: t('chat.left', { name }), system: true });
                playSound('peerLeave');
            }
            mem.updateOnlineCount();
        });

        socket.on('iceCandidate', (cfg) => s.mesh.handleIceCandidate(cfg));
        socket.on('sessionDescription', (cfg) => s.mesh.handleSessionDescription(cfg));

        // message lifecycle — the server broadcasts the persisted result to
        // everyone (sender included), so the DOM follows the store
        socket.on('chatEdit', (cfg) => {
            if (Number.isFinite(cfg?.ts))
                s.chat.editMessage({
                    name: String(cfg.name || '').slice(0, 24),
                    ts: cfg.ts,
                    text: String(cfg.text || ''),
                });
        });
        socket.on('chatDelete', (cfg) => {
            if (Number.isFinite(cfg?.ts))
                s.chat.deleteMessage({ name: String(cfg.name || '').slice(0, 24), ts: cfg.ts });
        });
        socket.on('chatReact', (cfg) => {
            if (Number.isFinite(cfg?.ts))
                s.chat.reactMessage({
                    name: String(cfg.name || '').slice(0, 24),
                    ts: cfg.ts,
                    reactions: cfg.reactions,
                });
        });

        socket.on('peerStatus', ({ peer_id, element, status }) => {
            if (element === 'audio') {
                const member = members.get(peer_id);
                if (!member) return;
                member.peer_audio_status = status === true;
                mem.updateMicIconNode(peer_id, status === true);
                return;
            }
            if (element === 'deafen') {
                const member = members.get(peer_id);
                if (!member) return;
                member.peer_deafen = status === true;
                const node = $(`#memberList .member[data-id="${peer_id}"] .member-deafen`);
                if (node) node.classList.toggle('on', status === true);
            }
            if (element === 'share') {
                const member = members.get(peer_id);
                if (!member) return;
                member.peer_share = status === true;
                const node = $(`#memberList .member[data-id="${peer_id}"] .member-share`);
                if (node) node.classList.toggle('on', status === true);
            }
        });

        socket.on('peerName', ({ peer_id, peer_name: rawName, peer_name_old }) => {
            // host-supplied: cap like the join/rename inputs so a hostile host
            // can't push an oversized string into state or localStorage
            const peer_name = String(rawName || '').slice(0, 24);
            if (!peer_name) return;
            const member = members.get(peer_id);
            const old = member?.peer_name;
            if (member && old && old !== peer_name) {
                // per-user volume memory is keyed by display name — follow the rename
                if (peerVolumes[old] !== undefined && peerVolumes[old] !== 1) {
                    x.savePeerVolume(peer_name, peerVolumes[old]);
                }
                x.savePeerVolume(old, 1); // drop the stale key
                // avatar lookup is keyed by name too — move it along
                const avatar = avatars.get(old);
                if (avatar) {
                    avatars.set(peer_name, avatar);
                    avatars.delete(old);
                }
                s.chat.renamePeer(old, peer_name);
                member.peer_name = peer_name;
                if (peerVolumes[peer_name] !== undefined) member.volume = peerVolumes[peer_name];
            } else if (member) {
                member.peer_name = peer_name;
            }
            if (peer_id === s.selfUuid) {
                // the host renamed ME — accept it and persist for the next visit
                s.selfName = peer_name;
                localStorage.setItem(NICK_KEY, peer_name);
                if (s.selfAvatar) avatars.set(s.selfName, s.selfAvatar);
                s.chat.setAvatar(s.selfName, s.selfAvatar);
                $('#nickInput').value = peer_name;
                toast(t('channel.renamedYou', { name: peer_name }), 'ok');
            } else if (s.joined && member && (peer_name_old || old)) {
                s.chat.add({
                    text: t('chat.renamed', { old: peer_name_old || old, name: peer_name }),
                    system: true,
                });
            }
            mem.renderMembers();
        });

        socket.on('peerAvatar', ({ peer_id, peer_name, avatar }) => {
            const url =
                typeof avatar === 'string' && avatar.length <= AVATAR_MAX_CHARS && DATA_URL_RE.test(avatar)
                    ? avatar
                    : '';
            const member = members.get(peerIdSafe(peer_id));
            if (member) member.avatar = url || undefined;
            if (peer_name) {
                if (url) {
                    avatars.set(peer_name, url);
                    mem.capAvatars();
                } else avatars.delete(peer_name);
                s.chat.setAvatar(peer_name, url);
            }
            mem.renderMembers();
        });

        socket.on('peerAction', ({ peer_id, peer_action }) => {
            if (peer_id === s.selfUuid && peer_action === 'muteAudio') {
                x.setMic(false);
                toast(t('channel.mutedByHost'), 'warn');
            }
        });

        socket.on('roomAction', ({ peer_name, action }) => {
            if (action === 'joinLockOn') {
                s.joinLockOn = true;
                s.chat.add({ text: t('channel.joinLockOn', { name: peer_name }), system: true });
            } else if (action === 'joinLockOff') {
                s.joinLockOn = false;
                s.chat.add({ text: t('channel.joinLockOff', { name: peer_name }), system: true });
            }
            x.updateHeaderActions();
        });

        socket.on('kickOut', (cfg) => {
            x.teardown();
            // host ejection vs. the admin deleting the room under our feet
            x.showJoinFatal(cfg?.reason === 'channelDeleted' ? t('channel.channelDeleted') : t('channel.kicked'));
        });

        socket.on('channelNotFound', () => x.showJoinFatal(t('channel.errors.channelNotFound')));
        socket.on('roomIsBusy', (cfg) =>
            x.showJoinError(t('channel.errors.roomIsBusy', { n: cfg?.maxParticipants || 0 }))
        );
        socket.on('roomIsJoinLocked', () => x.showJoinError(t('channel.errors.roomIsJoinLocked')));
        socket.on('roomIsLocked', () => x.showJoinError(t('channel.errors.roomIsLocked')));
        socket.on('tempRoomLimitReached', (cfg) =>
            x.showJoinError(
                cfg?.reason === 'rate-limit'
                    ? t('channel.errors.tempRateLimit')
                    : t('channel.errors.tempIpLimit', { n: cfg?.max || 0 })
            )
        );
        socket.on('channelLimitReached', (cfg) =>
            x.showJoinError(t('channel.errors.channelLimit', { n: cfg?.max || 0 }))
        );
        socket.on('channelPasswordRequired', () => {
            // wrong or missing channel password — drop the stale remembered value
            // so the overlay stays up until a correct one is entered
            x.clearChannelPw();
            s.channelPassword = '';
            x.showJoinError(t('channel.errors.passwordRequired'));
            $('#joinPasswordField').classList.remove('hidden');
            $('#channelPwInput').value = '';
            $('#channelPwInput').focus();
        });
        socket.on('unauthorized', () => {
            if (!s.hostToken) return x.showJoinError(t('channel.errors.unauthorized'));
            // persisted token no longer accepted (expired or the host was removed
            // from the channel config) — drop it and carry on as a guest
            x.clearHostToken();
            s.hostToken = '';
            $('#hostReadyHint').classList.add('hidden');
            toast(t('channel.hostTokenExpired'), 'warn');
            if (s.joined)
                emitJoin(); // reconnect of an established session: rejoin without the token
            else {
                s.socket.disconnect();
                x.join({ textOnly: false });
            }
        });
        socket.on('joinError', () => {
            // server-side fault mid-join (the handler logs the details) — the
            // session state was rolled back there, so start over cleanly
            x.showJoinError(t('channel.errors.joinFailed'));
            x.setOverlayBusy(false);
        });

        socket.on('disconnect', (reason) => {
            if (!s.joined) return;
            // The mesh and member list SURVIVE the disconnect: the server parks
            // our session as a ghost, this socket re-joins with the same
            // peer_uuid and the existing peer connections resume — they heal via
            // the ICE-restart recovery ladder instead of a full renegotiation.
            // Intentional exits (leave, kick, our own B1 rebuild, join errors)
            // tear the state down themselves before disconnecting.
            if (reason === 'io client disconnect' || rec.selfReconnecting) return;
            // brief transport flaps (VPN/accelerator switch) usually reconnect
            // within a couple of seconds — don't cry "disconnected" until it sticks
            clearTimeout(disconnectToastTimer);
            disconnectToastTimer = setTimeout(() => {
                disconnectToastTimer = null;
                if (!s.socket?.connected && s.joined) toast(t('channel.errors.disconnected'), 'warn');
            }, DISCONNECT_TOAST_MS);
        });
    }

    return {
        registerSocketHandlers,
        bindHistoryPaging,
        clearDisconnectToast: () => {
            clearTimeout(disconnectToastTimer);
            disconnectToastTimer = null;
        },
    };
}
