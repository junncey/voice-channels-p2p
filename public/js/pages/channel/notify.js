/*
Unread badge + desktop notifications — background-tab bookkeeping for the
channel page: title counter for unread messages and an @mention
Notification (when enabled and permission is granted).
Shared page state arrives via the `s` accessor object (owned by channel.js).
*/

export function createNotify({ s, x, channelId, escapeRegExp, toast, t }) {
    let baseTitle = '';
    let unreadCount = 0;
    const NOTIFY_KEY = 'vc_notify';
    const notifySupported = typeof window !== 'undefined' && 'Notification' in window;
    let notifyEnabled =
        notifySupported && localStorage.getItem(NOTIFY_KEY) === '1' && Notification.permission === 'granted';

    /** true when the text contains an @mention of the local user's name */
    function mentionsMe(text) {
        if (!s.selfName || !text.includes('@')) return false;
        const re = new RegExp(`@${escapeRegExp(s.selfName)}(?![\\p{L}\\p{N}_])`, 'u');
        return re.test(text);
    }

    /** A message from someone else arrived: bump the background-tab counter and,
     *  when it mentions us, fire a desktop notification (if enabled). */
    function noteIncomingMessage(name, text) {
        if (name === s.selfName || !document.hidden) return;
        unreadCount += 1;
        document.title = `(${unreadCount}) ${baseTitle}`;
        if (notifyEnabled && mentionsMe(text)) {
            try {
                const n = new Notification(`@${name} · ${s.channelMeta?.name || channelId}`, {
                    body: (text || t('chat.image')).slice(0, 80),
                    tag: 'vc-mention',
                    silent: true, // the message chime already played
                });
                n.onclick = () => {
                    window.focus();
                    n.close();
                };
            } catch {
                /* some platforms throw on construction — the title badge still works */
            }
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && unreadCount) {
            unreadCount = 0;
            document.title = baseTitle;
        }
    });

    /** boot() hands over the page title once the channel metadata is in. */
    function setBaseTitle(title) {
        baseTitle = title;
        document.title = baseTitle;
    }

    async function onNotifyToggle(event) {
        const on = event.target.checked;
        if (!on) {
            notifyEnabled = false;
            localStorage.setItem(NOTIFY_KEY, '0');
            return;
        }
        if (Notification.permission === 'granted') {
            notifyEnabled = true;
            localStorage.setItem(NOTIFY_KEY, '1');
            return;
        }
        if (Notification.permission === 'denied') {
            event.target.checked = false;
            toast(t('channel.notifyBlocked'), 'warn');
            return;
        }
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            notifyEnabled = true;
            localStorage.setItem(NOTIFY_KEY, '1');
        } else {
            event.target.checked = false;
            if (permission === 'denied') toast(t('channel.notifyBlocked'), 'warn');
        }
    }

    return {
        noteIncomingMessage,
        setBaseTitle,
        onNotifyToggle,
        isNotifyEnabled: () => notifyEnabled,
        notifySupported,
    };
}
