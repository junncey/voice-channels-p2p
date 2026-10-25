'use strict';

/**
 * Lightweight append-only audit trail (JSONL): who joined/left/was kicked,
 * admin data operations (backup/restore, channel CRUD). Membership events on
 * the regular log path are debug-gated by default, so this file is the place
 * to look when someone asks "who was in the channel last night".
 *
 * The file lives next to channels.json (app/src/audit.jsonl by default),
 * rotates to <file>.1 once it passes MAX_BYTES, and keeps the last MAX_LINES
 * lines in memory for the admin tail endpoint — trivially small by design.
 */

const fs = require('fs');
const path = require('path');

const Logs = require('./logs');

const log = new Logs('audit');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_LINES = 2000; // in-memory tail (the admin endpoint serves ≤ this)
const MAX_FIELDS = 24; // per event, hard shape guard
const VALUE_MAX = 200; // per scalar value, keeps the file greppable

class Audit {
    /** @param {string} [file] audit JSONL location */
    constructor(file = path.join(__dirname, 'audit.jsonl')) {
        this.file = file;
        this.lines = [];
        this.tornTail = false; // last on-disk line is a torn write: prepend \n before the next append
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            this.loadTail();
        } catch (err) {
            log.warn('Audit trail unavailable', { error: err.message });
        }
    }

    /** Append one event: audit('join', { channel: 'x', name: 'alice' }). */
    record(event, fields = {}) {
        const entry = { t: new Date().toISOString(), event: String(event).slice(0, 32) };
        let count = 0;
        for (const [key, value] of Object.entries(fields || {})) {
            if (count >= MAX_FIELDS) break;
            if (value === undefined || value === null) continue;
            const k = String(key).slice(0, 32);
            entry[k] =
                typeof value === 'object'
                    ? JSON.stringify(value).slice(0, VALUE_MAX * 4)
                    : String(value).slice(0, VALUE_MAX);
            count++;
        }
        const line = JSON.stringify(entry);
        this.lines.push(line);
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        try {
            this.rotateIfNeeded();
            // a torn tail (crash mid-append) must never swallow the next event
            fs.appendFileSync(this.file, (this.tornTail ? '\n' : '') + line + '\n', 'utf8');
            this.tornTail = false;
        } catch (err) {
            log.warn('Audit write failed', { error: err.message });
        }
        return entry;
    }

    rotateIfNeeded() {
        try {
            const stat = fs.statSync(this.file);
            if (stat.size < MAX_BYTES) return;
            fs.renameSync(this.file, `${this.file}.1`); // previous .1 is dropped
            log.info('Audit trail rotated', { file: this.file });
        } catch (err) {
            if (err.code !== 'ENOENT') log.warn('Audit rotate check failed', { error: err.message });
        }
    }

    /** Load the trailing lines of an existing audit file into memory. */
    loadTail() {
        if (!fs.existsSync(this.file)) return;
        const raw = fs.readFileSync(this.file, 'utf8');
        if (!raw.trim()) return;
        let lines = raw.split('\n').filter(Boolean);
        // a torn trailing line (crash mid-append) is dropped and remembered
        try {
            JSON.parse(lines[lines.length - 1]);
        } catch {
            lines = lines.slice(0, -1);
            this.tornTail = true;
        }
        this.lines = lines.slice(-MAX_LINES);
    }

    /**
     * Newest-first tail for the admin console. Parses lazily and skips
     * unparsable lines (the file is append-only; a torn tail is expected).
     * @returns {Array<object>}
     */
    tail(limit = 200) {
        const n = Math.max(1, Math.min(Number(limit) || 200, MAX_LINES));
        const out = [];
        for (let i = this.lines.length - 1; i >= 0 && out.length < n; i--) {
            try {
                out.push(JSON.parse(this.lines[i]));
            } catch {
                /* skip torn line */
            }
        }
        return out;
    }
}

module.exports = Audit;
