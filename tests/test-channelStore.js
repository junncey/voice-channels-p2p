'use strict';

// npx mocha test-channelStore.js

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');

const ChannelStore = require('../app/src/channelStore');
const { verifyPassword, hashPassword } = require('../app/src/channelStore');

const DEFAULT_SETTINGS = Object.fromEntries(
    Object.entries(ChannelStore.SETTINGS_SCHEMA).map(([key, rule]) => [key, rule.default])
);

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
        it('should hash and verify with scrypt', async () => {
            const stored = await hashPassword('s3cret-pass');
            stored.should.startWith('scrypt$');
            (await verifyPassword('s3cret-pass', stored)).should.be.true();
            (await verifyPassword('wrong', stored)).should.be.false();
        });

        it('should produce unique salts', async () => {
            (await hashPassword('same')).should.not.equal(await hashPassword('same'));
        });

        it('should reject malformed stored hashes', async () => {
            (await verifyPassword('x', '')).should.be.false();
            (await verifyPassword('x', 'md5$abc$def')).should.be.false();
            (await verifyPassword('x', null)).should.be.false();
        });

        it('should keep the event loop responsive while verifying (async scrypt)', async () => {
            const store = newStore('flood');
            await store.create({ id: 'flood', name: 'F', password: 'right-pw' });
            // 16 concurrent wrong-password verifies ≈ 0.5-1.6s of scrypt work.
            // The 5ms timer is scheduled BEFORE the flood starts: with scryptSync
            // the 16 verifies block the loop inside Array.from, so the timer
            // cannot fire until they all finish (drift ≥ the whole scrypt batch);
            // on the threadpool the loop stays free (drift ≈ scheduling noise).
            const t0 = Date.now();
            const timer = new Promise((resolve) => setTimeout(resolve, 5));
            const jobs = Array.from({ length: 16 }, () => store.verifyChannelPassword('flood', 'wrong-pw'));
            await timer;
            const drift = Date.now() - t0;
            (await Promise.all(jobs)).every((ok) => ok === false).should.be.true();
            drift.should.be.below(200);
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

        it('should persist channels across reloads (atomic write)', async () => {
            const filePath = tempFile('persist');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

            const store = new ChannelStore({ filePath, autoInit: true });
            await store.create({
                id: 'night-talk',
                name: '周五夜聊',
                hosts: [{ username: 'alice', password: 'pw1' }],
            });

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

        it('should manage temporary channels in memory only', async () => {
            await store.create({ id: 'persisted', name: 'kept' });
            const temp = store.getOrCreateTemp('quick-room');
            temp.temporary.should.be.true();
            store.getOrCreateTemp('quick-room').should.equal(temp); // created once
            store.isTemp('quick-room').should.be.true();
            store.isTemp('persisted').should.be.false();

            // sanitized with the temporary flag, listed separately
            store.sanitize(temp).temporary.should.be.true();
            store.sanitize(store.get('persisted')).temporary.should.be.false();
            store
                .listTemps()
                .map((ch) => ch.id)
                .should.eql(['quick-room']);

            // never written to disk
            const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
            raw.channels.map((ch) => ch.id).should.eql(['persisted']);

            // removed only when empty
            store.removeTempIfEmpty('quick-room', 1);
            store.isTemp('quick-room').should.be.true();
            store.removeTempIfEmpty('quick-room', 0);
            store.isTemp('quick-room').should.be.false();
        });

        it('should create a valid channel and never expose hashes', async () => {
            const res = await store.create({
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

        it('should reject invalid ids', async () => {
            for (const bad of ['ab', 'has space', '../etc/passwd', 'x'.repeat(33), '<script>']) {
                (await store.create({ id: bad, name: 'n' })).ok.should.be.false(bad);
            }
        });

        it('should auto-generate a valid unique id when id is empty or omitted', async () => {
            const a = await store.create({ id: '', name: 'auto A' });
            a.ok.should.be.true();
            store.isValidId(a.channel.id).should.be.true();
            a.channel.id.should.have.length(8);
            store.exists(a.channel.id).should.be.true();

            const b = await store.create({ name: 'auto B' });
            b.ok.should.be.true();
            store.isValidId(b.channel.id).should.be.true();
            b.channel.id.should.not.equal(a.channel.id);
        });

        it('should still reject an invalid explicit id (auto only applies to empty)', async () => {
            (await store.create({ id: 'x', name: 'too short' })).ok.should.be.false();
        });

        it('should reject Object.prototype-poisoning reserved ids', async () => {
            for (const bad of ['constructor', '__proto__', 'prototype']) {
                store.isValidId(bad).should.be.false(bad);
                (await store.create({ id: bad, name: 'n' })).ok.should.be.false(bad);
            }
            // exact match only: the id pattern is case-sensitive
            store.isValidId('Constructor').should.be.true();
        });

        it('should reject duplicate ids and enforce field limits', async () => {
            (await store.create({ id: 'dup', name: 'first' })).ok.should.be.true();
            (await store.create({ id: 'dup', name: 'second' })).ok.should.be.false();

            (await store.create({ id: 'ok-id', name: 'n'.repeat(65) })).ok.should.be.false();
            (await store.create({ id: 'ok-id2', name: 'n', maxParticipants: 99 })).ok.should.be.false();
            (await store.create({ id: 'ok-id3', name: 'n', maxParticipants: 1 })).ok.should.be.false();
        });

        it('should update fields and keep blank-password hosts', async () => {
            await store.create({ id: 'upd', name: 'old', hosts: [{ username: 'bob', password: 'pw2' }] });
            const res = await store.update('upd', {
                name: 'new',
                hosts: [
                    { username: 'bob', password: '' },
                    { username: 'carol', password: 'pw3' },
                ],
            });
            res.ok.should.be.true();
            res.channel.name.should.equal('new');
            res.channel.hosts.should.eql(['bob', 'carol']);
            // bob kept the original hash
            (await store.verifyHost('upd', 'bob', 'pw2')).should.be.ok();
            (await store.verifyHost('upd', 'carol', 'pw3')).should.be.ok();
            should(await store.verifyHost('upd', 'carol', 'pw2')).be.null();
        });

        it('should remove channels', async () => {
            await store.create({ id: 'gone', name: 'n' });
            store.remove('gone').ok.should.be.true();
            store.exists('gone').should.be.false();
            store.remove('gone').ok.should.be.false();
        });

        it('should list only public channels for the public list', async () => {
            await store.create({ id: 'pub1', name: 'a', public: true });
            await store.create({ id: 'priv1', name: 'b', public: false });
            store
                .list()
                .map((c) => c.id)
                .should.eql(['pub1']);
            store
                .list({ includePrivate: true })
                .map((c) => c.id)
                .should.eql(['pub1', 'priv1']);
        });
    });

    describe('3. Host verification', () => {
        it('should verify per-channel hosts', async () => {
            const store = newStore('hostauth');
            await store.create({ id: 'chan1', name: 'c', hosts: [{ username: 'alice', password: 'pw1' }] });
            await store.create({ id: 'chan2', name: 'c', hosts: [{ username: 'bob', password: 'pw2' }] });

            (await store.verifyHost('chan1', 'alice', 'pw1')).should.eql({ username: 'alice' });
            // wrong channel / wrong user / wrong password
            should.not.exist(await store.verifyHost('chan2', 'alice', 'pw1'));
            should.not.exist(await store.verifyHost('chan1', 'bob', 'pw1'));
            should.not.exist(await store.verifyHost('chan1', 'alice', 'pw2'));
            should.not.exist(await store.verifyHost('missing', 'alice', 'pw1'));
        });

        it('should fall back to the default moderator secret for host-less channels', async () => {
            const store = newStore('fallback', { defaultModerator: 'letmein' });
            await store.create({ id: 'open', name: 'c' }); // no hosts configured
            await store.create({ id: 'locked', name: 'c', hosts: [{ username: 'a', password: 'b' }] });

            (await store.verifyHost('open', 'anyone', 'letmein')).should.be.ok();
            should.not.exist(await store.verifyHost('open', 'anyone', 'nope'));
            // fallback must NOT apply when the channel has its own hosts
            should.not.exist(await store.verifyHost('locked', 'anyone', 'letmein'));
        });

        it('should re-check host membership for join-time validation', async () => {
            const store = newStore('isHost');
            await store.create({ id: 'chan1', name: 'c', hosts: [{ username: 'alice', password: 'pw' }] });
            store.isHost('chan1', 'alice').should.be.true();
            store.isHost('chan1', 'bob').should.be.false();
            store.isHost('nope', 'alice').should.be.false();
        });
    });

    describe('4. Channel join password', () => {
        it('should set a password on create and never expose the hash', async () => {
            const store = newStore('chanpw');
            (await store.create({ id: 'locked', name: 'c', password: 'open-sesame' })).ok.should.be.true();
            (await store.create({ id: 'open', name: 'c' })).ok.should.be.true();

            store.sanitize(store.get('locked')).hasPassword.should.be.true();
            store.sanitize(store.get('open')).hasPassword.should.be.false();
            // hash never leaks through the sanitized copy
            JSON.stringify(store.sanitize(store.get('locked'))).should.not.containEql('scrypt$');

            (await store.verifyChannelPassword('locked', 'open-sesame')).should.be.true();
            (await store.verifyChannelPassword('locked', 'wrong')).should.be.false();
            (await store.verifyChannelPassword('locked', '')).should.be.false();
            (await store.verifyChannelPassword('locked')).should.be.false();
            (await store.verifyChannelPassword('open', 'anything')).should.be.false(); // no password set
            (await store.verifyChannelPassword('missing', 'open-sesame')).should.be.false();
        });

        it('should keep / replace / clear the password on update (tri-state)', async () => {
            const store = newStore('chanpw-upd');
            await store.create({ id: 'sec', name: 'c', password: 'first' });
            // field omitted -> unchanged
            (await store.update('sec', { name: 'renamed' })).ok.should.be.true();
            (await store.verifyChannelPassword('sec', 'first')).should.be.true();
            // non-empty -> replaced
            (await store.update('sec', { password: 'second' })).ok.should.be.true();
            (await store.verifyChannelPassword('sec', 'first')).should.be.false();
            (await store.verifyChannelPassword('sec', 'second')).should.be.true();
            // '' -> explicitly cleared
            const cleared = await store.update('sec', { password: '' });
            cleared.ok.should.be.true();
            cleared.channel.hasPassword.should.be.false();
            should.not.exist(store.get('sec').passwordHash);
        });

        it('should persist the hash across reloads and reject bad values', async () => {
            const filePath = tempFile('chanpw-file');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            const store = new ChannelStore({ filePath, autoInit: true });
            await store.create({ id: 'keep', name: 'c', password: 'gate' });
            const reloaded = new ChannelStore({ filePath, autoInit: false });
            (await reloaded.verifyChannelPassword('keep', 'gate')).should.be.true();

            (await store.create({ id: 'bad1', name: 'n', password: 'x'.repeat(65) })).ok.should.be.false();
            (await store.create({ id: 'bad2', name: 'n', password: '   ' })).ok.should.be.false();
            (await store.create({ id: 'bad3', name: 'n', password: 123 })).ok.should.be.false();
        });
    });

    describe('5. Admin settings (temp rooms toggle + quotas)', () => {
        it('should default tempRooms to true and honor the env-seeded default', () => {
            newStore('settings-default').getSettings().should.eql(DEFAULT_SETTINGS);
            newStore('settings-env', { defaultSettings: { tempRooms: false } })
                .getSettings()
                .should.eql({ ...DEFAULT_SETTINGS, tempRooms: false });
        });

        it('should toggle settings and persist them across reloads', () => {
            const filePath = tempFile('settings-persist');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            const store = new ChannelStore({ filePath, autoInit: true });

            store
                .updateSettings({ tempRooms: false })
                .should.eql({ ok: true, settings: { ...DEFAULT_SETTINGS, tempRooms: false } });
            const reloaded = new ChannelStore({ filePath, autoInit: false, defaultSettings: { tempRooms: true } });
            // file wins over the env-seeded default once a setting is stored
            reloaded.getSettings().should.eql({ ...DEFAULT_SETTINGS, tempRooms: false });

            store.updateSettings({ tempRooms: true }).ok.should.be.true();
            JSON.parse(fs.readFileSync(filePath, 'utf8')).settings.should.eql({ ...DEFAULT_SETTINGS, tempRooms: true });
        });

        it('should ignore non-boolean / unknown settings and malformed input', () => {
            const store = newStore('settings-bad');
            store.updateSettings({ tempRooms: 'yes' }).ok.should.be.false();
            store.updateSettings({ somethingElse: true }).ok.should.be.true(); // unknown key = no-op
            store.getSettings().should.eql(DEFAULT_SETTINGS);
            store.updateSettings(null).ok.should.be.false();
        });

        it('should validate numeric settings (type/range) and accept numeric strings from forms', () => {
            const store = newStore('settings-numeric');
            store.updateSettings({ tempMaxPerIp: 'x' }).ok.should.be.false();
            store.updateSettings({ tempMaxPerIp: 1.5 }).ok.should.be.false();
            store.updateSettings({ tempMaxPerIp: 101 }).ok.should.be.false();
            store.updateSettings({ tempCreateWindowMin: 0 }).ok.should.be.false();
            store.updateSettings({ socketMaxChannels: true }).ok.should.be.false();
            const res = store.updateSettings({ tempMaxPerIp: '5', tempCreateWindowMin: 30, socketMaxChannels: 3 });
            res.ok.should.be.true();
            res.settings.tempMaxPerIp.should.equal(5);
            res.settings.tempCreateWindowMin.should.equal(30);
            res.settings.socketMaxChannels.should.equal(3);
        });

        it('should persist numeric settings and ignore hand-edited garbage on load', () => {
            const filePath = tempFile('settings-num-persist');
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            const store = new ChannelStore({ filePath, autoInit: true });
            store
                .updateSettings({
                    tempMaxRooms: 50,
                    tempMaxPerIp: 1,
                    tempCreateMax: 2,
                    tempCreateWindowMin: 5,
                    socketMaxChannels: 1,
                })
                .ok.should.be.true();
            new ChannelStore({ filePath, autoInit: false }).getSettings().should.eql({
                ...DEFAULT_SETTINGS,
                tempMaxRooms: 50,
                tempMaxPerIp: 1,
                tempCreateMax: 2,
                tempCreateWindowMin: 5,
                socketMaxChannels: 1,
            });

            // a hand-edited registry with out-of-range values falls back per key
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            raw.settings.tempMaxPerIp = 9999;
            raw.settings.tempRooms = 'nope';
            fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');
            new ChannelStore({ filePath, autoInit: false }).getSettings().should.eql({
                ...DEFAULT_SETTINGS,
                tempMaxRooms: 50,
                tempCreateMax: 2,
                tempCreateWindowMin: 5,
                socketMaxChannels: 1,
            });
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

    describe('6. Temp room cap', () => {
        it('should refuse to create temp rooms beyond MAX_TEMP_ROOMS', () => {
            const store = newStore('tempcap');
            for (let i = 0; i < ChannelStore.MAX_TEMP_ROOMS; i++) {
                should(store.getOrCreateTemp(`tmp-${i}`)).be.ok();
            }
            should(store.getOrCreateTemp('overflow-room')).be.null();
            // existing rooms stay reachable at the cap
            store.getOrCreateTemp('tmp-0').should.be.ok();
        });
    });

    describe('6b. Temp room per-IP quotas', () => {
        const { normalizeIp } = ChannelStore;

        it('should normalize IPs for quota tracking (IPv6 -> /64, mapped v4, ports)', () => {
            normalizeIp('203.0.113.9').should.equal('203.0.113.9');
            normalizeIp('203.0.113.9:8080').should.equal('203.0.113.9');
            normalizeIp('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd').should.equal('2001:0db8:1234:5678');
            normalizeIp('2001:DB8::abcd').should.equal('2001:0db8:0000:0000');
            normalizeIp('[2001:db8::1]:443').should.equal('2001:0db8:0000:0000');
            normalizeIp('::ffff:192.168.1.5').should.equal('192.168.1.5');
            normalizeIp('fe80::1%eth0').should.equal('fe80:0000:0000:0000');
            normalizeIp('').should.equal('');
            normalizeIp(null).should.equal('');
        });

        it('should cap live temp rooms per IP and free quota when rooms close', () => {
            const store = newStore('tempip-cap');
            const ip = '203.0.113.9';
            for (let i = 0; i < ChannelStore.MAX_TEMPS_PER_IP; i++) {
                should(store.getOrCreateTemp(`room-${i}`, { creatorIp: ip })).be.ok();
            }
            // a different visitor is unaffected
            should(store.getOrCreateTemp('other-room', { creatorIp: '198.51.100.7' })).be.ok();
            // ...but IPv6 rotation inside the creator's /64 must not grant fresh quota
            should(store.getOrCreateTemp('v6-a', { creatorIp: '2001:db8::1' })).be.ok();
            should(store.getOrCreateTemp('v6-b', { creatorIp: '2001:db8:0:0:0:0:0:2' })).be.ok();
            should(store.getOrCreateTemp('v6-c', { creatorIp: '2001:db8::3' })).be.ok();
            should(store.getOrCreateTemp('v6-d', { creatorIp: '2001:db8::4' })).be.null();
            should(store.getOrCreateTemp('room-overflow', { creatorIp: ip })).be.null();
            // the last peer leaving releases the slot
            store.removeTempIfEmpty('room-0', 0);
            should(store.getOrCreateTemp('room-new', { creatorIp: ip })).be.ok();
            // an existing room is still reachable at the cap (no new creation)
            store.getOrCreateTemp('room-1', { creatorIp: ip }).id.should.equal('room-1');
        });

        it('should report the exceeded quota with its reason', () => {
            const store = newStore('tempip-reason');
            const ip = '203.0.113.9';
            store.checkTempQuota(ip).should.eql({ ok: true });
            for (let i = 0; i < ChannelStore.MAX_TEMPS_PER_IP; i++) {
                store.getOrCreateTemp(`r-${i}`, { creatorIp: ip });
            }
            store.checkTempQuota(ip).should.eql({ ok: false, reason: 'per-ip-limit' });
            store.removeTemp('r-0');
            store.checkTempQuota(ip).should.eql({ ok: true });
            // no attributable IP -> never per-IP limited (global cap still applies)
            store.checkTempQuota('').should.eql({ ok: true });
        });

        it('should rate-limit create-leave-create churn per IP within the window', () => {
            const store = newStore('tempip-rate');
            const ip = '192.0.2.10';
            for (let i = 0; i < ChannelStore.TEMP_CREATE_MAX_PER_WINDOW; i++) {
                should(store.getOrCreateTemp(`churn-${i}`, { creatorIp: ip })).be.ok();
                store.removeTempIfEmpty(`churn-${i}`, 0); // room gone, creation still counted
            }
            store.checkTempQuota(ip).should.eql({ ok: false, reason: 'rate-limit' });
            should(store.getOrCreateTemp('churn-next', { creatorIp: ip })).be.null();
            // ...until the window has slid past the oldest creation
            store.tempCreateLog.set(ip, [Date.now() - store.settings.tempCreateWindowMin * 60000 - 1]);
            should(store.getOrCreateTemp('churn-next', { creatorIp: ip })).be.ok();
        });

        it('should honor admin-tuned quotas at runtime', () => {
            const store = newStore('tempip-tuned');
            store.updateSettings({ tempMaxPerIp: 1, tempCreateMax: 1 }).ok.should.be.true();
            should(store.getOrCreateTemp('t-one', { creatorIp: '203.0.113.9' })).be.ok();
            should(store.getOrCreateTemp('t-two', { creatorIp: '203.0.113.9' })).be.null(); // per-ip cap 1
            store.checkTempQuota('203.0.113.9').reason.should.equal('per-ip-limit');
            store.removeTempIfEmpty('t-one', 0); // frees the owned slot, creation still counted
            store.checkTempQuota('203.0.113.9').reason.should.equal('rate-limit');
            // 0 = refuse every new temp room for everyone
            store.updateSettings({ tempMaxPerIp: 0 }).ok.should.be.true();
            should(store.getOrCreateTemp('t-three', { creatorIp: '198.51.100.1' })).be.null();
            // …but a room that is already live stays reachable regardless of the quotas
            store.updateSettings({ tempMaxPerIp: 1, tempCreateMax: 5, tempCreateWindowMin: 1 }).ok.should.be.true();
            should(store.getOrCreateTemp('t-live', { creatorIp: '198.51.100.1' })).be.ok();
            store.updateSettings({ tempMaxPerIp: 0, tempMaxRooms: 0 }).ok.should.be.true();
            should(store.getOrCreateTemp('t-four', { creatorIp: '198.51.100.1' })).be.null();
            store.getOrCreateTemp('t-live').id.should.equal('t-live');
        });

        it('should keep creatorIp server-side (never in sanitize/listTemps output)', () => {
            const store = newStore('tempip-sanitize');
            const temp = store.getOrCreateTemp('leaky', { creatorIp: '203.0.113.9' });
            should(store.sanitize(temp).creatorIp).be.undefined();
            JSON.stringify(store.listTemps()).should.not.containEql('203.0.113.9');
        });

        it('should leave legacy calls without creatorIp on the global cap only', () => {
            const store = newStore('tempip-nocreator');
            for (let i = 0; i < ChannelStore.MAX_TEMPS_PER_IP + 2; i++) {
                should(store.getOrCreateTemp(`anon-${i}`)).be.ok();
            }
        });
    });

    describe('7. Registry corruption recovery', () => {
        it('should quarantine an unreadable registry and start empty without a backup', () => {
            const filePath = tempFile('quarantine');
            fs.writeFileSync(filePath, '{ not json', 'utf8');
            const store = new ChannelStore({ filePath, autoInit: false });
            store.channels.should.be.an.Array().and.empty();
            // the broken file was renamed aside, never silently overwritten
            fs.existsSync(`${filePath}.corrupt`).should.be.true();
            fs.readFileSync(`${filePath}.corrupt`, 'utf8').should.equal('{ not json');
            fs.existsSync(filePath).should.be.false();
        });

        it('should restore a quarantined registry from the .bak copy', async () => {
            const filePath = tempFile('quarantine-bak');
            const store = new ChannelStore({ filePath, autoInit: true });
            await store.create({ id: 'keep-me', name: 'kept' });
            await store.create({ id: 'second', name: 'kept2' }); // .bak now holds the pre-write state
            fs.writeFileSync(filePath, 'garbage{', 'utf8'); // corrupt the live file

            const reloaded = new ChannelStore({ filePath, autoInit: false });
            reloaded.exists('keep-me').should.be.true();
            reloaded.exists('second').should.be.false(); // .bak predates the last write
            fs.existsSync(`${filePath}.corrupt`).should.be.true();
        });

        it('should refresh the .bak copy before every save', async () => {
            const filePath = tempFile('bak');
            const store = new ChannelStore({ filePath, autoInit: true });
            await store.create({ id: 'one', name: 'first' });
            fs.existsSync(`${filePath}.bak`).should.be.true();
            JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8')).channels.should.be.empty(); // pre-create state
            await store.create({ id: 'two', name: 'second' });
            JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8'))
                .channels.map((c) => c.id)
                .should.eql(['one']);
        });
    });

    describe('8. Default-moderator fallback tokens', () => {
        it('should mark fallback logins with a via claim and configured hosts without', async () => {
            const store = newStore('fallback-claim', { defaultModerator: 'letmein' });
            await store.create({ id: 'open', name: 'c' });
            await store.create({ id: 'hosted', name: 'c', hosts: [{ username: 'a', password: 'b' }] });

            const fallback = await store.verifyHost('open', 'anyone', 'letmein');
            fallback.should.be.ok();
            fallback.username.should.equal('anyone');
            fallback.via.should.equal('default-moderator');

            (await store.verifyHost('hosted', 'a', 'b')).should.eql({ username: 'a' }); // no via claim
            should.not.exist(await store.verifyHost('open', 'anyone', 'wrong'));
        });

        it('should report hostless channels for the join-time fallback re-check', async () => {
            const store = newStore('hostless', { defaultModerator: 'letmein' });
            await store.create({ id: 'open', name: 'c' });
            await store.create({ id: 'hosted', name: 'c', hosts: [{ username: 'a', password: 'b' }] });
            store.isHostless('open').should.be.true();
            store.isHostless('hosted').should.be.false();
            // configuring a real host revokes the fallback
            await store.update('open', { hosts: [{ username: 'real', password: 'pw' }] });
            store.isHostless('open').should.be.false();
            store.isHostless('missing').should.be.false();
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
            'reserved',
            'tempcap',
            'quarantine',
            'quarantine-bak',
            'bak',
            'fallback-claim',
            'hostless',
        ]) {
            for (const suffix of ['', '.bak', '.corrupt', '.tmp']) {
                const filePath = tempFile(name) + suffix;
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        }
    });

    describe('9. Per-channel chat retention override', () => {
        let store;
        beforeEach(() => {
            store = newStore('retention');
        });
        it('should accept and expose a per-channel retention override', async () => {
            const { channel } = await store.create({ id: 'keep-long', name: 'A', chatRetentionHours: 720 });
            channel.chatRetentionHours.should.equal(720);
            store.sanitize(store.get('keep-long')).chatRetentionHours.should.equal(720);
        });

        it('should inherit the global setting when absent or cleared', async () => {
            const { channel } = await store.create({ id: 'inherit', name: 'B' });
            should(channel.chatRetentionHours).be.null();
            await store.update('inherit', { chatRetentionHours: 0 });
            store.sanitize(store.get('inherit')).chatRetentionHours.should.equal(0);
            await store.update('inherit', { chatRetentionHours: null });
            should(store.sanitize(store.get('inherit')).chatRetentionHours).be.null();
        });

        it('should reject out-of-range or non-integer overrides', async () => {
            (await store.create({ id: 'badret', name: 'C', chatRetentionHours: 9999 })).ok.should.be.false();
            (await store.create({ id: 'badret2', name: 'D', chatRetentionHours: 1.5 })).ok.should.be.false();
            (await store.create({ id: 'badret3', name: 'E', chatRetentionHours: 'abc' })).ok.should.be.false();
        });

        it('should survive a registry reload', async () => {
            await store.create({ id: 'persist', name: 'F', chatRetentionHours: 48 });
            const reloaded = new ChannelStore({ filePath: store.filePath, autoInit: false });
            reloaded.sanitize(reloaded.get('persist')).chatRetentionHours.should.equal(48);
        });
    });

    describe('10. Verbatim passwords + legacy sanitized-hash fallback', () => {
        it('should hash and verify passwords containing markup characters verbatim', async () => {
            const secret = '<b>p&ss</b>"word\'';
            const stored = await hashPassword(secret);
            (await verifyPassword(secret, stored)).should.be.true();
            (await verifyPassword('wrong', stored)).should.be.false();
            // no legacy fallback wired: verifyPasswordCompat behaves like verifyPassword
            (await ChannelStore.verifyPasswordCompat(secret, stored, null)).should.be.true();
            (await ChannelStore.verifyPasswordCompat('wrong', stored, null)).should.be.false();
        });

        it('should keep pre-fix hashes of SANITIZED passwords verifiable via the fallback', async () => {
            const checkXSS = require('../app/src/xss.js');
            const raw = 'a<b>&c';
            const legacyForm = checkXSS(raw);
            legacyForm.should.not.equal(raw); // sanity: the sanitizer really rewrites it
            // a pre-fix registry stored the hash of the SANITIZED form
            const legacyHash = await hashPassword(legacyForm);

            const store = newStore('legacy-pw', { legacySanitize: (pw) => checkXSS(pw) });
            await store.create({ id: 'legacy-chan', name: 'Legacy', password: raw });
            // raw-first verify against the NEW hash
            (await store.verifyChannelPassword('legacy-chan', raw)).should.be.true();

            // plant the legacy hash and verify the raw password still passes
            store.get('legacy-chan').passwordHash = legacyHash;
            (await store.verifyChannelPassword('legacy-chan', raw)).should.be.true();
            (await store.verifyChannelPassword('legacy-chan', 'wrong')).should.be.false();
        });

        it('should verify hosts verbatim and via the legacy fallback', async () => {
            const checkXSS = require('../app/src/xss.js');
            const raw = 'h<b>ost';
            const store = newStore('legacy-host', { legacySanitize: (pw) => checkXSS(pw) });
            await store.create({ id: 'hostchan', name: 'H', hosts: [{ username: 'alice', password: raw }] });
            (await store.verifyHost('hostchan', 'alice', raw)).should.eql({ username: 'alice' });

            store.get('hostchan').hosts[0].passwordHash = await hashPassword(checkXSS(raw));
            (await store.verifyHost('hostchan', 'alice', raw)).should.eql({ username: 'alice' });
            should(await store.verifyHost('hostchan', 'alice', 'wrong')).be.null();
        });
    });

    describe('11. sanitize: host usernames are operator data', () => {
        it('should omit hosts from the public shape and include them for admin', async () => {
            const store = newStore('hosts-gate');
            await store.create({ id: 'hosted', name: 'Hosted', hosts: [{ username: 'alice', password: 'pw1' }] });
            const channel = store.get('hosted');

            should(store.sanitize(channel).hosts).be.undefined();
            store.sanitize(channel, { includePrivate: true }).hosts.should.eql(['alice']);
            // create/update results feed the admin console — they carry hosts
            (
                await store.create({ id: 'hosted2', name: 'H2', hosts: [{ username: 'bob', password: 'pw2' }] })
            ).channel.hosts.should.eql(['bob']);
        });

        it('should never generate an id shadowed by a live temp room', () => {
            const store = newStore('genid');
            for (let i = 0; i < 50; i++) {
                const id = store.generateId();
                store.isTemp(id).should.be.false();
                store.getOrCreateTemp(id);
                store.isTemp(id).should.be.true();
            }
        });
    });
});
