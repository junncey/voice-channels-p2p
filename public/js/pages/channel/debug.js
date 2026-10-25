/**
 * e2e inspection hooks (only with #debug in the URL — never in normal use).
 * Extracted from the channel controller: every probe pulls a FRESH context
 * snapshot via getCtx(), so the controller's mutable module state (hub, mesh,
 * members, …) is always read live.
 */

export function installDebugHooks(getCtx) {
    window.__vcDebug = () => {
        const { hub, micProcessed, micTest, settings, members, audioEls, connPaths, lossStreaks, peerRecovery, b1Attempts, b1InFlight, webAudioPlayback, shareSound } = getCtx();
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
        };
    };
    // e2e aid: swap the outgoing mic track for a synthetic sine — verifies the
    // WebRTC chain without depending on acoustic mic/speaker hardware
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
        const { mesh } = getCtx();
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
    // probe: force the AudioContext suspended/running to test the fallback migration
    window.__vcCtx = (op) => {
        const { hub } = getCtx();
        return op === 'suspend' ? hub?.ctx?.suspend() : hub?.ctx?.resume();
    };
    // probe: direct access to the mesh (pc states, restartIce) for recovery tests
    window.__vcMesh = () => getCtx().mesh;
    // probe: persistent tap on the outgoing (post-gain) mic stream; sync read, external pacing
    window.__vcOutTap = () => {
        const { hub } = getCtx();
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
