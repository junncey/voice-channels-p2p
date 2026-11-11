/*
频道页的语音控制 + 音频管线。

持有有效麦克风状态（手动静音 / PTT）、输入增益管线
（原始采集 <-> WebAudio 处理轨，随 AudioContext
挂起/恢复重新同步）以及远端播放：可行时按用户音量
0..300% × 总音量 0..100% 走 GainNode，以 muted
`<audio>` 元件为回退路径（Chromium WebAudio bug —— 见
core/audio.js）。共享页面状态经 `s` 存取器对象到达，
跨模块调用走晚绑定的 `x` 调用面（两者都归
channel.js 所有）；成员卡片助手经 `mem`（members.js）。
*/

import { keyLabel, normalizePttKey } from '/js/core/utils.js';

export function createVoice({ s, x, mem, members, audioEls, settings, channelId, screenLock, playSound, t, $, el }) {
    let pttActive = false;
    let lastOnAir = false; // 我们上一次广播的 peerStatus(audio)
    let lastDeafenSent = null; // 我们上一次广播的 peerStatus(deafen)
    let micProcessed = false; // 对外轨道来自增益管线
    // play() 被 autoplay 策略拒绝的回退 <audio> 元件 ——
    // 在首个用户手势 / 上下文状态翻转时重试（见 retryPendingPlays）
    const pendingPlays = new Set();

    /** 麦克风此刻是否真的在对外发送 */
    function onAir() {
        return !!s.localStream && s.micOn && (!settings.ptt || pttActive);
    }

    /** PTT 模式开启时 micBtn 的悬停标题 —— 显示用户绑定的键。 */
    function pttTitle() {
        return t('channel.pttOn', { key: keyLabel(normalizePttKey(settings.pttKey)) });
    }

    /**
     * 把 on-air 状态压到正确的轨道上。通常对外轨道承载静音门控；
     * 一起听进行期间对外混音必须保持活跃（音乐在它身上），
     * 仅麦克风在原始采集处单独门控。
     */
    function applyTrackGate(live) {
        if (!s.localStream) return;
        if (micProcessed && x.shareSound.active()) {
            s.rawMicStream?.getAudioTracks().forEach((track) => (track.enabled = live));
            s.localStream.getAudioTracks().forEach((track) => (track.enabled = true));
        } else {
            s.localStream.getAudioTracks().forEach((track) => (track.enabled = live));
        }
    }

    function onMicBtnClick() {
        if (s.textOnly || !s.localStream) {
            enableVoice();
            return;
        }
        // 采集已死（设备拔出、自动恢复失败）：重新获取，
        // 而不是切换一个反正没人听得见的静音门控
        if (micTrackDead()) {
            recoverMicDevice();
            return;
        }
        setMic(!s.micOn);
    }

    function setMic(on) {
        const next = on && !!s.localStream;
        if (next === s.micOn) return;
        s.micOn = next;
        applyMicState();
        // 手动切换与主持人静音的点击反馈音；PTT 键
        // 直接驱动 applyMicState，必须保持无声
        playSound(next ? 'micOn' : 'micOff');
    }

    /** 把有效状态推到本地轨道 / 对端 / UI。 */
    function applyMicState() {
        const live = onAir();
        applyTrackGate(live);
        if (s.socket && s.joined && live !== lastOnAir) {
            lastOnAir = live;
            s.socket.emit('peerStatus', {
                room_id: channelId,
                peer_name: s.selfName,
                peer_id: s.selfUuid,
                element: 'audio',
                status: live,
            });
        }
        const self = members.get(s.selfUuid);
        if (self) self.peer_audio_status = live;
        updateVoiceControls();
        syncPttHoldButton();
        mem.updateMicIconNode(s.selfUuid, live); // 原地更新：整体重渲染会杀死拖动中的音量滑杆
    }

    /** 把广播去重基线对齐 join 载荷的 peer_audio —— 不发事件。 */
    function seedLastOnAir() {
        lastOnAir = onAir();
    }

    // ----- 自我静音：一次性静音所有远端成员（自己的麦克风不受影响） -----

    function toggleDeafen() {
        s.deafened = !s.deafened;
        applyDeafenState();
    }

    function applyDeafenState() {
        $('#deafenBtn').classList.toggle('on', s.deafened);
        $('#deafenBtn').title = t(s.deafened ? 'channel.undeafen' : 'channel.deafen');
        const self = members.get(s.selfUuid);
        if (self) self.peer_deafen = s.deafened;
        const icon = $('#memberList .member[data-id="' + (s.selfUuid || '') + '"] .member-deafen');
        if (icon) icon.classList.toggle('on', s.deafened);
        reapplyAllVolumes(); // 0×任何数，两条播放路径同时静音
        if (s.socket && s.joined && s.deafened !== lastDeafenSent) {
            lastDeafenSent = s.deafened;
            s.socket.emit('peerStatus', {
                room_id: channelId,
                peer_name: s.selfName,
                peer_id: s.selfUuid,
                element: 'deafen',
                status: s.deafened,
            });
        }
    }

    // ----- 「一起听」：共享声音状态 -> 房间 + UI -----

    function broadcastShare(on) {
        const self = members.get(s.selfUuid);
        if (self) self.peer_share = on;
        const node = $(`#memberList .member[data-id="${s.selfUuid || ''}"] .member-share`);
        if (node) node.classList.toggle('on', on);
        else mem.renderMembers();
        const btn = $('#shareSoundBtn');
        if (btn) {
            btn.classList.toggle('on', on);
            btn.title = t(on ? 'channel.shareStop' : 'channel.shareSound');
        }
        if (s.socket && s.joined) {
            s.socket.emit('peerStatus', {
                room_id: channelId,
                peer_name: s.selfName,
                peer_id: s.selfUuid,
                element: 'share',
                status: on,
            });
        }
    }

    function bindPttKeys() {
        window.addEventListener('keydown', (event) => {
            // Ctrl/Cmd+M：在任何位置切换麦克风（输入区打字必须
            // 继续插入字母 m，所以保持豁免）
            if ((event.ctrlKey || event.metaKey) && event.code === 'KeyM') {
                const target = event.target;
                const typing =
                    target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
                if (!typing && s.joined && s.localStream) {
                    event.preventDefault();
                    setMic(!s.micOn);
                }
                return;
            }
            // 绑定键只有单独按下才算 PTT —— Ctrl/Cmd/Alt
            // + 键属于快捷键领地（Ctrl+V 粘贴绝不能开麦）
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.code !== normalizePttKey(settings.pttKey) || event.repeat) return;
            if (!settings.ptt || !s.joined || !s.localStream || !s.micOn) return;
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
            if (event.code !== normalizePttKey(settings.pttKey) || !pttActive) return;
            pttActive = false;
            applyMicState();
        });
        // 按住中途失焦（Alt+Tab、系统对话框、副屏）：失焦窗口
        // 收不到 keyup —— 释放 PTT，而不是对着虚空发送，
        // 直到下一轮按键往返
        window.addEventListener('blur', () => {
            if (!pttActive) return;
            pttActive = false;
            applyMicState();
        });
    }

    // ----- 触屏 PTT：为没有键盘的设备提供按住说话按钮 -----
    // 仅在 PTT 模式开启且主 pointer 为 coarse 时可见。

    const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

    function bindPttHoldButton() {
        const btn = $('#pttHoldBtn');
        if (!btn) return;
        const start = (event) => {
            if (!settings.ptt || !s.joined || !s.localStream || !s.micOn || pttActive) return;
            event.preventDefault();
            btn.classList.add('active');
            pttActive = true;
            applyMicState();
        };
        const stop = () => {
            if (!pttActive) return;
            btn.classList.remove('active');
            pttActive = false;
            applyMicState();
        };
        btn.addEventListener('pointerdown', start);
        btn.addEventListener('pointerup', stop);
        btn.addEventListener('pointercancel', stop);
        btn.addEventListener('pointerleave', stop);
        btn.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    /** 按住中途 PTT 模式被关掉：释放按键状态。 */
    function resetPtt() {
        pttActive = false;
    }

    function syncPttHoldButton() {
        const btn = $('#pttHoldBtn');
        if (!btn) return;
        const show = coarsePointer && settings.ptt && s.joined && !!s.localStream && s.micOn;
        btn.classList.toggle('hidden', !show);
        if (!show) btn.classList.remove('active');
    }

    function buildAudioConstraints() {
        const audio = {
            // 音乐模式覆盖处理开关 —— 浏览器会糟蹋音乐
            echoCancellation: settings.musicMode ? false : settings.echoCancellation,
            noiseSuppression: settings.musicMode ? false : settings.noiseSuppression,
            autoGainControl: settings.musicMode ? false : settings.autoGainControl,
        };
        if (settings.musicMode) {
            // 设备支持时采集立体声（ideal：单声道麦克风照常
            // 工作）—— 若采集本身就被下混成单声道，链路的
            // stereo=1/sprop-stereo=1 fmtp 就毫无意义
            audio.channelCount = { ideal: 2 };
        }
        if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };
        return { audio };
    }

    /**
     * 对外轨道的编码器提示：'speech' 让 Chrome 更放心地做
     * DTX/FEC 权衡，'music'（音乐模式或共享进行中）保持
     * 保真优先行为。零成本，不支持的浏览器会忽略。
     */
    function refreshOutgoingHint() {
        const hint = settings.musicMode || x.shareSound?.active() ? 'music' : 'speech';
        for (const track of [...(s.rawMicStream?.getAudioTracks() || []), ...(s.localStream?.getAudioTracks() || [])]) {
            if ('contentHint' in track) track.contentHint = hint;
        }
    }

    /**
     * 共享 AudioContext 运行期间，把对外轨道指向增益处理后的麦克
     * 风流；挂起的上下文只会发出静音，所以在上下文恢复之前
     * 改发原始轨道（statechange 会重跑这里）。
     */
    function syncMicPipeline() {
        if (!s.rawMicStream) return;
        const wantProcessed = !!s.hub?.ctx && s.hub.ctx.state === 'running';
        if (wantProcessed === micProcessed) return;
        const live = onAir();
        if (wantProcessed) {
            const processed = s.hub.attachMic(s.rawMicStream, settings.micVolume);
            if (!processed) return;
            s.localStream = processed;
            micProcessed = true;
            applyTrackGate(live); // 换轨之前：门控混音流（共享时则门控原始麦克风）
            refreshOutgoingHint(); // 对外轨道对象随管线变了
            s.mesh?.replaceAudioTrack(processed.getAudioTracks()[0], processed);
        } else {
            s.hub?.detachMic();
            s.rawMicStream.getAudioTracks().forEach((track) => (track.enabled = live));
            s.localStream = s.rawMicStream;
            micProcessed = false;
            refreshOutgoingHint();
            s.mesh?.replaceAudioTrack(s.rawMicStream.getAudioTracks()[0], s.rawMicStream);
        }
        if (s.hub?.ctx) s.hub.watch('self', s.localStream, x.localLevelCb);
    }

    /**
     * 仅设置变化（NS/EC/AGC/音乐模式）：原地重配活动轨道，
     * 而不是二次开麦 —— 第二次 getUserMedia 在单采集设备
     * （蓝牙 HFP 耳机）上会直接失败，在其他设备上也会扰动
     * 音频路由。轨道对象存活，WebAudio 管线与 sender 的
     * replaceTrack 路径都不受触碰。
     * 新约束可验证地生效时返回 true；
     * 任何拒绝、超时或不匹配都回退到完整重获取。
     */
    async function tryApplyMicConstraints() {
        const rawTrack = s.rawMicStream?.getAudioTracks()[0];
        if (!rawTrack || rawTrack.readyState !== 'live' || typeof rawTrack.applyConstraints !== 'function') {
            return false;
        }
        // 设备切换必须走完整路径（重配的轨道可能还挂着过期路由）；
        // 未上报 deviceId 也证明不了什么
        if ((rawTrack.getSettings?.().deviceId || '') !== settings.micDeviceId) return false;
        const audio = buildAudioConstraints().audio;
        try {
            await Promise.race([
                rawTrack.applyConstraints(audio),
                new Promise((_, reject) => setTimeout(() => reject(new Error('mic-constraint-timeout')), 3000)),
            ]);
        } catch {
            return false;
        }
        // resolve 不代表浏览器真的重配了：核对它回报的开关
        // （channelCount 这类 ideal 值字段无法验证）
        const applied = rawTrack.getSettings?.() || {};
        for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
            if (typeof applied[key] === 'boolean' && applied[key] !== audio[key]) return false;
        }
        watchMicHealth(s.rawMicStream); // 重新同步 micChannels（stereo fmtp 可能需要一轮重协商）
        refreshOutgoingHint(); // 音乐模式会翻转编码器 content hint
        return true;
    }

    /**
     * 按当前设置重新获取麦克风（设备切换或处理开关）并热替换
     * 对外轨道 —— 不涉及重协商。
     */
    async function reacquireMic() {
        // 仅处理变化的改动走活动轨道的 applyConstraints；下方完整路径
        // 仍是设备切换与死采集的答案
        if (s.localStream && (await tryApplyMicConstraints())) return;
        const hadStream = !!s.localStream;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
        } catch (err) {
            // 配置的设备在枚举与打开之间消失了 —— 过期的精确
            // deviceId 会带着 OverconstrainedError 永远失败，所以
            // 丢弃它，向默认设备回退一次（recoverMicDevice 只覆盖
            // track-onended 路径；这里覆盖设置界面）
            const staleDevice = settings.micDeviceId && ['OverconstrainedError', 'NotFoundError'].includes(err?.name);
            if (!staleDevice) throw err;
            settings.micDeviceId = '';
            x.refreshDeviceSelects();
            stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
            x.toast(t('channel.micFallback'), 'warn');
        }
        const track = stream.getAudioTracks()[0];
        // 设备/处理变化保持当前静音态；启用语音则把麦克风打开
        s.micOn = hadStream ? s.micOn : true;
        s.textOnly = false;
        screenLock.sync(); // 从纯文字启用语音：现在开始保持屏幕常亮
        track.enabled = onAir();
        if (s.hub) await s.hub.ensureContext().catch(() => {});

        // 围绕新采集重建输入增益管线；旧麦克风（原始采集 +
        // 处理轨）在热替换完成后停止
        const oldRaw = s.rawMicStream;
        const oldOut = s.localStream;
        s.hub?.detachMic();
        micProcessed = false;
        s.rawMicStream = stream;
        s.localStream = stream;
        watchMicHealth(stream); // 新采集带上自己的死亡监视
        refreshOutgoingHint(); // 模式/设备开关会重新采集 —— 提示可能已翻转
        syncMicPipeline(); // 可能时升级到处理轨
        if (!micProcessed) s.mesh?.replaceAudioTrack(track, stream);
        if (s.hub?.ctx) s.hub.watch('self', s.localStream, x.localLevelCb);
        mem.ensureSelfMember();
        applyMicState();
        oldOut?.getTracks().forEach((old) => old.stop());
        oldRaw?.getTracks().forEach((old) => old.stop());
        x.refreshDeviceSelects(); // 授权后标签才可用
    }

    async function enableVoice() {
        try {
            await reacquireMic();
        } catch {
            x.toast(t('channel.errors.micDenied'), 'warn');
        }
    }

    /** 设置弹窗调用方：重新获取麦克风，拒绝时弹共享提示。 */
    function reacquireMicOrToast() {
        return reacquireMic().catch(() => x.toast(t('channel.errors.micDenied'), 'warn'));
    }

    // ----- 麦克风设备健康：热拔的 USB/蓝牙耳机（或系统收回麦克风）
    // 会在通话中途终结采集轨道 —— 没有恢复的话，我们这边
    // 还在说话，房间里却只剩寂静 -----

    let micRecovering = false;

    /** 原始采集已彻底死亡（所有轨道 ended）。 */
    function micTrackDead() {
        const tracks = s.rawMicStream?.getAudioTracks() || [];
        return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
    }

    /** 监视原始采集的设备死亡；每次 reacquireMic 重新武装。 */
    function watchMicHealth(stream) {
        if (!stream) return;
        // stereo fmtp 必须与采集「实际送达」的声道一致（音乐模式
        // 请求 ideal:2，单声道麦克风仍产单声道）：不匹配会让编码器
        // 以每声道一半的码率输出双份单声道。通话中途翻转
        // （设备切换）需要一次普通重协商来推送新 dict。
        const channels = stream.getAudioTracks()[0]?.getSettings?.().channelCount;
        const next = channels >= 2 ? 2 : 1;
        if (next !== settings.micChannels) {
            settings.micChannels = next;
            if (s.joined) s.mesh?.renegotiateAll();
        }
        for (const track of stream.getAudioTracks()) {
            track.onended = () => recoverMicDevice();
        }
    }

    /**
     * 设备消失后重新获取麦克风。配置的设备不在时回退到默认设备
     * （过期的精确 deviceId 会带着 OverconstrainedError 永远失败）
     * —— 清空的选择仅本次会话有效，
     * 设备很可能还会回来。
     */
    async function recoverMicDevice() {
        if (micRecovering || !s.rawMicStream) return;
        if (!micTrackDead()) return; // 扬声器变化/新增设备 —— 采集未受影响
        micRecovering = true;
        try {
            if (settings.micDeviceId && !(await micDevicePresent())) {
                settings.micDeviceId = '';
                x.refreshDeviceSelects();
            }
            await reacquireMic(); // 保留静音态，热替换对外轨道
            x.toast(t('channel.micRecovered'), 'ok');
        } catch {
            x.toast(t('channel.errors.micLost'), 'warn');
        } finally {
            micRecovering = false;
        }
    }

    /** 配置的麦克风仍在枚举中吗？未显式选择设备即视为在。 */
    async function micDevicePresent() {
        if (!settings.micDeviceId) return true;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.some((d) => d.kind === 'audioinput' && d.deviceId === settings.micDeviceId);
        } catch {
            return true; // 枚举被拒：假定在，交给 getUserMedia 判定
        }
    }

    function updateVoiceControls() {
        const micBtn = $('#micBtn');
        const live = onAir();
        if (!s.localStream) {
            micBtn.classList.add('muted');
            mem.setIconBtn(micBtn, mem.MIC_OFF_SVG, t('channel.enableVoice'));
        } else if (s.micOn && settings.ptt) {
            micBtn.classList.toggle('muted', !live);
            mem.setIconBtn(micBtn, live ? mem.MIC_ON_SVG : mem.MIC_OFF_SVG, pttTitle());
        } else if (s.micOn) {
            micBtn.classList.remove('muted');
            mem.setIconBtn(micBtn, mem.MIC_ON_SVG, t('channel.micOn'));
        } else {
            micBtn.classList.add('muted');
            mem.setIconBtn(micBtn, mem.MIC_OFF_SVG, t('channel.micOff'));
        }
        if (!live) {
            $('#micLevelBar').style.width = '0%';
            $('#settingsMicBar').style.width = '0%';
        }
    }

    // -------------------------------------------------------------------------
    // 远端音频播放 —— 按用户音量 0..300% × 总音量 0..100%
    // -------------------------------------------------------------------------

    /** Chromium：经 GainNode 播放（可超过 100% + AudioContext 输出）。 */
    function webAudioPlayback() {
        return !!s.hub?.ctx && s.hub.ctx.state === 'running' && typeof s.hub.ctx.setSinkId === 'function';
    }

    /** 上下文状态翻转 —— 在增益通路与原始通路间搬移播放/麦克风。 */
    function onCtxStateChange() {
        if (webAudioPlayback()) {
            for (const [peerId, audio] of [...audioEls]) {
                if (audio.srcObject) attachRemoteAudio(peerId, audio.srcObject);
            }
            applySpeaker();
        } else {
            // 又挂起了：增益图会无声 —— 改走元件播放
            for (const [peerId, player] of [...(s.hub?.players?.entries() || [])]) {
                const stream = player.src.mediaStream;
                if (stream) attachRemoteAudio(peerId, stream);
            }
            retryPendingPlays(); // 状态翻转可能已解除元件播放的阻塞
        }
        syncMicPipeline(); // 原始轨 <-> 增益处理轨
    }

    /** 远端对端的总增益：按用户音量 × 总音量 ×（静音时为 0） */
    function peerTotalGain(peerId) {
        return (members.get(peerId)?.volume ?? 1) * settings.volume * (s.deafened ? 0 : 1);
    }

    function removeAudioEl(peerId) {
        const audio = audioEls.get(peerId);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
            audioEls.delete(peerId);
        }
        pendingPlays.delete(peerId);
    }

    /**
     * 常驻手势钩子：恢复会话中途被挂起的 AudioContext，
     * 并重试被 autoplay 拒绝的回退元件。join 时用 { once: true }
     * 挂的一对钩子会被第一次点击消费掉，留下一个之后才挂起
     * （iOS 来电打断、系统音频会话丢失）且无法回头恢复的
     * 上下文 —— 播放会一直停在降级的 <audio> 回退上，
     * 麦克风增益管线也一直关闭。
     * 上下文运行期间，每次手势只花一次状态检查，
     * 外加一个通常为空的重试集合。
     */
    function bindResumeOnGesture() {
        const resume = () => {
            if (s.hub?.ctx?.state === 'suspended') s.hub.ctx.resume().catch(() => {});
            retryPendingPlays();
        };
        window.addEventListener('pointerdown', resume);
        window.addEventListener('keydown', resume);
    }

    /**
     * 对 autoplay 策略拒绝过的回退元件重跑 play()（尚无用户
     * 手势 —— 加载即自动 join，或 Firefox 上元件路径是永久态）。
     * 由首次 pointerdown/keydown 与上下文状态翻转调用；
     * 没有它，被拒元件会一直无声，直到下一次 attachRemoteAudio
     * —— 安静链路上这可能永远不会来。
     */
    function retryPendingPlays() {
        for (const peerId of [...pendingPlays]) {
            const audio = audioEls.get(peerId);
            if (!audio || !audio.srcObject) {
                pendingPlays.delete(peerId);
                continue;
            }
            audio
                .play()
                .then(() => pendingPlays.delete(peerId))
                .catch(() => {}); // still blocked — keep for the next trigger
        }
    }

    function attachRemoteAudio(peerId, stream) {
        const total = peerTotalGain(peerId);
        if (webAudioPlayback() && s.hub.playPeer(peerId, stream, total)) {
            removeAudioEl(peerId);
            return;
        }
        // 回退路径：<audio> 元件支持 element.setSinkId 但上限 100%
        s.hub?.stopPeer(peerId);
        let audio = audioEls.get(peerId);
        if (!audio) {
            audio = el('audio', { autoplay: '', playsinline: '' });
            audio.style.display = 'none';
            document.body.append(audio);
            audioEls.set(peerId, audio);
            x.applySink(audio);
        }
        audio.srcObject = stream;
        audio.volume = Math.min(1, total);
        audio
            .play()
            .then(() => pendingPlays.delete(peerId))
            .catch(() => pendingPlays.add(peerId)); // 被拒：手势/状态翻转时重试
    }

    function reapplyPeerVolume(peerId) {
        const total = peerTotalGain(peerId);
        if (s.hub) s.hub.setPeerVolume(peerId, total);
        const audio = audioEls.get(peerId);
        if (audio) audio.volume = Math.min(1, total);
    }

    function reapplyAllVolumes() {
        // members 以会话 uuid 为键 —— 每个条目都是远端对端
        for (const peerId of members.keys()) reapplyPeerVolume(peerId);
    }

    /** 把远端播放路由到所选输出设备。 */
    async function applySpeaker() {
        if (webAudioPlayback()) {
            await s.hub.setSink(settings.spkDeviceId);
            return;
        }
        for (const audio of audioEls.values()) await x.applySink(audio);
    }

    /** 拆除：增益管线随 AudioContext 一起消失。 */
    function resetProcessed() {
        micProcessed = false;
    }

    return {
        onAir,
        onMicBtnClick,
        setMic,
        applyMicState,
        seedLastOnAir,
        resetPtt,
        toggleDeafen,
        applyDeafenState,
        broadcastShare,
        bindPttKeys,
        bindPttHoldButton,
        syncPttHoldButton,
        buildAudioConstraints,
        refreshOutgoingHint,
        watchMicHealth,
        recoverMicDevice,
        syncMicPipeline,
        reacquireMic,
        enableVoice,
        reacquireMicOrToast,
        updateVoiceControls,
        webAudioPlayback,
        onCtxStateChange,
        retryPendingPlays,
        bindResumeOnGesture,
        removeAudioEl,
        attachRemoteAudio,
        reapplyPeerVolume,
        reapplyAllVolumes,
        applySpeaker,
        resetProcessed,
        get micProcessed() {
            return micProcessed;
        },
    };
}
