'use strict';

/**
 * Chat history store for the voice-channel edition.
 *
 * Chat itself travels peer-to-peer over WebRTC DataChannels; the sender's
 * page additionally relays every message (text + compressed image data URLs)
 * here so late joiners can catch up. Messages are kept per channel in
 * app/src/chat_history/<id>.json (atomic write on every append — voice-channel
 * traffic is human-scale) and pruned to the admin-configured retention window
 * (channels.json settings: chatRetentionHours, 0 = keep nothing). Temporary
 * rooms keep history in memory only; it vanishes together with the room.
 */

const fs = require('fs');
const path = require('path');

const Logs = require('./logs');

const log = new Logs('chatStore');

// Same id space as the channel registry — ids become filenames, so this check
// doubles as path-traversal protection.
const ID_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

const DATA_URL_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_MESSAGES = 300; // per channel: stored, kept in memory and served
const MAX_IMAGES = 9; // same cap as the client batch protocol
// mirrors the client transfer cap (images.js MAX_TRANSFER_CHARS) — anything
// larger was never deliverable P2P either
const MAX_IMAGE_CHARS = 1600 * 1024;
const NAME_MAX = 24;
const TEXT_MAX = 500;
const REPLY_TEXT_MAX = 80; // quote snippet shown inside the reply bubble
// Disk budget per channel, images included; rows drop from the oldest end
// until a file fits (images dominate — text rows are a few hundred bytes).
const MAX_FILE_BYTES = 12 * 1024 * 1024;
// Catch-up pagination: one page sent per request — on join and per
// scroll-up fetch. The byte budget keeps a single emit under the socket.io
// packet cap (images dominate — the newest row is always included, older
// ones drop first).
const CHAT_PAGE_SIZE = 10;
const MAX_SEND_BYTES = 2 * 1024 * 1024;
// How often background pruning walks the store (in-memory entries + files on
// disk) so messages past the retention window actually disappear even for
// channels nobody touches (e.g. after the admin shortens the window).
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

class ChatStore {
    /**
     * @param {object}   [options]
     * @param {string}   [options.dir]             history directory
     * @param {function|number} [options.retentionHours] live retention window in
     *     hours — a function of the channelId (per-channel override → global
     *     fallback) so admin setting changes apply at once; 0 = keep nothing
     * @param {number}   [options.maxBytes]        per-channel file budget (tests)
     * @param {number}   [options.sweepMs]         background prune interval (0 = off, for tests)
     */
    constructor({ dir = path.join(__dirname, 'chat_history'), retentionHours = 24, maxBytes = MAX_FILE_BYTES, sweepMs = SWEEP_INTERVAL_MS } = {}) {
        this.dir = dir;
        this.maxBytes = maxBytes > 0 ? maxBytes : MAX_FILE_BYTES;
        this.retentionHours = typeof retentionHours === 'function' ? retentionHours : () => retentionHours;
        /** channelId -> { persistent, messages: [{ts,name,text,imgs}] } */
        this.channels = new Map();
        this.sweepTimer = null;
        if (sweepMs > 0) {
            this.sweepTimer = setInterval(() => {
                try {
                    this.sweep();
                } catch (err) {
                    log.error('Chat history sweep failed', { error: err.message });
                }
            }, sweepMs);
            this.sweepTimer.unref?.();
        }
        fs.mkdirSync(this.dir, { recursive: true });
    }

    fileFor(id) {
        return path.join(this.dir, `${id}.json`);
    }

    /** Retention window in ms for a channel (0 = the feature is switched off). */
    retentionMs(id) {
        const hours = Number(this.retentionHours(id));
        return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 0;
    }

    /** Messages holder for a channel (lazy-loads the file for persistent ones). */
    entry(id, { persistent = true } = {}) {
        let entry = this.channels.get(id);
        if (!entry) {
            entry = { persistent, messages: persistent ? this.loadFile(id) : [] };
            this.channels.set(id, entry);
        }
        return entry;
    }

    loadFile(id) {
        const file = this.fileFor(id);
        try {
            if (!fs.existsSync(file)) return [];
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(raw?.messages) ? raw.messages.filter(isPlainMessage) : [];
        } catch (err) {
            // a broken history file must never take the server down — quarantine
            // it (same pattern as the channel registry) and start empty
            try {
                fs.renameSync(file, `${file}.corrupt`);
            } catch {
                /* nothing more we can do */
            }
            log.error('Chat history file unreadable, quarantined', { file, error: err.message });
            return [];
        }
    }

