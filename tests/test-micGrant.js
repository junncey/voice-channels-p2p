'use strict';

// npx mocha test-micGrant.js
// acquireMic 位于浏览器 ES 模块——经其 file URL 动态导入
// （包本身保持 CommonJS）。

require('should');
const { pathToFileURL } = require('url');
const path = require('path');

describe('test-micGrant', () => {
    let acquireMic, micApiAvailable;
    let originalNavigator;

    before(async () => {
        ({ acquireMic, micApiAvailable } = await import(
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

    // Node 把 `navigator` 暴露为只读 getter 全局，直接赋值会抛错；
    // 改用 defineProperty 在单个测试期间临时重定义。
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
        // 我们已降级之后弹窗才被同意：那个流必须被 stop，否则采集指示灯
        // 长亮却没人读它的数据
        release(lateStream);
        await new Promise((resolve) => setTimeout(resolve, 10));
        stopped.should.eql(['late']);
    });

    it('should report unavailable (not a denial) when the API is missing', async () => {
        // 非安全上下文（局域网 http://IP）：navigator.mediaDevices 整个
        // 是 undefined，getUserMedia 调用会同步抛 TypeError 逃出 try——
        // 必须提前判定，否则 join 死在开 socket 之前
        Object.defineProperty(globalThis, 'navigator', {
            value: {},
            configurable: true,
            writable: true,
        });
        micApiAvailable().should.be.false();
        const res = await acquireMic({ audio: true }, { timeoutMs: 50 });
        (res.stream === null).should.be.true();
        res.timedOut.should.be.false();
        res.unavailable.should.be.true();
    });

    it('micApiAvailable is true when getUserMedia exists', () => {
        stubGetUserMedia(() => Promise.resolve({ getTracks: () => [] }));
        micApiAvailable().should.be.true();
    });
});
