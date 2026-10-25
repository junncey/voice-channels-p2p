/**
 * "Listen together" — capture system or tab audio with getDisplayMedia and
 * mix it into the outgoing voice stream (AudioHub.attachShare), so everyone
 * in the channel hears it alongside the mic. No renegotiation is involved:
 * the share rides the SAME audio m-line through the mic pipeline's
 * MediaStreamAudioDestinationNode.
 *
 * Source selection happens in the browser's own picker: "entire screen" +
 * "share system audio" for everything the machine plays, or a single tab +
 * "share tab audio" for one app's sound (window shares carry no audio).
 * The video track that getDisplayMedia demands is stopped on arrival —
 * nothing visual ever leaves the browser.
 *
 * While a share runs, the outgoing mix must stay live or the music dies, so
 * mic muting is re-routed by the controller: the RAW capture track gets the
 * on-air gate and the processed (mixed) track always stays enabled.
 */

import { t } from '/js/core/i18n.js';

/**
 * @param {object} deps
 * @param {function(): boolean}  deps.isJoined        joined to a channel
 * @param {function(): Promise<boolean>} deps.ensureVoice  acquire the mic (prompts
 *        permission when the member joined text-only) and report success
 * @param {function(): object|null} deps.getHub        live AudioHub (rebuilt per join)
 * @param {function(): boolean}  deps.pipelineReady   mic processed & context running
 * @param {function(): void}     deps.applyGate       re-push the mic on-air state (track gating)
 * @param {function(boolean): void} deps.broadcast    tell the room (peerStatus share)
 * @param {function(): void}     deps.refreshBitrate  re-apply the Opus send caps
 * @param {function(string, string): void} deps.toast message sink
 */
export function createShareSound(deps) {
    /** @type {MediaStream|null} the capture we own (audio track after video drop) */
    let stream = null;

    async function start() {
        if (stream) return;
        if (!deps.isJoined()) return;
        if (!navigator.mediaDevices?.getDisplayMedia) {
            deps.toast(t('channel.shareUnsupported'), 'warn');
            return;
        }
        // the share mixes through the mic pipeline — voice must be live first
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
                video: true, // audio-only display capture isn't a thing; dropped below
                audio: true,
                // keep our own tab out of the picker: capturing it would loop the
                // remote voices playing here straight back to everyone (echo)
                selfBrowserSurface: 'exclude',
                systemAudio: 'include',
                surfaceSwitching: 'include',
            });
        } catch {
            return; // cancelled in the picker, or a hard denial — nothing to report
        }
        const audio = capture.getAudioTracks()[0];
        if (!audio) {
            // a window pick, or the audio checkbox was left unticked
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
        // the browser's own "stop sharing" bar ends the track without us
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
        // ownership ends here: stopping the audio track also flips the
        // browser's sharing indicator off
        capture.getTracks().forEach((track) => track.stop());
        deps.applyGate();
        deps.broadcast(false);
        deps.refreshBitrate();
        if (!silent) deps.toast(t('channel.shareEnded'), '');
    }

    return {
        start,
        stop,
        /** a share is live (audio flowing into the outgoing mix) */
        active: () => !!stream,
    };
}
