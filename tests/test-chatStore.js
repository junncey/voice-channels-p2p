'use strict';

// npx mocha test-chatStore.js

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');

const ChatStore = require('../app/src/chatStore');

const IMG = (tag, repeat = 16) => `data:image/png;base64,${tag}${'A'.repeat(repeat)}`;

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
            store.append('room1', { name: 'bob', text: 'hi', imgs: [IMG('b1='), IMG('b2=')] });

            const history = store.history('room1').messages;
            history.should.have.length(2);
            history[0].name.should.equal('alice');
            history[0].text.should.equal('hello');
            should.equal(history[0].imgs, undefined); // text-only rows stay compact
            history[1].text.should.equal('hi');
            history[1].imgs.should.have.length(2);
            history[1].imgs[0].should.startWith('data:image/png;base64,b1=');
        });

        it('should trim name/text and reject empty payloads', () => {
            store = newStore('sanitize');
            store.append('room1', { name: 'x'.repeat(99), text: 'y'.repeat(999) });
            const [msg] = store.history('room1').messages;
            msg.name.should.have.length(24);
            msg.text.should.have.length(500);

            should.equal(store.append('room1', { name: 'a', text: '' }), null);
            should.equal(store.append('room1', { name: 'a', text: '   ' }), null);
            // a bogus image payload (not an array) is dropped, the text still lands
            const noImages = store.append('room1', { name: 'a', text: 'ok', imgs: 99 });
            noImages.should.be.an.Object();
            should.equal(noImages.imgs, undefined);
            should.equal(store.append('room1', { name: 'a', text: '', imgs: [] }), null);
        });

        it('should reject invalid ids (path safety) and serve them empty', () => {
            store = newStore('ids');
            should.equal(store.append('../etc/passwd', { name: 'a', text: 'x' }), null);
            should.equal(store.append('', { name: 'a', text: 'x' }), null);
            store.history('../etc/passwd').messages.should.be.empty();
        });

        it('should keep only whitelisted, size-capped image data URLs', () => {
            store = newStore('images');
            // of the five entries only the first is valid (wrong mime, bad
            // base64, non-URL and over-cap rows are dropped)
            const stored = store.append('room1', {
                name: 'a',
                text: '',
                imgs: [
                    IMG('ok='),
                    'data:image/png;base64,!!!',
                    'data:text/html;base64,AAA=',
                    'not-a-data-url',
                    IMG('big=', 1600 * 1024),
                ],
            });
            stored.should.be.an.Object();
            stored.imgs.should.have.length(1);
            stored.imgs[0].should.startWith('data:image/png;base64,ok=');
        });

        it('should serve history inside the catch-up byte budget', () => {
            store = newStore('budget-send');
            store.append('room1', { name: 'a', text: 'old text' });
            store.append('room1', {
                name: 'a',
                text: 'big pics',
                imgs: [IMG('p1=', 400 * 1024), IMG('p2=', 400 * 1024)],
            });
            store.append('room1', { name: 'a', text: 'fresh text' });

            // default budget: everything fits
            store.history('room1').messages.should.have.length(3);
            // 512KB budget: the newest row plus the 800KB image row would not
            // fit → the newest row (always included) + nothing older, and the
            // page reports there is more behind it
            const trimmed = store.history('room1', { maxBytes: 512 * 1024 });
            trimmed.messages.should.have.length(1);
            trimmed.messages[0].text.should.equal('fresh text');
            trimmed.hasMore.should.be.true();
        });

        it('should serve at most the requested page size', () => {
            store = newStore('cap');
            const base = Date.now() - 60 * 1000; // inside the retention window
            for (let i = 0; i < ChatStore.MAX_MESSAGES + 20; i++) {
                // unique ts: a same-ts group may legitimately swell a page
                // (the boundary never splits one), keep this case exact
                store.append('room1', { name: 'a', text: `m${i}` }, { ts: base + i });
            }
            // 320 sent → stored capped at MAX_MESSAGES (oldest shifted off),
            // one page serves only the newest CHAT_PAGE_SIZE of what remains
            const page = store.history('room1');
            page.messages.should.have.length(ChatStore.CHAT_PAGE_SIZE);
            page.messages[0].text.should.equal(`m${ChatStore.MAX_MESSAGES + 20 - ChatStore.CHAT_PAGE_SIZE}`);
            page.messages[page.messages.length - 1].text.should.equal(`m${ChatStore.MAX_MESSAGES + 19}`);
            page.hasMore.should.be.true();
        });

        it('should page backwards without duplicates or gaps', () => {
            store = newStore('paging');
            const total = ChatStore.CHAT_PAGE_SIZE * 2 + 7; // not a page multiple
            const base = Date.now() - 60 * 1000; // inside the retention window
            for (let i = 0; i < total; i++) {
                store.append('room1', { name: 'a', text: `m${i}` }, { ts: base + i });
            }

            // walk from the newest end back until the store reports done
            const seen = [];
            let before = 0;
            for (let guard = 0; guard < 100; guard++) {
                const page = store.history('room1', { before });
                if (!page.messages.length) break;
                page.messages.should.have.length(Math.min(ChatStore.CHAT_PAGE_SIZE, total - seen.length));
                seen.unshift(...page.messages.map((m) => m.text));
                page.hasMore.should.equal(seen.length < total);
                before = page.messages[0].ts;
                if (!page.hasMore) break;
            }
            seen.should.have.length(total);
            seen.should.eql(Array.from({ length: total }, (_, i) => `m${i}`)); // oldest → newest, no dupes
        });

        it('should move a group sharing one ts to a single page whole', () => {
            store = newStore('same-ts');
            const base = Date.now() - 60 * 1000; // inside the retention window
            // 12 rows on the SAME millisecond plus one older row below them
            store.append('room1', { name: 'a', text: 'bottom' }, { ts: base - 500 });
            for (let i = 0; i < 12; i++) {
                store.append('room1', { name: 'a', text: `same${i}` }, { ts: base });
            }

            const first = store.history('room1');
            // the limit cut heals to the group boundary: the whole group
            // ships on one page (12 rows > the page size) rather than being
            // split across a cursor that cannot address its halves
            first.messages.map((m) => m.text).should.eql(Array.from({ length: 12 }, (_, i) => `same${i}`));
            first.hasMore.should.be.true();

            // paging back with the group's ts skips the whole group at once —
            // no row of it re-appears, nothing is lost
            const second = store.history('room1', { before: first.messages[0].ts });
            second.messages.map((m) => m.text).should.eql(['bottom']);
            second.hasMore.should.be.false();
        });

        it('should serve an empty page when the cursor predates everything', () => {
            store = newStore('exhausted');
            store.append('room1', { name: 'a', text: 'x' });
            const page = store.history('room1', { before: 1 });
            page.messages.should.be.empty();
            page.hasMore.should.be.false();
        });
    });

    describe('1. retention window', () => {
        it('should prune messages older than the window', () => {
            store = newStore('prune', { retentionHours: 1 });
            const now = Date.now();
            store.append('room1', { name: 'a', text: 'old' }, { ts: now - 2 * 60 * 60 * 1000 });
            store.append('room1', { name: 'a', text: 'fresh' }, { ts: now });
            store
                .history('room1')
                .messages.map((m) => m.text)
                .should.eql(['fresh']);
        });

        it('should keep nothing while retention is 0', () => {
            store = newStore('zero', { retentionHours: 0 });
            should.equal(store.append('room1', { name: 'a', text: 'x' }), null);
            store.history('room1').messages.should.be.empty();
            fs.readdirSync(store.dir).should.be.empty();
        });

        it('should follow live admin setting changes via the getter', () => {
            let hours = 24;
            store = newStore('live', { retentionHours: () => hours });
            store.append('room1', { name: 'a', text: 'kept' });
            hours = 0;
            store.history('room1').messages.should.be.empty();
            hours = 24;
            store.history('room1').messages.should.have.length(1);
        });
    });

    describe('2. persistence', () => {
        it('should survive a reload from disk (text and images)', () => {
            const dir = tempDir('reload');
            const first = new ChatStore({ dir, sweepMs: 0 });
            first.append('room1', { name: 'a', text: 'persisted' });
            first.append('room1', { name: 'b', text: 'pic', imgs: [IMG('keep=')] });
            first.destroy();

            const second = new ChatStore({ dir, sweepMs: 0 });
            const history = second.history('room1').messages;
            history.should.have.length(2);
            history[0].text.should.equal('persisted');
            history[1].imgs.should.eql([IMG('keep=')]);
            second.destroy();
        });

        it('should keep loading legacy rows that stored an image count only', () => {
            const dir = tempDir('legacy');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'room1.json'),
                JSON.stringify({
                    version: 1,
                    messages: [
                        { ts: Date.now() - 1000, name: 'a', text: 'old text', imgs: 0 },
                        { ts: Date.now(), name: 'a', text: '', imgs: 2 },
                    ],
                }),
                'utf8'
            );

            const legacyStore = new ChatStore({ dir, sweepMs: 0 });
            const history = legacyStore.history('room1').messages;
            history.should.have.length(2);
            history[0].text.should.equal('old text');
            history[1].imgs.should.equal(2); // count preserved as-is; the client renders the placeholder
            legacyStore.destroy();
        });

        it('should quarantine a corrupt history file', () => {
            const dir = tempDir('corrupt');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'room1.json'), '{ not json', 'utf8');

            const corruptStore = new ChatStore({ dir, sweepMs: 0 });
            corruptStore.history('room1').messages.should.be.empty();
            fs.existsSync(path.join(dir, 'room1.json.corrupt')).should.be.true();
            corruptStore.destroy();
        });

        it('should never write temp room history to disk', () => {
            store = newStore('temp');
            store.append('room1', { name: 'a', text: 'x' }, { persistent: false });
            store.history('room1', { persistent: false }).messages.should.have.length(1);
            fs.readdirSync(store.dir).should.be.empty();
        });

        it('should drop rows past the per-file disk budget', () => {
            // small budget so the shrink loop is exercised quickly
            store = newStore('budget', { maxBytes: 4096 });
            for (let i = 0; i < 40; i++) {
                store.append('room1', { name: 'a', text: 'x'.repeat(500) });
            }
            const history = store.history('room1').messages;
            history.length.should.be.below(40);
            history[history.length - 1].text.should.equal('x'.repeat(500)); // newest kept
            fs.statSync(store.fileFor('room1')).size.should.be.below(4096);
        });

        it('should delete history together with the channel', () => {
            store = newStore('remove');
            store.append('room1', { name: 'a', text: 'x' });
            store.removeChannel('room1');
            store.history('room1').messages.should.be.empty();
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

            sweepStore.history('gone').messages.should.be.empty();
            fs.existsSync(sweepStore.fileFor('gone')).should.be.false();
            sweepStore.history('kept').messages.should.have.length(1);
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
            fs.readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .should.be.empty();
            zeroStore.destroy();
        });
    });

    describe('5. reply quotes + per-channel retention + exportAll', () => {
        it('should persist the reply quote with the row and cap its size', () => {
            store = newStore('reply');
            const row = store.append('room1', {
                name: 'alice',
                text: 'answer',
                reply: { name: 'bob', text: 'x'.repeat(300), ts: 123 },
            });
            row.reply.name.should.equal('bob');
            row.reply.text.length.should.equal(80);
            row.reply.ts.should.equal(123);
            // invalid shapes are dropped, the message stays
            const bad = store.append('room1', { name: 'alice', text: 'no reply', reply: { name: 'x' } });
            should(bad.reply).be.undefined();
        });

        it('should honor a per-channel retention override from the resolver', () => {
            const hours = { roomA: 0, roomB: 1000 };
            store = newStore('per-channel', { retentionHours: (id) => hours[id] ?? 24 });
            // override 0 = keep nothing for roomA
            should(store.append('roomA', { name: 'a', text: 'gone' })).be.null();
            // roomB keeps rows
            const row = store.append('roomB', { name: 'b', text: 'kept' });
            row.text.should.equal('kept');
            // default applies elsewhere
            store.append('roomC', { name: 'c', text: 'also kept' }).text.should.equal('also kept');
        });

        it('should keep a channel override alive even when the global window is off', () => {
            // global 0 = keep nothing, but a channel may explicitly opt in —
            // sweep() must not wipe it on the global rule alone
            const hours = { keep: 48 };
            store = newStore('global-off', { retentionHours: (id) => hours[id] ?? 0 });
            store.append('keep', { name: 'a', text: 'kept' });
            store.append('plain', { name: 'a', text: 'dropped' });
            should(store.history('plain').messages).be.empty();
            store.sweep();
            store.history('keep').messages.should.have.length(1);
        });

        it('should prune per-channel inside sweep and exportAll', () => {
            const hours = { fast: 1, slow: 1000 };
            store = newStore('sweep-id', { retentionHours: (id) => hours[id] ?? 24 });
            const old = Date.now() - 5 * 60 * 60 * 1000; // 5h ago
            store.append('fast', { name: 'a', text: 'old' }, { ts: old });
            store.append('slow', { name: 'a', text: 'old' }, { ts: old });
            store.sweep();
            store.history('fast').messages.should.be.empty();
            store.history('slow').messages.should.have.length(1);
            // exportAll mirrors the pruned view
            store.append('slow', { name: 'a', text: 'new' });
            store
                .exportAll('slow')
                .map((m) => m.text)
                .should.eql(['old', 'new']);
            // exported rows are copies — mutating them cannot corrupt the store
            store.exportAll('slow')[0].text = 'hacked';
            store.exportAll('slow')[0].text.should.equal('old');
        });
    });

    describe('4. JSONL append-only storage', () => {
        it('should store one line per message instead of rewriting the file', () => {
            store = newStore('jsonl');
            store.append('room1', { name: 'a', text: 'one' });
            store.append('room1', { name: 'a', text: 'two' });
            const file = path.join(store.dir, 'room1.jsonl');
            fs.existsSync(file).should.be.true();
            const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
            lines.should.have.length(2);
            JSON.parse(lines[0]).text.should.equal('one');
            JSON.parse(lines[1]).text.should.equal('two');
        });

        it('should migrate a legacy .json file to .jsonl on first load and drop the old file', () => {
            const dir = tempDir('migrate');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'old.json'),
                JSON.stringify({ version: 1, messages: [{ ts: Date.now(), name: 'a', text: 'kept' }] }),
                'utf8'
            );
            const migrated = new ChatStore({ dir, sweepMs: 0 });
            migrated
                .history('old')
                .messages.map((m) => m.text)
                .should.eql(['kept']);
            fs.existsSync(path.join(dir, 'old.jsonl')).should.be.true();
            fs.existsSync(path.join(dir, 'old.json')).should.be.false();
            migrated.destroy();
        });

        it('should enforce the disk budget in bytes, not UTF-16 code units (CJK)', () => {
            // 3 bytes per CJK char in UTF-8 vs 1 in String#length: a budget
            // measured in code units let a Chinese channel grow ~3x past it
            const maxBytes = 4096;
            store = newStore('cjk-budget', { maxBytes });
            for (let i = 0; i < 200; i++) {
                store.append('room1', { name: '张三', text: '汉字内容重复填充'.repeat(10) + i });
            }
            const file = path.join(store.dir, 'room1.jsonl');
            const size = fs.statSync(file).size;
            size.should.be.belowOrEqual(maxBytes);
            // and the newest row must still be there
            store.history('room1').messages.at(-1).text.should.endWith('199');
        });

        it('should survive a torn trailing line (crash mid-append)', () => {
            const dir = tempDir('torn');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                path.join(dir, 'room1.jsonl'),
                JSON.stringify({ ts: Date.now(), name: 'a', text: 'ok' }) + '\n{"ts":1,"name":"a","text":"to',
                'utf8'
            );
            const torn = new ChatStore({ dir, sweepMs: 0 });
            torn.history('room1')
                .messages.map((m) => m.text)
                .should.eql(['ok']);
            torn.destroy();
        });

        it('should quarantine a fully garbled JSONL file', () => {
            const dir = tempDir('garbled');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'room1.jsonl'), '###\n???\n!!!', 'utf8');
            const garbled = new ChatStore({ dir, sweepMs: 0 });
            garbled.history('room1').messages.should.be.empty();
            fs.existsSync(path.join(dir, 'room1.jsonl.corrupt')).should.be.true();
            garbled.destroy();
        });

        it('should pick up disk state after reload()', () => {
            store = newStore('reload-method');
            store.append('room1', { name: 'a', text: 'on disk' });
            store.channels.get('room1').messages.length = 0; // simulate stale memory
            store.reload();
            store
                .history('room1')
                .messages.map((m) => m.text)
                .should.eql(['on disk']);
        });
    });

    describe('6. edit / recall / reactions', () => {
        it('should edit a row in place and flag it', () => {
            const dir = tempDir('edit');
            const ts = Date.now() - 1000;
            const first = new ChatStore({ dir, sweepMs: 0 });
            first.append('room1', { name: 'a', text: 'before' }, { ts });
            first.destroy();

            const second = new ChatStore({ dir, sweepMs: 0 });
            const updated = second.edit('room1', { ts, name: 'a', text: '  after  ' });
            updated.text.should.equal('after');
            updated.edited.should.be.true();
            second.destroy();

            const third = new ChatStore({ dir, sweepMs: 0 });
            third.history('room1').messages[0].text.should.equal('after');
            third.history('room1').messages[0].edited.should.be.true();
            third.destroy();
        });

        it('should refuse edits to other senders or missing rows', () => {
            store = newStore('edit-guard');
            const ts = Date.now() - 1000;
            store.append('room1', { name: 'a', text: 'mine' }, { ts });
            should.equal(store.edit('room1', { ts, name: 'b', text: 'x' }), null);
            should.equal(store.edit('room1', { ts: ts - 5000, name: 'a', text: 'x' }), null);
            should.equal(store.edit('room1', { ts, name: 'a', text: '   ' }), null);
        });

        it('should recall into a tombstone that keeps paging cursors stable', () => {
            store = newStore('recall');
            const oldTs = Date.now() - 1000;
            const newTs = Date.now();
            store.append('room1', { name: 'a', text: 'old' }, { ts: oldTs });
            store.append('room1', { name: 'a', text: 'gone soon' }, { ts: newTs });
            const tomb = store.remove('room1', { ts: newTs, name: 'a' });
            tomb.deleted.should.be.true();
            should.equal(tomb.text, '');
            const messages = store.history('room1').messages;
            messages.should.have.length(2); // the row stays as a tombstone
            messages[1].deleted.should.be.true();
            should.equal(messages[1].imgs, undefined);
            // a tombstone cannot be edited or re-recalled
            should.equal(store.edit('room1', { ts: newTs, name: 'a', text: 'zombie' }), null);
            should.equal(store.remove('room1', { ts: newTs, name: 'a' }), null);
        });

        it('should toggle reactions per reactor and cap the shape', () => {
            store = newStore('react');
            const ts = Date.now() - 1000;
            store.append('room1', { name: 'a', text: 'hello' }, { ts });
            const add = store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });
            add.reactions.should.eql({ '👍': ['b'] });
            // same reactor twice = no duplicate; a second reactor joins in
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'c' });
            store.history('room1').messages[0].reactions.should.eql({ '👍': ['b', 'c'] });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b', op: 'remove' });
            store.history('room1').messages[0].reactions.should.eql({ '👍': ['c'] });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'c', op: 'remove' });
            should.equal(store.history('room1').messages[0].reactions, undefined);
            // distinct-emoji cap (8): a 9th distinct emoji is refused
            for (const emoji of ['😀', '😁', '😂', '🤣', '😅', '😆', '😉', '😊']) {
                store.react('room1', { ts, name: 'a', emoji, who: 'b' });
            }
            const capped = store.react('room1', { ts, name: 'a', emoji: '😏', who: 'b' });
            Object.keys(capped.reactions).should.have.length(8);
        });

        it('should work for in-memory temp rooms too', () => {
            store = newStore('temp-lifecycle');
            const ts = Date.now();
            store.append('tmp1', { name: 'a', text: 'x' }, { persistent: false, ts });
            store.edit('tmp1', { ts, name: 'a', text: 'y' }, { persistent: false }).text.should.equal('y');
            store.remove('tmp1', { ts, name: 'a' }, { persistent: false }).deleted.should.be.true();
            fs.readdirSync(store.dir).should.be.empty();
        });
    });
});
