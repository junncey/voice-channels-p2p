/**
 * Channel page controller — voice (left) + text chat (right).
 *
 * Audio settings (gear button): mic/speaker device pickers, browser audio
 * processing toggles, push-to-talk (hold V), mic level meter, speaker volume
 * and mic/speaker test. Images travel over the chat DataChannel in chunks
 * (public/js/core/images.js) and can be pasted straight from the clipboard.
 */

import { api } from '/js/core/api.js';
import { Mesh } from '/js/core/webrtc.js';
import { AudioHub, getTestBeepUrl } from '/js/core/audio.js';
import { initChat } from '/js/core/chat.js';
import { fileToImageMessage, sendImageData, createImageReceiver } from '/js/core/images.js';
import { createDropdown } from '/js/core/dropdown.js';
import { initI18n, t } from '/js/core/i18n.js';
import { $, el, avatarColor, randomNick, copyText } from '/js/core/utils.js';

const NICK_KEY = 'vc_nick';
const HOST_TOKEN_PREFIX = 'vc_host_token_';
const CHANNEL_PW_PREFIX = 'vc_chan_pw_';
const SEND_KEY_STORE = 'vc_send_key'; // 'enter' (default) | 'ctrlEnter'
const AUDIO_SETTINGS_KEY = 'vc_audio_settings';
const PEER_VOLUMES_KEY = 'vc_peer_volumes';
const AVATAR_KEY = 'vc_avatar';
const AVATAR_MAX_CHARS = 96 * 1024; // broadcast/storage cap for the avatar data URL
const PTT_KEY_CODE = 'KeyV';

const AVATAR_DATA_URL_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;

const MIC_ON_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const MIC_OFF_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 1.16-.29 2.26-.8 3.22"/><line x1="12" y1="19" x2="12" y2="22"/></svg>';
const LOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const UNLOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';
const VOL_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const channelId = (() => {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'c' ? decodeURIComponent(parts[1] || '') : '';
})();

const sinkSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const defaultAudioSettings = {
    micDeviceId: '',
    spkDeviceId: '',
    micVolume: 1, // input gain 0..2 = 0%..200%
    volume: 1,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    ptt: false,
};

let settings = loadAudioSettings();
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
let pttActive = false;
let lastOnAir = false; // last peerStatus(audio) we broadcast
let isPresenter = false;
let joinLockOn = false;
let localStream = null;
let rawMicStream = null; // straight from getUserMedia, before the input gain
let micProcessed = false; // outgoing track comes from the gain pipeline
let hostToken = loadHostToken();
// channel join password: pre-filled from storage for the auto-join path,
// otherwise taken from the overlay input at join time
let channelPassword = '';
// composer send key preference (QQ style): Enter or Ctrl+Enter sends, the
// other combinations insert a newline
let sendKey = localStorage.getItem(SEND_KEY_STORE) === 'ctrlEnter' ? 'ctrlEnter' : 'enter';

// ----- host login persistence -----
// The host token lives in localStorage so the login survives browser restarts
// (the server re-grants presenter status on every join). Tokens stored in
// sessionStorage by older versions are promoted on sight; expired ones are
// dropped locally so the join never has to fail because of them.

function hostTokenKey() {
    return HOST_TOKEN_PREFIX + channelId;
}

function jwtExpiresAt(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
    } catch {
        return 0;
    }
}

function loadHostToken() {
    const key = hostTokenKey();
    let token = localStorage.getItem(key) || sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (token && jwtExpiresAt(token) <= Date.now()) {
        localStorage.removeItem(key);
        token = null;
    }
    if (token) localStorage.setItem(key, token);
    return token || '';
}

function saveHostToken(token) {
    localStorage.setItem(hostTokenKey(), token);
}

function clearHostToken() {
    localStorage.removeItem(hostTokenKey());
    sessionStorage.removeItem(hostTokenKey());
}

// ----- channel password persistence -----
// Remembered per channel so returning visitors keep the auto-join flow; the
// server still validates it on every join (a stale value just re-opens the
// overlay). Hosts never need it (their JWT bypasses the channel password).

function channelPwKey() {
    return CHANNEL_PW_PREFIX + channelId;
}

function loadChannelPw() {
    return localStorage.getItem(channelPwKey()) || '';
}

function saveChannelPw(password) {
    localStorage.setItem(channelPwKey(), password);
}

function clearChannelPw() {
    localStorage.removeItem(channelPwKey());
}

/** peerId -> { peer_name, peer_presenter, peer_audio_status, joined_at, volume, self } */
const members = new Map();
const audioEls = new Map(); // peerId -> HTMLAudioElement (fallback playback path)
/** display name -> custom avatar data URL (validated) */
const avatars = new Map();
let selfAvatar = safeAvatarUrl(localStorage.getItem(AVATAR_KEY));
let micDevices = [];
let spkDevices = [];
let micDropdown = null;
let spkDropdown = null;

const imageReceiver = createImageReceiver({
    onDone: ({ from, dataUrl, batch }) => {
        if (batch) chat.addBatchImage(batch, dataUrl, t('chat.image'));
        else chat.addImage({ name: from || '?', src: dataUrl, alt: t('chat.image') });
    },
    onFail: (reason, batch) => {
        if (batch) chat.failBatchImage(batch);
        else chat.add({ text: t('chat.imageBroken'), system: true });
    },
});

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
    chat = initChat($('#chatMessages'), {
        emptyText: t('chat.empty'),
        downloadText: t('chat.saveImage'),
        yesterdayText: t('chat.yesterday'),
        avatarFor: (name) => avatars.get(name) || '',
        imagesProgress: (got, total) => t('chat.imagesProgress', { got, total }),
        failText: t('chat.imageBroken'),
    });
    bindUi();
    bindPttKeys();

    try {
        channelMeta = await api.getChannel(channelId);
    } catch {
        showJoinFatal(t('channel.errors.channelNotFound'));
        return;
    }

    $('#channelName').textContent = channelMeta.name || channelId;
    $('#channelDesc').textContent = channelMeta.description || '';
    $('#tempBadge').classList.toggle('hidden', !channelMeta.temporary);
    $('#joinChannelName').textContent = `# ${channelMeta.name || channelId}`;
    document.title = `${channelMeta.name || channelId} · ${t('app.name')}`;

    const presetName = new URLSearchParams(location.search).get('name');
    const savedNick = presetName || localStorage.getItem(NICK_KEY) || '';
    $('#nickInput').value = savedNick || randomNick(t('channel.guest'));
    if (hostToken) $('#hostReadyHint').classList.remove('hidden');

    // Password-protected channel: hosts pass with their own login, everyone
    // else must type the password (or have it remembered from a previous join)
    const pwFieldVisible = !!channelMeta.hasPassword && !hostToken;
    $('#joinPasswordField').classList.toggle('hidden', !pwFieldVisible);
    if (pwFieldVisible) {
        channelPassword = loadChannelPw();
        // pre-fill so the join() override below and the auto-join path agree
        $('#channelPwInput').value = channelPassword;
    }

    if (savedNick && (!pwFieldVisible || channelPassword)) {
        // returning visitor: skip the nickname overlay and join straight away
        $('#joinOverlay').classList.add('hidden');
        join({ textOnly: false });
        return;
    }

    $('#nickInput').focus();
    $('#nickInput').select();
    $('#nickInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') join({ textOnly: false });
    });
    $('#channelPwInput').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') join({ textOnly: false });
    });
}

