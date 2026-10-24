/**
 * Channel page controller — voice (left) + text chat (right).
 *
 * Audio settings (gear button): mic/speaker device pickers, browser audio
 * processing toggles, push-to-talk (hold V), mic level meter, speaker volume
 * and mic/speaker test, operation sound effects (public/js/core/sound.js).
 * Images travel over the chat DataChannel in chunks (public/js/core/images.js)
 * and can be pasted straight from the clipboard.
 */

import { api } from '/js/core/api.js';
import { Mesh } from '/js/core/webrtc.js';
import { AudioHub, getTestBeepUrl } from '/js/core/audio.js';
import { initChat } from '/js/core/chat.js';
import { fileToImageMessage, sendImageData, createImageReceiver } from '/js/core/images.js';
import { createDropdown } from '/js/core/dropdown.js';
import { initI18n, t } from '/js/core/i18n.js';
import { initSoundSettings, playSound } from '/js/core/sound.js';
import { initVersionCheck } from '/js/core/version.js';
import { $, el, avatarColor, randomNick, copyText } from '/js/core/utils.js';

const NICK_KEY = 'vc_nick';
const HOST_TOKEN_PREFIX = 'vc_host_token_';
const CHANNEL_PW_PREFIX = 'vc_chan_pw_';
const SEND_KEY_STORE = 'vc_send_key'; // 'enter' (default) | 'ctrlEnter'
const AUDIO_SETTINGS_KEY = 'vc_audio_settings';
const PEER_VOLUMES_KEY = 'vc_peer_volumes';
const AVATAR_KEY = 'vc_avatar';
const AVATAR_MAX_CHARS = 96 * 1024; // broadcast/storage cap for the avatar data URL
const AVATARS_MAX = 100; // hard cap on remembered peer avatars (flood guard)
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

/** Opus caps for the mesh (passed as getOpusFmtp — read at every SDP round). */
function opusFmtp() {
    const raw = Math.round(Number(settings.opusBitrate));
    const kbps = Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, raw || 64));
    const maxaveragebitrate = kbps * 1000;
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

// ----- media self-healing (see the recovery engine section below) -----
const peerRecovery = new Map(); // peerId -> { timer, attempts, lastState, brokenAt, escalated }
let recoveryScanTimer = null;
let b1Attempts = 0; // automatic signaling reconnects since the last stable period
let b1InFlight = false;
let b1Timer = null;
let b1ResetTimer = null;
let selfReconnecting = false; // suppress the "disconnected" toast on our own B1 reconnect
// transport-level drops (VPN switch, network flap) usually reconnect within a
// couple of seconds — hold the "disconnected" toast until it sticks
const DISCONNECT_TOAST_MS = 3000;
let disconnectToastTimer = null;

// ----- screen wake lock (mobile: a locked screen kills the voice session) -----

let wakeLock = null; // active Sentinel; null = not held / unsupported
let wakeLockBusy = false; // a request() round-trip in flight

function wakeLockWanted() {
    // request() rejects while hidden — the visibilitychange handler re-arms
    return joined && !textOnly && document.visibilityState === 'visible';
}

async function syncWakeLock() {
    if (!('wakeLock' in navigator)) return; // unsupported: degrade silently
    if (!wakeLockWanted()) {
        releaseWakeLock();
        return;
    }
    if (wakeLock || wakeLockBusy) return;
    wakeLockBusy = true;
    try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (wakeLockWanted()) {
            wakeLock = sentinel;
            // system revoked it (screen off, battery saver): drop the handle so
            // the visibilitychange handler can request a fresh one
            sentinel.addEventListener('release', () => {
                if (wakeLock === sentinel) wakeLock = null;
            });
        } else {
            sentinel.release().catch(() => {});
        }
    } catch {
        /* denied — the session just loses the keep-awake nicety */
    } finally {
        wakeLockBusy = false;
    }
}

function releaseWakeLock() {
    const sentinel = wakeLock;
    wakeLock = null;
    try {
        sentinel?.release?.().catch?.(() => {});
    } catch {
        /* already released */
    }
}

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
    onDone: ({ from, dataUrl, batch, peerId }) => {
        if (batch) chat.addBatchImage(batch, dataUrl, t('chat.image'));
        else {
            // a lone image IS the message — batched ones already chimed with
            // their 'chat' text frame. The display name comes from the
            // DataChannel peer, not the self-declared 'from' field.
            const name = members.get(peerId)?.peer_name || from || '?';
            chat.addImage({ name, src: dataUrl, alt: t('chat.image') });
            playSound('message');
        }
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
    // a reload drops the call, so ask first while any peer link is up
    initVersionCheck({ isBusy: () => !!mesh && mesh.entries.size > 0 });
    chat = initChat($('#chatMessages'), {
        emptyText: t('chat.empty'),
        downloadText: t('chat.saveImage'),
        yesterdayText: t('chat.yesterday'),
        avatarFor: (name) => avatars.get(name) || '',
        imagesProgress: (got, total) => t('chat.imagesProgress', { got, total }),
        failText: t('chat.imageBroken'),
        historyLoadingText: t('chat.historyLoading'),
        historyEndText: t('chat.historyEnd'),
    });
    bindHistoryPaging($('#chatMessages'));
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
    $('#backBtn').addEventListener('click', leave);
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
    $('#outageActionBtn').addEventListener('click', () => {
        if ($('#outageBanner').dataset.mode === 'failed') {
            intentionalUnload = true;
            location.reload();
        } else attemptSignalingReconnect({ manual: true });
    });
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
    // back from the background: the screen lock auto-released the sentinel —
    // re-request it while the voice session is still live
    document.addEventListener('visibilitychange', syncWakeLock);
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
            rawMicStream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
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

// ----- scroll-up pagination for the persisted chat history -----
// Lives at module scope (not inside registerSocketHandlers): boot() binds the
// scroll listener before the socket handlers are wired.

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
        if (!text && !imgs.length) continue;
        const ts = typeof msg.ts === 'number' && msg.ts > 0 ? msg.ts : 0;
        rows.push({ name, text, imgs, self: name === selfName, time: ts ? new Date(ts) : new Date() });
    }
    return rows;
}

