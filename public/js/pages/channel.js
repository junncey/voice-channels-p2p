/*
Channel page controller — assembly + shared state.

Holds the page-wide mutable state (socket/mesh/hub/chat, session identity,
streams — exposed to the submodules via the `s` accessor object) and the
late-bound cross-module surface `x`, then wires the submodules of
js/pages/channel/ together:

  recovery.js      media/signaling self-healing ladder + path monitor
  members.js       member list UI + roster sync + host moderation
  voice.js         mic/deafen/PTT controls + audio pipeline + playback
  settings.js      settings modal (devices/volumes/appearance/avatar)
  composer.js      chat composer (reply/edit/typing/mention/images)
  notify.js        unread title badge + @mention notifications
  offline.js       offline banner (navigator.onLine strip)
  hostAuth.js      host login + channel-password persistence
  socketEvents.js  socket.io event wiring + chat history pagination

The controller keeps the join flow, the mesh callbacks, page lifecycle
(leave/teardown/overlays) and the #debug probes (installed at the file
tail, per project convention).
*/

import { api } from '/js/core/api.js';
import { Mesh } from '/js/core/webrtc.js';
import { AudioHub, getTestBeepUrl } from '/js/core/audio.js';
import { initChat, escapeRegExp, validReply } from '/js/core/chat.js';
import { openEmojiPicker } from '/js/core/emoji.js';
import { fileToImageMessage, sendImageData, createImageReceiver, DATA_URL_RE } from '/js/core/images.js';
import { createDropdown } from '/js/core/dropdown.js';
import { initI18n, t, getLang, setLang } from '/js/core/i18n.js';
import { initSoundSettings, playSound } from '/js/core/sound.js';
import { initVersionCheck } from '/js/core/version.js';
import { getThemePref, setThemePref } from '/js/core/theme.js';
import { createWakeLock } from '/js/pages/channel/wakeLock.js';
import { createShareSound } from '/js/pages/channel/share.js';
import { installDebugHooks } from '/js/pages/channel/debug.js';
import { createRecovery } from '/js/pages/channel/recovery.js';
import { createMembers } from '/js/pages/channel/members.js';
import { createVoice } from '/js/pages/channel/voice.js';
import { createSettings } from '/js/pages/channel/settings.js';
import { createComposer } from '/js/pages/channel/composer.js';
import { createNotify } from '/js/pages/channel/notify.js';
import { createOfflineBanner } from '/js/pages/channel/offline.js';
import { createHostAuth, loadHostToken, loadChannelPw } from '/js/pages/channel/hostAuth.js';
import { createSocketEvents } from '/js/pages/channel/socketEvents.js';
import { $, el, avatarColor, randomNick, copyText, toast } from '/js/core/utils.js';

const NICK_KEY = 'vc_nick';
const AUDIO_SETTINGS_KEY = 'vc_audio_settings';
const PEER_VOLUMES_KEY = 'vc_peer_volumes';
const AVATAR_KEY = 'vc_avatar';
const AVATAR_MAX_CHARS = 96 * 1024; // broadcast/storage cap for the avatar data URL
const AVATARS_MAX = 100; // hard cap on remembered peer avatars (flood guard)

const LOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const UNLOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

// ---------------------------------------------------------------------------
// shared state
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
    musicMode: false,
    opusBitrate: 64, // encoder cap in kbps (BITRATE_MIN..BITRATE_MAX)
};

// Opus send caps stamped onto every local offer/answer and live senders:
// voice favors bandwidth discipline (usedtx stops sending during silence),
// music favors fidelity (stereo). null deletes the key — each dict states the
// FULL desired state so switching modes on a live connection can't leave the
// other mode's params behind in re-offers. The bitrate ceiling is the user's
// slider (settings.opusBitrate, kbps); toggling music mode re-seeds it with
// the mode's default (192 / 64), after which it stays hand-tunable.
const BITRATE_MIN = 24;
const BITRATE_MAX = 256;

function loadAudioSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || '{}');
        const merged = { ...defaultAudioSettings, ...stored };
        // pre-slider music-mode users never stored a bitrate — keep their 192k
        // ceiling instead of silently dropping them to the voice default
        if (stored.opusBitrate === undefined && merged.musicMode) merged.opusBitrate = 192;
        return merged;
    } catch {
        return { ...defaultAudioSettings };
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

/** Opus caps for the mesh (passed as getOpusFmtp — read at every SDP round). */
function opusFmtp() {
    const raw = Math.round(Number(settings.opusBitrate));
    const kbps = Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, raw || 64));
    const maxaveragebitrate = kbps * 1000;
    if (shareSound.active()) {
        // shared music needs bandwidth and stereo. The mic's processing
        // toggles stay untouched on purpose: on speakers, AEC is what keeps
        // the shared audio from leaking back in through the mic. Stereo
        // engages on the next SDP round (reverse offer / ICE restart); the
        // bitrate half applies at once via setParameters.
        return { maxaveragebitrate: Math.max(maxaveragebitrate, 192000), stereo: 1, usedtx: null };
    }
    return settings.musicMode
        ? { maxaveragebitrate, stereo: 1, usedtx: null }
        : { maxaveragebitrate, usedtx: 1, stereo: null };
}

let settings = loadAudioSettings();
let channelMeta = null;
let socket = null;
let mesh = null;
let hub = null;
let chat = null;

let selfName = '';
let selfUuid = null;
let joined = false;
// set before in-app navigations (leave/reload) so the beforeunload prompt
// doesn't fire for exits the user explicitly asked for
let intentionalUnload = false;
let textOnly = false;
let micOn = false;
let deafened = false; // self-deafen: silence every remote member locally
let isPresenter = false;
let joinLockOn = false;
let localStream = null;
let rawMicStream = null; // straight from getUserMedia, before the input gain
let hostToken = loadHostToken(channelId);
// channel join password: pre-filled from storage for the auto-join path,
// otherwise taken from the overlay input at join time
let channelPassword = '';

/** peerId -> { peer_name, peer_presenter, peer_audio_status, joined_at, volume, self } */
const members = new Map();
const audioEls = new Map(); // peerId -> HTMLAudioElement (fallback playback path)
/** display name -> custom avatar data URL (validated) */
const avatars = new Map();
let selfAvatar = safeAvatarUrl(localStorage.getItem(AVATAR_KEY));

// Live view of the shared `let` state for the submodules: closures capture
// bindings, property reads stay fresh across reassignments.
const s = {
    get channelMeta() {
        return channelMeta;
    },
    set channelMeta(v) {
        channelMeta = v;
    },
    get socket() {
        return socket;
    },
    set socket(v) {
        socket = v;
    },
    get mesh() {
        return mesh;
    },
    set mesh(v) {
        mesh = v;
    },
    get hub() {
        return hub;
    },
    set hub(v) {
        hub = v;
    },
    get chat() {
        return chat;
    },
    set chat(v) {
        chat = v;
    },
    get selfName() {
        return selfName;
    },
    set selfName(v) {
        selfName = v;
    },
    get selfUuid() {
        return selfUuid;
    },
    set selfUuid(v) {
        selfUuid = v;
    },
    get joined() {
        return joined;
    },
    set joined(v) {
        joined = v;
    },
    get intentionalUnload() {
        return intentionalUnload;
    },
    set intentionalUnload(v) {
        intentionalUnload = v;
    },
    get textOnly() {
        return textOnly;
    },
    set textOnly(v) {
        textOnly = v;
    },
    get micOn() {
        return micOn;
    },
    set micOn(v) {
        micOn = v;
    },
    get deafened() {
        return deafened;
    },
    set deafened(v) {
        deafened = v;
    },
    get isPresenter() {
        return isPresenter;
    },
    set isPresenter(v) {
        isPresenter = v;
    },
    get joinLockOn() {
        return joinLockOn;
    },
    set joinLockOn(v) {
        joinLockOn = v;
    },
    get localStream() {
        return localStream;
    },
    set localStream(v) {
        localStream = v;
    },
    get rawMicStream() {
        return rawMicStream;
    },
    set rawMicStream(v) {
        rawMicStream = v;
    },
    get hostToken() {
        return hostToken;
    },
    set hostToken(v) {
        hostToken = v;
    },
    get channelPassword() {
        return channelPassword;
    },
    set channelPassword(v) {
        channelPassword = v;
    },
    get selfAvatar() {
        return selfAvatar;
    },
    set selfAvatar(v) {
        selfAvatar = v;
    },
};

