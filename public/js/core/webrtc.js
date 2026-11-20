/**
 * Mesh WebRTC 管理器——每个远端 peer 一个 RTCPeerConnection。
 *
 * 信令协议（服务器只转发，绝不触碰媒体）：
 *   relaySDP        { peer_id, session_description }
 *   relayICE        { peer_id, ice_candidate }
 *   sessionDescription / iceCandidate / addPeer / removePeer  （入站）
 *
 * 聊天走每连接一条 DataChannel（P2P，绝不中转）。
 *
 * 协商模型（避免纯音频 mesh 中的 offer 冲突）：
 *  - 加入方（should_create_offer=true）创建 DataChannel，
 *    并发送初始 offer。
 *  - 对端在应答之前先挂载麦克风，因此带音频 m-line 的 offer
 *    立即得到 sendrecv 应答，ICE 一连通媒体即流动
 *    （在 'connected' 之后才挂载，要付一整轮反向 offer 的代价
 *    本端才发声）。纯文字加入者的仅 DC offer 保持仅 DC；
 *    之后的语音启用走标准 addTrack → negotiationneeded →
 *    反向 offer 路径（replaceAudioTrack/_addLocalTracks）。
 *  - offer 相撞（双方同时恢复）用 perfect-negotiation 角色裁决：
 *    较小的 session uuid 是 impolite（保留自己的 offer），
 *    较大的回滚并应答（见 handleSessionDescription）。
 */

const CHAT_DC_LABEL = 'mirotalk_chat_channel';
// 重新协商重试梯子：第一个延迟跨过常规的反向 offer 窗口，
// 第二个兜住缓慢收敛的情况——再往后就等下一次
// 自然到来的 SDP 轮次
const RENEGOTIATE_RETRIES = 2;
const RENEGOTIATE_RETRY_DELAYS = [2500, 7000];
// 单个 peer 的未打开 DataChannel 可缓冲的预算——发往一条
// 信道永远不会打开的链路的图片传输不能一直占着内存，
// 直到该 peer 最终离开。帧数：一张完整图片约 137 个 12KB 分块，
// 上限至少要容纳这一次突发。字节：仅帧数上限并不约束内存
// （图片分块每个约 12k 字符）——起作用的是字节预算。
// 任一超限都拒绝该帧（见 sendChat），多帧图片批次因此整体
// 一致地中止，而不是排队到一半。
const DC_QUEUE_MAX_FRAMES = 512;
const DC_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
// 图片传输泵的 SCTP 低水位（见 drainChat）：低于它才能再喂
// 一批分块，高于它泵就等待——数据与语音包共享同一条
// ICE 五元组（和带宽）
const DC_BUFFER_LOW = 128 * 1024;
const DRAIN_WAIT_MS = 60; // 泵轮询节奏
const DRAIN_MAX_MS = 5000; // 单次等待绝不让传输停滞太久
// 陈旧无应答 offer 的判定：发出这么久仍未收到 answer，视为已被
// 服务器静默丢弃（对端 ghost 窗口内 relaySDP 没有落脚处）——
// 覆盖正常信令 RTT，避免回滚掉仍在路上的 answer
const OFFER_STUCK_MS = 8000;
// remoteDescription 落座前缓存的 ICE 候选上限：异常/失控对端不得
// 无限占用内存（正常 trickle 每对端几十个候选）
const PENDING_ICE_MAX = 256;

/**
 * 把 Opus fmtp 参数合并进 SDP 中每一条 opus/48000/2 fmtp 行。
 * 幂等（同键值是替换而非重复追加）——可安全地作用于
 * ICE-restart 梯子的每次重新 offer。显式设为 null 的参数会被
 * 移除，模式字典因此能声明完整的目标状态，通话中切换模式
 * 也不会把另一模式的参数残留到后续 re-offer 里。
 * 只改写我们自己的 local description：发送侧上限
 * （maxaveragebitrate/usedtx）配置本地编码器，立体声
 * 在双方都改写各自的 offer/answer 后端到端生效
 * （Chrome 读取本地 fmtp 来配置编码器）。
 * 为测试导出（tests/test-opusFmtp.js）。
 * @param {string} sdp
 * @param {object} params 例如 { maxaveragebitrate: 64000, usedtx: 1, stereo: null }
 */
export function mungeOpusFmtp(sdp, params) {
    const payloadTypes = new Set();
    for (const match of sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2(?=\s|$)/g)) payloadTypes.add(match[1]);
    if (!payloadTypes.size) return sdp;
    return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, pt, existing) => {
        if (!payloadTypes.has(pt)) return line;
        const merged = {};
        for (const pair of existing.split(';')) {
            const eq = pair.indexOf('=');
            if (eq === -1) {
                if (pair.trim()) merged[pair.trim()] = '';
            } else merged[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
        for (const [key, value] of Object.entries(params)) {
            if (value === null) delete merged[key];
            else merged[key] = value;
        }
        const text = Object.entries(merged)
            .map(([key, value]) => (value === '' ? key : `${key}=${value}`))
            .join(';');
        return text ? `a=fmtp:${pt} ${text}` : `a=fmtp:${pt}`;
    });
}

