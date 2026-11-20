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
