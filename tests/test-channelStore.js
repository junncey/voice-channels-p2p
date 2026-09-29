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

    after(() => {
        for (const name of ['init', 'persist', 'corrupt', 'crud', 'hostauth', 'fallback', 'isHost']) {
            const filePath = tempFile(name);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    });
});
