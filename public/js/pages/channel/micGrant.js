/*
Join-time microphone acquisition with a bounded permission wait.

The browser can leave a getUserMedia() promise pending indefinitely when the
permission prompt is never answered (ignored tab, dismissed dialog, a policy
that neither grants nor denies). joinInner() awaits that call before it opens
the socket, so one unanswered prompt used to mean: no socket, no member card,
the button stuck on "connecting…" — the room looked unreachable while nothing
was actually broken.

acquireMic() bounds the wait. On timeout it returns { stream: null, timedOut:
true } and releases a late-arriving grant (otherwise the capture light stays on
with nobody reading the track). The caller degrades to text-only; the mic button
can retry afterwards, this time under a user gesture.
*/

export const MIC_GRANT_TIMEOUT_MS = 8000;

/**
 * @param {MediaStreamConstraints} constraints
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ stream: MediaStream|null, timedOut: boolean }>}
 */
export async function acquireMic(constraints, { timeoutMs = MIC_GRANT_TIMEOUT_MS } = {}) {
    const request = navigator.mediaDevices.getUserMedia(constraints);
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('mic-grant-timeout'));
        }, timeoutMs);
    });
    try {
        return { stream: await Promise.race([request, timeout]), timedOut: false };
    } catch {
        if (timedOut) {
            // the grant may still land later — release it so the device is free
            request.then((late) => late.getTracks().forEach((track) => track.stop())).catch(() => {});
        }
        return { stream: null, timedOut };
    } finally {
        clearTimeout(timer);
    }
}
