/**
 * 音量电平监测——共享一个 AudioContext，每个流一个 analyser。
 * analyser 抽头本身不会把音频路由到扬声器；播放要么走每 peer 一个的
 * GainNode（支持 100% 以上增益，汇入共享峰值限制器），
 * 要么走频道页面持有的专用 <audio> 元件。
 */

export class AudioHub {
    /**
     * @param {object} [options]
     * @param {number} [options.threshold] 成员被判为正在说话的 RMS 电平下限
     */
    constructor({ threshold = 0.06 } = {}) {
        this.threshold = threshold;
        this.ctx = null;
        this.watchers = new Map(); // key -> { src, analyser, data, speaking, cb }
        /** key -> { src, gain } 可发声的播放链（仅远端 peer） */
        this.players = new Map();
        /** 所有 peer 增益汇入的共享 DynamicsCompressor（见 _outChain） */
        this.master = null;
        /** key -> 维持远端轨道交付存活的静音 <audio>（见 _prime） */
        this.primers = new Map();
        /** 本地麦克风管线：{ raw, src, gain, dest, stream } 或 null */
        this.mic = null;
        /** 「一起听」共享：{ raw, src, gain }，混入麦克风限制器，或 null */
        this.share = null;
        this.timer = null;
    }

    async ensureContext() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            // 'interactive' 要求最小的输出缓冲——那些本会默认 100ms+
            // 播放缓冲的平台可借此免费削减远端语音延迟。WebRTC 轨道
            // 运行在 48kHz：把上下文固定到相同采样率，可绕开 Chromium
            // 的重采样器（以及采样率不匹配时 MediaStreamSource 的
            // 一族 bug）。
            // 拒绝显式采样率的浏览器则回退到默认采样率。
            try {
                this.ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
            } catch {
                this.ctx = new AC({ latencyHint: 'interactive' });
            }
        }
        if (this.ctx.state === 'suspended') {
            // 绝不因自动播放策略阻塞调用方：没有用户手势时，Chrome 的
            // resume() 会无限期挂起，这曾把整个自动加入流程（无 socket、
            // 无 peer）一直卡到首次点击为止。上下文启动之前，
            // 播放本就回退到 <audio> 元件，
            // 所以一次限时尝试就足够。
            const resumed = this.ctx.resume().catch(() => {});
            await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 250))]);
        }
    }

    /**
     * 开始监测一个流。
     * @param {string}  key   成员 id（本地麦克风为 'self'）
     * @param {MediaStream} stream
     * @param {function} cb   每个 tick 以 { level, speaking } 调用
     */
    watch(key, stream, cb) {
        if (!this.ctx || !stream) return;
        this.unwatch(key);
        const src = this.ctx.createMediaStreamSource(stream);
        const analyser = this.ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.55;
        src.connect(analyser); // analyser 是末端节点——无可闻输出
        this.watchers.set(key, {
            src,
            analyser,
            data: new Float32Array(analyser.fftSize), // 供 _tick 使用的时域样本
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
            /* 本就未连接 */
        }
        this.watchers.delete(key);
        if (!this.watchers.size) this._stop();
    }

    // ----- 每 peer 可闻播放（增益 0..3 = 0%..300%） -----

    /**
     * 经 gain 节点开始播放远端流。图构建失败时返回 false
     * （调用方回退到 <audio> 元件）。
     * @param {string}  key    peer id
     * @param {MediaStream} stream
     * @param {number}  volume 初始总增益（peer 音量 × master）
     */
    playPeer(key, stream, volume) {
        if (!this.ctx || !stream || !stream.getAudioTracks().length) return false;
        this.stopPeer(key);
        try {
            const src = this.ctx.createMediaStreamSource(stream);
            const gain = this.ctx.createGain();
            gain.gain.value = 0;
            src.connect(gain).connect(this._outChain());
            gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.03); // 淡入，避免爆音
            this.players.set(key, { src, gain });
            this._prime(key, stream);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 远端播放的共享输出节点：一个略低于满量程的峰值限制器。peer 增益
     * 最高可到 300% × master 音量，超过 1.0 的部分会在 destination 处
     * 硬削波——发送侧从一开始就有限制器，这是接收侧的对应物。
     * 它只削超出的过冲部分，
     * 且一个节点由所有 peer 链共享。
     * @returns {AudioNode}
     */
    _outChain() {
        if (!this.master) {
            const limiter = this.ctx.createDynamicsCompressor();
            limiter.threshold.value = -3;
            limiter.knee.value = 1;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.003;
            limiter.release.value = 0.1;
            limiter.connect(this.ctx.destination);
            this.master = { limiter };
        }
        return this.master.limiter;
    }

    /**
     * Chromium 只有在媒体元件消费远端 WebRTC 轨道之后才会交付音频——
     * 缺了这一步，即使 RTP 已经流入，MediaStreamSourceNode 也保持静音。
     * 一个静音的隐藏元件足以启动（并维持）这条交付通路；
     * 它自身不渲染任何声音。
     */
    _prime(key, stream) {
        let el = this.primers.get(key);
        if (!el) {
            el = document.createElement('audio');
            el.muted = true;
            el.setAttribute('playsinline', '');
            el.style.display = 'none';
            document.body.append(el);
            this.primers.set(key, el);
        }
        el.srcObject = stream;
        el.play().catch(() => {});
    }

    _unprime(key) {
        const el = this.primers.get(key);
        if (!el) return;
        el.srcObject = null;
        el.remove();
        this.primers.delete(key);
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
            /* 本就未连接 */
        }
        this.players.delete(key);
        this._unprime(key);
    }

    // ----- 本地麦克风输入增益（0..2 = 采集电平的 0%..200%），
    // 后接峰值限制器，防止提升后的输入数字削波 -----

    /**
     * 把原始采集经 gain 节点路由，返回处理后流，
     * 其轨道替换外发轨道。图构建失败时返回 null
     * （调用方继续发送原始流）。
     * @param {MediaStream} rawStream 直接来自 getUserMedia
     * @param {number} gainValue 初始增益（settings.micVolume）
     */
    attachMic(rawStream, gainValue = 1) {
        if (!this.ctx || !rawStream || !rawStream.getAudioTracks().length) return null;
        this.detachMic();
        try {
            const src = this.ctx.createMediaStreamSource(rawStream);
            const gain = this.ctx.createGain();
            gain.gain.value = gainValue;
            // 增益级之后放置软限制器：micVolume 最高到 200% 时会把峰值
            // 推过满量程——造成硬性数字削波。阈值略低于 0dBFS、
            // knee 接近零，可让阈值以下的信号原样通过，
            // 只削除超出的过冲部分。
            const limiter = this.ctx.createDynamicsCompressor();
            limiter.threshold.value = -3;
            limiter.knee.value = 1;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.001;
            limiter.release.value = 0.1;
            const dest = this.ctx.createMediaStreamDestination();
            src.connect(gain).connect(limiter).connect(dest);
            this.mic = { raw: rawStream, src, gain, limiter, dest, stream: dest.stream };
            // 在旧麦克风管线下（或管线尚不存在时）捕获的 share，
            // 随重建后的输出一起走——在这里重新挂接，接入与麦克风
            // 相同的限制器（原因见 attachShare）。其 gain 节点要先断开：
            // 否则每次重建都会在图上留一条指向已废弃限制器的
            // 孤儿连线
            if (this.share) {
                try {
                    this.share.gain.disconnect();
                } catch {
                    /* 尚无旧连线 */
                }
                this.share.src.connect(this.share.gain).connect(limiter);
            }
            return dest.stream;
        } catch {
            this.mic = null;
            return null;
        }
    }

    setMicGain(value) {
        if (!this.mic || !this.ctx) return;
        this.mic.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
    }

    detachMic() {
        if (!this.mic) return;
        try {
            this.mic.src.disconnect();
            this.mic.gain.disconnect();
            this.mic.limiter.disconnect();
        } catch {
            /* 本就未连接 */
        }
        this.mic.stream.getTracks().forEach((track) => track.stop());
        this.mic = null;
    }

    // ----- 共享声音（「一起听」：显示捕获音频混入外发麦克风
    // destination——同一音频 m-line，无需重新协商） -----

    /**
     * 把捕获的共享流混入麦克风管线的输出端——经与麦克风相同的
     * 限制器，而不是直接进 destination。两个接近满量程的声源
     * 相加会超过 ±1.0，编码器还没见到混合信号，destination 就已
     * 硬削波（在嘈杂音乐上说话 = 失真）；共享限制器改为削掉
     * 相加后的峰值，顺带充当温和的 ducking。
     * 流生命周期归调用方管（结束时停止其轨道）；
     * 在麦克风管线存在之前启动的 share
     * 由下一次 attachMic 挂接。
     * @param {MediaStream} rawStream 来自 getDisplayMedia 的音频轨道
     * @returns {boolean} 图是否构建成功
     */
    attachShare(rawStream) {
        if (!this.ctx || !rawStream || !rawStream.getAudioTracks().length) return false;
        this.detachShare();
        try {
            const src = this.ctx.createMediaStreamSource(rawStream);
            const gain = this.ctx.createGain(); // unity——留作日后电平控制的把手
            src.connect(gain);
            this.share = { raw: rawStream, src, gain };
            if (this.mic) gain.connect(this.mic.limiter);
            return true;
        } catch {
            this.share = null;
            return false;
        }
    }

    detachShare() {
        if (!this.share) return;
        try {
            this.share.src.disconnect();
            this.share.gain.disconnect();
        } catch {
            /* 本就未连接 */
        }
        this.share = null;
    }

    /**
     * 把 Web Audio 播放路由到指定输出设备（仅 Chromium）。
     * @returns {Promise<boolean>} 输出设备是否设置成功
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
            // 浮点时域 RMS（一个普通电平表）：之前用的字节量化
            // 频域 bin 在语音阈值附近分辨率粗糙，
            // 安静说话者的圆环会闪烁不定
            watcher.analyser.getFloatTimeDomainData(watcher.data);
            let sum = 0;
            for (let i = 0; i < watcher.data.length; i++) sum += watcher.data[i] * watcher.data[i];
            const level = Math.sqrt(sum / watcher.data.length);
            watcher.lastLevel = level;

            // 加迟滞，避免圆环在阈值附近闪烁
            if (!watcher.speaking && level > this.threshold) watcher.speaking = true;
            else if (watcher.speaking && level < this.threshold * 0.55) watcher.speaking = false;

            if (watcher.cb) watcher.cb({ level, speaking: watcher.speaking });
        }
    }

    destroy() {
        this._stop();
        for (const key of [...this.watchers.keys()]) this.unwatch(key);
        for (const key of [...this.players.keys()]) this.stopPeer(key);
        if (this.master) {
            try {
                this.master.limiter.disconnect();
            } catch {
                /* 本就未连接 */
            }
            this.master = null;
        }
        this.detachShare();
        this.detachMic();
        if (this.ctx) this.ctx.close().catch(() => {});
        this.ctx = null;
    }
}

// ---------------------------------------------------------------------------
// 扬声器测试音——一段 660 Hz 的短 beep，离线渲染为 WAV blob URL，
// 从而经 <audio> 元件播放（因此会遵循 setSinkId/音量设置），
// 不依赖任何网络资源。
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
    view.setUint16(22, 1, true); // 单声道
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