function bindHistoryPaging(box) {
    box.addEventListener('scroll', maybeLoadOlder, { passive: true });
}

/** Fire a page fetch whenever the list is scrolled near its top. */
function maybeLoadOlder() {
    if (!socket || !historyHasMore || historyLoading) return;
    const box = $('#chatMessages');
    if (!box || box.scrollTop > CHAT_LOAD_THRESHOLD) return;
    loadOlderPage();
}

function loadOlderPage() {
    if (historyLoading || !historyHasMore) return;
    historyLoading = true;
    chat.setHistoryFooter('loading');
    // ack keeps request and response paired; the timeout un-sticks the
    // flag when the answer never comes so a later scroll can retry
    socket.timeout(8000).emit('chatPage', { room_id: channelId, before: historyCursor ?? 0 }, (err, res) => {
        historyLoading = false;
        chat.setHistoryFooter(null);
        if (err) return;
        const messages = Array.isArray(res?.messages) ? res.messages : [];
        historyHasMore = res?.hasMore === true;
        if (messages.length) {
            const first = messages[0]; // oldest of the page, again
            if (first && typeof first.ts === 'number' && first.ts > 0) historyCursor = first.ts;
            chat.prependHistory(parseHistoryRows(messages), { imageAlt: t('chat.image') });
        }
        if (historyHasMore)
            maybeLoadOlder(); // viewport may still not be full
        else chat.setHistoryFooter('end');
    });
}

function registerSocketHandlers() {
    socket.on('connect', () => {
        // back within the flap window — the "disconnected" toast never fired
        clearTimeout(disconnectToastTimer);
        disconnectToastTimer = null;
        emitJoin();
    });

    socket.on('serverInfo', (cfg) => {
        // a successful (re)join resolves any pending self-reconnect
        b1InFlight = false;
        selfReconnecting = false;
        clearTimeout(b1Timer);
        if (!joined) {
            joined = true;
            startRecoveryScan();
            startPathMonitor();
            syncWakeLock();
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
        chat.addHistory(rows, { dividerText: t('chat.historyDivider'), imageAlt: t('chat.image') });
        maybeLoadOlder(); // keep going while the viewport isn't filled yet
    });

    socket.on('addPeer', (cfg) => {
        const known = mesh.entries.has(cfg.peer_id);
        mesh.addPeer(cfg.peer_id, cfg.should_create_offer, cfg.iceServers || []);
        syncMembers(cfg.peers || {});
        // should_create_offer=false means: WE are the old member and someone
        // else just joined — announce them (the joiner gets one event per
        // existing member and must not re-announce everyone). rejoin=true is
        // a resumed session coming back from a network flap: its card never
        // left, no announcement, no sound.
        if (joined && cfg.should_create_offer === false && !cfg.rejoin) {
            const name = members.get(cfg.peer_id)?.peer_name || '';
            if (name) chat.add({ text: t('chat.joined', { name }), system: true });
            playSound('peerJoin');
        }
        // resumed session with an existing (possibly broken) link: the mesh
        // entry was reused so NO offer went out — put the recovery ladder on
        // it now instead of waiting for the next 10s scan
        if (known && cfg.should_create_offer === true) {
            const state = mesh.entries.get(cfg.peer_id)?.pc.connectionState;
            if (state && state !== 'connected' && state !== 'closed') notePeerState(cfg.peer_id, state);
        }
        updateOnlineCount();
    });

    socket.on('removePeer', ({ peer_id }) => {
        const name = members.get(peer_id)?.peer_name || '';
        dropPeer(peerIdSafe(peer_id));
        if (joined && name) {
            chat.add({ text: t('chat.left', { name }), system: true });
            playSound('peerLeave');
        }
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
        if (peer_id === selfUuid) {
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
            if (url) {
                avatars.set(peer_name, url);
                capAvatars();
            } else avatars.delete(peer_name);
            chat.setAvatar(peer_name, url);
        }
        renderMembers();
    });

    socket.on('peerAction', ({ peer_id, peer_action }) => {
        if (peer_id === selfUuid && peer_action === 'muteAudio') {
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
    socket.on('tempRoomLimitReached', (cfg) =>
        showJoinError(
            cfg?.reason === 'rate-limit'
                ? t('channel.errors.tempRateLimit')
                : t('channel.errors.tempIpLimit', { n: cfg?.max || 0 })
        )
    );
    socket.on('channelLimitReached', (cfg) => showJoinError(t('channel.errors.channelLimit', { n: cfg?.max || 0 })));
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
        if (joined)
            emitJoin(); // reconnect of an established session: rejoin without the token
        else {
            socket.disconnect();
            join({ textOnly: false });
        }
    });

    socket.on('disconnect', (reason) => {
        if (!joined) return;
        // The mesh and member list SURVIVE the disconnect: the server parks
        // our session as a ghost, this socket re-joins with the same
        // peer_uuid and the existing peer connections resume — they heal via
        // the ICE-restart recovery ladder instead of a full renegotiation.
        // Intentional exits (leave, kick, our own B1 rebuild, join errors)
        // tear the state down themselves before disconnecting.
        if (reason === 'io client disconnect' || selfReconnecting) return;
        // brief transport flaps (VPN/accelerator switch) usually reconnect
        // within a couple of seconds — don't cry "disconnected" until it sticks
        clearTimeout(disconnectToastTimer);
        disconnectToastTimer = setTimeout(() => {
            disconnectToastTimer = null;
            if (!socket?.connected && joined) toast(t('channel.errors.disconnected'), 'warn');
        }, DISCONNECT_TOAST_MS);
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
                playSound('message');
                return;
            }
            if (data.type === 'img-start' || data.type === 'img-chunk' || data.type === 'img-end') {
                imageReceiver(data, peerId);
            }
        },
        onPeerState(peerId, state) {
            const node = $(`#memberList .member[data-id="${peerId}"]`);
            if (node) node.classList.toggle('bad', state === 'failed' || state === 'disconnected');
            notePeerState(peerId, state);
            // first path read right after the link settles; the poll keeps it fresh
            if (state === 'connected') checkPeerPath(peerId, PATH_FIRST_CHECK_MS);
        },
    };
}

// ---------------------------------------------------------------------------
// media self-healing — a coturn restart destroys every TURN allocation while
// signaling stays up, so links die without the app noticing. Recovery runs
// per peer (a mesh can be half-broken):
//   disconnected → 5s grace (ICE often self-heals; acting sooner breaks it)
//   failed       → act at once
//   → up to 3 ICE-restart rounds (3/6/12s backoff, lower session id initiates
//     so both sides never re-offer at once) → signaling reconnect (rebuilds
//     every link) → after 2 silent reconnects: visible "reload" prompt.
// A 10s scan re-checks every connectionState in case a webview swallows the
// connectionstatechange event.
// The same ladder heals links after a SIGNALING drop (VPN/accelerator switch):
// the server parks the session as a ghost, this side keeps its peer
// connections, the resume addPeer reuses them, and ICE restarts re-punch the
// new network path — no renegotiation, the DataChannel survives.
// ---------------------------------------------------------------------------

const RECOVERY_GRACE_MS = 5000;
const RECOVERY_ROUND_DELAYS = [3000, 6000, 12000];
const RECOVERY_TOTAL_MS = 20000; // per-peer window before the signaling reconnect (round3 +12s = 21s)
const RECOVERY_MAX_B1 = 2; // automatic signaling reconnects before asking the user
const RECOVERY_SCAN_MS = 10000;
const RECOVERY_B1_RESET_MS = 60000; // stable for this long → the B1 budget refills

function notePeerState(peerId, state) {
    const rec = peerRecovery.get(peerId);
    if (rec && rec.lastState === state) return;

    if (state === 'connected' || state === 'closed') {
        if (state === 'connected') {
            hideOutageBanner();
            armB1Reset();
        }
        clearConnectingBadge(peerId);
        cancelPeerRecovery(peerId);
        // 🔴 Nothing may reset the relay-upgrade budget here: the 10s recovery
        // scan re-reports 'connected' for every healthy peer, so a cancel in this
        // branch kills the 12s grace timer before it can ever fire (1.1.5 shipped
        // with exactly that bug — the upgrade never ran). A real break clears the
        // budget through peerRecovery instead; see noteRelayUpgrade.
        return;
    }
    if (state !== 'disconnected' && state !== 'failed') return; // new/checking/connecting
    if (!mesh?.entries.has(peerId)) {
        cancelPeerRecovery(peerId);
        return;
    }

    if (!rec) {
        clearTimeout(b1ResetTimer); // instability: don't refill the B1 budget
        peerRecovery.set(peerId, {
            timer: null,
            attempts: 0,
            lastState: state,
            brokenAt: Date.now(),
            escalated: false,
        });
        scheduleRecoveryTick(peerId, state === 'failed' ? 0 : RECOVERY_GRACE_MS);
        updatePeerCardRecovery(peerId);
        return;
    }
    rec.lastState = state;
    // disconnected degraded to failed while still in the grace window — skip the wait
    if (state === 'failed' && rec.attempts === 0 && rec.timer) scheduleRecoveryTick(peerId, 0);
}

function scheduleRecoveryTick(peerId, delay) {
    const rec = peerRecovery.get(peerId);
    if (!rec) return;
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => recoveryTick(peerId), delay);
}

