'use strict';

/**
 * Minimal ustar tar writer (no external deps) for the admin backup download:
 * channels.json + every persisted chat history file, streamed as tar.gz.
 * Only regular files with short names are produced — the ustar subset every
 * tar implementation understands.
 */

const fs = require('fs');

const BLOCK = 512;

/** Octal ASCII encoding with trailing NUL/spaces (tar header fields). */
function octal(value, length) {
    return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** Header checksum: sum of all 512 bytes with the checksum field as spaces. */
function headerChecksum(header) {
    let sum = 0;
    for (const byte of header) sum += byte;
    return sum;
}

/** One 512-byte ustar header for a regular file. */
function fileHeader(name, size, mtime) {
    const header = Buffer.alloc(BLOCK);
    header.write(name.slice(0, 100), 0, 100, 'utf8'); // name
    header.write(octal(0o644, 8), 100); // mode
    header.write(octal(0, 8), 108); // uid
    header.write(octal(0, 8), 116); // gid
    header.write(octal(size, 12), 124); // size
    header.write(octal(mtime, 12), 136); // mtime
    header.write('        ', 148); // chksum placeholder: 8 spaces
    header.write('0', 156); // typeflag: regular file
    header.write('ustar\0', 257, 'binary'); // magic
    header.write('00', 263); // version
    const sum = headerChecksum(header);
    header.write(octal(sum, 8), 148);
    return header;
}

/**
 * Pack files into a single tar buffer.
 * @param {Array<{name: string, data: Buffer, mtime?: number}>} files
 * @returns {Buffer} tar archive (two zero blocks terminated)
 */
function tarFiles(files) {
    const chunks = [];
    for (const file of files) {
        if (!Buffer.isBuffer(file.data)) continue;
        const mtime = Number.isFinite(file.mtime) ? Math.floor(file.mtime / 1000) : Math.floor(Date.now() / 1000);
        chunks.push(fileHeader(file.name, file.data.length, mtime));
        chunks.push(file.data);
        const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
        if (pad) chunks.push(Buffer.alloc(pad));
    }
    chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
    return Buffer.concat(chunks);
}

/**
 * Async generator producing the same archive as tarFiles() block by block —
 * the streaming counterpart for the HTTP backup so file payloads never sit
 * in memory whole (each entry is read from disk in chunks, backpressure
 * handled by stream.Readable.from on the consumer side).
 * @param {Array<{name: string, path?: string, data?: Buffer, mtime?: number}>} files
 *   entries with `data` are yielded as-is; entries with `path` are streamed
 *   from disk (caller must have verified the file exists/readable).
 */
async function* createTarIterator(files) {
    for (const file of files) {
        const size = Buffer.isBuffer(file.data) ? file.data.length : fs.statSync(file.path).size;
        const mtime = Number.isFinite(file.mtime) ? Math.floor(file.mtime / 1000) : Math.floor(Date.now() / 1000);
        yield fileHeader(file.name, size, mtime);
        if (Buffer.isBuffer(file.data)) {
            yield file.data;
        } else {
            for await (const chunk of fs.createReadStream(file.path, { highWaterMark: 64 * 1024 })) {
                yield chunk;
            }
        }
        const pad = (BLOCK - (size % BLOCK)) % BLOCK;
        if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(BLOCK * 2); // end-of-archive marker
}

// ---------------------------------------------------------------------------
// Reader side (admin restore): a strict ustar parser that accepts exactly the
// subset the writer produces — regular files, short names, checksum verified.
// Malformed archives (bad checksum, unexpected typeflag, short read) reject
// with an Error instead of writing anything to disk.
// ---------------------------------------------------------------------------

/** Parse an octal tar header field (NUL/space terminated). */
function parseOctal(block, offset, length) {
    const raw = block.toString('utf8', offset, offset + length).replace(/[\0 ]/g, '');
    const value = parseInt(raw, 8);
    return Number.isFinite(value) ? value : NaN;
}

/**
 * Walk a whole tar archive held in one buffer. Files are handed to
 * `onFile(name, buffer)` sequentially; directories and the end-of-archive
 * marker terminate parsing. Enforces per-file and total size caps.
 * @param {Buffer} tar the raw (decompressed) archive
 * @param {object} [options]
 * @param {number} [options.maxFileBytes] per-entry cap
 * @param {number} [options.maxTotalBytes] whole-archive cap
 * @param {function(string, Buffer): (void|Promise<void>)} [options.onFile]
 * @returns {Promise<{files: number, bytes: number}>}
 */
async function readTar(
    tar,
    { maxFileBytes = 64 * 1024 * 1024, maxTotalBytes = 1024 * 1024 * 1024, onFile = null } = {}
) {
    if (!Buffer.isBuffer(tar) || tar.length < BLOCK) throw new Error('archive too short');
    let offset = 0;
    let files = 0;
    let bytes = 0;
    let sawEnd = false;
    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        // two consecutive zero blocks = end of archive
        if (header.every((b) => b === 0)) {
            sawEnd = true;
            break;
        }
        // checksum: sum of all header bytes with the chksum field as spaces
        const stored = parseOctal(header, 148, 8);
        const actual = headerChecksum(header) - sumRange(header, 148, 8) + 8 * 0x20;
        if (!Number.isFinite(stored) || stored !== actual) throw new Error(`tar checksum mismatch at offset ${offset}`);
        const size = parseOctal(header, 124, 12);
        if (!Number.isFinite(size) || size < 0) throw new Error('tar entry has invalid size');
        if (size > maxFileBytes) throw new Error('tar entry exceeds the per-file size cap');
        const typeflag = String.fromCharCode(header[156]);
        let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
        if (prefix) name = `${prefix}/${name}`;
        offset += BLOCK;
        const content = tar.subarray(offset, offset + size);
        if (content.length < size) throw new Error(`archive truncated inside entry ${name}`);
        if (typeflag === '0' || typeflag === '\0') {
            if (!name) throw new Error('tar entry has an empty name');
            bytes += size;
            if (bytes > maxTotalBytes) throw new Error('archive exceeds the total size cap');
            if (onFile) await onFile(name, Buffer.from(content));
            files++;
        } else if (typeflag !== '5') {
            // symlinks/devices/long-name extensions never appear in our own
            // backups — refuse instead of silently skipping entry types we
            // cannot attribute
            throw new Error(`unsupported tar entry type "${typeflag}" (${name})`);
        }
        offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    }
    if (!sawEnd) throw new Error('archive is missing its end-of-archive marker (truncated?)');
    if (!files) throw new Error('archive contains no files');
    return { files, bytes };
}

/** Sum of a byte range (the checksum field's own bytes, excluded above). */
function sumRange(block, start, length) {
    let sum = 0;
    for (let i = start; i < start + length; i++) sum += block[i];
    return sum;
}

module.exports = { tarFiles, createTarIterator, readTar };
