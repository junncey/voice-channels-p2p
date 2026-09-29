/**
 * Audio level monitoring — one shared AudioContext, one analyser per stream.
 * Analyser taps do NOT route audio to the speakers; playback happens through
 * dedicated <audio> elements owned by the channel page.
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
        if (this.ctx) this.ctx.close().catch(() => {});
        this.ctx = null;
    }
}
