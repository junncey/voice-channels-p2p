'use strict';

/**
 * Chat history store for the voice-channel edition.
 *
 * Chat itself travels peer-to-peer over WebRTC DataChannels; the sender's
 * page additionally relays every message (text + compressed image data URLs)
 * here so late joiners can catch up. Messages are kept per channel as
 * append-only JSONL in app/src/chat_history/<id>.jsonl — one appendSync per
 * message instead of a full-file rewrite (a channel may hold up to 12MB of
 * image history) — and pruned to the admin-configured retention window
 * (channels.json settings: chatRetentionHours, 0 = keep nothing). Full
 * rewrites only happen on retention/cap drops, edits/recalls/reactions and
 * background compaction. Legacy <id>.json files (single JSON array) are
 * migrated to JSONL on first load. Temporary rooms keep history in memory
 * only; it vanishes together with the room.
 */

const fs = require('fs');
const path = require('path');

const Logs = require('./logs');
const limits = require('./limits');

const log = new Logs('chatStore');

// Same id space as the channel registry — ids become filenames, so this check
// doubles as path-traversal protection.
const { CHANNEL_ID_RE: ID_PATTERN } = limits;

const { IMAGE_DATA_URL_RE: DATA_URL_RE } = limits;
const MAX_MESSAGES = 300; // per channel: stored, kept in memory and served
const MAX_IMAGES = 9; // same cap as the client batch protocol
const MAX_IMAGE_CHARS = limits.IMAGE_MAX_CHARS;
const NAME_MAX = limits.PEER_NAME_MAX;
const TEXT_MAX = limits.CHAT_TEXT_MAX;
const REPLY_TEXT_MAX = limits.REPLY_TEXT_MAX; // quote snippet shown inside the reply bubble
// reaction caps: distinct emoji per message, reactor names per emoji, and the
// emoji string itself (some emoji carry several code points + modifiers)
const REACTIONS_MAX_EMOJI = 8;
const REACTIONS_MAX_NAMES = 50;
const REACTION_EMOJI_MAX = limits.REACTION_EMOJI_MAX;
// Disk budget per channel, images included; rows drop from the oldest end
// until a file fits (images dominate — text rows are a few hundred bytes).
// Append-mode stops at 90% of the budget so compaction runs before it is
// actually needed.
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const COMPACT_AT_RATIO = 0.9;
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
    constructor({
        dir = path.join(__dirname, 'chat_history'),
        retentionHours = 24,
        maxBytes = MAX_FILE_BYTES,
        sweepMs = SWEEP_INTERVAL_MS,
    } = {}) {
        this.dir = dir;
        this.maxBytes = maxBytes > 0 ? maxBytes : MAX_FILE_BYTES;
        this.retentionHours = typeof retentionHours === 'function' ? retentionHours : () => retentionHours;
        /** channelId -> { persistent, messages: [{ts,name,text,...}], fileSize } */
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

    /** Canonical (JSONL) history file of a channel. */
    fileFor(id) {
        return path.join(this.dir, `${id}.jsonl`);
    }

    /** Pre-JSONL history file of a channel (migrated away on first load). */
    legacyFileFor(id) {
        return path.join(this.dir, `${id}.json`);
    }

    /**
     * The file that actually holds this channel's history on disk right now
     * (JSONL after migration, legacy JSON before it). Used by the backup
     * download so the archive always reflects the real on-disk layout.
     */
    existingFileFor(id) {
        const jsonl = this.fileFor(id);
        if (fs.existsSync(jsonl)) return jsonl;
        const legacy = this.legacyFileFor(id);
        return fs.existsSync(legacy) ? legacy : jsonl;
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
            entry = { persistent, messages: persistent ? this.loadFile(id) : [], fileSize: null };
            if (persistent && entry.messages) {
                try {
                    entry.fileSize = fs.existsSync(this.fileFor(id)) ? fs.statSync(this.fileFor(id)).size : 0;
                } catch {
                    entry.fileSize = 0;
                }
            }
            this.channels.set(id, entry);
        }
        return entry;
    }

    loadFile(id) {
        const file = this.fileFor(id);
        try {
            if (fs.existsSync(file)) return this.loadJsonlFile(file);
        } catch (err) {
            log.error('Chat history file unreadable', { file, error: err.message });
            return [];
        }
        // no JSONL yet — migrate a legacy <id>.json on first touch
        const legacy = this.legacyFileFor(id);
        if (!fs.existsSync(legacy)) return [];
        let messages;
        try {
            const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
            messages = Array.isArray(raw?.messages) ? raw.messages.filter(isPlainMessage) : [];
        } catch (err) {
            // a broken history file must never take the server down — quarantine
            // it (same pattern as the channel registry) and start empty
            try {
                fs.renameSync(legacy, `${legacy}.corrupt`);
            } catch {
                /* nothing more we can do */
            }
            log.error('Chat history file unreadable, quarantined', { file: legacy, error: err.message });
            return [];
        }
        if (messages.length) {
            try {
                this.writeFile(id, messages);
            } catch (err) {
                // the JSONL could not be written; serve the parsed rows anyway —
                // the legacy file is untouched, so the next boot retries the
                // migration instead of the session starting from an empty view
                log.warn('Chat history migration could not write JSONL, serving parsed rows', {
                    channel: id,
                    error: err.message,
                });
                return messages;
            }
        }
        try {
            fs.unlinkSync(legacy);
        } catch (err) {
            // Windows/AV can hold the just-read file briefly (EBUSY): the JSONL
            // is already authoritative, so a leftover legacy file beats
            // quarantining a GOOD history. The next load prefers the JSONL.
            log.warn('Legacy chat history file not removed after migration', { channel: id, error: err.message });
        }
        log.info('Chat history migrated to JSONL', { channel: id, messages: messages.length });
        return messages;
    }

    /**
     * Parse a JSONL history file line by line. A torn trailing line (crash
     * mid-append) is normal for append-only logs and is skipped silently;
     * lines that still fail to parse are skipped with a warn. A file where
     * EVERY line is garbage yields an empty history.
     */
    loadJsonlFile(file) {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return [];
        const lines = raw.split('\n');
        const messages = [];
        let bad = 0;
        for (const line of lines) {
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                if (isPlainMessage(msg)) messages.push(msg);
                else bad++;
            } catch {
                bad++;
            }
        }
        if (bad && !messages.length) {
            // completely garbled (not just a torn tail) — quarantine for inspection
            try {
                fs.renameSync(file, `${file}.corrupt`);
            } catch {
                /* keep going with what we parsed */
            }
            log.warn('Chat history file fully unparsable, quarantined', { file, bad_lines: bad });
            return [];
        }
        if (bad) log.warn('Chat history file had unparsable lines', { file, bad_lines: bad, kept: messages.length });
        return messages;
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
        const before = entry.messages.length;
        this.prune(entry.messages, Date.now(), id);
        while (entry.messages.length > MAX_MESSAGES) entry.messages.shift();
        const dropped = entry.messages.length !== before;
        if (persistent) {
            // O(1) path: nothing left the window/cap and the file is comfortably
            // inside its budget → append exactly one JSONL line
            if (
                !dropped &&
                entry.fileSize !== null &&
                entry.fileSize > 0 &&
                entry.fileSize < this.maxBytes * COMPACT_AT_RATIO
            ) {
                this.appendLine(id, entry, message);
            } else {
                this.save(id, entry);
            }
        }
        return message;
    }

    /** One-line append; a failure falls back to a full rewrite. */
    appendLine(id, entry, message) {
        const line = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
        try {
            fs.appendFileSync(this.fileFor(id), line);
            entry.fileSize = (entry.fileSize || 0) + line.length;
        } catch (err) {
            log.warn('Chat history append failed, rewriting', { channel: id, error: err.message });
            this.save(id, entry);
        }
    }

    /**
     * Edit one of the caller's own messages (matched by ts + sender name —
     * names are the only identity this system has). Tombstones cannot be
     * edited. Returns the updated message or null.
     */
    edit(id, { ts, name, text }, { persistent = true } = {}) {
        const row = this.findRow(id, ts, name, { persistent });
        if (!row || row.deleted) return null;
        const cleanText = typeof text === 'string' ? text.trim().slice(0, TEXT_MAX) : '';
        if (!cleanText) return null;
        row.text = cleanText;
        row.edited = true;
        this.persistIf(id, persistent);
        return row;
    }

    /**
     * Recall (soft-delete) a message: the row stays as a tombstone so paging
     * cursors and reply quotes keep resolving, but the text/images are gone.
     */
    remove(id, { ts, name }, { persistent = true } = {}) {
        const row = this.findRow(id, ts, name, { persistent });
        if (!row || row.deleted) return null;
        row.deleted = true;
        row.text = '';
        delete row.imgs;
        delete row.reactions;
        this.persistIf(id, persistent);
        return row;
    }

    /**
     * Toggle one reactor on one emoji of a message. `who` is the server-side
     * joined name of the acting member. Returns the updated message or null.
     */
    react(id, { ts, name, emoji, who, op }, { persistent = true } = {}) {
        const row = this.findRow(id, ts, name, { persistent });
        if (!row || row.deleted) return null;
        const cleanEmoji = typeof emoji === 'string' ? emoji.trim().slice(0, REACTION_EMOJI_MAX) : '';
        const whoName = typeof who === 'string' ? who.slice(0, NAME_MAX) : '';
        if (!cleanEmoji || !whoName) return null;

        const reactions = { ...(row.reactions || {}) };
        const names = reactions[cleanEmoji] || [];
        const idx = names.indexOf(whoName);
        if (op === 'remove') {
            if (idx !== -1) names.splice(idx, 1);
        } else if (idx === -1) {
            // add (idempotent): a repeated add from a racing client is a no-op
            if (Object.keys(reactions).length >= REACTIONS_MAX_EMOJI && !reactions[cleanEmoji]) return row;
            if (names.length >= REACTIONS_MAX_NAMES) return row;
            names.push(whoName);
        }
        if (names.length) reactions[cleanEmoji] = names;
        else delete reactions[cleanEmoji];
        if (Object.keys(reactions).length) row.reactions = reactions;
        else delete row.reactions;
        this.persistIf(id, persistent);
        return row;
    }

    /** Find a row by ts + sender name; null when absent (or channel unknown). */
    findRow(id, ts, name, { persistent = true } = {}) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return null;
        if (!Number.isFinite(ts) || ts <= 0 || typeof name !== 'string' || !name) return null;
        const entry = this.entry(id, { persistent });
        for (let i = entry.messages.length - 1; i >= 0; i--) {
            const row = entry.messages[i];
            if (row.ts === ts && row.name === name) return row;
        }
        return null;
    }

    /** Full rewrite after an in-place row mutation (edits are rare). */
    persistIf(id, persistent) {
        if (!persistent) return;
        const entry = this.entry(id);
        this.save(id, entry);
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

    /**
     * Atomic full rewrite (tmp + rename; content copy for single-file bind
     * mounts). Also the compaction point: rows drop from the oldest end
     * until the serialized file fits its disk budget.
     */
    save(id, entry) {
        try {
            if (!entry.messages.length) {
                for (const file of [this.fileFor(id), this.legacyFileFor(id)]) {
                    try {
                        fs.unlinkSync(file);
                    } catch {
                        /* already gone */
                    }
                }
                entry.fileSize = 0;
                return;
            }
            // shrink from the oldest end until the file fits its disk budget.
            // Byte length, not String#length: CJK text is 3 bytes per code unit
            // in UTF-8, and the budget is a disk budget.
            let lines = serializeLines(entry.messages);
            let bytes = Buffer.byteLength(lines, 'utf8');
            while (bytes > this.maxBytes && entry.messages.length > 1) {
                entry.messages.shift();
                lines = serializeLines(entry.messages);
                bytes = Buffer.byteLength(lines, 'utf8');
            }
            this.writeFile(id, entry.messages, lines);
            entry.fileSize = bytes;
        } catch (err) {
            log.error('Chat history save failed', { channel: id, error: err.message });
        }
    }

    writeFile(id, messages, lines = serializeLines(messages)) {
        const file = this.fileFor(id);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, lines, 'utf8');
        try {
            fs.renameSync(tmp, file);
        } catch (err) {
            // Docker bind-mounts channels.json-style single files: rename()
            // cannot replace a mount point, copy the payload over instead
            if (!['EBUSY', 'EXDEV', 'EPERM'].includes(err.code)) throw err;
            fs.copyFileSync(tmp, file);
            fs.unlinkSync(tmp);
        }
    }

    /** Forget a channel entirely (room destroyed / admin delete / restore). */
    removeChannel(id) {
        if (typeof id !== 'string' || !id) return;
        this.channels.delete(id);
        for (const file of [this.fileFor(id), this.legacyFileFor(id)]) {
            try {
                fs.unlinkSync(file);
            } catch (err) {
                if (err.code !== 'ENOENT') log.warn('Chat history removal failed', { channel: id, error: err.message });
            }
        }
    }

    /** Drop every in-memory cache entry so the next read re-loads from disk. */
    reload() {
        this.channels.clear();
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
            while (entry.messages.length > MAX_MESSAGES) entry.messages.shift();
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
            // loadFile() may itself migrate a legacy .json to .jsonl — the
            // existence check runs after it so a fresh migration is not
            // immediately rewritten again
            const messages = this.loadFile(id);
            const before = messages.length;
            this.prune(messages, now, id);
            if (messages.length !== before || !fs.existsSync(this.fileFor(id))) {
                this.save(id, { persistent: true, messages });
            }
        }
    }

    /** Channel ids that have a history file on disk (JSONL or legacy JSON). */
    listFiles() {
        try {
            const ids = new Set();
            for (const name of fs.readdirSync(this.dir)) {
                for (const ext of ['.jsonl', '.json']) {
                    if (name.endsWith(ext)) ids.add(name.slice(0, -ext.length));
                }
            }
            return [...ids].filter((id) => ID_PATTERN.test(id));
        } catch {
            return [];
        }
    }

    destroy() {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
    }
}

function serializeLines(messages) {
    return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
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
        (m.edited === undefined || typeof m.edited === 'boolean') &&
        (m.deleted === undefined || typeof m.deleted === 'boolean') &&
        (m.reactions === undefined || isPlainReactions(m.reactions)) &&
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

/** Reactions map: emoji -> array of reactor names (plain strings only). */
function isPlainReactions(reactions) {
    if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return false;
    for (const names of Object.values(reactions)) {
        if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return false;
    }
    return true;
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