function bindUi() {
    $('#backBtn').addEventListener('click', () => (location.href = '/'));
    $('#joinBtn').addEventListener('click', () => join({ textOnly: false }));
    $('#textOnlyBtn').addEventListener('click', () => join({ textOnly: true }));

    $('#hostLoginBtn').addEventListener('click', openHostModal);
    $('#hostLoginEntryBtn').addEventListener('click', openHostModal);
    $('#hostCancelBtn').addEventListener('click', closeHostModal);
    $('#hostLoginForm').addEventListener('submit', onHostLoginSubmit);

    $('#renameCancelBtn').addEventListener('click', closeRenameModal);
    $('#renameForm').addEventListener('submit', onRenameSubmit);
    $('#renameModal').addEventListener('click', (event) => {
        if (event.target === $('#renameModal')) closeRenameModal();
    });

    $('#copyLinkBtn').addEventListener('click', async () => {
        const ok = await copyText(`${location.origin}/c/${channelId}`);
        if (ok) toast(t('channel.copied'), 'ok');
    });

    $('#leaveBtn').addEventListener('click', leave);
    $('#micBtn').addEventListener('click', onMicBtnClick);
    $('#chatForm').addEventListener('submit', onChatSubmit);
    bindChatInput();

    bindImageUi();
    bindSettingsUi();

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
    // overlay visible = manual attempt: its input is authoritative (it may
    // differ from the remembered value after a "wrong password" round-trip)
    if (!$('#joinPasswordField').classList.contains('hidden')) {
        channelPassword = $('#channelPwInput').value;
    }

    // release anything a previous attempt left behind (e.g. the stale-token
    // retry after 'unauthorized' joins a second time)
    teardownMedia();
    for (const peerId of [...members.keys()]) dropPeer(peerId, { silent: true });

    selfName = nick;
    selfUuid = crypto.randomUUID();
    localStorage.setItem(NICK_KEY, nick);
    textOnly = asTextOnly;

    if (!textOnly) {
        try {
            rawMicStream = await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() });
        } catch {
            textOnly = true;
            toast(t('channel.errors.micDenied'), 'warn');
        }
    }
    if (rawMicStream) rawMicStream.getTracks().forEach((track) => (track.enabled = true));
    localStream = rawMicStream;

    hub = new AudioHub();
    try {
        await hub.ensureContext();
    } catch {
        /* speaking indicators degrade to off, voice still works */
    }
    if (hub.ctx) {
        // the context may start suspended (autoplay policy — e.g. auto-join on
        // page load with no user gesture): peers play through <audio> elements
        // until the first interaction resumes it, then upgrade to the gain path
        hub.ctx.addEventListener('statechange', onCtxStateChange);
        const resume = () => hub?.ctx?.resume().catch(() => {});
        window.addEventListener('pointerdown', resume, { once: true });
        window.addEventListener('keydown', resume, { once: true });
    }
    syncMicPipeline(); // may swap localStream to the gain-processed stream
    if (localStream && hub.ctx) hub.watch('self', localStream, localLevelCb);
    applySpeaker(); // route Web Audio playback to the chosen output from the start

    socket = io({ transports: ['websocket'] });
    mesh = new Mesh({ signaling: socket, handlers: meshHandlers() });
    if (localStream) mesh.setLocalStream(localStream);

    registerSocketHandlers();

    setOverlayBusy(true);
    micOn = !textOnly && !!localStream;
    applyMicState(); // no socket yet — just refresh buttons; peer_audio goes in the join payload
    lastOnAir = onAir();
}

function localLevelCb({ level }) {
    const pct = `${Math.min(100, Math.round(level * 220))}%`;
    $('#micLevelBar').style.width = pct;
    $('#settingsMicBar').style.width = pct;
}