/**
 * 重排音频编解码能力，让 audio/red（冗余音频，RFC 2198 风格——
 * Chrome 作为包裹 Opus 的 UEP 层自带）排在最前。
 * 编解码顺序决定 Chrome 发送端实际用什么编码：RED 打头意味着
 * 每个包都重复携带上一帧，单个丢包不产生任何可闻损失——
 * 这是比带内 FEC（只能缓解 Opus 内部帧丢失）强得多的抗丢包手段。
 * 能力清单里没有 audio/red 的浏览器拿到的列表原样返回，
 * 协商无论如何都安全：若 ANSWER 省略 red，发送端回退为
 * 普通 Opus。
 * 为测试导出（tests/test-red-codecs.js）。
 * @param {Array} codecs RTCRtpReceiver.getCapabilities('audio').codecs
 * @returns {Array} 新数组，red 条目排最前，其余保持原顺序
 */
export function redFirstCodecs(codecs) {
    if (!Array.isArray(codecs) || !codecs.length) return codecs || [];
    const red = codecs.filter((codec) => codec?.mimeType?.toLowerCase() === 'audio/red');
    if (!red.length) return codecs;
    return [...red, ...codecs.filter((codec) => codec?.mimeType?.toLowerCase() !== 'audio/red')];
}

/**
 * 纯解析一次 getStats() 的报告集合（为测试导出）：收集候选报告、
 * 选定候选对，并摘出入向/出向音频计数器。各字段语义与 connPath
 * 方法注释一致。
 * @param {RTCStatsReport|{forEach: Function}} stats
 * @returns {{candidates: Map, pair: object|null, fallback: object|null,
 *     inbound: object|null, outboundLoss: number|null, outboundTs: number|null,
 *     outboundJitter: number|null, outbound: object|null}}
 */
export function parseConnStats(stats) {
    const candidates = new Map();
    let pair = null; // 显式 selected 标记（标准/Firefox）…
    let fallback = null; // …Chromium：最新的 succeeded + nominated 对
    let inbound = null; // 入向音频 RTP（每连接一条音频轨道）
    let outboundLoss = null; // peer 报告的我们流丢失百分比（0..1 → %）
    let outboundTs = null; // 该接收方报告的时间戳（去重标识）
    let outboundJitter = null; // peer 眼中我们流的抖动（ms）
    let outbound = null; // 我们出向音频 RTP 计数（由调用方差分）
    stats.forEach((report) => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
            candidates.set(report.id, report);
            return;
        }
        if (report.type === 'inbound-rtp' && !inbound) {
            // 本应用的链路都是纯音频：第一个 inbound-rtp 就是音频流，
            // 即使浏览器省略 kind（旧版 Firefox 以 mediaType
            // 报告）——没有这个回退，整个入向质量监测
            // 会无声地失明
            const kind = report.kind || report.mediaType;
            if (!kind || kind === 'audio') {
                inbound = {
                    packetsLost: report.packetsLost ?? 0,
                    packetsReceived: report.packetsReceived ?? 0,
                    jitter: typeof report.jitter === 'number' ? report.jitter : null,
                    bytesReceived: report.bytesReceived ?? 0,
                    timestamp: report.timestamp ?? Date.now(),
                    // 累计 NetEQ 计数——恢复引擎的 jitter 提升所响应的
                    // 隐藏率真值；浏览器不报告这些字段时为 null
                    concealedSamples: typeof report.concealedSamples === 'number' ? report.concealedSamples : null,
                    totalSamplesReceived:
                        typeof report.totalSamplesReceived === 'number' ? report.totalSamplesReceived : null,
                    // 累计播放缓冲计数——差分出实际达到的延迟，
                    // 用于闭合 jitter 提升回路（提升的目标真的生效了吗？）
                    jitterBufferDelay: typeof report.jitterBufferDelay === 'number' ? report.jitterBufferDelay : null,
                    jitterBufferEmittedCount:
                        typeof report.jitterBufferEmittedCount === 'number' ? report.jitterBufferEmittedCount : null,
                };
            }
            return;
        }
        if (report.type === 'remote-inbound-rtp') {
            // 关于我们（单条）出向音频轨道的 RTCP 接收方报告；
            // 部分浏览器省略该字段——null 意为「无结论」，
            // 调用方必须视作既不好也不坏
            if (typeof report.fractionLost === 'number') {
                outboundLoss = Math.round(report.fractionLost * 1000) / 10;
                // 报告标识：RR 会在多次路径轮询间重复（音频的报告
                // 间隔可能超过 5s 节拍）——一份陈旧读数
                // 绝不能重复喂给调用方的丢包连击统计
                outboundTs = typeof report.timestamp === 'number' ? report.timestamp : null;
            }
            // peer 眼中我们流的抖动——jitter 提升所响应的入向信号
            // 的出向孪生
            if (typeof report.jitter === 'number') outboundJitter = Math.round(report.jitter * 1000);
            return;
        }
        if (report.type === 'outbound-rtp') {
            // 我们编码器的实际输出（与入向相同的纯音频首报告回退）：
            // 调用方差分 bytesSent 得到真实发送码率，
            // targetBitrate 说明自适应地板（setParameters）
            // 是否真的生效——这是丢包自适应从未有过的
            // 那一份回读
            const kind = report.kind || report.mediaType;
            if (!kind || kind === 'audio') {
                outbound = {
                    bytesSent: report.bytesSent ?? 0,
                    timestamp: report.timestamp ?? Date.now(),
                    targetBitrate: typeof report.targetBitrate === 'number' ? report.targetBitrate : null,
                };
            }
            return;
        }
        if (report.type !== 'candidate-pair') return;
        if (report.selected) {
            pair = report;
            return;
        }
        if (
            report.state === 'succeeded' &&
            report.nominated &&
            (!fallback || (report.lastPacketReceivedTimestamp || 0) > (fallback.lastPacketReceivedTimestamp || 0))
        ) {
            fallback = report;
        }
    });
    return { candidates, pair, fallback, inbound, outboundLoss, outboundTs, outboundJitter, outbound };
}

