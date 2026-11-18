'use strict';

// npx mocha test-chatevents.js
// chatEvents.js 的单测：在线变更器与事件行重放共用的那组实现
// （此前是两份逐行镜像），外加行级校验器/归一化器。

require('should');

const events = require('../app/src/chatEvents');

describe('test-chatevents (shared row mutators)', () => {
    it('applyEditText marks the row edited with cleaned text', () => {
        const row = { ts: 1, name: 'a', text: 'old' };
        events.applyEditText(row, events.cleanChatText('  new <b>  '));
        row.text.should.equal('new <b>');
        row.edited.should.be.true();
    });

    it('cleanChatText trims and caps like the composer (500)', () => {
        events.cleanChatText(`  ${'x'.repeat(600)}  `).length.should.equal(500);
        events.cleanChatText(42).should.equal('');
        events.cleanChatText('   ').should.equal('');
    });

    it('applyDeleteRow tombstones and strips images/reactions', () => {
        const row = { ts: 1, name: 'a', text: 'x', imgs: ['data:image/png;base64,A'], reactions: { '👍': ['a'] } };
        events.applyDeleteRow(row);
        row.deleted.should.be.true();
        row.text.should.equal('');
        should.not.exist(row.imgs);
        should.not.exist(row.reactions);
    });

    it('toggleReaction adds, dedupes, removes, and reports no-ops', () => {
        const row = { ts: 1, name: 'a', text: 'x' };
        events.toggleReaction(row, '👍', 'alice', 'add').should.be.true();
        events.toggleReaction(row, '👍', 'alice', 'add').should.be.false(); // 幂等重复添加
        events.toggleReaction(row, '👍', 'bob', 'add').should.be.true();
        row.reactions['👍'].should.eql(['alice', 'bob']);
        events.toggleReaction(row, '👍', 'alice', 'remove').should.be.true();
        events.toggleReaction(row, '👍', 'carol', 'remove').should.be.false(); // 移除不在场者
        events.toggleReaction(row, '👍', 'bob', 'remove').should.be.true();
        should.not.exist(row.reactions); // 空 emoji 清理掉
    });

    it('toggleReaction enforces the emoji/names caps as silent no-ops', () => {
        const row = { ts: 1, name: 'a', text: 'x' };
        for (let i = 0; i < limitsCapEmoji(); i++) events.toggleReaction(row, `e${i}`, 'alice', 'add');
        events.toggleReaction(row, 'overflow', 'alice', 'add').should.be.false(); // 第 9 个 emoji
        const row2 = { ts: 2, name: 'a', text: 'x' };
        for (let i = 0; i < 50; i++) events.toggleReaction(row2, '👍', `u${i}`, 'add');
        events.toggleReaction(row2, '👍', 'u50', 'add').should.be.false(); // 第 51 人
        row2.reactions['👍'].length.should.equal(50);
    });

    function limitsCapEmoji() {
        return 8;
    }
});

describe('test-chatevents (applyEvent replay)', () => {
    const seed = () => [
        { ts: 1, name: 'a', text: 'one' },
        { ts: 2, name: 'a', text: 'two' },
        { ts: 3, name: 'b', text: 'three' },
    ];

    it('replays edit/del/react onto the same rows the live path mutates', () => {
        const rows = seed();
        events.applyEvent(rows, { e: 'edit', ts: 2, name: 'a', text: 'EDIT' });
        rows[1].text.should.equal('EDIT');
        rows[1].edited.should.be.true();

        events.applyEvent(rows, { e: 'del', ts: 3, name: 'b' });
        rows[2].deleted.should.be.true();

        events.applyEvent(rows, { e: 'react', ts: 1, name: 'a', emoji: '👍', who: 'b', op: 'add' });
        rows[0].reactions.should.eql({ '👍': ['b'] });
    });

    it('drop removes an exact prefix count', () => {
        const rows = seed();
        events.applyEvent(rows, { e: 'drop', ts: 0, n: 2 });
        rows.length.should.equal(1);
        rows[0].ts.should.equal(3);
        events.applyEvent(rows, { e: 'drop', ts: 0, n: 99 }); // 超量安全截断
        rows.length.should.equal(0);
    });

    it('ignores invalid or unknown events (older-version forward compat)', () => {
        const rows = seed();
        events.applyEvent(rows, { e: 'future-thing', x: 1 });
        events.applyEvent(rows, { e: 'edit', ts: 2, name: 'a', text: '' }); // 空文本无效
        events.applyEvent(rows, { e: 'edit', ts: 'x', name: 'a', text: 'v' }); // 坏身份
        events.applyEvent(rows, { e: 'del', n: -1 });
        rows.should.eql(seed());
    });

    it('never targets tombstoned rows', () => {
        const rows = seed();
        events.applyEvent(rows, { e: 'del', ts: 1, name: 'a' });
        events.applyEvent(rows, { e: 'edit', ts: 1, name: 'a', text: 'zombie' });
        rows[0].text.should.equal('');
        events.applyEvent(rows, { e: 'react', ts: 1, name: 'a', emoji: '👍', who: 'b', op: 'add' });
        should.not.exist(rows[0].reactions);
    });
});

