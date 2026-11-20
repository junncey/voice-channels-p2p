/*
信令服务器的房间状态 + 会话生命周期。

peers/presenters 以会话 uuid（join 时的 peer_uuid）为键，而不是 socket.id：
网络抖动后重连的页面带着同一 uuid 重新 join，并原地恢复（RESUME）其会话——
其他成员从未收到 removePeer，因此他们的 peer 连接保持存活，
靠 ICE restart 治愈，而不是完整重协商。
每个条目携带其绑定的 socket_id。

本模块持有内存映射、成员身份读取（公共/admin 的 peer 视图）、
房间作用域的 emit 助手，以及幽灵/会话生命周期
（挂起 → 恢复 | 过期）。store 与审计轨迹均为注入，
因此它不含任何配置装配；由 signaling.js 从 socket 协议层驱动它。
*/

'use strict';

const checkXSS = require('./xss.js');
const Validate = require('./validate');
const { toJson } = require('./payload');

// 异常断连（VPN/加速器切换、Wi-Fi 抖动、休眠）把会话挂起为幽灵（GHOST）：
// peers 条目（及主持人角色）在宽限窗口内存活，同一 uuid 可以重新 join
// 并恢复会话。只有宽限过期后，剩余成员才会收到 removePeer 广播。
// 传输层掉线通常几秒内就重连，所以窗口较短（15s）；
// ping 超时死亡则是被深度节流的后台标签页（手机锁屏）的标志性特征，
// 其唤醒需要更长的窗口才能落地，
// 由此完成一次原地恢复（resume），
// 而不是整张 mesh 重建。
const GHOST_GRACE_MS = Number(process.env.GHOST_GRACE_MS) || 15000;
const GHOST_GRACE_LATE_MS = Number(process.env.GHOST_GRACE_LATE_MS) || 30000;

