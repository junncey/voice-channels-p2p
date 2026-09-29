/**
 * Channel page controller — voice (left) + text chat (right).
 */

import { api } from '/js/core/api.js';
import { Mesh } from '/js/core/webrtc.js';
import { AudioHub } from '/js/core/audio.js';
import { initChat } from '/js/core/chat.js';
import { initI18n, t } from '/js/core/i18n.js';
import { $, el, avatarColor, randomNick, copyText } from '/js/core/utils.js';

const NICK_KEY = 'vc_nick';
const HOST_TOKEN_PREFIX = 'vc_host_token_';

const MIC_ON_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const MIC_OFF_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 1.16-.29 2.26-.8 3.22"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const LOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const UNLOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const channelId = (() => {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'c' ? decodeURIComponent(parts[1] || '') : '';
})();

let channelMeta = null;
let socket = null;
let mesh = null;
let hub = null;
let chat = null;

let selfName = '';
let selfUuid = null;
let joined = false;
let textOnly = false;
let micOn = false;
let isPresenter = false;
let joinLockOn = false;
let localStream = null;
let hostToken = sessionStorage.getItem(HOST_TOKEN_PREFIX + channelId) || '';

/** peerId -> { peer_name, peer_presenter, peer_audio_status, joined_at, self } */
const members = new Map();
const audioEls = new Map(); // peerId -> HTMLAudioElement

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

boot();

async function boot() {
    if (!channelId) {
        location.replace('/');
        return;
    }

    await initI18n();
    chat = initChat($('#chatMessages'), { emptyText: t('chat.empty') });
    bindUi();

    try {
        channelMeta = await api.getChannel(channelId);
    } catch {
        showJoinFatal(t('channel.errors.channelNotFound'));
        return;
    }

    $('#channelName').textContent = channelMeta.name || channelId;
    $('#channelDesc').textContent = channelMeta.description || '';
    $('#joinChannelName').textContent = `# ${channelMeta.name || channelId}`;
    document.title = `${channelMeta.name || channelId} · ${t('app.name')}`;

    const presetName = new URLSearchParams(location.search).get('name');
    $('#nickInput').value = presetName || localStorage.getItem(NICK_KEY) || randomNick(t('channel.guest'));
    if (hostToken) $('#hostReadyHint').classList.remove('hidden');

    $('#nickInput').focus();
    $('#nickInput').select();
    $('#nickInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') join({ textOnly: false });
    });
}

function bindUi() {
    $('#backBtn').addEventListener('click', () => (location.href = '/'));
    $('#joinBtn').addEventListener('click', () => join({ textOnly: false }));
    $('#textOnlyBtn').addEventListener('click', () => join({ textOnly: true }));

    $('#hostLoginBtn').addEventListener('click', openHostModal);
    $('#hostCancelBtn').addEventListener('click', closeHostModal);
    $('#hostLoginForm').addEventListener('submit', onHostLoginSubmit);

    $('#copyLinkBtn').addEventListener('click', async () => {
        const ok = await copyText(`${location.origin}/c/${channelId}`);
        if (ok) toast(t('channel.copied'), 'ok');
    });

    $('#leaveBtn').addEventListener('click', leave);
    $('#micBtn').addEventListener('click', onMicBtnClick);
    $('#chatForm').addEventListener('submit', onChatSubmit);

    $('#lockBtn').addEventListener('click', () => {
        if (!socket || !joined || !isPresenter) return;
        const action = joinLockOn ? 'joinLockOff' : 'joinLockOn';
        // The room broadcast excludes the sender, so reflect the new state locally at once
        joinLockOn = action === 'joinLockOn';
        updateHeaderActions();
        chat.add({ text: t(`channel.${action}`, { name: selfName }), system: true });
        socket.emit('roomAction', {
            room_id: channelId,
            peer_name: selfName,
            peer_uuid: selfUuid,
            action,
        });
    });

    window.addEventListener('beforeunload', () => {
        socket?.disconnect();
        teardownMedia();
    });
}

// ---------------------------------------------------------------------------
// join flow
// ---------------------------------------------------------------------------

