'use strict';

// npx mocha test-chatstore-perf.js
//
// 事件行写入路径的回归守卫（docs/deferred-engineering.md #1）：在 ~12MB
// 图片密集频道上，交互路径（edit / react / append）必须保持 O(1) 追加
// ——事件循环上绝无全量序列化重写——且后台 sweep 必须不读取即跳过
// 未变化的空闲文件。
// 结构性断言（重写计数、磁盘行数）是确定的；
// 墙钟预算刻意放宽以免 CI 负载翻转结果，
// 而旧的每操作重写行为（每次 12MB 重写 ~50-100ms）
// 会直接爆掉预算。

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');

const ChatStore = require('../app/src/chatStore');

const MAX_BYTES = 12 * 1024 * 1024;
// 280 行图片 ≈ 11.2MB：稳妥低于硬预算、高于 90% 压缩比阈值，且第二个
// 测试里的 20 次 append 恰好落在（而非越过）MAX_MESSAGES 上，避免 drop
// 标记搅乱行数断言
const ROW_IMG = 'data:image/png;base64,' + 'A'.repeat(41 * 1024);
const ROWS = 280;

function tempDir(name) {
    const dir = path.join(os.tmpdir(), `mirotalk-chat-perf-${process.pid}-${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return dir;
}

/** 直接在磁盘上铺一份 ~11.5MB 的 JSONL 历史（不经过 store）。 */
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

/** 统计 fn 运行期间 ChatStore#save（全量重写）的调用次数。 */
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

/** 同步 fn 阻塞的毫秒数。 */
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

        saves.should.equal(0); // 零重写：纯事件行追加
        totalMs.should.be.below(750); // 30 次操作留 ~75 倍余量；每次一重写需数秒
        const lines = fs.readFileSync(seed.file, 'utf8').split('\n').filter(Boolean);
        lines.should.have.length(ROWS + 30); // 基础行未动 + 每次 edit 一条事件行
        store.channels.get(id).fileSize.should.equal(fs.statSync(seed.file).size); // 记账分毫不差
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
        lines.should.have.length(ROWS + 30 + 20); // 回应以事件行随行，新消息成行
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
            loads.should.equal(1); // 首次照面：对 11.5MB 文件做一次完整检查
            reader.sweep();
            loads.should.equal(1); // 保留期内文件未变化：仅 stat 即跳过
        } finally {
            ChatStore.prototype.loadFile = orig;
        }
        reader.destroy();
    });
});
