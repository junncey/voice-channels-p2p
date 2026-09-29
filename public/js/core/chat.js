/**
 * Chat message list — plain-text only (textContent everywhere, no HTML injection).
 */

import { el, formatTime, avatarColor } from './utils.js';

/**
 * @param {HTMLElement} container scrollable message list
 * @param {object} [options]
 * @param {string}  [options.emptyText] placeholder shown when the list is empty
 */
export function initChat(container, { emptyText = '' } = {}) {
    let emptyNode = null;

    function showEmpty() {
        if (!emptyText || emptyNode) return;
        emptyNode = el('div', { class: 'chat-empty', text: emptyText });
        container.append(emptyNode);
    }

    function nearBottom() {
        return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    }

    /**
     * @param {object} msg
     * @param {string} msg.name
     * @param {string} msg.text
     * @param {boolean} [msg.self]
     * @param {boolean} [msg.system]
     * @param {Date} [msg.time]
     */
    function add({ name, text, self = false, system = false, time = new Date() }) {
        if (!text) return;
        if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
        }
        const stick = nearBottom();

        const node = el('div', {
            class: 'msg' + (self ? ' self' : '') + (system ? ' system' : ''),
        });

        if (system) {
            node.append(el('div', { class: 'msg-system-text', text }));
        } else {
            node.append(
                el(
                    'div',
                    { class: 'msg-avatar', style: { background: avatarColor(name) } },
                    (name || '?').trim().charAt(0).toUpperCase() || '?'
                ),
                el(
                    'div',
                    { class: 'msg-body' },
                    el(
                        'div',
                        { class: 'msg-meta' },
                        el('span', { class: 'msg-name', text: name }),
                        el('span', { class: 'msg-time', text: formatTime(time) })
                    ),
                    el('div', { class: 'msg-text', text })
                )
            );
        }

        container.append(node);
        if (stick) container.scrollTop = container.scrollHeight;
        // cap history so a long session can't grow the DOM unbounded
        while (container.children.length > 300) container.firstChild.remove();
        if (!container.children.length) showEmpty();
    }

    showEmpty();
    return { add };
}