async function join({ textOnly: asTextOnly }) {
    const nick = $('#nickInput').value.trim().slice(0, 24);
    if (!nick) return showJoinError(t('channel.errors.nickRequired'));

    selfName = nick;
    selfUuid = crypto.randomUUID();
    localStorage.setItem(NICK_KEY, nick);
    textOnly = asTextOnly;

    if (!textOnly) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
        } catch {
            textOnly = true;
            toast(t('channel.errors.micDenied'), 'warn');
        }
    }
    if (localStream) localStream.getTracks().forEach((track) => (track.enabled = true));

    hub = new AudioHub();
    try {
        await hub.ensureContext();
    } catch {
        /* speaking indicators degrade to off, voice still works */
    }
    if (localStream && hub.ctx) {
        hub.watch('self', localStream, ({ level }) => {
            $('#micLevelBar').style.width = `${Math.min(100, Math.round(level * 220))}%`;
        });
    }

    socket = io({ transports: ['websocket'] });
    mesh = new Mesh({ signaling: socket, handlers: meshHandlers() });
    if (localStream) mesh.setLocalStream(localStream);

    registerSocketHandlers();

    setOverlayBusy(true);
    micOn = !textOnly && !!localStream;
    updateVoiceControls();
}

function registerSocketHandlers() {
    socket.on('connect', () => {
        socket.emit('join', {
            channel: channelId,
            peer_uuid: selfUuid,
            peer_name: selfName,
            peer_token: hostToken || undefined,
            peer_audio: !textOnly,
        });
    });

    socket.on('serverInfo', (cfg) => {
        if (!joined) {
            joined = true;
            isPresenter = !!cfg.is_presenter;
            joinLockOn = !!cfg.join_locked;
            $('#joinOverlay').classList.add('hidden');
            updateHeaderActions();
            syncMembers(cfg.peers || {});
            chat.add({ text: t('chat.joined', { name: selfName }), system: true, self: true });
        } else {
            isPresenter = !!cfg.is_presenter;
            joinLockOn = !!cfg.join_locked;
            updateHeaderActions();
        }
        updateOnlineCount();
    });

    socket.on('addPeer', (cfg) => {
        mesh.addPeer(cfg.peer_id, cfg.should_create_offer, cfg.iceServers || []);
        syncMembers(cfg.peers || {});
        // should_create_offer=false means: WE are the old member and someone
        // else just joined — announce them (the joiner gets one event per
        // existing member and must not re-announce everyone).
        if (joined && cfg.should_create_offer === false) {
            const name = members.get(cfg.peer_id)?.peer_name || '';
            if (name) chat.add({ text: t('chat.joined', { name }), system: true });
        }
        updateOnlineCount();
    });

    socket.on('removePeer', ({ peer_id }) => {
        const name = members.get(peer_id)?.peer_name || '';
        dropPeer(peerIdSafe(peer_id));
        if (joined && name) chat.add({ text: t('chat.left', { name }), system: true });
        updateOnlineCount();
    });

    socket.on('iceCandidate', (cfg) => mesh.handleIceCandidate(cfg));
    socket.on('sessionDescription', (cfg) => mesh.handleSessionDescription(cfg));

    socket.on('peerStatus', ({ peer_id, element, status }) => {
        if (element !== 'audio') return;
        const member = members.get(peer_id);
        if (!member) return;
        member.peer_audio_status = status === true;
        renderMembers();
    });

    socket.on('peerName', ({ peer_id, peer_name }) => {
        const member = members.get(peer_id);
        if (member && peer_name) {
            member.peer_name = peer_name;
            renderMembers();
        }
    });

    socket.on('peerAction', ({ peer_id, peer_action }) => {
        if (peer_id === socket.id && peer_action === 'muteAudio') {
            setMic(false);
            toast(t('channel.mutedByHost'), 'warn');
        }
    });

    socket.on('roomAction', ({ peer_name, action }) => {
        if (action === 'joinLockOn') {
            joinLockOn = true;
            chat.add({ text: t('channel.joinLockOn', { name: peer_name }), system: true });
        } else if (action === 'joinLockOff') {
            joinLockOn = false;
            chat.add({ text: t('channel.joinLockOff', { name: peer_name }), system: true });
        }
        updateHeaderActions();
    });

    socket.on('kickOut', () => {
        teardown();
        showJoinFatal(t('channel.kicked'));
    });

    socket.on('channelNotFound', () => showJoinFatal(t('channel.errors.channelNotFound')));
    socket.on('roomIsBusy', (cfg) => showJoinError(t('channel.errors.roomIsBusy', { n: cfg?.maxParticipants || 0 })));
    socket.on('roomIsJoinLocked', () => showJoinError(t('channel.errors.roomIsJoinLocked')));
    socket.on('roomIsLocked', () => showJoinError(t('channel.errors.roomIsLocked')));
    socket.on('unauthorized', () => {
        if (hostToken) {
            sessionStorage.removeItem(HOST_TOKEN_PREFIX + channelId);
            hostToken = '';
            $('#hostReadyHint').classList.add('hidden');
        }
        showJoinError(t('channel.errors.unauthorized'));
    });

    socket.on('disconnect', () => {
        if (!joined) return;
        // full reset: socket.io reconnects with a NEW socket id, the server
        // treats us as a fresh join and re-sends addPeer for everyone
        mesh?.clear();
        for (const peerId of [...members.keys()]) {
            if (peerId !== socket.id) dropPeer(peerId, { silent: true });
        }
        toast(t('channel.errors.disconnected'), 'warn');
    });
}