// Late-bound cross-module surface: filled once every factory below has run
// (event handlers only ever fire after that), so submodules can call each
// other and the controller without import cycles.
const x = {};

// ----- screen wake lock (mobile: a locked screen kills the voice session) -----
// Holder lives in ./channel/wakeLock.js; it re-arms itself on visibility
// changes. request() rejects while hidden, so "wanted" includes visible.

const screenLock = createWakeLock({
    wanted: () => joined && !textOnly && document.visibilityState === 'visible',
});

// ----- "listen together": shared sound mixed into the outgoing voice -----
// Holder lives in ./channel/share.js (getDisplayMedia orchestration); the
// mixing itself is AudioHub.attachShare into the mic pipeline's destination.

const shareSound = createShareSound({
    isJoined: () => joined,
    ensureVoice: async () => {
        if (!localStream) await x.enableVoice(); // text-only member: prompt for the mic
        return !!localStream;
    },
    getHub: () => hub,
    pipelineReady: () => voice.micProcessed && hub?.ctx?.state === 'running',
    applyGate: () => x.applyMicState(),
    broadcast: (on) => x.broadcastShare(on),
    refreshBitrate: () => mesh?.setSendBitrate(),
    toast,
});

const imageReceiver = createImageReceiver({
    onDone: ({ from, dataUrl, batch, peerId }) => {
        if (batch) chat.addBatchImage(batch, dataUrl, t('chat.image'));
        else {
            // a lone image IS the message — batched ones already chimed with
            // their 'chat' text frame. The display name comes from the
            // DataChannel peer, not the self-declared 'from' field.
            const name = members.get(peerId)?.peer_name || from || '?';
            chat.addImage({ name, src: dataUrl, alt: t('chat.image') });
            playSound('message');
            notify.noteIncomingMessage(name, '');
        }
    },
    onFail: (reason, batch) => {
        if (batch) chat.failBatchImage(batch);
        else chat.add({ text: t('chat.imageBroken'), system: true });
    },
});

// ---------------------------------------------------------------------------
// submodule wiring
// ---------------------------------------------------------------------------

const rec = createRecovery({ s, x, members, $, el, t });
const mem = createMembers({
    s,
    x,
    rec,
    members,
    avatars,
    audioEls,
    channelId,
    peerVolumes,
    shareSound,
    avatarColor,
    AVATAR_MAX_CHARS,
    AVATARS_MAX,
    DATA_URL_RE,
    $,
    el,
    t,
});
const voice = createVoice({ s, x, mem, members, audioEls, settings, channelId, screenLock, playSound, t, $, el });
const notify = createNotify({ s, x, channelId, escapeRegExp, toast, t });
const composer = createComposer({
    s,
    x,
    members,
    channelId,
    openEmojiPicker,
    fileToImageMessage,
    sendImageData,
    toast,
    t,
    $,
    el,
});
const hostAuth = createHostAuth({ s, x, channelId, api, t, $ });
const se = createSocketEvents({
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
});
const settingsUi = createSettings({
    s,
    x,
    mem,
    members,
    avatars,
    settings,
    channelId,
    AVATAR_KEY,
    AUDIO_SETTINGS_KEY,
    PEER_VOLUMES_KEY,
    defaultAudioSettings,
    sinkSupported,
    safeAvatarUrl,
    DATA_URL_RE,
    createDropdown,
    initSoundSettings,
    getTestBeepUrl,
    getThemePref,
    setThemePref,
    getLang,
    setLang,
    toast,
    t,
    $,
    el,
});

