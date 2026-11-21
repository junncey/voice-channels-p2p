'use strict';

// npx mocha test-mesh-chat.js
// 针对 Mesh 中纯记账逻辑的浏览器模块单测：DataChannel 发送队列预算
// （帧数 + 字节数）、中途开麦挂载（我们还是纯文字时就连上的链路上调
// replaceAudioTrack）、connPath 统计读数（含 receiver-report 身份）、
// SDP 轮次之后的自适应状态重打，以及 drainChat。
// 对端的“连接”就是普通对象——
// 不需要真的 RTCPeerConnection。

require('should');
const { pathToFileURL } = require('url');
const path = require('path');

describe('test-mesh-chat (mesh bookkeeping)', () => {
    let Mesh;

    before(async () => {
        ({ Mesh } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'core', 'webrtc.js'))));
    });

    /** 一个 entries 由各测试自行伪造的 Mesh（信令只需要 .emit）。 */
    function bareMesh() {
        return new Mesh({ signaling: { emit() {} }, handlers: {} });
    }

    function connectingEntry() {
        return {
            pc: { connectionState: 'new' },
            dc: { readyState: 'connecting' },
            pendingIce: [],
            queue: [],
            queueBytes: 0,
            tracksAdded: false,
            offering: false,
        };
    }

    describe('sendChat queue budget', () => {
        it('should queue frames while the channel connects and flush on open', () => {
            const mesh = bareMesh();
            const entry = connectingEntry();
            mesh.entries.set('p1', entry);
            mesh.sendChat({ type: 'chat', msg: 'hi' });
            mesh.sendChat({ type: 'chat', msg: 'again' });
            entry.queue.should.have.length(2);
            entry.queueBytes.should.be.above(0);

            const sent = [];
            entry.dc = { readyState: 'open', send: (raw) => sent.push(raw) };
            entry.queue.splice(0).forEach((raw) => entry.dc.send(raw)); // 冲刷形态照搬 _attachChat.onopen
            sent.should.have.length(2);
            JSON.parse(sent[0]).msg.should.equal('hi');
        });

        it('should refuse once the BYTE budget is exhausted (image-sized frames)', () => {
            const mesh = bareMesh();
            const entry = connectingEntry();
            mesh.entries.set('p1', entry);
            // ~1MB 的 JSON 帧对着 4MB 预算：塞得进三帧，第四帧必须被拒——
            // 排队中的图片爆发绝不允许无界缓冲
            const frame = { type: 'img-chunk', d: 'a'.repeat(1024 * 1024) };
            for (let i = 0; i < 3; i++) mesh.sendChat(frame);
            entry.queue.should.have.length(3);
            entry.queueBytes.should.be.above(3 * 1024 * 1024);
            (() => mesh.sendChat(frame)).should.throw('dc-send-failed');
            entry.queue.should.have.length(3); // 被拒的帧不会排进一半
        });

        it('should refuse once the FRAME budget is exhausted (tiny frames)', () => {
            const mesh = bareMesh();
            const entry = connectingEntry();
            mesh.entries.set('p1', entry);
            for (let i = 0; i < 512; i++) mesh.sendChat({ type: 'chat', msg: 'x' });
            entry.queue.should.have.length(512);
            (() => mesh.sendChat({ type: 'chat', msg: 'x' })).should.throw('dc-send-failed');
        });

        it('should keep delivering to open channels when another peer is over budget', () => {
            const mesh = bareMesh();
            const stuck = connectingEntry();
            const open = { pc: { connectionState: 'connected' }, dc: { readyState: 'open', sent: 0, send() {} } };
            open.dc.send = function (raw) {
                this.sent += 1;
            };
            mesh.entries.set('stuck', stuck);
            mesh.entries.set('open', open);
            const frame = { type: 'img-chunk', d: 'a'.repeat(1024 * 1024) };
            for (let i = 0; i < 3; i++) mesh.sendChat(frame);
            open.dc.sent.should.equal(3); // 每次发送都抵达了已打开的频道
            (() => mesh.sendChat(frame)).should.throw('dc-send-failed'); // 卡住的 peer 被拒绝
            open.dc.sent.should.equal(4); // 拒绝的同时，打开的 peer 仍收到了这一帧
        });
    });

    describe('drainChat backpressure', () => {
        it('should return at once when buffers are below the low-water mark', async () => {
            const mesh = bareMesh();
            const entry = { pc: {}, dc: { readyState: 'open', bufferedAmount: 1024 } };
            mesh.entries.set('p1', entry);
            await mesh.drainChat(); // 立即 resolve，无需等待
        });

        it('should wait for a congested buffer to drain', async () => {
            const mesh = bareMesh();
            const dc = { readyState: 'open', bufferedAmount: 512 * 1024 };
            mesh.entries.set('p1', { pc: {}, dc });
            setTimeout(() => {
                dc.bufferedAmount = 1024;
            }, 90);
            const started = Date.now();
            await mesh.drainChat();
            (Date.now() - started).should.be.aboveOrEqual(50); // 确实经过轮询等待
        });
    });

    describe('late voice attach', () => {
        it('should attach tracks on a link that connected while text-only', () => {
            const mesh = bareMesh();
            const track = { kind: 'audio' };
            mesh.localStream = { getTracks: () => [track] };
            const added = [];
            const entry = {
                pc: { connectionState: 'connected', addTrack: (...args) => added.push(args), getSenders: () => [] },
                dc: null,
                pendingIce: [],
                queue: [],
                queueBytes: 0,
                tracksAdded: false,
                offering: false,
            };
            mesh.entries.set('p1', entry);
            mesh.replaceAudioTrack(track, mesh.localStream);
            // 旧代码会跳过 !tracksAdded 的条目——通话中途开麦
            // 在完整重连之前谁也收不到
            added.should.have.length(1);
            entry.tracksAdded.should.equal(true);
        });

        it('should skip closed connections instead of adding tracks to them', () => {
            const mesh = bareMesh();
            const track = { kind: 'audio' };
            mesh.localStream = { getTracks: () => [track] };
            let added = 0;
            mesh.entries.set('p1', {
                pc: { connectionState: 'closed', addTrack: () => (added += 1) },
                dc: null,
                pendingIce: [],
                queue: [],
                tracksAdded: false,
            });
            mesh.replaceAudioTrack(track, mesh.localStream);
            added.should.equal(0);
        });
    });

    describe('connPath stats readback', () => {
        it('should surface outbound loss identity, jitter and encoder counters', async () => {
            const mesh = bareMesh();
            mesh.entries.set('p1', {
                pc: {
                    connectionState: 'connected',
                    getStats: async () => [
                        { type: 'inbound-rtp', kind: 'audio', packetsLost: 1, packetsReceived: 99 },
                        { type: 'remote-inbound-rtp', fractionLost: 0.05, timestamp: 12345, jitter: 0.007 },
                        {
                            type: 'outbound-rtp',
                            kind: 'audio',
                            bytesSent: 40000,
                            timestamp: 12345,
                            targetBitrate: 32000,
                        },
                        {
                            type: 'candidate-pair',
                            selected: true,
                            localCandidateId: 'L',
                            remoteCandidateId: 'R',
                            currentRoundTripTime: 0.045,
                        },
                        { type: 'local-candidate', id: 'L', candidateType: 'srflx' },
                        { type: 'remote-candidate', id: 'R', candidateType: 'prflx' },
                    ],
                },
            });
            const info = await mesh.connPath('p1');
            info.type.should.equal('p2p');
            info.rtt.should.equal(45);
            info.outboundLoss.should.equal(5);
            info.outboundTs.should.equal(12345); // 去重身份随报告一同返回
            info.outboundJitter.should.equal(7);
            info.outbound.should.eql({ bytesSent: 40000, timestamp: 12345, targetBitrate: 32000 });
        });

        it('should treat a non-connected link as unknown across every field', async () => {
            const mesh = bareMesh();
            mesh.entries.set('p1', { pc: { connectionState: 'disconnected' } });
            const info = await mesh.connPath('p1');
            info.type.should.equal('unknown');
            should(info.outboundLoss).be.null();
            should(info.outboundTs).be.null();
            should(info.outboundJitter).be.null();
            should(info.outbound).be.null();
        });
    });

    describe('adaptive state restamp after SDP rounds', () => {
        /** 带 fmtp 上限的 Mesh，其条目的 pc 会记录每次 setParameters
         *  调用，并暴露一对音频 sender/receiver。 */
        function adaptiveMesh({ bitrateFloor = null, jitterTarget = null } = {}) {
            const mesh = new Mesh({
                signaling: { emit() {} },
                handlers: {},
                getOpusFmtp: () => ({ maxaveragebitrate: 64000, usedtx: 1 }),
            });
            const params = { encodings: [{}] };
            const receiver = { track: { kind: 'audio' }, jitterBufferTarget: null };
            const calls = { setParameters: 0 };
            const pc = {
                signalingState: 'stable',
                connectionState: 'connected',
                localDescription: { type: 'answer', sdp: 'v=0' },
                setRemoteDescription: async () => {},
                setLocalDescription: async () => {},
                createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }),
                createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
                getTransceivers: () => [],
                getSenders: () => [
                    {
                        track: { kind: 'audio' },
                        getParameters: () => params,
                        setParameters: (p) => {
                            calls.setParameters += 1;
                            should(p.encodings[0].maxBitrate).be.a.Number();
                            return Promise.resolve();
                        },
                    },
                ],
                getReceivers: () => [receiver],
            };
            const entry = {
                pc,
                dc: null,
                pendingIce: [],
                queue: [],
                queueBytes: 0,
                tracksAdded: true,
                offering: false,
                bitrateFloor,
                jitterTarget,
            };
            mesh.entries.set('p1', entry);
            return { mesh, entry, params, receiver, calls };
        }

        it('should re-apply the fmtp cap and jitter target after ANSWERING a re-offer', async () => {
            const { mesh, params, receiver } = adaptiveMesh({ jitterTarget: 80 });
            await mesh._applySessionDescription('p1', mesh.entries.get('p1'), { type: 'offer', sdp: 'v=0' });
            // 一轮 SDP 可能把 sender encodings / receiver 缓冲提示冲掉——
            // 重打把自适应引擎的调校重新按回链路上
            params.encodings[0].maxBitrate.should.equal(64000);
            receiver.jitterBufferTarget.should.equal(80);
        });

        it('should re-apply the LOSS-DRIVEN FLOOR (not the cap) after our own offer', async () => {
            const { mesh, params } = adaptiveMesh({ bitrateFloor: 32000, jitterTarget: 120 });
            const sent = await mesh.renegotiate('p1');
            sent.should.be.true();
            params.encodings[0].maxBitrate.should.equal(32000); // 地板优先于 fmtp 上限
        });

        it('should leave receivers untouched when no jitter target is in force', async () => {
            const { mesh, receiver } = adaptiveMesh();
            await mesh._applySessionDescription('p1', mesh.entries.get('p1'), { type: 'answer', sdp: 'v=0' });
            should(receiver.jitterBufferTarget).be.null();
        });
    });

    describe('legacy playoutDelayHint conversion', () => {
        /** receiver 还没有 jitterBufferTarget 的条目（M110 之前的
         *  Chromium webview）——那里只有已废弃的 hint。 */
        function legacyMesh() {
            const mesh = bareMesh();
            const receiver = { track: { kind: 'audio' }, playoutDelayHint: null };
            mesh.entries.set('p1', { pc: { getReceivers: () => [receiver] }, jitterTarget: null });
            return { mesh, receiver };
        }

        it('should convert milliseconds to SECONDS for the legacy hint', () => {
            const { mesh, receiver } = legacyMesh();
            mesh.setPeerJitterTarget('p1', 60);
            // hint 以 SECONDS 为单位钳制在 [0,10]——不换算的 60 会把
            // 播放延迟钉死在上限，而不是请求 60ms
            receiver.playoutDelayHint.should.equal(0.06);
        });

        it('should keep null as the adaptive default (not zero)', () => {
            const { mesh, receiver } = legacyMesh();
            mesh.setPeerJitterTarget('p1', 120);
            mesh.setPeerJitterTarget('p1', null);
            // null / 1000 === 0 会把最小延迟钉死——null 必须把控制权
            // 交还给浏览器的自适应缓冲
            should(receiver.playoutDelayHint).be.null();
        });
    });

    describe('stale offer unstick (ghost-swallowed answers)', () => {
        /** 一条停在 have-local-offer 的链路（对端 ghost 窗口吞掉了
         *  我们 offer 的 answer）——rollback 调用被记录。 */
        function stuckMesh({ signalingState = 'have-local-offer', offerSentAt = Date.now() - 9000 } = {}) {
            const mesh = bareMesh();
            const calls = { rollback: 0 };
            const pc = {
                signalingState,
                setLocalDescription: async (desc) => {
                    if (desc.type === 'rollback') calls.rollback += 1;
                },
            };
            mesh.entries.set('p1', {
                pc,
                pendingIce: [],
                queue: [],
                queueBytes: 0,
                tracksAdded: true,
                offering: false,
                offerSentAt,
            });
            return { mesh, entry: mesh.entries.get('p1'), calls };
        }

        it('should roll back an unanswered offer once it is stale', async () => {
            const { mesh, entry, calls } = stuckMesh();
            (await mesh.unstickStaleOffer('p1')).should.be.true();
            calls.rollback.should.equal(1);
            should(entry.offerSentAt).be.null();
        });

        it('should leave a FRESH offer alone (the answer may still be in flight)', async () => {
            const { mesh, calls } = stuckMesh({ offerSentAt: Date.now() - 1000 });
            (await mesh.unstickStaleOffer('p1')).should.be.false();
            calls.rollback.should.equal(0);
        });

        it('should do nothing on a stable link or without a recorded offer', async () => {
            const stable = stuckMesh({ signalingState: 'stable' });
            (await stable.mesh.unstickStaleOffer('p1')).should.be.false();
            const unrecorded = stuckMesh({ offerSentAt: null });
            (await unrecorded.mesh.unstickStaleOffer('p1')).should.be.false();
            (stable.calls.rollback + unrecorded.calls.rollback).should.equal(0);
        });
    });

    describe('renegotiate retry ladder must unstick a swallowed offer', function () {
        this.timeout(10000); // 第一跳重试延迟 2.5s（RENEGOTIATE_RETRY_DELAYS）
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        /** 一条卡在 have-local-offer 的链路：陈旧 offer 的 answer 已被
         *  对端 ghost 吞掉——直接 renegotiate 会被 stable 检查拒绝，
         *  唯一的出路是重试梯子先回滚陈旧 offer 再发新的。 */
        function stuckOfferMesh() {
            const mesh = bareMesh();
            const emitted = [];
            mesh.signaling.emit = (evt, payload) => emitted.push(payload);
            const pc = {
                signalingState: 'have-local-offer',
                getTransceivers: () => [],
                getSenders: () => [],
                getReceivers: () => [],
                createOffer: async () => ({ type: 'offer', sdp: 'v=0 fresh-offer' }),
                setLocalDescription: async (desc) => {
                    if (desc.type === 'rollback') pc.signalingState = 'stable';
                },
            };
            mesh.entries.set('p1', {
                pc,
                pendingIce: [],
                queue: [],
                queueBytes: 0,
                tracksAdded: true,
                offering: false,
                offerSentAt: Date.now() - 9000, // 陈旧：answer 早已不会来
            });
            return { mesh, emitted, pc };
        }

        it('rolls the stale offer back and sends a fresh one on the retry tick', async () => {
            const { mesh, emitted, pc } = stuckOfferMesh();
            (await mesh.renegotiate('p1')).should.be.false(); // stable 检查拒绝
            emitted.should.be.empty(); // 没有立刻发出去
            await sleep(2900); // 第一跳重试：解卡 + 重发
            pc.signalingState.should.equal('stable');
            emitted.filter((p) => p?.peer_id === 'p1').should.have.length(1); // 新 offer 已上路
        });

        it('keeps a FRESH stuck offer intact on the first hop (answer may be in flight)', async () => {
            const { mesh, emitted } = stuckOfferMesh();
            mesh.entries.get('p1').offerSentAt = Date.now() - 200; // 刚发出的 offer
            await mesh.renegotiate('p1');
            await sleep(2900); // 第一跳：年龄门槛挡住回滚——梯子继续等第二跳
            emitted.should.be.empty();
            mesh.removePeer('p1'); // 拆掉待发的后续重试，测试收尾即止
        });
    });

    describe('pending ICE hardening', () => {
        it('should cap the pre-remote-description candidate buffer', async () => {
            const mesh = bareMesh();
            const entry = {
                pc: { remoteDescription: null },
                pendingIce: [],
                queue: [],
                queueBytes: 0,
                tracksAdded: false,
                offering: false,
            };
            mesh.entries.set('p1', entry);
            const cand = { candidate: 'candidate:1' };
            for (let i = 0; i < 300; i++) await mesh.handleIceCandidate({ peer_id: 'p1', ice_candidate: cand });
            entry.pendingIce.should.have.length(256); // 异常洪泛封顶，不再增长
        });

        it('should flush buffered candidates once the remote description lands', async () => {
            const mesh = bareMesh();
            const added = [];
            const entry = {
                pc: {
                    remoteDescription: null,
                    setRemoteDescription: async () => {},
                    addIceCandidate: async (c) => added.push(c),
                },
                pendingIce: [{ candidate: 'a' }, { candidate: 'b' }, { candidate: 'c' }],
                queue: [],
                queueBytes: 0,
                tracksAdded: true,
                offering: false,
            };
            mesh.entries.set('p1', entry);
            await mesh._applySessionDescription('p1', entry, { type: 'answer', sdp: 'v=0' });
            added.should.have.length(3);
            entry.pendingIce.should.be.empty();
        });
    });

    describe('glare arbitration (before setRemoteDescription)', () => {
        /** Chromium 式 pc：have-local-offer 下 setRemoteDescription(offer)
         *  直接成功（隐式回滚本地待定 offer），绝不抛错——glare 裁决
         *  若放在 catch 里，在这台 pc 上永远不会执行（双方各自隐式
         *  回滚并应答对方，两个 answer 都落在已回滚的 offer 上）。 */
        function glarePc(signalingState) {
            const calls = { remote: [], local: [] };
            return {
                calls,
                signalingState,
                connectionState: 'disconnected',
                async setRemoteDescription(desc) {
                    calls.remote.push(desc.type);
                    this.signalingState = 'stable';
                },
                async setLocalDescription(desc) {
                    calls.local.push(desc.type);
                    if (desc.type === 'rollback') this.signalingState = 'stable';
                },
                async createAnswer() {
                    return { type: 'answer', sdp: 'v=0\r\n' };
                },
                getSenders: () => [],
                getReceivers: () => [],
                getTransceivers: () => [],
            };
        }

        function glareMesh(selfId) {
            const mesh = new Mesh({ signaling: { emit() {} }, handlers: {}, getSelfId: () => selfId });
            const pc = glarePc('have-local-offer'); // 我方的 re-offer 正在途
            mesh.entries.set('peer', { pc, pendingIce: [], tracksAdded: true, offering: false });
            return { mesh, pc };
        }

        const collidingOffer = { peer_id: 'peer', session_description: { type: 'offer', sdp: 'v=0\r\n' } };

        it('should let the impolite side (lower uuid) ignore the colliding offer', async () => {
            const { mesh, pc } = glareMesh('aaa'); // aaa < peer
            await mesh.handleSessionDescription(collidingOffer);
            pc.calls.remote.should.eql([]); // 自己的 offer 原样保留
            pc.calls.local.should.eql([]); // 不回滚、不应答
        });

        it('should make the polite side (higher uuid) roll back explicitly, then answer', async () => {
            const { mesh, pc } = glareMesh('zzz'); // zzz > peer
            await mesh.handleSessionDescription(collidingOffer);
            pc.calls.local.should.eql(['rollback', 'answer']); // 先解自己的卡，再应答
            pc.calls.remote.should.eql(['offer']);
        });

        it('should stay polite without a role (no getSelfId)', async () => {
            const mesh = new Mesh({ signaling: { emit() {} }, handlers: {} });
            const pc = glarePc('have-local-offer');
            mesh.entries.set('peer', { pc, pendingIce: [], tracksAdded: true, offering: false });
            await mesh.handleSessionDescription(collidingOffer);
            pc.calls.local.should.eql(['rollback', 'answer']);
        });

        it('should answer normally when stable (no glare)', async () => {
            const { mesh, pc } = glareMesh('aaa');
            pc.signalingState = 'stable';
            await mesh.handleSessionDescription(collidingOffer);
            pc.calls.local.should.eql(['answer']); // 无需回滚
            pc.calls.remote.should.eql(['offer']);
        });
    });

    describe('SDP generation guards (stale answers / regressed offers)', () => {
        /** 会走路的状态机 pc：记录每次描述调用并按 offer/answer/
         *  rollback 推进 signalingState——比真实浏览器更宽松
         *  （不校验 answer 对应哪份 offer），恰好复现待防的错配。 */
        function seqPc(signalingState = 'stable') {
            const calls = { remote: [], local: [] };
            return {
                calls,
                signalingState,
                connectionState: 'new',
                localDescription: null,
                remoteDescription: null,
                async setRemoteDescription(desc) {
                    calls.remote.push(desc.type);
                    this.remoteDescription = desc;
                    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
                },
                async setLocalDescription(desc) {
                    calls.local.push(desc.type);
                    if (desc.type === 'rollback') this.signalingState = 'stable';
                    else {
                        this.localDescription = desc;
                        this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
                    }
                },
                async createOffer() {
                    return { type: 'offer', sdp: 'v=0 offer' };
                },
                async createAnswer() {
                    return { type: 'answer', sdp: 'v=0 answer' };
                },
                getSenders: () => [],
                getReceivers: () => [],
                getTransceivers: () => [],
            };
        }

        /** entries 由本组用例自行落座的 Mesh（信令 emit 被记录）。 */
        function seqMesh(signalingState = 'have-local-offer', offerSeq) {
            const sent = [];
            const mesh = new Mesh({
                signaling: { emit: (evt, payload) => sent.push(payload) },
                handlers: {},
            });
            const pc = seqPc(signalingState);
            const entry = { pc, pendingIce: [], queue: [], queueBytes: 0, tracksAdded: true, offering: false };
            if (offerSeq !== undefined) entry.offerSeq = offerSeq;
            mesh.entries.set('p1', entry);
            return { mesh, entry, pc, sent };
        }

        const answerMsg = (seq) => ({
            peer_id: 'p1',
            session_description: { type: 'answer', sdp: 'v=0' },
            ...(seq !== undefined ? { sdp_seq: seq } : {}),
        });
        const offerMsg = (seq, sdp = 'v=0') => ({
            peer_id: 'p1',
            session_description: { type: 'offer', sdp },
            ...(seq !== undefined ? { sdp_seq: seq } : {}),
        });

        it('should ignore an answer landing on a stable PC (was an InvalidStateError)', async () => {
            const { mesh, pc } = seqMesh('stable');
            // 我们的 offer 早已被 unstick 回滚、或另一份 answer 已应用
            // ——stable 下到达的 answer 定义上就是陈旧/重复的
            await mesh.handleSessionDescription(answerMsg(1));
            pc.calls.remote.should.eql([]); // 不触 setRemoteDescription，也不抛错
        });

        it('should reject a late answer to a superseded offer by seq, accept the matching one', async () => {
            const { mesh, pc } = seqMesh('have-local-offer', 2);
            // 旧 offer（回滚/重建前）的迟到 answer：不校验代次就会被
            // 静默应用到当前 pending offer 上（旧 ICE 凭据错配）
            await mesh.handleSessionDescription(answerMsg(1));
            pc.calls.remote.should.eql([]);
            await mesh.handleSessionDescription(answerMsg(2)); // 当前 offer 的真 answer
            pc.calls.remote.should.eql(['answer']);
        });

        it('should fall back to the state guard alone for a seq-less legacy peer', async () => {
            const { mesh, pc } = seqMesh('have-local-offer', 7);
            await mesh.handleSessionDescription(answerMsg(undefined)); // 旧对端不带 sdp_seq
            pc.calls.remote.should.eql(['answer']);
        });

        it('should echo the offer seq on our answer, reject regressed offers, re-answer replays', async () => {
            const { mesh, pc, sent } = seqMesh('stable');
            await mesh.handleSessionDescription(offerMsg(5));
            pc.calls.remote.should.eql(['offer']);
            const answers = sent.filter((p) => p.session_description.type === 'answer');
            answers.should.have.length(1);
            answers[0].sdp_seq.should.equal(5); // answer 原样回带所应答 offer 的代次
            // 对端回滚重发链上晚到的旧 offer（seq 3 < 已接受 5）：拒收
            await mesh.handleSessionDescription(offerMsg(3, 'v=0 stale'));
            pc.calls.remote.should.eql(['offer']);
            // 同 seq 的重复投递：幂等重应答（重复投递被容忍）
            await mesh.handleSessionDescription(offerMsg(5, 'v=0 dup'));
            pc.calls.remote.should.eql(['offer', 'offer']);
        });

        it('should keep the seq ledger across rebuildPeer (pre-rebuild answers rejected)', async () => {
            const had = Object.hasOwn(globalThis, 'RTCPeerConnection');
            const RealPC = globalThis.RTCPeerConnection;
            // rebuildPeer 经 addPeer 构造真实 RTCPeerConnection——
            // 断言期间装一个仅覆盖被用到面的假实现（finally 还原）
            globalThis.RTCPeerConnection = class {
                constructor() {
                    Object.assign(this, seqPc('stable'));
                }
                createDataChannel(label) {
                    return { label, readyState: 'connecting' };
                }
                close() {}
            };
            try {
                const sent = [];
                const mesh = new Mesh({
                    signaling: { emit: (evt, payload) => sent.push(payload) },
                    handlers: {},
                });
                const flush = () => new Promise((resolve) => setImmediate(resolve));
                mesh.addPeer('p1', true, []); // 加入方路径：初始 offer
                await flush();
                mesh.rebuildPeer('p1'); // 恢复阶梯：整链路换 PC、立即重新 offer
                await flush();
                sent.filter((p) => p.session_description.type === 'offer')
                    .map((p) => p.sdp_seq)
                    .should.eql([1, 2]); // 账本跨重建递增，绝不重用旧序号
                // 旧 PC 那份 offer（seq 1）的迟到 answer：新 PC 正
                // pending seq 2——不校验代次就会错配到新 offer 上
                const entry = mesh.entries.get('p1');
                await mesh.handleSessionDescription(answerMsg(1));
                entry.pc.calls.remote.should.eql([]);
                await mesh.handleSessionDescription(answerMsg(2));
                entry.pc.calls.remote.should.eql(['answer']);
            } finally {
                if (had) globalThis.RTCPeerConnection = RealPC;
                else delete globalThis.RTCPeerConnection;
            }
        });
    });

    describe('removePeer detaches stale-PC events (rebuild ladder survival)', () => {
        /** 接线形态照搬 addPeer：处理器存在时读当前 connectionState。 */
        function wiredPc(mesh, peerId) {
            const pc = {
                connectionState: 'failed',
                close() {
                    this.connectionState = 'closed';
                },
                onicecandidate: null,
                ontrack: null,
                onconnectionstatechange: null,
                onnegotiationneeded: null,
                ondatachannel: null,
            };
            pc.onconnectionstatechange = () => {
                if (mesh.handlers.onPeerState) mesh.handlers.onPeerState(peerId, pc.connectionState);
            };
            return pc;
        }

        it('must not report the late closed event after a deliberate teardown', () => {
            const mesh = bareMesh();
            const states = [];
            mesh.handlers.onPeerState = (id, state) => states.push([id, state]);
            const pc = wiredPc(mesh, 'p1');
            mesh.entries.set('p1', {
                pc,
                dc: null,
                pendingIce: [],
                queue: [],
                queueBytes: 0,
                tracksAdded: false,
                offering: false,
            });
            mesh.removePeer('p1');
            mesh.entries.has('p1').should.equal(false);
            // close() 之后浏览器异步派发 connectionstatechange('closed')——
            // 修复前处理器仍在，rebuildPeer 的恢复梯子会被这次迟到上报
            // 整个取消（escalatePeerRecovery 刚配好的轮次随 cancel 消失），
            // 新 PC 再失败时只能重建全新梯子 → 无限重建循环
            pc.onconnectionstatechange?.();
            (pc.onconnectionstatechange === null).should.equal(true);
            states.should.eql([]);
        });

        it('must detach the data-channel handlers as well (dying-link renegotiation fires once)', () => {
            const mesh = bareMesh();
            const dc = { onopen: () => {}, onmessage: () => {}, onclose: () => {} };
            mesh.entries.set('p1', {
                pc: { close() {} },
                dc,
                pendingIce: [],
                queue: [],
                queueBytes: 0,
                tracksAdded: false,
                offering: false,
            });
            mesh.removePeer('p1');
            (dc.onopen === null).should.equal(true);
            (dc.onmessage === null).should.equal(true);
            (dc.onclose === null).should.equal(true);
        });
    });
});
