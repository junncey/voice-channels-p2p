/**
 * 「一起听」—— 把一个应用的声音混入对外的语音输出流
 * （AudioHub.attachShare），让频道里的每个人都能与麦克风一起听到。
 * 全程不涉及重协商：共享音频搭麦克风管线的
 * MediaStreamAudioDestinationNode，走同一条 audio m-line。
 *
 * 两种来源：
 * 1. 浏览器标签页 —— getDisplayMedia 选「标签页」并勾选「分享标签
 *    页声音」（整屏+系统声音是兜底）。共享期间被分享标签页的本地
 *    播放被 Chrome 静音（suppressLocalAudioPlayback，采集照常）。
 *    getDisplayMedia 强制要求的视频轨到手即停 —— 任何画面都不会
 *    离开浏览器。
 * 2. 本机应用（桌面客户端/游戏）—— 直连 helper/app-audio-bridge 小
 *    工具（127.0.0.1:8790+，WASAPI 进程级回路采集，见
 *    docs/share-app-audio.md）：拉取 float32 流经 WebAudio 送进
 *    MediaStreamAudioDestinationNode，**不经本地扬声器**——本地零
 *    重音，也无需浏览器选择器。
 *
 * 共享进行期间，对外混音必须保持活跃，否则音乐会断，所以
 * 麦克风静音被控制器改道：RAW 采集轨接过 on-air 门控，
 * 处理后（混音）轨始终保持启用。
 */

import { t } from '/js/core/i18n.js';

// 小工具端口探测序列（被占用时自动顺延，与服务端 pick_port 一致；
// 避开 8765 等浏览器受限端口——那些端口上 fetch 会 ERR_UNSAFE_PORT）
const HELPER_PORTS = [8790, 8791, 8792, 8793, 8794];

/**
 * @param {object} deps
 * @param {function(): boolean}  deps.isJoined        是否已加入频道
 * @param {function(): Promise<boolean>} deps.ensureVoice  获取麦克风（成员以纯文字
 *        身份加入时会弹权限请求）并回报成败
 * @param {function(): object|null} deps.getHub        实时 AudioHub（每次 join 重建）
 * @param {function(): boolean}  deps.pipelineReady   麦克风已处理且上下文运行中
 * @param {function(): void}     deps.applyGate       重新推送麦克风 on-air 状态（轨门控）
 * @param {function(boolean): void} deps.broadcast    告知房间（peerStatus share）
 * @param {function(): void}     deps.refreshBitrate  重新应用 Opus 发送上限
 * @param {function(string, string): void} deps.toast 消息出口
 */
