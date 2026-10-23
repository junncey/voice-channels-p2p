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
// mirrors the server-side persisted-image cap — reject anything bigger on render
const MAX_IMAGE_CHARS = 1600 * 1024;

/**
 * @param {HTMLElement} container scrollable message list
 * @param {object} [options]
 * @param {string}  [options.emptyText] placeholder shown when the list is empty
 * @param {string}  [options.downloadText] lightbox save-image button label
 * @param {string}  [options.yesterdayText] time-separator label for yesterday
 * @param {function(string):string} [options.avatarFor] name -> custom avatar data URL ('' = none)
 * @param {function(number, number):string} [options.imagesProgress] (got, total) -> progress label
 * @param {string}  [options.failText] note when every image of a batch failed
 * @param {string}  [options.historyLoadingText] scroll-up pagination loading line
 * @param {string}  [options.historyEndText] scroll-up pagination end-of-history line
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
        historyLoadingText = '',
        historyEndText = '',
    } = {}
) {
    let emptyNode = null;
    let lastTime = null;
    let footerNode = null; // scroll-up pagination status line pinned to the top
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
        append(buildMessage({ name, self, bubble: textBubble(text), ts: time.getTime() }), stick);
    }

    /**
     * Standalone image message (no batch). src must be a validated data:image/* URL.
     */
    function addImage({ name, src, self = false, alt = 'image', time = new Date() }) {
        if (!DATA_URL_RE.test(src)) return;
        const when = new Date(time);
        const stick = nearBottom();
        maybeTimeChip(when, stick);
        const bubble = el('div', { class: 'msg-bubble img' }, imageNode(src, alt));
        append(buildMessage({ name, self, bubble, ts: when.getTime() }), stick);
    }

    /**
     * Render server-persisted history before the live session starts. Rows
     * keep their original send times (time chips rebuild naturally); image
     * batches render like the live merged bubbles — the data URLs were
     * persisted by the sender and are re-validated here before touching the DOM.
     * @param {Array<{name:string,text:string,imgs?:string[],self?:boolean,time:Date}>} messages
     * @param {object} [options]
     * @param {string} [options.dividerText] system line shown after the block
     * @param {string} [options.imageAlt]    alt/title for persisted images
     */
    function addHistory(messages, { dividerText = '', imageAlt = 'image' } = {}) {
        let shown = 0;
        for (const msg of Array.isArray(messages) ? messages : []) {
            if (!msg || typeof msg !== 'object') continue;
            const time = msg.time instanceof Date && !isNaN(msg.time) ? msg.time : new Date();
            const text = typeof msg.text === 'string' ? msg.text : '';
            const images = validImages(msg.imgs);
            if (!text && !images.length) continue;

            if (images.length) {
                const stick = nearBottom();
                maybeTimeChip(time, stick);
                const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(images.length, 6))}` });
                for (const src of images) imagesEl.append(imageNode(src, imageAlt));
                const bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
                if (text) bubble.append(el('div', { class: 'msg-text', text }));
                append(buildMessage({ name: msg.name, self: !!msg.self, bubble, ts: time.getTime() }), stick);
            } else {
                add({ name: msg.name, text, self: !!msg.self, time });
            }
            shown++;
        }
        if (shown && dividerText) add({ text: dividerText, system: true });
    }

    /** Plain-text bubble. */
    function textBubble(text) {
        return el('div', { class: 'msg-bubble' }, el('div', { class: 'msg-text', text }));
    }

    /** Persisted image URLs, re-validated before touching the DOM. */
    function validImages(imgs) {
        return (Array.isArray(imgs) ? imgs : [])
            .filter((src) => typeof src === 'string' && src.length > 0 && src.length <= MAX_IMAGE_CHARS && DATA_URL_RE.test(src))
            .slice(0, 9);
    }

    function timeChipNode(time) {
        return el('div', { class: 'chat-time', text: timeChipText(time) });
    }

    /**
     * Render one OLDER page of persisted history above everything currently
     * in the list (scroll-up pagination). Same row rules as addHistory; time
     * chips are rebuilt for the block (its first row always carries one) and
     * stitched to the existing top: a top chip the new rows now sit within
     * the gap threshold of becomes redundant and is dropped, a threshold-
     * crossing gap keeps it — or gets one when the DOM cap had removed it.
     * The viewport stays anchored: the scroll offset grows by the inserted
     * height, so nothing jumps. Deliberately does NOT run the DOM cap —
     * the freshly fetched rows must not be cut away again.
     * @param {Array<{name:string,text:string,imgs?:string[],self?:boolean,time:Date}>} messages
     * @param {object} [options]
     * @param {string} [options.imageAlt] alt/title for persisted images
     */
    function prependHistory(messages, { imageAlt = 'image' } = {}) {
        const frag = document.createDocumentFragment();
        let prevTs = null;
        let shown = 0;
        for (const msg of Array.isArray(messages) ? messages : []) {
            if (!msg || typeof msg !== 'object') continue;
            const time = msg.time instanceof Date && !isNaN(msg.time) ? msg.time : new Date();
            const ts = time.getTime();
            const text = typeof msg.text === 'string' ? msg.text : '';
            const images = validImages(msg.imgs);
            if (!text && !images.length) continue;

            if (prevTs === null || ts - prevTs > TIME_GAP_MS) frag.append(timeChipNode(time));
            let bubble;
            if (images.length) {
                const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(images.length, 6))}` });
                for (const src of images) imagesEl.append(imageNode(src, imageAlt));
                bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
                if (text) bubble.append(el('div', { class: 'msg-text', text }));
            } else {
                bubble = textBubble(text);
            }
            frag.append(buildMessage({ name: msg.name, self: !!msg.self, bubble, ts }));
            prevTs = ts;
            shown++;
        }
        if (!shown) return;

        // the block lands below the pagination footer (if one is up) and
        // above everything else
        let anchor = container.firstChild;
        if (anchor?.classList?.contains('history-footer')) anchor = anchor.nextSibling;

        // stitch the boundary to whatever is now the first row below the block
        let topChip = null;
        let topRow = null;
        for (let n = anchor; n; n = n.nextSibling) {
            if (!n.classList) continue;
            if (!topChip && n.classList.contains('chat-time')) topChip = n;
            else if (n.classList.contains('msg')) {
                topRow = n;
                break;
            }
        }
        if (topRow?.dataset?.ts) {
            const gap = Number(topRow.dataset.ts) - prevTs;
            if (gap > TIME_GAP_MS) {
                if (!topChip) frag.append(timeChipNode(new Date(Number(topRow.dataset.ts))));
                // else the existing chip already separates the two blocks
            } else if (topChip) {
                topChip.remove();
            }
        }

        if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
        }
        const prevTop = container.scrollTop;
        const prevHeight = container.scrollHeight;
        container.insertBefore(frag, anchor ?? null);
        container.scrollTop = prevTop + (container.scrollHeight - prevHeight);
    }

    /**
     * Pagination status line pinned to the very top of the list:
     * 'loading' while a page is in flight, 'end' once the store ran dry,
     * null to clear.
     */
    function setHistoryFooter(state) {
        if (footerNode) {
            footerNode.remove();
            footerNode = null;
        }
        const text = state === 'loading' ? historyLoadingText : state === 'end' ? historyEndText : '';
        if (!text) return;
        footerNode = el('div', { class: 'msg system history-footer' }, el('div', { class: 'msg-system-text', text }));
        container.prepend(footerNode);
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
        const when = new Date(time);
        const stick = nearBottom();
        maybeTimeChip(when, stick);

        const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(count, 6))}` });
        const progressEl = el('div', { class: 'msg-img-progress', text: imagesProgress(0, count) });
        const bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
        if (text) bubble.append(el('div', { class: 'msg-text', text }));
        bubble.append(progressEl);
        append(buildMessage({ name, self, bubble, ts: when.getTime() }), stick);

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
     *  right edge with the bubble to its left. `ts` tags the row so the
     *  scroll-up pagination can stitch time chips to the existing top. */
    function buildMessage({ name, self, bubble, ts }) {
        const row = el('div', {
            class: 'msg' + (self ? ' self' : ''),
            dataset: { name: name || '?', ...(ts ? { ts: String(ts) } : {}) },
        });
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
    return { add, addHistory, prependHistory, setHistoryFooter, addImage, openBatch, addBatchImage, failBatchImage, setAvatar, renamePeer };
}
