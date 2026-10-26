'use strict';

// npx mocha test-restore.js
// Backup restore round-trip: build a server state, archive it exactly like
// GET /api/admin/backup does, then apply it over a DIFFERENT pair of stores
// and verify the whole-state semantics (registry, histories, missing-channel
// sweep, rejection of bad archives).

require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ChannelStore = require('../app/src/channelStore');
const ChatStore = require('../app/src/chatStore');
const { tarFiles } = require('../app/src/backup');
const { applyBackupArchive, RestoreError } = require('../app/src/restore');

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

/** The exact archive shape GET /api/admin/backup produces. */
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
        // pre-existing state the restore must REPLACE, including a channel
        // that is NOT in the archive (whole-state semantics)
        await target.channelStore.create({ id: 'ghostchan', name: 'Old' });
        target.chatStore.append('ghostchan', { name: 'x', text: 'stale' });
        target.chatStore.append('chan2', { name: 'y', text: 'not in archive' });

        const stats = await applyBackupArchive(archive, target);
        stats.channels.should.equal(2);
        stats.histories.should.equal(1);

        // registry replaced: archive channels in, pre-existing ones out
        target.channelStore.exists('chan1').should.be.true();
        target.channelStore.exists('chan2').should.be.true();
        target.channelStore.exists('ghostchan').should.be.false();
        // settings travelled along
        target.channelStore.settings.chatRetentionHours.should.equal(48);
        // host password hashes survive (verify against the original password)
        (await target.channelStore.verifyHost('chan1', 'hosta', 'pw1')).username.should.equal('hosta');
        // history restored through the in-memory caches
        const rows = target.chatStore.history('chan1').messages;
        rows.map((r) => r.text).should.eql(['hello', 'edited?']);
        rows[1].reply.name.should.equal('bob');
        // histories of channels absent from the archive are gone
        target.chatStore.listFiles().should.eql(['chan1']);
        // and the restored registry is on disk (a fresh store sees the same)
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
        // the legacy file is in place and migrates on first read
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

        // not gzip
        await applyBackupArchive(Buffer.from('plain text'), target).should.be.rejectedWith(/gzip/);
        // valid gzip, not a tar
        await applyBackupArchive(zlib.gzipSync(Buffer.from('garbage!')), target).should.be.rejectedWith(RestoreError);
        // tar without channels.json (the lone history entry is valid)
        const noRegistry = zlib.gzipSync(tarFiles([{ name: 'chat_history/roomx.jsonl', data: Buffer.from('{}\n') }]));
        await applyBackupArchive(noRegistry, target).should.be.rejectedWith(/channels\.json/);
        // unexpected entry name (path traversal shape)
        const evil = zlib.gzipSync(
            tarFiles([
                { name: 'channels.json', data: fs.readFileSync(target.channelStore.filePath) },
                { name: '../../etc/passwd', data: Buffer.from('nope') },
            ])
        );
        await applyBackupArchive(evil, target).should.be.rejectedWith(/unexpected archive entry/);
        // registry with invalid channel ids
        const badRegistry = zlib.gzipSync(
            tarFiles([
                {
                    name: 'channels.json',
                    data: Buffer.from(JSON.stringify({ channels: [{ id: '../evil', name: 'x' }] })),
                },
            ])
        );
        await applyBackupArchive(badRegistry, target).should.be.rejectedWith(/invalid channel ids/);

        // nothing above changed the target state
        target.channelStore.exists('keepme').should.be.true();
        target.chatStore.listFiles().should.be.empty();
    });
});