Object.assign(x, {
    // controller surface
    join,
    leave,
    teardown,
    teardownMedia,
    showJoinError,
    showJoinFatal,
    setOverlayBusy,
    updateHeaderActions,
    localLevelCb,
    opusFmtp,
    toast,
    shareSound,
    peerVolumes,
    // submodules
    rec,
    mem,
    voice,
    notify,
    composer,
    hostAuth,
    se,
    settings: settingsUi,
    // frequently reached functions, flat for brevity in the submodules
    dropPeer: mem.dropPeer,
    onAir: voice.onAir,
    setMic: voice.setMic,
    applyMicState: voice.applyMicState,
    resetPtt: voice.resetPtt,
    syncPttHoldButton: voice.syncPttHoldButton,
    applyDeafenState: voice.applyDeafenState,
    broadcastShare: voice.broadcastShare,
    enableVoice: voice.enableVoice,
    reacquireMicOrToast: voice.reacquireMicOrToast,
    applySpeaker: voice.applySpeaker,
    reapplyAllVolumes: voice.reapplyAllVolumes,
    applySink: settingsUi.applySink,
    refreshDeviceSelects: settingsUi.refreshDeviceSelects,
    savePeerVolume: settingsUi.savePeerVolume,
    saveChannelPw: hostAuth.saveChannelPw,
    clearChannelPw: hostAuth.clearChannelPw,
    clearHostToken: hostAuth.clearHostToken,
    onNotifyToggle: notify.onNotifyToggle,
    isNotifyEnabled: notify.isNotifyEnabled,
    notifySupported: notify.notifySupported,
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
    // a reload drops the call, so ask first while any peer link is up
    initVersionCheck({ isBusy: () => !!mesh && mesh.entries.size > 0 });
    createOfflineBanner({ t });
    chat = initChat($('#chatMessages'), {
        emptyText: t('chat.empty'),
        downloadText: t('chat.saveImage'),
        yesterdayText: t('chat.yesterday'),
        todayText: t('chat.today'),
        deletedText: t('chat.deleted'),
        editedText: t('chat.editedMark'),
        avatarFor: (name) => avatars.get(name) || '',
        imagesProgress: (got, total) => t('chat.imagesProgress', { got, total }),
        failText: t('chat.imageBroken'),
        historyLoadingText: t('chat.historyLoading'),
        historyEndText: t('chat.historyEnd'),
        // include OUR OWN name: seeing yourself highlighted is the whole point,
        // and .mention.self is keyed off it (chat.js compares with selfName)
        mentionNames: () => [...members.values()].map((m) => m.peer_name),
        selfName: () => selfName,
        isHost: () => isPresenter,
        onReply: composer.startReply,
        onEdit: composer.startEdit,
        onDelete: ({ name, ts }) => {
            if (!socket || !joined) return;
            socket.emit('chatDelete', { room_id: channelId, ts, name });
        },
        onReact: ({ name, ts, emoji, on }) => {
            if (!socket || !joined) return;
            socket.emit('chatReact', { room_id: channelId, ts, name, emoji, op: on ? 'add' : 'remove' });
        },
        jumpNewText: (n) => t('chat.jumpNew', { n }),
        jumpText: t('chat.jumpBottom'),
    });
    se.bindHistoryPaging($('#chatMessages'));
    bindUi();
    voice.bindPttKeys();

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
    notify.setBaseTitle(`${channelMeta.name || channelId} · ${t('app.name')}`);

    const presetName = new URLSearchParams(location.search).get('name');
    const savedNick = presetName || localStorage.getItem(NICK_KEY) || '';
    $('#nickInput').value = savedNick || randomNick(t('channel.guest'));
    if (hostToken) $('#hostReadyHint').classList.remove('hidden');

    // Password-protected channel: hosts pass with their own login, everyone
    // else must type the password (or have it remembered from a previous join)
    const pwFieldVisible = !!channelMeta.hasPassword && !hostToken;
    $('#joinPasswordField').classList.toggle('hidden', !pwFieldVisible);
    if (pwFieldVisible) {
        channelPassword = loadChannelPw(channelId);
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
    $('#backBtn').addEventListener('click', leave);
    $('#joinBtn').addEventListener('click', () => join({ textOnly: false }));
    $('#textOnlyBtn').addEventListener('click', () => join({ textOnly: true }));

    $('#hostLoginBtn').addEventListener('click', hostAuth.openHostModal);
    $('#hostLoginEntryBtn').addEventListener('click', hostAuth.openHostModal);
    $('#hostCancelBtn').addEventListener('click', hostAuth.closeHostModal);
    $('#hostLoginForm').addEventListener('submit', hostAuth.onHostLoginSubmit);

    $('#renameCancelBtn').addEventListener('click', mem.closeRenameModal);
    $('#renameForm').addEventListener('submit', mem.onRenameSubmit);
    $('#renameModal').addEventListener('click', (event) => {
        if (event.target === $('#renameModal')) mem.closeRenameModal();
    });

    $('#copyLinkBtn').addEventListener('click', async () => {
        const ok = await copyText(`${location.origin}/c/${channelId}`);
        if (ok) toast(t('channel.copied'), 'ok');
    });

    $('#exportChatBtn').addEventListener('click', async () => {
        if (!isPresenter || !hostToken) return;
        try {
            await api.hostExport(channelId, hostToken);
            toast(t('channel.exportDone'), 'ok');
        } catch (err) {
            toast(err?.status === 404 ? t('channel.errors.channelNotFound') : t('common.error'), 'warn');
        }
    });

    $('#leaveBtn').addEventListener('click', leave);
    $('#outageActionBtn').addEventListener('click', () => {
        if ($('#outageBanner').dataset.mode === 'failed') {
            intentionalUnload = true;
            location.reload();
        } else rec.attemptSignalingReconnect({ manual: true });
    });
    $('#micBtn').addEventListener('click', voice.onMicBtnClick);
    $('#deafenBtn').addEventListener('click', voice.toggleDeafen);
    $('#shareSoundBtn').addEventListener('click', () => (shareSound.active() ? shareSound.stop() : shareSound.start()));
    voice.bindPttHoldButton();
    $('#chatForm').addEventListener('submit', composer.onChatSubmit);
    composer.bindChatInput();
    composer.bindChatSearch();
    settingsUi.bindAppearanceControls();

    composer.bindImageUi();
    settingsUi.bindSettingsUi();

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

    // the version bar reloads after its own confirmation — take that as a yes
    // so the browser doesn't ask a second time (see reloadNow in version.js)
    window.addEventListener('vc:unload-intent', () => {
        intentionalUnload = true;
    });
    // Native "leave site?" confirmation while connected to the channel —
    // browsers render their own localized text, returnValue is the legacy
    // Chrome/Edge toggle. No cleanup here: the dialog is cancellable and the
    // session must keep working afterwards, so teardown waits for pagehide
    // (which only fires on a real unload, including the iOS swipe-away that
    // skips beforeunload entirely).
    window.addEventListener('beforeunload', (e) => {
        if (intentionalUnload || !joined) return;
        e.preventDefault();
        e.returnValue = '';
    });
    window.addEventListener('pagehide', () => {
        socket?.disconnect();
        teardownMedia();
    });
    // Back from bfcache: pagehide already dropped the socket and the mic, but
    // the page still looks joined — a silent, deaf channel. Reload to rejoin
    // instead of leaving the user talking to nobody.
    window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return;
        intentionalUnload = true;
        location.reload();
    });
    // (wake lock re-arming on visibilitychange is owned by channel/wakeLock.js)
}

