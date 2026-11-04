/*
Voice controls + audio plumbing for the channel page.

Owns the effective mic state (manual mute / push-to-talk), the input-gain
pipeline (raw capture <-> WebAudio-processed track, re-synced as the
AudioContext suspends/resumes) and remote playback: per-user volume
0..300% × master 0..100% over GainNodes when possible, with muted
`<audio>` elements as the fallback path (Chromium WebAudio bug — see
core/audio.js). Shared page state arrives via the `s` accessor object,
cross-module calls via the late-bound `x` surface (both owned by
channel.js); member-card helpers come through `mem` (members.js).
*/

export function createVoice({ s, x, mem, members, audioEls, settings, channelId, screenLock, playSound, t, $, el }) {
    const PTT_KEY_CODE = 'KeyV';
    let pttActive = false;
    let lastOnAir = false; // last peerStatus(audio) we broadcast
    let lastDeafenSent = null; // last peerStatus(deafen) we broadcast
    let micProcessed = false; // outgoing track comes from the gain pipeline
    // fallback <audio> elements whose play() was refused by autoplay policy —
    // retried on the first user gesture / context state flip (see retryPendingPlays)
    const pendingPlays = new Set();

    /** mic is actually transmitting right now */
    function onAir() {
        return !!s.localStream && s.micOn && (!settings.ptt || pttActive);
    }

    /**
     * Push the on-air state onto the right tracks. Normally the outgoing track
     * carries the mute gate; while a sound share runs the outgoing MIX must stay
     * live (it carries the music) and the mic alone is gated at its raw capture.
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
        // capture died (device unplugged, auto-recovery failed): re-acquire
        // instead of toggling a mute gate nobody would hear anyway
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
        // click feedback for manual toggles and host mutes; push-to-talk keys
        // drive applyMicState directly and must stay silent
        playSound(next ? 'micOn' : 'micOff');
    }

    /** Push the effective state to the local track / peers / UI. */
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
        mem.updateMicIconNode(s.selfUuid, live); // in-place: full re-renders kill a mid-drag volume slider
    }

    /** Align the broadcast dedup baseline with the join payload's peer_audio — no emit. */
    function seedLastOnAir() {
        lastOnAir = onAir();
    }

    // ----- self-deafen: mute every remote member at once (own mic unaffected) -----

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
        reapplyAllVolumes(); // 0×anything silences both playback paths
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

    // ----- "listen together": shared sound state -> room + UI -----

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
            // Ctrl/Cmd+M: toggle the mic from anywhere (typing in the composer
            // must keep inserting an 'm', so it stays exempt)
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
            if (event.code !== PTT_KEY_CODE || event.repeat) return;
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
            if (event.code !== PTT_KEY_CODE || !pttActive) return;
            pttActive = false;
            applyMicState();
        });
    }

    // ----- touch push-to-talk: a hold-to-talk button for devices with no keyboard -----
    // Visible only while PTT mode is on and the primary pointer is coarse.

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

    /** PTT mode flipped off mid-press: release the key state. */
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
            // music mode overrides the processing toggles — browsers mangle music
            echoCancellation: settings.musicMode ? false : settings.echoCancellation,
            noiseSuppression: settings.musicMode ? false : settings.noiseSuppression,
            autoGainControl: settings.musicMode ? false : settings.autoGainControl,
        };
        if (settings.musicMode) {
            // stereo capture when the device offers it (ideal: mono mics keep
            // working) — the link's stereo=1/sprop-stereo=1 fmtp is pointless
            // if capture itself got downmixed to one channel
            audio.channelCount = { ideal: 2 };
        }
        if (settings.micDeviceId) audio.deviceId = { exact: settings.micDeviceId };
        return { audio };
    }

    /**
     * Encoder hint for the outgoing track: 'speech' lets Chrome lean harder on
     * DTX/FEC trade-offs, 'music' (music mode or a running share) keeps the
     * fidelity-first behavior. Zero-cost, ignored by browsers without support.
     */
    function refreshOutgoingHint() {
        const hint = settings.musicMode || x.shareSound?.active() ? 'music' : 'speech';
        for (const track of [...(s.rawMicStream?.getAudioTracks() || []), ...(s.localStream?.getAudioTracks() || [])]) {
            if ('contentHint' in track) track.contentHint = hint;
        }
    }

    /**
     * Point the outgoing track at the gain-processed mic stream while the shared
     * AudioContext runs; a suspended context would emit silence, so the raw track
     * goes out instead until the context resumes (statechange re-runs this).
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
            applyTrackGate(live); // before the swap: gate the mixed stream (or the raw mic while sharing)
            refreshOutgoingHint(); // the outgoing track object changed with the pipeline
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
     * Settings-only change (NS/EC/AGC/music mode): reconfigure the LIVE track
     * in place instead of opening the mic a second time — a second getUserMedia
     * can fail outright on single-capture devices (Bluetooth HFP headsets) and
     * disturbs the audio route everywhere else. The track object survives, so
     * neither the WebAudio pipeline nor the senders' replaceTrack path is
     * touched. Returns true when the new constraints are verifiably in effect;
     * any refusal, timeout or mismatch falls back to the full re-acquisition.
     */
    async function tryApplyMicConstraints() {
        const rawTrack = s.rawMicStream?.getAudioTracks()[0];
        if (!rawTrack || rawTrack.readyState !== 'live' || typeof rawTrack.applyConstraints !== 'function') {
            return false;
        }
        // a device switch must go through the full path (a reconfigured track
        // could keep a stale route); an unreported deviceId is not proof either
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
        // a resolve is not proof the browser reconfigured: verify the toggles it
        // reports back (ideal-valued fields like channelCount are not verifiable)
        const applied = rawTrack.getSettings?.() || {};
        for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
            if (typeof applied[key] === 'boolean' && applied[key] !== audio[key]) return false;
        }
        watchMicHealth(s.rawMicStream); // re-sync micChannels (stereo fmtp may need a renegotiation)
        refreshOutgoingHint(); // music mode flips the encoder content hint
        return true;
    }

    /**
     * Re-acquire the mic with the current settings (device switch or processing
     * toggle) and hot-swap the outgoing track — no renegotiation involved.
     */
    async function reacquireMic() {
        // processing-only changes ride applyConstraints on the live track; the
        // full path below stays the answer for device switches and dead captures
        if (s.localStream && (await tryApplyMicConstraints())) return;
        const hadStream = !!s.localStream;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
        } catch (err) {
            // the configured device vanished between enumeration and open — a
            // stale exact deviceId fails with OverconstrainedError forever, so
            // drop it and fall back to the default device ONCE (recoverMicDevice
            // only covers the track-onended path; this covers the settings UI)
            const staleDevice = settings.micDeviceId && ['OverconstrainedError', 'NotFoundError'].includes(err?.name);
            if (!staleDevice) throw err;
            settings.micDeviceId = '';
            x.refreshDeviceSelects();
            stream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints());
            x.toast(t('channel.micFallback'), 'warn');
        }
        const track = stream.getAudioTracks()[0];
        // a device/processing change keeps the current mute state; enabling voice turns the mic on
        s.micOn = hadStream ? s.micOn : true;
        s.textOnly = false;
        screenLock.sync(); // voice enabled from text-only: hold the screen awake now
        track.enabled = onAir();
        if (s.hub) await s.hub.ensureContext().catch(() => {});

        // rebuild the input-gain pipeline around the new capture; the previous mic
        // (raw capture + processed track) is stopped after the hot-swap
        const oldRaw = s.rawMicStream;
        const oldOut = s.localStream;
        s.hub?.detachMic();
        micProcessed = false;
        s.rawMicStream = stream;
        s.localStream = stream;
        watchMicHealth(stream); // the new capture carries its own death watch
        refreshOutgoingHint(); // mode/device toggles re-capture — the hint may have flipped
        syncMicPipeline(); // upgrades to the processed track when possible
        if (!micProcessed) s.mesh?.replaceAudioTrack(track, stream);
        if (s.hub?.ctx) s.hub.watch('self', s.localStream, x.localLevelCb);
        mem.ensureSelfMember();
        applyMicState();
        oldOut?.getTracks().forEach((old) => old.stop());
        oldRaw?.getTracks().forEach((old) => old.stop());
        x.refreshDeviceSelects(); // labels become available after permission is granted
    }

    async function enableVoice() {
        try {
            await reacquireMic();
        } catch {
            x.toast(t('channel.errors.micDenied'), 'warn');
        }
    }

    /** Settings-modal callers: re-acquire the mic, toasting the shared denial. */
    function reacquireMicOrToast() {
        return reacquireMic().catch(() => x.toast(t('channel.errors.micDenied'), 'warn'));
    }

    // ----- mic device health: a hot-unplugged USB/Bluetooth headset (or the OS
    // revoking the mic) ends the capture track mid-call — without recovery the
    // room just goes silent on our side while we keep talking -----

    let micRecovering = false;

    /** The raw capture is fully dead (all tracks ended). */
    function micTrackDead() {
        const tracks = s.rawMicStream?.getAudioTracks() || [];
        return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
    }

    /** Watch the raw capture for device death; re-armed per reacquireMic. */
    function watchMicHealth(stream) {
        if (!stream) return;
        // stereo fmtp must match what the capture ACTUALLY delivers (music mode
        // asks for ideal:2, mono mics still produce mono): a mismatch makes the
        // encoder ship dual-mono at half the per-channel rate. A mid-call flip
        // (device switch) needs one plain renegotiation to push the new dict.
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
     * Re-acquire the mic after its device vanished. Falls back to the default
     * device when the configured one is gone (a stale exact deviceId would fail
     * getUserMedia with OverconstrainedError forever) — the cleared choice
     * stays session-only, the device may well come back.
     */
    async function recoverMicDevice() {
        if (micRecovering || !s.rawMicStream) return;
        if (!micTrackDead()) return; // speakers changed / devices added — capture untouched
        micRecovering = true;
        try {
            if (settings.micDeviceId && !(await micDevicePresent())) {
                settings.micDeviceId = '';
                x.refreshDeviceSelects();
            }
            await reacquireMic(); // keeps the mute state, hot-swaps the outgoing track
            x.toast(t('channel.micRecovered'), 'ok');
        } catch {
            x.toast(t('channel.errors.micLost'), 'warn');
        } finally {
            micRecovering = false;
        }
    }

    /** Configured mic still enumerated? No explicit device counts as present. */
    async function micDevicePresent() {
        if (!settings.micDeviceId) return true;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.some((d) => d.kind === 'audioinput' && d.deviceId === settings.micDeviceId);
        } catch {
            return true; // enumeration refused: assume present, let getUserMedia decide
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
            mem.setIconBtn(micBtn, live ? mem.MIC_ON_SVG : mem.MIC_OFF_SVG, t('channel.pttOn'));
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
    // remote audio playback — per-user volume 0..300% x master 0..100%
    // -------------------------------------------------------------------------

    /** Chromium: play through GainNodes (boost past 100% + AudioContext sink). */
    function webAudioPlayback() {
        return !!s.hub?.ctx && s.hub.ctx.state === 'running' && typeof s.hub.ctx.setSinkId === 'function';
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
            for (const [peerId, player] of [...(s.hub?.players?.entries() || [])]) {
                const stream = player.src.mediaStream;
                if (stream) attachRemoteAudio(peerId, stream);
            }
            retryPendingPlays(); // the state flip may have unblocked element playback
        }
        syncMicPipeline(); // raw track <-> gain-processed track
    }

    /** total gain for a remote peer: per-user volume × master volume × (0 when deafened) */
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
     * Re-run play() on fallback elements autoplay policy had refused (no user
     * gesture yet — auto-join on load, or Firefox where the element path is
     * permanent). Called from the first pointerdown/keydown and context state
     * flips; without it a refused element stays silent until the next
     * attachRemoteAudio, which may never come on a quiet link.
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
        // fallback path: <audio> elements honor element.setSinkId but cap at 100%
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
            .catch(() => pendingPlays.add(peerId)); // refused: retry on gesture/state flip
    }

    function reapplyPeerVolume(peerId) {
        const total = peerTotalGain(peerId);
        if (s.hub) s.hub.setPeerVolume(peerId, total);
        const audio = audioEls.get(peerId);
        if (audio) audio.volume = Math.min(1, total);
    }

    function reapplyAllVolumes() {
        // members are keyed by session uuid — every entry is a remote peer
        for (const peerId of members.keys()) reapplyPeerVolume(peerId);
    }

    /** Route remote playback to the selected output device. */
    async function applySpeaker() {
        if (webAudioPlayback()) {
            await s.hub.setSink(settings.spkDeviceId);
            return;
        }
        for (const audio of audioEls.values()) await x.applySink(audio);
    }

    /** Teardown: the gain pipeline is gone with the AudioContext. */
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