describe('test-chatevents (validators and sanitizers)', () => {
    it('isPlainMessage accepts legacy img counts and rejects foreign shapes', () => {
        events.isPlainMessage({ ts: 1, name: 'a', text: 'x' }).should.be.true();
        events.isPlainMessage({ ts: 1, name: 'a', text: 'x', imgs: 3 }).should.be.true(); // 旧版计数
        events.isPlainMessage({ ts: 1, name: 'a', text: 'x', imgs: ['data:image/png;base64,A'] }).should.be.true();
        // 事件行与消息行的分流在 loadJsonlFile（row.e 检查），
        // 这里只管消息行的形状
        events.isPlainMessage('x').should.be.false();
        events.isPlainMessage({ ts: 'NaN', name: 'a', text: 'x' }).should.be.false();
        events.isPlainMessage({ ts: 1, name: 'a', text: 'x', reply: { name: 'b', text: 'q' } }).should.be.false(); // reply 缺 ts
    });

    it('sanitizeReply is strict: non-empty parts and a positive finite ts', () => {
        events.sanitizeReply({ name: 'b', text: 'hello', ts: 123 }).should.eql({ name: 'b', text: 'hello', ts: 123 });
        should.not.exist(events.sanitizeReply({ name: 'b', text: '', ts: 123 })); // 空摘要
        should.not.exist(events.sanitizeReply({ name: '', text: 'x', ts: 123 }));
        should.not.exist(events.sanitizeReply({ name: 'b', text: 'x', ts: 0 })); // ts 必须为正
        should.not.exist(events.sanitizeReply({ name: 'b', text: 'x', ts: 'later' }));
        should.not.exist(events.sanitizeReply(null));
        // 截断
        events.sanitizeReply({ name: 'n'.repeat(40), text: 't'.repeat(200), ts: 5 }).should.eql({
            name: 'n'.repeat(24),
            text: 't'.repeat(80),
            ts: 5,
        });
    });

    it('sanitizeImages whitelists data urls and caps count/size', () => {
        const good = 'data:image/png;base64,QUJD';
        events.sanitizeImages([good, good, good]).length.should.equal(3);
        events.sanitizeImages(['javascript:x', good]).should.eql([good]);
        events.sanitizeImages(Array(12).fill(good)).length.should.equal(9); // 张数上限
        events.sanitizeImages(`data:image/png;base64,${'A'.repeat(1600 * 1024 + 1)}`).should.eql([]); // 尺寸上限
        events.sanitizeImages('nope').should.eql([]);
    });

    it('estimateBytes counts serialized UTF-8 bytes (CJK = 3 bytes/char)', () => {
        events
            .estimateBytes({ ts: 1, name: 'a', text: 'x' })
            .should.equal(Buffer.byteLength(JSON.stringify({ ts: 1, name: 'a', text: 'x' }), 'utf8'));
        // 中文按字节而非字符计——「页必装进包」的前提
        events
            .estimateBytes({ ts: 1, name: 'a', text: '好' })
            .should.be.above(Buffer.byteLength('{"ts":1,"name":"a","text":""}', 'utf8'));
    });

    it('serializeLines joins one JSON object per line', () => {
        const out = events.serializeLines([
            { ts: 1, name: 'a', text: 'x' },
            { ts: 2, name: 'a', text: 'y' },
        ]);
        out.split('\n').filter(Boolean).length.should.equal(2);
        out.endsWith('\n').should.be.true();
    });
});