    /**
     * Store one chat message. `imgs` is an array of validated data:image/*
     * URLs (server-side sanitized before this point; re-validated here).
     * `reply` is an optional quote of the answered row ({name, text, ts}).
     * Returns the stored message or null (feature off, invalid id/payload).
     * `ts` override exists for tests.
     */
    append(id, { name, text, imgs = [], reply = null }, { persistent = true, ts = Date.now() } = {}) {
        if (!ID_PATTERN.test(id)) return null;
        if (this.retentionMs(id) <= 0) return null;

        // trim + cap exactly like the client composer (input.trim().slice(500))
        // so a stored message never differs from what was rendered live
        const cleanName = typeof name === 'string' ? name.slice(0, NAME_MAX) : '';
        const cleanText = typeof text === 'string' ? text.trim().slice(0, TEXT_MAX) : '';
        const images = sanitizeImages(imgs);
        if (!cleanText && !images.length) return null;

        const entry = this.entry(id, { persistent });
        const message = { ts, name: cleanName, text: cleanText };
        if (images.length) message.imgs = images; // omitted for text-only rows: keeps files compact
        const cleanReply = sanitizeReply(reply);
        if (cleanReply) message.reply = cleanReply;
        entry.messages.push(message);
        this.prune(entry.messages, Date.now(), id);
        while (entry.messages.length > MAX_MESSAGES) entry.messages.shift();
        if (persistent) this.save(id, entry);
        return message;
    }

    /**
     * One page of kept messages for a joiner / scroll-up fetch, oldest
     * first, inside the payload budget (newest row always included, older
     * ones drop first). `before` (a ts) pages backwards: only rows strictly
     * older are considered. ts is the only cursor and it is not unique, so
     * a page boundary never splits a group sharing one ts — the whole group
     * rides the older page (or this one), otherwise the next page's cursor
     * would skip its remainder for good. `hasMore` says whether the store
     * still holds older rows (rows already shifted off MAX_MESSAGES are
     * gone for good and don't count). Empty when disabled/unknown.
     */
    history(id, { persistent = true, before = 0, limit = CHAT_PAGE_SIZE, maxBytes = MAX_SEND_BYTES } = {}) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return { messages: [], hasMore: false };
        const entry = this.entry(id, { persistent });
        this.prune(entry.messages, Date.now(), id);

        const messages = entry.messages;
        let end = messages.length;
        if (Number.isFinite(before) && before > 0) {
            while (end > 0 && messages[end - 1].ts >= before) end--;
        }
        const count = Number.isFinite(limit) && limit > 0 ? limit : CHAT_PAGE_SIZE;
        const start = Math.max(0, end - count);

