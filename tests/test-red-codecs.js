'use strict';

// npx mocha test-red-codecs.js
// redFirstCodecs lives in a browser ES module — import it dynamically via its
// file URL (the package itself stays CommonJS), same pattern as test-opusFmtp.

require('should');
const { pathToFileURL } = require('url');
const path = require('path');

// shape mirrors RTCRtpReceiver.getCapabilities('audio').codecs in Chrome,
// where audio/red rides first-party with an apt chain pointing at opus
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
        // everything else keeps its relative order — codec preference only
        // reorders, it must never drop or duplicate entries
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
        // same object references — the reordering carries payloads untouched
        for (const codec of CHROME_LIKE) out.should.containEql(codec);
    });

    it('should return the input untouched when audio/red is absent (Firefox-like)', () => {
        const noRed = CHROME_LIKE.filter((c) => c.mimeType !== 'audio/red');
        const out = redFirstCodecs(noRed);
        // identity return is the caller’s "no red available" signal (webrtc.js
        // compares red !== codecs before calling setCodecPreferences)
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
