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
            should.equal(history[0].imgs, undefined); // 纯文字行保持紧凑
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
            // 非法图片负载（非数组）被丢弃，文字照常入库
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
            // 五个条目只有第一个合法（错误 mime、坏 base64、非 data URL
            // 和超上限的行都会被丢弃）
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

            // 默认预算：全部装得下
            store.history('room1').messages.should.have.length(3);
            // 512KB 预算：最新行加上 800KB 图片行装不下 → 只剩最新行
            // （永远保留）+ 更早的行一概不给，
            // 且分页报告其后还有更多
            const trimmed = store.history('room1', { maxBytes: 512 * 1024 });
            trimmed.messages.should.have.length(1);
            trimmed.messages[0].text.should.equal('fresh text');
            trimmed.hasMore.should.be.true();
        });

        it('should serve at most the requested page size', () => {
            store = newStore('cap');
            const base = Date.now() - 60 * 1000; // 在保留窗口期内
            for (let i = 0; i < ChatStore.MAX_MESSAGES + 20; i++) {
                // ts 唯一：同 ts 消息组可以合理地把一页撑大（页边界从不
                // 切开一组），这里保持精确逐条的情况
                store.append('room1', { name: 'a', text: `m${i}` }, { ts: base + i });
            }
            // 发了 320 条 → 存储被裁到 MAX_MESSAGES（最老的被挤出），
            // 一页只下发剩余内容中最新的 CHAT_PAGE_SIZE 条
            const page = store.history('room1');
            page.messages.should.have.length(ChatStore.CHAT_PAGE_SIZE);
            page.messages[0].text.should.equal(`m${ChatStore.MAX_MESSAGES + 20 - ChatStore.CHAT_PAGE_SIZE}`);
            page.messages[page.messages.length - 1].text.should.equal(`m${ChatStore.MAX_MESSAGES + 19}`);
            page.hasMore.should.be.true();
        });

        it('should page backwards without duplicates or gaps', () => {
            store = newStore('paging');
            const total = ChatStore.CHAT_PAGE_SIZE * 2 + 7; // 不是页大小的整数倍
            const base = Date.now() - 60 * 1000; // 在保留窗口期内
            for (let i = 0; i < total; i++) {
                store.append('room1', { name: 'a', text: `m${i}` }, { ts: base + i });
            }

            // 从最新端往回走，直到 store 报告取完
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
            seen.should.eql(Array.from({ length: total }, (_, i) => `m${i}`)); // 最老 → 最新，无重复
        });

        it('should move a group sharing one ts to a single page whole', () => {
            store = newStore('same-ts');
            const base = Date.now() - 60 * 1000; // 在保留窗口期内
            // 12 行落在同一毫秒，下面再压一行更早的
            store.append('room1', { name: 'a', text: 'bottom' }, { ts: base - 500 });
            for (let i = 0; i < 12; i++) {
                store.append('room1', { name: 'a', text: `same${i}` }, { ts: base });
            }

            const first = store.history('room1');
            // 截断愈合到组边界：整组（12 行 > 页大小）一次性发在同一页，
            // 而不是被一个无法寻址其中一半的游标切开
            //
            first.messages.map((m) => m.text).should.eql(Array.from({ length: 12 }, (_, i) => `same${i}`));
            first.hasMore.should.be.true();

            // 以组的 ts 向前翻页时整组一次跳过——组内任何一行都不会
            // 再次出现，也不会丢失
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
            history[1].imgs.should.equal(2); // 原样保留计数；占位图由客户端渲染
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
            // 预算取小值，让收缩循环很快被触发
            store = newStore('budget', { maxBytes: 4096 });
            for (let i = 0; i < 40; i++) {
                store.append('room1', { name: 'a', text: 'x'.repeat(500) });
            }
            const history = store.history('room1').messages;
            history.length.should.be.below(40);
            history[history.length - 1].text.should.equal('x'.repeat(500)); // 最新一条保留
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
            // 非法形态被丢弃，消息本身保留
            const bad = store.append('room1', { name: 'alice', text: 'no reply', reply: { name: 'x' } });
            should(bad.reply).be.undefined();
        });

        it('should honor a per-channel retention override from the resolver', () => {
            const hours = { roomA: 0, roomB: 1000 };
            store = newStore('per-channel', { retentionHours: (id) => hours[id] ?? 24 });
            // 覆盖值 0 = roomA 什么都不留
            should(store.append('roomA', { name: 'a', text: 'gone' })).be.null();
            // roomB 保留行
            const row = store.append('roomB', { name: 'b', text: 'kept' });
            row.text.should.equal('kept');
            // 其余频道套用默认值
            store.append('roomC', { name: 'c', text: 'also kept' }).text.should.equal('also kept');
        });

        it('should keep a channel override alive even when the global window is off', () => {
            // 全局 0 = 一概不留，但频道可以显式选择保留——
            // sweep() 不得只凭全局规则把它清掉
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
            const old = Date.now() - 5 * 60 * 60 * 1000; // 5 小时前
            store.append('fast', { name: 'a', text: 'old' }, { ts: old });
            store.append('slow', { name: 'a', text: 'old' }, { ts: old });
            store.sweep();
            store.history('fast').messages.should.be.empty();
            store.history('slow').messages.should.have.length(1);
            // exportAll 与修剪后的视图一致
            store.append('slow', { name: 'a', text: 'new' });
            store
                .exportAll('slow')
                .map((m) => m.text)
                .should.eql(['old', 'new']);
            // 导出的行是副本——改坏它们也不会污染 store
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
            // UTF-8 中每个汉字 3 字节，而 String#length 只算 1：按 code unit
            // 计的预算会让中文频道悄悄膨胀到预算的 ~3 倍
            const maxBytes = 4096;
            store = newStore('cjk-budget', { maxBytes });
            for (let i = 0; i < 200; i++) {
                store.append('room1', { name: '张三', text: '汉字内容重复填充'.repeat(10) + i });
            }
            const file = path.join(store.dir, 'room1.jsonl');
            const size = fs.statSync(file).size;
            size.should.be.belowOrEqual(maxBytes);
            // 且最新一行必须仍在
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
            store.channels.get('room1').messages.length = 0; // 模拟内存过期
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
            messages.should.have.length(2); // 该行以墓碑形式保留
            messages[1].deleted.should.be.true();
            should.equal(messages[1].imgs, undefined);
            // 墓碑不可再编辑，也不可再次撤回
            should.equal(store.edit('room1', { ts: newTs, name: 'a', text: 'zombie' }), null);
            should.equal(store.remove('room1', { ts: newTs, name: 'a' }), null);
        });

        it('should toggle reactions per reactor and cap the shape', () => {
            store = newStore('react');
            const ts = Date.now() - 1000;
            store.append('room1', { name: 'a', text: 'hello' }, { ts });
            const add = store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });
            add.reactions.should.eql({ '👍': ['b'] });
            // 同一 reactor 两次 = 不产生重复；第二个 reactor 加入
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'c' });
            store.history('room1').messages[0].reactions.should.eql({ '👍': ['b', 'c'] });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b', op: 'remove' });
            store.history('room1').messages[0].reactions.should.eql({ '👍': ['c'] });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'c', op: 'remove' });
            should.equal(store.history('room1').messages[0].reactions, undefined);
            // 去重 emoji 上限（8）：第 9 种 emoji 被拒绝
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

    describe('7. event-line write path (no rewrites on the interaction path)', () => {
        it('should append one event line per lifecycle op without touching base rows', () => {
            store = newStore('events');
            const ts = Date.now() - 60 * 1000;
            store.append('room1', { name: 'a', text: 'm1' }, { ts });
            store.append('room1', { name: 'a', text: 'm2' }, { ts: ts + 1 });
            const file = store.fileFor('room1');
            const before = fs.readFileSync(file, 'utf8');
            const sizeBefore = fs.statSync(file).size;

            store.edit('room1', { ts, name: 'a', text: 'm1 edited' });
            store.remove('room1', { ts: ts + 1, name: 'a' });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });

            const after = fs.readFileSync(file, 'utf8');
            after.should.startWith(before); // 纯追加：基础行字节级不变
            const lines = after.split('\n').filter(Boolean);
            lines.should.have.length(5); // 2 条基础 + edit + del + react
            JSON.parse(lines[2]).should.eql({ e: 'edit', ts, name: 'a', text: 'm1 edited' });
            JSON.parse(lines[3]).should.eql({ e: 'del', ts: ts + 1, name: 'a' });
            JSON.parse(lines[4]).should.eql({ e: 'react', ts, name: 'a', emoji: '👍', who: 'b', op: 'add' });
            fs.statSync(file).size.should.be.above(sizeBefore);
        });

        it('should not persist a no-op reaction (capped or repeated)', () => {
            store = newStore('react-noop');
            const ts = Date.now() - 1000;
            store.append('room1', { name: 'a', text: 'm1' }, { ts });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });
            const file = store.fileFor('room1');
            // 重复 add / 移除不存在的回应都是 no-op：不写任何行
            const afterFirst = fs.readFileSync(file, 'utf8');
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'nobody', op: 'remove' });
            fs.readFileSync(file, 'utf8').should.equal(afterFirst);
            // 去重 emoji 上限（8）：第 9 种被拒，同样不写行
            for (const emoji of ['😀', '😁', '😂', '🤣', '😅', '😆', '😉', '😊']) {
                store.react('room1', { ts, name: 'a', emoji, who: 'b' });
            }
            const afterCap = fs.readFileSync(file, 'utf8');
            afterCap.should.not.equal(afterFirst); // 8 次合法 add 都已落盘
            store.react('room1', { ts, name: 'a', emoji: '😏', who: 'b' }); // 被上限挡下
            fs.readFileSync(file, 'utf8').should.equal(afterCap);
        });

        it('should replay event lines into the exact same history after reload', () => {
            const dir = tempDir('replay');
            const ts = Date.now() - 60 * 1000;
            const first = new ChatStore({ dir, sweepMs: 0 });
            first.append('room1', { name: 'a', text: 'm1', imgs: [IMG('r1=')] }, { ts });
            first.append('room1', { name: 'b', text: 'm2', reply: { name: 'a', text: 'm1', ts } }, { ts: ts + 1 });
            first.edit('room1', { ts, name: 'a', text: 'm1 edited' });
            first.react('room1', { ts: ts + 1, name: 'b', emoji: '🎉', who: 'a' });
            first.remove('room1', { ts, name: 'a' }); // 把被编辑的行打成墓碑
            const expected = first.exportAll('room1');
            first.destroy();

            const second = new ChatStore({ dir, sweepMs: 0 });
            second.exportAll('room1').should.eql(expected);
            second.destroy();
        });

        it('should round-trip a mixed op sequence exactly', () => {
            const dir = tempDir('roundtrip');
            const first = new ChatStore({ dir, sweepMs: 0 });
            const base = Date.now() - 60 * 1000;
            const rows = [];
            for (let i = 0; i < 12; i++) {
                rows.push(
                    first.append(
                        'room1',
                        { name: i % 2 ? 'alice' : 'bob', text: `m${i}`, imgs: i % 4 === 0 ? [IMG(`i${i}=`)] : [] },
                        { ts: base + i * 100 }
                    )
                );
            }
            first.edit('room1', { ts: rows[1].ts, name: rows[1].name, text: 'm1 v2' });
            first.react('room1', { ts: rows[2].ts, name: rows[2].name, emoji: '👍', who: 'alice' });
            first.react('room1', { ts: rows[2].ts, name: rows[2].name, emoji: '👍', who: 'alice' }); // 幂等 add
            first.react('room1', { ts: rows[2].ts, name: rows[2].name, emoji: '👍', who: 'carol' });
            first.react('room1', { ts: rows[2].ts, name: rows[2].name, emoji: '👍', who: 'alice', op: 'remove' });
            first.edit('room1', { ts: rows[3].ts, name: rows[3].name, text: 'm3 v2' });
            first.edit('room1', { ts: rows[3].ts, name: rows[3].name, text: 'm3 v3' });
            first.remove('room1', { ts: rows[5].ts, name: rows[5].name });
            first.react('room1', { ts: rows[5].ts, name: rows[5].name, emoji: '😅', who: 'bob' }); // 墓碑：忽略
            first.edit('room1', { ts: rows[5].ts, name: rows[5].name, text: 'zombie' }); // 墓碑：忽略
            first.remove('room1', { ts: 404, name: 'nobody' }); // 行不存在：忽略
            const expected = first.exportAll('room1');
            first.destroy();

            const second = new ChatStore({ dir, sweepMs: 0 });
            second.exportAll('room1').should.eql(expected);
            second.destroy();
        });

        it('should ride retention drops as drop markers on the next append', () => {
            let hours = 24;
            store = newStore('shrink', { retentionHours: () => hours });
            const old = Date.now() - 2 * 60 * 60 * 1000;
            store.append('room1', { name: 'a', text: 'old' }, { ts: old });
            hours = 1; // 管理员收紧窗口；下一次 append 补付一条标记行
            store.append('room1', { name: 'a', text: 'fresh' });

            const lines = fs.readFileSync(store.fileFor('room1'), 'utf8').split('\n').filter(Boolean);
            lines.should.have.length(3); // 旧行 + drop 标记 + 新行
            JSON.parse(lines[1]).should.eql({ e: 'drop', ts: old, n: 1 });
            store
                .history('room1')
                .messages.map((m) => m.text)
                .should.eql(['fresh']);
            const second = new ChatStore({ dir: store.dir, sweepMs: 0 });
            second
                .history('room1')
                .messages.map((m) => m.text)
                .should.eql(['fresh']); // 重放结果一致：不会死而复生
            second.destroy();
        });

        it('should ride MAX_MESSAGES cap drops as drop markers and stay replay-exact', () => {
            const dir = tempDir('dropmarker');
            const first = new ChatStore({ dir, sweepMs: 0 });
            const base = Date.now() - 60 * 1000;
            const total = ChatStore.MAX_MESSAGES + 25;
            for (let i = 0; i < total; i++) {
                first.append('room1', { name: 'a', text: `m${i}` }, { ts: base + i });
            }
            const expected = first.exportAll('room1');
            expected.length.should.equal(ChatStore.MAX_MESSAGES);
            first.destroy();

            const second = new ChatStore({ dir, sweepMs: 0 });
            second.exportAll('room1').should.eql(expected);
            second.destroy();
        });

        it('should drop-mark sweep trims of in-memory channels', () => {
            let hours = 3;
            store = newStore('sweep-marker', { retentionHours: () => hours });
            const old = Date.now() - 2 * 60 * 60 * 1000; // 在 3h 窗口内
            store.append('room1', { name: 'a', text: 'old' }, { ts: old });
            store.append('room1', { name: 'a', text: 'fresh' });
            hours = 1; // 窗口收紧；sweep 经一条标记行修剪，而非整档重写
            store.sweep();

            const lines = fs.readFileSync(store.fileFor('room1'), 'utf8').split('\n').filter(Boolean);
            lines.should.have.length(3);
            JSON.parse(lines[2]).should.eql({ e: 'drop', ts: old, n: 1 });
            store
                .history('room1')
                .messages.map((m) => m.text)
                .should.eql(['fresh']);
        });

        it('should keep appending past the compaction ratio and compact later', function () {
            this.timeout(4000);
            const dir = tempDir('defer-compact');
            const store = new ChatStore({ dir, sweepMs: 0, maxBytes: 8192 });
            const bigText = 'x'.repeat(600); // 存储截断到 500 → 每行约 543B：14 行越过比率
            // 显式取不重复的 ts：快速 CI 机器上 14 次 append 会落在同一毫秒，
            // 而 edit() 按 ts 定位行——ts 相同会让目标变得有歧义
            // （测试随后就会改错消息）。
            const base = Date.now();
            for (let i = 0; i < 14; i++)
                store.append('room1', { name: 'a', text: `${i}-${bigText}` }, { ts: base + i });
            const file = store.fileFor('room1');
            const sizeAfterAppends = fs.statSync(file).size;
            sizeAfterAppends.should.be.above(8192 * 0.9); // 越过比率…
            sizeAfterAppends.should.be.below(8192); // …但未触及硬预算

            let saves = 0;
            const orig = ChatStore.prototype.save;
            ChatStore.prototype.save = function (...args) {
                saves++;
                return orig.apply(this, args);
            };
            try {
                const ts = store.history('room1').messages[0].ts;
                store.edit('room1', { ts, name: 'a', text: 'edited' });
            } finally {
                ChatStore.prototype.save = orig;
            }
            saves.should.equal(0); // 越过比率后交互路径仍零重写

            return new Promise((resolve) => setTimeout(resolve, 1300)).then(() => {
                fs.statSync(file).size.should.be.belowOrEqual(8192); // 后台压缩已运行
                const second = new ChatStore({ dir, sweepMs: 0 });
                second.history('room1').messages.at(-1).text.should.startWith('13');
                second.destroy();
            });
        });

        it('should skip unchanged idle files on repeated sweeps', () => {
            const dir = tempDir('sweep-skip');
            const writer = new ChatStore({ dir, retentionHours: 24, sweepMs: 0 });
            writer.append('idle', { name: 'a', text: 'kept' });
            writer.append('idle', { name: 'a', text: 'kept2' });
            writer.destroy();

            const reader = new ChatStore({ dir, retentionHours: 24, sweepMs: 0 });
            let loads = 0;
            const orig = ChatStore.prototype.loadFile;
            ChatStore.prototype.loadFile = function (...args) {
                loads++;
                return orig.apply(this, args);
            };
            try {
                reader.sweep();
                loads.should.equal(1); // 首次照面：做一次完整检查
                reader.sweep();
                loads.should.equal(1); // 保留期内文件未变化：跳过
                // 外部变更（restore 式重写）会强制重新查看
                fs.appendFileSync(
                    reader.fileFor('idle'),
                    JSON.stringify({ ts: Date.now(), name: 'x', text: 'external' }) + '\n',
                    'utf8'
                );
                reader.sweep();
                loads.should.equal(2);
            } finally {
                ChatStore.prototype.loadFile = orig;
            }
            fs.existsSync(reader.fileFor('idle')).should.be.true();
            reader.destroy();
        });

        it('should wipe an all-expired idle file from the tail sample alone', () => {
            const dir = tempDir('sweep-tailwipe');
            const writer = new ChatStore({ dir, retentionHours: 1, sweepMs: 0 });
            writer.append('old', { name: 'a', text: 'ancient' }, { ts: Date.now() - 9 * 60 * 60 * 1000 });
            writer.destroy();

            const reader = new ChatStore({ dir, retentionHours: 1, sweepMs: 0 });
            let loads = 0;
            const orig = ChatStore.prototype.loadFile;
            ChatStore.prototype.loadFile = function (...args) {
                loads++;
                return orig.apply(this, args);
            };
            try {
                reader.sweep();
            } finally {
                ChatStore.prototype.loadFile = orig;
            }
            loads.should.equal(0); // 仅凭尾部抽样判定；从未解析过文件
            fs.existsSync(reader.fileFor('old')).should.be.false();
            reader.destroy();
        });

        it('should tolerate a torn event line and skip unknown event kinds', () => {
            const dir = tempDir('event-tolerance');
            fs.mkdirSync(dir, { recursive: true });
            const ts = Date.now();
            const rows = [
                JSON.stringify({ ts, name: 'a', text: 'base' }),
                JSON.stringify({ e: 'edit', ts, name: 'a', text: 'edited' }),
                JSON.stringify({ e: 'warp', ts, name: 'a', text: 'from the future' }), // 未知事件类型
                '{"e":"del","ts":1,"name":"a"', // 撕裂尾行（追加中途崩溃）
                '',
            ].join('\n');
            fs.writeFileSync(path.join(dir, 'room1.jsonl'), rows, 'utf8');

            const tolerant = new ChatStore({ dir, sweepMs: 0 });
            const history = tolerant.history('room1').messages;
            history.should.have.length(1);
            history[0].text.should.equal('edited');
            history[0].edited.should.be.true();
            fs.existsSync(path.join(dir, 'room1.jsonl.corrupt')).should.be.false(); // 不误触发隔离
            tolerant.destroy();
        });

        it('should ignore a leftover .tmp from an interrupted compaction', () => {
            const dir = tempDir('interrupted-compact');
            fs.mkdirSync(dir, { recursive: true });
            const ts = Date.now();
            fs.writeFileSync(
                path.join(dir, 'room1.jsonl'),
                JSON.stringify({ ts, name: 'a', text: 'good' }) + '\n',
                'utf8'
            );
            // writeFileSync(tmp) 与 renameSync 之间 kill -9 会留下垃圾文件
            fs.writeFileSync(path.join(dir, 'room1.jsonl.tmp'), '{"ts":1,"nam', 'utf8');

            const restarted = new ChatStore({ dir, sweepMs: 0 });
            restarted
                .history('room1')
                .messages.map((m) => m.text)
                .should.eql(['good']);
            fs.existsSync(path.join(dir, 'room1.jsonl.corrupt')).should.be.false();
            restarted.destroy();
        });

        it('should keep every line restore-valid (parses to a finite ts)', () => {
            store = newStore('restore-valid');
            const ts = Date.now() - 1000;
            store.append('room1', { name: 'a', text: 'm1' }, { ts });
            store.edit('room1', { ts, name: 'a', text: 'edited' });
            store.react('room1', { ts, name: 'a', emoji: '👍', who: 'b' });
            store.remove('room1', { ts, name: 'a' });
            for (const line of fs.readFileSync(store.fileFor('room1'), 'utf8').split('\n').filter(Boolean)) {
                Number.isFinite(JSON.parse(line).ts).should.be.true(); // restore.js 的行校验
            }
        });
    });
});
