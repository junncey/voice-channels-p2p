'use strict';

// npx mocha test-connstats.js
// webrtc.js 拆出的 getStats 解析纯函数（parseConnStats/assembleConnPath）
// 的单测——此前整段逻辑埋在 Mesh.connPath 里无法脱离浏览器测试。

require('should');

let parseConnStats;
let assembleConnPath;

before(async () => {
    const mod = await require('./helpers').importBrowserModule('public/js/core/webrtc.js');
    parseConnStats = mod.parseConnStats;
    assembleConnPath = mod.assembleConnPath;
});

function statsFixture(reports) {
    return { forEach: (fn) => reports.forEach(fn) };
}

describe('test-connstats (parseConnStats)', () => {
    it('collects candidates and picks the explicitly selected pair', () => {
        const parsed = parseConnStats(
            statsFixture([
                { type: 'local-candidate', id: 'L1', candidateType: 'host' },
                { type: 'remote-candidate', id: 'R1', candidateType: 'srflx' },
                { type: 'candidate-pair', id: 'P1', state: 'succeeded', nominated: true },
                { type: 'candidate-pair', id: 'P2', selected: true, localCandidateId: 'L1', remoteCandidateId: 'R1' },
            ])
        );
        parsed.pair.id.should.equal('P2');
        parsed.candidates.size.should.equal(2);
    });

    it('falls back to the freshest succeeded+nominated pair (Chromium)', () => {
        const parsed = parseConnStats(
            statsFixture([
                {
                    type: 'candidate-pair',
                    id: 'P1',
                    state: 'succeeded',
                    nominated: true,
                    lastPacketReceivedTimestamp: 100,
                },
                {
                    type: 'candidate-pair',
                    id: 'P2',
                    state: 'succeeded',
                    nominated: true,
                    lastPacketReceivedTimestamp: 900,
                },
                { type: 'candidate-pair', id: 'P3', state: 'succeeded', nominated: false },
                { type: 'candidate-pair', id: 'P4', state: 'failed', nominated: true },
            ])
        );
        should.not.exist(parsed.pair);
        parsed.fallback.id.should.equal('P2');
    });

    it('takes the first inbound-rtp as audio, honoring the legacy mediaType field', () => {
        const legacy = parseConnStats(
            statsFixture([{ type: 'inbound-rtp', mediaType: 'audio', packetsLost: 3, packetsReceived: 97 }])
        );
        legacy.inbound.packetsLost.should.equal(3);
        // 省略 kind 的报告（旧 Firefox）同样按音频收下
        const bare = parseConnStats(statsFixture([{ type: 'inbound-rtp', packetsLost: 1 }]));
        should.exist(bare.inbound);
        // 视频流（如果有）不冒充音频——inbound 保持缺席（无结论），
        // 绝不是伪造的 0
        const video = parseConnStats(statsFixture([{ type: 'inbound-rtp', kind: 'video' }]));
        should.not.exist(video.inbound);
    });

    it('extracts remote-inbound loss %% , jitter and the report timestamp', () => {
        const parsed = parseConnStats(
            statsFixture([{ type: 'remote-inbound-rtp', fractionLost: 0.037, jitter: 0.0045, timestamp: 12345 }])
        );
        parsed.outboundLoss.should.equal(3.7); // 0..1 → %，保留一位
        parsed.outboundJitter.should.equal(5); // s → ms
        parsed.outboundTs.should.equal(12345); // 陈旧报告的去重标识
        const missing = parseConnStats(statsFixture([{ type: 'remote-inbound-rtp' }]));
        should.not.exist(missing.outboundLoss);
        should.not.exist(missing.outboundTs);
    });

    it('reads the outbound encoder counters incl. targetBitrate', () => {
        const parsed = parseConnStats(
            statsFixture([{ type: 'outbound-rtp', kind: 'audio', bytesSent: 1000, targetBitrate: 64000 }])
        );
        parsed.outbound.should.eql({ bytesSent: 1000, timestamp: parsed.outbound.timestamp, targetBitrate: 64000 });
        const noBitrate = parseConnStats(statsFixture([{ type: 'outbound-rtp', bytesSent: 5 }]));
        should(noBitrate.outbound.targetBitrate).be.null();
    });
});

describe('test-connstats (assembleConnPath)', () => {
    const candidates = [
        { type: 'local-candidate', id: 'L', candidateType: 'host' },
        { type: 'remote-candidate', id: 'R', candidateType: 'srflx' },
        { type: 'local-candidate', id: 'LR', candidateType: 'relay' },
    ];

    it('direct candidates on both ends = p2p', () => {
        const parsed = parseConnStats(
            statsFixture([
                ...candidates,
                {
                    type: 'candidate-pair',
                    selected: true,
                    localCandidateId: 'L',
                    remoteCandidateId: 'R',
                    currentRoundTripTime: 0.021,
                },
            ])
        );
        const out = assembleConnPath('connected', parsed);
        out.type.should.equal('p2p');
        out.local.should.equal('host');
        out.remote.should.equal('srflx');
        out.rtt.should.equal(21);
    });

    it('any relay candidate = relay', () => {
        const parsed = parseConnStats(
            statsFixture([
                ...candidates,
                { type: 'candidate-pair', selected: true, localCandidateId: 'LR', remoteCandidateId: 'R' },
            ])
        );
        assembleConnPath('connected', parsed).type.should.equal('relay');
    });

    it('never claims p2p with an unverified path (missing candidates or no pair)', () => {
        const noPair = parseConnStats(statsFixture(candidates));
        assembleConnPath('connected', noPair).type.should.equal('unknown');
        const half = parseConnStats(
            statsFixture([
                ...candidates,
                { type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'MISSING' },
            ])
        );
        const out = assembleConnPath('connected', half);
        out.type.should.equal('unknown');
        out.local.should.equal('host'); // 已知的半边照常带回
        should.not.exist(out.remote);
    });

    it('keeps inbound/outbound counters through every outcome', () => {
        const parsed = parseConnStats(statsFixture([{ type: 'inbound-rtp', packetsLost: 2, packetsReceived: 50 }]));
        const out = assembleConnPath('connected', parsed);
        out.type.should.equal('unknown');
        out.inbound.packetsReceived.should.equal(50);
    });
});
