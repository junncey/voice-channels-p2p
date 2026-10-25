/**
 * Screen Wake Lock holder — mobile browsers kill the WebRTC voice session
 * when the screen locks, so the channel page keeps the screen awake while a
 * voice session is live. Re-arms itself when the page becomes visible again
 * (the system releases the sentinel while hidden); silently degrades where
 * the API is unsupported or denied.
 */

export function createWakeLock({ wanted = () => false } = {}) {
    let sentinel = null; // active WakeLockSentinel; null = not held
    let busy = false; // request() round-trip in flight

    async function sync() {
        if (!('wakeLock' in navigator)) return; // unsupported: degrade silently
        if (!wanted()) {
            release();
            return;
        }
        if (sentinel || busy) return;
        busy = true;
        try {
            const held = await navigator.wakeLock.request('screen');
            if (wanted()) {
                sentinel = held;
                // system revoked it (screen off, battery saver): drop the
                // handle so the visibilitychange handler can request a fresh one
                held.addEventListener('release', () => {
                    if (sentinel === held) sentinel = null;
                });
            } else {
                held.release().catch(() => {});
            }
        } catch {
            /* denied — the session just loses the keep-awake nicety */
        } finally {
            busy = false;
        }
    }

    function release() {
        const held = sentinel;
        sentinel = null;
        try {
            held?.release?.().catch?.(() => {});
        } catch {
            /* already released */
        }
    }

    document.addEventListener('visibilitychange', sync);

    return { sync, release };
}