function peerIdSafe(id) {
    return typeof id === 'string' ? id : '';
}

// ---------------------------------------------------------------------------
// mesh callbacks
// ---------------------------------------------------------------------------

function meshHandlers() {
    return {
        onRemoteStream(peerId, stream) {
            let audio = audioEls.get(peerId);
            if (!audio) {
                audio = el('audio', { autoplay: '', playsinline: '' });
                audio.style.display = 'none';
                document.body.append(audio);
                audioEls.set(peerId, audio);
            }
            audio.srcObject = stream;
            audio.play().catch(() => {});
            if (hub?.ctx) {
                hub.watch(peerId, stream, ({ speaking }) => {
                    const node = $(`#memberList .member[data-id="${peerId}"]`);
                    if (node) node.classList.toggle('speaking', speaking);
                });
            }
        },
        onChat(peerId, data) {
            if (!data || data.type !== 'chat') return;
            const name = members.get(peerId)?.peer_name || String(data.from || '').slice(0, 24) || '?';
            chat.add({ name, text: String(data.msg || '').slice(0, 500) });
        },
        onPeerState(peerId, state) {
            const node = $(`#memberList .member[data-id="${peerId}"]`);
            if (node) node.classList.toggle('bad', state === 'failed' || state === 'disconnected');
        },
    };
}

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

function syncMembers(peersMap) {
    const selfId = socket.id;
    for (const [peerId, info] of Object.entries(peersMap)) {
        if (roomMetaKey(peerId)) continue;
        if (peerId === selfId) continue;
        const existing = members.get(peerId);
        members.set(peerId, {
            peer_name: info.peer_name || existing?.peer_name || '?',
            peer_presenter: !!info.peer_presenter,
            peer_audio_status: info.peer_audio_status === true,
            joined_at: info.joined_at || existing?.joined_at || Date.now(),
        });
    }
    // drop stale entries
    for (const peerId of [...members.keys()]) {
        if (peerId === selfId) continue;
        if (!peersMap[peerId]) dropPeer(peerId, { silent: true });
    }
    ensureSelfMember();
    renderMembers();
}

function roomMetaKey(key) {
    return key === 'lock' || key === 'password' || key === 'joinLock';
}

function ensureSelfMember() {
    members.set(socket.id, {
        peer_name: selfName,
        peer_presenter: isPresenter,
        peer_audio_status: micOn,
        joined_at: 0, // self always first
        self: true,
    });
}

function dropPeer(peerId, { silent = false } = {}) {
    members.delete(peerId);
    mesh?.removePeer(peerId);
    hub?.unwatch(peerId);
    const audio = audioEls.get(peerId);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
        audioEls.delete(peerId);
    }
    if (!silent) renderMembers();
}