// ---------------------------------------------------------------------------
// join flow
// ---------------------------------------------------------------------------

let joining = false;

async function join({ textOnly: asTextOnly }) {
    // re-entrancy guard: Enter on the nick/password inputs can fire a second
    // join before the first reaches setOverlayBusy (its awaits span mic setup);
    // the first socket would be orphaned server-side as a ghost session
    if (joining) return;
    joining = true;
    try {
        await joinInner({ textOnly: asTextOnly });
    } finally {
        joining = false;
    }
}

async function joinInner({ textOnly: asTextOnly }) {
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
    for (const peerId of [...members.keys()]) mem.dropPeer(peerId, { silent: true });

    selfName = nick;
    selfUuid = crypto.randomUUID();
    localStorage.setItem(NICK_KEY, nick);
    textOnly = asTextOnly;

    if (!textOnly) {
        try {
            rawMicStream = await navigator.mediaDevices.getUserMedia(voice.buildAudioConstraints());
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
        hub.ctx.addEventListener('statechange', voice.onCtxStateChange);
        const resume = () => hub?.ctx?.resume().catch(() => {});
        window.addEventListener('pointerdown', resume, { once: true });
        window.addEventListener('keydown', resume, { once: true });
    }
    voice.syncMicPipeline(); // may swap localStream to the gain-processed stream
    if (localStream && hub.ctx) hub.watch('self', localStream, localLevelCb);
    voice.applySpeaker(); // route Web Audio playback to the chosen output from the start

    // Faster reconnect cadence than the socket.io defaults (1000..5000ms with
    // 0.5 jitter): a VPN/accelerator switch kills the websocket for a few
    // seconds and the default backoff can sit idle for up to 5s after the
    // network is already back. Sub-second first retry, 2s cap, and a bounded
    // per-attempt handshake timeout so a half-open tunnel can't stall one
    // retry for the engine's 20s default.
    socket = io({
        transports: ['websocket'],
        reconnectionDelay: 400,
        reconnectionDelayMax: 2000,
        randomizationFactor: 0.3,
        timeout: 8000,
    });
    mesh = new Mesh({ signaling: socket, handlers: meshHandlers(), getOpusFmtp: opusFmtp });
    if (localStream) mesh.setLocalStream(localStream);

    se.registerSocketHandlers();

    setOverlayBusy(true);
    micOn = !textOnly && !!localStream;
    voice.applyMicState(); // no socket yet — just refresh buttons; peer_audio goes in the join payload
    voice.seedLastOnAir(); // baseline must match that payload, else the first mute toggle would not broadcast
}

function localLevelCb({ level }) {
    const pct = `${Math.min(100, Math.round(level * 220))}%`;
    $('#micLevelBar').style.width = pct;
    $('#settingsMicBar').style.width = pct;
}

// ---------------------------------------------------------------------------
// mesh callbacks
// ---------------------------------------------------------------------------

function meshHandlers() {
    return {
        onRemoteStream(peerId, stream) {
            voice.attachRemoteAudio(peerId, stream);
            if (hub?.ctx) {
                hub.watch(peerId, stream, ({ level, speaking }) => {
                    const node = $(`#memberList .member[data-id="${peerId}"]`);
                    if (!node) return;
                    node.classList.toggle('speaking', speaking);
                    // continuous ring: the avatar glow breathes with the level
                    node.style.setProperty('--lvl', (Math.min(1, level * 2.2) || 0).toFixed(3));
                });
            }
        },
        onChat(peerId, data) {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'typing') {
                // the sender's identity is the DataChannel peer, not `from`
                composer.notePeerTyping(members.get(peerId)?.peer_name || String(data.from || '').slice(0, 24));
                return;
            }
            if (data.type === 'chat') {
                const name = members.get(peerId)?.peer_name || String(data.from || '').slice(0, 24) || '?';
                const batch = typeof data.batch === 'string' && data.batch.length <= 64 ? data.batch : '';
                const imgs = Number(data.imgs);
                const text = String(data.msg || '').slice(0, 500);
                const reply = validReply(data.reply);
                if (batch && Number.isInteger(imgs) && imgs > 0 && imgs <= 9) {
                    // one send of text + N images renders as ONE merged bubble
                    chat.openBatch({ batch, name, text, count: imgs, reply });
                } else {
                    chat.add({ name, text, reply });
                }
                playSound('message');
                notify.noteIncomingMessage(name, text);
                return;
            }
            if (data.type === 'img-start' || data.type === 'img-chunk' || data.type === 'img-end') {
                imageReceiver(data, peerId);
            }
        },
        onPeerState(peerId, state) {
            const node = $(`#memberList .member[data-id="${peerId}"]`);
            if (node) node.classList.toggle('bad', state === 'failed' || state === 'disconnected');
            rec.notePeerState(peerId, state);
            // first path read right after the link settles; the poll keeps it fresh
            if (state === 'connected') rec.checkPeerPath(peerId, rec.PATH_FIRST_CHECK_MS);
        },
    };
}

