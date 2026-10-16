'use strict';

// npx mocha test-chatStore.js

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');

const ChatStore = require('../app/src/chatStore');

function tempDir(name) {
    const dir = path.join(os.tmpdir(), `mirotalk-chat-test-${process.pid}-${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return dir;
}

function newStore(name, opts = {}) {
    return new ChatStore({ dir: tempDir(name), sweepMs: 0, ...opts });
}

describe('test-chatStore', () => {
    let store;
    afterEach(() => {
        store?.destroy();
        store = null;
    });

    describe('0. append + history', () => {
        it('should store and return messages oldest-first', () => {
            store = newStore('basic');
            store.append('room1', { name: 'alice', text: 'hello' });
            store.append('room1', { name: 'bob', text: 'hi', imgs: 2 });

            const history = store.history('room1');
            history.should.have.length(2);
            history[0].name.should.equal('alice');
            history[0].text.should.equal('hello');
            history[0].imgs.should.equal(0);
            history[1].text.should.equal('hi');
            history[1].imgs.should.equal(2);
        });

        it('should trim name/text and reject empty payloads', () => {
            store = newStore('sanitize');
            store.append('room1', { name: 'x'.repeat(99), text: 'y'.repeat(999) });
            const [msg] = store.history('room1');
            msg.name.should.have.length(24);
            msg.text.should.have.length(500);

            should.equal(store.append('room1', { name: 'a', text: '' }), null);
            should.equal(store.append('room1', { name: 'a', text: '   ' }), null);
            // a bogus image count is clamped to none, the text itself still lands
            const clamped = store.append('room1', { name: 'a', text: 'ok', imgs: 99 });
            clamped.should.be.an.Object();
            clamped.imgs.should.equal(0);
        });

        it('should reject invalid ids (path safety) and serve them empty', () => {
            store = newStore('ids');
            should.equal(store.append('../etc/passwd', { name: 'a', text: 'x' }), null);
            should.equal(store.append('', { name: 'a', text: 'x' }), null);
            store.history('../etc/passwd').should.be.empty();
        });

        it('should cap the number of stored messages', () => {
            store = newStore('cap');
            for (let i = 0; i < ChatStore.MAX_MESSAGES + 20; i++) {
                store.append('room1', { name: 'a', text: `m${i}` });
            }
            const history = store.history('room1');
            history.should.have.length(ChatStore.MAX_MESSAGES);
            history[0].text.should.equal('m20'); // oldest dropped
            history[history.length - 1].text.should.equal(`m${ChatStore.MAX_MESSAGES + 19}`);
        });
    });

    describe('1. retention window', () => {
        it('should prune messages older than the window', () => {
            store = newStore('prune', { retentionHours: 1 });
            const now = Date.now();
            store.append('room1', { name: 'a', text: 'old' }, { ts: now - 2 * 60 * 60 * 1000 });
            store.append('room1', { name: 'a', text: 'fresh' }, { ts: now });
            store.history('room1').map((m) => m.text).should.eql(['fresh']);
        });

        it('should keep nothing while retention is 0', () => {
            store = newStore('zero', { retentionHours: 0 });
            should.equal(store.append('room1', { name: 'a', text: 'x' }), null);
            store.history('room1').should.be.empty();
            fs.readdirSync(store.dir).should.be.empty();
        });

        it('should follow live admin setting changes via the getter', () => {
            let hours = 24;
            store = newStore('live', { retentionHours: () => hours });
            store.append('room1', { name: 'a', text: 'kept' });
            hours = 0;
            store.history('room1').should.be.empty();
            hours = 24;
            store.history('room1').should.have.length(1);
        });
    });

    describe('2. persistence', () => {
        it('should survive a reload from disk', () => {
            const dir = tempDir('reload');
            const first = new ChatStore({ dir, sweepMs: 0 });
            first.append('room1', { name: 'a', text: 'persisted' });
            first.destroy();

            const second = new ChatStore({ dir, sweepMs: 0 });
            second.history('room1')[0].text.should.equal('persisted');
            second.destroy();
        });

        it('should quarantine a corrupt history file', () => {
            const dir = tempDir('corrupt');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'room1.json'), '{ not json', 'utf8');

            const corruptStore = new ChatStore({ dir, sweepMs: 0 });
            corruptStore.history('room1').should.be.empty();
            fs.existsSync(path.join(dir, 'room1.json.corrupt')).should.be.true();
            corruptStore.destroy();
        });

        it('should never write temp room history to disk', () => {
            store = newStore('temp');
            store.append('room1', { name: 'a', text: 'x' }, { persistent: false });
            store.history('room1', { persistent: false }).should.have.length(1);
            fs.readdirSync(store.dir).should.be.empty();
        });

        it('should drop rows past the per-file disk budget', () => {
            // small budget so the shrink loop is exercised quickly
            store = newStore('budget', { maxBytes: 4096 });
            for (let i = 0; i < 40; i++) {
                store.append('room1', { name: 'a', text: 'x'.repeat(500) });
            }
            const history = store.history('room1');
            history.length.should.be.below(40);
            history[history.length - 1].text.should.equal('x'.repeat(500)); // newest kept
            fs.statSync(store.fileFor('room1')).size.should.be.below(4096);
        });

        it('should delete history together with the channel', () => {
            store = newStore('remove');
            store.append('room1', { name: 'a', text: 'x' });
            store.removeChannel('room1');
            store.history('room1').should.be.empty();
            fs.readdirSync(store.dir).should.be.empty();
        });
    });

    describe('3. sweep', () => {
        it('should prune both memory and disk files', () => {
            const dir = tempDir('sweep');
            const sweepStore = new ChatStore({ dir, retentionHours: 1, sweepMs: 0 });
            sweepStore.append('gone', { name: 'a', text: 'old' }, { ts: Date.now() - 5 * 60 * 60 * 1000 });
            sweepStore.append('kept', { name: 'a', text: 'fresh' });
            sweepStore.sweep();

            sweepStore.history('gone').should.be.empty();
            fs.existsSync(sweepStore.fileFor('gone')).should.be.false();
            sweepStore.history('kept').should.have.length(1);
            sweepStore.destroy();
        });

        it('should prune files of channels not in memory too', () => {
            const dir = tempDir('sweep-idle');
            const writer = new ChatStore({ dir, retentionHours: 1, sweepMs: 0 });
            writer.append('idle', { name: 'a', text: 'ancient' }, { ts: Date.now() - 9 * 60 * 60 * 1000 });
            writer.destroy();

            const idleStore = new ChatStore({ dir, retentionHours: 1, sweepMs: 0 });
            idleStore.sweep();
            fs.existsSync(idleStore.fileFor('idle')).should.be.false();
            idleStore.destroy();
        });

        it('should wipe everything when retention is 0', () => {
            const dir = tempDir('sweep-zero');
            const writer = new ChatStore({ dir, retentionHours: 24, sweepMs: 0 });
            writer.append('room1', { name: 'a', text: 'x' });
            writer.destroy();

            const zeroStore = new ChatStore({ dir, retentionHours: 0, sweepMs: 0 });
            zeroStore.sweep();
            fs.readdirSync(dir).filter((f) => f.endsWith('.json')).should.be.empty();
            zeroStore.destroy();
        });
    });
});
