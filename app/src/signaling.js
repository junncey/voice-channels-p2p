/*
Socket.IO 信令——mesh P2P 协议核心（relaySDP 载荷新增可选 sdp_seq
代次号，answer 原样回带、服务器只透传不解释——语义见前端 webrtc.js）。

join → addPeer → relaySDP/relayICE → removePeer，外加房间作用域的
peer 事件中转。join 的完整门禁流程（含防爆破冷却与 addPeer 通知）
在 joinFlow.js；房间状态与幽灵/恢复语义在 rooms.js；
聊天处理器经 `chatGateway` 注入。
*/

'use strict';

const Validate = require('./validate');
const limits = require('./limits');
const { sanitizeExceptSecrets, isImageDataUrl, toJson } = require('./payload');
const { createJoinFlow } = require('./joinFlow');

// 信令中转节流：relaySDP/relayICE 只做成员资格校验，恶意/失控
// 客户端可以向房间内每个成员洪水转发并被原样放大。正常打洞
// 每对端几十个候选、重连风暴也就几百条——窗口阈值放得足够
// 宽，只拦脚本级洪泛；超限断开（仅该 socket，不碰房间其余
// 成员，与踢人同一拆除路径）。预算随所在频道的容量缩放：
// mesh 重连风暴的中转量随成员数线性放大，固定阈值对大频道
// （maxParticipants 可到 16）一次全量重连 + 几轮恢复即触线，
// flood 断开反而制造「ghost → 再恢复」的循环。
const RELAY_WINDOW_MS = 10000;
const RELAY_MAX_EVENTS = 2000; // 基本预算：默认 8 人频道校准的历史值
// 每对端的系数：一次完整协商 ≈ 2 SDP + 10-15 ICE 候选，恢复
// 梯子重跑 3 轮 + relay 升级重试 ≈ 85，翻倍留余量
const RELAY_EVENTS_PER_PEER = 200;

/** 该 socket 的中转预算：基本值与「所在最大频道的容量 × 每对端
 *  事件量」取大（relay 只能发往共享房间的成员，成员上限就是
 *  合法事件量的上限）。 */
function relayBudget(socket, channelStore) {
    let cap = 0;
    for (const channel of Object.keys(socket.channels || {})) {
        const def = channelStore.get(channel) || channelStore.getTemp(channel);
        const n = def?.maxParticipants || 0;
        if (n > cap) cap = n;
    }
    return Math.max(RELAY_MAX_EVENTS, cap * RELAY_EVENTS_PER_PEER);
}

/** 本条中转事件是否超出 socket 级预算；超限的那一条触发断开。 */
function relayThrottled(socket, log, budget) {
    const now = Date.now();
    if (!socket.relayWindow || now - socket.relayWindow.start >= RELAY_WINDOW_MS) {
        socket.relayWindow = { start: now, count: 0 };
    }
    socket.relayWindow.count += 1;
    if (socket.relayWindow.count <= budget) return false;
    if (socket.relayWindow.count === budget + 1) {
        log.warn('[' + socket.id + '] signaling relay flood, disconnecting', {
            window_ms: RELAY_WINDOW_MS,
            events: socket.relayWindow.count,
            budget,
        });
        socket.disconnect(true);
    }
    return true;
}

const SDP_TYPES = new Set(['offer', 'answer']);

/** relaySDP 载荷形状/大小：正常 offer/answer 连同全部候选也就几 KB，
 *  超限只能是恶意构造——中转按「条」计费、不按字节计，socket.io
 *  2MB 包上限内的一个巨型载荷会被原样放大到目标成员。 */
function validSdpPayload(desc) {
    if (!desc || typeof desc !== 'object') return false;
    if (!SDP_TYPES.has(desc.type)) return false;
    return typeof desc.sdp === 'string' && desc.sdp.length > 0 && desc.sdp.length <= limits.SDP_MAX_CHARS;
}

/** relayICE 载荷形状/大小：candidate 行（含扩展属性）远小于此限。 */
function validIcePayload(cand) {
    if (!cand || typeof cand !== 'object') return false;
    if (typeof cand.candidate !== 'string') return false;
    return cand.candidate.length <= limits.ICE_CAND_MAX_CHARS;
}

