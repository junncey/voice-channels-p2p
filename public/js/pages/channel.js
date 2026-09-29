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
import { initI18n, t } from '/js/core/i18n.js';
import { $, el, avatarColor, randomNick, copyText } from '/js/core/utils.js';

const NICK_KEY = 'vc_nick';
const HOST_TOKEN_PREFIX = 'vc_host_token_';
const AUDIO_SETTINGS_KEY = 'vc_audio_settings';
const PTT_KEY_CODE = 'KeyV';

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

const sinkSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const defaultAudioSettings = {
    micDeviceId: '',
    spkDeviceId: '',
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
let hostToken = sessionStorage.getItem(HOST_TOKEN_PREFIX + channelId) || '';

/** peerId -> { peer_name, peer_presenter, peer_audio_status, joined_at, self } */
const members = new Map();
const audioEls = new Map(); // peerId -> HTMLAudioElement

const imageReceiver = createImageReceiver({
    onDone: ({ from, dataUrl }) => {
        chat.addImage({ name: from || '?', src: dataUrl, alt: t('chat.image') });
    },
    onFail: () => chat.add({ text: t('chat.imageBroken'), system: true }),
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
    chat = initChat($('#chatMessages'), { emptyText: t('chat.empty'), downloadText: t('chat.saveImage') });
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

    selfName = nick;
    selfUuid = crypto.randomUUID();
    localStorage.setItem(NICK_KEY, nick);
    textOnly = asTextOnly;

    if (!textOnly) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() });
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
    if (localStream && hub.ctx) hub.watch('self', localStream, localLevelCb);

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
    socket.on('connect', () => {
        socket.emit('join', {
            channel: channelId,
            peer_uuid: selfUuid,
            peer_name: selfName,
            peer_token: hostToken || undefined,
            peer_audio: onAir(),
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
                audio.volume = settings.volume;
                document.body.append(audio);
                audioEls.set(peerId, audio);
                applySink(audio);
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
            if (!data || typeof data !== 'object') return;
            if (data.type === 'chat') {
                const name = members.get(peerId)?.peer_name || String(data.from || '').slice(0, 24) || '?';
                chat.add({ name, text: String(data.msg || '').slice(0, 500) });
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
        peer_audio_status: onAir(),
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
    renderMembers();
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
async function reacquireMic() {
    const hadStream = !!localStream;
    const stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
    const track = stream.getAudioTracks()[0];
    // a device/processing change keeps the current mute state; enabling voice turns the mic on
    micOn = hadStream ? micOn : true;
    textOnly = false;
    track.enabled = onAir();
    mesh?.replaceAudioTrack(track, stream);
    localStream?.getTracks().forEach((old) => old.stop());
    localStream = stream;
    if (hub) await hub.ensureContext().catch(() => {});
    if (hub?.ctx) hub.watch('self', stream, localLevelCb);
    ensureSelfMember();
    applyMicState();
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
// audio settings modal
// ---------------------------------------------------------------------------

function bindSettingsUi() {
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#settingsCloseBtn').addEventListener('click', closeSettings);
    $('#settingsModal').addEventListener('click', (event) => {
        if (event.target === $('#settingsModal')) closeSettings();
    });

    $('#micDeviceSelect').addEventListener('change', (event) => {
        settings.micDeviceId = event.target.value;
        saveAudioSettings();
        // switching device in text-only mode doubles as "enable voice"
        if (localStream) reacquireMic().catch(() => toast(t('channel.errors.micDenied'), 'warn'));
        else enableVoice();
    });

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

    $('#spkDeviceSelect').addEventListener('change', (event) => {
        settings.spkDeviceId = event.target.value;
        saveAudioSettings();
        for (const audio of audioEls.values()) applySink(audio);
    });

    $('#volumeSlider').addEventListener('input', (event) => {
        settings.volume = Number(event.target.value) / 100;
        $('#volumeVal').textContent = `${event.target.value}%`;
        for (const audio of audioEls.values()) audio.volume = settings.volume;
        saveAudioSettings();
    });

    $('#testMicBtn').addEventListener('click', onTestMicClick);
    $('#testSpkBtn').addEventListener('click', playTestBeep);

    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDeviceSelects);
}

function openSettings() {
    $('#micDeviceSelect').value = settings.micDeviceId;
    $('#nsToggle').checked = settings.noiseSuppression;
    $('#ecToggle').checked = settings.echoCancellation;
    $('#agcToggle').checked = settings.autoGainControl;
    $('#pttToggle').checked = settings.ptt;
    $('#spkDeviceSelect').disabled = !sinkSupported;
    $('#sinkUnsupported').classList.toggle('hidden', sinkSupported);
    const pct = Math.round(settings.volume * 100);
    $('#volumeSlider').value = String(pct);
    $('#volumeVal').textContent = `${pct}%`;
    refreshDeviceSelects();
    $('#settingsModal').classList.remove('hidden');
}

function closeSettings() {
    $('#settingsModal').classList.add('hidden');
    stopMicTest();
}

async function refreshDeviceSelects() {
    let devices = [];
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
        return;
    }
    fillDeviceSelect($('#micDeviceSelect'), devices.filter((d) => d.kind === 'audioinput'), settings.micDeviceId, t('settings.deviceMic'));
    fillDeviceSelect($('#spkDeviceSelect'), devices.filter((d) => d.kind === 'audiooutput'), settings.spkDeviceId, t('settings.deviceSpk'));
}

function fillDeviceSelect(select, devices, selectedId, genericLabel) {
    select.replaceChildren(el('option', { value: '', text: t('settings.defaultDevice') }));
    devices.forEach((device, index) => {
        const label = (device.label || '').trim() || `${genericLabel} ${index + 1}`;
        select.append(el('option', { value: device.deviceId, text: label.slice(0, 60) }));
    });
    select.value = devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
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

// ----- mic test: record a few seconds, then play it back -----

let micTest = null; // { rec, timer }

async function onTestMicClick() {
    if (micTest) {
        stopMicTest();
        return;
    }
    if (!localStream) {
        await enableVoice();
        if (!localStream) return;
    }
    if (typeof MediaRecorder === 'undefined') return toast(t('settings.micTestUnsupported'), 'warn');

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(localStream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
    };
    rec.onstop = () => {
        if (!micTest) return;
        clearTimeout(micTest.timer);
        micTest = null;
        resetTestMicBtn();
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (!blob.size) return;
        const url = URL.createObjectURL(blob);
        const playback = new Audio(url);
        playback.volume = Math.max(0.2, settings.volume);
        applySink(playback);
        playback.onended = () => URL.revokeObjectURL(url);
        playback.play().catch(() => URL.revokeObjectURL(url));
    };
    rec.start();
    micTest = { rec, timer: setTimeout(() => rec.state !== 'inactive' && rec.stop(), 10000) };
    const btn = $('#testMicBtn');
    btn.classList.add('recording');
    btn.textContent = t('settings.stopMicTest');
}

function stopMicTest() {
    if (!micTest) return;
    const rec = micTest.rec;
    clearTimeout(micTest.timer);
    micTest = null;
    resetTestMicBtn();
    if (rec.state !== 'inactive') rec.stop();
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

// ---------------------------------------------------------------------------
// chat + image sending
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

function bindImageUi() {
    $('#imageBtn').addEventListener('click', () => $('#imageFileInput').click());
    $('#imageFileInput').addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = ''; // allow re-picking the same file
        if (file) sendImageFile(file);
    });

    // paste an image straight from the clipboard, wherever the focus is
    window.addEventListener('paste', (event) => {
        if (!joined) return;
        const items = event.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    event.preventDefault();
                    sendImageFile(file);
                    return;
                }
            }
        }
    });
}

async function sendImageFile(file) {
    if (!joined) return;
    let payload;
    try {
        payload = await fileToImageMessage(file);
    } catch (err) {
        const key = err?.message === 'too-large' ? 'chat.imageTooLarge' : 'chat.imageUnsupported';
        toast(t(key), 'warn');
        return;
    }
    sendImageData({
        send: (frame) => mesh.sendChat(frame),
        from: selfName,
        mime: payload.mime,
        dataUrl: payload.dataUrl,
    });
    chat.addImage({ name: selfName, self: true, src: payload.dataUrl, alt: t('chat.image') });
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
    stopMicTest();
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
