/*
Channel 页面控制器 —— 装配 + 共享状态。

持有页面级的可变状态（socket/mesh/hub/聊天、会话身份、
各路流 —— 经 `s` 存取器对象暴露给子模块）以及晚绑定的
跨模块调用面 `x`，随后把 js/pages/channel/ 的各子模块
装配到一起：

  recovery.js      媒体/信令自愈阶梯 + 链路路径监视
  members.js       成员列表 UI + 花名册同步 + 主持人管理
  voice.js         麦克风/静音/PTT 控制 + 音频管线 + 播放
  settings.js      设置弹窗（设备/音量/外观/头像）
  composer.js      聊天输入区（回复/编辑/正在输入/@提及/图片）
  notify.js        未读标题徽章 + @提及桌面通知
  offline.js       离线横幅（navigator.onLine 探测）
  hostAuth.js      主持人登录 + 频道密码持久化
  socketEvents.js  socket.io 事件接线 + 聊天历史分页

控制器保留 join 流程、mesh 回调、页面生命周期
（leave/teardown/覆盖层）以及 #debug 探针（按项目惯例
安装在文件尾部）。
*/

import { api } from '/js/core/api.js';
import { Mesh } from '/js/core/webrtc.js';
import { AudioHub, getTestBeepUrl } from '/js/core/audio.js';
import { initChat, escapeRegExp, validReply } from '/js/core/chat.js';
import { openEmojiPicker } from '/js/core/emoji.js';
import {
    fileToImageMessage,
    sendImageData,
    createImageReceiver,
    DATA_URL_RE,
    MAX_FILE_BYTES,
} from '/js/core/images.js';
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
import { acquireMic } from '/js/pages/channel/micGrant.js';
import { createSettings } from '/js/pages/channel/settings.js';
import { createComposer } from '/js/pages/channel/composer.js';
import { createNotify } from '/js/pages/channel/notify.js';
import { createOfflineBanner } from '/js/pages/channel/offline.js';
import { createHostAuth, loadHostToken, loadChannelPw } from '/js/pages/channel/hostAuth.js';
import { createSocketEvents } from '/js/pages/channel/socketEvents.js';
import { createUi } from '/js/pages/channel/ui.js';
import { $, el, randomNick, toast } from '/js/core/utils.js';

const NICK_KEY = 'vc_nick';
const AUDIO_SETTINGS_KEY = 'vc_audio_settings';
const PEER_VOLUMES_KEY = 'vc_peer_volumes';
const AVATAR_KEY = 'vc_avatar';
const AVATAR_MAX_CHARS = 96 * 1024; // 广播/存储层对头像 data URL 的上限
const AVATARS_MAX = 100; // 记忆的对端头像硬上限（防刷屏）

const LOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const UNLOCK_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>';

// ---------------------------------------------------------------------------
// 共享状态
// ---------------------------------------------------------------------------

const channelId = (() => {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts[0] === 'c' ? decodeURIComponent(parts[1] || '') : '';
})();

const sinkSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

const defaultAudioSettings = {
    micDeviceId: '',
    spkDeviceId: '',
    micVolume: 1, // 输入增益 0..2 = 0%..200%
    volume: 1,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    ptt: false,
    pttKey: 'KeyV', // 按键说话的绑定键（event.code，用户可在设置里录制替换）
    musicMode: false,
    opusBitrate: 64, // 编码器码率上限，kbps（BITRATE_MIN..BITRATE_MAX）
    micChannels: 1, // 当前采集实际送达的声道数（1|2，由 watchMicHealth 刷新）
};

