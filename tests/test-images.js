'use strict';

// npx mocha test-images.js
// 图片传输协议：分块经接收端回环、发送端背压泵（分块爆发之间 await
// `ready` 钩子）以及无进展超时（有进展就重置计时，真停滞仍快速失败）。
// 浏览器 ES 模块经其 file URL 导入，
// 与 test-opusFmtp 同一套路。

require('should');
const { pathToFileURL } = require('url');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('test-images (DC image protocol)', () => {
    let sendImageData, createImageReceiver;

    before(async () => {
        ({ sendImageData, createImageReceiver } = await import(
            pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'images.js'))
        ));
    });

    it('should round-trip a multi-chunk image through the receiver', async () => {
        const base64 = 'Q'.repeat(100 * 1024); // 每块 12KB，共 9 块
        const dataUrl = `data:image/png;base64,${base64}`;
        const frames = [];
        await sendImageData({ send: (f) => frames.push(f), from: 'alice', mime: 'image/png', dataUrl, batch: 'b1' });
        frames[0].type.should.equal('img-start');
        frames.at(-1).type.should.equal('img-end');
        frames.filter((f) => f.type === 'img-chunk').should.have.length(9);

        let done = null;
        let failed = null;
        const receive = createImageReceiver({
            onDone: (res) => (done = res),
            onFail: (reason) => (failed = reason),
            stallMs: 5000,
        });
        for (const frame of frames) receive(frame, 'peer1');
        should(failed).be.null();
        done.should.be.ok();
        done.dataUrl.should.equal(dataUrl);
        done.batch.should.equal('b1');
        done.peerId.should.equal('peer1'); // 以信任的 socket 来源为准，而非自报的 from
    });

    it('should pump the backpressure hook between chunk bursts', async () => {
        const dataUrl = `data:image/png;base64,${'Q'.repeat(100 * 1024)}`; // 9 块
        let readyCalls = 0;
        const order = [];
        await sendImageData({
            send: (f) => order.push(`f:${f.type}:${f.i ?? ''}`),
            ready: async () => {
                readyCalls += 1;
                order.push('ready');
            },
            from: 'a',
            mime: 'image/png',
            dataUrl,
        });
        // 每 4 个分块 await 一次排空钩子：分块 0-3，然后 ready，…
        readyCalls.should.equal(2);
        order.indexOf('ready').should.be.above(0);
        order.indexOf('ready').should.be.below(order.length - 1); // 交织在中间，而非攒到最后批量执行
    });

    it('should stay effectively synchronous without a hook', async () => {
        const dataUrl = `data:image/png;base64,${'Q'.repeat(24 * 1024)}`; // 2 块
        const frames = [];
        await sendImageData({ send: (f) => frames.push(f), from: 'a', mime: 'image/png', dataUrl });
        frames.should.have.length(4); // start + 2 个分块 + end
    });

    it('should fail a stalled transfer on the no-progress timeout', async () => {
        let failed = null;
        const receive = createImageReceiver({
            onDone: () => {},
            onFail: (reason) => (failed = reason),
            stallMs: 120,
        });
        receive({ type: 'img-start', id: 't1', from: 'a', mime: 'image/png', size: 1000, total: 1 }, 'peer1');
        await sleep(300);
        failed.should.equal('timeout');
        // 条目已被清除：迟到的 img-end 无法将其复活
        receive({ type: 'img-end', id: 't1', from: 'a' }, 'peer1');
        await sleep(50);
        failed.should.equal('timeout'); // 仍是超时，而不是二次判定
    });

    it('should keep a slow-but-alive transfer past the initial window (progress re-arms)', async () => {
        let done = null;
        let failed = null;
        const receive = createImageReceiver({
            onDone: (res) => (done = res),
            onFail: (reason) => (failed = reason),
            stallMs: 200,
        });
        const base64 = 'A'.repeat(20 * 1024); // 2 块
        receive({ type: 'img-start', id: 't2', from: 'a', mime: 'image/png', size: base64.length, total: 2 }, 'peer1');
        await sleep(150); // 150 < 200：还在第一个窗口期内
        receive({ type: 'img-chunk', id: 't2', i: 0, d: base64.slice(0, 12 * 1024) }, 'peer1');
        await sleep(150); // 距 start 已 300ms，但距最后一个分块只有 150ms
        should(failed).be.null(); // 旧的固定 200ms 窗口会把它误杀
        receive({ type: 'img-chunk', id: 't2', i: 1, d: base64.slice(12 * 1024) }, 'peer1');
        receive({ type: 'img-end', id: 't2', from: 'a' }, 'peer1');
        should(failed).be.null();
        done.should.be.ok();
        done.dataUrl.should.equal(`data:image/png;base64,${base64}`);
    });
});
