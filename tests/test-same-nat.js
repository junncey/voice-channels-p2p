'use strict';

// npx mocha test-same-nat.js
// 同 NAT 判定与 relay-only 重建的回归（specs/same-nat-relay-recovery.md）。
// 背景：双方 srflx 候选 IP 相同的对等（同一路由器/CGNAT 下的两台
// 设备）在 host 直连被拦、srflx 回环过不了 CGNAT 的网络里只能靠
// TURN relay 相连，而普通全候选矩阵的重建风暴会反复掐断缓慢的
// relay 收集——恢复梯子因此对「从未连上」的同 NAT 链路改用
// relay-only PC。Mesh 负责事实（srflx 集合 + sameNatWith），
// rebuildPeer/addPeer 的 relayOnly 选项负责落地（含无 TURN 时的
// 降级守卫）。

require('should');
const { importBrowserModule } = require('./helpers');

const SRFLX_A = 'candidate:1 1 udp 1686052607 117.151.16.0 23189 typ srflx raddr 192.168.0.110 rport 55170';
const SRFLX_B = 'candidate:2 1 udp 1686052607 58.48.104.199 18501 typ srflx raddr 192.168.113.4 rport 55170';
const HOST = 'candidate:3 1 udp 2122260223 192.168.0.110 55170 typ host generation 0';
const RELAY = 'candidate:4 1 udp 58662911 124.220.169.206 49243 typ relay raddr 117.151.16.0 rport 23189';
const PRFLX = 'candidate:5 1 udp 1686052607 117.151.16.0 34567 typ prflx raddr 10.0.0.1 rport 1234';
const MDNS_HOST = 'candidate:6 1 udp 2122260223 8ab7f1c3.local 55170 typ host generation 0';

const TURN_ICE = [{ urls: 'turn:rtc.example.com:3478', username: 'u', credential: 'p' }];
const STUN_ONLY_ICE = [{ urls: 'stun:rtc.example.com:3478' }];

/** 记录构造配置的假 PC（面覆盖 addPeer/rebuildPeer 路径；
 *  test-mesh-chat.js 的 globalThis.RTCPeerConnection 先例同款）。 */