function registerSocketHandlers() {
    socket.on('connect', emitJoin);

    socket.on('serverInfo', (cfg) => {
        if (!joined) {
            joined = true;
            isPresenter = !!cfg.is_presenter;
            joinLockOn = !!cfg.join_locked;
            $('#joinOverlay').classList.add('hidden');
            updateHeaderActions();
            syncMembers(cfg.peers || {});
            chat.add({ text: t('chat.joined', { name: selfName }), system: true, self: true });
            // password accepted — keep it for the next auto-join
            if (channelPassword) saveChannelPw(channelPassword);
            // tell everyone in the room which avatar we carry (peers list only
            // flows joiner <- room, this is the joiner -> room direction)
            if (selfAvatar) socket.emit('peerAvatar', { room_id: channelId, avatar: selfAvatar });
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
        updateMicIconNode(peer_id, status === true);
    });

    socket.on('peerName', ({ peer_id, peer_name, peer_name_old }) => {
        if (!peer_name) return;
        const member = members.get(peer_id);
        const old = member?.peer_name;
        if (member && old && old !== peer_name) {
            // per-user volume memory is keyed by display name — follow the rename
            if (peerVolumes[old] !== undefined && peerVolumes[old] !== 1) {
                savePeerVolume(peer_name, peerVolumes[old]);
            }
            savePeerVolume(old, 1); // drop the stale key
            // avatar lookup is keyed by name too — move it along
            const avatar = avatars.get(old);
            if (avatar) {
                avatars.set(peer_name, avatar);
                avatars.delete(old);
            }
            chat.renamePeer(old, peer_name);
            member.peer_name = peer_name;
            if (peerVolumes[peer_name] !== undefined) member.volume = peerVolumes[peer_name];
        } else if (member) {
            member.peer_name = peer_name;
        }
        if (peer_id === socket.id) {
            // the host renamed ME — accept it and persist for the next visit
            selfName = peer_name;
            localStorage.setItem(NICK_KEY, peer_name);
            if (selfAvatar) avatars.set(selfName, selfAvatar);
            chat.setAvatar(selfName, selfAvatar);
            $('#nickInput').value = peer_name;
            toast(t('channel.renamedYou', { name: peer_name }), 'ok');
        } else if (joined && member && (peer_name_old || old)) {
            chat.add({
                text: t('chat.renamed', { old: peer_name_old || old, name: peer_name }),
                system: true,
            });
        }
        renderMembers();
    });

    socket.on('peerAvatar', ({ peer_id, peer_name, avatar }) => {
        const url =
            typeof avatar === 'string' && avatar.length <= AVATAR_MAX_CHARS && AVATAR_DATA_URL_RE.test(avatar)
                ? avatar
                : '';
        const member = members.get(peerIdSafe(peer_id));
        if (member) member.avatar = url || undefined;
        if (peer_name) {
            if (url) avatars.set(peer_name, url);
            else avatars.delete(peer_name);
            chat.setAvatar(peer_name, url);
        }
        renderMembers();
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

    socket.on('kickOut', (cfg) => {
        teardown();
        // host ejection vs. the admin deleting the room under our feet
        showJoinFatal(cfg?.reason === 'channelDeleted' ? t('channel.channelDeleted') : t('channel.kicked'));
    });

    socket.on('channelNotFound', () => showJoinFatal(t('channel.errors.channelNotFound')));
    socket.on('roomIsBusy', (cfg) => showJoinError(t('channel.errors.roomIsBusy', { n: cfg?.maxParticipants || 0 })));
    socket.on('roomIsJoinLocked', () => showJoinError(t('channel.errors.roomIsJoinLocked')));
    socket.on('roomIsLocked', () => showJoinError(t('channel.errors.roomIsLocked')));
    socket.on('channelPasswordRequired', () => {
        // wrong or missing channel password — drop the stale remembered value
        // so the overlay stays up until a correct one is entered
        clearChannelPw();
        channelPassword = '';
        showJoinError(t('channel.errors.passwordRequired'));
        $('#joinPasswordField').classList.remove('hidden');
        $('#channelPwInput').value = '';
        $('#channelPwInput').focus();
    });
    socket.on('unauthorized', () => {
        if (!hostToken) return showJoinError(t('channel.errors.unauthorized'));
        // persisted token no longer accepted (expired or the host was removed
        // from the channel config) — drop it and carry on as a guest
        clearHostToken();
        hostToken = '';
        $('#hostReadyHint').classList.add('hidden');
        toast(t('channel.hostTokenExpired'), 'warn');
        if (joined) emitJoin(); // reconnect of an established session: rejoin without the token
        else {
            socket.disconnect();
            join({ textOnly: false });
        }
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

function emitJoin() {
    socket.emit('join', {
        channel: channelId,
        peer_uuid: selfUuid,
        peer_name: selfName,
        peer_token: hostToken || undefined,
        channel_password: channelPassword || undefined,
        peer_audio: onAir(),
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
            attachRemoteAudio(peerId, stream);
            if (hub?.ctx) {
                hub.watch(peerId, stream, ({ speaking }) => {
                    const node = $(`#memberList .member[data-id="${peerId}"]`);
                    if (node) node.classList.toggle('speaking', speaking);
                });
            }
        },
        onChat(peerId, data) {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'chat') {
                const name = members.get(peerId)?.peer_name || String(data.from || '').slice(0, 24) || '?';
                const batch = typeof data.batch === 'string' && data.batch.length <= 64 ? data.batch : '';
                const imgs = Number(data.imgs);
                if (batch && Number.isInteger(imgs) && imgs > 0 && imgs <= 9) {
                    // one send of text + N images renders as ONE merged bubble
                    chat.openBatch({ batch, name, text: String(data.msg || '').slice(0, 500), count: imgs });
                } else {
                    chat.add({ name, text: String(data.msg || '').slice(0, 500) });
                }
                return;
            }
            if (data.type === 'img-start' || data.type === 'img-chunk' || data.type === 'img-end') {
                imageReceiver(data);
            }
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
        const name = info.peer_name || existing?.peer_name || '?';
        const avatar =
            typeof info.peer_avatar === 'string' &&
            info.peer_avatar.length <= AVATAR_MAX_CHARS &&
            AVATAR_DATA_URL_RE.test(info.peer_avatar)
                ? info.peer_avatar
                : existing?.avatar;
        if (avatar) avatars.set(name, avatar);
        members.set(peerId, {
            peer_name: name,
            peer_presenter: !!info.peer_presenter,
            peer_audio_status: info.peer_audio_status === true,
            joined_at: info.joined_at || existing?.joined_at || Date.now(),
            avatar,
            // remembered per-user volume; an in-session adjustment wins over the stored one
            volume: existing?.volume ?? (name !== '?' ? peerVolumes[name] ?? 1 : 1),
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
        peer_audio_status: onAir(),
        joined_at: 0, // self always first
        avatar: selfAvatar || undefined,
        self: true,
    });
    if (selfAvatar) avatars.set(selfName, selfAvatar);
}

function dropPeer(peerId, { silent = false } = {}) {
    members.delete(peerId);
    mesh?.removePeer(peerId);
    hub?.unwatch(peerId);
    hub?.stopPeer(peerId);
    const audio = audioEls.get(peerId);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
        audioEls.delete(peerId);
    }
    if (!silent) renderMembers();
}

function memberAvatarNode(info) {
    if (info.avatar) {
        const img = el('img', { class: 'member-avatar img', alt: '' });
        img.src = info.avatar; // validated data URL
        return img;
    }
    return el(
        'div',
        { class: 'member-avatar', style: { background: avatarColor(info.peer_name) } },
        (info.peer_name || '?').trim().charAt(0).toUpperCase() || '?'
    );
}

function micIconNode(on) {
    return el('span', {
        class: 'member-mic' + (on ? '' : ' off'),
        html: on ? MIC_ON_SVG : MIC_OFF_SVG,
    });
}

/** Per-user volume row (0-300%), revealed on card hover. */
function memberVolumeNode(peerId, info) {
    const initial = Math.round((info.volume ?? 1) * 100);
    const value = el('span', { class: 'member-volume-val', text: `${initial}%` });
    const slider = el('input', {
        type: 'range',
        min: 0,
        max: 300,
        step: 5,
        value: String(initial),
        title: t('channel.userVolume'),
    });
    slider.addEventListener('input', () => {
        info.volume = Number(slider.value) / 100;
        value.textContent = `${slider.value}%`;
        slider.closest('.member-volume')?.classList.add('adjusted');
        savePeerVolume(info.peer_name, info.volume);
        reapplyPeerVolume(peerId);
    });
    return el(
        'div',
        { class: 'member-volume' + (initial !== 100 ? ' adjusted' : '') },
        el('span', { class: 'member-volume-icon', html: VOL_SVG }),
        slider,
        value
    );
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
                memberAvatarNode(info),
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
                        micIconNode(info.peer_audio_status)
                    )
                )
            );

            if (!info.self) node.append(memberVolumeNode(peerId, info));

            if (isPresenter && !info.self) {
                node.append(
                    el(
                        'div',
                        { class: 'member-actions' },
                        el('button', {
                            class: 'btn ghost sm',
                            text: t('channel.renameMember'),
                            onclick: () => renamePeer(peerId),
                        }),
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

/**
 * Update one member's mic icon in place — remote peerStatus flips (and local
 * push-to-talk) must not rebuild the list, or a volume slider mid-drag dies.
 */
function updateMicIconNode(peerId, on) {
    const node = $(`#memberList .member[data-id="${peerId}"] .member-mic`);
    if (!node) {
        renderMembers();
        return;
    }
    node.className = 'member-mic' + (on ? '' : ' off');
    node.innerHTML = on ? MIC_ON_SVG : MIC_OFF_SVG;
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

// ----- host renames a member's joined nickname -----

let renameTarget = null; // peerId the rename modal is editing

function renamePeer(peerId) {
    renameTarget = peerId;
    $('#renameInput').value = members.get(peerId)?.peer_name || '';
    $('#renameError').textContent = '';
    $('#renameModal').classList.remove('hidden');
    $('#renameInput').focus();
    $('#renameInput').select();
}

function closeRenameModal() {
    renameTarget = null;
    $('#renameModal').classList.add('hidden');
}

function onRenameSubmit(event) {
    event.preventDefault();
    const name = $('#renameInput').value.trim().slice(0, 24);
    if (!name) {
        $('#renameError').textContent = t('channel.errors.nickRequired');
        return;
    }
    if (renameTarget && members.get(renameTarget)?.peer_name !== name) {
        socket.emit('peerRename', {
            room_id: channelId,
            peer_name: selfName,
            peer_uuid: selfUuid,
            peer_id: renameTarget,
            peer_name_new: name,
        });
    }
    closeRenameModal();
}

function updateHeaderActions() {
    $('#hostBadge').classList.toggle('hidden', !isPresenter);
    // host login stays reachable after the auto-join (no pre-join overlay)
    $('#hostLoginEntryBtn').classList.toggle('hidden', !(joined && !isPresenter));
    const lockBtn = $('#lockBtn');
    lockBtn.classList.toggle('hidden', !isPresenter);
    if (isPresenter) {
        const label = joinLockOn ? t('channel.unlockBtn') : t('channel.lockBtn');
        lockBtn.innerHTML = (joinLockOn ? LOCK_SVG : UNLOCK_SVG) + `<span>${label}</span>`;
    }
}

// ---------------------------------------------------------------------------
// mic controls (manual mute + push-to-talk share one effective state)
// ---------------------------------------------------------------------------

/** mic is actually transmitting right now */
function onAir() {
    return !!localStream && micOn && (!settings.ptt || pttActive);
}

function onMicBtnClick() {
    if (textOnly || !localStream) {
        enableVoice();
        return;
    }
    setMic(!micOn);
}

function setMic(on) {
    micOn = on && !!localStream;
    applyMicState();
}

/** Push the effective state to the local track / peers / UI. */
function applyMicState() {
    const live = onAir();
    if (localStream) localStream.getAudioTracks().forEach((track) => (track.enabled = live));
    if (socket && joined && live !== lastOnAir) {
        lastOnAir = live;
        socket.emit('peerStatus', {
            room_id: channelId,
            peer_name: selfName,
            peer_id: socket.id,
            element: 'audio',
            status: live,
        });
    }
    const self = members.get(socket?.id);
    if (self) self.peer_audio_status = live;
    updateVoiceControls();
    updateMicIconNode(socket?.id, live); // in-place: full re-renders kill a mid-drag volume slider
}

function bindPttKeys() {
    window.addEventListener('keydown', (event) => {
        if (event.code !== PTT_KEY_CODE || event.repeat) return;
        if (!settings.ptt || !joined || !localStream || !micOn) return;
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
        event.preventDefault();
        pttActive = true;
        applyMicState();
    });
    window.addEventListener('keyup', (event) => {
        if (event.code !== PTT_KEY_CODE || !pttActive) return;
        pttActive = false;
        applyMicState();
    });
}

function buildAudioConstraints() {
    const audio = {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
    };
    if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };
    return { audio };
}

/**
 * Re-acquire the mic with the current settings (device switch or processing
 * toggle) and hot-swap the outgoing track — no renegotiation involved.
 */
/**
 * Point the outgoing track at the gain-processed mic stream while the shared
 * AudioContext runs; a suspended context would emit silence, so the raw track
 * goes out instead until the context resumes (statechange re-runs this).
 */
function syncMicPipeline() {
    if (!rawMicStream) return;
    const wantProcessed = !!hub?.ctx && hub.ctx.state === 'running';
    if (wantProcessed === micProcessed) return;
    const live = onAir();
    if (wantProcessed) {
        const processed = hub.attachMic(rawMicStream, settings.micVolume);
        if (!processed) return;
        processed.getAudioTracks().forEach((track) => (track.enabled = live));
        localStream = processed;
        micProcessed = true;
        mesh?.replaceAudioTrack(processed.getAudioTracks()[0], processed);
    } else {
        hub?.detachMic();
        rawMicStream.getAudioTracks().forEach((track) => (track.enabled = live));
        localStream = rawMicStream;
        micProcessed = false;
        mesh?.replaceAudioTrack(rawMicStream.getAudioTracks()[0], rawMicStream);
    }
    if (hub?.ctx) hub.watch('self', localStream, localLevelCb);
}

async function reacquireMic() {
    const hadStream = !!localStream;
    const stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
    const track = stream.getAudioTracks()[0];
    // a device/processing change keeps the current mute state; enabling voice turns the mic on
    micOn = hadStream ? micOn : true;
    textOnly = false;
    track.enabled = onAir();
    if (hub) await hub.ensureContext().catch(() => {});

    // rebuild the input-gain pipeline around the new capture; the previous mic
    // (raw capture + processed track) is stopped after the hot-swap
    const oldRaw = rawMicStream;
    const oldOut = localStream;
    hub?.detachMic();
    micProcessed = false;
    rawMicStream = stream;
    localStream = stream;
    syncMicPipeline(); // upgrades to the processed track when possible
    if (!micProcessed) mesh?.replaceAudioTrack(track, stream);
    if (hub?.ctx) hub.watch('self', localStream, localLevelCb);
    ensureSelfMember();
    applyMicState();
    oldOut?.getTracks().forEach((old) => old.stop());
    oldRaw?.getTracks().forEach((old) => old.stop());
    refreshDeviceSelects(); // labels become available after permission is granted
}

async function enableVoice() {
    try {
        await reacquireMic();
    } catch {
        toast(t('channel.errors.micDenied'), 'warn');
    }
}

function updateVoiceControls() {
    const micBtn = $('#micBtn');
    const live = onAir();
    if (!localStream) {
        micBtn.classList.add('muted');
        micBtn.innerHTML = `${MIC_OFF_SVG}<span>${t('channel.enableVoice')}</span>`;
    } else if (micOn && settings.ptt) {
        micBtn.classList.toggle('muted', !live);
        micBtn.innerHTML = `${live ? MIC_ON_SVG : MIC_OFF_SVG}<span>${t('channel.pttOn')}</span>`;
    } else if (micOn) {
        micBtn.classList.remove('muted');
        micBtn.innerHTML = `${MIC_ON_SVG}<span>${t('channel.micOn')}</span>`;
    } else {
        micBtn.classList.add('muted');
        micBtn.innerHTML = `${MIC_OFF_SVG}<span>${t('channel.micOff')}</span>`;
    }
    if (!live) {
        $('#micLevelBar').style.width = '0%';
        $('#settingsMicBar').style.width = '0%';
    }
}

// ---------------------------------------------------------------------------
// remote audio playback — per-user volume 0..300% x master 0..100%
// ---------------------------------------------------------------------------

/** Chromium: play through GainNodes (boost past 100% + AudioContext sink). */
function webAudioPlayback() {
    return !!hub?.ctx && hub.ctx.state === 'running' && typeof hub.ctx.setSinkId === 'function';
}

/** Context state flipped — move playback/mic between the gain path and raw paths. */
function onCtxStateChange() {
    if (webAudioPlayback()) {
        for (const [peerId, audio] of [...audioEls]) {
            if (audio.srcObject) attachRemoteAudio(peerId, audio.srcObject);
        }
        applySpeaker();
    } else {
        // suspended (again): the gain graph would be silent — play through elements
        for (const [peerId, player] of [...(hub?.players?.entries() || [])]) {
            const stream = player.src.mediaStream;
            if (stream) attachRemoteAudio(peerId, stream);
        }
    }
    syncMicPipeline(); // raw track <-> gain-processed track
}

/** total gain for a remote peer: per-user volume × master volume */
function peerTotalGain(peerId) {
    return (members.get(peerId)?.volume ?? 1) * settings.volume;
}

function removeAudioEl(peerId) {
    const audio = audioEls.get(peerId);
    if (audio) {
        audio.srcObject = null;
        audio.remove();
        audioEls.delete(peerId);
    }
}

function attachRemoteAudio(peerId, stream) {
    const total = peerTotalGain(peerId);
    if (webAudioPlayback() && hub.playPeer(peerId, stream, total)) {
        removeAudioEl(peerId);
        return;
    }
    // fallback path: <audio> elements honor element.setSinkId but cap at 100%
    hub?.stopPeer(peerId);
    let audio = audioEls.get(peerId);
    if (!audio) {
        audio = el('audio', { autoplay: '', playsinline: '' });
        audio.style.display = 'none';
        document.body.append(audio);
        audioEls.set(peerId, audio);
        applySink(audio);
    }
    audio.srcObject = stream;
    audio.volume = Math.min(1, total);
    audio.play().catch(() => {});
}

function reapplyPeerVolume(peerId) {
    const total = peerTotalGain(peerId);
    if (hub) hub.setPeerVolume(peerId, total);
    const audio = audioEls.get(peerId);
    if (audio) audio.volume = Math.min(1, total);
}

function reapplyAllVolumes() {
    for (const peerId of members.keys()) {
        if (peerId !== socket?.id) reapplyPeerVolume(peerId);
    }
}

/** Route remote playback to the selected output device. */
async function applySpeaker() {
    if (webAudioPlayback()) {
        await hub.setSink(settings.spkDeviceId);
        return;
    }
    for (const audio of audioEls.values()) await applySink(audio);
}

// ---------------------------------------------------------------------------
// audio settings modal
// ---------------------------------------------------------------------------

function bindSettingsUi() {
    micDropdown = createDropdown({
        getItems: () => deviceItems('mic'),
        getValue: () => settings.micDeviceId,
        onSelect: (value) => {
            settings.micDeviceId = value;
            saveAudioSettings();
            // switching device in text-only mode doubles as "enable voice"
            if (localStream) reacquireMic().catch(() => toast(t('channel.errors.micDenied'), 'warn'));
            else enableVoice();
        },
    });
    spkDropdown = createDropdown({
        getItems: () => deviceItems('spk'),
        getValue: () => settings.spkDeviceId,
        onSelect: (value) => {
            settings.spkDeviceId = value;
            saveAudioSettings();
            applySpeaker();
        },
    });
    $('#micDeviceSelect').append(micDropdown.el);
    $('#spkDeviceSelect').append(spkDropdown.el);

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#settingsCloseBtn').addEventListener('click', closeSettings);
    $('#settingsModal').addEventListener('click', (event) => {
        if (event.target === $('#settingsModal')) closeSettings();
    });
    bindAvatarUi();

    for (const [id, key] of [
        ['nsToggle', 'noiseSuppression'],
        ['ecToggle', 'echoCancellation'],
        ['agcToggle', 'autoGainControl'],
    ]) {
        $(`#${id}`).addEventListener('change', (event) => {
            settings[key] = event.target.checked;
            saveAudioSettings();
            if (localStream) reacquireMic().catch(() => toast(t('channel.errors.micDenied'), 'warn'));
        });
    }

    $('#pttToggle').addEventListener('change', (event) => {
        settings.ptt = event.target.checked;
        pttActive = false;
        saveAudioSettings();
        applyMicState();
    });

    $('#micVolumeSlider').addEventListener('input', (event) => {
        settings.micVolume = Number(event.target.value) / 100;
        $('#micVolumeVal').textContent = `${event.target.value}%`;
        hub?.setMicGain(settings.micVolume); // takes effect immediately, no renegotiation
        saveAudioSettings();
    });

    $('#volumeSlider').addEventListener('input', (event) => {
        settings.volume = Number(event.target.value) / 100;
        $('#volumeVal').textContent = `${event.target.value}%`;
        reapplyAllVolumes();
        saveAudioSettings();
    });

    $('#testMicBtn').addEventListener('click', onTestMicClick);
    $('#testSpkBtn').addEventListener('click', playTestBeep);

    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDeviceSelects);
}

function openSettings() {
    updateAvatarPreview();
    $('#nsToggle').checked = settings.noiseSuppression;
    $('#ecToggle').checked = settings.echoCancellation;
    $('#agcToggle').checked = settings.autoGainControl;
    $('#pttToggle').checked = settings.ptt;
    spkDropdown.setDisabled(!sinkSupported);
    $('#sinkUnsupported').classList.toggle('hidden', sinkSupported);
    const pct = Math.round(settings.volume * 100);
    $('#volumeSlider').value = String(pct);
    $('#volumeVal').textContent = `${pct}%`;
    const micPct = Math.round(settings.micVolume * 100);
    $('#micVolumeSlider').value = String(micPct);
    $('#micVolumeVal').textContent = `${micPct}%`;
    refreshDeviceSelects();
    $('#settingsModal').classList.remove('hidden');
}

function closeSettings() {
    micDropdown?.close();
    spkDropdown?.close();
    $('#settingsModal').classList.add('hidden');
    stopMicTest();
}

function deviceItems(kind) {
    const list = kind === 'mic' ? micDevices : spkDevices;
    const generic = t(kind === 'mic' ? 'settings.deviceMic' : 'settings.deviceSpk');
    const items = [{ value: '', label: t('settings.defaultDevice') }];
    list.forEach((device, index) => {
        items.push({ value: device.deviceId, label: ((device.label || '').trim() || `${generic} ${index + 1}`).slice(0, 60) });
    });
    return items;
}

async function refreshDeviceSelects() {
    let devices = [];
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
        return;
    }
    micDevices = devices.filter((d) => d.kind === 'audioinput');
    spkDevices = devices.filter((d) => d.kind === 'audiooutput');
    micDropdown?.refresh();
    spkDropdown?.refresh();
}

async function applySink(audioEl) {
    if (!sinkSupported || !settings.spkDeviceId) return;
    try {
        await audioEl.setSinkId(settings.spkDeviceId);
    } catch {
        /* device vanished — keep the default output */
    }
}

async function playTestBeep() {
    const url = await getTestBeepUrl();
    if (!url) return toast(t('common.error'), 'warn');
    const beep = new Audio(url);
    beep.volume = settings.volume;
    await applySink(beep);
    beep.play().catch(() => toast(t('common.error'), 'warn'));
}

// ----- mic test: live loopback — hear your own mic through the speakers with
// a short delay; click again to stop. Taps the RAW capture so it works even
// while the channel mic is muted, and applies the input volume itself -----

const MIC_TEST_DELAY = 0.5; // seconds — long enough to feel like an echo, short enough to be live

let micTest = null; // { src, delay, gain, timer }

async function onTestMicClick() {
    if (micTest) {
        stopMicTest();
        return;
    }
    if (!localStream) {
        await enableVoice();
        if (!localStream) return;
    }
    if (!hub?.ctx) return toast(t('settings.micTestUnsupported'), 'warn');
    try {
        await hub.ensureContext();
    } catch {
        /* fall through — the graph below will simply stay silent */
    }
    const ctx = hub.ctx;
    const src = ctx.createMediaStreamSource(rawMicStream || localStream);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = MIC_TEST_DELAY;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(delay).connect(gain).connect(ctx.destination); // ctx sink = selected speaker
    gain.gain.setTargetAtTime(Math.max(0.2, settings.volume) * settings.micVolume, ctx.currentTime, 0.03);
    micTest = {
        src,
        delay,
        gain,
        timer: setTimeout(stopMicTest, 30000), // safety stop: bounded feedback risk
    };
    const btn = $('#testMicBtn');
    btn.classList.add('recording');
    btn.textContent = t('settings.stopMicTest');
}

function stopMicTest() {
    if (!micTest) return;
    clearTimeout(micTest.timer);
    try {
        micTest.src.disconnect();
        micTest.delay.disconnect();
        micTest.gain.disconnect();
    } catch {
        /* already disconnected */
    }
    micTest = null;
    resetTestMicBtn();
}

function resetTestMicBtn() {
    const btn = $('#testMicBtn');
    btn.classList.remove('recording');
    btn.textContent = t('settings.testMic');
}

function loadAudioSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || '{}');
        return { ...defaultAudioSettings, ...stored };
    } catch {
        return { ...defaultAudioSettings };
    }
}

function saveAudioSettings() {
    try {
        localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        /* storage full / disabled — settings just won't persist */
    }
}

// per-user volumes, keyed by display name so they survive reconnects,
// page reloads and follow the same person into other channels
function loadPeerVolumes() {
    try {
        return JSON.parse(localStorage.getItem(PEER_VOLUMES_KEY)) || {};
    } catch {
        return {};
    }
}

const peerVolumes = loadPeerVolumes();

function savePeerVolume(name, volume) {
    if (!name || name === '?') return;
    delete peerVolumes[name]; // re-insert so recency order holds
    if (volume !== 1) peerVolumes[name] = volume;
    const keys = Object.keys(peerVolumes);
    if (keys.length > 50) for (const key of keys.slice(0, keys.length - 50)) delete peerVolumes[key];
    try {
        localStorage.setItem(PEER_VOLUMES_KEY, JSON.stringify(peerVolumes));
    } catch {
        /* storage full — volumes still apply for this session */
    }
}

// ---------------------------------------------------------------------------
// chat + image sending
// ---------------------------------------------------------------------------

// composer textarea grows with the content up to this height, then scrolls
const CHAT_INPUT_MAX_HEIGHT = 120;

function bindChatInput() {
    const input = $('#chatInput');
    input.addEventListener('input', autoGrowChatInput);
    input.addEventListener('keydown', onChatInputKeydown);

    // QQ-style send-key menu behind the caret next to the send button
    const menu = $('#sendKeyMenu');
    const caret = $('#sendKeyBtn');
    for (const radio of menu.querySelectorAll('input[name="sendKey"]')) {
        if (radio.value === sendKey) radio.checked = true;
        radio.addEventListener('change', () => {
            sendKey = radio.value === 'ctrlEnter' ? 'ctrlEnter' : 'enter';
            localStorage.setItem(SEND_KEY_STORE, sendKey);
            toggleSendKeyMenu(false);
        });
    }
    caret.addEventListener('click', () => toggleSendKeyMenu(menu.classList.contains('hidden')));
    document.addEventListener('click', (event) => {
        if (!menu.classList.contains('hidden') && !menu.contains(event.target) && !caret.contains(event.target)) {
            toggleSendKeyMenu(false);
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') toggleSendKeyMenu(false);
    });
}

function toggleSendKeyMenu(open) {
    $('#sendKeyMenu').classList.toggle('hidden', !open);
    $('#sendKeyBtn').classList.toggle('open', open);
}

function autoGrowChatInput() {
    const input = $('#chatInput');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, CHAT_INPUT_MAX_HEIGHT) + 'px';
}

function onChatInputKeydown(event) {
    // IME composition: Enter confirms the candidate text, it must never send
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Enter') return;
    // newline/sending is handled EXPLICITLY — relying on the browser's default
    // insertion is unreliable across webviews and mobile keyboards
    event.preventDefault();
    const ctrlEnter = event.ctrlKey || event.metaKey;
    if (sendKey === 'enter') {
        if (ctrlEnter || event.shiftKey) insertChatNewline();
        else $('#chatForm').requestSubmit();
    } else if (ctrlEnter) {
        $('#chatForm').requestSubmit();
    } else {
        insertChatNewline();
    }
}

function insertChatNewline() {
    const input = $('#chatInput');
    // execCommand keeps the native undo stack; setRangeText is the fallback
    let inserted = false;
    try {
        inserted = document.execCommand('insertText', false, '\n');
    } catch {
        inserted = false;
    }
    if (!inserted) input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    autoGrowChatInput();
}

async function onChatSubmit(event) {
    event.preventDefault();
    if (!joined) return;
    const input = $('#chatInput');
    const text = input.value.trim().slice(0, 500);
    const images = [...pendingImages];
    if (!text && !images.length) return;
    input.value = '';
    autoGrowChatInput();
    clearPendingImages(); // the tray is emptied up-front; failures toast per image

    if (!images.length) {
        mesh.sendChat({ type: 'chat', from: selfName, msg: text });
        chat.add({ name: selfName, text, self: true });
        return;
    }

    // text + images go out as ONE batch = one merged bubble on every receiver
    const payloads = [];
    for (const item of images) {
        try {
            payloads.push(await fileToImageMessage(item.file));
        } catch (err) {
            const key = err?.message === 'too-large' ? 'chat.imageTooLarge' : 'chat.imageUnsupported';
            toast(t(key), 'warn');
        }
    }
    if (!payloads.length) {
        if (text) {
            mesh.sendChat({ type: 'chat', from: selfName, msg: text });
            chat.add({ name: selfName, text, self: true });
        }
        return;
    }

    const batch = crypto.randomUUID();
    mesh.sendChat({ type: 'chat', from: selfName, msg: text, batch, imgs: payloads.length });
    chat.openBatch({ batch, name: selfName, text, count: payloads.length, self: true });
    for (const payload of payloads) {
        sendImageData({
            send: (frame) => mesh.sendChat(frame),
            from: selfName,
            mime: payload.mime,
            dataUrl: payload.dataUrl,
            batch,
        });
        chat.addBatchImage(batch, payload.dataUrl, t('chat.image'));
    }
}

// ---------------------------------------------------------------------------
// custom avatar (settings modal)
// ---------------------------------------------------------------------------

function safeAvatarUrl(value) {
    return typeof value === 'string' && value.length <= AVATAR_MAX_CHARS && AVATAR_DATA_URL_RE.test(value)
        ? value
        : '';
}

function bindAvatarUi() {
    $('#avatarUploadBtn').addEventListener('click', () => $('#avatarFileInput').click());
    $('#avatarResetBtn').addEventListener('click', () => applySelfAvatar(''));
    $('#avatarFileInput').addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        event.target.value = ''; // allow re-picking the same file
        if (!file) return;
        try {
            applySelfAvatar(await processAvatarFile(file));
        } catch {
            toast(t('chat.imageUnsupported'), 'warn');
        }
    });
}

