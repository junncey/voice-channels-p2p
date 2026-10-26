/*
Settings modal (audio devices, processing toggles, PTT, volumes, bitrate,
sound effects, notifications) plus the appearance panel (theme, language)
and the custom-avatar picker — everything that lives behind the ⚙ button.
Shared page state arrives via the `s` accessor object, cross-module calls
via the late-bound `x` surface (both owned by channel.js); member-card
helpers come through `mem` (members.js).
*/

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
                // switching device in text-only mode doubles as "enable voice"
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
            // re-seed the bitrate slider with the mode's default (hand-tuning
            // survives across sessions, but a mode switch is an explicit preset)
            settings.opusBitrate = settings.musicMode ? 192 : 64;
            saveAudioSettings();
            reflectMusicMode();
            reflectBitrate();
            // re-capture under the overridden processing constraints (hot-swaps the
            // outgoing track) and push the new bitrate onto live senders at once;
            // the fmtp side (stereo) lands with the next SDP round
            if (s.localStream) x.reacquireMicOrToast();
            s.mesh?.setSendBitrate();
        });

        $('#pttToggle').addEventListener('change', (event) => {
            settings.ptt = event.target.checked;
            x.resetPtt();
            saveAudioSettings();
            x.applyMicState();
        });

        $('#micVolumeSlider').addEventListener('input', (event) => {
            settings.micVolume = Number(event.target.value) / 100;
            $('#micVolumeVal').textContent = `${event.target.value}%`;
            s.hub?.setMicGain(settings.micVolume); // takes effect immediately, no renegotiation
            saveAudioSettings();
        });

        $('#bitrateSlider').addEventListener('input', (event) => {
            settings.opusBitrate = Number(event.target.value);
            $('#bitrateVal').textContent = `${event.target.value} kbps`;
            saveAudioSettings();
            // pushes onto live senders via setParameters, no renegotiation; the
            // fmtp cap rides along on the next SDP round
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

        // operation sound effects: master switch, volume, per-event sound pickers
        initSoundSettings({ applySink, toast });

        // desktop notifications on mention (hidden where unsupported)
        $('#notifySection').classList.toggle('hidden', !x.notifySupported);
        $('#notifyToggle').addEventListener('change', x.onNotifyToggle);

        navigator.mediaDevices?.addEventListener?.('devicechange', refreshDeviceSelects);
    }

    function openSettings() {
        updateAvatarPreview();
        reflectMusicMode();
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
        const kbps = x.opusFmtp().maxaveragebitrate / 1000;
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
        if (!s.localStream) {
            await x.enableVoice();
            if (!s.localStream) return;
        }
        if (!s.hub?.ctx) return toast(t('settings.micTestUnsupported'), 'warn');
        try {
            await s.hub.ensureContext();
        } catch {
            /* fall through — the graph below will simply stay silent */
        }
        const ctx = s.hub.ctx;
        const src = ctx.createMediaStreamSource(s.rawMicStream || s.localStream);
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

    function saveAudioSettings() {
        try {
            localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(settings));
        } catch {
            /* storage full / disabled — settings just won't persist */
        }
    }

    function savePeerVolume(name, volume) {
        if (!name || name === '?') return;
        delete x.peerVolumes[name]; // re-insert so recency order holds
        if (volume !== 1) x.peerVolumes[name] = volume;
        const keys = Object.keys(x.peerVolumes);
        if (keys.length > 50) for (const key of keys.slice(0, keys.length - 50)) delete x.peerVolumes[key];
        try {
            localStorage.setItem(PEER_VOLUMES_KEY, JSON.stringify(x.peerVolumes));
        } catch {
            /* storage full — volumes still apply for this session */
        }
    }

    // -------------------------------------------------------------------------
    // appearance (settings modal): theme preference + UI language
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
                // switching language reloads the page — take that as intended so
                // the leave-site prompt stays quiet
                s.intentionalUnload = true;
                setLang(lang);
            }
        });
        renderLang();
    }

    // -------------------------------------------------------------------------
    // custom avatar (settings modal)
    // -------------------------------------------------------------------------

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