function renderMembers() {
    const list = $('#memberList');
    const sorted = [...members.entries()].sort((a, b) => {
        const [, a2] = a;
        const [, b2] = b;
        if (!!a2.self !== !!b2.self) return a2.self ? -1 : 1;
        if (!!a2.peer_presenter !== !!b2.peer_presenter) return a2.peer_presenter ? -1 : 1;
        return (a2.joined_at || 0) - (b2.joined_at || 0);
    });

    list.replaceChildren(
        ...sorted.map(([peerId, info]) => {
            const node = el('li', { class: 'member' + (info.self ? ' self-member' : ''), dataset: { id: peerId } });
            node.append(
                el(
                    'div',
                    { class: 'member-avatar', style: { background: avatarColor(info.peer_name) } },
                    (info.peer_name || '?').trim().charAt(0).toUpperCase() || '?'
                ),
                el(
                    'div',
                    { class: 'member-info' },
                    el(
                        'div',
                        { class: 'member-name' },
                        `${info.peer_name}`,
                        info.self ? el('span', { class: 'you', text: `（${t('channel.you')}）` }) : null
                    ),
                    el(
                        'div',
                        { class: 'member-sub' },
                        info.peer_presenter ? el('span', { class: 'badge host', text: t('channel.hostBadge') }) : null,
                        info.self && textOnly ? el('span', { class: 'badge', text: t('channel.textOnlyBadge') }) : null,
                        el('span', {
                            class: 'member-mic' + (info.peer_audio_status ? '' : ' off'),
                            html: info.peer_audio_status ? MIC_ON_SVG : MIC_OFF_SVG,
                        })
                    )
                )
            );

            if (isPresenter && !info.self) {
                node.append(
                    el(
                        'div',
                        { class: 'member-actions' },
                        el('button', {
                            class: 'btn ghost sm',
                            text: t('channel.muteMember'),
                            onclick: () => mutePeer(peerId),
                        }),
                        el('button', {
                            class: 'btn danger sm',
                            text: t('channel.removeMember'),
                            onclick: () => kickPeer(peerId),
                        })
                    )
                );
            }
            return node;
        })
    );
    $('#memberCount').textContent = String(members.size);
}

function updateOnlineCount() {
    $('#onlineCount').textContent = t('index.online', { n: members.size });
    $('#memberCount').textContent = String(members.size);
}

// ---------------------------------------------------------------------------
// host actions / moderation
// ---------------------------------------------------------------------------

function mutePeer(peerId) {
    socket.emit('peerAction', {
        room_id: channelId,
        peer_name: selfName,
        peer_uuid: selfUuid,
        peer_id: peerId,
        peer_action: 'muteAudio',
        send_to_all: false,
    });
}

function kickPeer(peerId) {
    socket.emit('kickOut', {
        room_id: channelId,
        peer_name: selfName,
        peer_uuid: selfUuid,
        peer_id: peerId,
        peer_kicked_reason: 'removed by host',
    });
}

function updateHeaderActions() {
    $('#hostBadge').classList.toggle('hidden', !isPresenter);
    const lockBtn = $('#lockBtn');
    lockBtn.classList.toggle('hidden', !isPresenter);
    if (isPresenter) {
        const label = joinLockOn ? t('channel.unlockBtn') : t('channel.lockBtn');
        lockBtn.innerHTML = (joinLockOn ? LOCK_SVG : UNLOCK_SVG) + `<span>${label}</span>`;
    }
}

// ---------------------------------------------------------------------------
// mic controls
// ---------------------------------------------------------------------------

function onMicBtnClick() {
    if (textOnly || !localStream) {
        enableVoice();
        return;
    }
    setMic(!micOn);
}

function setMic(on) {
    micOn = on && !!localStream;
    if (localStream) localStream.getTracks().forEach((track) => (track.enabled = micOn));
    socket?.emit('peerStatus', {
        room_id: channelId,
        peer_name: selfName,
        peer_id: socket.id,
        element: 'audio',
        status: micOn,
    });
    const self = members.get(socket?.id);
    if (self) self.peer_audio_status = micOn;
    updateVoiceControls();
    renderMembers();
}

