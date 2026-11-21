'use strict';

// npx mocha test-recovery.js
// 恢复引擎 B1 预算回零的回归：10s 恢复扫描会对每个健康对端重报
// 'connected'（此时无恢复记录、早退挡不住）——重报绝不能重置
// 「稳定 RECOVERY_B1_RESET_MS 后预算回满」的定时器，否则定时器
// 永不到期（每 10s 被重设）：一次故障耗尽自动重连预算后，
// 哪怕稳定运行数小时，下一次链路故障也只肯给用户「手动重载」。

require('should');
const { importBrowserModule } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('test-recovery (B1 budget refill must survive repeated connected reports)', () => {
    let recovery;
    let meshEntries;
    const PEER = 'peer-aaaa';

    before(async () => {
        // 恢复引擎在工厂体内向 window/document 挂监听（online /
        // visibilitychange）——最小 stub 即可；jsdom 套件会在各自的
        // before 里重设自己的全局（全局设置放套件钩子的约定见
        // test-chat-dom.js）
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        meshEntries = new Map();
        const s = {
            selfUuid: 'self-zzzz',
            joined: true,
            socket: { connected: true, disconnect() {}, connect() {}, timeout: () => ({ emit() {} }) },
            mesh: {
                entries: meshEntries,
                clear() {},
                restartIce: () => Promise.resolve(true),
                unstickStaleOffer: () => Promise.resolve(false),
                rebuildPeer: () => true,
            },
            chat: { add() {} },
        };
        const mod = await importBrowserModule('public/js/pages/channel/recovery.js');
        recovery = mod.createRecovery({
            s,
            x: { dropPeer() {} },
            members: new Map(),
            channelId: 'testroom',
            $: () => stubNode(),
            el: () => stubNode(),
            t: (key) => key,
            timings: { b1ResetMs: 300 },
        });
    });

    after(() => {
        // disconnected 建 rec 时武装的 5s 宽限定时器不得在测试结束后
        // 继续烧轮次（全量回归的后台噪声）
        recovery.clearPeerRecovery();
        recovery.resetForTeardown();
    });

    it('repeated connected reports (recovery scan) must not postpone the refill', async () => {
        recovery.markSessionRestored();
        recovery.attemptSignalingReconnect({ manual: true });
        recovery.debugState().b1Attempts.should.equal(1);
        recovery.notePeerState(PEER, 'connected'); // 武装：t=300ms 回零
        // 模拟 10s 恢复扫描的重报节拍（压缩为 80ms），全部落在武装
        // 窗口内：修复前每次重报都重设定时器（到期被推到 t≈540ms），
        // t≈450ms 处预算尚未回满——断言恰好在两种行为间分野
        for (let i = 0; i < 3; i += 1) {
            await sleep(80);
            recovery.notePeerState(PEER, 'connected');
        }
        await sleep(210); // 越过首次武装的到期点
        recovery.debugState().b1Attempts.should.equal(0);
    });

    it('a fresh break cancels the armed refill (instability must not refill)', async () => {
        recovery.markSessionRestored();
        recovery.attemptSignalingReconnect({ manual: true });
        recovery.notePeerState(PEER, 'connected'); // 武装
        meshEntries.set(PEER, { pc: { connectionState: 'disconnected' } });
        recovery.notePeerState(PEER, 'disconnected'); // 新的不稳定：解除武装
        await sleep(400);
        recovery.debugState().b1Attempts.should.equal(1); // 稳定期被打断：不回填
    });

    it('recovery re-arms the refill from the moment of stability', async () => {
        recovery.notePeerState(PEER, 'connected'); // 清 rec + 重新武装
        await sleep(400);
        recovery.debugState().b1Attempts.should.equal(0);
    });

    it('must not refill the budget while any recovery record is pending (perpetual B1 loop guard)', async () => {
        // 一条永久治不好的链路挂账期间，健康链路每 10s 扫描的
        // 'connected' 重报不得重新武装预算回填——否则预算回零 +
        // escalated 重试 = 每 ~80-90s 核爆整个房间的永动 B1 循环
        recovery.markSessionRestored();
        recovery.attemptSignalingReconnect({ manual: true });
        recovery.debugState().b1Attempts.should.equal(1);
        meshEntries.set(PEER, { pc: { connectionState: 'disconnected' } });
        recovery.notePeerState(PEER, 'disconnected'); // 坏链路挂账
        meshEntries.set('peer-healthy', { pc: { connectionState: 'connected' } });
        for (let i = 0; i < 3; i += 1) {
            await sleep(80);
            recovery.notePeerState('peer-healthy', 'connected'); // 10s 扫描重报（压缩节拍）
        }
        await sleep(210); // 越过假设被武装的 300ms 回填终点
        recovery.debugState().b1Attempts.should.equal(1); // 预算没有回零
        // 挂账清空（坏链路治愈）后，下一次健康报告照常武装
        recovery.notePeerState(PEER, 'connected');
        await sleep(400);
        recovery.debugState().b1Attempts.should.equal(0);
    });
});

