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

module.exports = { tarFiles, createTarIterator };