export function createShareSound(deps) {
    /** @type {MediaStream|null} 我们持有的输出流（display 路径=采集轨；helper 路径=destination 轨） */
    let stream = null;
    /** helper 路径的清理器 */
    let helperCtl = null;
    /** 探测到的小工具基地址缓存 */
    let helperBase = null;

    /** 两条来源共用的门禁：已加入、语音管线就绪。返回就绪的 AudioHub。 */
    async function prepare() {
        if (stream) return null; // 同一时刻只允许一种共享
        if (!deps.isJoined()) return null;
        // 共享要经麦克风管线混音 —— 语音必须先处于活跃状态
        if (!(await deps.ensureVoice())) {
            deps.toast(t('channel.shareVoiceNeeded'), 'warn');
            return null;
        }
        const hub = deps.getHub();
        if (!hub) return null;
        await hub.ensureContext().catch(() => {});
        if (!deps.pipelineReady()) {
            deps.toast(t('channel.sharePipeline'), 'warn');
            return null;
        }
        return hub;
    }

    /** 探测本机小工具（含端口顺延），成功返回基地址并缓存。 */
    async function findHelper() {
        if (helperBase) return helperBase;
        for (const port of HELPER_PORTS) {
            const base = `http://127.0.0.1:${port}`;
            try {
                const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(600) });
                if (res.ok && (await res.json())?.rate) {
                    helperBase = base;
                    return base;
                }
            } catch {
                /* 端口无人监听：试下一个 */
            }
        }
        return null;
    }

    /** 来源 1：浏览器标签页（选择器里也可手动改选整屏+系统声音兜底）。 */
    async function start() {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            deps.toast(t('channel.shareUnsupported'), 'warn');
            return;
        }
        const hub = await prepare();
        if (!hub) return;

        let capture;
        try {
            capture = await navigator.mediaDevices.getDisplayMedia({
                video: true, // 纯音频的屏幕采集并不存在；视频轨在下方丢弃
                // 共享期间 Chrome 只静音被分享标签页的「本地播放」、采集
                // 照常——防止整页重音；停止共享后标签页自动恢复出声
                audio: { suppressLocalAudioPlayback: true },
                // 让本标签页不出现在选择器里：采集它会把这里正在
                // 播放的远端声音原样回灌给所有人（回声）
                selfBrowserSurface: 'exclude',
                systemAudio: 'include',
                surfaceSwitching: 'include',
            });
        } catch {
            return; // 在选择器里取消，或被硬性拒绝 —— 无需上报
        }
        const audio = capture.getAudioTracks()[0];
        if (!audio) {
            // 选了窗口，或没勾选音频复选框
            capture.getTracks().forEach((track) => track.stop());
            deps.toast(t('channel.shareNoAudio'), 'warn');
            return;
        }
        for (const video of capture.getVideoTracks()) {
            video.stop();
            capture.removeTrack(video);
        }
        if (!hub.attachShare(capture)) {
            capture.getTracks().forEach((track) => track.stop());
            deps.toast(t('common.error'), 'warn');
            return;
        }
        stream = capture;
        // 浏览器自带的「停止共享」条会在我们不知情时结束轨道
        audio.addEventListener('ended', () => stop());
        deps.applyGate();
        deps.broadcast(true);
        deps.refreshBitrate();
        deps.toast(t('channel.shareStarted'), 'ok');
    }

    /**
     * 来源 2：本机应用 —— 让小工具开始按进程采集，频道页直接拉流。
     * 音频只进对外混音（MediaStreamAudioDestination），本地不发声。
     * @param {number} pid 目标进程（小工具按进程树采集）
     */
    async function startHelper(pid, name) {
        const base = await findHelper();
        if (!base) {
            deps.toast(t('channel.shareHelperMissing'), 'warn');
            return;
        }
        const hub = await prepare();
        if (!hub) return;
        try {
            const res = await fetch(`${base}/api/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pid, name }),
                // 须长于小工具的激活等待（6s）：让服务端先返回真实错误，
                // 客户端提前放弃会留下无主采集
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) throw new Error('helper rejected');
        } catch {
            deps.toast(t('channel.shareHelperFail'), 'warn');
            return;
        }
        // 拉流并经 WebAudio 送进对外混音节点；失败（小工具退出/进程结束
        // 断流）由 pump 捕获并自动收场
        const dest = hub.ctx.createMediaStreamDestination();
        const abort = new AbortController();
        const pump = (async () => {
            const res = await fetch(`${base}/stream`, { signal: abort.signal });
            const reader = res.body.getReader();
            // 注意：下面这段「8 字节重组 + 丢帧追赶」播放循环与小工具内嵌页
            // (helper/app-audio-bridge/src/page.html) 是双份手抄，改动须两处同步
            let pending = new Uint8Array(0); // read() 按网络任意切割，跨段对齐到整帧（8 字节）
            let nextTime = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const merged = new Uint8Array(pending.length + value.byteLength);
                merged.set(pending);
                merged.set(value, pending.length);
                const usable = Math.floor(merged.byteLength / 8) * 8;
                pending = merged.slice(usable);
                const frames = usable / 8;
                if (!frames) continue;
                const work = merged.slice(0, usable);
                const interleaved = new Float32Array(work.buffer, 0, frames * 2);
                const buf = hub.ctx.createBuffer(2, frames, 48000); // 小工具固定 48k 立体声
                const l = buf.getChannelData(0);
                const r = buf.getChannelData(1);
                for (let i = 0; i < frames; i++) {
                    l[i] = interleaved[i * 2];
                    r[i] = interleaved[i * 2 + 1];
                }
                const src = hub.ctx.createBufferSource();
                src.buffer = buf;
                src.connect(dest);
                const now = hub.ctx.currentTime;
                if (nextTime < now + 0.03) nextTime = now + 0.03; // 30ms 起播余量
                if (nextTime > now + 0.35) nextTime = now + 0.06; // 落后过多：丢帧追上
                src.start(nextTime);
                nextTime += buf.duration;
            }
        })();
        if (!hub.attachShare(dest.stream)) {
            abort.abort();
            fetch(`${base}/api/stop`, { method: 'POST' }).catch(() => {});
            deps.toast(t('common.error'), 'warn');
            return;
        }
        stream = dest.stream;
        helperCtl = {
            abort,
            cleanup() {
                abort.abort();
                fetch(`${base}/api/stop`, { method: 'POST' }).catch(() => {});
            },
        };
        pump.catch(() => stop()); // 断流/小工具退出：与用户主动停止同路收场
        deps.applyGate();
        deps.broadcast(true);
        deps.refreshBitrate();
        deps.toast(t('channel.shareStartedApp'), 'ok');
    }

    function stop({ silent = false } = {}) {
        if (!stream) return;
        const capture = stream;
        stream = null;
        const ctl = helperCtl;
        helperCtl = null;
        const hub = deps.getHub();
        hub?.detachShare();
        // 所有权到此为止：停掉音频轨也会同时熄灭
        // 浏览器的共享指示
        capture.getTracks().forEach((track) => track.stop());
        ctl?.cleanup();
        deps.applyGate();
        deps.broadcast(false);
        deps.refreshBitrate();
        if (!silent) deps.toast(t('channel.shareEnded'), '');
    }

    return {
        start,
        startHelper,
        findHelper,
        stop,
        /** 共享进行中（音频正流入对外混音） */
        active: () => !!stream,
    };
}
