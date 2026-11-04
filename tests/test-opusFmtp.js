'use strict';

// npx mocha test-opusFmtp.js
// mungeOpusFmtp lives in a browser ES module — import it dynamically via its
// file URL (the package itself stays CommonJS).

require('should');
const { pathToFileURL } = require('url');
const path = require('path');

const SDP = [
    'v=0',
    'o=- 46117317 2 IN IP4 127.0.0.1',
    's=-',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0 8',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:0 PCMU/8000',
    'a=fmtp:0 annexb=no',
    'a=rtpmap:8 PCMA/8000',
].join('\r\n');

describe('test-opusFmtp', () => {
    let mungeOpusFmtp;

    before(async () => {
        ({ mungeOpusFmtp } = await import(
            pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'webrtc.js'))
        ));
    });

    it('should add params to the opus fmtp line', () => {
        const out = mungeOpusFmtp(SDP, { maxaveragebitrate: 64000, usedtx: 1 });
        out.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000;usedtx=1');
    });

    it('should replace same-key values instead of duplicating (idempotent)', () => {
        const once = mungeOpusFmtp(SDP, { maxaveragebitrate: 64000 });
        const twice = mungeOpusFmtp(once, { maxaveragebitrate: 192000, stereo: 1 });
        twice.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=192000;stereo=1');
        twice.match(/maxaveragebitrate=/g).should.have.length(1);
        twice.should.not.containEql('64000');
    });

    it('should remove params set to null — mode switches leave no residue', () => {
        // voice first: usedtx negotiated onto the live connection…
        const voice = mungeOpusFmtp(SDP, { maxaveragebitrate: 64000, usedtx: 1, stereo: null });
        voice.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000;usedtx=1');
        // …then music on the SAME connection (a later offer munges over the
        // previous local description): usedtx must be gone, not lingering
        const music = mungeOpusFmtp(voice, { maxaveragebitrate: 192000, stereo: 1, usedtx: null });
        music.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=192000;stereo=1');
        music.should.not.containEql('usedtx');
        // …and back to voice: stereo must be gone too
        const voiceAgain = mungeOpusFmtp(music, { maxaveragebitrate: 64000, usedtx: 1, stereo: null });
        voiceAgain.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000;usedtx=1');
        voiceAgain.should.not.containEql('stereo');
    });

    it('should negotiate both stereo declarations in music mode (sprop-stereo)', () => {
        // Chrome only encodes true stereo when the decoder (stereo=1) AND the
        // sent stream (sprop-stereo=1) are both declared — mirror the exact
        // param set channel.js opusFmtp() emits for music mode with a stereo
        // capture. FEC rides in music mode too (cheap at high rates), DTX stays
        // off.
        const music = mungeOpusFmtp(SDP, {
            maxaveragebitrate: 192000,
            stereo: 1,
            'sprop-stereo': 1,
            usedtx: null,
            useinbandfec: 1,
        });
        music.should.containEql(
            'a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=192000;stereo=1;sprop-stereo=1'
        );
        music.should.not.containEql('usedtx');
        // …and back to voice: BOTH stereo declarations must leave together
        const voice = mungeOpusFmtp(music, {
            maxaveragebitrate: 64000,
            usedtx: 1,
            useinbandfec: 1,
            stereo: null,
            'sprop-stereo': null,
        });
        voice.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000;usedtx=1');
        voice.should.not.containEql('stereo');
    });

    it('should drop both stereo declarations in music mode when the mic is mono', () => {
        // watchMicHealth flips settings.micChannels to 1 for mono captures:
        // the music dict then states stereo:null/'sprop-stereo':null so the
        // encoder ships mono at full per-channel rate instead of dual-mono
        const monoMusic = mungeOpusFmtp(SDP, {
            maxaveragebitrate: 192000,
            stereo: null,
            'sprop-stereo': null,
            usedtx: null,
            useinbandfec: 1,
        });
        monoMusic.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=192000');
        monoMusic.should.not.containEql('stereo');
        monoMusic.should.not.containEql('usedtx');
        // …a stereo mic lands mid-call: both declarations must arrive together
        const stereoMusic = mungeOpusFmtp(monoMusic, {
            maxaveragebitrate: 192000,
            stereo: 1,
            'sprop-stereo': 1,
            usedtx: null,
            useinbandfec: 1,
        });
        stereoMusic.should.containEql(
            'a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=192000;stereo=1;sprop-stereo=1'
        );
    });

    it('should keep FEC across the voice↔music mode switch', () => {
        // Chrome only sends Opus inband FEC when the receiving side negotiated
        // useinbandfec — mirror the exact voice dict from channel.js opusFmtp()
        // applied to an SDP that never carried the parameter; music mode keeps
        // it (a sliver of 192k headroom buys continuity on lossy links)
        const noFec = SDP.replace(';useinbandfec=1', '');
        const voice = mungeOpusFmtp(noFec, {
            maxaveragebitrate: 64000,
            usedtx: 1,
            useinbandfec: 1,
            stereo: null,
            'sprop-stereo': null,
        });
        voice.should.containEql('a=fmtp:111 minptime=10;maxaveragebitrate=64000;usedtx=1;useinbandfec=1');
        // …music on the SAME connection: DTX leaves, FEC and stereo stay
        const music = mungeOpusFmtp(voice, {
            maxaveragebitrate: 192000,
            stereo: 1,
            'sprop-stereo': 1,
            usedtx: null,
            useinbandfec: 1,
        });
        music.should.containEql(
            'a=fmtp:111 minptime=10;maxaveragebitrate=192000;useinbandfec=1;stereo=1;sprop-stereo=1'
        );
        music.should.not.containEql('usedtx');
    });

    it('should leave non-opus fmtp lines untouched', () => {
        const out = mungeOpusFmtp(SDP, { maxaveragebitrate: 64000 });
        out.should.containEql('a=fmtp:0 annexb=no');
    });

    it('should return the SDP unchanged when there is no opus track', () => {
        const noOpus = SDP.replace('a=rtpmap:111 opus/48000/2\r\n', '').replace(
            'a=fmtp:111 minptime=10;useinbandfec=1\r\n',
            ''
        );
        mungeOpusFmtp(noOpus, { maxaveragebitrate: 64000 }).should.equal(noOpus);
    });
});
