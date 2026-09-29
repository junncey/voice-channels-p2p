/**
 * Chat message list — plain-text only (textContent everywhere, no HTML injection).
 */

import { el, formatTime, avatarColor } from './utils.js';

/**
 * @param {HTMLElement} container scrollable message list
 * @param {object} [options]
 * @param {string}  [options.emptyText] placeholder shown when the list is empty
 * @param {string}  [options.downloadText] lightbox save-image button label
 */
export function initChat(container, { emptyText = '', downloadText = 'Save' } = {}) {
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
        const stick = nearBottom();

        const node = el('div', {
            class: 'msg' + (self ? ' self' : '') + (system ? ' system' : ''),
        });

        if (system) {
            node.append(el('div', { class: 'msg-system-text', text }));
        } else {
            node.append(...buildBody({ name, text, self, time }));
        }

        append(node, stick);
    }

    /**
     * Image bubble — src must be a validated data:image/* URL (the receiver
     * whitelists the mime; we never interpolate it into HTML).
     * @param {object} msg
     * @param {string} msg.name
     * @param {string} msg.src    data URL
     * @param {boolean} [msg.self]
     * @param {string} [msg.alt]  alt/filename text
     * @param {Date} [msg.time]
     */
    function addImage({ name, src, self = false, alt = 'image', time = new Date() }) {
        if (!/^data:image\/(jpeg|png|gif|webp);base64,/.test(src)) return;
        const stick = nearBottom();

        const node = el('div', { class: 'msg img' + (self ? ' self' : '') });
        node.append(
            ...buildBody({ name, text: '', self, time }),
            (() => {
                const img = el('img', {
                    class: 'msg-image',
                    alt,
                    loading: 'lazy',
                    title: alt,
                });
                img.src = src;
                img.addEventListener('click', () => openLightbox(img.src, alt));
                return img;
            })()
        );

        append(node, stick);
    }

    function buildBody({ name, text, self, time }) {
        return [
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
                text ? el('div', { class: 'msg-text', text }) : null
            ),
        ];
    }

    function append(node, stick) {
        if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
        }
        container.append(node);
        if (stick) container.scrollTop = container.scrollHeight;
        // cap history so a long session can't grow the DOM unbounded
        while (container.children.length > 300) container.firstChild.remove();
        if (!container.children.length) showEmpty();
    }

    // ----- lightbox (click an image to view it full size) -----

    let lightbox = null;

    function openLightbox(src, alt) {
        closeLightbox();
        const img = el('img', { alt });
        img.src = src;
        const download = el('a', { class: 'btn ghost sm', download: alt || 'image', href: src, text: downloadText });
        download.setAttribute('download', alt || 'image');
        lightbox = el('div', { class: 'lightbox', onclick: () => closeLightbox() }, el('div', { class: 'lightbox-bar', onclick: (e) => e.stopPropagation() }, download), img);
        document.body.append(lightbox);
        document.addEventListener('keydown', lightboxEsc);
    }

    function lightboxEsc(event) {
        if (event.key === 'Escape') closeLightbox();
    }

    function closeLightbox() {
        if (!lightbox) return;
        document.removeEventListener('keydown', lightboxEsc);
        lightbox.remove();
        lightbox = null;
    }

    showEmpty();
    return { add, addImage };
}