function installFakePC() {
    const had = Object.hasOwn(globalThis, 'RTCPeerConnection');
    const RealPC = globalThis.RTCPeerConnection;
    const constructed = [];
    globalThis.RTCPeerConnection = class {
        constructor(config) {
            this.config = config;
            this.signalingState = 'stable';
            this.connectionState = 'new';
            this.localDescription = null;
            this.remoteDescription = null;
            constructed.push(this);
        }

        createDataChannel(label) {
            return { label, readyState: 'connecting' };
        }

        async createOffer() {
            return { type: 'offer', sdp: 'v=0 offer' };
        }

        async setLocalDescription(desc) {
            if (desc.type !== 'rollback') this.localDescription = desc;
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

        close() {}
    };
    return {
        constructed,
        restore() {
            if (had) globalThis.RTCPeerConnection = RealPC;
            else delete globalThis.RTCPeerConnection;
        },
    };
}

describe('test-same-nat (candidateSrflxIp parsing)', () => {
    let candidateSrflxIp;

    before(async () => {
        ({ candidateSrflxIp } = await importBrowserModule('public/js/core/webrtc.js'));
    });

    it('extracts the address of srflx candidates', () => {
        candidateSrflxIp(SRFLX_A).should.equal('117.151.16.0');
        candidateSrflxIp(SRFLX_B).should.equal('58.48.104.199');
    });

    it('returns null for host / relay / prflx / mDNS candidates', () => {
        // 同 NAT 判定只认 srflx：host 是内网地址、relay 是 TURN
        // 服务器地址、prflx 是打洞现场发现的映射——都不代表对端
        // 稳定的公网出口
        should.not.exist(candidateSrflxIp(HOST));
        should.not.exist(candidateSrflxIp(RELAY));
        should.not.exist(candidateSrflxIp(PRFLX));
        should.not.exist(candidateSrflxIp(MDNS_HOST));
    });

    it('returns null for malformed input', () => {
        should.not.exist(candidateSrflxIp(undefined));
        should.not.exist(candidateSrflxIp(''));
        should.not.exist(candidateSrflxIp('not a candidate line'));
        should.not.exist(candidateSrflxIp('candidate:7 1 udp 1 10.0.0.1 9'));
    });
});

describe('test-same-nat (Mesh srflx bookkeeping and sameNatWith)', () => {
    let Mesh;

    before(async () => {
        ({ Mesh } = await importBrowserModule('public/js/core/webrtc.js'));
    });

    /** 手动驱动 handleIceCandidate 的最小条目。 */
    function entryWithPc({ remoteDescription = {} } = {}) {
        return {
            pc: { remoteDescription, addIceCandidate: async () => {} },
            pendingIce: [],
        };
    }

    function bareMesh() {
        return new Mesh({ signaling: { emit() {} }, handlers: {} });
    }

    /** 经真实 addPeer 接线后触发一次本地候选事件（fake 已安装）。 */
    function feedLocal(mesh, candidate) {
        const pc = [...mesh.entries.values()].at(-1).pc;
        pc.onicecandidate({ candidate: { candidate } });
    }

    it('records local srflx candidates from onicecandidate', () => {
        const fake = installFakePC();
        try {
            const mesh = bareMesh();
            mesh.addPeer('peer', false, []);
            feedLocal(mesh, HOST);
            mesh.localSrflxIps.size.should.equal(0);
            feedLocal(mesh, SRFLX_A);
            mesh.localSrflxIps.has('117.151.16.0').should.be.true();
        } finally {
            fake.restore();
        }
    });

    it('records remote srflx candidates even before remoteDescription lands', async () => {
        // 判定在「从未连上」时最需要——候选还在 pendingIce 里缓冲
        // 的阶段就得可用（恢复梯子正是在协商失败后重建时消费它）
        const mesh = bareMesh();
        mesh.entries.set('peer', entryWithPc({ remoteDescription: null }));
        await mesh.handleIceCandidate({ peer_id: 'peer', ice_candidate: { candidate: SRFLX_B } });
        mesh.remoteSrflxIps.get('peer').has('58.48.104.199').should.be.true();
    });

    it('sameNatWith requires non-empty sets on both sides with intersection', async () => {
        const fake = installFakePC();
        try {
            const mesh = bareMesh();
            mesh.addPeer('peer', false, []);
            feedLocal(mesh, SRFLX_A);
            mesh.sameNatWith('peer').should.be.false(); // 对端一侧尚无知识

            mesh.entries.set('peer', entryWithPc());
            await mesh.handleIceCandidate({ peer_id: 'peer', ice_candidate: { candidate: HOST } });
            await mesh.handleIceCandidate({ peer_id: 'peer', ice_candidate: { candidate: RELAY } });
            mesh.sameNatWith('peer').should.be.false(); // 对端只有非 srflx 候选

            await mesh.handleIceCandidate({ peer_id: 'peer', ice_candidate: { candidate: SRFLX_B } });
            mesh.sameNatWith('peer').should.be.false(); // srflx 都有但不相交（跨网对端）

            await mesh.handleIceCandidate({ peer_id: 'peer', ice_candidate: { candidate: SRFLX_A } });
            mesh.sameNatWith('peer').should.be.true(); // 同一公网出口
        } finally {
            fake.restore();
        }
    });

    it('keeps remote srflx knowledge across clear() (B1 reconnect within the page)', async () => {
        const fake = installFakePC();
        try {
            const mesh = bareMesh();
            mesh.addPeer('peer', false, []); // 接好 onicecandidate 的真实条目
            // remoteDescription 尚未落座（走 pendingIce 缓冲路径），知识照样入账
            await mesh.handleIceCandidate({ peer_id: 'peer', ice_candidate: { candidate: SRFLX_A } });
            feedLocal(mesh, SRFLX_A);
            mesh.clear(); // B1 信令重连拆全部链路——知识保留（sdpSeqs 先例）
            mesh.sameNatWith('peer').should.be.true();
            mesh.close(); // 页面拆除才终结
            mesh.sameNatWith('peer').should.be.false();
        } finally {
            fake.restore();
        }
    });
});

describe('test-same-nat (relay-only PC policy)', () => {
    let Mesh;

    before(async () => {
        ({ Mesh } = await importBrowserModule('public/js/core/webrtc.js'));
    });

    it('rebuildPeer({relayOnly}) applies iceTransportPolicy relay when TURN is configured', async () => {
        const fake = installFakePC();
        try {
            const mesh = new Mesh({ signaling: { emit() {} }, handlers: {} });
            mesh.updateIceServers(TURN_ICE);
            mesh.addPeer('peer', true, TURN_ICE); // 初始普通策略
            fake.constructed[0].config.should.not.have.property('iceTransportPolicy');
            mesh.rebuildPeer('peer', { relayOnly: true });
            const rebuilt = fake.constructed[1];
            rebuilt.config.iceTransportPolicy.should.equal('relay');
            mesh.entries.get('peer').relayOnly.should.be.true();
        } finally {
            fake.restore();
        }
    });

    it('falls back to the normal policy without any TURN server (degradation guard)', async () => {
        const fake = installFakePC();
        try {
            const mesh = new Mesh({ signaling: { emit() {} }, handlers: {} });
            mesh.addPeer('peer', true, STUN_ONLY_ICE);
            mesh.rebuildPeer('peer', { relayOnly: true }); // 请求 relay-only
            fake.constructed[1].config.should.not.have.property('iceTransportPolicy'); // 静默回退
            mesh.entries.get('peer').relayOnly.should.be.false(); // 实际生效标志为假
        } finally {
            fake.restore();
        }
    });

    it('rebuildPeer without options stays on the normal policy', async () => {
        const fake = installFakePC();
        try {
            const mesh = new Mesh({ signaling: { emit() {} }, handlers: {} });
            mesh.updateIceServers(TURN_ICE);
            mesh.addPeer('peer', true, TURN_ICE);
            mesh.rebuildPeer('peer');
            fake.constructed[1].config.should.not.have.property('iceTransportPolicy');
            mesh.entries.get('peer').relayOnly.should.be.false();
        } finally {
            fake.restore();
        }
    });
});
