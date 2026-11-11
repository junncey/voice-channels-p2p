/**
 * 「一起听」—— 用 getDisplayMedia 采集系统或标签页音频，
 * 混入对外的语音输出流（AudioHub.attachShare），让频道里的
 * 每个人都能与麦克风一起听到。全程不涉及重协商：共享音频
 * 搭麦克风管线的 MediaStreamAudioDestinationNode，
 * 走同一条 audio m-line。
 *
 * 音源选择交给浏览器自己的选择器：「整个屏幕」+「共享系统
 * 音频」可播整台机器的声音，或单个标签页 +「共享标签页
 * 音频」播一个应用的声音（窗口共享不带音频）。
 * getDisplayMedia 强制要求的视频轨到手即停 ——
 * 任何画面都不会离开浏览器。
 *
 * 共享进行期间，对外混音必须保持活跃，否则音乐会断，所以
 * 麦克风静音被控制器改道：RAW 采集轨接过 on-air 门控，
 * 处理后（混音）轨始终保持启用。
 */

import { t } from '/js/core/i18n.js';

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
    /** @type {MediaStream|null} 我们持有的采集（丢掉视频轨后的音频轨） */
    let stream = null;

    async function start() {
        if (stream) return;
        if (!deps.isJoined()) return;
        if (!navigator.mediaDevices?.getDisplayMedia) {
            deps.toast(t('channel.shareUnsupported'), 'warn');
            return;
        }
        // 共享要经麦克风管线混音 —— 语音必须先处于活跃状态
        if (!(await deps.ensureVoice())) {
            deps.toast(t('channel.shareVoiceNeeded'), 'warn');
            return;
        }
        const hub = deps.getHub();
        if (!hub) return;
        await hub.ensureContext().catch(() => {});
        if (!deps.pipelineReady()) {
            deps.toast(t('channel.sharePipeline'), 'warn');
            return;
        }

        let capture;
        try {
            capture = await navigator.mediaDevices.getDisplayMedia({
                video: true, // 纯音频的屏幕采集并不存在；视频轨在下方丢弃
                audio: true,
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

    function stop({ silent = false } = {}) {
        if (!stream) return;
        const capture = stream;
        stream = null;
        const hub = deps.getHub();
        hub?.detachShare();
        // 所有权到此为止：停掉音频轨也会同时熄灭
        // 浏览器的共享指示
        capture.getTracks().forEach((track) => track.stop());
        deps.applyGate();
        deps.broadcast(false);
        deps.refreshBitrate();
        if (!silent) deps.toast(t('channel.shareEnded'), '');
    }

    return {
        start,
        stop,
        /** 共享进行中（音频正流入对外混音） */
        active: () => !!stream,
    };
}
