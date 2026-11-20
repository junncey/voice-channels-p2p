/*
join 门禁流程：从 signaling.js 拆出的 join 处理器全流程
（身份校验 → host 认证 → 幽灵恢复/收割 → 容量/锁门禁 →
临时房物化/落座），外加按 IP 的 join 防爆破冷却与 addPeer 的
mesh 通知。signaling.js 只保留 socket 接线；join 的每一段
在此可独立阅读，步骤函数可单测。

协议与语义未变——纯提取 + 步骤命名；行为安全网是
test-server.js 的信令集成测试。
*/

'use strict';

const Validate = require('./validate');
const ChannelStore = require('./channelStore');
const limits = require('./limits');
const { sanitizeExceptSecrets, hostTokenValidFor } = require('./payload');

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

// ---------------------------------------------------------------------------
// join 流程
// ---------------------------------------------------------------------------

/**
 * 创建 join 处理器。依赖与 signaling.js 相同（经 server.js 装配注入）。
 */
function createJoinFlow({
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
}) {
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
        reapSession,
        releaseRoomEntry,
        broadcastRemovePeer,
        sendToPeer,
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

    /** 认证失败的统一出口：记日志 + 计入防爆破 + 告知客户端。 */
    function rejectJoin(socket, ip, event, extra = {}) {
        recordJoinFailure(ip);
        socket.emit(event, extra);
    }

    /**
     * 第 1 段——身份形状校验：channel id、会话 uuid、昵称。
     * 返回 { channel, peer_uuid, peer_name } 或 null（已 emit 并计数）。
     */
    function validateIdentity(socket, ip, config) {
        const { channel, peer_uuid } = config;

        if (!Validate.isValidRoomName(channel) || !channelStore.isValidId(channel)) {
            log.warn('[' + socket.id + '] invalid channel id', { channel });
            rejectJoin(socket, ip, 'unauthorized');
            return null;
        }

        // peer_uuid 成为本会话的房间状态键（resume 匹配、中转目标）
        // ——严格的 uuid 形状让它绝不可能与房间元键碰撞，
        // 也不会污染对象原型
        if (!Validate.isValidSessionUuid(peer_uuid)) {
            log.warn('[' + socket.id + '] invalid peer_uuid', { channel });
            rejectJoin(socket, ip, 'unauthorized');
            return null;
        }

        // join 名字随每条成员广播传播——要求真实字符串，
        // 并像其他所有名字路径一样设上限（peerName/peerRename
        // 以 PEER_NAME_MAX 封顶），脚本化 join 无法把
        // 一个 socket 包大小的名字塞进房间状态与成员卡片
        if (typeof config.peer_name !== 'string' || !config.peer_name.trim()) {
            log.warn('[' + socket.id + '] invalid peer_name', { channel });
            rejectJoin(socket, ip, 'unauthorized');
            return null;
        }

        return { channel, peer_uuid, peer_name: config.peer_name.slice(0, limits.PEER_NAME_MAX) };
    }

    /**
     * 第 3 段——会话恢复：携带同一 peer_uuid 的重连是本页面的会话在重连
     * （每次 join() 都铸造新 uuid）。当上个 socket 的条目仍在幽灵宽限
     * 窗口内时，把它重绑（REBIND）到新 socket 并保留会话——其他成员
     * 从未见过 removePeer，他们的 peer 连接保持在线，经 ICE restart
     * 治愈而非完整重协商。改名、或旧 socket 仍然活着，都不算恢复：
     * 逐出旧会话并重建。（绝不会匹配第二个标签页——它有自己的 uuid。）
     * 返回 { is_rejoin, resumed, keepJoinedAt }。
     */
    async function resumeOrReap(channel, peer_uuid, peer_name, socket) {
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
                delete existingEntry.ghost_until; // 宽限随 resume 结束（presence 探测不再报告它）
                existingEntry.socket_id = socket.id;
                log.debug('[' + socket.id + '] session resumed in grace window', { channel });
            } else {
                is_rejoin = nameMatches; // 同一会话带着活 socket 回归：容量/锁定检查的绕过与恢复保持一致
                await reapSession(channel, peer_uuid, existingEntry);
                log.debug('[' + socket.id + '] reaped stale session on rejoin', { channel, resumed: false });
            }
        }
        return { is_rejoin, resumed, keepJoinedAt };
    }

    /**
     * 第 5 段——物化待决的临时房间。被拒绝的 join 绝不会生成
     * （并随后泄漏）一个空房间：只有在全部认证检查通过后才创建
     * （getOrCreateTemp 在全局/按 IP 上限处返回 null）。
     * 返回频道定义或 null（已 emit）。
     */
    function materializeTemp(socket, ip, channel) {
        if (channelStore.getTemp(channel)) {
            // 加入别人已生成的房间：不创建、不计配额
            return channelStore.getTemp(channel);
        }
        const quota = channelStore.checkTempQuota(ip);
        if (!quota.ok) {
            log.warn('[' + socket.id + '] temp room quota exceeded', { channel, reason: quota.reason });
            socket.emit('tempRoomLimitReached', {
                reason: quota.reason,
                max: channelStore.settings.tempMaxPerIp,
            });
            return null;
        }
        const def = channelStore.getOrCreateTemp(channel, { creatorIp: ip });
        if (!def) {
            log.warn('[' + socket.id + '] temp room cap reached', { channel });
            socket.emit('channelNotFound');
            return null;
        }
        return def;
    }

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

    /**
     * join 的完整流程（含失败回滚）。房间状态写入后设置 claimed，
     * 让 catch 能把半加入的 socket 回滚掉（若并发同 uuid join 已占有
     * 该槽位，则跳过回滚）。
     */
    async function handleJoin(socket, cfg) {
        let claimed = null;
        const run = async () => {
            const peer_ip = getSocketIP(socket);
            // channel_password 保持原文——它走哈希校验，清洗器会
            // 静默改变实际生效的密钥（修复前的存量哈希经
            // channelStore 的 verifyPasswordCompat 回退继续通过校验）
            const config = sanitizeExceptSecrets(cfg, ['channel_password']);

            if (!Validate.isValidData(config)) return;
            // 绝不记录凭证（host JWT / 房间密码）
            const { peer_token, channel_password, ...joinLogData } = config;
            log.debug('[' + socket.id + '] join', joinLogData);

            // 防爆破守卫：连续 join 认证失败过多的来源，
            // 在冷却窗口内被忽略。丢弃会明确告知客户端
            // （retryAfter 秒）——否则共享 NAT 后面
            // 误触计数器的合法用户，
            // 会一直等待一个永远不会来的 serverInfo
            if (isJoinThrottled(peer_ip)) {
                log.warn('[' + socket.id + '] join dropped: auth-failure cooldown', { channel: config.channel });
                return socket.emit('joinThrottled', {
                    retryAfter: Math.ceil(joinThrottleRemainingMs(peer_ip) / 1000),
                });
            }

            // —— 第 1 段：身份形状 ——
            const identity = validateIdentity(socket, peer_ip, config);
            if (!identity) return;
            const { channel, peer_uuid, peer_name } = identity;

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
            // 到所有认证检查通过之后（见 materializeTemp）。
            let channelDef = channelStore.get(channel);
            const wouldCreateTemp = !channelDef && tempRoomsEnabled();
            if (!channelDef && !wouldCreateTemp) {
                log.warn('[' + socket.id + '] channel not found in registry', { channel });
                return socket.emit('channelNotFound');
            }

            // —— 第 2 段：host 认证 ——
            // 主持人：为本频道签发的有效 host JWT，且该 host 必须仍在
            // 配置中（token 可能早于配置变更）。复查策略与 host 导出
            // 端点共用（payload.hostTokenValidFor）。
            let is_presenter = false;
            if (peer_token) {
                const payload = verifyConsoleToken(peer_token);
                if (hostTokenValidFor(payload, channel, { channelsCfg, channelStore })) {
                    is_presenter = true;
                    log.debug('[' + socket.id + '] joining as host', {
                        channel,
                        username: payload.username,
                        via: payload.via || 'configured',
                    });
                } else {
                    log.warn('[' + socket.id + '] invalid host token for channel', { channel });
                    return rejectJoin(socket, peer_ip, 'unauthorized');
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
                return rejectJoin(socket, peer_ip, 'channelPasswordRequired');
            }

            // —— 第 3 段：幽灵恢复 / 收割 ——
            const { is_rejoin, resumed, keepJoinedAt } = await resumeOrReap(channel, peer_uuid, peer_name, socket);

            // —— 第 4 段：容量/锁门禁 ——
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
                peers[channel]?.['lock'] === true && !safeEqualStrings(peers[channel]?.['password'], channel_password);
            if (roomLocked) {
                log.debug('[' + socket.id + '] [Warning] room is locked', { channel });
                return rejectJoin(socket, peer_ip, 'roomIsLocked');
            }

            const isPresenterNow = is_presenter || presenters[channel]?.[peer_uuid]?.is_presenter === true;

            // 房间级 join 锁只拦新加入者——重连的成员
            // （同 uuid，上面已恢复或已收割）本来就在房里。
            const joinLocked = peers[channel]?.['joinLock'] === true && !is_rejoin && !isPresenterNow;
            if (joinLocked) {
                log.debug('[' + socket.id + '] [Warning] room is join-locked', { channel });
                return socket.emit('roomIsJoinLocked');
            }

            // —— 第 5 段：物化临时房 + 落座 ——
            // 认证已过——现在才实体化待决的临时房间
            if (!channelDef) channelDef = materializeTemp(socket, peer_ip, channel);
            if (!channelDef) return;

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
                ip: peer_ip,
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
            await sendToPeer(socket.id, 'chatHistory', chatPage);

            // Send room info to the joined peer
            await sendToPeer(socket.id, 'serverInfo', {
                peers_count: getPeerCount(channel),
                peers: getRoomPeers(channel),
                is_presenter: isPresenter,
                join_locked: peers[channel]['joinLock'] === true,
                room_locked: peers[channel]['lock'] === true,
                maxRoomParticipants: maxParticipants,
            });
        };

        try {
            await run();
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
    }

    return { handleJoin };
}

module.exports = { createJoinFlow };