/**
 * 把解析结果组装为 connPath 的返回值（纯函数，为测试导出）：
 * 候选对两端类型判定 p2p/relay；缺任一候选报告则路径未证实——
 * 绝不宣称 'p2p'。
 */
export function assembleConnPath(state, parsed) {
    const { candidates, inbound, outboundLoss, outboundTs, outboundJitter, outbound } = parsed;
    const pair = parsed.pair || parsed.fallback;
    if (!pair) {
        return {
            state,
            type: 'unknown',
            local: null,
            remote: null,
            rtt: null,
            inbound,
            outboundLoss,
            outboundTs,
            outboundJitter,
            outbound,
        };
    }
    const local = candidates.get(pair.localCandidateId)?.candidateType ?? null;
    const remote = candidates.get(pair.remoteCandidateId)?.candidateType ?? null;
    const rtt = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
    if (!local || !remote) {
        return {
            state,
            type: 'unknown',
            local,
            remote,
            rtt,
            inbound,
            outboundLoss,
            outboundTs,
            outboundJitter,
            outbound,
        };
    }
    const type = local === 'relay' || remote === 'relay' ? 'relay' : 'p2p';
    return { state, type, local, remote, rtt, inbound, outboundLoss, outboundTs, outboundJitter, outbound };
}

/** iceServers 载荷的身份标识：URLs + 凭据用户名。REST 模式的
 *  用户名是 unix 过期时间戳，新铸造的一组必然不同。 */
function iceServersStamp(iceServers) {
    return iceServers.map((server) => `${server?.urls}|${server?.username || ''}`).join(';');
}

export class Mesh {
    /**
     * @param {object}   options
     * @param {object}   options.signaling     socket.io 客户端（需要 .emit）
     * @param {object}   options.handlers      { onRemoteStream, onChat, onPeerState }
     * @param {function} [options.getOpusFmtp] () => 我们本地 offer/answer 用的
     *                                            Opus fmtp 参数（null = 保持默认）
     * @param {function} [options.getSelfId]   () => 我们的 session uuid——启用下方
     *                                            的 polite/impolite 冲突角色
     */
    constructor({ signaling, handlers = {}, getOpusFmtp = null, getSelfId = null }) {
        this.signaling = signaling;
        this.handlers = handlers;
        this.getOpusFmtp = getOpusFmtp;
        this.getSelfId = getSelfId;
        this.localStream = null;
        /** 最新的 iceServers 载荷（TURN REST 凭据会在会话中途过期） */
        this.iceServers = [];
        /** 当前 iceServers 载荷的身份（对加入风暴去重） */
        this.iceStamp = '';
        /** peerId -> { pc, dc, dcTimer, pendingIce, queue, queueBytes, tracksAdded, offering, bitrateFloor, jitterTarget, renegotiateTimer } */
        this.entries = new Map();
    }

    /** 设置/替换本地麦克风流（在 peer 连接前调用，或之后启用语音）。 */
    setLocalStream(stream) {
        this.localStream = stream;
        if (stream) {
            for (const entry of this.entries.values()) {
                if (entry.pc.connectionState === 'connected') this._addLocalTracks(entry);
            }
        }
    }

    /**
     * 在每条存活连接上换出向外音频轨道（切换麦克风或
     * 约束变更）。sender.replaceTrack 不动协商。
     * @param {MediaStreamTrack} track 来自新本地流的轨道
     * @param {MediaStream} [stream] 新的本地流（更新 this.localStream）
     */
    replaceAudioTrack(track, stream) {
        if (stream) this.localStream = stream;
        for (const entry of this.entries.values()) {
            if (entry.pc.connectionState === 'closed') continue;
            if (!entry.tracksAdded) {
                // 这条链路建立时我们还是纯文字，之后启用了语音
                // （连接时的挂载已经跑过，当时没有可添加的流）
                // ——现在就挂载：addTrack 会触发 negotiationneeded，
                // 标准的反向 offer 轮次把轨道带给 peer。
                // 在这里跳过（旧做法「连接时会拾取当前流」）
                // 会造成通话中途启用语音的人
                // 一直在向空传输。
                this._addLocalTracks(entry);
                continue;
            }
            const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
            if (sender) sender.replaceTrack(track).catch((err) => console.error('[mesh] replaceTrack failed', err));
            else {
                entry.pc.addTrack(track, this.localStream);
                this._applySendBitrate(entry); // 新建的 sender 不能停在浏览器默认码率
            }
        }
    }