// Opus 发送端上限，盖到每个本地 offer/answer 与活动 sender 上：
// 语音模式偏带宽纪律（usedtx 在静默期停止发送）与抗丢包
// （useinbandfec —— Chrome 只在接收方协商了 FEC 时才发送 Opus FEC，
// 这与恢复引擎按丢包驱动的码率地板正好配合：留出的余量
// 用来喂冗余）；音乐模式偏保真（stereo + sprop-stereo ——
// stereo 声明我们的解码器接受立体声，sprop-stereo 声明我们
// 发送的流是立体声；两者齐备后 Chrome 的编码器才会真正
// 编码双声道）。null 表示删除该键 —— 每份 dict 都声明完整的
// 目标状态，这样在活动连接上切换模式时，re-offer 不会残留
// 另一模式的参数。
// 码率上限即用户滑杆值（settings.opusBitrate，kbps）；
// 切换音乐模式时以该模式默认值（192 / 64）重新播种，
// 之后仍可手动微调。
const BITRATE_MIN = 24;
const BITRATE_MAX = 256;

function loadAudioSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || '{}');
        const merged = { ...defaultAudioSettings, ...stored };
        // 滑杆上线前的音乐模式老用户从未存过码率 —— 保留其 192k
        // 上限，而不是悄悄把他们降到语音默认值
        if (stored.opusBitrate === undefined && merged.musicMode) merged.opusBitrate = 192;
        return merged;
    } catch {
        return { ...defaultAudioSettings };
    }
}

// 按用户记忆的音量，以显示名为键，重连、刷新页面后依然生效，
// 且同一人换到其他频道也能跟随
function loadPeerVolumes() {
    try {
        return JSON.parse(localStorage.getItem(PEER_VOLUMES_KEY)) || {};
    } catch {
        return {};
    }
}

const peerVolumes = loadPeerVolumes();

/** mesh 用的 Opus 上限（作为 getOpusFmtp 传入 —— 每轮 SDP 都会读取）。 */
function opusFmtp() {
    const raw = Math.round(Number(settings.opusBitrate));
    const kbps = Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, raw || 64));
    const maxaveragebitrate = kbps * 1000;
    // 音乐模式同样带着 FEC：192k 下带内冗余只吃掉一点点余量，
    // 却能让有损链路不至于把音乐剁碎。
    if (shareSound.active()) {
        // 一起听需要带宽与立体声。麦克风的处理开关刻意不动：
        // 外放场景下，正是 AEC 在防止共享音频经麦克风漏回。
        // fmtp 一侧（stereo）由 share.js 经 renegotiateAll 推送生效；
        // 码率这一半则经 setParameters 立即生效。这里 stereo 保持
        // 无条件开启 —— 即使麦克风本身是单声道，
        // 共享混音也是立体声。
        return {
            maxaveragebitrate: Math.max(maxaveragebitrate, 192000),
            stereo: 1,
            'sprop-stereo': 1,
            usedtx: null,
            useinbandfec: 1,
        };
    }
    if (settings.musicMode) {
        // 仅当采集实际送达两个声道时才声明 stereo：
        // 单声道麦克风 + stereo fmtp 会让编码器输出双份单声道，
        // 同样上限下每声道带宽砍半（watchMicHealth 负责跟踪）
        const stereo =
            settings.micChannels === 2 ? { stereo: 1, 'sprop-stereo': 1 } : { stereo: null, 'sprop-stereo': null };
        return { maxaveragebitrate, ...stereo, usedtx: null, useinbandfec: 1 };
    }
    return { maxaveragebitrate, usedtx: 1, useinbandfec: 1, stereo: null, 'sprop-stereo': null };
}

const settings = loadAudioSettings(); // 内容变更走属性赋值，从不整体重绑
let channelMeta = null;
let socket = null;
let mesh = null;
let hub = null;
let chat = null;

let selfName = '';
let selfUuid = null;
let joined = false;
// 在应用内导航（离开/重载）前置位，让 beforeunload 确认框
// 不对用户主动请求的退出弹出
let intentionalUnload = false;
let textOnly = false;
let micOn = false;
let deafened = false; // 自我静音：本地屏蔽所有远端成员的声音
let isPresenter = false;
let joinLockOn = false;
let localStream = null;
let rawMicStream = null; // getUserMedia 直接产出的原始流，尚未过输入增益
let hostToken = loadHostToken(channelId);
// 频道入房密码：自动 join 路径下从存储预填，
// 否则在 join 时从覆盖层输入框读取
let channelPassword = '';

