/*
Socket.IO 信令——mesh P2P 协议核心（协议未变）。

join → addPeer → relaySDP/relayICE → removePeer，外加房间作用域的
peer 事件中转。join 路径强制执行会话 uuid 身份模型，以及
rooms.js 里实现的幽灵/恢复语义。这里的一切都是从
server.js 原样迁出的（纯提取——房间状态经 `rooms`、
聊天处理器经 `chatGateway` 注入）。
*/

'use strict';

const Validate = require('./validate');
const ChannelStore = require('./channelStore');
const limits = require('./limits');
const { sanitizeExceptSecrets, toJson } = require('./payload');

// ---------------------------------------------------------------------------
// join 认证冷却（防爆破守卫）
// ---------------------------------------------------------------------------

// 按客户端 IP 计的连续 join 认证失败（无效 id、坏/缺失的 host token、
// 频道或房间密码错误）。按 IP 为键，而不是 socket.id：
// 重连的客户端会铸造全新 socket（和全新计数器），
// 旧的按 socket 限制形同虚设。达到 JOIN_FAIL_LIMIT 后，
// 该 IP 的后续 join 在 JOIN_FAIL_COOLDOWN_MS 内被忽略——
// join 路径绝不能变成密码爆破的神谕。计数器在 join 成功时重置；
// 上限高于旧的按 socket 5 次，一个 NAT 家庭集体打错同一个密码
// 也不会把自己锁在外面。
const JOIN_FAIL_LIMIT = 10;
const JOIN_FAIL_COOLDOWN_MS = 60 * 1000;
const JOIN_FAIL_SWEEP_AT = 1024;
const joinFailures = new Map(); // 归一化 ip -> { count, ts }（ts = 最后一次失败）

function joinFailKey(ip) {
    // 归一化，让同一 /64 内的 IPv6 轮换无法铸造新计数器
    return ChannelStore.normalizeIp(ip) || String(ip || '');
}

function isJoinThrottled(ip) {
    return joinThrottleRemainingMs(ip) > 0;
}

/** 该来源 join 冷却的剩余毫秒数（0 = 可自由尝试）。
 *  兼作 joinThrottled 事件的载荷，让客户端能区分
 *  「被拒」与「丢失」，并精确退避到秒。 */
function joinThrottleRemainingMs(ip) {
    const entry = joinFailures.get(joinFailKey(ip));
    if (!entry || entry.count < JOIN_FAIL_LIMIT) return 0;
    // 窗口从最后一次失败起算；一旦流逝，该来源获得全新尝试
    // （新失败会重新武装冷却）
    return Math.max(0, JOIN_FAIL_COOLDOWN_MS - (Date.now() - entry.ts));
}

