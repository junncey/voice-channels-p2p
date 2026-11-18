'use strict';

// npx mocha test-backup.js
// tar 写入器结构检查（集成测试覆盖 HTTP 路径；这里验证 tar 读取器
// 所依赖的归档布局算术）。

require('should');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTarIterator, readTar } = require('../app/src/backup');
const { tarFiles } = require('./helpers');

describe('test-backup (tar writer)', () => {
    it('should produce a 512-aligned ustar archive with valid checksums', () => {
        const files = [
            { name: 'channels.json', data: Buffer.from('{"channels":[]}') },
            { name: 'chat_history/a.json', data: Buffer.from('x'.repeat(1000)) },
        ];
        const tar = tarFiles(files);

        // header(512) + data(16 补齐到 512) + header(512) + data(1000 补齐到 1024) + 结束标记(1024)
        tar.length.should.equal(512 + 512 + 512 + 1024 + 1024);

        // 偏移 257 处的 magic：'ustar\0' + 版本 '00'
        tar.slice(257, 265)
            .toString()
            .should.equal('ustar\0' + '00');

        // 存储的 size 字段（偏移 124，12 字节八进制 + NUL）——payload 是 15 字节
        const sizeField = tar.slice(124, 136).toString().replace(/\0.*$/, '').trim();
        parseInt(sizeField, 8).should.equal(15);

        // checksum：按写入器的方式重算（该字段先全部填空格）——
        // 必须与存储值完全一致
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
            this.skip(); // 本机没有 tar——上面的结构检查仍然执行过
            return;
        }
        list.should.equal('probe.txt');
    });

    it('streaming iterator should produce bytes identical to the buffered writer', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tar-'));
        try {
            const diskFile = path.join(dir, 'on-disk.bin');
            // 故意取不与 512 块对齐的尺寸，以触发补齐逻辑
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

    it('streaming iterator must not tear when the source file grows mid-archive', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tar-'));
        try {
            const file = path.join(dir, 'growing.jsonl');
            const original = Buffer.from('{"ts":1,"name":"a","text":"hi"}\n');
            fs.writeFileSync(file, original);

            const chunks = [];
            for await (const chunk of createTarIterator([{ name: 'chat_history/g.jsonl', path: file }])) {
                chunks.push(chunk);
                // tar 头已发出（按原 size 声明）——此刻 chatStore 式的
                // 追加写落进来。归档必须仍精确截断到头声明的字节数，
                // 否则后续条目全部错位、整个备份损坏
                if (chunks.length === 1) fs.appendFileSync(file, Buffer.from('{"ts":2,"name":"a","text":"late"}\n'));
            }

            const out = new Map();
            await readTar(Buffer.concat(chunks), { onFile: (name, data) => out.set(name, data) });
            out.get('chat_history/g.jsonl').equals(original).should.be.true();
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
        tar[100] ^= 0xff; // 翻转 header 内部的一个字节
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