/** peerId -> { peer_name, peer_presenter, peer_audio_status, joined_at, volume, self } */
const members = new Map();
const audioEls = new Map(); // peerId -> HTMLAudioElement（回退播放路径）
/** 显示名 -> 自定义头像 data URL（已校验） */
const avatars = new Map();
let selfAvatar = safeAvatarUrl(localStorage.getItem(AVATAR_KEY));

// 子模块看到的共享 `let` 状态实时视图：闭包捕获的是绑定，
// 而属性读取在每次重赋值后都保持最新。
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

// 晚绑定的跨模块调用面：在下方全部工厂函数跑完后才填充
// （事件处理器只会在那之后触发），子模块因此能互相调用、
// 也能调控制器，而不产生 import 环。
const x = {};

// ----- 屏幕 wake lock（移动端：锁屏会杀掉语音会话） -----
// 持有器在 ./channel/wakeLock.js；它在 visibility 变化时自行重新武装。
// 页面隐藏时 request() 会拒绝，所以「想要」的条件里包含可见。

const screenLock = createWakeLock({
    wanted: () => joined && !textOnly && document.visibilityState === 'visible',
});

// ----- 「一起听」：把共享声音混入对外的语音输出 -----
// 持有器在 ./channel/share.js（getDisplayMedia 编排）；
// 混音本身由 AudioHub.attachShare 注入麦克风管线的 destination。

const shareSound = createShareSound({
    isJoined: () => joined,
    ensureVoice: async () => {
        if (!localStream) await x.enableVoice(); // 纯文字成员：此时才请求麦克风
        return !!localStream;
    },
    getHub: () => hub,
    pipelineReady: () => voice.micProcessed && hub?.ctx?.state === 'running',
    applyGate: () => x.applyMicState(),
    broadcast: (on) => x.broadcastShare(on),
    refreshBitrate: () => {
        // 共享音频的 fmtp dict（stereo/usedtx）需要一轮 SDP —— 强制发起，
        // 让音乐上限立刻作用于活动链路，而不是等一场可能永远不来的
        // 重启；对外 content hint 同步跟进
        mesh?.setSendBitrate();
        mesh?.renegotiateAll();
        voice.refreshOutgoingHint();
    },
    toast,
});