function recoveryTick(peerId) {
    const rec = peerRecovery.get(peerId);
    if (!rec) return;
    rec.timer = null;
    const state = mesh?.entries.get(peerId)?.pc.connectionState;
    if (!mesh?.entries.has(peerId) || state === 'connected' || state === 'closed') {
        cancelPeerRecovery(peerId);
        return;
    }
    if (Date.now() - rec.brokenAt >= RECOVERY_TOTAL_MS) {
        escalatePeerRecovery(peerId);
        return;
    }
    if (state === 'disconnected' || state === 'failed') {
        if (rec.attempts < RECOVERY_ROUND_DELAYS.length) {
            rec.attempts += 1;
            // glare arbitration: with both sides broken, only the lower
            // session id re-offers; the other just answers
            if (selfUuid < peerId) {
                mesh.restartIce(peerId).catch(() => {});
            } else {
                console.log('[mesh] recovery: waiting for peer re-offer', peerId);
            }
            scheduleRecoveryTick(peerId, RECOVERY_ROUND_DELAYS[rec.attempts - 1]);
            return;
        }
        // rounds spent but the window isn't over: keep watching the link
        scheduleRecoveryTick(peerId, RECOVERY_ROUND_DELAYS[RECOVERY_ROUND_DELAYS.length - 1]);
        return;
    }
    // transitional (new/checking/connecting): a restart is being evaluated —
    // re-check shortly without burning another round
    scheduleRecoveryTick(peerId, 3000);
}

function escalatePeerRecovery(peerId) {
    const rec = peerRecovery.get(peerId);
    if (!rec || rec.escalated) return;
    rec.escalated = true;
    console.warn('[mesh] recovery: ICE restarts exhausted, falling back to signaling reconnect', peerId);
    showOutageBanner('recovering');
    attemptSignalingReconnect();
}

/** Drop every remote peer + mesh entry locally (before intentional
 *  disconnects: the B1 full rebuild and join-error resets — the transport
 *  'disconnect' handler deliberately KEEPS state so a resume can heal it). */
function resetLocalMesh() {
    mesh?.clear();
    for (const peerId of [...members.keys()]) {
        if (peerId !== selfUuid) dropPeer(peerId, { silent: true });
    }
}

/** Last-resort fallback: rebuild the whole session over fresh signaling. */
function attemptSignalingReconnect({ manual = false } = {}) {
    if (!socket || !joined) return;
    if (b1InFlight) return;
    if (!manual && b1Attempts >= RECOVERY_MAX_B1) {
        showOutageBanner('failed');
        return;
    }
    b1Attempts += 1;
    b1InFlight = true;
    selfReconnecting = true;
    console.warn('[mesh] recovery: signaling reconnect', { manual, attempt: b1Attempts });
    // B1 is a FULL rebuild: drop the mesh BEFORE disconnecting (the server
    // treats the intentional disconnect as a real leave, everyone tears their
    // links down) — then re-join as a fresh session and let the addPeer storm
    // rebuild every link with fresh ICE
    resetLocalMesh();
    socket.disconnect();
    socket.connect();
    clearTimeout(b1Timer);
    b1Timer = setTimeout(() => {
        b1InFlight = false;
        selfReconnecting = false;
    }, 15000);
}

