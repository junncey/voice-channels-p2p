'use strict';

// npx mocha test-images.js
// Image transfer protocol: chunk roundtrip through the receiver, the sender's
// backpressure pump (the `ready` hook awaited between chunk bursts) and the
// no-progress timeout (progress re-arms it, a stall still fails promptly).
// Browser ES module imported via its file URL, same pattern as test-opusFmtp.

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
        const base64 = 'Q'.repeat(100 * 1024); // 9 chunks at 12KB each
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
        done.peerId.should.equal('peer1'); // trusted over the self-declared from
    });

    it('should pump the backpressure hook between chunk bursts', async () => {
        const dataUrl = `data:image/png;base64,${'Q'.repeat(100 * 1024)}`; // 9 chunks
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
        // every 4th chunk awaits the drain hook: chunks 0-3, then ready, …
        readyCalls.should.equal(2);
        order.indexOf('ready').should.be.above(0);
        order.indexOf('ready').should.be.below(order.length - 1); // interleaved, not batched at the end
    });

    it('should stay effectively synchronous without a hook', async () => {
        const dataUrl = `data:image/png;base64,${'Q'.repeat(24 * 1024)}`; // 2 chunks
        const frames = [];
        await sendImageData({ send: (f) => frames.push(f), from: 'a', mime: 'image/png', dataUrl });
        frames.should.have.length(4); // start + 2 chunks + end
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
        // the entry is gone: a late img-end cannot resurrect it
        receive({ type: 'img-end', id: 't1', from: 'a' }, 'peer1');
        await sleep(50);
        failed.should.equal('timeout'); // still the timeout, not a second verdict
    });

    it('should keep a slow-but-alive transfer past the initial window (progress re-arms)', async () => {
        let done = null;
        let failed = null;
        const receive = createImageReceiver({
            onDone: (res) => (done = res),
            onFail: (reason) => (failed = reason),
            stallMs: 200,
        });
        const base64 = 'A'.repeat(20 * 1024); // 2 chunks
        receive({ type: 'img-start', id: 't2', from: 'a', mime: 'image/png', size: base64.length, total: 2 }, 'peer1');
        await sleep(150); // 150 < 200: inside the first window
        receive({ type: 'img-chunk', id: 't2', i: 0, d: base64.slice(0, 12 * 1024) }, 'peer1');
        await sleep(150); // 300 since start, but only 150 since the last chunk
        should(failed).be.null(); // the old fixed 200ms window would have killed it
        receive({ type: 'img-chunk', id: 't2', i: 1, d: base64.slice(12 * 1024) }, 'peer1');
        receive({ type: 'img-end', id: 't2', from: 'a' }, 'peer1');
        should(failed).be.null();
        done.should.be.ok();
        done.dataUrl.should.equal(`data:image/png;base64,${base64}`);
    });
});