function updateAvatarPreview() {
    $('#avatarPreview').replaceChildren(memberAvatarNode({ peer_name: selfName, avatar: selfAvatar }));
}

function applySelfAvatar(dataUrl) {
    selfAvatar = safeAvatarUrl(dataUrl);
    if (selfAvatar) localStorage.setItem(AVATAR_KEY, selfAvatar);
    else localStorage.removeItem(AVATAR_KEY);
    if (selfAvatar) avatars.set(selfName, selfAvatar);
    else avatars.delete(selfName);
    chat.setAvatar(selfName, selfAvatar);
    const me = members.get(socket.id);
    if (me) {
        me.avatar = selfAvatar || undefined;
        renderMembers();
    }
    updateAvatarPreview();
    if (joined) socket.emit('peerAvatar', { room_id: channelId, avatar: selfAvatar || null });
}

/**
 * Center-crop any image to a small square JPEG data URL that always fits the
 * avatar broadcast budget (shrinks size/quality until it does).
 */
async function processAvatarFile(file) {
    if (!file || !file.type.startsWith('image/') || file.type === 'image/gif') {
        throw new Error('not-image');
    }
    if (file.size > 8 * 1024 * 1024) throw new Error('too-large');
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('read-failed'));
        reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('not-image'));
        image.src = dataUrl;
    });

    const crop = (size) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(
            img,
            (img.naturalWidth - side) / 2,
            (img.naturalHeight - side) / 2,
            side,
            side,
            0,
            0,
            size,
            size
        );
        return canvas;
    };

    let out = '';
    for (const size of [96, 72, 56]) {
        const canvas = crop(size);
        for (const quality of [0.85, 0.7, 0.5]) {
            out = canvas.toDataURL('image/jpeg', quality);
            if (out.length <= 64 * 1024) return out;
        }
    }
    return out; // 56px q0.5 always lands well under the 96KB broadcast cap
}

