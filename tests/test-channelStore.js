'use strict';

// npx mocha test-channelStore.js

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');

const ChannelStore = require('../app/src/channelStore');
const { verifyPassword, hashPassword } = require('../app/src/channelStore');

function tempFile(name) {
    return path.join(os.tmpdir(), `mirotalk-channels-test-${process.pid}-${name}.json`);
}

function newStore(name, opts = {}) {
    const filePath = tempFile(name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return new ChannelStore({ filePath, autoInit: true, ...opts });
}

describe('test-channelStore', () => {
    describe('0. Password hashing', () => {
        it('should hash and verify with scrypt', () => {
            const stored = hashPassword('s3cret-pass');
            stored.should.startWith('scrypt$');
            verifyPassword('s3cret-pass', stored).should.be.true();
            verifyPassword('wrong', stored).should.be.false();
        });

        it('should produce unique salts', () => {
            hashPassword('same').should.not.equal(hashPassword('same'));
        });

        it('should reject malformed stored hashes', () => {
            verifyPassword('x', '').should.be.false();
            verifyPassword('x', 'md5$abc$def').should.be.false();
            verifyPassword('x', null).should.be.false();
        });
    });

    describe('1. Registry file lifecycle', () => {
        it('should auto-create an empty registry file', () => {
            const store = newStore('init');
            fs.existsSync(store.filePath).should.be.true();
            const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
            raw.should.have.property('version', 1);
            raw.channels.should.be.an.Array().and.empty();
        });

        it('should persist channels across reloads (atomic write)', () => {
            const filePath = tempFile('persist');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

            const store = new ChannelStore({ filePath, autoInit: true });
            store.create({ id: 'night-talk', name: '周五夜聊', hosts: [{ username: 'alice', password: 'pw1' }] });

            const reloaded = new ChannelStore({ filePath, autoInit: false });
            reloaded.exists('night-talk').should.be.true();
            reloaded.get('night-talk').name.should.equal('周五夜聊');
        });

        it('should survive a corrupted file without crashing', () => {
            const filePath = tempFile('corrupt');
            fs.writeFileSync(filePath, '{ not json', 'utf8');
            const store = new ChannelStore({ filePath, autoInit: false });
            store.channels.should.be.an.Array().and.empty();
        });
    });

    describe('2. CRUD validation', () => {
        let store;
        beforeEach(() => {
            store = newStore('crud');
        });

        it('should manage temporary channels in memory only', () => {
            store.create({ id: 'persisted', name: 'kept' });
            const temp = store.getOrCreateTemp('quick-room');
            temp.temporary.should.be.true();
            store.getOrCreateTemp('quick-room').should.equal(temp); // created once
            store.isTemp('quick-room').should.be.true();
            store.isTemp('persisted').should.be.false();

            // sanitized with the temporary flag, listed separately
            store.sanitize(temp).temporary.should.be.true();
            store.sanitize(store.get('persisted')).temporary.should.be.false();
            store.listTemps().map((ch) => ch.id).should.eql(['quick-room']);

            // never written to disk
            const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
            raw.channels.map((ch) => ch.id).should.eql(['persisted']);

            // removed only when empty
            store.removeTempIfEmpty('quick-room', 1);
            store.isTemp('quick-room').should.be.true();
            store.removeTempIfEmpty('quick-room', 0);
            store.isTemp('quick-room').should.be.false();
        });

        it('should create a valid channel and never expose hashes', () => {
            const res = store.create({
                id: 'good-id_1',
                name: '频道A',
                description: 'desc',
                public: true,
                maxParticipants: 6,
                hosts: [{ username: 'alice', password: 'pw1' }],
            });
            res.ok.should.be.true();
            res.channel.hosts.should.eql(['alice']);
            should.not.exist(res.channel.hosts[0]?.passwordHash);
        });

        it('should reject invalid ids', () => {
            for (const bad of ['ab', 'has space', '../etc/passwd', 'x'.repeat(33), '<script>']) {
                store.create({ id: bad, name: 'n' }).ok.should.be.false(bad);
            }
        });

        it('should auto-generate a valid unique id when id is empty or omitted', () => {
            const a = store.create({ id: '', name: 'auto A' });
            a.ok.should.be.true();
            store.isValidId(a.channel.id).should.be.true();
            a.channel.id.should.have.length(8);
            store.exists(a.channel.id).should.be.true();

            const b = store.create({ name: 'auto B' });
            b.ok.should.be.true();
            store.isValidId(b.channel.id).should.be.true();
            b.channel.id.should.not.equal(a.channel.id);
        });

        it('should still reject an invalid explicit id (auto only applies to empty)', () => {
            store.create({ id: 'x', name: 'too short' }).ok.should.be.false();
        });

        it('should reject duplicate ids and enforce field limits', () => {
            store.create({ id: 'dup', name: 'first' }).ok.should.be.true();
            store.create({ id: 'dup', name: 'second' }).ok.should.be.false();

            store.create({ id: 'ok-id', name: 'n'.repeat(65) }).ok.should.be.false();
            store.create({ id: 'ok-id2', name: 'n', maxParticipants: 99 }).ok.should.be.false();
            store.create({ id: 'ok-id3', name: 'n', maxParticipants: 1 }).ok.should.be.false();
        });

        it('should update fields and keep blank-password hosts', () => {
            store.create({ id: 'upd', name: 'old', hosts: [{ username: 'bob', password: 'pw2' }] });
            const res = store.update('upd', {
                name: 'new',
                hosts: [{ username: 'bob', password: '' }, { username: 'carol', password: 'pw3' }],
            });
            res.ok.should.be.true();
            res.channel.name.should.equal('new');
            res.channel.hosts.should.eql(['bob', 'carol']);
            // bob kept the original hash
            store.verifyHost('upd', 'bob', 'pw2').should.be.ok();
            store.verifyHost('upd', 'carol', 'pw3').should.be.ok();
            should(store.verifyHost('upd', 'carol', 'pw2')).be.null();
        });

        it('should remove channels', () => {
            store.create({ id: 'gone', name: 'n' });
            store.remove('gone').ok.should.be.true();
            store.exists('gone').should.be.false();
            store.remove('gone').ok.should.be.false();
        });

        it('should list only public channels for the public list', () => {
            store.create({ id: 'pub1', name: 'a', public: true });
            store.create({ id: 'priv1', name: 'b', public: false });
            store.list().map((c) => c.id).should.eql(['pub1']);
            store.list({ includePrivate: true }).map((c) => c.id).should.eql(['pub1', 'priv1']);
        });
    });

    describe('3. Host verification', () => {
        it('should verify per-channel hosts', () => {
            const store = newStore('hostauth');
            store.create({ id: 'chan1', name: 'c', hosts: [{ username: 'alice', password: 'pw1' }] });
            store.create({ id: 'chan2', name: 'c', hosts: [{ username: 'bob', password: 'pw2' }] });

            store.verifyHost('chan1', 'alice', 'pw1').should.eql({ username: 'alice' });
            // wrong channel / wrong user / wrong password
            should.not.exist(store.verifyHost('chan2', 'alice', 'pw1'));
            should.not.exist(store.verifyHost('chan1', 'bob', 'pw1'));
            should.not.exist(store.verifyHost('chan1', 'alice', 'pw2'));
            should.not.exist(store.verifyHost('missing', 'alice', 'pw1'));
        });

        it('should fall back to the default moderator secret for host-less channels', () => {
            const store = newStore('fallback', { defaultModerator: 'letmein' });
            store.create({ id: 'open', name: 'c' }); // no hosts configured
            store.create({ id: 'locked', name: 'c', hosts: [{ username: 'a', password: 'b' }] });

            store.verifyHost('open', 'anyone', 'letmein').should.be.ok();
            should.not.exist(store.verifyHost('open', 'anyone', 'nope'));
            // fallback must NOT apply when the channel has its own hosts
            should.not.exist(store.verifyHost('locked', 'anyone', 'letmein'));
        });

        it('should re-check host membership for join-time validation', () => {
            const store = newStore('isHost');
            store.create({ id: 'chan1', name: 'c', hosts: [{ username: 'alice', password: 'pw' }] });
            store.isHost('chan1', 'alice').should.be.true();
            store.isHost('chan1', 'bob').should.be.false();
            store.isHost('nope', 'alice').should.be.false();
        });
    });

    describe('4. Channel join password', () => {
        it('should set a password on create and never expose the hash', () => {
            const store = newStore('chanpw');
            store.create({ id: 'locked', name: 'c', password: 'open-sesame' }).ok.should.be.true();
            store.create({ id: 'open', name: 'c' }).ok.should.be.true();

            store.sanitize(store.get('locked')).hasPassword.should.be.true();
            store.sanitize(store.get('open')).hasPassword.should.be.false();
            // hash never leaks through the sanitized copy
            JSON.stringify(store.sanitize(store.get('locked'))).should.not.containEql('scrypt$');

            store.verifyChannelPassword('locked', 'open-sesame').should.be.true();
            store.verifyChannelPassword('locked', 'wrong').should.be.false();
            store.verifyChannelPassword('locked', '').should.be.false();
            store.verifyChannelPassword('locked').should.be.false();
            store.verifyChannelPassword('open', 'anything').should.be.false(); // no password set
            store.verifyChannelPassword('missing', 'open-sesame').should.be.false();
        });

        it('should keep / replace / clear the password on update (tri-state)', () => {
            const store = newStore('chanpw-upd');
            store.create({ id: 'sec', name: 'c', password: 'first' });
            // field omitted -> unchanged
            store.update('sec', { name: 'renamed' }).ok.should.be.true();
            store.verifyChannelPassword('sec', 'first').should.be.true();
            // non-empty -> replaced
            store.update('sec', { password: 'second' }).ok.should.be.true();
            store.verifyChannelPassword('sec', 'first').should.be.false();
            store.verifyChannelPassword('sec', 'second').should.be.true();
            // '' -> explicitly cleared
            const cleared = store.update('sec', { password: '' });
            cleared.ok.should.be.true();
            cleared.channel.hasPassword.should.be.false();
            should.not.exist(store.get('sec').passwordHash);
        });

        it('should persist the hash across reloads and reject bad values', () => {
            const filePath = tempFile('chanpw-file');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            const store = new ChannelStore({ filePath, autoInit: true });
            store.create({ id: 'keep', name: 'c', password: 'gate' });
            const reloaded = new ChannelStore({ filePath, autoInit: false });
            reloaded.verifyChannelPassword('keep', 'gate').should.be.true();

            store.create({ id: 'bad1', name: 'n', password: 'x'.repeat(65) }).ok.should.be.false();
            store.create({ id: 'bad2', name: 'n', password: '   ' }).ok.should.be.false();
            store.create({ id: 'bad3', name: 'n', password: 123 }).ok.should.be.false();
        });
    });

    describe('5. Admin settings (temp rooms toggle)', () => {
        it('should default tempRooms to true and honor the env-seeded default', () => {
            newStore('settings-default').getSettings().should.eql({ tempRooms: true });
            newStore('settings-env', { defaultSettings: { tempRooms: false } })
                .getSettings()
                .should.eql({ tempRooms: false });
        });

        it('should toggle settings and persist them across reloads', () => {
            const filePath = tempFile('settings-persist');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            const store = new ChannelStore({ filePath, autoInit: true });

            store.updateSettings({ tempRooms: false }).should.eql({ ok: true, settings: { tempRooms: false } });
            const reloaded = new ChannelStore({ filePath, autoInit: false, defaultSettings: { tempRooms: true } });
            // file wins over the env-seeded default once a setting is stored
            reloaded.getSettings().should.eql({ tempRooms: false });

            store.updateSettings({ tempRooms: true }).ok.should.be.true();
            JSON.parse(fs.readFileSync(filePath, 'utf8')).settings.should.eql({ tempRooms: true });
        });

        it('should ignore non-boolean / unknown settings and malformed input', () => {
            const store = newStore('settings-bad');
            store.updateSettings({ tempRooms: 'yes' }).ok.should.be.false();
            store.updateSettings({ somethingElse: true }).ok.should.be.true(); // unknown key = no-op
            store.getSettings().should.eql({ tempRooms: true });
            store.updateSettings(null).ok.should.be.false();
        });

        it('should force-remove a temp room regardless of occupancy', () => {
            const store = newStore('settings-remove');
            store.getOrCreateTemp('quick-room');
            store.removeTempIfEmpty('quick-room', 3); // occupied: no-op
            store.isTemp('quick-room').should.be.true();
            store.removeTemp('quick-room').ok.should.be.true();
            store.isTemp('quick-room').should.be.false();
            store.removeTemp('quick-room').ok.should.be.false(); // already gone
            store.removeTemp('never-existed').ok.should.be.false();
        });
    });

    after(() => {
        for (const name of [
            'init',
            'persist',
            'corrupt',
            'crud',
            'hostauth',
            'fallback',
            'isHost',
            'chanpw',
            'chanpw-upd',
            'chanpw-file',
            'settings-default',
            'settings-env',
            'settings-persist',
            'settings-bad',
            'settings-remove',
        ]) {
            const filePath = tempFile(name);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });
});
