/**
 * e2e 检查钩子（仅当 URL 带 #debug 时——正常使用绝不出现）。
 * 自频道控制器拆出：每个探针都经 getCtx() 拉取全新上下文
 * 快照，控制器的可变模块状态（hub、mesh、members 等）
 * 始终是实时读取。
 */

export function installDebugHooks(getCtx) {
    window.__vcDebug = () => {
        const {
            hub,
            micProcessed,
            micTest,
            settings,
            members,
            audioEls,
            connPaths,
            lossStreaks,
            peerRecovery,
            b1Attempts,
            b1InFlight,
            webAudioPlayback,
            shareSound,
        } = getCtx();
        return {
            mode: webAudioPlayback() ? 'webaudio' : 'element',
            ctxState: hub?.ctx?.state ?? null,
            ctxTime: hub?.ctx?.currentTime ?? null,
            micRaw:
                hub?.mic?.raw
                    .getAudioTracks()
                    .map((t) => `${t.readyState}:${t.enabled ? 'on' : 'off'}`)
                    .join(',') ?? null,
            micProcessed,
            micOut:
                hub?.mic?.stream
                    .getAudioTracks()
                    .map((t) => `${t.readyState}:${t.enabled ? 'on' : 'off'}`)
                    .join(',') ?? null,
            share: {
                active: shareSound ? shareSound.active() : false,
                raw:
                    hub?.share?.raw
                        .getAudioTracks()
                        .map((t) => `${t.readyState}:${t.enabled ? 'on' : 'off'}`)
                        .join(',') ?? null,
            },
            micTest: micTest ? { delay: micTest.delay.delayTime.value, gain: micTest.gain.gain.value } : null,
            micVolume: settings.micVolume,
            micGain: hub?.mic?.gain.gain.value ?? null,
            // 实时采样（不是被节流的 _tick 值）—— 后台标签页也能读。
            // 与 AudioHub._tick 相同的浮点时域 RMS（watcher 缓冲是
            // Float32Array；旧字节 API 在这里每次调用都会抛错）
            levels: hub
                ? Object.fromEntries(
                      [...hub.watchers.entries()].map(([k, w]) => {
                          w.analyser.getFloatTimeDomainData(w.data);
                          let sum = 0;
                          for (let i = 0; i < w.data.length; i++) sum += w.data[i] * w.data[i];
                          return [k, Math.sqrt(sum / w.data.length)];
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
        };
    };
    // e2e 辅助：把对外的麦克风轨换成合成正弦波 —— 不依赖真实
    // 麦克风/扬声器硬件即可验证 WebRTC 链路
    window.__vcTone = async (ms = 3000) => {
        const { hub, mesh, localStream, micProcessed } = getCtx();
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
            g.connect(hub.mic.gain); // 搭输入增益管线的车
        } else {
            const dest = hub.ctx.createMediaStreamDestination();
            g.connect(dest);
            mesh.replaceAudioTrack(dest.stream.getAudioTracks()[0], dest.stream);
            restore = () => mesh.replaceAudioTrack(localStream.getAudioTracks()[0], localStream);
        }
        const data = new Uint8Array(an.frequencyBinCount);
        window.__vcToneLevel = 0;
        osc.start();
        osc.stop(hub.ctx.currentTime + ms / 1000); // 音频时钟排程：后台标签页的定时器节流卡不住它
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
        const { mesh } = getCtx();
        if (!mesh) return null;
        const out = [];
        for (const [peerId, entry] of mesh.entries) {
            const stats = await entry.pc.getStats();
            const rows = [];
            stats.forEach((r) => {
                if (r.type === 'inbound-rtp' && r.kind === 'audio')
                    rows.push({
                        dir: 'in',
                        bytes: r.bytesReceived,
                        packets: r.packetsReceived,
                        lost: r.packetsLost,
                        jitterMs: typeof r.jitter === 'number' ? Math.round(r.jitter * 1000) : null,
                        // 听者实际听到的：NetEQ 掩蔽占比
                        // （PLC 在丢包处缝合）与其维持的播放缓冲
                        concealed: r.concealedSamples,
                        concealedPct:
                            r.concealedSamples && r.totalSamplesReceived
                                ? Math.round((r.concealedSamples / r.totalSamplesReceived) * 1000) / 10
                                : null,
                        jbDelayMs:
                            r.jitterBufferDelay && r.jitterBufferEmittedCount
                                ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) / 1000
                                : null,
                    });
                if (r.type === 'outbound-rtp' && r.kind === 'audio')
                    rows.push({
                        dir: 'out',
                        bytes: r.bytesSent,
                        packets: r.packetsSent,
                        targetBitrate: r.targetBitrate, // 回读：setParameters 是否生效？
                    });
            });
            const path = await mesh.connPath(peerId).catch(() => null);
            out.push({
                peerId,
                state: entry.pc.connectionState,
                path,
                // 本链路协商出的包级冗余（null = 尚无远端
                // 描述）—— RED 偏好的回读
                red: typeof mesh.redNegotiated === 'function' ? mesh.redNegotiated(peerId) : undefined,
                rows,
            });
        }
        return out;
    };
    // 探针：对（已在流动的）远端流新挂一个 Web Audio 抽头是否有声，
    // 以及 muted <audio> 元件能否预热管线？
    window.__vcRetap = async (ms = 1200) => {
        const { hub } = getCtx();
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
    // 探针：强制 AudioContext 挂起/运行，测试回退迁移
    window.__vcCtx = (op) => {
        const { hub } = getCtx();
        return op === 'suspend' ? hub?.ctx?.suspend() : hub?.ctx?.resume();
    };
    // 探针：直接访问 mesh（PC 状态、restartIce）用于恢复测试
    window.__vcMesh = () => getCtx().mesh;
    // 探针：对外（增益后）麦克风流上的常驻抽头；同步读取，外部驱动节拍
    window.__vcOutTap = () => {
        const { hub } = getCtx();
        if (!hub?.ctx || !hub.mic) return null;
        if (!window.__outTap || window.__outTapKey !== hub.mic) {
            try {
                window.__outTap?.src.disconnect();
            } catch {
                /* 过期的旧抽头 */
            }
            const src = hub.ctx.createMediaStreamSource(hub.mic.stream);
            const an = hub.ctx.createAnalyser();
            an.fftSize = 2048;
            src.connect(an);
            window.__outTap = { src, an, data: new Float32Array(an.fftSize) };
            window.__outTapKey = hub.mic;
        }
        const { an, data } = window.__outTap;
        an.getFloatTimeDomainData(data); // 线性刻度 —— 字节读数按 dB 映射，会掩盖增益变化
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        return Number(Math.sqrt(sum / data.length).toFixed(4));
    };
    // 探针：第一个远端对端流的线性 RMS（接收侧）
    window.__vcPeerRms = () => {
        const { hub } = getCtx();
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
