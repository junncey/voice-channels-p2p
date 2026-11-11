/**
 * 屏幕 Wake Lock 持有器 —— 移动浏览器在锁屏时会杀掉
 * WebRTC 语音会话，所以语音会话进行期间，
 * 频道页要保持屏幕常亮。页面重新变为可见时自行重新武装
 * （隐藏期间系统会释放 sentinel）；
 * 在 API 不支持或被拒绝的地方静默降级。
 */

export function createWakeLock({ wanted = () => false } = {}) {
    let sentinel = null; // 活动的 WakeLockSentinel；null = 未持有
    let busy = false; // request() 往返正在进行

    async function sync() {
        if (!('wakeLock' in navigator)) return; // 不支持：静默降级
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
                // 系统收回它（锁屏、省电模式）：丢掉句柄，
                // 让 visibilitychange 处理器能重新请求新的
                held.addEventListener('release', () => {
                    if (sentinel === held) sentinel = null;
                });
            } else {
                held.release().catch(() => {});
            }
        } catch {
            /* 被拒绝 —— 会话只是失去常亮这份贴心而已 */
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
            /* 早已释放 */
        }
    }

    document.addEventListener('visibilitychange', sync);

    return { sync, release };
}