/** relaySDP 的可选代次号（offer/answer 与协商轮次的关联，语义见
 *  前端 webrtc.js 的 sdp_seq）：合法才透传；畸形值与畸形载荷同语义
 *  ——整条静默丢弃，不回执。undefined（旧客户端不带）永远合法。 */
function validSdpSeq(seq) {
    return seq === undefined || (Number.isSafeInteger(seq) && seq >= 0 && seq <= limits.SDP_SEQ_MAX);
}

/**
 * 把信令协议接到 socket.io 服务器上。依赖来自 server.js（装配点）：
 * 房间状态（`rooms`）、聊天 socket 域（`chatGateway`）、
 * channel/chat store 与 host-token 助手。
 */
function registerSignaling(
    io,
    {
        rooms,
        chatGateway,
        channelStore,
        chatStore,
        audit,
        log,
        channelsCfg,
        tempRoomsEnabled,
        getIceServers,
        verifyConsoleToken,
        safeEqualStrings,
        trustProxy,
    }
) {
    const {
        channels,
        sockets,
        peers,
        presenters,
        isPeerInRoom,
        roomSessionUuid,
        roomSender,
        sharedRoom,
        liveSessionSocket,
        sessionPresence,
        sendToRoom,
        detachAsGhost,
        removePeerFrom,
    } = rooms;

    // join 的完整门禁流程（防爆破冷却、host 认证、幽灵恢复、
    // 临时房物化、addPeer mesh 通知）在 joinFlow.js
    const joinFlow = createJoinFlow({
        rooms,
        channelStore,
        chatStore,
        audit,
        log,
        channelsCfg,
        tempRoomsEnabled,
        getIceServers,
        verifyConsoleToken,
        safeEqualStrings,
        trustProxy,
    });

    io.sockets.on('connect', async (socket) => {
        log.debug('[' + socket.id + '] connection accepted', {
            // Host 头并非总在（HTTP/1.0 或手工构造的握手）——
            // 这里抛 TypeError 会炸穿本处理器，disconnect
            // 还没注册，socket 就成了永不清理的僵尸
            host: (socket.handshake.headers.host || '').split(':')[0],
        });

        socket.channels = {};
        sockets[socket.id] = socket;

        /**
         * peer 断开连接时
         */
        socket.on('disconnect', async (reason) => {
            // 主动离开（leave()、kickOut、admin 逐出、我们自己的 B1
            // 重建）立刻拆除会话。其余一切
            // （VPN/加速器切换、网络抖动、休眠）转为幽灵：
            // 会话条目在宽限窗口内存活，同一 uuid 可以
            // 无缝恢复。
            const intentional = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';
            for (const channel of Object.keys(socket.channels)) {
                if (intentional) await removePeerFrom(channel, socket, reason);
                else await detachAsGhost(channel, socket, reason);
            }
            log.debug('[' + socket.id + '] disconnected', { reason });
            delete sockets[socket.id];
            chatGateway.onDisconnect(socket);
        });

        socket.on('join', (cfg) => joinFlow.handleJoin(socket, cfg));

        /**
         * 向 peer 中转 ICE（peer_id = 目标会话 uuid）
         */
        socket.on('relayICE', async (config) => {
            if (relayThrottled(socket, log, relayBudget(socket, channelStore))) return;
            if (!Validate.isValidData(config)) return;
            const { peer_id, ice_candidate } = config;
            if (!validIcePayload(ice_candidate)) return;
            const channel = sharedRoom(socket, peer_id);
            const target = channel && liveSessionSocket(channel, peer_id);
            if (!target) return;
            target.emit('iceCandidate', {
                peer_id: socket.channels[channel].uuid,
                ice_candidate: ice_candidate,
            });
        });

        /**
         * 向 peer 中转 SDP（peer_id = 目标会话 uuid）
         */
        socket.on('relaySDP', async (config) => {
            if (relayThrottled(socket, log, relayBudget(socket, channelStore))) return;
            if (!Validate.isValidData(config)) return;
            const { peer_id, session_description, sdp_seq } = config;
            // 畸形/超大载荷静默丢弃（不回 relayUndelivered 回执——
            // 回执语义是「合法载荷此刻投不出去」）
            if (!validSdpPayload(session_description) || !validSdpSeq(sdp_seq)) return;
            const channel = sharedRoom(socket, peer_id);
            const target = channel && liveSessionSocket(channel, peer_id);
            if (!target) {
                // 例外——发送者自己还没加入任何频道：传输重连时
                // socket.io-client 先冲刷断线期间缓冲的全部 emit、之后
                // 才发 join，恢复梯子在断线期间发出的 offer 就这样以
                // 「陌生人」的身份到达。投不出去的原因在发送者自己，
                // 不是对端吞信令——回执只会把客户端引向一次毫无意义
                // 的探测。静默丢弃；那份 offer 由 resume 路径解卡
                // （specs/p2p-recovery-boundaries.md §3）
                if (!Object.keys(socket.channels).length) return;
                // 回执而非静默丢弃：SDP 目标此刻不可投递（对端 ghost
                // 吞信令，或已离开）。客户端据此立刻做 presence 分流，
                // 把「offer 卡死」的判定从 8s 超时盲等降为 RTT 级。
                // 刻意只在 SDP 层回执——ICE 候选量大（重连风暴下
                // 每对端几十条），回执本身会成为放大器
                socket.emit('relayUndelivered', { peer_id, kind: 'sdp' });
                return;
            }
            log.debug('[' + socket.id + '] relay SessionDescription to [' + peer_id + ']', {
                type: session_description.type,
            });
            target.emit('sessionDescription', {
                peer_id: socket.channels[channel].uuid,
                session_description: session_description,
                sdp_seq, // 可选代次号；undefined 经 socket.io 编码自然省略
            });
        });

        /**
         * 按需获取全新 ICE 服务器列表（ack 式）。长会话活得比
         * TURN REST 凭证久：列表在 addPeer 时烤进每个
         * RTCPeerConnection，凭证临近到期的客户端会索要一套新的，
         * 喂给 setConfiguration——其恢复用的 iceRestart 便能
         * 重新通过 coturn 认证。
         * 设计上很便宜：列表进程级全局，
         * 且在 getIceServers 里做了记忆化。
         */
        socket.on('refreshIceServers', async (unused, ack) => {
            if (typeof ack !== 'function') return;
            ack(getIceServers());
        });

        /**
         * 恢复探测（ack 式）：目标会话是否仍是我们共享房间的成员？
         * socket 错过 removePeer 广播的客户端（断开时间长于目标的
         * 幽灵宽限）否则会对着一个已不存在的 peer
         * 跑完整套 ICE-restart 阶梯。
         * 'gone' 让它立刻丢掉成员卡片；
         * 'ghost'（附 resume 宽限剩余毫秒）让阶梯继续治愈并推迟
         * 全量重建——resume 仍可能落地。
         * 'unknown'：探测者自己的 join 尚未在该频道落座——此刻对
         * 房间一无所知，任何确定性答案都是错的（答 'gone' 会让
         * 客户端当场拆掉一个活着的成员）。客户端携带的 room_id
         * 是判定依据；不带 room_id 的旧载荷走原路径。
         */
        socket.on('peerPresence', async (config, ack) => {
            if (typeof ack !== 'function' || !Validate.isValidData(config)) return;
            if (typeof config.room_id === 'string' && !Object.hasOwn(socket.channels, config.room_id)) {
                return ack({ present: 'unknown', graceLeftMs: 0 });
            }
            const channel = sharedRoom(socket, config.peer_id);
            ack(channel ? sessionPresence(channel, config.peer_id) : { present: 'gone', graceLeftMs: 0 });
        });

        /**
         * 处理房间操作（主持人门控）：lock/unlock/joinLock。
         * （旧的 `checkPassword` 操作已移除：客户端没有任何地方用它，
         * 而且它让任何 socket 都能未认证地探测房间密码。）
         */
        socket.on('roomAction', async (cfg) => {
            // 房间锁密码原文存储/比对（仅内存，故不存在旧形态）
            // ——除密钥外全部清洗
            const config = sanitizeExceptSecrets(cfg, ['password']);
            if (!Validate.isValidData(config)) return;

            const { room_id, password, action } = config;

            // 发送者必须是房间已加入的成员（同时也拦下
            // 针对任意键或继承键的探测）
            const senderUuid = roomSessionUuid(socket, room_id);
            if (!senderUuid) return;

            const isPresenter = presenters[room_id]?.[senderUuid]?.is_presenter === true;
            const peer_name = peers[room_id][senderUuid].peer_name;

            try {
                switch (action) {
                    case 'lock':
                        if (!isPresenter) return;
                        peers[room_id]['lock'] = true;
                        peers[room_id]['password'] = password;
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    case 'unlock':
                        if (!isPresenter) return;
                        delete peers[room_id]['lock'];
                        delete peers[room_id]['password'];
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    case 'joinLockOn':
                        if (!isPresenter) return;
                        peers[room_id]['joinLock'] = true;
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    case 'joinLockOff':
                        if (!isPresenter) return;
                        delete peers[room_id]['joinLock'];
                        await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                        break;
                    default:
                        break;
                }
            } catch (err) {
                log.error('Room action', toJson(err));
            }
        });

        /**
         * 向 peer 中转改名
         */
        socket.on('peerName', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_name_old } = config;
            // 与 peerRename 相同的 trim + 24 字符上限（见 handleJoin）——
            // 非字符串/空白名不得写进房间状态并随成员广播扩散
            const peer_name_new =
                typeof config.peer_name_new === 'string'
                    ? config.peer_name_new.trim().slice(0, limits.PEER_NAME_MAX)
                    : '';
            if (!peer_name_new) return;

            const entry = Object.hasOwn(peers, room_id) ? peers[room_id][senderUuid] : null;
            if (!entry) return;

            entry['peer_name'] = peer_name_new;
            if (presenters[room_id] && presenters[room_id][senderUuid]) {
                presenters[room_id][senderUuid]['peer_name'] = peer_name_new;
            }
            log.debug('[' + socket.id + '] peer profile changed', { peer_name_old, peer_name_new });

            await sendToRoom(room_id, socket.id, 'peerName', {
                peer_id: senderUuid,
                peer_name: peer_name_new,
            });
        });

        /**
         * host 改他人昵称（管理行为）。被改名的 peer 与其他人收到
         * 同一条 peerName 广播，并接受新名字。
         */
        socket.on('peerRename', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_id } = config;

            if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) {
                log.debug('peerRename blocked: sender is not the presenter', { room_id, socket_id: socket.id });
                return;
            }

            const name =
                typeof config.peer_name_new === 'string'
                    ? config.peer_name_new.trim().slice(0, limits.PEER_NAME_MAX)
                    : '';
            // 改名目标必须是房间已加入的成员
            if (!name || !isPeerInRoom(room_id, peer_id)) return;

            const old = peers[room_id][peer_id]['peer_name'];
            peers[room_id][peer_id]['peer_name'] = name;
            if (presenters[room_id] && presenters[room_id][peer_id]) {
                presenters[room_id][peer_id]['peer_name'] = name;
            }
            log.info('[' + socket.id + '] host renamed peer', { room_id, peer_id, from: old, to: name });

            // 所有人（含 host）都收到更新——host 的成员列表
            // 与聊天提示也必须跟随（sendToRoom 会跳过发送者）
            for (const sock of Object.values(channels[room_id] || {})) {
                sock.emit('peerName', { peer_id, peer_name: name, peer_name_old: old });
            }
        });

        /**
         * 设置/清除 peer 的自定义头像。data URL 绝不过
         * checkXSS（DOMPurify 会剥掉 data: URI）——改为按严格
         * 白名单 + 尺寸上限校验，与 DataChannel 图片协议完全一致，
         * 且只作为 <img src> 渲染。
         */
        socket.on('peerAvatar', async (cfg) => {
            const ctx = roomSender(socket, cfg, { sanitize: false }); // data URL 绝不过 checkXSS
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, avatar } = config;

            const valid = isImageDataUrl(avatar, limits.AVATAR_MAX_CHARS);
            if (valid) {
                peers[room_id][senderUuid]['peer_avatar'] = avatar;
            } else {
                delete peers[room_id][senderUuid]['peer_avatar'];
            }

            const peer_name = peers[room_id][senderUuid]['peer_name'];
            log.debug('[' + socket.id + '] peer avatar ' + (valid ? 'set' : 'cleared'), { room_id });

            // 所有人（含发送者）——发送者自己的 DOM 已是最新，
            // 回声只是让房间保持同步
            for (const sock of Object.values(channels[room_id] || {})) {
                sock.emit('peerAvatar', {
                    peer_id: senderUuid,
                    peer_name,
                    avatar: valid ? avatar : null,
                });
            }
        });

        /**
         * 向 peer 中转 audio/deafen/share 状态。'audio' 是麦克风状态；
         * 'deafen' 标记在本地静音了全部远端声音的成员；
         * 'share' 标记把采集的系统/标签页声音混进 outgoing 流的成员
         * （「一起听」）。
         */
        socket.on('peerStatus', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, element, status } = config;

            if (element === 'audio') peers[room_id][senderUuid]['peer_audio_status'] = status === true;
            else if (element === 'deafen') peers[room_id][senderUuid]['peer_deafen'] = status === true;
            else if (element === 'share') peers[room_id][senderUuid]['peer_share'] = status === true;
            else return;

            await sendToRoom(room_id, socket.id, 'peerStatus', {
                peer_id: senderUuid,
                peer_name: peers[room_id][senderUuid]['peer_name'],
                element,
                status: status === true,
            });
        });

        chatGateway.register(socket);

        /**
         * 向 peer 中转操作（管理类操作受主持人门控）。
         * peer_id（定向时）为目标会话 uuid。
         */
        socket.on('peerAction', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_id, peer_action, send_to_all } = config;

            // 只有主持人能执行管理类操作
            const presenterActions = ['muteAudio', 'ejectAll'];
            if (presenterActions.includes(peer_action)) {
                if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) return;
            }

            const targetName = isPeerInRoom(room_id, peer_id) ? peers[room_id][peer_id].peer_name : config.peer_name;
            const data = { peer_id, peer_name: targetName, peer_action };

            if (send_to_all) {
                await sendToRoom(room_id, socket.id, 'peerAction', data);
            } else {
                // 定向操作：目标必须与发送者共享房间
                // （与 SDP/ICE 中转相同的成员门禁）
                const channel = sharedRoom(socket, peer_id);
                const target = channel && liveSessionSocket(channel, peer_id);
                if (!target) return;
                target.emit('peerAction', data);
            }
        });

        /**
         * 把 peer 踢出房间（仅主持人）。peer_id 是目标（TARGET）的
         * 会话 uuid；调用者身份是绑定在服务端的会话，
         * 不是客户端提供的任何东西。
         */
        socket.on('kickOut', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id, peer_id, peer_kicked_reason } = config;

            if (!isPeerInRoom(room_id, peer_id)) return;

            if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) return;

            const target = liveSessionSocket(room_id, peer_id);
            if (!target) return;
            log.info('[' + socket.id + '] kick out peer [' + peer_id + '] from room [' + room_id + ']', {
                by: peers[room_id][senderUuid].peer_name,
                target: peers[room_id][peer_id]?.peer_name,
            });
            audit.record('hostKick', {
                channel: room_id,
                by: peers[room_id][senderUuid].peer_name,
                target: peers[room_id][peer_id]?.peer_name,
                reason: peer_kicked_reason,
            });
            target.emit('kickOut', {
                peer_name: peers[room_id][senderUuid].peer_name,
                peer_kicked_reason: peer_kicked_reason,
            });
        });
    });
}

module.exports = { registerSignaling };
