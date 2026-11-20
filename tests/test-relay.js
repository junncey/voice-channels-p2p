'use strict';

// npx mocha test-relay.js
// relay 升级引擎的 ghost 宽限让路回归：对端 ghost 期间服务器会丢弃
// 发往它的一切 SDP——此刻 restart 的 offer 只会被吞，而「已发出」
// 照样烧一次尝试额度；两次烧完的 done 墓碑会挡死这条链路之后的
// relay 升级（直到下一次链路事件重置）。宽限快照（恢复引擎 presence
// 探测写入的 ghostGraceUntil）在场时 tick 必须让路、不烧额度，
// 快照失效（对端 resume → 'live' 分支删除 / 宽限到期）后照常发起。

require('should');
const { importBrowserModule } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('test-relay (relay upgrade defers inside the peer ghost grace)', () => {
    const SELF = 'aaaa1111-0000-0000-0000-000000000000';
    const PEER = 'ffff9999-0000-0000-0000-000000000000'; // self < peer：本侧有权发起
    let relayMod;
    let s;
    let restarts;
    let ghostGraceUntil;

    before(async () => {
        relayMod = await importBrowserModule('public/js/pages/channel/relay.js');
    });

    beforeEach(() => {
        restarts = [];
        ghostGraceUntil = new Map();
        s = {
            selfUuid: SELF,
            joined: true,
            mesh: {
                entries: new Map([[PEER, { pc: { connectionState: 'connected' } }]]),
                restartIce: () => {
                    restarts.push(Date.now());
                    return Promise.resolve(true);
                },
            },
        };
    });

    function engine(timings) {
        return relayMod.createRelayUpgrade({
            s,
            peerRecovery: new Map(),
            connPaths: new Map([[PEER, { state: 'connected', type: 'relay' }]]),
            ghostGraceUntil,
            timings,
        });
    }

    it('must not burn an attempt while the peer is inside its ghost grace', async () => {
        const relay = engine({ graceMs: 40, retryMs: 60 });
        // 快照必须先于首个 tick 到位（presence 探测在断线当下就能带回）
        ghostGraceUntil.set(PEER, Date.now() + 5000);
        relay.note(PEER, { state: 'connected', type: 'relay' });
        await sleep(220); // 宽限让路节拍（60ms）走了三跳以上
        restarts.should.eql([]); // 一次 restart 都没发——额度没被吞掉的信令烧掉
    });

    it('resumes the upgrade once the grace expires', async () => {
        const relay = engine({ graceMs: 40, retryMs: 5000 });
        ghostGraceUntil.set(PEER, Date.now() + 80); // 宽限只够让路一跳
        relay.note(PEER, { state: 'connected', type: 'relay' });
        // t≈40 首跳让路（defer min(80+500,5000)=520）→ t≈560 宽限早已
        // 过期，照常发起；下一次重试在 5s 之外，不会叠加第二次
        await sleep(640);
        restarts.should.have.length(1);
    });

    it('still upgrades right away without any ghost snapshot (main path intact)', async () => {
        const relay = engine({ graceMs: 40, retryMs: 5000 });
        relay.note(PEER, { state: 'connected', type: 'relay' });
        await sleep(120); // 宽限 40ms 到点即发起
        restarts.should.have.length(1);
    });
});