function createRooms({ channelStore, chatStore, audit, log }) {
    const channels = {}; // channelId -> { socketId: socket }（活跃信令 socket）
    const sockets = {}; // socketId -> socket
    const peers = {}; // channelId -> { sessionUuid: peerInfo(+socket_id, ghost), 'lock', 'password', 'joinLock' }
    const presenters = {}; // channelId -> { sessionUuid: {peer_ip, peer_name, is_presenter} }

    const roomMetaKeys = new Set(['lock', 'password', 'joinLock']);

    const ghosts = new Map(); // ghostKey(channel, uuid) -> 过期定时器

    const ghostKey = (channel, uuid) => channel + '|' + uuid;

    function getPeerCount(roomId) {
        if (!peers[roomId]) return 0;
        return Object.keys(peers[roomId]).filter((k) => !roomMetaKeys.has(k)).length;
    }

    /** 房间的公共 peer 名单，以会话 uuid 为键（剔除房间元键）。幽灵
     *  仍留在名单里：宽限期内他们仍是成员，若在这里剔除，
     *  每个在线客户端的成员对账都会拆掉那条本可由 resume
     *  治愈的 peer 连接。 */
    function getRoomPeers(roomId) {
        const room = peers[roomId] || {};
        const list = {};
        for (const [uuid, info] of Object.entries(room)) {
            if (roomMetaKeys.has(uuid)) continue;
            list[uuid] = {
                peer_name: info.peer_name,
                peer_presenter: !!info.peer_presenter,
                peer_audio: !!info.peer_audio,
                peer_audio_status: !!info.peer_audio_status,
                peer_deafen: !!info.peer_deafen,
                peer_share: !!info.peer_share,
                peer_avatar: info.peer_avatar || null,
                joined_at: info.joined_at,
            };
        }
        return list;
    }

    /** 房间成员的 admin 视图：谁在房里、从何时起、处于何种状态
     *  （ghost = 异常断连，仍在恢复宽限窗口内）。 */
    function getRoomMembers(roomId) {
        const room = peers[roomId];
        if (!room) return [];
        return Object.entries(room)
            .filter(([uuid]) => !roomMetaKeys.has(uuid))
            .map(([uuid, info]) => ({
                uuid,
                name: info.peer_name,
                presenter: !!info.peer_presenter,
                audio: !!info.peer_audio_status,
                ghost: !!info.ghost,
                joined_at: info.joined_at || 0,
            }))
            .sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0));
    }

    /**
     * 检查某个会话 uuid 是否为指定房间已加入的成员。幽灵也算成员
     * ——他们仍在宽限窗口内。
     */
    function isPeerInRoom(room_id, peer_uuid) {
        if (!room_id || !peer_uuid || !Object.hasOwn(peers, room_id)) return false;
        // 房间元键（'lock'/'password'/'joinLock'）永远不会是成员
        return Object.hasOwn(peers[room_id], peer_uuid) && !roomMetaKeys.has(peer_uuid);
    }

    /**
     * 发送者在房间里的会话 uuid，前提是发送者确实已加入该房间
     * （服务端状态——客户端无法冒领其他会话的身份）。
     */
    function roomSessionUuid(socket, roomId) {
        const uuid = socket.channels?.[roomId]?.uuid;
        return uuid && isPeerInRoom(roomId, uuid) ? uuid : null;
    }

    /**
     * 房间作用域 socket 处理器的共享前导：清洗载荷（携带必须保持原文
     * 字段——图片、emoji——的调用方可选择退出，改为逐个清洗
     * 其文本字段）、丢弃畸形包，并解析发送者在包所指房间中
     * 已加入会话的 uuid。
     * 当数据包必须被静默丢弃时返回 null。
     */
    function roomSender(socket, raw, { sanitize = true } = {}) {
        const config = sanitize ? checkXSS(raw) : raw;
        if (!Validate.isValidData(config)) return null;
        const senderUuid = roomSessionUuid(socket, config.room_id);
        return senderUuid ? { config, senderUuid } : null;
    }

    /**
     * 发送者与目标会话 uuid 共同所在的第一个房间（中转门禁：
     * 一个 socket 只能对自己 join 过的 peer 发信令）。无关联时为 null。
     */
    function sharedRoom(socket, peerUuid) {
        if (!peerUuid || typeof peerUuid !== 'string') return null;
        for (const channel of Object.keys(socket.channels || {})) {
            if (isPeerInRoom(channel, peerUuid)) return channel;
        }
        return null;
    }

    /** 房间内某会话 uuid 的活跃 socket——幽灵/已死 socket 返回 null。 */
    function liveSessionSocket(channel, peerUuid) {
        if (!isPeerInRoom(channel, peerUuid)) return null;
        const sock = sockets[peers[channel][peerUuid].socket_id];
        return sock && sock.connected ? sock : null;
    }

    /** 客户端恢复探测的存在性判定：'live' = 可投递的会话，'ghost' =
     *  挂起在恢复宽限内（值得治愈），'gone' = 会话根本不存在
     *  （探测者错过了它的 removePeer）。'ghost' 附带 resume 宽限
     *  的剩余毫秒（graceLeftMs）——恢复引擎据此在窗口内保持
     *  等待而非升级到全量重建。 */
    function sessionPresence(channel, peerUuid) {
        if (!isPeerInRoom(channel, peerUuid)) return { present: 'gone', graceLeftMs: 0 };
        const entry = peers[channel][peerUuid];
        if (entry.ghost || !liveSessionSocket(channel, peerUuid)) {
            const graceLeftMs = entry.ghost_until ? Math.max(0, entry.ghost_until - Date.now()) : 0;
            return { present: 'ghost', graceLeftMs };
        }
        return { present: 'live', graceLeftMs: 0 };
    }

    /** 向同房间的所有 peer 异步发送数据（不含自己） */
    async function sendToRoom(room_id, socket_id, msg, config = {}) {
        // Object.hasOwn 把继承键（'constructor' 等）挡在查找之外
        const room = room_id && Object.hasOwn(channels, room_id) ? channels[room_id] : {};
        for (const [peer_id, sock] of Object.entries(room)) {
            if (peer_id !== socket_id) {
                sock.emit(msg, config);
            }
        }
    }

    /** 向房间内所有成员异步发送数据（含发送者自己）——聊天生命周期事件
     * （编辑/撤回/回应）使用：发送者的 DOM 必须与其他人一样，
     * 跟随服务器持久化后的结果。 */
    async function broadcastToRoom(room_id, msg, config = {}) {
        for (const sock of Object.values(channels[room_id] || {})) {
            sock.emit(msg, config);
        }
    }

    /** 向指定 peer 异步发送数据 */
    async function sendToPeer(peer_id, msg, config = {}) {
        if (peer_id && Object.hasOwn(sockets, peer_id)) {
            sockets[peer_id].emit(msg, config);
        }
    }

    /**
     * 把异常断连的会话挂起为幽灵：peers 条目（及主持人角色）在宽限窗口
     * 内存活，死掉的 socket 则离开投递映射。成员们保留各自的 peer
     * 连接——窗口内的 resume 靠 ICE restart 治愈它们，
     * 而不是完整重协商。
     */
    function detachAsGhost(channel, socket, reason) {
        const session = socket.channels[channel];
        const entry = session && isPeerInRoom(channel, session.uuid) ? peers[channel][session.uuid] : null;
        if (!entry) {
            // 该频道的 join 从未完成——按普通移除处理
            return removePeerFrom(channel, socket, reason);
        }
        entry.ghost = true;
        delete channels[channel]?.[socket.id];
        const delay = reason === 'ping timeout' ? GHOST_GRACE_LATE_MS : GHOST_GRACE_MS;
        // 宽限终点随条目存活：presence 探测据此告知客户端
        // 「resume 还有多久可能落地」，恢复引擎好把全量重建
        // （B1）推迟到窗口之后——resume 的原地恢复比 B1 便宜
        // 一个数量级，而 B1 是主动断开，反而毁掉 resume 通道
        entry.ghost_until = Date.now() + delay;
        const key = ghostKey(channel, session.uuid);
        clearTimeout(ghosts.get(key));
        ghosts.set(
            key,
            setTimeout(() => expireGhost(channel, session.uuid), delay)
        );
        log.debug('[' + socket.id + '] session ghosted', { channel, reason, resume_window_ms: delay });
    }

    /** 宽限过期且未恢复——会话真的离开了。 */
    function expireGhost(channel, uuid) {
        ghosts.delete(ghostKey(channel, uuid));
        const entry = Object.hasOwn(peers, channel) ? peers[channel][uuid] : null;
        if (!entry || !entry.ghost) return;
        const socketId = entry.socket_id;
        const name = entry.peer_name;
        releaseRoomEntry(channel, uuid);
        broadcastRemovePeer(channel, uuid, socketId);
        log.info('[ghost] grace expired, session removed', { channel, uuid, name });
        audit.record('ghostExpire', { channel, name });
    }

    /**
     * 丢弃会话的房间注册（peers/presenters）并清理空掉的房间。
     * 不发信令——是否广播由调用方决定。
     */
    function releaseRoomEntry(channel, uuid) {
        if (!Object.hasOwn(peers, channel)) return;
        try {
            delete peers[channel][uuid];
            delete presenters[channel]?.[uuid];

            if (getPeerCount(channel) === 0) {
                delete peers[channel];
                delete presenters[channel];
                delete channels[channel]; // 清理以防内存泄漏
                // 空的临时房间永久消失——其（仅内存的）
                // 聊天历史随之而去
                if (channelStore.removeTempIfEmpty(channel, 0)) {
                    chatStore.removeChannel(channel);
                }
            }
        } catch (err) {
            log.error('Release room entry', toJson(err));
        }
    }

    /** 向房间内剩余的所有人广播某会话的 removePeer。 */
    function broadcastRemovePeer(channel, uuid, socketId) {
        for (const [id, sock] of Object.entries(channels[channel] || {})) {
            sock.emit('removePeer', { peer_id: uuid });
            log.debug('emit removePeer [' + uuid + '] -> [' + id + ']');
        }
        if (socketId && Object.hasOwn(sockets, socketId)) {
            sockets[socketId].emit('removePeer', { peer_id: uuid });
        }
    }

    /**
     * 拆除即将被同 uuid 重连 socket 取代的会话条目：还活着的旧 socket 走
     * 正常 removePeer 路径离开；幽灵（或已死 socket）则当场过期。
     * join 处理器用它完成两类对账：
     * 既有条目的清理、
     * 以及被并发同 uuid join 抢占的槽位的回收。
     */
    async function reapSession(channel, uuid, entry) {
        const oldSocket = sockets[entry.socket_id];
        if (oldSocket && oldSocket.connected) {
            await removePeerFrom(channel, oldSocket, 'reconnected');
            return;
        }
        clearTimeout(ghosts.get(ghostKey(channel, uuid)));
        ghosts.delete(ghostKey(channel, uuid));
        releaseRoomEntry(channel, uuid);
        broadcastRemovePeer(channel, uuid, entry.socket_id);
    }

    /**
     * 把某 socket 的会话从频道移除：释放房间条目，
     * 并向房间广播 removePeer。
     * @param {string} channel 频道 ID
     * @param {object} socket 该（可能已死）成员 socket
     * @param {string} reason 断连原因（仅用于日志）
     */
    function removePeerFrom(channel, socket, reason = 'unknown') {
        const session = socket.channels[channel];
        if (!session) {
            return log.debug('[' + socket.id + '] [Warning] not in ', channel);
        }
        delete socket.channels[channel];
        delete channels[channel]?.[socket.id];
        clearTimeout(ghosts.get(ghostKey(channel, session.uuid)));
        ghosts.delete(ghostKey(channel, session.uuid));
        releaseRoomEntry(channel, session.uuid);
        broadcastRemovePeer(channel, session.uuid, socket.id);
        log.info('[leave] peer removed', {
            channel,
            reason,
            name: session.name,
            uuid: session.uuid,
            peers_left: getPeerCount(channel),
        });
        audit.record('leave', { channel, name: session.name, reason });
    }

    return {
        channels,
        sockets,
        peers,
        presenters,
        roomMetaKeys,
        ghosts,
        ghostKey,
        getPeerCount,
        getRoomPeers,
        getRoomMembers,
        isPeerInRoom,
        roomSessionUuid,
        roomSender,
        sharedRoom,
        liveSessionSocket,
        sessionPresence,
        sendToRoom,
        broadcastToRoom,
        sendToPeer,
        detachAsGhost,
        releaseRoomEntry,
        broadcastRemovePeer,
        reapSession,
        removePeerFrom,
    };
}

module.exports = { createRooms };