function bindImageUi() {
    $('#imageBtn').addEventListener('click', () => $('#imageFileInput').click());
    $('#imageFileInput').addEventListener('change', (event) => {
        const files = [...(event.target.files || [])];
        event.target.value = ''; // allow re-picking the same file
        for (const file of files) addPendingImage(file);
    });

    // pasted images land in the composer tray, so text or more images can be
    // added before everything goes out together
    window.addEventListener('paste', (event) => {
        if (!joined) return;
        const items = event.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    event.preventDefault();
                    addPendingImage(file);
                    return;
                }
            }
        }
    });
}

// ----- pending image tray (composer attachments) -----

const MAX_PENDING_IMAGES = 6;
let pendingImages = []; // {id, file, url}
let pendingImageSeq = 0;

function addPendingImage(file) {
    if (!joined) return;
    if (!file || !file.type.startsWith('image/')) return toast(t('chat.imageUnsupported'), 'warn');
    if (file.size > 8 * 1024 * 1024) return toast(t('chat.imageTooLarge'), 'warn');
    if (pendingImages.length >= MAX_PENDING_IMAGES) return toast(t('chat.imageTooMany'), 'warn');
    pendingImages.push({ id: ++pendingImageSeq, file, url: URL.createObjectURL(file) });
    renderPendingImages();
}