// ---------------------------------------------------------------------------
// header actions (host badge / export / join lock)
// ---------------------------------------------------------------------------

function updateHeaderActions() {
    $('#hostBadge').classList.toggle('hidden', !isPresenter);
    // host chat export (Markdown) — presenters only, served with the host JWT
    $('#exportChatBtn').classList.toggle('hidden', !isPresenter);
    // host login stays reachable after the auto-join (no pre-join overlay)
    $('#hostLoginEntryBtn').classList.toggle('hidden', !(joined && !isPresenter));
    const lockBtn = $('#lockBtn');
    lockBtn.classList.toggle('hidden', !isPresenter);
    if (isPresenter) {
        mem.setIconBtn(
            lockBtn,
            joinLockOn ? LOCK_SVG : UNLOCK_SVG,
            joinLockOn ? t('channel.unlockBtn') : t('channel.lockBtn')
        );
    }
}

// ---------------------------------------------------------------------------
// leave / teardown / overlay states
// ---------------------------------------------------------------------------

function leave() {
    // intentional exit: teardown marks us as not joined BEFORE the navigation,
    // so the beforeunload guard stays quiet, and the socket 'disconnect' handler
    // skips its "connection lost, reconnecting…" toast. Also drops peers and
    // stops the mic at once instead of waiting for pagehide.
    teardown();
    location.href = '/';
}