function armB1Reset() {
    clearTimeout(b1ResetTimer);
    b1ResetTimer = setTimeout(() => (b1Attempts = 0), RECOVERY_B1_RESET_MS);
}

function cancelPeerRecovery(peerId) {
    const rec = peerRecovery.get(peerId);
    if (!rec) return;
    clearTimeout(rec.timer);
    peerRecovery.delete(peerId);
    updatePeerCardRecovery(peerId);
}

function clearPeerRecovery() {
    for (const peerId of [...peerRecovery.keys()]) cancelPeerRecovery(peerId);
}

function startRecoveryScan() {
    if (recoveryScanTimer) return;
    recoveryScanTimer = setInterval(() => {
        if (!joined || !mesh) return;
        for (const [peerId, entry] of mesh.entries) notePeerState(peerId, entry.pc.connectionState);
    }, RECOVERY_SCAN_MS);
}

function stopRecoveryScan() {
    clearInterval(recoveryScanTimer);
    recoveryScanTimer = null;
}

/** Member card: red name/avatar while the link is broken, badge once recovery runs. */
function updatePeerCardRecovery(peerId) {
    const node = $(`#memberList .member[data-id="${peerId}"]`);
    if (node) node.classList.toggle('lost', peerRecovery.has(peerId));
}

// ---------------------------------------------------------------------------
// "connecting…" badge — a ghost member (socket dead, waiting for the server
// heartbeat to reap it) never answers the SDP offer, so its card sits in
// new/connecting looking normal while the link will never come up. Real links
// settle in 2-8s (relayed ones slower), so only flag past a generous window.
// ---------------------------------------------------------------------------

const CONNECTING_BADGE_MS = 12000;
const connectingTimers = new Map(); // peerId -> timeout; present = 'connected' not yet observed
const stuckConnecting = new Set(); // window expired with the link still not up

function armConnectingBadge(peerId) {
    if (connectingTimers.has(peerId) || stuckConnecting.has(peerId)) return;
    connectingTimers.set(
        peerId,
        setTimeout(() => {
            connectingTimers.delete(peerId);
            const state = mesh?.entries.get(peerId)?.pc.connectionState;
            if (!members.has(peerId) || state === 'connected' || state === 'closed') return;
            stuckConnecting.add(peerId);
            updatePeerCardConnecting(peerId, true);
        }, CONNECTING_BADGE_MS)
    );
}

function clearConnectingBadge(peerId) {
    const timer = connectingTimers.get(peerId);
    if (timer) clearTimeout(timer);
    connectingTimers.delete(peerId);
    if (stuckConnecting.delete(peerId)) updatePeerCardConnecting(peerId, false);
}

function updatePeerCardConnecting(peerId, on) {
    const node = $(`#memberList .member[data-id="${peerId}"]`);
    if (node) node.classList.toggle('connecting', on);
}

// ---------------------------------------------------------------------------
// connection path monitor — per-peer badge telling P2P (hole punching
// succeeded) apart from TURN relay. Read from the selected ICE candidate
// pair via mesh.connPath() every few seconds: an ICE restart that flips the
// path gets picked up too. Client-side only — in a mesh no one (not even the
// server) sees anyone's media path but their own.
// ---------------------------------------------------------------------------

const PATH_POLL_MS = 5000;
const PATH_FIRST_CHECK_MS = 1200; // just-connected: let the selected pair settle, then read at once
const connPaths = new Map(); // peerId -> { type, local, remote, rtt } from mesh.connPath()
const pathChecks = new Set(); // peers with a getStats round-trip in flight
const pathEarlyTimers = new Map(); // peerId -> post-connect one-shot check
let pathPollTimer = null;

function startPathMonitor() {
    if (pathPollTimer) return;
    pathPollTimer = setInterval(() => {
        if (!joined || !mesh) return;
        for (const peerId of mesh.entries.keys()) checkPeerPath(peerId);
    }, PATH_POLL_MS);
}

function stopPathMonitor() {
    clearInterval(pathPollTimer);
    pathPollTimer = null;
    for (const timer of pathEarlyTimers.values()) clearTimeout(timer);
    pathEarlyTimers.clear();
    connPaths.clear();
    lossStreaks.clear();
    for (const peerId of [...relayUpgrades.keys()]) cancelRelayUpgrade(peerId);
}

function checkPeerPath(peerId, delay = 0) {
    if (delay) {
        if (pathEarlyTimers.has(peerId)) return;
        pathEarlyTimers.set(
            peerId,
            setTimeout(() => {
                pathEarlyTimers.delete(peerId);
                checkPeerPath(peerId);
            }, delay)
        );
        return;
    }
    if (pathChecks.has(peerId)) return;
    if (!mesh?.entries.has(peerId)) return;
    pathChecks.add(peerId);
    mesh.connPath(peerId)
        .then((info) => {
            if (!info || !mesh?.entries.has(peerId)) return; // peer left meanwhile
            connPaths.set(peerId, info);
            notePeerLoss(peerId, info);
            updatePeerPathBadge(peerId);
            noteRelayUpgrade(peerId, info);
        })
        .catch(() => {
            connPaths.delete(peerId);
            updatePeerPathBadge(peerId); // don't leave a stale "P2P"/relay badge behind
            cancelRelayUpgrade(peerId);
        })
        .finally(() => pathChecks.delete(peerId));
}

function pathBadgeNode(peerId) {
    const node = el('span', { class: 'badge path-badge' });
    fillPathBadge(node, peerId);
    return node;
}

function updatePeerPathBadge(peerId) {
    const node = $(`#memberList .member[data-id="${peerId}"] .path-badge`);
    if (node) fillPathBadge(node, peerId);
}

