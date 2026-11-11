/*
离线横幅 —— navigator.onLine 为 false 时，钉在频道页顶部的
窄条警示。这里断网会同时杀掉 socket 和全部 DataChannel，
横幅用来解释为什么一切都没有响应，而 recovery.js 仍在
底层持续重试。纯信息展示：不持有状态、不驱动任何
重连逻辑 —— online/offline 事件翻转它，仅此而已。
复用 base.css 的更新条布局。
*/

export function createOfflineBanner({ t }) {
    let bar = null;

    function sync() {
        if (!navigator.onLine) {
            if (bar) return;
            bar = document.createElement('div');
            bar.className = 'update-bar offline-bar';
            bar.setAttribute('role', 'status');
            bar.textContent = t('channel.offline');
            document.body.prepend(bar);
        } else if (bar) {
            bar.remove();
            bar = null;
        }
    }

    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    sync();
}
