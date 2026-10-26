/*
Offline banner — a slim danger-tinted strip pinned to the top of the channel
page while navigator.onLine is false. Losing the network here kills the socket
AND every DataChannel at once, so the strip explains why nothing responds
while recovery.js keeps retrying underneath. Purely informational: it owns no
state and drives no reconnect logic — online/offline events flip it, that's
all. Reuses the update-bar layout from base.css.
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
