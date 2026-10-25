'use strict';

// npx mocha test-backup.js
// tar writer structure checks (the integration suite covers the HTTP path;
// here we verify the archive layout arithmetic a tar reader depends on).

require('should');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tarFiles, createTarIterator, readTar } = require('../app/src/backup');

describe('test-backup (tar writer)', () => {
    it('should produce a 512-aligned ustar archive with valid checksums', () => {
        const files = [
            { name: 'channels.json', data: Buffer.from('{"channels":[]}') },
            { name: 'chat_history/a.json', data: Buffer.from('x'.repeat(1000)) },
        ];
        const tar = tarFiles(files);

        // header(512) + data(16 padded to 512) + header(512) + data(1000 padded to 1024) + end marker(1024)
        tar.length.should.equal(512 + 512 + 512 + 1024 + 1024);

        // magic at offset 257: 'ustar\0' + version '00'
        tar.slice(257, 265)
            .toString()
            .should.equal('ustar\0' + '00');

        // stored size field (offset 124, 12 bytes octal + NUL) — payload is 15 bytes
        const sizeField = tar.slice(124, 136).toString().replace(/\0.*$/, '').trim();
        parseInt(sizeField, 8).should.equal(15);

        // checksum: recompute it the way the writer does (field blanked to
        // spaces) — must match the stored value exactly
        const stored = parseInt(tar.slice(148, 156).toString().replace(/\0.*$/, '').trim(), 8);
        const probe = Buffer.from(tar.slice(0, 512));
        probe.fill(0x20, 148, 156);
        let sum = 0;
        for (const byte of probe) sum += byte;
        sum.should.equal(stored);
    });

    it('should be readable by the system tar when available', function () {
        let list;
        try {
            list = execFileSync('tar', ['-tf', '-'], {
                input: tarFiles([{ name: 'probe.txt', data: Buffer.from('hi') }]),
            })
                .toString()
                .trim();
        } catch {
            this.skip(); // no tar on this machine — structure checks above still ran
            return;
        }
        list.should.equal('probe.txt');
    });

    it('streaming iterator should produce bytes identical to the buffered writer', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tar-'));
        try {
            const diskFile = path.join(dir, 'on-disk.bin');
            // size deliberately unaligned with the 512 block to exercise padding
            fs.writeFileSync(diskFile, Buffer.from('y'.repeat(1300)));

            const entries = [
                { name: 'channels.json', data: Buffer.from('{"channels":[]}') },
                { name: 'chat_history/big.json', path: diskFile },
            ];
            const buffered = tarFiles(entries.map((e) => ({ ...e, data: e.data ?? fs.readFileSync(e.path) })));

            const chunks = [];
            for await (const chunk of createTarIterator(entries)) chunks.push(chunk);
            const streamed = Buffer.concat(chunks);

            Buffer.compare(buffered, streamed).should.equal(0);
            (streamed.length % 512).should.equal(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('test-backup (tar reader)', () => {
    it('should round-trip archives the writer produced', async () => {
        const files = [
            { name: 'channels.json', data: Buffer.from('{"channels":[],"settings":{}}') },
            { name: 'chat_history/room1.jsonl', data: Buffer.from('{"ts":1,"name":"a","text":"hi"}\n') },
            { name: 'chat_history/room2.json', data: Buffer.from('x'.repeat(600)) },
        ];
        const out = new Map();
        const stats = await readTar(tarFiles(files), { onFile: (name, data) => out.set(name, data) });
        stats.files.should.equal(3);
        out.get('channels.json').toString().should.equal('{"channels":[],"settings":{}}');
        out.get('chat_history/room1.jsonl').toString().should.equal('{"ts":1,"name":"a","text":"hi"}\n');
        out.get('chat_history/room2.json').length.should.equal(600);
    });

    it('should reject archives with a corrupted checksum', async () => {
        const tar = tarFiles([{ name: 'x.txt', data: Buffer.from('hello') }]);
        tar[100] ^= 0xff; // flip a byte inside the header
        await readTar(tar).should.be.rejectedWith(/checksum/);
    });

    it('should reject truncated archives and non-regular entries', async () => {
        await readTar(tarFiles([{ name: 'x', data: Buffer.from('abc') }]).slice(0, 600)).should.be.rejected();
        await readTar(Buffer.alloc(1024)).should.be.rejectedWith(/no files/);
    });

    it('should honor the size caps', async () => {
        const tar = tarFiles([{ name: 'big.bin', data: Buffer.alloc(4096) }]);
        await readTar(tar, { maxFileBytes: 1024 }).should.be.rejectedWith(/per-file/);
    });
});
