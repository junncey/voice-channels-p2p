'use strict';

/**
 * Chat history store for the voice-channel edition.
 *
 * Chat itself travels peer-to-peer over WebRTC DataChannels; the sender's
 * page additionally relays every message (text + compressed image data URLs)
 * here so late joiners can catch up. Messages are kept per channel as
 * append-only JSONL in app/src/chat_history/<id>.jsonl, and none of the
 * interaction paths ever rewrite the file:
 *
 *   - a new message appends exactly one line;
 *   - lifecycle changes append small event lines (`{"e":...}`) that replay
 *     in file order on load: edits, recalls, reactions, and prefix drops
 *     (retention window / MAX_MESSAGES cap) — so even a 12MB image-heavy
 *     channel mutates in O(1), with no full serialization stalling the
 *     event loop while people are chatting;
 *   - the file reconciles with memory only via deferred background
 *     compaction (scheduled once the file crosses COMPACT_AT_RATIO of its
 *     budget, coalesced ~1s), via an inline shrink when a single append
 *     pushes past the hard budget (disk bound identical to the old
 *     rewrite-per-message scheme), on legacy <id>.json migration, and as
 *     the fallback when an append fails.
 *
 * Retention trimming for channels nobody has in memory is driven by stat +
 * a tail sample: unchanged files inside their retention epoch are skipped
 * without reading, an all-expired file is wiped from the tail timestamps
 * alone, and only the remaining cases pay a full parse.
 *
 * A torn trailing line (crash mid-append) is normal for append-only logs
 * and is skipped; every line carries a finite `ts` so restore validation
 * keeps accepting the format. Legacy <id>.json files (single JSON array)
 * are migrated to JSONL on first load. Temporary rooms keep history in
 * memory only; it vanishes together with the room.
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
// Appends keep working past COMPACT_AT_RATIO (90%) of the budget; crossing
// it only schedules a coalesced background compaction. Only the hard budget
// shrinks inline, so peak disk usage stays bounded like it always was.
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const COMPACT_AT_RATIO = 0.9;
// Grace period after the ratio is crossed before the background compaction
// runs — bursts of edits/reactions/messages coalesce into one rewrite.
const COMPACT_DELAY_MS = 1000;
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
// How much of a history file's tail the sweep reads to find the newest row
// timestamp before deciding to pay a full parse.
const SWEEP_TAIL_BYTES = 64 * 1024;

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
        /** channelId -> { persistent, messages: [{ts,name,text,...}], fileSize, pendingDrop, pendingDropTs } */
        this.channels = new Map();
        /** channelId -> { size, mtimeMs, retention, minTs } — lets sweep() skip unchanged idle files */
        this.sweepState = new Map();
        this.compactPending = new Set();
        this.compactTimer = null;
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
            entry.pendingDrop = 0;
            entry.pendingDropTs = undefined;
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
     * Parse a JSONL history file line by line, replaying lifecycle event
     * lines (`{"e":...}`) onto the message rows in file order. A torn
     * trailing line (crash mid-append) is normal for append-only logs and is
     * skipped silently; lines that still fail to parse are skipped with a
     * warn. A file where EVERY line is garbage yields an empty history.
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
                const row = JSON.parse(line);
                // message rows never carry an `e` field — it marks an event
                if (row && typeof row === 'object' && !Array.isArray(row) && row.e !== undefined) {
                    applyEvent(messages, row); // invalid/unknown events just don't apply
                } else if (isPlainMessage(row)) {
                    messages.push(row);
                } else {
                    bad++;
                }
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
        if (!persistent) {
            this.prune(entry.messages, Date.now(), id);
            while (entry.messages.length > MAX_MESSAGES) entry.messages.shift();
            return message;
        }

        this.trimEntry(entry, id);
        // drops are prefix-only, so the message survived unless it is gone
        // from the tail (i.e. the whole history expired around it)
        const kept = entry.messages[entry.messages.length - 1] === message;
        if (!kept || !(entry.fileSize > 0)) {
            // whole history expired, first row ever, or unknown disk state
            // (e.g. a failed migration): one canonical write settles it
            this.save(id, entry);
            entry.pendingDrop = 0;
            entry.pendingDropTs = undefined;
            return message;
        }
        // O(1) path: pending prefix-drops ride as one replayable marker line,
        // the message as another — the budget is enforced by deferred
        // compaction (or inline past the hard budget inside appendLines)
        const lines = [];
        if (entry.pendingDrop > 0) {
            lines.push({ e: 'drop', ts: entry.pendingDropTs ?? 0, n: entry.pendingDrop });
            entry.pendingDrop = 0;
            entry.pendingDropTs = undefined;
        }
        lines.push(message);
        this.appendLines(id, entry, lines);
        return message;
    }

    /**
     * Append one or more JSONL rows in a single write. A failure falls back
     * to a full rewrite. Crossing COMPACT_AT_RATIO schedules the background
     * compaction; crossing the hard budget shrinks inline so peak disk use
     * stays bounded even under an image flood.
     */
    appendLines(id, entry, rows) {
        const line = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
        try {
            fs.appendFileSync(this.fileFor(id), line);
            entry.fileSize = (entry.fileSize || 0) + line.length;
            if (entry.fileSize >= this.maxBytes) this.save(id, entry);
            else if (entry.fileSize >= this.maxBytes * COMPACT_AT_RATIO) this.scheduleCompact(id);
        } catch (err) {
            log.warn('Chat history append failed, rewriting', { channel: id, error: err.message });
            this.save(id, entry);
        }
    }

    /**
     * Retention prune + MAX_MESSAGES cap on an entry's rows, accounting
     * every dropped row into entry.pendingDrop so the next drop marker (or
     * full rewrite) keeps the disk replay equal to memory — including drops
     * that happened on read paths (history/export), which never write.
     */
    trimEntry(entry, id, now = Date.now()) {
        const { dropped, lastTs } = this.prune(entry.messages, now, id);
        let capDropped = 0;
        let capLastTs;
        while (entry.messages.length > MAX_MESSAGES) {
            capLastTs = entry.messages.shift().ts;
            capDropped++;
        }
        if (dropped > 0 || capDropped > 0) {
            entry.pendingDrop = (entry.pendingDrop || 0) + dropped + capDropped;
            // cap drops sit after prune drops in the prefix, so they are the
            // newer end of what left
            const latestDroppedTs = capLastTs ?? lastTs;
            if (latestDroppedTs !== undefined) entry.pendingDropTs = latestDroppedTs;
        }
    }

    /** Flush pending prefix-drops as one replayable marker line. */
    emitDropMarker(id, entry) {
        const n = entry.pendingDrop || 0;
        if (n <= 0) return;
        const evt = { e: 'drop', ts: entry.pendingDropTs ?? 0, n };
        entry.pendingDrop = 0;
        entry.pendingDropTs = undefined;
        this.appendLines(id, entry, [evt]);
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
        // event line replays through applyEvent('edit') — keep both in sync
        this.persistEvent(id, persistent, { e: 'edit', ts, name, text: cleanText });
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
        // event line replays through applyEvent('del') — keep both in sync
        this.persistEvent(id, persistent, { e: 'del', ts, name });
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

        // copy the per-emoji array too: mutating it in place would leak into
        // row.reactions and make the changed check below always equal
        const reactions = { ...(row.reactions || {}) };
        const names = [...(reactions[cleanEmoji] || [])];
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
        const changed = JSON.stringify(reactions) !== JSON.stringify(row.reactions || {});
        if (Object.keys(reactions).length) row.reactions = reactions;
        else delete row.reactions;
        if (changed) {
            // event line replays through applyEvent('react') — keep both in sync
            this.persistEvent(id, persistent, {
                e: 'react',
                ts,
                name,
                emoji: cleanEmoji,
                who: whoName,
                op: op === 'remove' ? 'remove' : 'add',
            });
        }
        return row;
    }

    /**
     * Persist one lifecycle event as an O(1) append; the full rewrite is
     * only the fallback for entries whose file is missing or empty (failed
     * migration, brand-new disk state).
     */
    persistEvent(id, persistent, evt) {
        if (!persistent) return;
        const entry = this.channels.get(id);
        if (!entry) return;
        if (entry.fileSize > 0) this.appendLines(id, entry, [evt]);
        else this.save(id, entry);
    }

    /** Find a row by ts + sender name; null when absent (or channel unknown). */
    findRow(id, ts, name, { persistent = true } = {}) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return null;
        if (!Number.isFinite(ts) || ts <= 0 || typeof name !== 'string' || !name) return null;
        const entry = this.entry(id, { persistent });
        return findRowIn(entry.messages, ts, name);
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
        this.trimEntry(entry, id);

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

    /**
     * Drop rows older than the channel's retention window, in place.
     * Returns how many rows left and the newest dropped ts (undefined when
     * nothing dropped) so callers can account prefix-drops for the disk log.
     */
    prune(messages, now = Date.now(), id = null) {
        // id-less callers (legacy) fall back to the resolver without an argument
        const retention = this.retentionMs(id);
        if (retention <= 0) {
            const all = messages.length;
            const lastTs = all ? messages[all - 1].ts : undefined;
            messages.length = 0;
            return { dropped: all, lastTs };
        }
        const cutoff = now - retention;
        let drop = 0;
        while (drop < messages.length && messages[drop].ts <= cutoff) drop++;
        const lastTs = drop > 0 ? messages[drop - 1].ts : undefined;
        if (drop > 0) messages.splice(0, drop);
        return { dropped: drop, lastTs };
    }

    /**
     * Full kept history of a channel, oldest first, unpaged (host export).
     * Prunes first, so expired rows never land in an export.
     */
    exportAll(id) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return [];
        const entry = this.entry(id, { persistent: true });
        this.trimEntry(entry, id);
        return entry.messages.map((m) => ({ ...m }));
    }

    /**
     * Atomic full rewrite (tmp + rename; content copy for single-file bind
     * mounts). Also the compaction point: event lines collapse into plain
     * rows and rows drop from the oldest end until the file fits its disk
     * budget. Only ever called off the interaction path (deferred
     * compaction, migration, hard-budget shrink, fallbacks).
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

    /**
     * Schedule the coalesced background compaction for a channel: the first
     * ratio-crossing starts the timer, further crossings only join the
     * batch. Runs between interactions, never inside one.
     */
    scheduleCompact(id) {
        if (this.compactPending.has(id)) return;
        this.compactPending.add(id);
        if (this.compactTimer) return;
        this.compactTimer = setTimeout(() => {
            this.compactTimer = null;
            const ids = [...this.compactPending];
            this.compactPending.clear();
            for (const pendingId of ids) {
                try {
                    this.runCompact(pendingId);
                } catch (err) {
                    log.error('Chat history compaction failed', { channel: pendingId, error: err.message });
                }
            }
        }, COMPACT_DELAY_MS);
        this.compactTimer.unref?.();
    }

    /** Reconcile one channel's file with memory: prune, rewrite, drop markers collapse. */
    runCompact(id) {
        const entry = this.channels.get(id); // peek only — never lazy-load here
        if (!entry) return;
        this.trimEntry(entry, id);
        this.save(id, entry);
        entry.pendingDrop = 0;
        entry.pendingDropTs = undefined;
    }

    /** Forget a channel entirely (room destroyed / admin delete / restore). */
    removeChannel(id) {
        if (typeof id !== 'string' || !id) return;
        this.channels.delete(id);
        this.sweepState.delete(id);
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
        this.sweepState.clear(); // restored/replaced files must be re-checked
    }

    /**
     * Background pass: prune every in-memory channel and every file on disk
     * (covers channels nobody touched since the retention window shrank),
     * deleting whatever ends up empty. With the feature disabled it wipes all
     * history.
     *
     * Disk-only channels skip the expensive path whenever possible: a file
     * whose size/mtime is unchanged, whose window is unchanged, and whose
     * oldest retained row has not reached its own expiry cannot have
     * anything to trim; an all-expired file is wiped from a tail sample
     * alone. Only the remaining cases pay a full parse.
     */
    sweep(now = Date.now()) {
        for (const [id, entry] of [...this.channels]) {
            if (this.retentionMs(id) <= 0) {
                // this channel's own override switches it off — drop it entirely
                if (entry.persistent) this.removeChannel(id);
                else this.channels.delete(id);
                continue;
            }
            this.trimEntry(entry, id, now);
            if (!(entry.pendingDrop > 0)) continue;
            if (!entry.persistent) {
                entry.pendingDrop = 0;
                entry.pendingDropTs = undefined;
                if (!entry.messages.length) this.channels.delete(id);
                continue;
            }
            if (!entry.messages.length || !(entry.fileSize > 0)) {
                this.save(id, entry);
                entry.pendingDrop = 0;
                entry.pendingDropTs = undefined;
            } else {
                this.emitDropMarker(id, entry);
            }
        }
        for (const id of this.listFiles()) {
            if (this.channels.has(id)) continue;
            if (this.retentionMs(id) <= 0) {
                this.removeChannel(id); // per-channel override disabled it
                continue;
            }
            const retention = this.retentionMs(id);
            let st = null;
            try {
                st = fs.statSync(this.fileFor(id));
            } catch {
                /* legacy-only channel (or racing removal) — take the full path */
            }
            const seen = this.sweepState.get(id);
            if (
                st &&
                seen &&
                seen.size === st.size &&
                seen.mtimeMs === st.mtimeMs &&
                seen.retention === retention &&
                now < seen.minTs + retention
            ) {
                continue; // unchanged file, nothing can have expired since the last check
            }
            // tail probe: when even the newest row is past the window, the
            // whole file is droppable — no need to parse megabytes to know it
            if (st && st.size > 0) {
                const latest = this.tailLatestMessageTs(this.fileFor(id), st.size);
                if (latest !== null && latest <= now - retention) {
                    this.save(id, { persistent: true, messages: [] });
                    this.sweepState.delete(id);
                    continue;
                }
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
            // remember the post-check shape so idle channels skip every
            // future sweep until the file changes, the window moves, or the
            // oldest retained row reaches its own expiry
            try {
                const after = fs.statSync(this.fileFor(id));
                this.sweepState.set(id, {
                    size: after.size,
                    mtimeMs: after.mtimeMs,
                    retention,
                    minTs: messages.length ? messages[0].ts : 0,
                });
            } catch {
                this.sweepState.delete(id); // file ended up gone (everything expired)
            }
        }
    }

    /**
     * Newest message-row ts found in the last SWEEP_TAIL_BYTES of a history
     * file, or null when the tail is unreadable/ambiguous (then the caller
     * falls back to a full check). Event lines carry the ts of a row that is
     * already in the file, so they never raise the maximum.
     */
    tailLatestMessageTs(file, size) {
        const start = Math.max(0, size - SWEEP_TAIL_BYTES);
        const len = size - start;
        const buf = Buffer.allocUnsafe(len);
        try {
            const fd = fs.openSync(file, 'r');
            try {
                const read = fs.readSync(fd, buf, 0, len, start);
                if (read !== len) return null;
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return null;
        }
        let text = buf.toString('utf8');
        if (start > 0) {
            // the chunk may begin mid-line (or mid-code-point): drop the
            // fragment up to the first complete newline
            const nl = text.indexOf('\n');
            if (nl === -1) return null;
            text = text.slice(nl + 1);
        }
        let maxTs = null;
        for (const line of text.split('\n')) {
            if (!line) continue;
            try {
                const row = JSON.parse(line);
                if (
                    row &&
                    typeof row === 'object' &&
                    !Array.isArray(row) &&
                    row.e === undefined &&
                    Number.isFinite(row.ts)
                ) {
                    if (maxTs === null || row.ts > maxTs) maxTs = row.ts;
                }
            } catch {
                return null; // torn or foreign tail — defer to the full check
            }
        }
        return maxTs;
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
        if (this.compactTimer) clearTimeout(this.compactTimer);
        this.compactTimer = null;
        this.compactPending.clear();
        this.sweepState.clear();
    }
}

/**
 * Replay one lifecycle event line onto an in-order row list. Mirrors the
 * live mutators (edit/remove/react + prefix drops) exactly so that
 * replaying a file always yields the same rows the writing process had in
 * memory; unknown event kinds from a newer version are skipped.
 */
function applyEvent(messages, evt) {
    switch (evt.e) {
        case 'drop': {
            // prefix drop: retention window / MAX_MESSAGES cap left the
            // first n rows — exact count, no ts/name assumptions (the `ts`
            // field only exists so restore validation accepts the line)
            if (!Number.isInteger(evt.n) || evt.n <= 0) return;
            messages.splice(0, Math.min(evt.n, messages.length));
            return;
        }
        case 'edit': {
            if (!isEventTarget(evt)) return;
            const text = typeof evt.text === 'string' ? evt.text.trim().slice(0, TEXT_MAX) : '';
            if (!text) return;
            const row = findRowIn(messages, evt.ts, evt.name);
            if (!row || row.deleted) return;
            row.text = text;
            row.edited = true;
            return;
        }
        case 'del': {
            if (!isEventTarget(evt)) return;
            const row = findRowIn(messages, evt.ts, evt.name);
            if (!row || row.deleted) return;
            row.deleted = true;
            row.text = '';
            delete row.imgs;
            delete row.reactions;
            return;
        }
        case 'react': {
            if (!isEventTarget(evt)) return;
            const emoji = typeof evt.emoji === 'string' ? evt.emoji.trim().slice(0, REACTION_EMOJI_MAX) : '';
            const who = typeof evt.who === 'string' ? evt.who.slice(0, NAME_MAX) : '';
            if (!emoji || !who) return;
            const row = findRowIn(messages, evt.ts, evt.name);
            if (!row || row.deleted) return;
            const reactions = { ...(row.reactions || {}) };
            const names = [...(reactions[emoji] || [])];
            const idx = names.indexOf(who);
            if (evt.op === 'remove') {
                if (idx !== -1) names.splice(idx, 1);
            } else if (idx === -1) {
                // same caps as the live toggle: a capped or repeated add
                // replays as the no-op it was when it happened
                if (Object.keys(reactions).length >= REACTIONS_MAX_EMOJI && !reactions[emoji]) return;
                if (names.length >= REACTIONS_MAX_NAMES) return;
                names.push(who);
            }
            if (names.length) reactions[emoji] = names;
            else delete reactions[emoji];
            if (Object.keys(reactions).length) row.reactions = reactions;
            else delete row.reactions;
            return;
        }
        default:
            return;
    }
}

/** Row identity carried by edit/del/react event lines (ts + sender name). */
function isEventTarget(evt) {
    return Number.isFinite(evt.ts) && typeof evt.name === 'string' && !!evt.name;
}

/** Find a row by ts + sender name in a plain row list (shared with replay). */
function findRowIn(messages, ts, name) {
    if (!Number.isFinite(ts) || typeof name !== 'string') return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const row = messages[i];
        if (row.ts === ts && row.name === name) return row;
    }
    return null;
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