describe('test-recovery (escalated ladder must retry B1 once conditions allow)', () => {
    // 升级到 B1 时 socket 可能已死（网络分区、服务器重启）：旧实现
    // 在 escalated 后没有任何自驱动——同状态的状态事件与 10s 扫描都
    // 早退，socket 恢复、resume join 落地后也没有任何一方再发起
    // restart/B1，媒体静默死亡且无横幅。回归：escalated 梯子在
    // serverInfo（markSessionRestored 的链路重扫）后必须重新尝试 B1。

    const PEER = 'peer-bbbb';
    let recovery;
    let s;
    let socketCalls;
    let meshClears;

    before(async () => {
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        socketCalls = [];
        meshClears = [];
        s = {
            selfUuid: 'self-zzzz',
            joined: true,
            socket: null, // 场景从「escalate 时 socket 已死」开始
            mesh: {
                entries: new Map([[PEER, { pc: { connectionState: 'failed' } }]]),
                clear: () => meshClears.push(Date.now()),
                restartIce: () => Promise.resolve(true),
                unstickStaleOffer: () => Promise.resolve(false),
                rebuildPeer: () => true,
            },
            chat: { add() {} },
        };
        const mod = await importBrowserModule('public/js/pages/channel/recovery.js');
        recovery = mod.createRecovery({
            s,
            x: { dropPeer: (id) => recovery.forgetPeer(id) },
            members: new Map([[PEER, { peer_name: 'B' }]]),
            channelId: 'testroom2',
            $: () => stubNode(),
            el: () => stubNode(),
            t: (key) => key,
        });
    });

    beforeEach(() => {
        recovery.clearPeerRecovery();
        recovery.resetForTeardown();
    });

    after(() => {
        recovery.clearPeerRecovery();
        recovery.resetForTeardown();
    });

    /** 直接放入一个已升级（轮次耗尽、已重建过）的恢复记录。 */
    function escalateLadder() {
        recovery.peerRecovery.set(PEER, {
            timer: null,
            attempts: 3,
            lastState: 'failed',
            brokenAt: Date.now(),
            escalated: true,
            flappy: false,
            rebuilt: true,
        });
    }

    it('keeps the escalated rec armed (no budget burned) while the socket is gone', async () => {
        escalateLadder();
        recovery.markSessionRestored(); // rescan 只能重排 tick——B1 发不出
        await sleep(60); // tick(0)：escalated → attempt 早退 → 重排 10s
        recovery.debugState().b1Attempts.should.equal(0); // 预算没被烧
        recovery.peerRecovery.has(PEER).should.equal(true); // 梯子没有死掉
        meshClears.should.have.length(0); // mesh 也未被拆除
    });

    it('fires B1 from the re-armed tick once the socket is back (serverInfo rescan)', async () => {
        escalateLadder();
        s.socket = {
            connected: true,
            disconnect: () => socketCalls.push('disconnect'),
            connect: () => socketCalls.push('connect'),
            timeout: () => ({ emit() {} }),
        };
        recovery.markSessionRestored(); // 服务器回来 + resume join 的 serverInfo
        await sleep(60);
        recovery.debugState().b1Attempts.should.equal(1);
        socketCalls.should.eql(['disconnect', 'connect']);
        meshClears.should.have.length(1); // B1 = 全量重建
        recovery.peerRecovery.has(PEER).should.equal(false); // 落地即随 forget 取消
    });
});