function recordJoinFailure(ip) {
    const key = joinFailKey(ip);
    const entry = joinFailures.get(key) || { count: 0, ts: 0 };
    entry.count++;
    entry.ts = Date.now();
    joinFailures.set(key, entry);
    // 一去不回的 IP 绝不能永远累积
    if (joinFailures.size > JOIN_FAIL_SWEEP_AT) {
        const now = Date.now();
        for (const [stale, e] of joinFailures) {
            if (e.count < JOIN_FAIL_LIMIT || now - e.ts >= JOIN_FAIL_COOLDOWN_MS) joinFailures.delete(stale);
        }
    }
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
        roomMetaKeys,
        ghosts,
        ghostKey,
        getPeerCount,
        getRoomPeers,
        isPeerInRoom,
        roomSessionUuid,
        roomSender,
        sharedRoom,
        liveSessionSocket,
        sessionPresence,
        sendToRoom,
        sendToPeer,
        reapSession,
        releaseRoomEntry,
        broadcastRemovePeer,
        detachAsGhost,
        removePeerFrom,
    } = rooms;

    function getSocketIP(socket) {
        if (trustProxy) {
            // Node 会把进来的头名转小写——
            // 之前的驼峰查找是死代码
            const forwarded = socket.handshake.headers['x-forwarded-for'];
            if (forwarded) return forwarded.split(',')[0].trim();
        }
        return socket.handshake.address;
    }

    io.sockets.on('connect', async (socket) => {
        log.debug('[' + socket.id + '] connection accepted', {
            host: socket.handshake.headers.host.split(':')[0],
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

        /**
         * peer join 时——频道必须存在于持久注册表。
         * 主持人权限只来自该频道的有效 host JWT。
         */
        socket.on('join', async (cfg) => {
            // 房间状态写入后设置，让下面的 catch 能把半加入的
            // socket 回滚掉（若并发同 uuid join 已占有该槽位，
            // 则跳过回滚）
            let claimed = null;
            const handleJoin = async () => {
                const peer_ip = getSocketIP(socket);
                // channel_password 保持原文——它走哈希校验，清洗器会
                // 静默改变实际生效的密钥（修复前的存量哈希经
                // channelStore 的 verifyPasswordCompat 回退继续通过校验）
                const config = sanitizeExceptSecrets(cfg, ['channel_password']);

                if (!Validate.isValidData(config)) return;
                // 绝不记录凭证（host JWT / 房间密码）
                const { peer_token, channel_password, ...joinLogData } = config;
                log.debug('[' + socket.id + '] join', joinLogData);

                const { channel, peer_uuid } = config;

                // 防爆破守卫：连续 join 认证失败过多的来源，
                // 在冷却窗口内被忽略。丢弃会明确告知客户端
                // （retryAfter 秒）——否则共享 NAT 后面
                // 误触计数器的合法用户，
                // 会一直等待一个永远不会来的 serverInfo
                if (isJoinThrottled(peer_ip)) {
                    log.warn('[' + socket.id + '] join dropped: auth-failure cooldown', { channel });
                    return socket.emit('joinThrottled', {
                        retryAfter: Math.ceil(joinThrottleRemainingMs(peer_ip) / 1000),
                    });
                }

                if (!Validate.isValidRoomName(channel) || !channelStore.isValidId(channel)) {
                    log.warn('[' + socket.id + '] invalid channel id', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('unauthorized');
                }

                // peer_uuid 成为本会话的房间状态键（resume 匹配、中转目标）
                // ——严格的 uuid 形状让它绝不可能与房间元键碰撞，
                // 也不会污染对象原型
                if (!Validate.isValidSessionUuid(peer_uuid)) {
                    log.warn('[' + socket.id + '] invalid peer_uuid', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('unauthorized');
                }

                // join 名字随每条成员广播传播——要求真实字符串，
                // 并像其他所有名字路径一样设上限（peerName/peerRename
                // 以 PEER_NAME_MAX 封顶），脚本化 join 无法把
                // 一个 socket 包大小的名字塞进房间状态与成员卡片
                if (typeof config.peer_name !== 'string' || !config.peer_name.trim()) {
                    log.warn('[' + socket.id + '] invalid peer_name', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('unauthorized');
                }
                const peer_name = config.peer_name.slice(0, limits.PEER_NAME_MAX);

                if (Object.hasOwn(socket.channels, channel)) {
                    return log.debug('[' + socket.id + '] [Warning] already joined', channel);
                }

                // 一个页面 = 一个频道；同时把玩多个活跃频道的 socket
                // 是脚本化客户端，不是浏览器访客（admin 可调：
                // settings.socketMaxChannels）
                const socketMaxChannels = channelStore.settings.socketMaxChannels;
                if (Object.keys(socket.channels).length >= socketMaxChannels) {
                    log.warn('[' + socket.id + '] socket channel limit reached', {
                        channel,
                        joined: Object.keys(socket.channels),
                    });
                    return socket.emit('channelLimitReached', { max: socketMaxChannels });
                }

                // 频道必须已注册——或在临时房间开启时，任何合法 id
                // 都可能成为临时的内存房间。临时房间的创建被推迟
                // 到所有认证检查通过之后，被拒绝的 join（坏 token/密码）
                // 绝不可能生成（并随后泄漏）一个空房间。
                let channelDef = channelStore.get(channel);
                const wouldCreateTemp = !channelDef && tempRoomsEnabled();
                if (!channelDef && !wouldCreateTemp) {
                    log.warn('[' + socket.id + '] channel not found in registry', { channel });
                    return socket.emit('channelNotFound');
                }

                // 主持人：为本频道签发的有效 host JWT，且该 host 必须仍在
                // 配置中（token 可能早于配置变更）。回退 token
                // （via: 'default-moderator'，由 host 登录为未配置 hosts 的
                // 频道签发）仅在频道仍无主
                // 且共享 default-moderator 功能开启时保持有效。
                let is_presenter = false;
                if (peer_token) {
                    const payload = verifyConsoleToken(peer_token);
                    const fallbackModeratorOk =
                        payload?.via === 'default-moderator' &&
                        Boolean(channelsCfg.defaultModerator) &&
                        channelStore.isHostless(channel);
                    if (
                        payload &&
                        payload.role === 'host' &&
                        payload.channelId === channel &&
                        payload.username &&
                        (channelStore.isHost(channel, payload.username) || fallbackModeratorOk)
                    ) {
                        is_presenter = true;
                        log.debug('[' + socket.id + '] joining as host', {
                            channel,
                            username: payload.username,
                            via: payload.via || 'configured',
                        });
                    } else {
                        log.warn('[' + socket.id + '] invalid host token for channel', { channel });
                        recordJoinFailure(peer_ip);
                        return socket.emit('unauthorized');
                    }
                }

                // 持久化频道密码（在 admin 后台设置）。host 用自己的
                // 凭证认证，总是通过。待决的临时房间（channelDef 仍为 null）
                // 还没有密码。
                // 校验是异步的（线程池 scrypt）——
                // 错误密码的 join 洪泛绝不能卡住事件循环。
                if (
                    !is_presenter &&
                    channelDef?.passwordHash &&
                    !(await channelStore.verifyChannelPassword(channel, channel_password))
                ) {
                    log.debug('[' + socket.id + '] [Warning] channel password required/invalid', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('channelPasswordRequired');
                }

                // 会话恢复：携带同一 peer_uuid 的重连是本页面的会话在重连
                // （每次 join() 都铸造新 uuid）。当上个 socket 的条目仍在
                // 幽灵宽限窗口内时，把它重绑（REBIND）到新 socket 并保留会话
                // ——其他成员从未见过 removePeer，他们的 peer 连接保持在线，
                // 经 ICE restart 治愈而非完整重协商。
                // 改名、或旧 socket 仍然活着，都不算恢复：
                // 逐出旧会话并重建。
                // （绝不会匹配第二个标签页——它有自己的 uuid。）
                let is_rejoin = false;
                let resumed = false;
                let keepJoinedAt = Date.now();
                const existingEntry = Object.hasOwn(peers, channel) ? peers[channel][peer_uuid] : null;
                if (existingEntry && !roomMetaKeys.has(peer_uuid)) {
                    const nameMatches = existingEntry.peer_name === peer_name;
                    if (existingEntry.ghost && nameMatches) {
                        is_rejoin = true;
                        resumed = true;
                        keepJoinedAt = existingEntry.joined_at;
                        clearTimeout(ghosts.get(ghostKey(channel, peer_uuid)));
                        ghosts.delete(ghostKey(channel, peer_uuid));
                        delete channels[channel]?.[existingEntry.socket_id];
                        if (sockets[existingEntry.socket_id]) delete sockets[existingEntry.socket_id].channels[channel]; // 死 socket 的簿记清理
                        existingEntry.ghost = false;
                        existingEntry.socket_id = socket.id;
                        log.debug('[' + socket.id + '] session resumed in grace window', { channel });
                    } else {
                        is_rejoin = nameMatches; // 同一会话带着活 socket 回归：容量/锁定检查的绕过与恢复保持一致
                        await reapSession(channel, peer_uuid, existingEntry);
                        log.debug('[' + socket.id + '] reaped stale session on rejoin', { channel, resumed: false });
                    }
                }

                // 容量硬检查（host 总是可以加入以管理自己的频道）
                const maxParticipants = channelDef?.maxParticipants || limits.DEFAULT_MAX_PARTICIPANTS;
                if (!is_presenter && !is_rejoin && getPeerCount(channel) >= maxParticipants) {
                    log.debug('[' + socket.id + '] channel is full', {
                        channel,
                        count: getPeerCount(channel),
                        maxParticipants,
                    });
                    return socket.emit('roomIsBusy', { maxParticipants });
                }

                // 房间级锁定（在任何房间结构创建之前读取，
                // 被拒绝的 join 绝不会留下空房间）。房间密码由 roomAction
                // 原文存储，并在此原文比对。
                const roomLocked =
                    peers[channel]?.['lock'] === true &&
                    !safeEqualStrings(peers[channel]?.['password'], channel_password);
                if (roomLocked) {
                    log.debug('[' + socket.id + '] [Warning] room is locked', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('roomIsLocked');
                }

                const isPresenterNow = is_presenter || presenters[channel]?.[peer_uuid]?.is_presenter === true;

                // 房间级 join 锁只拦新加入者——重连的成员
                // （同 uuid，上面已恢复或已收割）本来就在房里。
                const joinLocked = peers[channel]?.['joinLock'] === true && !is_rejoin && !isPresenterNow;
                if (joinLocked) {
                    log.debug('[' + socket.id + '] [Warning] room is join-locked', { channel });
                    return socket.emit('roomIsJoinLocked');
                }

                // 认证已过——现在才实体化待决的临时房间，
                // 被拒绝的 join 绝不会留下一个（getOrCreateTemp 在全局/
                // 按 IP 上限处返回 null）
                if (!channelDef) {
                    if (channelStore.getTemp(channel)) {
                        // 加入别人已生成的房间：不创建、不计配额
                    } else {
                        const quota = channelStore.checkTempQuota(peer_ip);
                        if (!quota.ok) {
                            log.warn('[' + socket.id + '] temp room quota exceeded', { channel, reason: quota.reason });
                            return socket.emit('tempRoomLimitReached', {
                                reason: quota.reason,
                                max: channelStore.settings.tempMaxPerIp,
                            });
                        }
                        channelDef = channelStore.getOrCreateTemp(channel, { creatorIp: peer_ip });
                        if (!channelDef) {
                            log.warn('[' + socket.id + '] temp room cap reached', { channel });
                            return socket.emit('channelNotFound');
                        }
                    }
                }

                // 认证已过——现在创建房间结构是安全的
                if (!Object.hasOwn(channels, channel)) channels[channel] = {};
                if (!Object.hasOwn(peers, channel)) peers[channel] = {};
                if (!Object.hasOwn(presenters, channel)) presenters[channel] = {};

                if (is_presenter) {
                    // 以会话 uuid 为键：主持人角色跨重连存活
                    // （幽灵宽限保住条目），且只能由在 join 时出示了
                    // 有效 host 凭证的会话持有
                    presenters[channel][peer_uuid] = { peer_ip, peer_name, is_presenter: true };
                    log.debug('[' + socket.id + '] joining as host', {
                        channel,
                        username: peer_name,
                    });
                }

                const isPresenter = isPresenterNow;

                peers[channel][peer_uuid] = {
                    peer_name: peer_name,
                    peer_presenter: isPresenter,
                    peer_audio: config.peer_audio === true,
                    peer_audio_status: config.peer_audio === true,
                    joined_at: keepJoinedAt,
                    socket_id: socket.id,
                    ghost: false,
                };
                claimed = { channel, uuid: peer_uuid };

                await addPeerTo(channel, socket, peer_uuid, { rejoin: resumed });

                // 同 uuid 竞态：addPeerTo 等待期间，并发 join 可能已占有
                // （或收割并替换）该槽位。若 uuid 不再指向本 socket，
                // 则另一个会话赢了——不碰房间状态，直接退场。
                // mesh 会自愈：peer 连接以 uuid 为键，
                // 赢家的 addPeer 会取代我们的。
                if (peers[channel]?.[peer_uuid]?.socket_id !== socket.id) {
                    claimed = null;
                    log.warn('[' + socket.id + '] concurrent same-uuid join lost the race, standing down', { channel });
                    return socket.emit('kickOut', { peer_kicked_reason: 'session superseded' });
                }

                channels[channel][socket.id] = socket;
                socket.channels[channel] = { uuid: peer_uuid, name: peer_name };

                // info（而非 debug）：成员变动是运维必须能从默认日志
                // 重建的唯一一件事，外加审计轨迹
                log.info('[join] peer joined', {
                    channel,
                    name: peer_name,
                    uuid: peer_uuid,
                    presenter: isPresenter,
                    resumed,
                    peers: getPeerCount(channel),
                });
                audit.record('join', {
                    channel,
                    name: peer_name,
                    presenter: isPresenter,
                    resumed,
                    ip: getSocketIP(socket),
                });

                joinFailures.delete(joinFailKey(peer_ip)); // join 成功即重置失败计数器

                // 在 serverInfo 之前给新来者补发已持久化的聊天历史，
                // 让它渲染在「你已加入」一行之上。每次（重）join 都发送
                // ——可能为空——客户端每次 join 恰好看到一个块，
                // 重连后可以忽略重放。只随行最新一页；
                // 旧页由客户端滚到顶部时经 'chatPage' 回拉。
                // chatStore.history() 同时应用页大小与载荷预算，
                // 并报告 hasMore。
                const chatPage = chatStore.history(channel, { persistent: !channelStore.isTemp(channel) });
                await sendToPeer(socket.id, sockets, 'chatHistory', chatPage);

                // Send room info to the joined peer
                await sendToPeer(socket.id, sockets, 'serverInfo', {
                    peers_count: getPeerCount(channel),
                    peers: getRoomPeers(channel),
                    is_presenter: isPresenter,
                    join_locked: peers[channel]['joinLock'] === true,
                    room_locked: peers[channel]['lock'] === true,
                    maxRoomParticipants: maxParticipants,
                });
            };

            try {
                await handleJoin();
            } catch (err) {
                // 失败的 join 绝不能留下建了一半的房间状态（全局
                // unhandledRejection 安全网只记日志）——告知客户端，
                // 并回滚本次 join 占有的一切
                log.error('Join handler failed', { socket_id: socket.id, error: err.message, stack: err.stack });
                if (
                    claimed &&
                    Object.hasOwn(peers, claimed.channel) &&
                    peers[claimed.channel][claimed.uuid]?.socket_id === socket.id
                ) {
                    delete socket.channels[claimed.channel];
                    delete channels[claimed.channel]?.[socket.id];
                    releaseRoomEntry(claimed.channel, claimed.uuid);
                    broadcastRemovePeer(claimed.channel, claimed.uuid, socket.id);
                    log.warn('Join rolled back after handler error', { channel: claimed.channel, uuid: claimed.uuid });
                }
                socket.emit('joinError', { error: 'join failed' });
            }
        });

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
            // 与 join 路径相同的 24 字符上限（见 handleJoin）
            const peer_name_new =
                typeof config.peer_name_new === 'string'
                    ? config.peer_name_new.slice(0, limits.PEER_NAME_MAX)
                    : config.peer_name_new;

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

            const valid =
                typeof avatar === 'string' &&
                avatar.length > 0 &&
                avatar.length <= limits.AVATAR_MAX_CHARS &&
                limits.IMAGE_DATA_URL_RE.test(avatar);
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

        /**
         * 把 peer 加入频道（mesh：通知每个既有 peer + 新来者）。
         * peer id 是会话 uuid——resume 时双方早已持有 peer 连接
         * （客户端的 mesh.addPeer 对已知 id 空操作），
         * 因此这只花一个同步事件，不是重协商。
         * @param {string} channel 频道 ID
         * @param {object} joiner 加入的 socket
         * @param {string} joinerUuid 其会话 uuid
         * @param {object} [opts] { rejoin }——true 时抑制客户端侧的加入宣告
         */
        async function addPeerTo(channel, joiner, joinerUuid, { rejoin = false } = {}) {
            const roomPeers = getRoomPeers(channel);
            for (const [id, sock] of Object.entries(channels[channel] || {})) {
                if (id === joiner.id) continue; // 新来者在下方会被告知所有人
                const memberUuid = sock.channels?.[channel]?.uuid;
                if (!memberUuid || memberUuid === joinerUuid) continue;
                sock.emit('addPeer', {
                    peer_id: joinerUuid,
                    peers: roomPeers,
                    should_create_offer: false,
                    rejoin,
                    iceServers: getIceServers(),
                });
                joiner.emit('addPeer', {
                    peer_id: memberUuid,
                    peers: roomPeers,
                    should_create_offer: true,
                    rejoin,
                    iceServers: getIceServers(),
                });
                log.debug('[' + joiner.id + '] emit addPeer [' + memberUuid + ']');
            }
        }
    });
}

module.exports = { registerSignaling };
