'use strict';

// npx mocha test-opusFmtp.js
// mungeOpusFmtp 位于浏览器 ES 模块——经其 file URL 动态导入
// （包本身保持 CommonJS）。

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
        // 先语音：usedtx 协商到活连接上…
        const voice = mungeOpusFmtp(SDP, { maxaveragebitrate: 64000, usedtx: 1, stereo: null });
        voice.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000;usedtx=1');
        // …再在同一条连接上切音乐（后续 offer 会改写上一个 local
        // description）：usedtx 必须消失，不能残留
        const music = mungeOpusFmtp(voice, { maxaveragebitrate: 192000, stereo: 1, usedtx: null });
        music.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=192000;stereo=1');
        music.should.not.containEql('usedtx');
        // …再切回语音：stereo 也必须消失
        const voiceAgain = mungeOpusFmtp(music, { maxaveragebitrate: 64000, usedtx: 1, stereo: null });
        voiceAgain.should.containEql('a=fmtp:111 minptime=10;useinbandfec=1;maxaveragebitrate=64000;usedtx=1');
        voiceAgain.should.not.containEql('stereo');
    });

    it('should negotiate both stereo declarations in music mode (sprop-stereo)', () => {
        // Chrome 只有在解码端（stereo=1）与发送流（sprop-stereo=1）同时声明时
        // 才会编码真立体声——完全复刻 channel.js opusFmtp() 在立体声采样的
        // 音乐模式下发出的参数集。
        // FEC 在音乐模式下也保留（高码率下代价很小），
        // DTX 保持关闭。
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
        // …再切回语音：两处 stereo 声明必须一起消失
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
        // watchMicHealth 对单声道采样会把 settings.micChannels 置为 1：
        // 此时音乐模式字典声明 stereo:null/'sprop-stereo':null，让编码器
        // 以单声道全每声道码率输出，而不是双单声道
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
        // …通话中途插入立体声麦克风：两处声明必须同时出现
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
        // Chrome 只有在接收端协商了 useinbandfec 时才会发送 Opus inband FEC
        // ——复刻 channel.js opusFmtp() 的语音模式字典，套在一个从未带过该
        // 参数的 SDP 上；音乐模式保留 FEC（用一点点 192k 余量换取易丢包
        // 链路上的连续性）
        const noFec = SDP.replace(';useinbandfec=1', '');
        const voice = mungeOpusFmtp(noFec, {
            maxaveragebitrate: 64000,
            usedtx: 1,
            useinbandfec: 1,
            stereo: null,
            'sprop-stereo': null,
        });
        voice.should.containEql('a=fmtp:111 minptime=10;maxaveragebitrate=64000;usedtx=1;useinbandfec=1');
        // …同一条连接上切音乐：DTX 撤走，FEC 与 stereo 保留
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