async function enableVoice() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        localStream = stream;
        textOnly = false;
        micOn = true;
        await hub.ensureContext().catch(() => {});
        if (hub.ctx) {
            hub.watch('self', stream, ({ level }) => {
                $('#micLevelBar').style.width = `${Math.min(100, Math.round(level * 220))}%`;
            });
        }
        mesh.setLocalStream(stream); // renegotiates every peer connection
        socket.emit('peerStatus', {
            room_id: channelId,
            peer_name: selfName,
            peer_id: socket.id,
            element: 'audio',
            status: true,
        });
        ensureSelfMember();
        updateVoiceControls();
        renderMembers();
    } catch {
        toast(t('channel.errors.micDenied'), 'warn');
    }
}

function updateVoiceControls() {
    const micBtn = $('#micBtn');
    if (textOnly || !localStream) {
        micBtn.classList.add('muted');
        micBtn.innerHTML = `${MIC_OFF_SVG}<span>${t('channel.enableVoice')}</span>`;
    } else if (micOn) {
        micBtn.classList.remove('muted');
        micBtn.innerHTML = `${MIC_ON_SVG}<span>${t('channel.micOn')}</span>`;
    } else {
        micBtn.classList.add('muted');
        micBtn.innerHTML = `${MIC_OFF_SVG}<span>${t('channel.micOff')}</span>`;
    }
    if (!micOn) $('#micLevelBar').style.width = '0%';
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

function onChatSubmit(event) {
    event.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim().slice(0, 500);
    if (!text || !joined) return;
    input.value = '';
    mesh.sendChat({ type: 'chat', from: selfName, msg: text });
    chat.add({ name: selfName, text, self: true });
}

// ---------------------------------------------------------------------------
// host login (pre-join)
// ---------------------------------------------------------------------------

function openHostModal() {
    $('#hostLoginError').textContent = '';
    $('#hostModal').classList.remove('hidden');
    $('#hostUser').focus();
}

function closeHostModal() {
    $('#hostModal').classList.add('hidden');
}

async function onHostLoginSubmit(event) {
    event.preventDefault();
    const username = $('#hostUser').value.trim();
    const password = $('#hostPass').value;
    $('#hostLoginError').textContent = '';
    try {
        const { token } = await api.hostLogin(channelId, username, password);
        sessionStorage.setItem(HOST_TOKEN_PREFIX + channelId, token);
        hostToken = token;
        $('#hostReadyHint').classList.remove('hidden');
        closeHostModal();
        if (!joined) join({ textOnly: false });
    } catch {
        $('#hostLoginError').textContent = t('channel.hostLoginFailed');
    }
}

// ---------------------------------------------------------------------------
// leave / teardown / overlay states
// ---------------------------------------------------------------------------

function leave() {
    location.href = '/';
}

function teardown() {
    joined = false;
    socket?.disconnect();
    teardownMedia();
    for (const peerId of [...members.keys()]) dropPeer(peerId, { silent: true });
}

function teardownMedia() {
    mesh?.close();
    if (localStream) localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    hub?.destroy();
    hub = null;
}

function setOverlayBusy(busy) {
    const btn = $('#joinBtn');
    btn.disabled = busy;
    $('#textOnlyBtn').disabled = busy;
    $('#hostLoginBtn').disabled = busy;
    $('#joinError').textContent = '';
    if (busy) {
        btn.dataset.label = btn.textContent;
        btn.textContent = t('channel.joining');
    } else if (btn.dataset.label) {
        btn.textContent = btn.dataset.label;
    }
}

function showJoinError(message) {
    setOverlayBusy(false);
    $('#joinError').textContent = message;
    teardownMedia();
    socket?.disconnect();
    socket = null;
    mesh = null;
}

/** Fatal states (channel gone / kicked) — disable joining entirely. */
function showJoinFatal(message) {
    $('#joinOverlay').classList.remove('hidden');
    setOverlayBusy(false);
    $('#joinError').textContent = message;
    $('#joinBtn').disabled = true;
    $('#textOnlyBtn').disabled = true;
    $('#hostLoginBtn').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
    const node = el('div', { class: `toast ${kind}`, text: message });
    $('#toasts').append(node);
    setTimeout(() => node.remove(), 3200);
}
