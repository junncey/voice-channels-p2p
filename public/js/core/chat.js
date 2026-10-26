/**
 * Chat message list — QQ-style bubbles (avatar beside a tailed bubble,
 * nickname above the bubble for others, centered time separators).
 * Plain text only (textContent everywhere, no HTML injection; image/avatar
 * sources must be validated data:image URLs — we never interpolate HTML).
 *
 * Message lifecycle after delivery (edit / recall / emoji reaction) is applied
 * in place by editMessage/deleteMessage/reactMessage — the server broadcasts
 * the persisted result to everyone including the sender, so the DOM follows
 * the store instead of trusting local echo.
 */

import { el, formatTime, formatDate, avatarColor } from './utils.js';
import { DATA_URL_RE, MAX_TRANSFER_CHARS } from './images.js';
import { isEmojiOnly, openEmojiPicker } from './emoji.js';

/** Show a time separator when the gap to the previous message exceeds this. */
const TIME_GAP_MS = 5 * 60 * 1000;

// mirrors the server-side persisted-image cap — reject anything bigger on render
const MAX_IMAGE_CHARS = MAX_TRANSFER_CHARS;

/** Escape a member name for the mention RegExp. */
export function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reply quote from a message payload, shape-checked and capped before
 * rendering/storing — shared with the channel page's history and live paths.
 */
export function validReply(reply) {
    if (
        !reply ||
        typeof reply !== 'object' ||
        typeof reply.name !== 'string' ||
        typeof reply.text !== 'string' ||
        !Number.isFinite(reply.ts)
    ) {
        return null;
    }
    return { name: reply.name.slice(0, 24), text: reply.text.slice(0, 80), ts: reply.ts };
}

/**
 * @param {HTMLElement} container scrollable message list
 * @param {object} [options]
 * @param {string}  [options.emptyText] placeholder shown when the list is empty * @param {string}  [options.downloadText] lightbox save-image button label
 * @param {string}  [options.yesterdayText] time-separator label for yesterday
 * @param {string}  [options.todayText] day separator label for today
 * @param {function(Date): string} [options.dayText] day separator label (older days)
 * @param {string}  [options.deletedText] tombstone text for recalled messages
 * @param {string}  [options.editedText] "(edited)" marker
 * @param {function(string):string} [options.avatarFor] name -> custom avatar data URL ('' = none)
 * @param {function(number, number):string} [options.imagesProgress] (got, total) -> progress label
 * @param {string}  [options.failText] note when every image of a batch failed
 * @param {string}  [options.historyLoadingText] scroll-up pagination loading line
 * @param {string}  [options.historyEndText] scroll-up pagination end-of-history line
 * @param {function(): string[]} [options.mentionNames] live member names for @highlighting
 * @param {function(): string} [options.selfName] the local user's display name
 * @param {function(): boolean} [options.isHost] presenter rights (recall anyone's message)
 * @param {function(object): void} [options.onReply] ({name, text, ts}) — reply button clicked
 * @param {function(object): void} [options.onEdit] ({name, text, ts}) — edit button clicked
 * @param {function(object): void} [options.onDelete] ({name, ts}) — recall button clicked
 * @param {function(object): void} [options.onReact] ({name, ts, emoji, on}) — reaction toggled
 * @param {function(number): string} [options.jumpNewText] (n) -> "n new messages" pill label
 * @param {string}  [options.jumpText] back-to-bottom pill label
 */
