/*
未读徽章 + 桌面通知 —— 频道页的后台标签页簿记：未读消息的
标题计数，以及 @提及时的桌面 Notification（开关开启且已授权
时触发）。
共享页面状态经 `s` 存取器对象到达（归 channel.js 所有）。
*/

import { MENTION_BOUNDARY } from '/js/core/utils.js';

export function createNotify({ s, x, channelId, escapeRegExp, toast, t }) {
    let baseTitle = '';
    let unreadCount = 0;
    const NOTIFY_KEY = 'vc_notify';
    const notifySupported = typeof window !== 'undefined' && 'Notification' in window;
    let notifyEnabled =
        notifySupported && localStorage.getItem(NOTIFY_KEY) === '1' && Notification.permission === 'granted';

    /** 文本中包含对本机用户名的 @提及 时为 true */
    function mentionsMe(text) {
        if (!s.selfName || !text.includes('@')) return false;
        // 词边界与聊天高亮共用（utils.MENTION_BOUNDARY）
        const re = new RegExp(`@${escapeRegExp(s.selfName)}${MENTION_BOUNDARY}`, 'u');
        return re.test(text);
    }

    /** 收到别人的消息：抬升后台标签页计数，
     *  若提及我们则（在开关开启时）发桌面通知。 */
    function noteIncomingMessage(name, text) {
        if (name === s.selfName || !document.hidden) return;
        unreadCount += 1;
        document.title = `(${unreadCount}) ${baseTitle}`;
        if (notifyEnabled && mentionsMe(text)) {
            try {
                const n = new Notification(`@${name} · ${s.channelMeta?.name || channelId}`, {
                    body: (text || t('chat.image')).slice(0, 80),
                    tag: 'vc-mention',
                    silent: true, // 消息提示音已播过
                });
                n.onclick = () => {
                    window.focus();
                    n.close();
                };
            } catch {
                /* 某些平台在构造时就抛错 —— 标题徽章仍然有效 */
            }
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && unreadCount) {
            unreadCount = 0;
            document.title = baseTitle;
        }
    });

    /** 频道元数据到位后，boot() 把页面标题交到这里。 */
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
