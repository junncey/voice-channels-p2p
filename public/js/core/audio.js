/**
 * Audio level monitoring — one shared AudioContext, one analyser per stream.
 * Analyser taps do NOT route audio to the speakers by themselves; playback is
 * either a per-peer GainNode (supports boosting past 100%) or a dedicated
 * <audio> element owned by the channel page.
 */

export class AudioHub {
    /**
     * @param {object} [options]
     * @param {number} [options.threshold] RMS level above which a member counts as speaking
     */
    constructor({ threshold = 0.06 } = {}) {
        this.threshold = threshold;
        this.ctx = null;
        this.watchers = new Map(); // key -> { src, analyser, data, speaking, cb }
        /** key -> { src, gain } audible playback chains (remote peers only) */
        this.players = new Map();
        this.timer = null;
    }

    async ensureContext() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AC();
        }
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume().catch(() => {});
        }
    }

    /**
     * Start monitoring a stream.
     * @param {string}  key   member id ('self' for the local mic)
     * @param {MediaStream} stream
     * @param {function} cb   invoked every tick with { level, speaking }
     */
    watch(key, stream, cb) {
        if (!this.ctx || !stream) return;
        this.unwatch(key);
        const src = this.ctx.createMediaStreamSource(stream);
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.55;
        src.connect(analyser); // analyser is a sink — no audible output
        this.watchers.set(key, {
            src,
            analyser,
            data: new Uint8Array(analyser.frequencyBinCount),
            speaking: false,
            cb,
        });
        this._start();
    }

    unwatch(key) {
        const watcher = this.watchers.get(key);
        if (!watcher) return;
        try {
            watcher.src.disconnect();
        } catch {
            /* already disconnected */
        }
        this.watchers.delete(key);
        if (!this.watchers.size) this._stop();
    }

    // ----- audible per-peer playback (gain 0..3 = 0%..300%) -----

    /**
     * Start playing a remote stream through a gain node. Returns false when
     * the graph can't be built (caller falls back to an <audio> element).
     * @param {string}  key    peer id
     * @param {MediaStream} stream
     * @param {number}  volume initial total gain (peer volume × master)
     */
    playPeer(key, stream, volume) {
        if (!this.ctx || !stream || !stream.getAudioTracks().length) return false;
        this.stopPeer(key);
        try {
            const src = this.ctx.createMediaStreamSource(stream);
            const gain = this.ctx.createGain();
            gain.gain.value = 0;
            src.connect(gain).connect(this.ctx.destination);
            gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.03); // fade in, no pop
            this.players.set(key, { src, gain });
            return true;
        } catch {
            return false;
        }
    }

    setPeerVolume(key, volume) {
        const player = this.players.get(key);
        if (!player || !this.ctx) return;
        player.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
    }

    stopPeer(key) {
        const player = this.players.get(key);
        if (!player) return;
        try {
            player.src.disconnect();
            player.gain.disconnect();
        } catch {
            /* already disconnected */
        }
        this.players.delete(key);
    }

    /**
     * Route Web Audio playback to a specific output device (Chromium only).
     * @returns {Promise<boolean>} whether the sink could be applied
     */
    async setSink(deviceId = '') {
        if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return false;
        try {
            await this.ctx.setSinkId(deviceId || '');
            return true;
        } catch {
            return false;
        }
    }

    _start() {
        if (!this.timer) this.timer = setInterval(() => this._tick(), 100);
    }

    _stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    _tick() {
        for (const watcher of this.watchers.values()) {
            watcher.analyser.getByteFrequencyData(watcher.data);
            let sum = 0;
            for (let i = 0; i < watcher.data.length; i++) sum += watcher.data[i] * watcher.data[i];
            const level = Math.sqrt(sum / watcher.data.length) / 255;

            // hysteresis so the ring doesn't flicker at the threshold
            if (!watcher.speaking && level > this.threshold) watcher.speaking = true;
            else if (watcher.speaking && level < this.threshold * 0.55) watcher.speaking = false;

            if (watcher.cb) watcher.cb({ level, speaking: watcher.speaking });
        }
    }

    destroy() {
        this._stop();
        for (const key of [...this.watchers.keys()]) this.unwatch(key);
        for (const key of [...this.players.keys()]) this.stopPeer(key);
        if (this.ctx) this.ctx.close().catch(() => {});
        this.ctx = null;
    }
}

// ---------------------------------------------------------------------------
// Speaker test tone — a short 660 Hz beep rendered offline into a WAV blob
// URL, so it plays through an <audio> element (and therefore honors
// setSinkId/volume) with zero network assets.
// ---------------------------------------------------------------------------

let beepUrlPromise = null;

export function getTestBeepUrl() {
    if (!beepUrlPromise) beepUrlPromise = renderBeep();
    return beepUrlPromise;
}

async function renderBeep() {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return null;
    const sampleRate = 24000;
    const duration = 0.4;
    const ctx = new OAC(1, Math.ceil(sampleRate * duration), sampleRate);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 660;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(0.85, 0.03);
    gain.gain.setValueAtTime(0.85, duration - 0.1);
    gain.gain.linearRampToValueAtTime(0.0001, duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(0);
    osc.stop(duration);
    try {
        const buffer = await ctx.startRendering();
        return bufferToWavUrl(buffer);
    } catch {
        return null;
    }
}

function bufferToWavUrl(buffer) {
    const chan = buffer.getChannelData(0);
    const view = new DataView(new ArrayBuffer(44 + chan.length * 2));
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + chan.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, chan.length * 2, true);
    let offset = 44;
    for (let i = 0; i < chan.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, chan[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }));
}