function teardown() {
    joined = false;
    socket?.disconnect();
    teardownMedia();
    composer.clearPendingImages();
    composer.clearTyping();
    voice.syncPttHoldButton();
    for (const peerId of [...members.keys()]) mem.dropPeer(peerId, { silent: true });
}

function teardownMedia() {
    rec.stopRecoveryScan();
    rec.clearPeerRecovery();
    rec.stopPathMonitor();
    rec.resetForTeardown();
    se.clearDisconnectToast();
    screenLock.release();
    shareSound.stop({ silent: true }); // releases the capture + tells the room before the socket goes
    settingsUi.stopMicTest();
    voice.resetProcessed();
    mesh?.close();
    if (localStream) localStream.getTracks().forEach((track) => track.stop());
    if (rawMicStream) rawMicStream.getTracks().forEach((track) => track.stop());
    rawMicStream = null;
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
    // auto-join keeps the overlay hidden — bring it back so the error is seen
    $('#joinOverlay').classList.remove('hidden');
    $('#joinError').textContent = message;
    teardownMedia();
    // the disconnect handler keeps mesh/members for a resume — this path is a
    // dead end, drop them here so no stale member cards linger behind the overlay
    rec.resetLocalMesh();
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
// helpers
// ---------------------------------------------------------------------------

function safeAvatarUrl(value) {
    return typeof value === 'string' && value.length <= AVATAR_MAX_CHARS && DATA_URL_RE.test(value) ? value : '';
}

// ---------------------------------------------------------------------------
// The #debug probes live in ./channel/debug.js — installed with a live
// snapshot getter so every probe reads the controller state at call time.
if (location.hash === '#debug') {
    installDebugHooks(() => {
        const d = rec.debugState();
        return {
            hub,
            mesh,
            members,
            audioEls,
            connPaths: d.connPaths,
            lossStreaks: d.lossStreaks,
            peerRecovery: d.peerRecovery,
            micProcessed: voice.micProcessed,
            micTest: settingsUi.micTest,
            settings,
            localStream,
            b1Attempts: d.b1Attempts,
            b1InFlight: d.b1InFlight,
            webAudioPlayback: voice.webAudioPlayback,
            shareSound,
        };
    });
}