describe('test-recovery (outage banner survives healthy re-reports while any link is pending)', () => {
    // 任何 'connected' 上报都无条件收起断线横幅的话：健康链路每 10s
    // 扫描的重报会把 B1 进行中的「恢复中」横幅、乃至预算耗尽后的
    // 「请重载」终态横幅悄悄藏掉——挂账链路还断着，用户却被告知
    // 一切正常（与 B1 预算回填的全表稳定语义同族，见上一个套件）。

    const BROKEN = 'peer-broken';
    const HEALTHY = 'peer-healthy';
    let recovery;

    before(async () => {
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        const hidden = new Set(['hidden']);
        const banner = {
            classList: {
                add: (cls) => hidden.add(cls),
                remove: (cls) => hidden.delete(cls),
                toggle() {},
            },
            dataset: {},
            textContent: '',
            title: '',
            append() {},
            removeAttribute() {},
        };
        const meshEntries = new Map([
            [BROKEN, { pc: { connectionState: 'disconnected' } }],
            [HEALTHY, { pc: { connectionState: 'connected' } }],
        ]);
        const s = {
            selfUuid: 'self-zzzz',
            joined: true,
            socket: { connected: true, disconnect() {}, connect() {}, timeout: () => ({ emit() {} }) },
            mesh: {
                entries: meshEntries,
                clear() {},
                restartIce: () => Promise.resolve(true),
                unstickStaleOffer: () => Promise.resolve(false),
                rebuildPeer: () => true,
            },
            chat: { add() {} },
        };
        const mod = await importBrowserModule('public/js/pages/channel/recovery.js');
        recovery = mod.createRecovery({
            s,
            x: { dropPeer() {} },
            members: new Map(),
            channelId: 'testroom3',
            $: (sel) => (sel === '#outageBanner' ? banner : stubNode()),
            el: () => stubNode(),
            t: (key) => key,
            timings: { b1ResetMs: 60 * 1000 },
        });
        recovery.bannerHidden = () => hidden.has('hidden');
    });

    after(() => {
        recovery.clearPeerRecovery();
        recovery.resetForTeardown();
    });

    it('keeps the terminal banner visible while a broken link is still on the ladder', () => {
        recovery.notePeerState(BROKEN, 'disconnected'); // 坏链路挂账
        recovery.showOutageBanner('failed'); // B1 预算耗尽的「请重载」终态
        recovery.bannerHidden().should.equal(false);
        // 10s 健康扫描对无恙链路的重报（无恢复记录，早退挡不住）
        recovery.notePeerState(HEALTHY, 'connected');
        recovery.bannerHidden().should.equal(false); // 挂账未清：横幅不收
        // 最后一条挂账链路治愈，全表稳定——现在才收
        recovery.notePeerState(BROKEN, 'connected');
        recovery.bannerHidden().should.equal(true);
    });
});

describe('test-recovery (flappy fast lane escalates at its 6s window, not +12s later)', function () {
    // 抖动捷径（FLAP_HEAL_THRESHOLD 次自愈后）：一轮立即 restart +
    // 一次沉淀节拍，然后升级到重建阶。「轮次用完但窗口未结束」分支
    // 曾用固定 12s 节拍——把 6s 快车道推迟到 ~15s 才升级；修复后
    // 该节拍对准窗口准点（min(12s, 窗口剩余)），重建在 ~6.1s 落地。

    this.timeout(15000);
    const PEER = 'zzzz9999-peer'; // self < peer：本侧是低 uuid，轮次先手
    let recovery;
    let rebuilds;

    before(async () => {
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        rebuilds = [];
        const meshEntries = new Map();
        const s = {
            selfUuid: 'aaaa1111-self',
            joined: true,
            socket: { connected: true, disconnect() {}, connect() {}, timeout: () => ({ emit() {} }) },
            mesh: {
                entries: meshEntries,
                clear() {},
                restartIce: () => Promise.resolve(true),
                unstickStaleOffer: () => Promise.resolve(false),
                rebuildPeer: () => {
                    rebuilds.push(Date.now());
                    return true;
                },
            },
            chat: { add() {} },
        };
        const mod = await importBrowserModule('public/js/pages/channel/recovery.js');
        recovery = mod.createRecovery({
            s,
            x: { dropPeer: (id) => recovery.forgetPeer(id) },
            members: new Map(),
            channelId: 'testroom4',
            $: () => stubNode(),
            el: () => stubNode(),
            t: (key) => key,
            timings: { b1ResetMs: 60 * 1000 },
        });

        // 5 分钟窗口内自愈 4 次 → 下一次断线走 flappy 快车道
        meshEntries.set(PEER, { pc: { connectionState: 'disconnected' } });
        for (let i = 0; i < 4; i += 1) {
            recovery.notePeerState(PEER, 'disconnected');
            meshEntries.set(PEER, { pc: { connectionState: 'connected' } });
            recovery.notePeerState(PEER, 'connected');
            meshEntries.set(PEER, { pc: { connectionState: 'disconnected' } });
        }
        // 真实的一次断线（failed → 立即轮 1）
        meshEntries.set(PEER, { pc: { connectionState: 'failed' } });
        recovery.notePeerState(PEER, 'failed');
    });

    after(() => {
        recovery.clearPeerRecovery();
        recovery.resetForTeardown();
    });

    it('escalates to the rebuild stage within the compressed window', async () => {
        // 轮 1（t≈0，restart 立即成功）→ +3s 沉淀复查（轮次用完）→
        // 夹紧后的节拍再 ~3.1s → 窗口到点升级。重建在 ~6.2s 落地；
        // 修复前的固定 12s 节拍要等到 ~15s
        await sleep(8600);
        rebuilds.should.have.length(1);
    });
});

