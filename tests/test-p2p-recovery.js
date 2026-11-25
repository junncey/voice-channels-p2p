'use strict';

// npx mocha test-p2p-recovery.js
// 打洞恢复的两处边界回归（specs/p2p-recovery-boundaries.md）：
//
//  1. 对端重建检测与「双方同时重建」相撞——双方梯子几乎同时升级到重建阶
//     时，后到的一方可能正在旧 PC 上应答先到一方的重建 offer；此刻它
//     再重建，旧 PC 的 answer 随 close 作废，而它新 PC 的 offer 又被
//     impolite 一方按完美协商忽略——两端各执一份无人应答的 offer，
//     只能双双落到 B1。
//  2. 非恢复（rejoin=false）的 addPeer 命中既有条目——该条目来自已经
//     终结的会话纪元：对端早已在 removePeer 时拆掉通向我们的 PC，
//     复用它意味着 offer 永远不会被重发。
//
// 信令服务器对「自身 join 尚未落座的发送者」的语义见 test-server.js。

require('should');
const { importBrowserModule } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

const A_ID = 'aaaa1111-0000-0000-0000-000000000000'; // 低 uuid：impolite
const B_ID = 'ffff9999-0000-0000-0000-000000000000'; // 高 uuid：polite

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

const sdpWith = (fingerprint) =>
    `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=group:BUNDLE 0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;

/** 指纹按实例唯一的假 PC：对端重建检测的事实来源就是「来 offer 的
 *  DTLS 指纹换了」。createAnswer 故意跨一个宏任务——真实浏览器里
 *  sRD → createAnswer → sLD 之间有 await 间隙，定时器可以在其间落点；
 *  close 之后的一切描述操作抛错（同真实浏览器）。 */
function installFakePC() {
    const had = Object.hasOwn(globalThis, 'RTCPeerConnection');
    const RealPC = globalThis.RTCPeerConnection;
    let serial = 0;
    globalThis.RTCPeerConnection = class {
        constructor() {
            serial += 1;
            this.serial = serial;
            this.fingerprint = serial.toString(16).padStart(2, '0').repeat(32).match(/../g).join(':');
            this.signalingState = 'stable';
            this.connectionState = 'new';
            this.localDescription = null;
            this.remoteDescription = null;
            this.closed = false;
        }

        _assertLive() {
            if (this.closed) throw new Error('InvalidStateError: The peer connection is closed');
        }

        async setRemoteDescription(desc) {
            this._assertLive();
            this.remoteDescription = desc;
            this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
        }

        async setLocalDescription(desc) {
            this._assertLive();
            if (desc.type === 'rollback') this.signalingState = 'stable';
            else {
                this.localDescription = desc;
                this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
            }
        }

        async createOffer() {
            this._assertLive();
            return { type: 'offer', sdp: sdpWith(this.fingerprint) };
        }

        async createAnswer() {
            await sleep(25);
            this._assertLive();
            return { type: 'answer', sdp: sdpWith(this.fingerprint) };
        }

        createDataChannel(label) {
            return { label, readyState: 'connecting' };
        }

        getSenders() {
            return [];
        }

        getReceivers() {
            return [];
        }

        getTransceivers() {
            return [];
        }

        close() {
            this.closed = true;
        }
    };
    return {
        restore() {
            if (had) globalThis.RTCPeerConnection = RealPC;
            else delete globalThis.RTCPeerConnection;
        },
    };
}

describe('test-p2p-recovery (remote rebuild detection in Mesh)', () => {
    let Mesh;
    let sdpFingerprint;

    before(async () => {
        ({ Mesh, sdpFingerprint } = await importBrowserModule('public/js/core/webrtc.js'));
    });

    /** 只覆盖应答路径用到的面的 PC，remoteDescription 可预置。 */
    function answeringPc(remoteSdp) {
        return {
            signalingState: 'stable',
            connectionState: 'failed',
            localDescription: null,
            remoteDescription: remoteSdp ? { type: 'offer', sdp: remoteSdp } : null,
            async setRemoteDescription(desc) {
                this.remoteDescription = desc;
                this.signalingState = 'have-remote-offer';
            },
            async setLocalDescription(desc) {
                if (desc.type === 'rollback') this.signalingState = 'stable';
                else {
                    this.localDescription = desc;
                    this.signalingState = 'stable';
                }
            },
            async createAnswer() {
                return { type: 'answer', sdp: sdpWith('ab') };
            },
            getSenders: () => [],
            getReceivers: () => [],
            getTransceivers: () => [],
        };
    }

    function meshWithEntry(remoteSdp) {
        const rebuilt = [];
        const mesh = new Mesh({ signaling: { emit() {} }, handlers: { onPeerRebuilt: (id) => rebuilt.push(id) } });
        mesh.entries.set('p1', {
            pc: answeringPc(remoteSdp),
            pendingIce: [],
            queue: [],
            queueBytes: 0,
            tracksAdded: true,
            offering: false,
        });
        return { mesh, rebuilt };
    }

    const offerMsg = (sdp, seq) => ({ peer_id: 'p1', session_description: { type: 'offer', sdp }, sdp_seq: seq });

    it('parses the DTLS fingerprint line (case-insensitive, CRLF and LF)', () => {
        sdpFingerprint(sdpWith('AB:CD')).should.equal('AB:CD');
        sdpFingerprint('v=0\na=fingerprint:sha-256 ab:cd\n').should.equal('AB:CD');
        should.not.exist(sdpFingerprint('v=0 no fingerprint'));
        should.not.exist(sdpFingerprint(undefined));
    });

    it('flags an offer whose fingerprint differs from the negotiated remote one', async () => {
        // 全新 PC = 全新证书 = 全新指纹；ICE restart 只换 ice-ufrag，
        // 指纹不变——两者由此区分
        const { mesh, rebuilt } = meshWithEntry(sdpWith('11:22'));
        await mesh.handleSessionDescription(offerMsg(sdpWith('33:44'), 9));
        rebuilt.should.eql(['p1']);
    });

    it('does not flag a plain ICE-restart offer (same fingerprint)', async () => {
        const { mesh, rebuilt } = meshWithEntry(sdpWith('11:22'));
        await mesh.handleSessionDescription(offerMsg(sdpWith('11:22'), 9));
        rebuilt.should.eql([]);
    });

    it('does not flag the first offer on a PC, nor offers without fingerprints', async () => {
        const first = meshWithEntry(null);
        await first.mesh.handleSessionDescription(offerMsg(sdpWith('33:44'), 1));
        first.rebuilt.should.eql([]); // 这份 PC 自己就是新的：没有「对端重建」可言
        const bare = meshWithEntry('v=0 legacy');
        await bare.mesh.handleSessionDescription(offerMsg('v=0 legacy too', 2));
        bare.rebuilt.should.eql([]); // 任一侧读不出指纹：无结论
    });

    it('does not flag answers (only offers can rebuild the remote PC)', async () => {
        const { mesh, rebuilt } = meshWithEntry(sdpWith('11:22'));
        mesh.entries.get('p1').pc.signalingState = 'have-local-offer';
        mesh.entries.get('p1').offerSeq = 4;
        await mesh.handleSessionDescription({
            peer_id: 'p1',
            session_description: { type: 'answer', sdp: sdpWith('33:44') },
            sdp_seq: 4,
        });
        rebuilt.should.eql([]);
    });
});

describe('test-p2p-recovery (simultaneous rebuild collision)', function () {
    this.timeout(10000);
    let Mesh;
    let recoveryMod;
    let fake;
    let nodes;

    before(async () => {
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        fake = installFakePC();
        ({ Mesh } = await importBrowserModule('public/js/core/webrtc.js'));
        recoveryMod = await importBrowserModule('public/js/pages/channel/recovery.js');
    });

    afterEach(() => {
        for (const node of Object.values(nodes)) {
            node.recovery.clearPeerRecovery();
            node.recovery.resetForTeardown();
        }
    });

    after(() => {
        fake.restore();
    });

    /** 一个节点 = Mesh + 恢复梯子；发出的信令经 deliver 送往对端。 */
    function buildNode(name, selfId, peerId) {
        const socket = {
            connected: true,
            calls: [],
            timeout: () => ({ emit() {} }),
            disconnect: () => socket.calls.push('disconnect'),
            connect: () => socket.calls.push('connect'),
        };
        const mesh = new Mesh({
            signaling: { emit: (evt, payload) => deliver(name, payload) },
            handlers: {},
            getSelfId: () => selfId,
        });
        const s = { selfUuid: selfId, joined: true, socket, mesh, chat: { add() {} } };
        const recovery = recoveryMod.createRecovery({
            s,
            x: { dropPeer() {} },
            members: new Map(),
            channelId: `sim-${name}`,
            $: () => stubNode(),
            el: () => stubNode(),
            t: (key) => key,
        });
        // 接线形态照搬 channel.js 的 meshHandlers（页面控制器依赖 DOM，
        // 不在 Node 侧加载）：Mesh 的事实经 handlers 交给恢复梯子
        mesh.handlers.onPeerState = (id, state) => recovery.notePeerState(id, state);
        mesh.handlers.onPeerRebuilt = (id) => recovery.notePeerRebuilt(id);
        const node = { name, selfId, peerId, mesh, s, recovery, onReceive: null };
        nodes[name] = node;
        return node;
    }

    function deliver(from, payload) {
        const to = nodes[from === 'A' ? 'B' : 'A'];
        to.mesh.handleSessionDescription({
            peer_id: nodes[from].selfId,
            session_description: payload.session_description,
            sdp_seq: payload.sdp_seq,
        });
        if (to.onReceive) to.onReceive(payload);
    }

    /** 两端已协商过一轮（互为对方的旧指纹），链路 failed，恢复记录都
     *  停在「窗口已耗尽」的升级点。 */
    async function brokenSession() {
        nodes = {};
        const a = buildNode('A', A_ID, B_ID);
        const b = buildNode('B', B_ID, A_ID);
        b.mesh.addPeer(A_ID, false, []); // B 是既有成员：应答方
        a.mesh.addPeer(B_ID, true, []); // A 是加入方：初始 offer（seq 1）
        await sleep(90); // B 应答、A 应用
        a.mesh.entries.get(B_ID).pc.remoteDescription.type.should.equal('answer');
        for (const node of [a, b]) {
            node.mesh.entries.get(node.peerId).pc.connectionState = 'failed';
            node.recovery.peerRecovery.set(node.peerId, {
                timer: null,
                attempts: 3,
                lastState: 'failed',
                brokenAt: Date.now() - 60000,
                escalated: false,
                flappy: false,
            });
        }
        return { a, b };
    }

    it('must not rebuild over an in-flight answer to the peer own rebuild offer', async () => {
        const { a, b } = await brokenSession();
        const bOldPc = b.mesh.entries.get(A_ID).pc;
        // A 的重建 offer（seq 2）一到 B，B 的梯子恰好也走到升级点——此刻
        // B 的旧 PC 正在应答这份 offer（createAnswer 尚未返回）
        b.onReceive = (payload) => {
            if (payload.sdp_seq === 2) setTimeout(() => b.recovery.markSessionRestored(), 0);
        };
        a.recovery.markSessionRestored(); // A 的梯子先到升级点：重建并重新 offer
        await sleep(200);

        // B 没有跟着重建：旧 PC 应答了 A 的新 PC，协商闭合
        b.mesh.entries.get(A_ID).pc.should.equal(bOldPc);
        bOldPc.closed.should.be.false();
        bOldPc.localDescription.type.should.equal('answer');
        // 修复前：B 重建把旧 PC 的 answer 带进坟墓，而 B 新 PC 的 offer 被
        // impolite 的 A 忽略——A 的新 PC 永远停在 have-local-offer
        a.mesh.entries.get(B_ID).pc.remoteDescription?.type.should.equal('answer');
        a.s.socket.calls.should.eql([]); // 没有任何一方落到 B1
        b.s.socket.calls.should.eql([]);
    });
});

describe('test-p2p-recovery (recovery ladder yields to a peer rebuild)', () => {
    let recoveryMod;
    let recovery;
    let meshEntries;

    before(async () => {
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        recoveryMod = await importBrowserModule('public/js/pages/channel/recovery.js');
    });

    beforeEach(() => {
        meshEntries = new Map();
        const s = {
            selfUuid: 'aaaa-self',
            joined: true,
            socket: { connected: true, timeout: () => ({ emit() {} }) },
            mesh: { entries: meshEntries, clear() {}, restartIce: () => Promise.resolve(true) },
            chat: { add() {} },
        };
        recovery = recoveryMod.createRecovery({
            s,
            x: { dropPeer() {} },
            members: new Map(),
            channelId: 'yield',
            $: () => stubNode(),
            el: () => stubNode(),
            t: (key) => key,
        });
    });

    afterEach(() => {
        recovery.clearPeerRecovery();
        recovery.resetForTeardown();
    });

    it('gives the fresh negotiation a full window (attempts and clock reset)', () => {
        const PEER = 'zzzz-peer';
        const stale = Date.now() - 60000;
        recovery.peerRecovery.set(PEER, {
            timer: null,
            attempts: 3,
            lastState: 'failed',
            brokenAt: stale,
            escalated: false,
            flappy: false,
        });
        const before = Date.now();
        recovery.notePeerRebuilt(PEER);
        const rec = recovery.peerRecovery.get(PEER);
        rec.brokenAt.should.be.aboveOrEqual(before); // 窗口从对端重建那一刻重新起算
        rec.attempts.should.equal(0);
        rec.escalated.should.be.false();
    });

    it('leaves escalated ladders alone (B1 is still the way out)', () => {
        const PEER = 'zzzz-peer';
        const stale = Date.now() - 60000;
        recovery.peerRecovery.set(PEER, {
            timer: null,
            attempts: 3,
            lastState: 'failed',
            brokenAt: stale,
            escalated: true,
            flappy: false,
        });
        recovery.notePeerRebuilt(PEER);
        recovery.peerRecovery.get(PEER).brokenAt.should.equal(stale);
        recovery.notePeerRebuilt('never-seen'); // 没有恢复记录：无事可做
    });
});

describe('test-p2p-recovery (addPeer on a stale entry)', () => {
    const SELF = '11111111-1111-1111-1111-111111111111';
    const PEER = '22222222-2222-2222-2222-222222222222';
    let handlers;
    let mesh;
    let emitted;
    let recCalls;
    let fake;

    before(async () => {
        global.window = { addEventListener() {} };
        global.document = { addEventListener() {} };
        fake = installFakePC();
        const { Mesh } = await importBrowserModule('public/js/core/webrtc.js');
        const mod = await importBrowserModule('public/js/pages/channel/socketEvents.js');
        handlers = {};
        emitted = [];
        recCalls = [];
        mesh = new Mesh({ signaling: { emit: (evt, payload) => emitted.push({ evt, payload }) }, handlers: {} });
        const s = {
            selfUuid: SELF,
            joined: true,
            socket: { on: (ev, fn) => (handlers[ev] = fn) },
            mesh,
            chat: { add() {} },
        };
        const rec = {
            forgetPeer: (id) => recCalls.push(['forget', id]),
            armConnectingBadge: (id) => recCalls.push(['badge', id]),
            notePeerState() {},
            retryStuckOffer: (id) => recCalls.push(['unstick', id]),
        };
        const mem = { syncMembers() {}, updateOnlineCount() {} };
        const se = mod.createSocketEvents({
            s,
            x: {},
            rec,
            mem,
            members: new Map([
                [SELF, { peer_name: 'me' }],
                [PEER, { peer_name: 'B' }],
            ]),
            avatars: new Map(),
            peerVolumes: {},
            channelId: 'testroom',
            NICK_KEY: 'vc_nick',
            AVATAR_MAX_CHARS: 96 * 1024,
            DATA_URL_RE: /^data:image\//,
            validReply: () => null,
            screenLock: { sync() {} },
            playSound() {},
            toast() {},
            t: (key) => key,
            $: () => stubNode(),
        });
        se.registerSocketHandlers();
    });

    after(() => {
        fake.restore();
    });

    const offers = () => emitted.filter((e) => e.evt === 'relaySDP').map((e) => e.payload.sdp_seq);

    it('replaces the stale entry and offers again on a non-rejoin addPeer', async () => {
        // 上个会话纪元的条目：初始 offer（seq 1）在本端断线期间被缓冲，
        // 重连时先于 join 冲刷、被服务器丢弃——对端也在我们被移除时
        // 拆掉了旧 PC。链路停在 new + have-local-offer：恢复梯子对
        // 过渡态不动作，这份 offer 永远等不到 answer
        mesh.addPeer(PEER, true, []);
        await flush();
        const stalePc = mesh.entries.get(PEER).pc;
        stalePc.signalingState.should.equal('have-local-offer');
        offers().should.eql([1]);

        handlers.addPeer({ peer_id: PEER, peers: {}, should_create_offer: true, iceServers: [], rejoin: false });
        await flush();

        stalePc.closed.should.be.true();
        mesh.entries.get(PEER).pc.should.not.equal(stalePc);
        offers().should.eql([1, 2]); // 全新 PC 的 offer 立刻发出（代次账本延续）
        recCalls.should.eql([
            ['forget', PEER], // 旧链路的恢复记录一并清账
            ['badge', PEER], // 新链路重新武装「连接中…」徽章
        ]);
    });

    it('replaces a stale entry on the answering side too (no pending offer to trap the peer)', async () => {
        const current = mesh.entries.get(PEER).pc;
        handlers.addPeer({ peer_id: PEER, peers: {}, should_create_offer: false, iceServers: [], rejoin: false });
        await flush();
        mesh.entries.get(PEER).pc.should.not.equal(current);
        should(mesh.entries.get(PEER).pc.localDescription).equal(null); // 纯应答方：留给对端的 offer
        offers().should.eql([1, 2]); // 没有多发 offer
    });

    it('keeps reusing the entry on a resume (rejoin:true) and unsticks a pending offer', async () => {
        const resumed = mesh.entries.get(PEER).pc;
        recCalls.length = 0;
        handlers.addPeer({ peer_id: PEER, peers: {}, should_create_offer: true, iceServers: [], rejoin: true });
        await flush();
        mesh.entries.get(PEER).pc.should.equal(resumed); // 原地恢复：PC 与 DataChannel 复用
        recCalls.should.eql([['unstick', PEER]]);
    });

    it('leaves brand-new peers on the plain add path (nothing to forget)', async () => {
        const FRESH = '33333333-3333-3333-3333-333333333333';
        recCalls.length = 0;
        handlers.addPeer({ peer_id: FRESH, peers: {}, should_create_offer: true, iceServers: [], rejoin: false });
        await flush();
        mesh.entries.has(FRESH).should.be.true();
        recCalls.should.eql([]);
    });
});
