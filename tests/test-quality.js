'use strict';

// npx mocha test-quality.js
// 质量引擎 pokeIce（僵尸链路/质量重启的 iceRestart）的 ghost 宽限让路
// 回归：对端 ghost 期间服务器会丢弃发往它的一切 SDP——此刻 poke 的
// offer 只会被吞，PC 反而被卡进 have-local-offer、冷却照烧
//（与 relay 升级引擎同一语义，见 test-relay.js / relay.js）。
// 宽限快照（恢复引擎 presence 探测写入的 ghostGraceUntil）在场时
// poke 必须顺延；快照失效（对端 resume / 宽限到期）或链路已交给
// 恢复阶梯后按情况发起或放弃。

require('should');
const { importBrowserModule } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('test-quality (quality restart defers inside the peer ghost grace)', () => {
    const SELF = 'aaaa1111-0000-0000-0000-000000000000';
    const PEER = 'ffff9999-0000-0000-0000-000000000000';
    const ZOMBIE_POLLS = 6; // 与 quality.js 的 ZOMBIE_POLLS 保持同步（触发阈值）

    let qualityMod;

    before(async () => {
        qualityMod = await importBrowserModule('public/js/pages/channel/quality.js');
    });

    function stubNode() {
        return {
            classList: { add() {}, remove() {}, toggle() {} },
            dataset: {},
            textContent: '',
            title: '',
            append() {},
            removeAttribute() {},
        };
    }

    /** 僵尸触发器：连投 ZOMBIE_POLLS+1 轮「已连接 + 对端声称在发送 +
     *  入向 RTP 计数器零增量」的路径轮询读数。 */
    function engine({ ghostGraceUntil = new Map() } = {}) {
        const restarts = [];
        const entries = new Map([[PEER, { pc: { connectionState: 'connected' } }]]);
        const s = {
            selfUuid: SELF,
            joined: true,
            mesh: {
                entries,
                restartIce: () => {
                    restarts.push(Date.now());
                    return Promise.resolve(true);
                },
                getOpusFmtp: () => null,
                setPeerJitterTarget() {},
                setPeerBitrateFloor() {},
            },
        };
        const members = new Map([[PEER, { peer_audio_status: true }]]);
        const quality = qualityMod.createLinkQuality({
            s,
            members,
            peerRecovery: new Map(),
            connPaths: new Map(),
            ghostGraceUntil,
            $: () => stubNode(),
            el: () => stubNode(),
            t: (key) => key,
        });
        const base = Date.now() - 10 * 60 * 1000;
        const poll = (i) =>
            quality.note(PEER, {
                state: 'connected',
                type: 'p2p',
                rtt: 12,
                // 逐轮同值的入向计数器：零字节数据 + 零增量 = 僵尸连击
                inbound: {
                    packetsLost: 0,
                    packetsReceived: 4000,
                    jitter: 0.001,
                    bytesReceived: 64000,
                    timestamp: base + i * 5000,
                    concealedSamples: 0,
                    totalSamplesReceived: 32000,
                    jitterBufferDelay: 0,
                    jitterBufferEmittedCount: 4000,
                },
                outboundLoss: null,
                outboundTs: null,
                outboundJitter: null,
                outbound: null,
            });
        return { quality, restarts, entries, poll };
    }

    it('must not poke while the peer is inside its ghost grace', async () => {
        const grace = new Map([[PEER, Date.now() + 5000]]);
        const { quality, restarts, poll } = engine({ ghostGraceUntil: grace });
        for (let i = 0; i <= ZOMBIE_POLLS; i += 1) poll(i);
        await sleep(150);
        restarts.should.eql([]); // 连击到点也不发——offer 只会被服务器吞掉
        quality.forget(PEER); // 清掉等待宽限的 pokeTimer
    });

    it('pokes once the grace expires', async () => {
        const grace = new Map([[PEER, Date.now() + 200]]);
        const { quality, restarts, poll } = engine({ ghostGraceUntil: grace });
        for (let i = 0; i <= ZOMBIE_POLLS; i += 1) poll(i);
        // 让路 min(200+500, 6000)=700ms → 宽限早已过期，poke 落地
        await sleep(950);
        restarts.should.have.length(1);
        quality.forget(PEER);
    });

    it('drops the deferred poke when the link entered the recovery ladder meanwhile', async () => {
        const grace = new Map([[PEER, Date.now() + 200]]);
        const { quality, restarts, entries, poll } = engine({ ghostGraceUntil: grace });
        for (let i = 0; i <= ZOMBIE_POLLS; i += 1) poll(i);
        // 等待期间对端链路转给恢复阶梯（presence/断线）——再发只会
        // 与梯子的 restart 轮次打架
        entries.delete(PEER);
        await sleep(950);
        restarts.should.eql([]);
        quality.forget(PEER);
    });

    it('still pokes right away without any ghost snapshot (main path intact)', async () => {
        const { quality, restarts, poll } = engine();
        for (let i = 0; i <= ZOMBIE_POLLS; i += 1) poll(i);
        await sleep(60);
        restarts.should.have.length(1);
        quality.forget(PEER);
    });
});