describe('test-recovery (same-NAT never-connected links rebuild relay-only)', () => {
    // specs/same-nat-relay-recovery.md：同 NAT（双方 srflx 同公网 IP）
    // 且从未连上的链路，梯子升级到重建阶时请求 relay-only PC；
    // 曾连上过的链路维持普通重建。节拍经 timings 注入压缩到毫秒级。
    // SELF < PEER：本侧是低 uuid 先手方，restart 轮次立即发起
    // （高 uuid 方要走 9s 破例窗口，压缩节拍压不动它）。
    const SELF = 'aaaa-self';
    const PEER = 'zzzz-peer';

    function stubNode() {
        return { classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, textContent: '', append() {} };
    }

    /** 同 NAT 与否可配置的引擎（sameNat 为 undefined 时干脆不提供
     *  该方法——模拟旧 stub / 旧 Mesh）。 */
    function makeEngine(sameNat) {
        const meshEntries = new Map();
        const rebuilds = [];
        const mesh = {
            entries: meshEntries,
            clear() {},
            restartIce: () => Promise.resolve(true),
            unstickStaleOffer: () => Promise.resolve(false),
            rebuildPeer(peerId, opts) {
                rebuilds.push({ peerId, opts });
                return true;
            },
        };
        if (sameNat !== undefined) mesh.sameNatWith = () => sameNat;
        const recovery = mod.createRecovery({
            s: {
                selfUuid: SELF,
                joined: true,
                socket: { connected: true, disconnect() {}, connect() {}, timeout: () => ({ emit() {} }) },
                mesh,
                chat: { add() {} },
            },
            members: new Map(),
            channelId: 'testroom',
            $: () => stubNode(),
            el: () => stubNode(),
            t: (key) => key,
            timings: { roundDelays: [10, 10, 10], totalMs: 40 },
        });
        return { meshEntries, rebuilds, recovery };
    }

    let mod;
    let lastRecovery = null; // afterEach 清扫（梯子重建/B1 回填的定时器不得泄漏到后续套件）
    before(async () => {
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        mod = await importBrowserModule('public/js/pages/channel/recovery.js');
    });

    afterEach(() => {
        if (lastRecovery) {
            lastRecovery.clearPeerRecovery();
            lastRecovery.resetForTeardown();
            lastRecovery = null;
        }
    });

    /** 走完压缩梯子（roundDelays [10,10,10]、窗口 40ms）直到重建。 */
    async function driveToRebuild(recovery, meshEntries) {
        meshEntries.set(PEER, { pc: { connectionState: 'failed' } });
        recovery.notePeerState(PEER, 'failed');
        await sleep(150); // 轮 1-3（t≈0/10/20）→ 窗口复查（t≈30）→ 升级重建（t≈40）
    }

    it('requests a relay-only rebuild for a same-NAT link that never connected', async () => {
        const { meshEntries, rebuilds, recovery } = makeEngine(true);
        lastRecovery = recovery;
        await driveToRebuild(recovery, meshEntries);
        rebuilds.should.have.length(1);
        rebuilds[0].peerId.should.equal(PEER);
        rebuilds[0].opts.relayOnly.should.be.true();
    });

    it('keeps the normal rebuild for a link that has connected before', async () => {
        const { meshEntries, rebuilds, recovery } = makeEngine(true);
        lastRecovery = recovery;
        // 曾连上过（哪怕后来断线）：relay-only 只留给从未连上的链路
        recovery.notePeerState(PEER, 'connected');
        await driveToRebuild(recovery, meshEntries);
        rebuilds.should.have.length(1);
        rebuilds[0].opts.relayOnly.should.be.false();
    });

    it('does not request relay-only for a cross-network peer (sameNat false)', async () => {
        const { meshEntries, rebuilds, recovery } = makeEngine(false);
        lastRecovery = recovery;
        await driveToRebuild(recovery, meshEntries);
        rebuilds.should.have.length(1);
        rebuilds[0].opts.relayOnly.should.be.false();
    });
});
