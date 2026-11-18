'use strict';

// npx mocha test-restore.js
// 备份恢复回环：先构造一份服务器状态，按 GET /api/admin/backup 的方式
// 逐字打包归档，然后应用到另一对全新 store 上，验证整态语义
// （注册表、历史、缺失频道清扫、坏归档拒绝）。
//

require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ChannelStore = require('../app/src/channelStore');
const ChatStore = require('../app/src/chatStore');
const { applyBackupArchive, RestoreError } = require('../app/src/restore');
const { tarFiles } = require('./helpers');

function tempDir(name) {
    const dir = path.join(os.tmpdir(), `vc-restore-test-${process.pid}-${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function buildSource() {
    const dir = tempDir('src');
    const channelStore = new ChannelStore({ filePath: path.join(dir, 'channels.json'), autoInit: true });
    const chatStore = new ChatStore({ dir: path.join(dir, 'chat_history'), sweepMs: 0 });
    return { channelStore, chatStore, dir };
}

/** 与 GET /api/admin/backup 产出的归档形状完全一致。 */
function makeArchive(channelStore, chatStore) {
    const entries = [];
    if (fs.existsSync(channelStore.filePath)) {
        entries.push({ name: path.basename(channelStore.filePath), data: fs.readFileSync(channelStore.filePath) });
    }
    for (const id of chatStore.listFiles()) {
        const file = chatStore.existingFileFor(id);
        entries.push({ name: `chat_history/${id}${path.extname(file)}`, data: fs.readFileSync(file) });
    }
    return zlib.gzipSync(tarFiles(entries));
}

describe('test-restore', () => {
    let source;
    let target;
    afterEach(() => {
        source?.chatStore.destroy();
        target?.chatStore.destroy();
        source = null;
        target = null;
    });

    it('should restore channels, settings and histories into a fresh server', async () => {
        source = buildSource();
        await source.channelStore.create({ id: 'chan1', name: 'One', hosts: [{ username: 'hosta', password: 'pw1' }] });
        await source.channelStore.create({ id: 'chan2', name: 'Two' });
        source.channelStore.updateSettings({ chatRetentionHours: 48 });
        source.chatStore.append('chan1', { name: 'alice', text: 'hello' }, { ts: Date.now() });
        source.chatStore.append(
            'chan1',
            { name: 'alice', text: 'edited?', reply: { name: 'bob', text: 'q', ts: 1 } },
            { ts: Date.now() + 1 }
        );

        const archive = makeArchive(source.channelStore, source.chatStore);

        const dir = tempDir('dst');
        target = {
            channelStore: new ChannelStore({ filePath: path.join(dir, 'channels.json'), autoInit: true }),
            chatStore: new ChatStore({ dir: path.join(dir, 'chat_history'), sweepMs: 0 }),
        };
        // 预置一份恢复必须整态替换的旧状态，包括一个归档里
        // 不存在的频道（整态语义）
        await target.channelStore.create({ id: 'ghostchan', name: 'Old' });
        target.chatStore.append('ghostchan', { name: 'x', text: 'stale' });
        target.chatStore.append('chan2', { name: 'y', text: 'not in archive' });

        const stats = await applyBackupArchive(archive, target);
        stats.channels.should.equal(2);
        stats.histories.should.equal(1);

        // 注册表被替换：归档内的频道进来，预置的频道出去
        target.channelStore.exists('chan1').should.be.true();
        target.channelStore.exists('chan2').should.be.true();
        target.channelStore.exists('ghostchan').should.be.false();
        // settings 一并随行
        target.channelStore.settings.chatRetentionHours.should.equal(48);
        // 主持人密码哈希存活（用原始密码验证）
        (await target.channelStore.verifyHost('chan1', 'hosta', 'pw1')).username.should.equal('hosta');
        // 历史经内存缓存恢复
        const rows = target.chatStore.history('chan1').messages;
        rows.map((r) => r.text).should.eql(['hello', 'edited?']);
        rows[1].reply.name.should.equal('bob');
        // 归档中缺失频道的历史已被清除
        target.chatStore.listFiles().should.eql(['chan1']);
        // 且恢复后的注册表落了盘（新建 store 读到同样的内容）
        const reopened = new ChannelStore({ filePath: path.join(dir, 'channels.json'), autoInit: false });
        reopened.exists('chan1').should.be.true();
        reopened.exists('ghostchan').should.be.false();
    });

    it('should accept legacy .json history entries from old backups', async () => {
        source = buildSource();
        await source.channelStore.create({ id: 'legacy1', name: 'L' });
        const archive = zlib.gzipSync(
            tarFiles([
                { name: 'channels.json', data: fs.readFileSync(source.channelStore.filePath) },
                {
                    name: 'chat_history/legacy1.json',
                    data: Buffer.from(
                        JSON.stringify({ version: 1, messages: [{ ts: Date.now(), name: 'a', text: 'old format' }] })
                    ),
                },
            ])
        );
        const dir = tempDir('dst-legacy');
        target = {
            channelStore: new ChannelStore({ filePath: path.join(dir, 'channels.json'), autoInit: true }),
            chatStore: new ChatStore({ dir: path.join(dir, 'chat_history'), sweepMs: 0 }),
        };
        const stats = await applyBackupArchive(archive, target);
        stats.histories.should.equal(1);
        // 旧格式文件原样就位，首次读取时才迁移
        target.chatStore
            .history('legacy1')
            .messages.map((m) => m.text)
            .should.eql(['old format']);
        fs.existsSync(path.join(dir, 'chat_history', 'legacy1.jsonl')).should.be.true();
    });

    it('should reject broken archives without touching the target', async () => {
        const dir = tempDir('dst-reject');
        target = {
            channelStore: new ChannelStore({ filePath: path.join(dir, 'channels.json'), autoInit: true }),
            chatStore: new ChatStore({ dir: path.join(dir, 'chat_history'), sweepMs: 0 }),
        };
        await target.channelStore.create({ id: 'keepme', name: 'K' });

        // 不是 gzip
        await applyBackupArchive(Buffer.from('plain text'), target).should.be.rejectedWith(/gzip/);
        // 合法 gzip，但不是 tar
        await applyBackupArchive(zlib.gzipSync(Buffer.from('garbage!')), target).should.be.rejectedWith(RestoreError);
        // 缺 channels.json 的 tar（单独的历史条目本身是合法的）
        const noRegistry = zlib.gzipSync(tarFiles([{ name: 'chat_history/roomx.jsonl', data: Buffer.from('{}\n') }]));
        await applyBackupArchive(noRegistry, target).should.be.rejectedWith(/channels\.json/);
        // 意外的条目名（路径穿越形态）
        const evil = zlib.gzipSync(
            tarFiles([
                { name: 'channels.json', data: fs.readFileSync(target.channelStore.filePath) },
                { name: '../../etc/passwd', data: Buffer.from('nope') },
            ])
        );
        await applyBackupArchive(evil, target).should.be.rejectedWith(/unexpected archive entry/);
        // 注册表含非法频道 ID
        const badRegistry = zlib.gzipSync(
            tarFiles([
                {
                    name: 'channels.json',
                    data: Buffer.from(JSON.stringify({ channels: [{ id: '../evil', name: 'x' }] })),
                },
            ])
        );
        await applyBackupArchive(badRegistry, target).should.be.rejectedWith(/invalid channel ids/);

        // 以上所有拒绝都没有改动目标状态
        target.channelStore.exists('keepme').should.be.true();
        target.chatStore.listFiles().should.be.empty();
    });
});