const imageReceiver = createImageReceiver({
    onDone: ({ from, dataUrl, batch, peerId }) => {
        if (batch) chat.addBatchImage(batch, dataUrl, t('chat.image'));
        else {
            // 单发图片本身就是消息 —— 批量图片已随其 'chat' 文本帧
            // 响过提示音。显示名取自 DataChannel 对端，
            // 而不是自报的 'from' 字段。
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
// 子模块装配
// ---------------------------------------------------------------------------

const rec = createRecovery({ s, x, members, channelId, $, el, t });
const mem = createMembers({
    s,
    x,
    rec,
    members,
    avatars,
    channelId,
    peerVolumes,
    shareSound,
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
    MAX_FILE_BYTES,
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
    // 控制器面
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
    // 子模块
    rec,
    mem,
    voice,
    notify,
    composer,
    hostAuth,
    se,
    settings: settingsUi,
    // 高频触达的函数，摊平放置让子模块调用更简洁
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
    recoverMicDevice: voice.recoverMicDevice,
    applySpeaker: voice.applySpeaker,
    reapplyPeerVolume: voice.reapplyPeerVolume,
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

// UI 事件接线（按钮/表单/窗口监听的一次性绑定）在 ./channel/ui.js
const ui = createUi({ s, x, channelId });

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

boot();

async function boot() {
    if (!channelId) {
        location.replace('/');
        return;
    }

    await initI18n();
    // 重载会掐断通话，所以还有对端链路存活时先征求意见
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
        // 把自己的名字也算进去：能看到自己被高亮正是意义所在，
        // 且 .mention.self 依赖它判定（chat.js 与 selfName 比对）
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

    // 带密码频道：主持人用自己的登录通过，其他人必须
    // 输入密码（或已在上次 join 时记住）
    const pwFieldVisible = !!channelMeta.hasPassword && !hostToken;
    $('#joinPasswordField').classList.toggle('hidden', !pwFieldVisible);
    if (pwFieldVisible) {
        channelPassword = loadChannelPw(channelId);
        // 预填以保证下方 join() 的覆盖值与自动 join 路径取值一致
        $('#channelPwInput').value = channelPassword;
    }

    if (savedNick && (!pwFieldVisible || channelPassword)) {
        // 老访客：跳过昵称覆盖层，直接入房
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
    ui.bind();
}

// ---------------------------------------------------------------------------
// join 流程
// ---------------------------------------------------------------------------

let joining = false;

async function join({ textOnly: asTextOnly }) {
    // 重入护栏：昵称/密码输入框上的 Enter 可能在第一次 join 走到
    // setOverlayBusy 之前再触发一次（其 await 跨越麦克风设置）；
    // 否则第一个 socket 会在服务器侧变成孤儿幽灵会话
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
    // 覆盖层可见 = 手动尝试：以输入框为准（在「密码错误」往返之后
    // 它可能与记住的值不同）
    if (!$('#joinPasswordField').classList.contains('hidden')) {
        channelPassword = $('#channelPwInput').value;
    }

    // 释放上一次尝试遗留的一切（例如 'unauthorized' 后换新令牌
    // 重试会再 join 一次）
    teardownMedia();
    for (const peerId of [...members.keys()]) mem.dropPeer(peerId, { silent: true });

    selfName = nick;
    selfUuid = crypto.randomUUID();
    localStorage.setItem(NICK_KEY, nick);
    textOnly = asTextOnly;

    if (!textOnly) {
        // 未应答的权限弹窗绝不能劫持整个 join：
        // 否则下方的 socket 代码永远不会执行（见 ./channel/micGrant.js）
        let grant = await acquireMic(voice.buildAudioConstraints());
        if (!grant.stream && !grant.timedOut && settings.micDeviceId) {
            // 记住的麦克风在两次会话之间消失了：过期的精确
            // deviceId 会永远失败 —— 清一次，改用默认设备重试
            // （仅本次会话，与 voice.js 通话中的回退一致）
            settings.micDeviceId = '';
            grant = await acquireMic(voice.buildAudioConstraints());
            if (grant.stream) toast(t('channel.micFallback'), 'warn');
        }
        rawMicStream = grant.stream;
        if (!grant.stream) {
            textOnly = true;
            toast(t(grant.timedOut ? 'channel.errors.micPending' : 'channel.errors.micDenied'), 'warn');
        }
    }
    if (rawMicStream) {
        rawMicStream.getTracks().forEach((track) => (track.enabled = true));
        voice.watchMicHealth(rawMicStream); // 热拔插恢复从现在开始监视采集
    }
    localStream = rawMicStream;

    hub = new AudioHub();
    try {
        await hub.ensureContext();
    } catch {
        /* 说话指示灯退化为关闭，语音仍正常 */
    }
    if (hub.ctx) {
        // 上下文可能以挂起态启动（autoplay 策略 —— 例如页面加载即
        // 自动 join、没有任何用户手势）：对端先经 <audio> 元件播放，
        // 待交互将其 resume 后再升级到增益通路（手势钩子每页面
        // 只绑定一次 —— voice.bindResumeOnGesture）
        hub.ctx.addEventListener('statechange', voice.onCtxStateChange);
    }
    voice.syncMicPipeline(); // 可能把 localStream 换成增益处理后的流
    if (localStream && hub.ctx) hub.watch('self', localStream, localLevelCb);
    voice.applySpeaker(); // 一开始就把 Web Audio 播放路由到所选输出设备

    // 重连节奏比 socket.io 默认更快（默认 1000..5000ms、
    // 抖动 0.5）：VPN/加速器切换会掐断 websocket 几秒，而默认
    // 退避可能在网络已恢复之后仍干等最多 5s。这里把首次
    // 重试压到亚秒级、上限 2s，并给每次尝试都设握手足时
    // 上限，避免半开的隧道把单次重试拖满引擎默认的
    // 20s 超时。
    socket = io({
        transports: ['websocket'],
        reconnectionDelay: 400,
        reconnectionDelayMax: 2000,
        randomizationFactor: 0.3,
        timeout: 8000,
    });
    mesh = new Mesh({ signaling: socket, handlers: meshHandlers(), getOpusFmtp: opusFmtp, getSelfId: () => selfUuid });
    if (localStream) mesh.setLocalStream(localStream);

    se.registerSocketHandlers();

    setOverlayBusy(true);
    micOn = !textOnly && !!localStream;
    voice.applyMicState(); // 此时还没有 socket —— 仅刷新按钮；peer_audio 随 join 载荷发送
    voice.seedLastOnAir(); // 基线必须与该载荷一致，否则第一次静音切换不会广播
}

function localLevelCb({ level }) {
    const pct = `${Math.min(100, Math.round(level * 220))}%`;
    $('#micLevelBar').style.width = pct;
    $('#settingsMicBar').style.width = pct;
}

// ---------------------------------------------------------------------------
// mesh 回调
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
                    // 连续光环：头像辉光随音量呼吸
                    node.style.setProperty('--lvl', (Math.min(1, level * 2.2) || 0).toFixed(3));
                });
            }
        },
        onChat(peerId, data) {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'typing') {
                // 发送者身份以 DataChannel 对端为准，不是 `from`
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
                    // 一次发送的文字 + N 张图渲染为同一条合并气泡
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
            // 链路刚稳定就做第一次路径读取；此后靠轮询保鲜
            if (state === 'connected') rec.checkPeerPath(peerId, rec.PATH_FIRST_CHECK_MS);
        },
    };
}

// ---------------------------------------------------------------------------
// 头部操作（主持人徽章 / 导出 / 入房锁）
// ---------------------------------------------------------------------------

function updateHeaderActions() {
    $('#hostBadge').classList.toggle('hidden', !isPresenter);
    // 主持人聊天导出（Markdown）—— 仅主持人，凭 host JWT 提供
    $('#exportChatBtn').classList.toggle('hidden', !isPresenter);
    // 自动 join（无预 join 覆盖层）之后主持人登录入口仍要可达
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
// 离开 / 拆除 / 覆盖层状态
// ---------------------------------------------------------------------------

function leave() {
    // 主动退出：teardown 在导航发生之前就把 joined 标记为 false，
    // beforeunload 护栏因此保持沉默，socket 'disconnect' 处理器
    // 也不再弹「连接断开，重连中…」提示。同时立刻移除对端并
    // 停掉麦克风，而不是等 pagehide。
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
    se.stopIceRefresh();
    se.stopJoinAck();
    screenLock.release();
    shareSound.stop({ silent: true }); // 释放屏幕采集 + 在 socket 断开前告知房间
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
    // 自动 join 时覆盖层是隐藏的 —— 把它带回来让错误可见
    $('#joinOverlay').classList.remove('hidden');
    $('#joinError').textContent = message;
    teardownMedia();
    // disconnect 处理器会为原地恢复保留 mesh/members —— 而这条路是
    // 死路，在这里清掉它们，避免覆盖层背后残留过期的成员卡片
    rec.resetLocalMesh();
    socket?.disconnect();
    socket = null;
    mesh = null;
}

/** 致命状态（频道不存在 / 被踢）—— 彻底禁止再入房。 */
function showJoinFatal(message) {
    $('#joinOverlay').classList.remove('hidden');
    setOverlayBusy(false);
    $('#joinError').textContent = message;
    $('#joinBtn').disabled = true;
    $('#textOnlyBtn').disabled = true;
    $('#hostLoginBtn').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function safeAvatarUrl(value) {
    return typeof value === 'string' && value.length <= AVATAR_MAX_CHARS && DATA_URL_RE.test(value) ? value : '';
}

// ---------------------------------------------------------------------------
// #debug 探针在 ./channel/debug.js —— 安装时传入实时快照
// 取值器，每个探针都在调用时读取控制器当前状态。
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