function fillPathBadge(node, peerId) {
    const info = connPaths.get(peerId);
    const known = !!info && (info.type === 'p2p' || info.type === 'relay');
    node.classList.toggle('on', known);
    node.classList.toggle('relay', known && info.type === 'relay');
    node.textContent = known ? t(info.type === 'p2p' ? 'channel.pathP2p' : 'channel.pathRelay') : '';
    if (!known) {
        node.removeAttribute('title');
        return;
    }
    // inline latency right after the link label; null = the selected pair
    // report didn't expose currentRoundTripTime — badge stays label-only.
    // the lone space text node is swallowed by the flex layout (gap: 4px
    // already separates) but keeps "P2P 45ms" as the badge's text content
    const quality = lossStreaks.get(peerId);
    if (info.rtt !== null) node.append(' ', el('span', { class: 'rtt', text: `${info.rtt}ms` }));
    // current loss marker: noticeable at a glance without hovering
    if (quality && quality.loss !== null && quality.loss >= 5)
        node.append(' ', el('span', { class: 'loss', text: t('channel.pathLoss', { n: Math.round(quality.loss) }) }));
    // hover detail: candidate types on both ends (host/srflx/prflx/relay) + RTT
    // + inbound quality (loss / jitter / bitrate, diffed between polls)
    const parts = [t(info.type === 'p2p' ? 'channel.pathP2pTitle' : 'channel.pathRelayTitle')];
    if (info.local && info.remote) parts.push(`${info.local} ↔ ${info.remote}`);
    if (info.rtt !== null) parts.push(t('channel.pathRtt', { n: info.rtt }));
    if (quality) {
        if (quality.loss !== null) parts.push(t('channel.pathLoss', { n: quality.loss }));
        if (quality.jitter !== null) parts.push(t('channel.pathJitter', { n: quality.jitter }));
        if (quality.kbps !== null) parts.push(t('channel.pathBitrate', { n: quality.kbps }));
    }
    node.title = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// inbound link quality — cumulative RTP counters say nothing about a RATE, so
// every path poll diffs packetsLost/packetsReceived since the previous one.
// Sustained high loss flips an "unstable" badge on the member card (with
// hysteresis so a single bad poll doesn't flicker it); the per-poll values
// feed the path-badge hover detail. Only an ALIVE link is judged — a broken
// one already shows the recovery badge.
// ---------------------------------------------------------------------------

const LOSS_BAD_PCT = 10; // a poll at/above this counts as bad
const LOSS_OK_PCT = 5; // at/below this counts as good (in between: neither)
const UNSTABLE_BAD_POLLS = 3; // ~15s at the 5s poll cadence → badge on
const UNSTABLE_GOOD_POLLS = 2; // clean polls before the badge clears
// peerId -> { last, loss, jitter, kbps, bad, good, unstable }
const lossStreaks = new Map();

function notePeerLoss(peerId, info) {
    const rec =
        lossStreaks.get(peerId) || { last: null, loss: null, jitter: null, kbps: null, bad: 0, good: 0, unstable: false };
    const inbound = info?.inbound;
    if (inbound) {
        const prev = rec.last;
        rec.jitter = inbound.jitter !== null ? Math.round(inbound.jitter * 1000) : null;
        if (prev && inbound.timestamp > prev.timestamp) {
            const dLost = inbound.packetsLost - prev.packetsLost;
            const dRecv = inbound.packetsReceived - prev.packetsReceived;
            const dSec = (inbound.timestamp - prev.timestamp) / 1000;
            // negative deltas = counter reset (SSRC switch): skip the rate, rebase
            if (dLost >= 0 && dRecv >= 0) {
                const total = dLost + dRecv;
                const loss = total > 0 ? (dLost / total) * 100 : 0;
                rec.loss = Math.round(loss * 10) / 10;
                rec.kbps =
                    dSec > 0 ? Math.round(((inbound.bytesReceived - prev.bytesReceived) * 8) / dSec / 1000) : null;
                if (loss >= LOSS_BAD_PCT) {
                    rec.bad += 1;
                    rec.good = 0;
                } else if (loss <= LOSS_OK_PCT) {
                    rec.good += 1;
                    rec.bad = 0;
                }
            }
        }
        rec.last = inbound;
    }
    const was = rec.unstable;
    if (!rec.unstable && rec.bad >= UNSTABLE_BAD_POLLS) rec.unstable = true;
    else if (rec.unstable && rec.good >= UNSTABLE_GOOD_POLLS) rec.unstable = false;
    lossStreaks.set(peerId, rec);
    if (was !== rec.unstable) updatePeerUnstable(peerId);
}

function updatePeerUnstable(peerId) {
    const node = $(`#memberList .member[data-id="${peerId}"]`);
    if (node) node.classList.toggle('unstable', !!lossStreaks.get(peerId)?.unstable);
}

// ---------------------------------------------------------------------------
// relay upgrade — ICE nominates the first working pair, which can be the TURN
// relay when direct checks were still in flight (cold DNS, slow NAT binding,
// coturn auth round-trip); WebRTC never re-runs checks on a connected link, so
// a connected-but-relayed path stays relayed forever. Fed by the path poll:
// once a link sits on relay past RELAY_UPGRADE_GRACE_MS, re-punch with an
// iceRestart (chat DataChannel preserved). Glare arbitration mirrors the
// recovery ladder — only the lower session-id side initiates, and the restart
// re-runs checks on BOTH ends, so the peer needs no watchdog of its own.
// Attempts are capped: when direct is impossible (symmetric NAT, blocked UDP)
// another restart is pointless churn that only blips the audio.
//
// 🔴 The budget must survive everything the app reports about a healthy link:
// the 10s recovery scan re-emits 'connected' for every peer, and a restart makes
// the path read 'unknown' for a moment. Cancelling the record on either signal
// resets `since`/`attempts` from inside the attempt it is supposed to bound —
// which is how 1.1.5 ended up never firing (grace 12s > scan 10s).
// Only these clear it: path is p2p, peer left / link broken (peerRecovery), the
// peer left the room, or we left.
// ---------------------------------------------------------------------------

const RELAY_UPGRADE_GRACE_MS = 12000; // relayed this long after connect → try re-punching
const RELAY_UPGRADE_RETRY_MS = 10000; // after a restart, let fresh checks settle before judging
const RELAY_UPGRADE_MAX_ATTEMPTS = 2;
const RELAY_UPGRADE_TOTAL_MS = 45000; // hard window, also bounds restartIce deferrals
// peerId -> { timer, attempts, since, done, busy }
//   done = attempts exhausted, tombstone so the poll stops re-arming
//   busy = our re-offer is in flight, don't stack a second one
const relayUpgrades = new Map();

function noteRelayUpgrade(peerId, info) {
    if (!info || peerRecovery.has(peerId) || !selfUuid || selfUuid >= peerId) {
        // link gone, or this side isn't the one allowed to re-punch
        cancelRelayUpgrade(peerId);
        return;
    }
    if (info.type === 'p2p') {
        // direct — the upgrade landed (or was never needed): start clean next time
        cancelRelayUpgrade(peerId);
        return;
    }
    // 'unknown' is transitional: our own restart is re-checking, or the candidate
    // reports aren't readable yet. Keep the budget — cancelling here would reset
    // the attempt counter from inside the restart it is supposed to bound.
    if (info.state !== 'connected' || info.type !== 'relay') return;

    let rec = relayUpgrades.get(peerId);
    if (!rec) {
        rec = { timer: null, attempts: 0, since: Date.now(), done: false, busy: false };
        relayUpgrades.set(peerId, rec);
    }
    if (rec.done || rec.timer || rec.busy) return; // exhausted / armed / offer in flight
    const due = Math.max(RELAY_UPGRADE_GRACE_MS - (Date.now() - rec.since), 0);
    rec.timer = setTimeout(() => relayUpgradeTick(peerId), due);
}

function relayUpgradeTick(peerId) {
    const rec = relayUpgrades.get(peerId);
    if (!rec) return;
    rec.timer = null;
    if (rec.busy) {
        // the previous offer hasn't settled — let it, then judge again
        scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
        return;
    }
    // Peer gone, broken link, or not our turn to initiate: nothing left to judge.
    if (!mesh?.entries.has(peerId) || peerRecovery.has(peerId) || !selfUuid || selfUuid >= peerId) {
        cancelRelayUpgrade(peerId);
        return;
    }
    // connPaths is written only by the 5s path poll, so this snapshot can still
    // describe the restart that just finished (state 'connecting', type
    // 'unknown'). Only a proven 'p2p' ends the cycle — treating "no verdict yet"
    // as "upgrade not needed" would drop the record and hand the link a fresh
    // 2 attempts, which is how a slow-settling restart turns into an endless
    // renegotiation loop. Unknown waits for the next poll instead.
    const info = connPaths.get(peerId);
    if (info?.type === 'p2p') {
        cancelRelayUpgrade(peerId);
        return;
    }
    const relayed = info?.state === 'connected' && info.type === 'relay';
    if (rec.attempts >= RELAY_UPGRADE_MAX_ATTEMPTS || Date.now() - rec.since >= RELAY_UPGRADE_TOTAL_MS) {
        if (relayed) console.warn('[mesh] relay upgrade: giving up, link stays on TURN', peerId);
        // tombstone: stay in the map so the poll doesn't re-arm a fresh cycle
        rec.done = true;
        return;
    }
    if (!relayed) {
        // no verdict yet (restart still settling / candidates unreadable): look again
        scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
        return;
    }
    rec.busy = true;
    // restartIce resolves false (never rejects) when the pc is mid-negotiation
    // or closed; the catch arm only guards a future signature change.
    mesh.restartIce(peerId).then(
        (sent) => {
            rec.busy = false;
            if (!relayUpgrades.has(peerId)) return; // cancelled while the offer was in flight
            if (!sent) {
                // mid-negotiation (reverse offer in flight): retry soon, don't burn an attempt
                scheduleRelayUpgradeRetry(peerId, 6000);
                return;
            }
            rec.attempts += 1;
            console.log(
                '[mesh] relay upgrade: ice restart sent',
                peerId,
                `${rec.attempts}/${RELAY_UPGRADE_MAX_ATTEMPTS}`
            );
            scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
        },
        () => {
            rec.busy = false;
            if (relayUpgrades.has(peerId)) scheduleRelayUpgradeRetry(peerId, RELAY_UPGRADE_RETRY_MS);
        }
    );
}

function scheduleRelayUpgradeRetry(peerId, delay) {
    const rec = relayUpgrades.get(peerId);
    if (!rec) return;
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => relayUpgradeTick(peerId), delay);
}