function removePendingImage(id) {
    const index = pendingImages.findIndex((item) => item.id === id);
    if (index === -1) return;
    URL.revokeObjectURL(pendingImages[index].url);
    pendingImages.splice(index, 1);
    renderPendingImages();
}

function clearPendingImages() {
    for (const item of pendingImages) URL.revokeObjectURL(item.url);
    pendingImages = [];
    renderPendingImages();
}

function renderPendingImages() {
    const tray = $('#chatAttachments');
    tray.replaceChildren(
        ...pendingImages.map((item) =>
            el(
                'div',
                { class: 'chat-attachment' },
                el('img', { src: item.url, alt: t('chat.image') }),
                el('button', {
                    class: 'chat-attachment-remove',
                    type: 'button',
                    text: '✕',
                    'aria-label': 'remove image',
                    onclick: () => removePendingImage(item.id),
                })
            )
        )
    );
    tray.classList.toggle('hidden', !pendingImages.length);
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
        saveHostToken(token);
        hostToken = token;
        $('#hostReadyHint').classList.remove('hidden');
        closeHostModal();
        if (!joined) join({ textOnly: false });
        else location.reload(); // presenter status is granted at join time — rejoin with the token
    } catch (err) {
        const key = err?.status === 503 ? 'channel.hostLoginUnavailable' : 'channel.hostLoginFailed';
        $('#hostLoginError').textContent = t(key);
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
    clearPendingImages();
    for (const peerId of [...members.keys()]) dropPeer(peerId, { silent: true });
}

