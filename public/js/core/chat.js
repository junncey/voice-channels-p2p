/**
 * Chat message list — QQ-style bubbles (avatar beside a tailed bubble,
 * nickname above the bubble for others, centered time separators).
 * Plain text only (textContent everywhere, no HTML injection; image/avatar
 * sources must be validated data:image URLs — we never interpolate HTML).
 */

import { el, formatTime, formatDate, avatarColor } from './utils.js';

/** Show a time separator when the gap to the previous message exceeds this. */
const TIME_GAP_MS = 5 * 60 * 1000;

const DATA_URL_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * @param {HTMLElement} container scrollable message list
 * @param {object} [options]
 * @param {string}  [options.emptyText] placeholder shown when the list is empty
 * @param {string}  [options.downloadText] lightbox save-image button label
 * @param {string}  [options.yesterdayText] time-separator label for yesterday
 * @param {function(string):string} [options.avatarFor] name -> custom avatar data URL ('' = none)
 * @param {function(number, number):string} [options.imagesProgress] (got, total) -> progress label
 * @param {string}  [options.failText] note when every image of a batch failed
 */
export function initChat(
    container,
    {
        emptyText = '',
        downloadText = 'Save',
        yesterdayText = '昨天',
        avatarFor = null,
        imagesProgress = (got, total) => `${got}/${total}`,
        failText = '',
    } = {}
) {
    let emptyNode = null;
    let lastTime = null;
    /** batchId -> { imagesEl, progressEl, textEl, expected, done } */
    const batches = new Map();

    function showEmpty() {
        if (!emptyText || emptyNode) return;
        emptyNode = el('div', { class: 'chat-empty', text: emptyText });
        container.append(emptyNode);
    }

    function nearBottom() {
        return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    }

    function timeChipText(d) {
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return formatTime(d);
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return `${yesterdayText} ${formatTime(d)}`;
        return d.getFullYear() === now.getFullYear() ? formatDate(d) : `${d.getFullYear()}/${formatDate(d)}`;
    }

    function maybeTimeChip(time, stick) {
        const ts = time.getTime();
        if (lastTime !== null && ts - lastTime <= TIME_GAP_MS) {
            lastTime = Math.max(lastTime, ts);
            return;
        }
        append(el('div', { class: 'chat-time', text: timeChipText(time) }), stick);
        lastTime = ts;
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
        maybeTimeChip(new Date(time), stick);

        if (system) {
            append(el('div', { class: 'msg system' }, el('div', { class: 'msg-system-text', text })), stick);
            return;
        }
        const bubble = el('div', { class: 'msg-bubble' }, el('div', { class: 'msg-text', text }));
        append(buildMessage({ name, self, bubble }), stick);
    }

    /**
     * Standalone image message (no batch). src must be a validated data:image/* URL.
     */
    function addImage({ name, src, self = false, alt = 'image', time = new Date() }) {
        if (!DATA_URL_RE.test(src)) return;
        const stick = nearBottom();
        maybeTimeChip(new Date(time), stick);
        const bubble = el('div', { class: 'msg-bubble img' }, imageNode(src, alt));
        append(buildMessage({ name, self, bubble }), stick);
    }

    /**
     * Open a merged bubble for one send of text + N images (QQ style: images
     * stacked in the bubble, text underneath). Images are appended later via
     * addBatchImage as their transfers complete.
     * @param {object} msg
     * @param {string}  msg.batch  batch id shared with the image frames
     * @param {string}  msg.name
     * @param {string}  [msg.text]
     * @param {number}  msg.count  announced image count
     * @param {boolean} [msg.self]
     * @param {Date}    [msg.time]
     */
    function openBatch({ batch, name, text = '', count = 1, self = false, time = new Date() }) {
        if (!batch) return;
        const stick = nearBottom();
        maybeTimeChip(new Date(time), stick);

        const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(count, 6))}` });
        const progressEl = el('div', { class: 'msg-img-progress', text: imagesProgress(0, count) });
        const bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
        if (text) bubble.append(el('div', { class: 'msg-text', text }));
        bubble.append(progressEl);
        append(buildMessage({ name, self, bubble }), stick);

        batches.set(batch, { row: container.lastChild, imagesEl, progressEl, bubble, expected: count, done: 0, failed: 0 });
    }

    /**
     * Append one arrived image into its batch bubble. Falls back to a
     * standalone image message if the batch row is gone (history cap).
     */
    function addBatchImage(batch, src, alt = 'image') {
        if (!DATA_URL_RE.test(src)) return failBatchImage(batch);
        const entry = batches.get(batch);
        if (!entry) return addImage({ name: '?', src, alt });
        entry.done++;
        entry.imagesEl.append(imageNode(src, alt));
        settleBatch(batch, entry);
    }

    /** One image of the batch failed to transfer. */
    function failBatchImage(batch) {
        const entry = batches.get(batch);
        if (!entry) return;
        entry.failed++;
        settleBatch(batch, entry);
    }

    function settleBatch(batch, entry) {
        const stick = nearBottom();
        const settled = entry.done + entry.failed >= entry.expected;
        if (settled) {
            if (entry.failed && entry.done) {
                entry.progressEl.textContent = imagesProgress(entry.done, entry.expected);
            } else if (entry.failed && !entry.done) {
                if (!entry.bubble.querySelector('.msg-text')) {
                    entry.bubble.append(el('div', { class: 'msg-text', text: failText }));
                }
                entry.progressEl.remove();
            } else {
                entry.progressEl.remove();
            }
            batches.delete(batch);
            if (stick) container.scrollTop = container.scrollHeight;
            return;
        }
        entry.progressEl.textContent = imagesProgress(entry.done, entry.expected);
    }

    function imageNode(src, alt) {
        const img = el('img', {
            class: 'msg-image',
            alt,
            loading: 'lazy',
            title: alt,
        });
        img.src = src;
        img.addEventListener('click', () => openLightbox(img.src, alt));
        return img;
    }

    /** One QQ-style row: avatar beside a body of [nickname] + bubble.
     *  DOM order is [avatar, body] for BOTH sides — .msg.self's
     *  flex-direction: row-reverse flips it so the avatar lands on the
     *  right edge with the bubble to its left. */
    function buildMessage({ name, self, bubble }) {
        const row = el('div', { class: 'msg' + (self ? ' self' : ''), dataset: { name: name || '?' } });
        const body = el('div', { class: 'msg-body' });
        if (!self && name) body.append(el('div', { class: 'msg-name', text: name }));
        body.append(bubble);
        row.append(avatarNode(name), body);
        return row;
    }

    function avatarNode(name) {
        const url = avatarFor ? avatarFor(name) : '';
        if (url && DATA_URL_RE.test(url)) {
            const img = el('img', { class: 'msg-avatar img', alt: '' });
            img.src = url; // set after creation; src is a validated data URL
            return img;
        }
        return el(
            'div',
            { class: 'msg-avatar', style: { background: avatarColor(name) } },
            (name || '?').trim().charAt(0).toUpperCase() || '?'
        );
    }

    /**
     * Custom avatar changed (self or a peer) — re-render avatars of the
     * matching rows so history follows, like QQ does.
     */
    function setAvatar(name, url) {
        if (!name) return;
        for (const row of [...container.children]) {
            if (row.classList?.contains('msg') && row.dataset.name === name) {
                row.querySelector('.msg-avatar')?.replaceWith(avatarNode(name));
            }
        }
    }

    /** A peer was renamed — retarget future avatar updates for their rows. */
    function renamePeer(oldName, newName) {
        if (!oldName || !newName || oldName === newName) return;
        for (const row of container.children) {
            if (row.dataset?.name === oldName) row.dataset.name = newName;
        }
    }

    function append(node, stick) {
        if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
        }
        container.append(node);
        if (stick) container.scrollTop = container.scrollHeight;
        // cap history so a long session can't grow the DOM unbounded
        while (container.children.length > 300) {
            const removed = container.firstChild;
            // a capped-away batch row can no longer receive images — drop its
            // entry so late chunks fall back to standalone image messages
            for (const [id, entry] of batches) {
                if (entry.row === removed) batches.delete(id);
            }
            removed.remove();
        }
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
    return { add, addImage, openBatch, addBatchImage, failBatchImage, setAvatar, renamePeer };
}
