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
});
