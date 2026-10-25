'use strict';

/**
 * Admin backup restore: unpack a tar.gz produced by GET /api/admin/backup
 * back into a live server — channels.json into the registry, chat_history/*
 * into the history directory. Everything is validated BEFORE a single file
 * is replaced (parse the whole archive into memory first, then apply), so a
 * truncated or hostile upload can never leave a half-restored server.
 *
 * Restores are whole-state: history files for channels absent from the
 * archive are removed, matching what a fresh unpack-over-a-data-dir would do.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const Logs = require('./logs');
const { readTar } = require('./backup');
const limits = require('./limits');

const log = new Logs('restore');

const ID_PATTERN = limits.CHANNEL_ID_RE;
const REGISTRY_NAME = 'channels.json';
// The registry is a few hundred KB at worst; one history file is bounded by
// the store's own 12MB disk budget. The whole-archive caps keep a hostile or
// accidental upload from OOM-ing a small host: the body is buffered, then
// gunzipped into memory, then parsed — so every stage gets its own ceiling.
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024; // decompressed tar

class RestoreError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** Gunzip a raw archive buffer with a hard cap on the decompressed size. */
function gunzipBounded(gzipBuf, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        const stream = zlib.createGunzip();
        stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                stream.destroy();
                reject(new RestoreError('decompressed archive exceeds the size limit', 413));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('error', (err) => reject(new RestoreError(`invalid gzip archive: ${err.message}`)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.end(gzipBuf);
    });
}

/**
 * Validate + apply a backup archive.
 * @param {Buffer} gzipBuf raw tar.gz bytes
 * @param {object} stores
 * @param {import('./channelStore')} stores.channelStore
 * @param {import('./chatStore')} stores.chatStore
 * @returns {Promise<{channels: number, histories: number}>}
 */
async function applyBackupArchive(gzipBuf, { channelStore, chatStore }) {
    if (!Buffer.isBuffer(gzipBuf) || !gzipBuf.length) throw new RestoreError('empty upload');
    const tar = await gunzipBounded(gzipBuf, MAX_ARCHIVE_BYTES);

    // ---- pass 1: parse every entry into memory (nothing written yet) ----
    let registryRaw = null;
    /** id -> { ext: '.jsonl'|'.json', data: Buffer } */
    const histories = new Map();
    try {
        await readTar(tar, {
            maxFileBytes: MAX_REGISTRY_BYTES,
            maxTotalBytes: MAX_ARCHIVE_BYTES,
            onFile: (name, data) => {
                if (name === REGISTRY_NAME) {
                    registryRaw = data;
                    return;
                }
                const m = name.match(new RegExp(`^chat_history/(${limits.CHANNEL_ID_SOURCE})\\.(jsonl|json)$`));
                if (!m) throw new RestoreError(`unexpected archive entry: ${name}`);
                const id = m[1];
                const prev = histories.get(id);
                // a JSONL entry wins over a legacy JSON one if both appear
                if (!prev || (prev.ext === '.json' && m[2] === 'jsonl')) {
                    histories.set(id, { ext: `.${m[2]}`, data });
                }
            },
        });
    } catch (err) {
        // structural tar problems are client-input errors, not server faults
        if (err instanceof RestoreError) throw err;
        throw new RestoreError(err.message);
    }
    if (!registryRaw) throw new RestoreError('archive is missing channels.json');

    // ---- pass 2: validate contents (parse shapes; still nothing written) ----
    let registry;
    try {
        registry = JSON.parse(registryRaw.toString('utf8'));
    } catch (err) {
        throw new RestoreError(`channels.json is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(registry.channels)) throw new RestoreError('channels.json has no channels array');
    if (
        registry.channels.length &&
        !registry.channels.every((ch) => ch && typeof ch === 'object' && ID_PATTERN.test(String(ch.id)))
    ) {
        throw new RestoreError('channels.json contains invalid channel ids');
    }
    for (const [id, entry] of histories) {
        if (entry.data.length > MAX_HISTORY_FILE_BYTES) throw new RestoreError(`history file too large: ${id}`);
        if (entry.ext === '.json') {
            try {
                const parsed = JSON.parse(entry.data.toString('utf8'));
                if (!Array.isArray(parsed?.messages)) throw new Error('no messages array');
            } catch (err) {
                throw new RestoreError(`history file ${id}.json is invalid: ${err.message}`);
            }
        } else {
            const lines = entry.data.toString('utf8').split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const row = JSON.parse(line);
                    if (!row || typeof row !== 'object' || !Number.isFinite(row.ts)) throw new Error('bad row');
                } catch (err) {
                    throw new RestoreError(`history file ${id}.jsonl has an invalid line: ${err.message}`);
                }
            }
        }
    }

    // ---- pass 3: apply (registry first, then histories, then the sweep) ----
    // registry: validated raw content becomes the new channels.json through
    // the store itself, so settings/hashes land in memory AND on disk in one
    // atomic shape (the store's own save() handles tmp+rename+.bak)
    const registryTmp = `${channelStore.filePath}.restore`;
    fs.writeFileSync(registryTmp, registryRaw, 'utf8');
    try {
        const parsed = channelStore.readRegistryFile(registryTmp);
        // snapshot the live state: if the persisting save() fails, memory must
        // keep matching the disk we still have (applySettings mutates in place,
        // so the settings copy is a real snapshot, not a shared reference)
        const prevChannels = channelStore.channels;
        const prevSettings = { ...channelStore.settings };
        channelStore.channels = parsed.channels;
        channelStore.applySettings(parsed.settings);
        try {
            channelStore.save();
        } catch (saveErr) {
            channelStore.channels = prevChannels;
            channelStore.settings = prevSettings;
            throw saveErr;
        }
    } catch (err) {
        throw new RestoreError(`registry rejected: ${err.message}`);
    } finally {
        try {
            fs.unlinkSync(registryTmp);
        } catch {
            /* already gone */
        }
    }

    // histories: write each file under its archive extension (legacy .json
    // entries migrate to .jsonl on first load, exactly like an old install)
    for (const [id, entry] of histories) {
        const file = path.join(chatStore.dir, `${id}${entry.ext}`);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, entry.data, 'utf8');
        try {
            fs.renameSync(tmp, file);
        } catch (err) {
            if (!['EBUSY', 'EXDEV', 'EPERM'].includes(err.code)) throw err;
            fs.copyFileSync(tmp, file);
            fs.unlinkSync(tmp);
        }
    }
    // whole-state semantics: drop history files whose channel is not in the archive
    for (const id of chatStore.listFiles()) {
        if (!histories.has(id)) chatStore.removeChannel(id);
    }
    chatStore.reload(); // in-memory caches lazy-load the new files

    log.info('Backup restored', { channels: registry.channels.length, histories: histories.size });
    return { channels: registry.channels.length, histories: histories.size };
}

module.exports = { applyBackupArchive, RestoreError };