        const picked = [];
        let used = 0;
        let i = end - 1;
        for (; i >= start; i--) {
            const size = estimateBytes(messages[i]);
            // the newest row of the page always rides along; older ones drop
            // first once the budget is hit and wait for the next page
            if (picked.length && used + size > maxBytes) break;
            picked.push(messages[i]);
            used += size;
        }
        // heal a cut that landed inside a same-ts group (limit or budget):
        // rows the cursor cannot address individually must ship whole
        while (i >= 0 && messages[i].ts === messages[i + 1]?.ts) {
            picked.push(messages[i]);
            i--;
        }
        const first = end - picked.length;
        return { messages: messages.slice(first, end), hasMore: first > 0 };
    }

    /** Drop rows older than the channel's retention window, in place. */
    prune(messages, now = Date.now(), id = null) {
        // id-less callers (legacy) fall back to the resolver without an argument
        const retention = this.retentionMs(id);
        if (retention <= 0) {
            messages.length = 0;
            return;
        }
        const cutoff = now - retention;
        let drop = 0;
        while (drop < messages.length && messages[drop].ts <= cutoff) drop++;
        if (drop > 0) messages.splice(0, drop);
    }

    /**
     * Full kept history of a channel, oldest first, unpaged (host export).
     * Prunes first, so expired rows never land in an export.
     */
    exportAll(id) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return [];
        const entry = this.entry(id, { persistent: true });
        this.prune(entry.messages, Date.now(), id);
        return entry.messages.map((m) => ({ ...m }));
    }

    /** Atomic write (tmp + rename; content copy for single-file bind mounts). */
    save(id, entry) {
        try {
            if (!entry.messages.length) {
                try {
                    fs.unlinkSync(this.fileFor(id));
                } catch {
                    /* already gone */
                }
                return;
            }
            // shrink from the oldest end until the file fits its disk budget
            let data = JSON.stringify({ version: 1, messages: entry.messages });
            while (data.length > this.maxBytes && entry.messages.length > 1) {
                entry.messages.shift();
                data = JSON.stringify({ version: 1, messages: entry.messages });
            }
            const file = this.fileFor(id);
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, data, 'utf8');
            try {
                fs.renameSync(tmp, file);
            } catch (err) {
                // Docker bind-mounts channels.json-style single files: rename()
                // cannot replace a mount point, copy the payload over instead
                if (!['EBUSY', 'EXDEV', 'EPERM'].includes(err.code)) throw err;
                fs.copyFileSync(tmp, file);
                fs.unlinkSync(tmp);
            }
        } catch (err) {
            log.error('Chat history save failed', { channel: id, error: err.message });
        }
    }

    /** Forget a channel entirely (room destroyed / admin delete). */
    removeChannel(id) {
        if (typeof id !== 'string' || !id) return;
        this.channels.delete(id);
        try {
            fs.unlinkSync(this.fileFor(id));
        } catch (err) {
            if (err.code !== 'ENOENT') log.warn('Chat history removal failed', { channel: id, error: err.message });
        }
    }

    /**
     * Background pass: prune every in-memory channel and every file on disk
     * (covers channels nobody touched since the retention window shrank),
     * deleting whatever ends up empty. With the feature disabled it wipes all
     * history.
     */
    sweep(now = Date.now()) {
        for (const [id, entry] of [...this.channels]) {
            if (this.retentionMs(id) <= 0) {
                // this channel's own override switches it off — drop it entirely
                if (entry.persistent) this.removeChannel(id);
                else this.channels.delete(id);
                continue;
            }
            const before = entry.messages.length;
            this.prune(entry.messages, now, id);
            if (entry.messages.length === before) continue;
            if (entry.persistent) this.save(id, entry);
            else if (!entry.messages.length) this.channels.delete(id);
        }
        for (const id of this.listFiles()) {
            if (this.channels.has(id)) continue;
            if (this.retentionMs(id) <= 0) {
                this.removeChannel(id); // per-channel override disabled it
                continue;
            }
            const messages = this.loadFile(id);
            this.prune(messages, now, id);
            this.save(id, { persistent: true, messages });
        }
    }

    listFiles() {
        try {
            return fs
                .readdirSync(this.dir)
                .filter((name) => name.endsWith('.json'))
                .map((name) => name.slice(0, -'.json'.length))
                .filter((id) => ID_PATTERN.test(id));
        } catch {
            return [];
        }
    }

    destroy() {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
    }
}

function isPlainMessage(m) {
    return (
        m &&
        typeof m === 'object' &&
        !Array.isArray(m) &&
        Number.isFinite(m.ts) &&
        typeof m.name === 'string' &&
        typeof m.text === 'string' &&
        (m.reply === undefined || isPlainReply(m.reply)) &&
        (m.imgs === undefined ||
            // legacy rows (≤ voice.21) kept the image COUNT only — accepted on
            // load so an upgrade never drops earlier history; the client shows
            // them as a "[image×N]" placeholder (the data itself never existed)
            Number.isInteger(m.imgs) ||
            (Array.isArray(m.imgs) && m.imgs.every((s) => typeof s === 'string')))
    );
}

/** Reply quote of an answered row — same caps as the live chat event. */
function isPlainReply(reply) {
    return (
        reply &&
        typeof reply === 'object' &&
        !Array.isArray(reply) &&
        typeof reply.name === 'string' &&
        typeof reply.text === 'string' &&
        Number.isFinite(reply.ts)
    );
}

/** Normalize an incoming reply payload for storage; null = drop it. */
function sanitizeReply(reply) {
    if (!isPlainReply(reply)) return null;
    return { name: reply.name.slice(0, NAME_MAX), text: reply.text.slice(0, REPLY_TEXT_MAX), ts: reply.ts };
}

/** Keep only whitelisted, size-capped data:image/* URLs, at most MAX_IMAGES. */
function sanitizeImages(input) {
    const images = [];
    if (!Array.isArray(input)) return images;
    for (const item of input) {
        if (images.length >= MAX_IMAGES) break;
        if (typeof item === 'string' && item.length > 0 && item.length <= MAX_IMAGE_CHARS && DATA_URL_RE.test(item)) {
            images.push(item);
        }
    }
    return images;
}

/** Rough serialized size of one row — good enough for the send budget. */
function estimateBytes(message) {
    let size = 80 + (message.name?.length || 0) + (message.text?.length || 0);
    if (Array.isArray(message.imgs)) for (const img of message.imgs) size += img.length + 8;
    return size;
}

module.exports = ChatStore;
module.exports.MAX_MESSAGES = MAX_MESSAGES;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;
module.exports.MAX_SEND_BYTES = MAX_SEND_BYTES;
module.exports.CHAT_PAGE_SIZE = CHAT_PAGE_SIZE;
module.exports.SWEEP_INTERVAL_MS = SWEEP_INTERVAL_MS;
