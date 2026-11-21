/*
join 时的麦克风获取，权限等待有上限。

当权限弹窗始终无人应答（标签页被忽略、弹窗被关掉、策略
既不授权也不拒绝）时，浏览器会让 getUserMedia() 的 promise
无限期挂起。joinInner() 在开 socket 之前要 await 这个调用，
所以过去一个无人应答的弹窗就意味着：没有 socket、
没有成员卡片、按钮卡在「连接中…」——
什么都没坏，房间却像不可达。

另一类「房间不可达」：非安全上下文。局域网设备经
http://<IP> 访问时 navigator.mediaDevices 整个是 undefined
（getUserMedia 仅在 https / localhost 可用），过去的
getUserMedia 调用会同步抛 TypeError 且逃出自己的 try——
join 流程同样死在开 socket 之前。

acquireMic() 给等待设了上限。超时即返回 { stream: null,
timedOut: true }，并释放迟到的授权（否则采集指示灯常亮，
却没人读这条轨道）。调用方退化为纯文字；麦克风按钮
此后可重试，那次调用会带着用户手势。API 整个不存在时
返回 { stream: null, timedOut: false, unavailable: true }，
同样不抛——调用方据此给出准确提示。
*/

export const MIC_GRANT_TIMEOUT_MS = 8000;

/** getUserMedia API 是否存在（https / localhost 之外的非安全上下文里没有）。 */
export function micApiAvailable() {
    return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * @param {MediaStreamConstraints} constraints
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ stream: MediaStream|null, timedOut: boolean, unavailable?: boolean }>}
 */
export async function acquireMic(constraints, { timeoutMs = MIC_GRANT_TIMEOUT_MS } = {}) {
    if (!micApiAvailable()) return { stream: null, timedOut: false, unavailable: true };
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
            // 授权可能稍后才落地 —— 释放它让设备空闲出来
            request.then((late) => late.getTracks().forEach((track) => track.stop())).catch(() => {});
        }
        return { stream: null, timedOut };
    } finally {
        clearTimeout(timer);
    }
}
