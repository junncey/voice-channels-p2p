'use strict';

/**
 * Chat history store for the voice-channel edition.
 *
 * Chat itself travels peer-to-peer over WebRTC DataChannels; the sender's page
 * additionally relays every text message here so late joiners can catch up.
 * Messages are kept per channel in app/src/chat_history/<id>.json (atomic
 * write on every append — voice-channel traffic is human-scale) and pruned to
 * the admin-configured retention window (channels.json settings:
 * chatRetentionHours, 0 = keep nothing). Temporary rooms keep history in
 * memory only; it vanishes together with the room.
 */

const fs = require('fs');
const path = require('path');

const Logs = require('./logs');

const log = new Logs('chatStore');

// Same id space as the channel registry — ids become filenames, so this check
// doubles as path-traversal protection.
const ID_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

const MAX_MESSAGES = 300; // per channel: stored, kept in memory and served
const NAME_MAX = 24;
const TEXT_MAX = 500;
const MAX_IMAGES = 9; // same cap as the client batch protocol
// Disk guard: even within the message cap a pathological row can't grow a
// history file past this — rows drop from the oldest end until it fits.
const MAX_FILE_BYTES = 512 * 1024;
// How often background pruning walks the store (in-memory entries + files on
// disk) so messages past the retention window actually disappear even for
// channels nobody touches (e.g. after the admin shortens the window).
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

class ChatStore {
    /**
     * @param {object}   [options]
     * @param {string}   [options.dir]             history directory
     * @param {function|number} [options.retentionHours] live retention window in
     *     hours — a function so admin setting changes apply at once; 0 = keep nothing
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

    /** Retention window in ms (0 = the feature is switched off). */
    retentionMs() {
        const hours = Number(this.retentionHours());
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
     * Store one chat message. Returns the stored message or null (feature
     * off, invalid id/payload). `ts` override exists for tests.
     */
    append(id, { name, text, imgs = 0 }, { persistent = true, ts = Date.now() } = {}) {
        if (!ID_PATTERN.test(id)) return null;
        if (this.retentionMs() <= 0) return null;

        // trim + cap exactly like the client composer (input.trim().slice(500))
        // so a stored message never differs from what was rendered live
        const cleanName = typeof name === 'string' ? name.slice(0, NAME_MAX) : '';
        const cleanText = typeof text === 'string' ? text.trim().slice(0, TEXT_MAX) : '';
        const cleanImgs = Number.isInteger(imgs) && imgs > 0 && imgs <= MAX_IMAGES ? imgs : 0;
        if (!cleanText && !cleanImgs) return null;

        const entry = this.entry(id, { persistent });
        entry.messages.push({ ts, name: cleanName, text: cleanText, imgs: cleanImgs });
        this.prune(entry.messages);
        while (entry.messages.length > MAX_MESSAGES) entry.messages.shift();
        if (persistent) this.save(id, entry);
        return entry.messages[entry.messages.length - 1];
    }

    /** Kept messages for a joiner, oldest first (empty when disabled/unknown). */
    history(id, { persistent = true } = {}) {
        if (!ID_PATTERN.test(id) || this.retentionMs() <= 0) return [];
        const entry = this.entry(id, { persistent });
        this.prune(entry.messages);
        return entry.messages.slice();
    }

    /** Drop rows older than the retention window, in place. */
    prune(messages, now = Date.now()) {
        const retention = this.retentionMs();
        if (retention <= 0) {
            messages.length = 0;
            return;
        }
        const cutoff = now - retention;
        let drop = 0;
        while (drop < messages.length && messages[drop].ts <= cutoff) drop++;
        if (drop > 0) messages.splice(0, drop);
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
        if (this.retentionMs() <= 0) {
            for (const id of [...this.channels.keys()]) this.removeChannel(id);
            for (const id of this.listFiles()) this.removeChannel(id);
            return;
        }
        for (const [id, entry] of [...this.channels]) {
            const before = entry.messages.length;
            this.prune(entry.messages, now);
            if (entry.messages.length === before) continue;
            if (entry.persistent) this.save(id, entry);
            else if (!entry.messages.length) this.channels.delete(id);
        }
        for (const id of this.listFiles()) {
            if (this.channels.has(id)) continue;
            const messages = this.loadFile(id);
            this.prune(messages, now);
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
        (m.imgs === undefined || typeof m.imgs === 'number')
    );
}

module.exports = ChatStore;
module.exports.MAX_MESSAGES = MAX_MESSAGES;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;
module.exports.SWEEP_INTERVAL_MS = SWEEP_INTERVAL_MS;