    /**
     * @param {string}  peerId
     * @param {boolean} shouldCreateOffer 加入方一侧为 true
     * @param {Array}   iceServers 来自 addPeer 载荷
     */
    addPeer(peerId, shouldCreateOffer, iceServers = []) {
        // 全新的凭据组随每一次 addPeer 而来（重连风暴也是）——
        // 立即应用到每条存活连接（否则恢复用的 iceRestart 抢在
        // 刷新定时器之前跑，会用早已过期的凭据收集候选），
        // 经去重使加入风暴不至于反复空转
        // setConfiguration O(n²)
        if (iceServers?.length && iceServersStamp(iceServers) !== this.iceStamp) this.updateIceServers(iceServers);
        if (this.entries.has(peerId)) return;

        // iceCandidatePoolSize 预分配 host 候选并预拨 STUN：首次加入
        // 和每次重建的收集都快一拍（重连风暴频繁建 PC 时受益；
        // 纯音频——这点开销可忽略）
        const pc = new RTCPeerConnection({
            iceServers: iceServers.length ? iceServers : this.iceServers,
            iceCandidatePoolSize: 4,
        });
        const entry = { pc, dc: null, pendingIce: [], queue: [], queueBytes: 0, tracksAdded: false, offering: false };
        this.entries.set(peerId, entry);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.signaling.emit('relayICE', { peer_id: peerId, ice_candidate: event.candidate });
            }
        };

        pc.ontrack = (event) => {
            // 重建把 jitter buffer 目标带了过来，但新 PC 尚无 receiver
            // ——轨道落定时应用到它的 receiver 上
            if (entry.jitterTarget !== null && entry.jitterTarget !== undefined && event.receiver) {
                this._applyJitterTarget(event.receiver, entry.jitterTarget);
            }
            const stream = event.streams[0];
            if (stream && this.handlers.onRemoteStream) this.handlers.onRemoteStream(peerId, stream);
        };

        pc.onconnectionstatechange = () => {
            // 兜底挂载：应答之后才到来的流（链路以纯文字状态连接、
            // 之后才启用语音）在这里挂上——若应答前挂载已跑过，
            // 这里是幂等的。
            if (pc.connectionState === 'connected') this._addLocalTracks(entry);
            if (this.handlers.onPeerState) this.handlers.onPeerState(peerId, pc.connectionState);
        };

        const initiateOffer = async () => {
            if (entry.offering || pc.signalingState !== 'stable') return;
            entry.offering = true;
            try {
                this._preferCodecs(pc);
                const offer = await pc.createOffer();
                this._mungeLocalSdp(offer);
                await pc.setLocalDescription(offer);
                entry.offerSentAt = Date.now(); // unstickStaleOffer 的陈旧判定基准
                this.signaling.emit('relaySDP', { peer_id: peerId, session_description: pc.localDescription });
            } catch (err) {
                console.error('[mesh] offer failed', peerId, err);
            } finally {
                entry.offering = false;
            }
        };
        pc.onnegotiationneeded = initiateOffer;

        if (shouldCreateOffer) {
            this._attachChat(peerId, entry, pc.createDataChannel(CHAT_DC_LABEL));
            if (this.localStream) {
                this._addLocalTracks(entry); // 触发 negotiationneeded -> 初始 offer
            } else {
                // 纯文字加入者：没有轨道可触发 negotiationneeded，
                // 因此手动发起初始（recvonly、数据信道）offer——
                // 远端麦克风在连接后经反向 offer 到来
                initiateOffer();
            }
        } else {
            pc.ondatachannel = (event) => {
                if (event.channel.label === CHAT_DC_LABEL) this._attachChat(peerId, entry, event.channel);
            };
        }
    }

    async handleSessionDescription({ peer_id, session_description }) {
        const entry = this.entries.get(peer_id);
        if (!entry || !session_description) return;
        const pc = entry.pc;
        try {
            await this._applySessionDescription(peer_id, entry, session_description);
        } catch (err) {
            // Glare：双方可能同时重新 offer（例如同时在恢复死链路）。
            // perfect-negotiation 角色让它保持确定——
            // 较小的 session uuid（恢复梯子已信任由其发起的一方）
            // 是 impolite：它忽略相撞的 offer，
            // 等待自己那份 offer 的应答。较大的 uuid
            // 回滚并应答。没有角色时双方都会回滚，每个应答都落在
            // 已回滚的 offer 上，两场协商一起死
            // （旧的永远 polite 行为）。没有 getSelfId 时，
            // 保留 polite 回滚作为安全默认。
            if (session_description.type === 'offer' && pc.signalingState === 'have-local-offer') {
                const selfId = this.getSelfId?.();
                if (selfId && selfId < peer_id) {
                    console.log('[mesh] glare: impolite, keeping our offer', peer_id);
                    return;
                }
                try {
                    await pc.setLocalDescription({ type: 'rollback' });
                    await this._applySessionDescription(peer_id, entry, session_description);
                    return;
                } catch (retryErr) {
                    console.error('[mesh] glare rollback failed', peer_id, retryErr);
                    return;
                }
            }
            console.error('[mesh] session description failed', peer_id, err);
        }
    }

    async _applySessionDescription(peer_id, entry, session_description) {
        const pc = entry.pc;
        await pc.setRemoteDescription(session_description);
        // 冲刷在远端描述之前到达的 ICE 候选——并行喂入：trickle
        // 候选本就允许乱序落地（end-of-candidates 除外），串行
        // 等待只会推迟弱网乱序场景下的打洞启动
        const pending = entry.pendingIce.splice(0);
        if (pending.length) await Promise.allSettled(pending.map((candidate) => pc.addIceCandidate(candidate)));
        if (session_description.type === 'offer') {
            // 应答之前先挂载我们的麦克风：带音频 m-line 的 offer
            // 立即以 sendrecv 应答，ICE 一连通媒体即流动——
            // 本端发声之前不再需要反向 offer 轮次
            // （约一次额外信令 RTT + 协商收敛，1-3s）。
            // 仅 DC 的 offer（纯文字加入者）在应答中不会增加 m-line；
            // addTrack 把它的 negotiationneeded 排到应答之后，
            // 恰好经正常路径产生那次反向 offer。
            // 下方的连接时挂载仍保留，作为对晚到流的
            // 幂等兜底。
            this._addLocalTracks(entry);
            this._preferCodecs(pc);
            const answer = await pc.createAnswer();
            this._mungeLocalSdp(answer);
            await pc.setLocalDescription(answer);
            this.signaling.emit('relaySDP', { peer_id, session_description: pc.localDescription });
        }
        this._restampAdaptiveState(entry);
    }

    /**
     * 不重建 PeerConnection 而恢复媒体路径
     * （例如 coturn 重启导致 TURN 分配死亡）。发送带
     * iceRestart 的重新 offer；对端经正常路径应答，
     * 聊天 DataChannel 得以保留。
     * @param {string} peerId
     * @returns {Promise<boolean>} 重新 offer 已发出时为 true
     */
    async restartIce(peerId) {
        return this._sendOffer(peerId, { iceRestart: true });
    }

    /**
     * 回滚一条陈旧的无应答 offer（恢复阶梯的解卡通道）：
     * 对端 ghost 窗口内，服务器会静默丢弃发往它的 relaySDP，
     * answer 永不到来，PC 永久卡在 have-local-offer——之后所有
     * restartIce/renegotiate 都被 stable 检查拒绝，恢复轮次
     * 全部空转。只在 offer 发出已超过 minAgeMs 时回滚（默认
     * OFFER_STUCK_MS，见常量注释；对端 resume 事件已证明其
     * ghost 吞掉过信令时，调用方可传入更短的年龄——见
     * recovery.retryStuckOffer）。
     * @param {string} peerId
     * @param {number} [minAgeMs] offer 判死的最低年龄（毫秒）
     * @returns {Promise<boolean>} 已回滚时为 true
     */
    async unstickStaleOffer(peerId, minAgeMs = OFFER_STUCK_MS) {
        const entry = this.entries.get(peerId);
        if (!entry) return false;
        const pc = entry.pc;
        if (pc.signalingState !== 'have-local-offer') return false;
        if (!entry.offerSentAt || Date.now() - entry.offerSentAt < minAgeMs) return false;
        try {
            await pc.setLocalDescription({ type: 'rollback' });
            entry.offerSentAt = null;
            console.warn('[mesh] rolled back a stale unanswered offer', peerId);
            return true;
        } catch (err) {
            console.error('[mesh] stale offer rollback failed', peerId, err);
            return false;
        }
    }

    /**
     * 不触碰 ICE 而重新协商存活链路（例如音乐模式切换后的
     * 纯 fmtp 变更，如 stereo/usedtx——setParameters 动不了这些，
     * 健康的链路也绝不会自己再产生一轮 SDP）。
     * 复用 offer 路径的 fmtp 改写与 glare 防护。
     * 被拒绝时（协商中途：应答方的反向 offer 尚在途中）
     * 走短梯子重试——与恢复路径不同，这里没有会自行重试的
     * 节拍，而丢掉一轮就会把链路困在错误模式
     * （音乐上限配语音 DTX……），
     * 直到某个不相干的 SDP 事件。
     * @param {string} peerId
     * @returns {Promise<boolean>} offer 已发出时为 true
     */
    async renegotiate(peerId) {
        const sent = await this._sendOffer(peerId, {});
        if (!sent) this._scheduleRenegotiateRetry(peerId, 1);
        return sent;
    }

    /** offer 路径拒绝的重新协商的有界重试（见 renegotiate）。 */
    _scheduleRenegotiateRetry(peerId, attempt) {
        if (attempt > RENEGOTIATE_RETRIES) return;
        const entry = this.entries.get(peerId);
        if (!entry || entry.renegotiateTimer) return;
        entry.renegotiateTimer = setTimeout(
            () => {
                entry.renegotiateTimer = null;
                if (!this.entries.has(peerId)) return; // 等待期间 peer 已离开
                this._sendOffer(peerId, {}).then((sent) => {
                    if (!sent) this._scheduleRenegotiateRetry(peerId, attempt + 1);
                });
            },
            RENEGOTIATE_RETRY_DELAYS[attempt - 1]
        );
    }

    /** 重新协商所有稳定链路——模式切换作用于整个 mesh。 */
    renegotiateAll() {
        for (const peerId of this.entries.keys()) this.renegotiate(peerId).catch(() => {});
    }

    /**
     * 信令重连前的最后一级：重建单条链路——关闭旧
     * PeerConnection（全新的 ICE + DTLS），经正常加入方路径
     * 重新 offer。对端保留其条目、直接应答：来自新 PC 的
     * offer 带着新 ice-ufrag，迫使双方代理重新生成凭据——
     * 一次完整重检，与 leave+rejoin 相同的协商形状，
     * 但省去服务器往返。本侧 ontrack 会再次触发，
     * 既有 attachRemoteAudio 重新挂接播放。
     * @param {string} peerId
     * @returns {boolean} 新条目（及其 offer）是否已发出
     */
    rebuildPeer(peerId) {
        const prev = this.entries.get(peerId);
        if (!prev) return false;
        // 把自适应状态带过去：重建的链路在交换刚完成时最脆弱
        // ——此刻丢掉提升过的 jitter 目标或丢包驱动的码率地板，
        // 恰好在深缓冲刚刚挣到的时候回退到浏览器默认
        // （恢复引擎的连续记录还在，但它们只在下一次状态
        // 变化时才重新应用，而那可能永远不来）。
        // jitterTarget 由 ontrack 逐 receiver 重新应用。
        const carry = { jitterTarget: prev.jitterTarget ?? null, bitrateFloor: prev.bitrateFloor || null };
        this.removePeer(peerId);
        this.addPeer(peerId, true, this.iceServers);
        const entry = this.entries.get(peerId);
        if (entry) {
            entry.bitrateFloor = carry.bitrateFloor;
            entry.jitterTarget = carry.jitterTarget;
        }
        return this.entries.has(peerId);
    }

    /** ice 重启与普通重新协商共用的 offer 核心。 */
    async _sendOffer(peerId, offerOptions) {
        const entry = this.entries.get(peerId);
        if (!entry) return false;
        const pc = entry.pc;
        // 协商中途（反向 offer 在途）：先让它收敛，
        // 调用方的节拍会在下一个 tick 重试
        if (pc.connectionState === 'closed' || pc.signalingState !== 'stable') return false;
        entry.offering = true;
        try {
            this._preferCodecs(pc);
            const offer = await pc.createOffer(offerOptions);
            this._mungeLocalSdp(offer);
            await pc.setLocalDescription(offer);
            entry.offerSentAt = Date.now(); // unstickStaleOffer 的陈旧判定基准
            this.signaling.emit('relaySDP', { peer_id: peerId, session_description: pc.localDescription });
            if (offerOptions.iceRestart) console.log('[mesh] ice restart offer sent', peerId);
            this._restampAdaptiveState(entry);
            return true;
        } catch (err) {
            console.error('[mesh] offer failed', peerId, err);
            return false;
        } finally {
            entry.offering = false;
        }
    }

    /**
     * 换入全新的 ICE 服务器列表（TURN REST 凭据会过期——该模式下
     * 用户名就是过期时间戳）。setConfiguration 喂给每条存活连接的
     * ICE 代理，下一次 iceRestart 因此能用仍可通过认证的凭据
     * 收集中继候选；
     * 既存分配无论如何都继续用旧的运行。
     * @param {Array} iceServers
     * @returns {number} 多少条存活连接拒绝了 setConfiguration
     */
    updateIceServers(iceServers) {
        if (!Array.isArray(iceServers) || !iceServers.length) return 0;
        this.iceServers = iceServers;
        this.iceStamp = iceServersStamp(iceServers);
        let refused = 0;
        for (const entry of this.entries.values()) {
            if (entry.pc.connectionState === 'closed') continue;
            try {
                entry.pc.setConfiguration({ iceServers });
            } catch {
                refused += 1; // 罕见的协商中途边界——调用方稍后会重新应用
            }
        }
        return refused;
    }

    async handleIceCandidate({ peer_id, ice_candidate }) {
        const entry = this.entries.get(peer_id);
        if (!entry || !ice_candidate) return;
        if (!entry.pc.remoteDescription) {
            // 异常/失控对端的洪泛不得无限占用内存（正常 trickle
            // 每对端几十个候选）——超限静默丢弃
            if (entry.pendingIce.length >= PENDING_ICE_MAX) return;
            entry.pendingIce.push(ice_candidate);
            return;
        }
        try {
            await entry.pc.addIceCandidate(ice_candidate);
        } catch {
            /* 忽略迟到/重复的候选 */
        }
    }

    /**
     * 检查一条连接的存活 ICE 路径：选中的候选对
     * 两端都是直连（host/srflx/prflx——打洞成功）时为 'p2p'，
     * 媒体经 TURN 服务器流动（任一端在中继候选上）时为 'relay'。
     * 入向音频 RTP 报告一并带回（累计计数——调用方在两次轮询间
     * 差分得到丢包率与码率），另外还有对端接收方报告
     * 归于我们流的出向丢包（fractionLost，以百分比计）——
     * 这是任何发送侧自适应都必须响应的信号。报告的解析与结果
     * 组装在模块级的 parseConnStats / assembleConnPath（纯函数，可单测）。
     * @param {string} peerId
     * @returns {Promise<?object>} { state, type, local, remote, rtt, inbound, outboundLoss, outboundTs, outboundJitter, outbound } — peer 未知时为 null
     */
    async connPath(peerId) {
        const entry = this.entries.get(peerId);
        if (!entry) return null;
        const pc = entry.pc;
        const state = pc.connectionState;
        if (state !== 'connected') {
            return {
                state,
                type: 'unknown',
                local: null,
                remote: null,
                rtt: null,
                inbound: null,
                outboundLoss: null,
                outboundTs: null,
                outboundJitter: null,
                outbound: null,
            };
        }
        return assembleConnPath(state, parseConnStats(await pc.getStats()));
    }

    removePeer(peerId) {
        const entry = this.entries.get(peerId);
        if (!entry) return;
        clearTimeout(entry.dcTimer);
        clearTimeout(entry.renegotiateTimer);
        try {
            entry.pc.close();
        } catch {
            /* 本已关闭 */
        }
        this.entries.delete(peerId);
    }

    /**
     * 经每条聊天 DataChannel 广播 JSON 载荷（未打开时排队）。
     * @throws {Error} 已打开的信道拒绝该帧（发送缓冲满/信道正在关闭），
     *         或连接中信道的队列超预算时抛 'dc-send-failed'
     *         ——调用方据此中止多帧传输，
     *         而不是无声地丢掉余下的帧。
     */
    sendChat(payload) {
        const raw = JSON.stringify(payload);
        let failed = false;
        for (const [peerId, entry] of this.entries) {
            if (!entry.dc) continue;
            if (entry.dc.readyState === 'open') {
                try {
                    entry.dc.send(raw);
                } catch {
                    failed = true;
                }
            } else if (
                entry.dc.readyState === 'connecting' &&
                entry.queue.length < DC_QUEUE_MAX_FRAMES &&
                entry.queueBytes + raw.length <= DC_QUEUE_MAX_BYTES
            ) {
                entry.queue.push(raw);
                entry.queueBytes += raw.length;
            } else if (entry.dc.readyState === 'connecting') {
                // 永远不会打开的信道（僵尸链路）：拒绝而非无限缓冲
                // ——聊天文字有服务器副本，但排队到一半的图片批次
                // 会渲染成一次损坏的传输，
                // 共享的中止路径（下面的 throw）才是诚实做法
                console.warn('[mesh] dc send queue over budget, refusing frame', peerId);
                failed = true;
            }
        }
        if (failed) throw new Error('dc-send-failed');
    }

    /** 关闭所有 peer 连接但保持实例可用（重连场景）。 */
    clear() {
        for (const peerId of [...this.entries.keys()]) this.removePeer(peerId);
    }

    /**
     * 等到每条 OPEN 聊天信道的 SCTP 缓冲都低于低水位
     * （有界——卡死的缓冲会释放泵，sendChat 的 throw 路径
     * 才是真正的失败模式）。图片传输泵在分块突发之间调用它：
     * 不节流地倾倒 ~1.6MB 会与共享同一传输的语音包争抢，
     * 在弱链路上造成可闻的通话卡顿。
     * @returns {Promise<void>}
     */
    async drainChat() {
        const deadline = Date.now() + DRAIN_MAX_MS;
        for (;;) {
            let busy = false;
            for (const entry of this.entries.values()) {
                if (entry.dc?.readyState === 'open' && entry.dc.bufferedAmount > DC_BUFFER_LOW) busy = true;
            }
            if (!busy || Date.now() >= deadline) return;
            await new Promise((resolve) => setTimeout(resolve, DRAIN_WAIT_MS));
        }
    }

    close() {
        this.clear();
        this.localStream = null;
    }

    _addLocalTracks(entry) {
        if (!this.localStream || entry.tracksAdded) return;
        entry.tracksAdded = true;
        for (const track of this.localStream.getTracks()) {
            entry.pc.addTrack(track, this.localStream);
        }
        this._applySendBitrate(entry);
    }

    /** 把配置的 Opus fmtp 上限烙到即将设为 LOCAL（offer 或 answer）
     *  的描述上——语义见 mungeOpusFmtp。 */
    _mungeLocalSdp(desc) {
        const fmtp = this.getOpusFmtp?.();
        if (fmtp && desc?.sdp) desc.sdp = mungeOpusFmtp(desc.sdp, fmtp);
    }

    /**
     * 连接的音频 transceiver 编解码偏好，在本侧生成的每次
     * offer/answer 之前应用：语音模式（fmtp 字典带 usedtx=1
     * ——与丢包自适应门控的同一信号）把 audio/red 排最前
     * 换取包级冗余；其余模式恢复浏览器默认顺序，
     * 避免音乐/共享带宽翻倍。每轮 SDP 都重跑一次，
     * 通话中的模式切换才不会落空——它本身触发的重新协商
     * 会双向重排编解码。没有 transceiver.setCodecPreferences
     * 或能力里没有 audio/red 的浏览器
     * 则静默保持默认。
     */
    _preferCodecs(pc) {
        for (const transceiver of pc.getTransceivers()) {
            const kind = transceiver.sender?.track?.kind || transceiver.receiver?.track?.kind;
            if (kind !== 'audio' || typeof transceiver.setCodecPreferences !== 'function') continue;
            try {
                const codecs = RTCRtpReceiver?.getCapabilities?.('audio')?.codecs;
                if (!Array.isArray(codecs) || !codecs.length) continue;
                if (this.getOpusFmtp?.()?.usedtx === 1) {
                    const red = redFirstCodecs(codecs);
                    if (red !== codecs) transceiver.setCodecPreferences(red); // 无 red → 原样不动
                } else {
                    // 把未改动的原始能力清单递回去以恢复浏览器默认顺序
                    // （它本身就是那个顺序）——规范里的 undefined/
                    // 空列表重置是较新的接口面，部分引擎会拒绝，
                    // 而这里被吞掉的拒绝会让语音→音乐切换
                    // 困在 RED 的双倍带宽上
                    transceiver.setCodecPreferences(codecs);
                }
            } catch {
                /* 无效偏好（浏览器拒绝的 apt 链）：保持默认 */
            }
        }
    }

    /** 我们协商出的音频段是否以 audio/red 打头——即编码器
     *  是否真的用冗余包裹包（Chrome 默认就在 m-line 里列出
     *  red；只有当它是首个载荷时发送端才会真正使用。
     *  getStats 的 outbound codecId 会误导性地报告包裹后的
     *  opus——每包字节约为上限 2 倍才是线路层面的实据）。 */
    redNegotiated(peerId) {
        const sdp = this.entries.get(peerId)?.pc.localDescription?.sdp;
        if (typeof sdp !== 'string') return null;
        let firstPayload = null; // 音频段的首个载荷类型
        for (const line of sdp.split(/\r?\n/)) {
            if (line.startsWith('m=audio')) {
                firstPayload = line.split(' ')[3] ?? null;
            } else if (line.startsWith('m=')) {
                if (firstPayload !== null) break; // 音频段结束也未出现 red rtpmap
            } else if (firstPayload !== null && new RegExp(`^a=rtpmap:${firstPayload} red/`).test(line)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 经 setParameters 把生效的发送码率推到连接的音频 sender 上
     * ——无需重新协商即生效。取值为配置的 fmtp 上限，
     * 或恢复引擎放在这条链路上的临时丢包驱动地板
     * （见 setPeerBitrateFloor）。
     */
    _applySendBitrate(entry) {
        const maxBitrate = entry.bitrateFloor || this.getOpusFmtp?.()?.maxaveragebitrate;
        if (!maxBitrate) return;
        const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (!sender) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings?.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = maxBitrate;
            sender.setParameters(params).catch(() => {
                /* 浏览器拒绝音频 setParameters——fmtp 上限仍然有效 */
            });
        } catch {
            /* 音频不支持 get/setParameters——无事可做 */
        }
    }

    /**
     * 每链路临时的发送码率地板，当对端接收方报告显示持续的
     * 出向丢包时由恢复引擎设置（即使 Opus 已近其上限，
     * 更小的供给负载也有助于缓解拥塞）。
     * 传 null 抬起地板并重新应用配置的上限。
     * @param {string} peerId
     * @param {?number} bps 地板值，单位 bit/s，或 null
     */
    setPeerBitrateFloor(peerId, bps) {
        const entry = this.entries.get(peerId);
        if (!entry) return;
        entry.bitrateFloor = bps || null;
        this._applySendBitrate(entry);
    }

    /**
     * 在每条存活连接上重新应用配置的发送码率。用户操作
     * （滑杆/模式切换）——任何自适应地板都让位于它。
     */
    setSendBitrate() {
        for (const entry of this.entries.values()) {
            entry.bitrateFloor = null;
            this._applySendBitrate(entry);
        }
    }

    /**
     * 单链路的接收侧播放平滑：路径轮询看到持续的抖动/丢包时
     * 抬高音频 jitter buffer 目标，收敛后回落到浏览器的
     * 自适应默认（null）。经特性检测——
     * 没有 receiver 缓冲控制能力的浏览器保持其默认。
     * @param {string} peerId
     * @param {?number} ms 目标深度，毫秒；null 为浏览器自动
     */
    setPeerJitterTarget(peerId, ms) {
        const entry = this.entries.get(peerId);
        if (!entry || entry.jitterTarget === ms) return;
        for (const receiver of entry.pc.getReceivers()) {
            if (receiver.track?.kind !== 'audio') continue;
            this._applyJitterTarget(receiver, ms);
        }
        entry.jitterTarget = ms;
    }

    /**
     * 每轮 SDP 之后重烙自适应链路状态（发送码率上限/地板 +
     * jitter buffer 目标）：改写音频段的协商可能丢掉 sender
     * 编码参数与 receiver 缓冲提示，而本应用制造的重新协商
     * 远多于健康链路本会经历的（恢复重启、中转重打洞、
     * 模式切换）——每一次都会无声地把已被自适应引擎
     * 调好的链路重置回浏览器默认。rebuildPeer 在 PC 交换时
     * 携带状态跨越；这就是普通 re-offer 路径的
     * 同一份保险。
     */
    _restampAdaptiveState(entry) {
        this._applySendBitrate(entry);
        if (entry.jitterTarget === null || entry.jitterTarget === undefined) return;
        for (const receiver of entry.pc.getReceivers()) {
            if (receiver.track?.kind !== 'audio') continue;
            this._applyJitterTarget(receiver, entry.jitterTarget);
        }
    }

    /** 把播放缓冲目标推到单个 receiver 上——经特性检测。
     *  标准属性的单位是毫秒，被其取代的旧 Chromium hint
     *  单位是秒（截断到 [0,10]——不换算的 60 会把
     *  pre-jitterBufferTarget webview 的播放钉在
     *  截断上限），null 在两者上都意为「浏览器自适应默认」，而非零。 */
    _applyJitterTarget(receiver, ms) {
        try {
            if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
            else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = ms === null ? null : ms / 1000;
        } catch {
            /* 被拒绝时该 receiver 保持浏览器默认 */
        }
    }

    _attachChat(peerId, entry, dc) {
        clearTimeout(entry.dcTimer); // peer 重建的信道刚到达
        entry.dc = dc;
        dc.onopen = () => {
            const queued = entry.queue.splice(0);
            entry.queueBytes = 0;
            for (const item of queued) {
                if (dc.readyState !== 'open') break;
                try {
                    dc.send(item);
                } catch {
                    // SCTP 缓冲撑爆时 send 同步抛——曾从这里炸穿
                    // 事件处理器。弃掉余帧并关流：下方 onclose 的
                    // 信道重建路径会换一条恢复，聊天文字有服务器
                    // 副本兜底（与 sendChat 的失败语义一致）
                    console.warn('[mesh] dc queue flush failed, closing channel');
                    try {
                        dc.close();
                    } catch {
                        /* 本已关闭 */
                    }
                    break;
                }
            }
        };
        dc.onmessage = (event) => {
            let data;
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }
            if (this.handlers.onChat) this.handlers.onChat(peerId, data);
        };
        dc.onclose = () => {
            if (entry.dc === dc) entry.dc = null;
            // PC 存活但 SCTP 已死（罕见的传输层重置）：聊天与图片
            // 传输会无声死亡而语音继续流动，且恢复梯子只盯着
            // connectionState。给正在重建的 peer 一点时间落位
            // 它自己的信道，然后重建我们的——随后的重新协商
            // 会在两端重建它。
            if (entry.pc.connectionState !== 'connected' || this.entries.get(peerId) !== entry) return;
            clearTimeout(entry.dcTimer);
            entry.dcTimer = setTimeout(() => {
                if (entry.dc || entry.pc.connectionState !== 'connected' || this.entries.get(peerId) !== entry) return;
                console.warn('[mesh] chat channel died on a live link, renegotiating', peerId);
                this._attachChat(peerId, entry, entry.pc.createDataChannel(CHAT_DC_LABEL));
            }, 1000);
        };
    }
}
