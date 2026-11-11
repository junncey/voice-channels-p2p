'use strict';

// npx mocha test-red-codecs.js
// redFirstCodecs 位于浏览器 ES 模块——经其 file URL 动态导入
// （包本身保持 CommonJS），与 test-opusFmtp 同一套路。

require('should');
const { pathToFileURL } = require('url');
const path = require('path');

// 形状仿照 Chrome 的 RTCRtpReceiver.getCapabilities('audio').codecs：
// audio/red 以 apt 链指向 opus 的方式随第一方一起出现
const CHROME_LIKE = [
    { mimeType: 'audio/opus', clockRate: 48000, channels: 2, sdpFmtpLine: 'minptime=10;useinbandfec=1' },
    { mimeType: 'audio/red', clockRate: 48000, channels: 2, sdpFmtpLine: '111/111' },
    { mimeType: 'audio/telephone-event', clockRate: 8000 },
    { mimeType: 'audio/PCMU', clockRate: 8000, channels: 1 },
    { mimeType: 'audio/CN', clockRate: 48000, channels: 1 },
];

describe('test-red-codecs', () => {
    let redFirstCodecs;

    before(async () => {
        ({ redFirstCodecs } = await import(
            pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'webrtc.js'))
        ));
    });

    it('should move audio/red entries to the front, keeping the rest in order', () => {
        const out = redFirstCodecs(CHROME_LIKE);
        out[0].mimeType.should.equal('audio/red');
        // 其余条目保持原有相对顺序——codec 偏好只做重排，
        // 绝不能丢条目或产生重复
        out.map((c) => c.mimeType).should.eql([
            'audio/red',
            'audio/opus',
            'audio/telephone-event',
            'audio/PCMU',
            'audio/CN',
        ]);
    });

    it('should not mutate the input array (capabilities objects are shared)', () => {
        const input = CHROME_LIKE.map((c) => ({ ...c }));
        const snapshot = input.map((c) => c.mimeType);
        redFirstCodecs(input);
        input.map((c) => c.mimeType).should.eql(snapshot);
    });

    it('should keep every entry and its fields intact (apt chains survive reordering)', () => {
        const out = redFirstCodecs(CHROME_LIKE);
        out.should.have.length(CHROME_LIKE.length);
        // 仍是同一批对象引用——重排不碰任何 payload 内容
        for (const codec of CHROME_LIKE) out.should.containEql(codec);
    });

    it('should return the input untouched when audio/red is absent (Firefox-like)', () => {
        const noRed = CHROME_LIKE.filter((c) => c.mimeType !== 'audio/red');
        const out = redFirstCodecs(noRed);
        // 原样返回是调用方的“无 red 可用”信号（webrtc.js 在调用
        // setCodecPreferences 前比较 red !== codecs）
        out.should.equal(noRed);
    });

    it('should be case-insensitive on the mimeType', () => {
        const mixed = [
            { mimeType: 'audio/Opus', clockRate: 48000, channels: 2 },
            { mimeType: 'audio/RED', clockRate: 48000, channels: 2 },
        ];
        redFirstCodecs(mixed)[0].mimeType.should.equal('audio/RED');
    });

    it('should tolerate empty and missing capability lists', () => {
        redFirstCodecs([]).should.eql([]);
        should(redFirstCodecs(undefined)).eql([]);
        should(redFirstCodecs(null)).eql([]);
    });
});
