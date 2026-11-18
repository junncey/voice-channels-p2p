/*
设置弹窗（音频设备、处理开关、PTT、音量、码率、
操作音效、通知）以及外观面板（主题、语言）
与自定义头像选择 —— ⚙ 按钮背后的一切。
共享页面状态经 `s` 存取器对象到达，跨模块调用走晚绑定的
`x` 调用面（两者都归 channel.js 所有）；成员卡片助手经
`mem`（members.js）。
*/
import { isModifierCode, keyLabel, normalizePttKey } from '/js/core/utils.js';
import { fileToDataUrl, MAX_FILE_BYTES } from '/js/core/images.js';

export function createSettings({
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
}) {
    let micDevices = [];
    let spkDevices = [];
    let micDropdown = null;
    let spkDropdown = null;

    function bindSettingsUi() {
        micDropdown = createDropdown({
            getItems: () => deviceItems('mic'),
            getValue: () => settings.micDeviceId,
            onSelect: (value) => {
                settings.micDeviceId = value;
                saveAudioSettings();
                // 纯文字模式下切换设备兼作「启用语音」
                if (s.localStream) x.reacquireMicOrToast();
                else x.enableVoice();
            },
        });
        spkDropdown = createDropdown({
            getItems: () => deviceItems('spk'),
            getValue: () => settings.spkDeviceId,
            onSelect: (value) => {
                settings.spkDeviceId = value;
                saveAudioSettings();
                x.applySpeaker();
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
                if (s.localStream) x.reacquireMicOrToast();
            });
        }

        $('#musicToggle').addEventListener('change', (event) => {
            settings.musicMode = event.target.checked;
            // 用该模式默认值重新播种码率滑杆（手动微调可以跨会话
            // 保留，但模式切换是明确的预设选择）
            settings.opusBitrate = settings.musicMode ? 192 : 64;
            saveAudioSettings();
            reflectMusicMode();
            reflectBitrate();
            // 在被覆盖的处理约束下重新采集（热替换对外轨道），并立即
            // 把新码率推到活动 sender 上；stereo/usedtx 住在 fmtp 里，
            // 所以还要强制一次普通重协商 ——
            // 健康的链路绝不会自己产生下一轮 SDP
            if (s.localStream) x.reacquireMicOrToast();
            s.mesh?.setSendBitrate();
            s.mesh?.renegotiateAll();
        });

        $('#pttToggle').addEventListener('change', (event) => {
            settings.ptt = event.target.checked;
            x.resetPtt();
            saveAudioSettings();
            x.applyMicState();
        });
        bindPttKeyUi();

        $('#micVolumeSlider').addEventListener('input', (event) => {
            settings.micVolume = Number(event.target.value) / 100;
            $('#micVolumeVal').textContent = `${event.target.value}%`;
            s.hub?.setMicGain(settings.micVolume); // 立即生效，无重协商
            saveAudioSettings();
        });

        $('#bitrateSlider').addEventListener('input', (event) => {
            settings.opusBitrate = Number(event.target.value);
            $('#bitrateVal').textContent = `${event.target.value} kbps`;
            saveAudioSettings();
            // 经 setParameters 推到活动 sender，无重协商；
            // fmtp 上限搭下一轮 SDP 的车
            s.mesh?.setSendBitrate();
        });

        $('#volumeSlider').addEventListener('input', (event) => {
            settings.volume = Number(event.target.value) / 100;
            $('#volumeVal').textContent = `${event.target.value}%`;
            x.reapplyAllVolumes();
            saveAudioSettings();
        });

        $('#testMicBtn').addEventListener('click', onTestMicClick);
        $('#testSpkBtn').addEventListener('click', playTestBeep);

        // 操作音效：总开关、音量、逐事件音效选择器
        initSoundSettings({ applySink, toast });

        // 被 @ 时的桌面通知（不支持处隐藏）
        $('#notifySection').classList.toggle('hidden', !x.notifySupported);
        $('#notifyToggle').addEventListener('change', x.onNotifyToggle);

        // 设备增删：刷新下拉框；若活动采集随设备一起死亡
        //（热拔耳机），voice.js 会重新获取麦克风
        navigator.mediaDevices?.addEventListener?.('devicechange', () => {
            refreshDeviceSelects();
            x.recoverMicDevice();
            recoverSpeakerDevice();
        });
    }

    // ----- PTT 绑定键：点击按钮进入录制态，按下任意单键即完成绑定 -----
    // 录制监听挂在 window 的 capture 阶段并吞掉事件，抢在（bubble 阶段的）
    // voice.js 全局 PTT/Ctrl+M 处理器之前，录制中的按键不会误开麦。

    let pttRecording = false;

    /** 按钮与提示文案的当前态回显：录制中显示等待提示，否则显示键名。 */
    function reflectPttKey() {
        const key = keyLabel(normalizePttKey(settings.pttKey));
        $('#pttKeyBtn').textContent = pttRecording ? t('settings.pttKeyRecord') : key;
        $('#pttKeyBtn').classList.toggle('recording', pttRecording);
        $('#pttHint').textContent = t('settings.pushToTalkHint', { key });
    }

    function stopPttRecording() {
        if (!pttRecording) return;
        pttRecording = false;
        window.removeEventListener('keydown', onPttKeyRecord, true);
        reflectPttKey();
    }

    function onPttKeyRecord(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.code === 'Escape') {
            stopPttRecording();
            return;
        }
        // 纯修饰键单独按住、或带着 Ctrl/Cmd/Alt 的组合键都构不成说话键——
        // 提示后继续等待下一个按键
        if (isModifierCode(event.code) || event.ctrlKey || event.metaKey || event.altKey) {
            toast(t('settings.pttKeyInvalid'), 'warn');
            return;
        }
        settings.pttKey = event.code;
        saveAudioSettings();
        stopPttRecording();
        x.applyMicState(); // 连带刷新 micBtn 悬停文案里的键名
    }

    function bindPttKeyUi() {
        $('#pttKeyBtn').addEventListener('click', () => {
            if (pttRecording) {
                stopPttRecording();
                return;
            }
            pttRecording = true;
            reflectPttKey();
            window.addEventListener('keydown', onPttKeyRecord, true);
        });
    }

    function openSettings() {
        updateAvatarPreview();
        reflectMusicMode();
        stopPttRecording();
        reflectPttKey();
        $('#pttToggle').checked = settings.ptt;
        $('#notifyToggle').checked = x.isNotifyEnabled();
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

    /** 音乐模式接管三个处理开关 —— 置灰并回显强制关闭的采集态
     *  （存储的偏好仍在底下保留）。 */
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

    /** 从设置同步码率滑杆/读数（不放
     *  reflectMusicMode 里 —— 打开弹窗绝不能冲掉手动微调值）。 */
    function reflectBitrate() {
        const kbps = x.opusFmtp().maxaveragebitrate / 1000;
        $('#bitrateSlider').value = String(kbps);
        $('#bitrateVal').textContent = `${kbps} kbps`;
    }

    function closeSettings() {
        stopPttRecording();
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
        let devices;
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
        if (!sinkSupported) return;
        try {
            // '' 是默认输出 —— 清空选择会主动重置一个仍指向
            // 通话中途消失的设备的元件
            await audioEl.setSinkId(settings.spkDeviceId || '');
        } catch {
            /* 设备已消失 —— 保持默认输出 */
        }
    }

    /** 配置的扬声器仍在枚举中吗？未显式选择即视为在。 */
    async function speakerDevicePresent() {
        if (!settings.spkDeviceId) return true;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.some((d) => d.kind === 'audiooutput' && d.deviceId === settings.spkDeviceId);
        } catch {
            return true; // 枚举被拒：假定在，交给 setSinkId 判定
        }
    }

    /**
     * 热拔的输出设备（USB/蓝牙耳机）会留下一个死选择：此后对它
     * 的每次 setSinkId 都抛错，下拉框继续列着一个幽灵设备，
     * 播放可能停在一个没有任何输出去向的 sink 上。
     * 清空选择，把两条播放路径都引回默认输出 ——
     * 与麦克风回退一样，清空的选择仅本次会话有效
     * （设备很可能还会回来）。
     */
    async function recoverSpeakerDevice() {
        if (await speakerDevicePresent()) return;
        settings.spkDeviceId = '';
        saveAudioSettings();
        await x.applySpeaker();
        toast(t('channel.spkFallback'), 'warn');
    }

    async function playTestBeep() {
        const url = await getTestBeepUrl();
        if (!url) return toast(t('common.error'), 'warn');
        const beep = new Audio(url);
        beep.volume = settings.volume;
        await applySink(beep);
        beep.play().catch(() => toast(t('common.error'), 'warn'));
    }

    // ----- 麦克风测试：实时回环 —— 经扬声器短延迟听到自己的麦克
    // 风；再点一次停止。抽的是 RAW 采集，即使频道麦克风被静音也能
    // 工作，并自行应用输入音量 -----

    const MIC_TEST_DELAY = 0.5; // 秒 —— 长到有回声感，短到仍是实时

    let micTest = null; // { src, delay, gain, timer }

    async function onTestMicClick() {
        if (micTest) {
            stopMicTest();
            return;
        }
        if (!s.localStream) {
            await x.enableVoice();
            if (!s.localStream) return;
        }
        if (!s.hub?.ctx) return toast(t('settings.micTestUnsupported'), 'warn');
        try {
            await s.hub.ensureContext();
        } catch {
            /* 继续往下走 —— 下方的图就保持无声 */
        }
        const ctx = s.hub.ctx;
        const src = ctx.createMediaStreamSource(s.rawMicStream || s.localStream);
        const delay = ctx.createDelay(2);
        delay.delayTime.value = MIC_TEST_DELAY;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(delay).connect(gain).connect(ctx.destination); // ctx sink = 所选扬声器
        gain.gain.setTargetAtTime(Math.max(0.2, settings.volume) * settings.micVolume, ctx.currentTime, 0.03);
        micTest = {
            src,
            delay,
            gain,
            timer: setTimeout(stopMicTest, 30000), // 安全停止：限制啸叫风险
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
            /* 早已断开 */
        }
        micTest = null;
        resetTestMicBtn();
    }

    function resetTestMicBtn() {
        const btn = $('#testMicBtn');
        btn.classList.remove('recording');
        btn.textContent = t('settings.testMic');
    }

    function saveAudioSettings() {
        try {
            localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings));
        } catch {
            /* 存储满/被禁用 —— 设置只是不持久化 */
        }
    }

    function savePeerVolume(name, volume) {
        if (!name || name === '?') return;
        delete x.peerVolumes[name]; // 先删再插，维持最近使用顺序
        if (volume !== 1) x.peerVolumes[name] = volume;
        const keys = Object.keys(x.peerVolumes);
        if (keys.length > 50) for (const key of keys.slice(0, keys.length - 50)) delete x.peerVolumes[key];
        try {
            localStorage.setItem(PEER_VOLUMES_KEY, JSON.stringify(x.peerVolumes));
        } catch {
            /* 存储满 —— 音量本会话仍然生效 */
        }
    }

    // -------------------------------------------------------------------------
    // 外观（设置弹窗）：主题偏好 + UI 语言
    // -------------------------------------------------------------------------

    function bindAppearanceControls() {
        const themeSeg = $('#themeSegmented');
        const renderTheme = () => {
            const pref = getThemePref();
            for (const btn of themeSeg.querySelectorAll('.segment')) {
                btn.classList.toggle('active', btn.dataset.themePref === pref);
            }
        };
        themeSeg.addEventListener('click', (event) => {
            const pref = event.target.closest('.segment')?.dataset.themePref;
            if (pref && pref !== getThemePref()) {
                setThemePref(pref);
                renderTheme();
            }
        });
        renderTheme();

        const langSeg = $('#langSegmented');
        const renderLang = () => {
            for (const btn of langSeg.querySelectorAll('.segment')) {
                btn.classList.toggle('active', btn.dataset.lang === getLang());
            }
        };
        langSeg.addEventListener('click', (event) => {
            const lang = event.target.closest('.segment')?.dataset.lang;
            if (lang && lang !== getLang()) {
                // 切换语言会重载页面 —— 视为有意为之，
                // 离开页面确认框保持沉默
                s.intentionalUnload = true;
                setLang(lang);
            }
        });
        renderLang();
    }

    // -------------------------------------------------------------------------
    // 自定义头像（设置弹窗）
    // -------------------------------------------------------------------------

    function bindAvatarUi() {
        $('#avatarUploadBtn').addEventListener('click', () => $('#avatarFileInput').click());
        $('#avatarResetBtn').addEventListener('click', () => applySelfAvatar(''));
        $('#avatarFileInput').addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            event.target.value = ''; // 允许再次选择同一个文件
            if (!file) return;
            try {
                applySelfAvatar(await processAvatarFile(file));
            } catch {
                toast(t('chat.imageUnsupported'), 'warn');
            }
        });
    }

    function updateAvatarPreview() {
        $('#avatarPreview').replaceChildren(mem.memberAvatarNode({ peer_name: s.selfName, avatar: s.selfAvatar }));
    }

    function applySelfAvatar(dataUrl) {
        s.selfAvatar = safeAvatarUrl(dataUrl);
        if (s.selfAvatar) localStorage.setItem(AVATAR_KEY, s.selfAvatar);
        else localStorage.removeItem(AVATAR_KEY);
        if (s.selfAvatar) avatars.set(s.selfName, s.selfAvatar);
        else avatars.delete(s.selfName);
        s.chat.setAvatar(s.selfName, s.selfAvatar);
        const me = members.get(s.selfUuid);
        if (me) {
            me.avatar = s.selfAvatar || undefined;
            mem.renderMembers();
        }
        updateAvatarPreview();
        if (s.joined) s.socket.emit('peerAvatar', { room_id: channelId, avatar: s.selfAvatar || null });
    }

    /**
     * 把任意图片居中裁剪为小方形 JPEG data URL，必定满足头像
     * 广播预算（不断缩小尺寸/质量直到满足）。
     */
    async function processAvatarFile(file) {
        if (!file || !file.type.startsWith('image/') || file.type === 'image/gif') {
            throw new Error('not-image');
        }
        if (file.size > MAX_FILE_BYTES) throw new Error('too-large');
        const dataUrl = await fileToDataUrl(file);
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
        return out; // 56px q0.5 总能稳稳落在 96KB 广播上限之下
    }

    return {
        bindSettingsUi,
        bindAppearanceControls,
        refreshDeviceSelects,
        applySink,
        savePeerVolume,
        stopMicTest,
        get micTest() {
            return micTest;
        },
    };
}