export function initChat(
    container,
    {
        emptyText = '',
        downloadText = 'Save',
        yesterdayText = '昨天',
        todayText = '今天',
        dayText = null,
        deletedText = '',
        editedText = '',
        avatarFor = null,
        imagesProgress = (got, total) => `${got}/${total}`,
        failText = '',
        historyLoadingText = '',
        historyEndText = '',
        mentionNames = () => [],
        selfName = () => '',
        isHost = () => false,
        onReply = null,
        onEdit = null,
        onDelete = null,
        onReact = null,
        jumpNewText = (n) => `${n}`,
        jumpText = '↓',
    } = {}
) {
    let emptyNode = null;
    let lastTime = null;
    let lastDay = null; // toDateString() of the last rendered message's day
    let footerNode = null; // scroll-up pagination status line pinned to the top
    /** batchId -> { imagesEl, progressEl, textEl, expected, done } */
    const batches = new Map();
    /** own rows awaiting the server's authoritative ts (FIFO, see bindServerTs) */
    const pendingOwn = [];
    /** an own row whose ack never arrived must not swallow a later ack */
    const PENDING_ACK_TTL_MS = 10_000;

    // ----- back-to-bottom pill (also counts messages that arrived below the fold) -----
    let jumpPill = null;
    let newBelow = 0;

    function nearBottom() {
        return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    }

    function scrollBottom() {
        container.scrollTop = container.scrollHeight;
    }

    function updateJumpPill() {
        if (nearBottom()) {
            newBelow = 0;
            if (jumpPill) jumpPill.classList.add('hidden');
            return;
        }
        if (!jumpPill) {
            jumpPill = el(
                'button',
                {
                    class: 'chat-jump hidden',
                    type: 'button',
                    onclick: () => {
                        scrollBottom();
                        updateJumpPill();
                    },
                },
                el('span', { class: 'chat-jump-label' })
            );
            // the composer follows the list in the DOM — hosting the pill there
            // keeps it anchored above the input regardless of the composer height
            (container.nextElementSibling || container.parentElement).append(jumpPill);
        }
        jumpPill.classList.remove('hidden');
        jumpPill.firstChild.textContent = newBelow > 0 ? jumpNewText(newBelow) : jumpText;
    }

    container.addEventListener('scroll', updateJumpPill, { passive: true });

    function showEmpty() {
        if (!emptyText || emptyNode) return;
        emptyNode = el('div', { class: 'chat-empty', text: emptyText });
        container.append(emptyNode);
    }

    function dayLabel(date) {
        const now = new Date();
        if (date.toDateString() === now.toDateString()) return todayText;
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (date.toDateString() === yesterday.toDateString()) return yesterdayText;
        if (dayText) return dayText(date);
        const y = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}-`;
        return `${y}${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function timeChipText(d) {
        const now = new Date();
        if (d.toDateString() === now.toDateString()) return formatTime(d);
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return `${yesterdayText} ${formatTime(d)}`;
        return d.getFullYear() === now.getFullYear() ? formatDate(d) : `${d.getFullYear()}/${formatDate(d)}`;
    }

    /**
     * Time chip between messages, upgraded to a full-day separator whenever
     * the calendar day changes (always inserted then, regardless of the gap).
     */
    function maybeTimeChip(time, stick) {
        const day = time.toDateString();
        if (day !== lastDay) {
            append(el('div', { class: 'chat-time day', text: dayLabel(time) }), stick, true);
            lastDay = day;
            lastTime = time.getTime();
            return;
        }
        const ts = time.getTime();
        if (lastTime !== null && ts - lastTime <= TIME_GAP_MS) {
            lastTime = Math.max(lastTime, ts);
            return;
        }
        append(el('div', { class: 'chat-time', text: timeChipText(time) }), stick, true);
        lastTime = ts;
    }
    /**
     * @param {object} msg
     * @param {string} msg.name
     * @param {string} msg.text
     * @param {boolean} [msg.self]
     * @param {boolean} [msg.system]
     * @param {Date} [msg.time]
     * @param {object} [msg.reply] {name, text, ts} quote of the answered row
     * @param {boolean} [msg.deleted] render as a recall tombstone
     * @param {boolean} [msg.edited] show the "(edited)" marker
     * @param {object|null} [msg.reactions] emoji -> [reactor names]
     */
    function add({
        name,
        text,
        self = false,
        system = false,
        time = new Date(),
        reply = null,
        deleted = false,
        edited = false,
        reactions = null,
    }) {
        if (!text && !deleted) return;
        const stick = nearBottom();
        maybeTimeChip(new Date(time), stick);

        if (system) {
            append(el('div', { class: 'msg system' }, el('div', { class: 'msg-system-text', text })), stick);
            return;
        }
        const row = buildMessage({
            name,
            self,
            bubble: deleted ? tombstoneBubble() : textBubble(text, edited),
            ts: time.getTime(),
            reply,
            text: deleted ? '' : text,
            deleted,
            reactions,
        });
        append(row, stick);
        // the server assigns the authoritative ts; chatAck binds it back to the
        // row we just rendered (edit/recall/reaction look rows up by ts+name)
        if (self && !deleted) rememberPending(row);
    }

    /** Queue a locally rendered own row until the server's chatAck lands. */
    function rememberPending(row) {
        if (!row || !row.dataset?.ts) return;
        pendingOwn.push({ row, at: Date.now() });
        if (pendingOwn.length > 20) pendingOwn.shift();
    }

    /**
     * Bind the server-assigned ts to the oldest still-pending own row. Called
     * on every chatAck; a row removed by a channel switch is skipped.
     */
    function bindServerTs(ts) {
        const value = Number(ts);
        if (!Number.isFinite(value) || value <= 0) return;
        const now = Date.now();
        while (pendingOwn.length) {
            const { row, at } = pendingOwn.shift();
            if (!row.isConnected) continue;
            // no ack ever comes for a message the server dropped (flood limit,
            // rejected payload) — letting such an entry sit at the head would
            // hand every later ack to the wrong row, so edit/recall would hit
            // an unrelated line. Expire it and let this ack go unbound instead.
            if (now - at > PENDING_ACK_TTL_MS) continue;
            row.dataset.ts = String(value);
            // the hover actions captured the old ts in their click closures —
            // rebuild them so edit/recall use the server-side identity
            refreshRowActions(row);
            return;
        }
    }

    /** Greyed-out body of a recalled message. */
    function tombstoneBubble() {
        return el(
            'div',
            { class: 'msg-bubble deleted' },
            el('div', { class: 'msg-text tombstone', text: deletedText })
        );
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
            if (!text && !images.length && !msg.deleted) continue;

            if (images.length) {
                const stick = nearBottom();
                maybeTimeChip(time, stick);
                const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(images.length, 6))}` });
                for (const src of images) imagesEl.append(imageNode(src, imageAlt));
                const bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
                if (text) bubble.append(textNode(text, !!msg.edited));
                append(
                    buildMessage({
                        name: msg.name,
                        self: !!msg.self,
                        bubble,
                        ts: time.getTime(),
                        reply: validReply(msg.reply),
                        text,
                        deleted: !!msg.deleted,
                        reactions: validReactions(msg.reactions),
                    }),
                    stick
                );
            } else {
                add({
                    name: msg.name,
                    text,
                    self: !!msg.self,
                    time,
                    reply: validReply(msg.reply),
                    deleted: !!msg.deleted,
                    edited: !!msg.edited,
                    reactions: validReactions(msg.reactions),
                });
            }
            shown++;
        }
        if (shown && dividerText) add({ text: dividerText, system: true });
    }

    /** Plain-text bubble with @mention highlighting (+ edited marker). */
    function textBubble(text, edited = false) {
        const bubble = el('div', { class: 'msg-bubble' }, textNode(text, edited));
        // the edited marker rides inside .msg-text and would blow up with the
        // jumbo glyph, so edited messages keep the regular bubble
        if (!edited && isEmojiOnly(text)) bubble.classList.add('emoji-only');
        return bubble;
    }

    function textNode(text, edited) {
        const node = el('div', { class: 'msg-text' }, ...mentionSegments(text));
        if (edited) node.append(el('span', { class: 'msg-edited', text: editedText }));
        return node;
    }

    /**
     * Split a text into nodes, highlighting `@name` occurrences of live
     * members (own name gets a stronger style). Plain text nodes only —
     * no HTML is ever interpolated.
     */
    function mentionSegments(text) {
        const names = [...new Set(mentionNames().filter(Boolean))];
        const me = selfName();
        if (!names.length || !text.includes('@')) return [text];
        const pattern = new RegExp(`(@(?:${names.map(escapeRegExp).join('|')}))(?![\\p{L}\\p{N}_])`, 'gu');
        const out = [];
        let last = 0;
        for (const match of text.matchAll(pattern)) {
            const at = match.index;
            if (at > last) out.push(text.slice(last, at));
            const name = match[1].slice(1);
            out.push(el('span', { class: 'mention' + (name === me ? ' self' : ''), text: match[1] }));
            last = at + match[1].length;
        }
        if (last < text.length) out.push(text.slice(last));
        return out.length ? out : [text];
    }

    /** Persisted image URLs, re-validated before touching the DOM. */
    function validImages(imgs) {
        return (Array.isArray(imgs) ? imgs : [])
            .filter(
                (src) =>
                    typeof src === 'string' && src.length > 0 && src.length <= MAX_IMAGE_CHARS && DATA_URL_RE.test(src)
            )
            .slice(0, 9);
    }

    /** Reactions map from a message payload, shape-checked before rendering. */
    function validReactions(reactions) {
        if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return null;
        const out = {};
        for (const [emoji, names] of Object.entries(reactions)) {
            if (typeof emoji !== 'string' || emoji.length > 16) continue;
            if (Array.isArray(names)) out[emoji] = names.filter((n) => typeof n === 'string').slice(0, 50);
        }
        return Object.keys(out).length ? out : null;
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
        let prevDay = null;
        let shown = 0;
        for (const msg of Array.isArray(messages) ? messages : []) {
            if (!msg || typeof msg !== 'object') continue;
            const time = msg.time instanceof Date && !isNaN(msg.time) ? msg.time : new Date();
            const ts = time.getTime();
            const day = time.toDateString();
            const text = typeof msg.text === 'string' ? msg.text : '';
            const images = validImages(msg.imgs);
            if (!text && !images.length && !msg.deleted) continue;

            if (prevDay !== day) {
                frag.append(el('div', { class: 'chat-time day', text: dayLabel(time) }));
                prevDay = day;
            } else if (prevTs === null || ts - prevTs > TIME_GAP_MS) {
                frag.append(timeChipNode(time));
            }
            let bubble;
            if (msg.deleted) {
                bubble = tombstoneBubble();
            } else if (images.length) {
                const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(images.length, 6))}` });
                for (const src of images) imagesEl.append(imageNode(src, imageAlt));
                bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
                if (text) bubble.append(textNode(text, !!msg.edited));
            } else {
                bubble = textBubble(text, !!msg.edited);
            }
            frag.append(
                buildMessage({
                    name: msg.name,
                    self: !!msg.self,
                    bubble,
                    ts,
                    reply: validReply(msg.reply),
                    text: msg.deleted ? '' : text,
                    deleted: !!msg.deleted,
                    reactions: validReactions(msg.reactions),
                })
            );
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
            const topDate = new Date(Number(topRow.dataset.ts));
            const newDay = topDate.toDateString() !== prevDay;
            const gap = Number(topRow.dataset.ts) - prevTs;
            if (newDay) {
                // calendar-day boundary always separates — as a day line
                if (topChip) topChip.replaceWith(el('div', { class: 'chat-time day', text: dayLabel(topDate) }));
                else frag.append(el('div', { class: 'chat-time day', text: dayLabel(topDate) }));
            } else if (gap > TIME_GAP_MS) {
                if (!topChip) frag.append(timeChipNode(topDate));
                // else the existing chip already separates the two blocks
            } else if (topChip) {
                // the boundary chip may itself be the insert anchor (first
                // child of the list) — re-point the anchor before dropping it
                if (topChip === anchor) anchor = topChip.nextSibling;
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
    function openBatch({ batch, name, text = '', count = 1, self = false, time = new Date(), reply = null }) {
        if (!batch) return;
        const when = new Date(time);
        const stick = nearBottom();
        maybeTimeChip(when, stick);

        const imagesEl = el('div', { class: `msg-images c${Math.max(1, Math.min(count, 6))}` });
        const progressEl = el('div', { class: 'msg-img-progress', text: imagesProgress(0, count) });
        const bubble = el('div', { class: 'msg-bubble img' }, imagesEl);
        if (text) bubble.append(textNode(text, false));
        bubble.append(progressEl);
        const row = buildMessage({ name, self, bubble, ts: when.getTime(), reply: validReply(reply), text });
        append(row, stick);
        if (self) rememberPending(row); // chatAck after the batch is stored

        batches.set(batch, {
            row: container.lastChild,
            imagesEl,
            progressEl,
            bubble,
            expected: count,
            done: 0,
            failed: 0,
        });
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
            if (stick) scrollBottom();
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

    /** Find a rendered row by ts + sender name (the message identity). */
    function findRow(name, ts) {
        if (!name || !Number.isFinite(ts)) return null;
        for (const child of [...container.children].reverse()) {
            if (child.classList?.contains('msg') && child.dataset?.ts === String(ts) && child.dataset?.name === name) {
                return child;
            }
        }
        return null;
    }

    // ----- live message lifecycle (server-broadcast results) -----

    /** Apply an edit broadcast: new text + the edited marker. */
    function editMessage({ name, ts, text }) {
        const row = findRow(name, ts);
        if (!row || typeof text !== 'string') return;
        row._deleted = false;
        row.dataset.text = text;
        const bubble = row.querySelector('.msg-bubble');
        if (!bubble) return;
        const quote = row.querySelector('.msg-quote');
        const imgs = row.querySelector('.msg-images');
        // edited rows carry the "(edited)" marker — always back to a regular
        // bubble, never the jumbo emoji treatment
        bubble.classList.remove('emoji-only');
        bubble.replaceChildren();
        if (quote) bubble.append(quote);
        if (imgs) bubble.append(imgs);
        bubble.append(textNode(text, true));
        refreshRowActions(row);
    }

    /** Apply a recall broadcast: the row becomes a tombstone. */
    function deleteMessage({ name, ts }) {
        const row = findRow(name, ts);
        if (!row) return;
        row._deleted = true;
        row.dataset.text = '';
        row.classList.add('recalled');
        const bubble = row.querySelector('.msg-bubble');
        if (bubble) {
            // the tombstone must not inherit the jumbo emoji sizing
            bubble.classList.remove('emoji-only');
            bubble.replaceChildren(el('div', { class: 'msg-text tombstone', text: deletedText }));
        }
        row.querySelector('.msg-reactions')?.remove();
        row.querySelector('.msg-actions')?.remove();
    }

    /** Apply a reaction broadcast: re-render the reaction bar from the map. */
    function reactMessage({ name, ts, reactions }) {
        const row = findRow(name, ts);
        if (!row || row._deleted) return;
        row.querySelector('.msg-reactions')?.remove();
        const map = validReactions(reactions);
        row._reactions = map || undefined;
        if (!map) return;
        row.querySelector('.msg-body')?.append(reactionsNode(row, map));
    }

    /** Reaction chips under a bubble; clicking toggles the local user's entry. */
    function reactionsNode(row, map) {
        const me = selfName();
        const wrap = el('div', { class: 'msg-reactions' });
        for (const [emoji, names] of Object.entries(map)) {
            const mine = names.includes(me);
            const chip = el(
                'button',
                {
                    class: 'msg-reaction' + (mine ? ' mine' : ''),
                    type: 'button',
                    title: names.slice(0, 6).join(', '),
                },
                emoji,
                names.length > 1 ? el('span', { class: 'msg-reaction-count', text: String(names.length) }) : null
            );
            chip.addEventListener('click', (event) => {
                event.stopPropagation();
                onReact?.({ name: row.dataset.name, ts: Number(row.dataset.ts), emoji, on: !mine });
            });
            wrap.append(chip);
        }
        return wrap;
    }

    /** Rebuild a row's hover action buttons after a state change. */
    function refreshRowActions(row) {
        row.querySelector('.msg-actions')?.remove();
        const actions = rowActionsNode(row);
        if (actions) row.append(actions);
    }

    /** The hover action cluster: reply / react / edit / recall. */
    function rowActionsNode(row) {
        if (!onReply && !onReact && !onEdit && !onDelete) return null;
        const name = row.dataset.name || '?';
        const ts = Number(row.dataset.ts) || 0;
        const mine = name === selfName();
        const host = isHost();
        const buttons = [];
        if (onReply) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn',
                        type: 'button',
                        'aria-label': 'reply',
                        title: 'reply',
                        onclick: (event) => {
                            event.stopPropagation();
                            onReply({ name, text: row.dataset.text || '', ts });
                        },
                    },
                    '↩'
                )
            );
        }
        if (onReact && !row._deleted) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn',
                        type: 'button',
                        'aria-label': 'react',
                        title: 'react',
                        onclick: (event) => {
                            event.stopPropagation();
                            openEmojiPicker(event.currentTarget, (emoji) =>
                                onReact({ name, ts, emoji, on: !(row._reactions?.[emoji] || []).includes(selfName()) })
                            );
                        },
                    },
                    '😊'
                )
            );
        }
        if (onEdit && mine && !row._deleted && row.dataset.text) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn',
                        type: 'button',
                        'aria-label': 'edit',
                        title: 'edit',
                        onclick: (event) => {
                            event.stopPropagation();
                            onEdit({ name, text: row.dataset.text, ts });
                        },
                    },
                    '✎'
                )
            );
        }
        if (onDelete && !row._deleted && (mine || host)) {
            buttons.push(
                el(
                    'button',
                    {
                        class: 'msg-action-btn danger',
                        type: 'button',
                        'aria-label': 'recall',
                        title: 'recall',
                        onclick: (event) => {
                            event.stopPropagation();
                            onDelete({ name, ts });
                        },
                    },
                    '🗑'
                )
            );
        }
        if (!buttons.length) return null;
        return el('div', { class: 'msg-actions' }, ...buttons);
    }

    /** One QQ-style row: avatar beside a body of [nickname] + bubble.
     *  DOM order is [avatar, body] for BOTH sides — .msg.self's
     *  flex-direction: row-reverse flips it so the avatar lands on the
     *  right edge with the bubble to its left. `ts` tags the row so the
     *  scroll-up pagination can stitch time chips to the existing top.
     *  A reply quote (when present) rides at the top of the bubble, hover
     *  buttons expose reply/react/edit/recall, and a reaction bar renders
     *  under the bubble when the row carries reactions. */
    function buildMessage({ name, self, bubble, ts, reply = null, text = '', deleted = false, reactions = null }) {
        const row = el('div', {
            class: 'msg' + (self ? ' self' : '') + (deleted ? ' recalled' : ''),
            dataset: { name: name || '?', ...(ts ? { ts: String(ts) } : {}), ...(text ? { text } : {}) },
        });
        row._deleted = deleted;
        row._reactions = reactions || undefined;
        if (reply) {
            bubble.prepend(quoteNode(reply));
            // a quoted reply keeps the bubble chrome — jumbo glyphs would
            // dwarf the quote and leave it floating without a container
            bubble.classList.remove('emoji-only');
        }
        const body = el('div', { class: 'msg-body' });
        if (!self && name) body.append(el('div', { class: 'msg-name', text: name }));
        body.append(bubble);
        if (reactions) body.append(reactionsNode(row, reactions));
        row.append(avatarNode(name), body);
        const actions = rowActionsNode(row);
        if (actions) row.append(actions);
        return row;
    }

    /** Quoted row inside a reply bubble — click scrolls to the original. */
    function quoteNode(reply) {
        const node = el(
            'div',
            { class: 'msg-quote' },
            el('span', { class: 'msg-quote-name', text: reply.name || '?' }),
            el('span', { class: 'msg-quote-text', text: reply.text || '' })
        );
        if (reply.ts) {
            node.addEventListener('click', () => {
                const target = findRow(reply.name, reply.ts);
                if (!target) return;
                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                target.classList.add('flash');
                setTimeout(() => target.classList.remove('flash'), 1200);
            });
        }
        return node;
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

    // ----- client-side search over the rendered rows (loaded pages only) -----

    /**
     * Filter the rendered list by a query (matches sender name and text).
     * '' / null clears the filter. Returns { total, hits } for the caller's
     * counter, or null when the filter was cleared.
     */
    function setSearch(query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) {
            container.classList.remove('searching');
            for (const child of container.children) child.classList.remove('hit', 'miss');
            return null;
        }
        container.classList.add('searching');
        let total = 0;
        let hits = 0;
        for (const child of container.children) {
            if (!child.classList?.contains('msg') || child.classList.contains('system')) {
                child.classList.add('miss');
                child.classList.remove('hit');
                continue;
            }
            total++;
            const name = (child.dataset?.name || '').toLowerCase();
            const text = (child.dataset?.text || '').toLowerCase();
            const match = name.includes(q) || text.includes(q);
            child.classList.toggle('hit', match);
            child.classList.toggle('miss', !match);
            if (match) hits++;
        }
        return { total, hits };
    }

    function append(node, stick, isChip = false) {
        if (emptyNode) {
            emptyNode.remove();
            emptyNode = null;
        }
        container.append(node);
        if (stick) scrollBottom();
        else if (!isChip && node.classList?.contains('msg')) newBelow = newBelow + 1;
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
        updateJumpPill(); // shows/hides the pill without a scroll event
    }

    // ----- lightbox (click an image to view it full size) -----

    let lightbox = null;

    function openLightbox(src, alt) {
        closeLightbox();
        const img = el('img', { alt });
        img.src = src;
        const download = el('a', { class: 'btn ghost sm', download: alt || 'image', href: src, text: downloadText });
        download.setAttribute('download', alt || 'image');
        lightbox = el(
            'div',
            { class: 'lightbox', onclick: () => closeLightbox() },
            el('div', { class: 'lightbox-bar', onclick: (e) => e.stopPropagation() }, download),
            img
        );
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
    return {
        add,
        addHistory,
        prependHistory,
        setHistoryFooter,
        addImage,
        openBatch,
        addBatchImage,
        failBatchImage,
        setAvatar,
        renamePeer,
        editMessage,
        deleteMessage,
        reactMessage,
        bindServerTs,
        setSearch,
    };
}
