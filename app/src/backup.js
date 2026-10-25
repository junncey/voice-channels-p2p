'use strict';

/**
 * Minimal ustar tar writer (no external deps) for the admin backup download:
 * channels.json + every persisted chat history file, streamed as tar.gz.
 * Only regular files with short names are produced — the ustar subset every
 * tar implementation understands.
 */

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

module.exports = { tarFiles };
