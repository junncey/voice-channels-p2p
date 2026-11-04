'use strict';

// npx mocha test-micGrant.js
// acquireMic lives in a browser ES module — import it dynamically via its
// file URL (the package itself stays CommonJS).

require('should');
const { pathToFileURL } = require('url');
const path = require('path');

describe('test-micGrant', () => {
    let acquireMic;
    let originalNavigator;

    before(async () => {
        ({ acquireMic } = await import(
            pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'pages', 'channel', 'micGrant.js'))
        ));
        originalNavigator = globalThis.navigator;
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'navigator', {
            value: originalNavigator,
            configurable: true,
            writable: true,
        });
    });

    // Node exposes `navigator` as a getter-only global, so a plain assignment
    // would throw; redefine it for the duration of one test.
    function stubGetUserMedia(impl) {
        Object.defineProperty(globalThis, 'navigator', {
            value: { mediaDevices: { getUserMedia: impl } },
            configurable: true,
            writable: true,
        });
    }

    it('should return the stream when the grant resolves', async () => {
        const stream = { getTracks: () => [] };
        stubGetUserMedia(() => Promise.resolve(stream));
        const res = await acquireMic({ audio: true }, { timeoutMs: 50 });
        res.stream.should.equal(stream);
        res.timedOut.should.be.false();
    });

    it('should report denied (not a timeout) when the request rejects', async () => {
        stubGetUserMedia(() => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })));
        const res = await acquireMic({ audio: true }, { timeoutMs: 200 });
        (res.stream === null).should.be.true();
        res.timedOut.should.be.false();
    });

    it('should give up on an unanswered prompt and release a late grant', async () => {
        let release;
        const stopped = [];
        const lateStream = { getTracks: () => [{ stop: () => stopped.push('late') }] };
        stubGetUserMedia(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                })
        );
        const res = await acquireMic({ audio: true }, { timeoutMs: 30 });
        (res.stream === null).should.be.true();
        res.timedOut.should.be.true();
        // the dialog gets answered after we already degraded: that stream must
        // be stopped, or the capture light stays on with nobody reading it
        release(lateStream);
        await new Promise((resolve) => setTimeout(resolve, 10));
        stopped.should.eql(['late']);
    });
});