function cancelRelayUpgrade(peerId) {
    const rec = relayUpgrades.get(peerId);
    if (!rec) return;
    clearTimeout(rec.timer);
    relayUpgrades.delete(peerId);
}

function showOutageBanner(mode) {
    $('#outageBanner').classList.remove('hidden');
    $('#outageBanner').dataset.mode = mode;
    $('#outageTitle').textContent = t(mode === 'failed' ? 'channel.outageFailedTitle' : 'channel.outageTitle');
    $('#outageHint').textContent = t(mode === 'failed' ? 'channel.outageFailedHint' : 'channel.outageRecovering');
    $('#outageActionBtn').textContent = t(mode === 'failed' ? 'channel.outageReload' : 'channel.outageRejoin');
}

function hideOutageBanner() {
    $('#outageBanner').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

function syncMembers(peersMap) {
    // peer ids are SESSION uuids (stable across our own reconnects) — our own
    // id is selfUuid, never the ephemeral socket.id
    const selfId = selfUuid;
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
        if (avatar) {
            avatars.set(name, avatar);
            capAvatars();
        }
        members.set(peerId, {
            peer_name: name,
            peer_presenter: !!info.peer_presenter,
            peer_audio_status: info.peer_audio_status === true,
            joined_at: info.joined_at || existing?.joined_at || Date.now(),
            avatar,
            // remembered per-user volume; an in-session adjustment wins over the stored one
            volume: existing?.volume ?? (name !== '?' ? (peerVolumes[name] ?? 1) : 1),
        });
        if (!existing) armConnectingBadge(peerId);
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
    members.set(selfUuid, {
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
    cancelPeerRecovery(peerId);
    cancelRelayUpgrade(peerId);
    clearConnectingBadge(peerId);
    clearTimeout(pathEarlyTimers.get(peerId));
    pathEarlyTimers.delete(peerId);
    connPaths.delete(peerId);
    lossStreaks.delete(peerId);
    members.delete(peerId);
    pruneAvatars();
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

/** avatars is keyed by display name — forget names no longer in the room. */
function pruneAvatars() {
    const present = new Set();
    for (const info of members.values()) {
        if (info.peer_name) present.add(info.peer_name);
    }
    for (const name of [...avatars.keys()]) {
        if (!present.has(name)) avatars.delete(name);
    }
}

/** Belt-and-braces: a peer cycling nicknames+avatars can't grow the map forever. */
function capAvatars() {
    while (avatars.size > AVATARS_MAX) avatars.delete(avatars.keys().next().value);
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
            const node = el('li', {
                class:
                    'member' +
                    (info.self ? ' self-member' : '') +
                    (peerRecovery.has(peerId) ? ' lost' : '') +
                    (stuckConnecting.has(peerId) ? ' connecting' : '') +
                    (lossStreaks.get(peerId)?.unstable ? ' unstable' : ''),
                dataset: { id: peerId },
            });
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
                        !info.self
                            ? el('span', { class: 'badge connect-badge', text: t('channel.peerConnecting') })
                            : null,
                        !info.self
                            ? el('span', { class: 'badge recover-badge', text: t('channel.peerOffline') })
                            : null,
                        !info.self
                            ? el('span', { class: 'badge unstable-badge', text: t('channel.peerUnstable') })
                            : null,
                        !info.self ? pathBadgeNode(peerId) : null,
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

/** Button content from a static SVG constant + a textContent label — never
 * string-built HTML, so a future interpolated label can't become an XSS sink. */
function setIconBtn(btn, icon, label) {
    btn.replaceChildren(el('span', { html: icon }), el('span', { text: label }));
}

function updateHeaderActions() {
    $('#hostBadge').classList.toggle('hidden', !isPresenter);
    // host login stays reachable after the auto-join (no pre-join overlay)
    $('#hostLoginEntryBtn').classList.toggle('hidden', !(joined && !isPresenter));
    const lockBtn = $('#lockBtn');
    lockBtn.classList.toggle('hidden', !isPresenter);
    if (isPresenter) {
        setIconBtn(
            lockBtn,
            joinLockOn ? LOCK_SVG : UNLOCK_SVG,
            joinLockOn ? t('channel.unlockBtn') : t('channel.lockBtn')
        );
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
    const next = on && !!localStream;
    if (next === micOn) return;
    micOn = next;
    applyMicState();
    // click feedback for manual toggles and host mutes; push-to-talk keys
    // drive applyMicState directly and must stay silent
    playSound(next ? 'micOn' : 'micOff');
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
            peer_id: selfUuid,
            element: 'audio',
            status: live,
        });
    }
    const self = members.get(selfUuid);
    if (self) self.peer_audio_status = live;
    updateVoiceControls();
    updateMicIconNode(selfUuid, live); // in-place: full re-renders kill a mid-drag volume slider
}

function bindPttKeys() {
    window.addEventListener('keydown', (event) => {
        if (event.code !== PTT_KEY_CODE || event.repeat) return;
        if (!settings.ptt || !joined || !localStream || !micOn) return;
        const target = event.target;
        if (
            target &&
            (target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable)
        )
            return;
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
        // music mode overrides the processing toggles — browsers mangle music
        echoCancellation: settings.musicMode ? false : settings.echoCancellation,
        noiseSuppression: settings.musicMode ? false : settings.noiseSuppression,
        autoGainControl: settings.musicMode ? false : settings.autoGainControl,
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
    syncWakeLock(); // voice enabled from text-only: hold the screen awake now
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
        setIconBtn(micBtn, MIC_OFF_SVG, t('channel.enableVoice'));
    } else if (micOn && settings.ptt) {
        micBtn.classList.toggle('muted', !live);
        setIconBtn(micBtn, live ? MIC_ON_SVG : MIC_OFF_SVG, t('channel.pttOn'));
    } else if (micOn) {
        micBtn.classList.remove('muted');
        setIconBtn(micBtn, MIC_ON_SVG, t('channel.micOn'));
    } else {
        micBtn.classList.add('muted');
        setIconBtn(micBtn, MIC_OFF_SVG, t('channel.micOff'));
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

    $('#musicToggle').addEventListener('change', (event) => {
        settings.musicMode = event.target.checked;
        // re-seed the bitrate slider with the mode's default (hand-tuning
        // survives across sessions, but a mode switch is an explicit preset)
        settings.opusBitrate = settings.musicMode ? 192 : 64;
        saveAudioSettings();
        reflectMusicMode();
        reflectBitrate();
        // re-capture under the overridden processing constraints (hot-swaps the
        // outgoing track) and push the new bitrate onto live senders at once;
        // the fmtp side (stereo) lands with the next SDP round
        if (localStream) reacquireMic().catch(() => toast(t('channel.errors.micDenied'), 'warn'));
        mesh?.setSendBitrate();
    });

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

    $('#bitrateSlider').addEventListener('input', (event) => {
        settings.opusBitrate = Number(event.target.value);
        $('#bitrateVal').textContent = `${event.target.value} kbps`;
        saveAudioSettings();
        // pushes onto live senders via setParameters, no renegotiation; the
        // fmtp cap rides along on the next SDP round
        mesh?.setSendBitrate();
    });

    $('#volumeSlider').addEventListener('input', (event) => {
        settings.volume = Number(event.target.value) / 100;
        $('#volumeVal').textContent = `${event.target.value}%`;
        reapplyAllVolumes();
        saveAudioSettings();
    });

    $('#testMicBtn').addEventListener('click', onTestMicClick);
    $('#testSpkBtn').addEventListener('click', playTestBeep);

    // operation sound effects: master switch, volume, per-event sound pickers
    initSoundSettings({ applySink, toast });

    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDeviceSelects);
}

function openSettings() {
    updateAvatarPreview();
    reflectMusicMode();
    $('#pttToggle').checked = settings.ptt;
    spkDropdown.setDisabled(!sinkSupported);
    $('#sinkUnsupported').classList.toggle('hidden', sinkSupported);
    const pct = Math.round(settings.volume * 100);
    $('#volumeSlider').value = String(pct);
    $('#volumeVal').textContent = `${pct}%`;
    const micPct = Math.round(settings.micVolume * 100);
    $('#micVolumeSlider').value = String(micPct);
    $('#micVolumeVal').textContent = `${micPct}%`;
    reflectBitrate();
    refreshDeviceSelects();
    $('#settingsModal').classList.remove('hidden');
}

/** Music mode owns the three processing toggles — grays them out and reflects
 *  the forced-off capture state (the stored preferences survive underneath). */
function reflectMusicMode() {
    const on = settings.musicMode;
    $('#musicToggle').checked = on;
    $('#nsToggle').disabled = on;
    $('#ecToggle').disabled = on;
    $('#agcToggle').disabled = on;
    if (on) {
        $('#nsToggle').checked = false;
        $('#ecToggle').checked = false;
        $('#agcToggle').checked = false;
    } else {
        $('#nsToggle').checked = settings.noiseSuppression;
        $('#ecToggle').checked = settings.echoCancellation;
        $('#agcToggle').checked = settings.autoGainControl;
    }
}

/** Sync the bitrate slider/readout from settings (NOT inside
 *  reflectMusicMode — opening the modal must not clobber a hand-tuned value). */
function reflectBitrate() {
    const kbps = opusFmtp().maxaveragebitrate / 1000;
    $('#bitrateSlider').value = String(kbps);
    $('#bitrateVal').textContent = `${kbps} kbps`;
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
        items.push({
            value: device.deviceId,
            label: ((device.label || '').trim() || `${generic} ${index + 1}`).slice(0, 60),
        });
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
        const merged = { ...defaultAudioSettings, ...stored };
        // pre-slider music-mode users never stored a bitrate — keep their 192k
        // ceiling instead of silently dropping them to the voice default
        if (stored.opusBitrate === undefined && merged.musicMode) merged.opusBitrate = 192;
        return merged;
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

/**
 * Give the server copies of an outgoing chat message for the history store.
 * Live delivery stays P2P over the DataChannel mesh; this relay is storage
 * only (the sender is the single reporting point, so nothing is stored
 * twice). A submit with images = one head event + one event per image —
 * each image rides alone because a whole batch can exceed the socket.io
 * packet cap; the server assembles the batch into one history row.
 */
function emitChatForHistory(text, images = []) {
    if (!socket) return;
    if (!images.length) {
        socket.emit('chat', { room_id: channelId, msg: text });
        return;
    }
    const batch = crypto.randomUUID();
    socket.emit('chat', { room_id: channelId, msg: text, batch, imgs: images.length });
    for (const img of images) socket.emit('chat', { room_id: channelId, batch, img });
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
        emitChatForHistory(text);
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
            emitChatForHistory(text);
        }
        return;
    }

    const batch = crypto.randomUUID();
    mesh.sendChat({ type: 'chat', from: selfName, msg: text, batch, imgs: payloads.length });
    chat.openBatch({ batch, name: selfName, text, count: payloads.length, self: true });
    emitChatForHistory(
        text,
        payloads.map((payload) => payload.dataUrl)
    );
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
    return typeof value === 'string' && value.length <= AVATAR_MAX_CHARS && AVATAR_DATA_URL_RE.test(value) ? value : '';
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
    const me = members.get(selfUuid);
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
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
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
        else {
            // presenter status is granted at join time — rejoin with the token
            intentionalUnload = true;
            location.reload();
        }
    } catch (err) {
        const key = err?.status === 503 ? 'channel.hostLoginUnavailable' : 'channel.hostLoginFailed';
        $('#hostLoginError').textContent = t(key);
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
    clearPendingImages();
    for (const peerId of [...members.keys()]) dropPeer(peerId, { silent: true });
}

function teardownMedia() {
    stopRecoveryScan();
    clearPeerRecovery();
    stopPathMonitor();
    releaseWakeLock();
    // the connecting-badge state is per-peer too — drop it with the rest
    for (const timer of connectingTimers.values()) clearTimeout(timer);
    connectingTimers.clear();
    stuckConnecting.clear();
    hideOutageBanner();
    b1Attempts = 0;
    b1InFlight = false;
    selfReconnecting = false;
    clearTimeout(b1Timer);
    clearTimeout(b1ResetTimer);
    clearTimeout(disconnectToastTimer);
    disconnectToastTimer = null;
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
    // the disconnect handler keeps mesh/members for a resume — this path is a
    // dead end, drop them here so no stale member cards linger behind the overlay
    resetLocalMesh();
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
        micRaw:
            hub?.mic?.raw
                .getAudioTracks()
                .map((t) => `${t.readyState}:${t.enabled ? 'on' : 'off'}`)
                .join(',') ?? null,
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
                  })
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
                path: connPaths.get(peerId) ?? null,
                loss: lossStreaks.get(peerId) ?? null,
            })),
        recovery: {
            peers: Object.fromEntries(
                [...peerRecovery.entries()].map(([peerId, r]) => [
                    peerId,
                    {
                        attempts: r.attempts,
                        state: r.lastState,
                        escalated: r.escalated,
                        brokenForMs: Date.now() - r.brokenAt,
                    },
                ])
            ),
            b1Attempts,
            b1InFlight,
        },
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
            const path = await mesh.connPath(peerId).catch(() => null);
            out.push({ peerId, state: entry.pc.connectionState, path, rows });
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
    // probe: direct access to the mesh (pc states, restartIce) for recovery tests
    window.__vcMesh = () => mesh;
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
