'use strict';

// npx mocha test-chatstore-perf.js
//
// Regression guard for the event-line write path (docs/deferred-engineering.md #1):
// on a ~12MB image-heavy channel the interaction paths (edit / react / append)
// must stay O(1) appends — no full serialize+rewrite on the event loop — and the
// background sweep must skip unchanged idle files without reading them. The
// structural asserts (rewrite counters, on-disk line counts) are deterministic;
// the wall-clock budgets are deliberately generous so CI load cannot flip them,
// while the old rewrite-per-op behavior (~50-100ms per 12MB rewrite) would
// blow straight through them.

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');

const ChatStore = require('../app/src/chatStore');

const MAX_BYTES = 12 * 1024 * 1024;
// 280 image rows ≈ 11.2MB: comfortably under the hard budget, above the 90%
// compaction ratio, and the 20 appends in the second test land exactly on
// (not past) MAX_MESSAGES so no drop markers muddy the line-count asserts
const ROW_IMG = 'data:image/png;base64,' + 'A'.repeat(41 * 1024);
const ROWS = 280;

function tempDir(name) {
    const dir = path.join(os.tmpdir(), `mirotalk-chat-perf-${process.pid}-${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return dir;
}

/** Build a ~11.5MB JSONL history directly on disk (no store involved). */
function seedBigChannel(dir, id) {
    const lines = [];
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < ROWS; i++) {
        lines.push(JSON.stringify({ ts: base + i, name: 'p', text: `row ${i}`, imgs: [ROW_IMG] }));
    }
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return { file, size: fs.statSync(file).size };
}

/** Count ChatStore#save calls (full rewrites) while fn runs. */
function withSaveSpy(fn) {
    const orig = ChatStore.prototype.save;
    let calls = 0;
    ChatStore.prototype.save = function (...args) {
        calls++;
        return orig.apply(this, args);
    };
    try {
        fn();
    } finally {
        ChatStore.prototype.save = orig;
    }
    return calls;
}

/** Milliseconds a synchronous fn blocks for. */
function timed(fn) {
    const t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('test-chatStore perf (12MB channel write path)', function () {
    this.timeout(30000);

    let dir;
    let store;
    const id = 'big';
    let seed;

    beforeEach(() => {
        dir = tempDir('main');
        fs.mkdirSync(dir, { recursive: true });
        seed = seedBigChannel(dir, id);
        seed.size.should.be.above(MAX_BYTES * 0.9);
        seed.size.should.be.below(MAX_BYTES);
        store = new ChatStore({ dir, sweepMs: 0 });
    });

    afterEach(() => {
        store?.destroy();
        store = null;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('edits stay O(1) appends (no rewrite on the event loop)', () => {
        const rows = store.exportAll(id);
        rows.should.have.length(ROWS);

        let totalMs = 0;
        let saves = 0;
        totalMs += timed(() => {
            saves = withSaveSpy(() => {
                for (let i = 0; i < 30; i++) {
                    const row = rows[i * 5];
                    store.edit(id, { ts: row.ts, name: row.name, text: `edited ${i}` });
                }
            });
        });

        saves.should.equal(0); // zero rewrites: pure event-line appends
        totalMs.should.be.below(750); // 30 ops with ~75x headroom; a rewrite per op needs seconds
        const lines = fs.readFileSync(seed.file, 'utf8').split('\n').filter(Boolean);
        lines.should.have.length(ROWS + 30); // base rows untouched + one event line per edit
        store.channels.get(id).fileSize.should.equal(fs.statSync(seed.file).size); // bookkeeping exact
    });

    it('reactions and new messages stay O(1) appends', () => {
        const rows = store.exportAll(id);

        let totalMs = 0;
        let saves = 0;
        totalMs += timed(() => {
            saves = withSaveSpy(() => {
                for (let i = 0; i < 30; i++) {
                    const row = rows[i * 5 + 1];
                    store.react(id, { ts: row.ts, name: row.name, emoji: '👍', who: `r${i}` });
                }
                for (let i = 0; i < 20; i++) {
                    store.append(id, { name: 'p', text: `fresh ${i}` });
                }
            });
        });

        saves.should.equal(0);
        totalMs.should.be.below(1000);
        const lines = fs.readFileSync(seed.file, 'utf8').split('\n').filter(Boolean);
        lines.should.have.length(ROWS + 30 + 20); // reactions ride as event lines, messages as rows
        store.channels.get(id).fileSize.should.equal(fs.statSync(seed.file).size);
    });

    it('sweep skips the unchanged idle file after one full check', () => {
        store.destroy();
        store = null;

        const reader = new ChatStore({ dir, sweepMs: 0 });
        let loads = 0;
        const orig = ChatStore.prototype.loadFile;
        ChatStore.prototype.loadFile = function (...args) {
            loads++;
            return orig.apply(this, args);
        };
        try {
            reader.sweep();
            loads.should.equal(1); // first sight: one full check of the 11.5MB file
            reader.sweep();
            loads.should.equal(1); // unchanged file inside its retention epoch: stat-only skip
        } finally {
            ChatStore.prototype.loadFile = orig;
        }
        reader.destroy();
    });
});