function teardownMedia() {
    stopMicTest();
    mesh?.close();
    if (localStream) localStream.getTracks().forEach((track) => track.stop());
    if (rawMicStream) rawMicStream.getTracks().forEach((track) => track.stop());
    rawMicStream = null;
    localStream = null;
    micProcessed = false;
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
    // auto-join keeps the overlay hidden — bring it back so the error is seen
    $('#joinOverlay').classList.remove('hidden');
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

// ---------------------------------------------------------------------------
// e2e inspection hook (only with #debug in the URL — never in normal use)
// ---------------------------------------------------------------------------

if (location.hash === '#debug') {
    window.__vcDebug = () => ({
        mode: webAudioPlayback() ? 'webaudio' : 'element',
        ctxState: hub?.ctx?.state ?? null,
        ctxTime: hub?.ctx?.currentTime ?? null,
        micRaw: hub?.mic?.raw.getAudioTracks().map((t) => `${t.readyState}:${t.enabled ? 'on' : 'off'}`).join(',') ?? null,
        micProcessed,
        micTest: micTest ? { delay: micTest.delay.delayTime.value, gain: micTest.gain.gain.value } : null,
        micVolume: settings.micVolume,
        micGain: hub?.mic?.gain.gain.value ?? null,
        // live sampling (not the throttled _tick values) — readable in background tabs
        levels: hub
            ? Object.fromEntries(
                  [...hub.watchers.entries()].map(([k, w]) => {
                      w.analyser.getByteFrequencyData(w.data);
                      let sum = 0;
                      for (let i = 0; i < w.data.length; i++) sum += w.data[i] * w.data[i];
                      return [k, Math.sqrt(sum / w.data.length) / 255];
                  }),
              )
            : null,
        tracks: hub
            ? [...hub.players.entries()].map(([k, p]) => ({
                  peer: k,
                  state: p.src.mediaStream
                      .getAudioTracks()
                      .map((t) => `${t.readyState}:${t.muted ? 'muted' : 'on'}`)
                      .join(','),
              }))
            : [],
        ctxSink: hub?.ctx?.sinkId ?? null,
        master: settings.volume,
        errs: window.__errs || [],
        peers: [...members.entries()]
            .filter(([, info]) => !info.self)
            .map(([peerId, info]) => ({
                name: info.peer_name,
                volume: info.volume ?? 1,
                gain: hub?.players.get(peerId)?.gain.gain.value ?? null,
                elVolume: audioEls.get(peerId)?.volume ?? null,
            })),
    });
    // e2e aid: swap the outgoing mic track for a synthetic sine — verifies the
    // WebRTC chain without depending on acoustic mic/speaker hardware
    window.__vcTone = async (ms = 3000) => {
        if (!mesh || !hub?.ctx || !localStream) return 'not-ready';
        const osc = hub.ctx.createOscillator();
        osc.frequency.value = 880;
        const g = hub.ctx.createGain();
        g.gain.value = 0.7;
        const an = hub.ctx.createAnalyser();
        an.fftSize = 512;
        osc.connect(g);
        g.connect(an);
        let restore = null;
        if (micProcessed && hub.mic) {
            g.connect(hub.mic.gain); // rides the input-gain pipeline
        } else {
            const dest = hub.ctx.createMediaStreamDestination();
            g.connect(dest);
            mesh.replaceAudioTrack(dest.stream.getAudioTracks()[0], dest.stream);
            restore = () => mesh.replaceAudioTrack(localStream.getAudioTracks()[0], localStream);
        }
        const data = new Uint8Array(an.frequencyBinCount);
        window.__vcToneLevel = 0;
        osc.start();
        osc.stop(hub.ctx.currentTime + ms / 1000); // audio-clock schedule: background-tab timer throttling can't stall it
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            await new Promise((r) => setTimeout(r, 300));
            an.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
            window.__vcToneLevel = Math.sqrt(sum / data.length) / 255;
        }
        g.disconnect();
        if (restore) restore();
        return 'done';
    };
    window.__vcStats = async () => {
        if (!mesh) return null;
        const out = [];
        for (const [peerId, entry] of mesh.entries) {
            const stats = await entry.pc.getStats();
            const rows = [];
            stats.forEach((r) => {
                if (r.type === 'inbound-rtp' && r.kind === 'audio')
                    rows.push({ dir: 'in', bytes: r.bytesReceived, packets: r.packetsReceived, lost: r.packetsLost });
                if (r.type === 'outbound-rtp' && r.kind === 'audio')
                    rows.push({ dir: 'out', bytes: r.bytesSent, packets: r.packetsSent });
            });
            out.push({ peerId, state: entry.pc.connectionState, rows });
        }
        return out;
    };
    // probe: is a FRESH Web Audio tap on the (now flowing) remote stream live,
    // and does a muted <audio> element prime the pipeline?
    window.__vcRetap = async (ms = 1200) => {
        if (!hub?.ctx) return 'no-ctx';
        const out = {};
        for (const [peerId, player] of hub.players) {
            const stream = player.src.mediaStream;
            const measure = () =>
                new Promise((resolve) => {
                    const an = hub.ctx.createAnalyser();
                    an.fftSize = 512;
                    hub.ctx.createMediaStreamSource(stream).connect(an);
                    const data = new Uint8Array(an.frequencyBinCount);
                    setTimeout(() => {
                        an.getByteFrequencyData(data);
                        let sum = 0;
                        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
                        resolve(Math.sqrt(sum / data.length) / 255);
                    }, ms);
                });
            out[peerId] = { fresh: await measure() };
            const el = document.createElement('audio');
            el.srcObject = stream;
            el.muted = true;
            await el.play().catch(() => {});
            out[peerId].withMutedEl = await measure();
            el.srcObject = null;
            el.remove();
        }
        return out;
    };
    // probe: force the AudioContext suspended/running to test the fallback migration
    window.__vcCtx = (op) => (op === 'suspend' ? hub?.ctx?.suspend() : hub?.ctx?.resume());
    // probe: persistent tap on the outgoing (post-gain) mic stream; sync read, external pacing
    window.__vcOutTap = () => {
        if (!hub?.ctx || !hub.mic) return null;
        if (!window.__outTap || window.__outTapKey !== hub.mic) {
            try {
                window.__outTap?.src.disconnect();
            } catch {
                /* stale tap */
            }
            const src = hub.ctx.createMediaStreamSource(hub.mic.stream);
            const an = hub.ctx.createAnalyser();
            an.fftSize = 2048;
            src.connect(an);
            window.__outTap = { src, an, data: new Float32Array(an.fftSize) };
            window.__outTapKey = hub.mic;
        }
        const { an, data } = window.__outTap;
        an.getFloatTimeDomainData(data); // linear scale — the dB-mapped byte readout hides gain changes
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        return Number(Math.sqrt(sum / data.length).toFixed(4));
    };
    // probe: linear RMS of the first remote peer stream (receive side)
    window.__vcPeerRms = () => {
        const w = hub?.watchers && [...hub.watchers.entries()].find(([k]) => k !== 'self');
        if (!w) return null;
        const an = w[1].analyser;
        const data = new Float32Array(an.fftSize);
        an.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        return Number(Math.sqrt(sum / data.length).toFixed(4));
    };
}
