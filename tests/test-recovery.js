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
});
