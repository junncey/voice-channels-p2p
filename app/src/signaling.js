/*
Socket.IO 信令——mesh P2P 协议核心（协议未变）。

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
            if (!Validate.isValidData(config)) return;
            const { peer_id, ice_candidate } = config;
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
            if (!Validate.isValidData(config)) return;
            const { peer_id, session_description } = config;
            const channel = sharedRoom(socket, peer_id);
            const target = channel && liveSessionSocket(channel, peer_id);
            if (!target) return;
            log.debug('[' + socket.id + '] relay SessionDescription to [' + peer_id + ']', {
                type: session_description.type,
            });
            target.emit('sessionDescription', {
                peer_id: socket.channels[channel].uuid,
                session_description: session_description,
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
         * 'ghost' 让阶梯继续治愈——resume 仍可能落地。
         */
        socket.on('peerPresence', async (config, ack) => {
            if (typeof ack !== 'function' || !Validate.isValidData(config)) return;
            const channel = sharedRoom(socket, config.peer_id);
            ack({ present: channel ? sessionPresence(channel, config.peer_id) : 'gone' });
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
