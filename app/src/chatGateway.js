/*
聊天 socket 域：五个聊天生命周期处理器（chat / chatPage /
chatEdit / chatDelete / chatReact），以及只有它们需要的
一切——按 socket 的限流守卫与待决图片批次组装。

实时投递仍走 DataChannel mesh 的 P2P；本网关只处理发送者的
历史存储副本与生命周期广播。这里的一切都是从 server.js
原样迁出的（纯提取——房间状态与助手经 `rooms`
注入）。
*/

'use strict';

const checkXSS = require('./xss.js');
const limits = require('./limits');
const { isImageDataUrl } = require('./payload');

/**
 * 滑动窗口限流守卫：窗口内按 key 记录时间戳，key 一旦超出预算即返回 true。
 * 聊天持久化与历史分页两条路径共用此守卫——两者每次调用都会触碰磁盘，
 * 因此脚本化客户端不允许把其中任何一条
 * 当成空转刷盘的入口。
 */
function makeRateGuard({ max, windowMs }) {
    const stamps = new Map(); // key -> 窗口内的时间戳
    const guard = (key, now = Date.now()) => {
        const list = (stamps.get(key) || []).filter((ts) => now - ts < windowMs);
        if (list.length >= max) {
            stamps.set(key, list);
            return true;
        }
        list.push(now);
        stamps.set(key, list);
        return false;
    };
    guard.forget = (key) => stamps.delete(key); // socket 已断开：丢弃其窗口
    return guard;
}

function createChatGateway({ rooms, chatStore, channelStore, audit, log }) {
    const { peers, presenters, sockets, roomSender, broadcastToRoom } = rooms;

    // 按 socket 的持久化频率：真人打字永远到不了这个量；脚本化洪泛会让历史
    // 文件膨胀（且不断重写）。实时 P2P 投递不受影响——
    // 被丢弃的只是历史副本。预算必须也覆盖图片批次
    // （1 个 head + 最多 9 个图片事件）。
    const isChatFlooded = makeRateGuard({ max: 24, windowMs: 10 * 1000 });

    // chatPage 只读但不免费（每次调用做裁剪 + 逐行载荷估算），
    // 成员同样不能空转它。比写入预算更宽松——
    // 快速滚动历史本来就会连发多页请求。
    const isChatPageFlooded = makeRateGuard({ max: 30, windowMs: 10 * 1000 });

    // 待决图片批次：已收到 head 事件、图片事件仍在到达。
    // 按 socket 为键，id 在不同发送者之间绝不可能碰撞；
    // 条目在 TTL 之后落盘（带上已到达的图片）。
    const CHAT_BATCH_TTL_MS = 30 * 1000;
    const CHAT_BATCHES_PER_SOCKET = 3;
    const chatBatches = new Map(); // socket.id -> Map(batchId -> pending)

    // 批次 TTL 必须在没有新流量时也能触发：否则图片事件永远没发完的
    // 发送者会一直把待决批次（最多 3 × ~1.6MB）占在内存里直到断开。
    // 只靠「新批次到来时顺带清扫」不足以应对
    // 一个单纯闲置下去的 socket。
    setInterval(() => {
        try {
            chatBatchSweep();
        } catch (err) {
            log.error('Chat batch sweep failed', { error: err.message });
        }
    }, 60 * 1000).unref?.();

    /** 把完成（或 TTL 到期）的批次存为一条历史行。 */
    function finalizeChatBatch(socketId, pending) {
        const stored = chatStore.append(
            pending.room_id,
            {
                name: pending.name,
                text: pending.text,
                imgs: pending.images,
                ...(pending.reply ? { reply: pending.reply } : {}),
            },
            { persistent: !channelStore.isTemp(pending.room_id) }
        );
        // 与文本路径相同的权威 ts 握手（见 chat 处理器）
        if (stored) sockets[socketId]?.emit('chatAck', { ts: stored.ts });
    }

    /** 冲刷过期的待决批次，让图片事件没发完的发送者
     *  也不至于丢掉消息的文字部分。 */
    function chatBatchSweep(now = Date.now()) {
        for (const [socketId, batches] of chatBatches) {
            for (const [batch, pending] of batches) {
                if (now - pending.ts > CHAT_BATCH_TTL_MS) {
                    batches.delete(batch);
                    finalizeChatBatch(socketId, pending);
                }
            }
            if (!batches.size) chatBatches.delete(socketId);
        }
    }

    /** 把五个聊天处理器接到新连接的 socket 上。 */
    function register(socket) {
        /**
         * 聊天持久化：DataChannel mesh 实时投递消息；发送者（SENDER）向这里
         * 中转一份副本，让它进入历史存储供迟到的加入者读取。
         * 服务器在这条路径上从不广播——只做存储。
         *
         * 带图片的提交 = 1 个 HEAD 事件（{msg, batch, imgs: count}）加
         * 每张图 1 个事件（{batch, img: dataUrl}）——每张图单独走
         * 一个事件，因为整个批次可能超过 socket.io 包上限。受洪泛门控
         * 与成员门控；内容绝不进日志。
         */
        socket.on('chat', async (cfg) => {
            const ctx = roomSender(socket, cfg, { sanitize: false }); // 图片载荷原文通过
            if (!ctx) return;
            const senderUuid = ctx.senderUuid;
            const { room_id } = ctx.config;

            if (isChatFlooded(socket.id)) {
                log.debug('[' + socket.id + '] chat dropped: flood guard', { room_id });
                return;
            }

            // 待决批次的图片部分
            if (typeof cfg.img === 'string') {
                const batch =
                    typeof cfg.batch === 'string' && cfg.batch.length <= limits.IMG_BATCH_ID_MAX ? cfg.batch : '';
                const pending = batch ? chatBatches.get(socket.id)?.get(batch) : null;
                if (!pending || pending.room_id !== room_id) return;
                // 只推送到声明数量为止，重复/多余事件无法让该行膨胀
                if (pending.images.length < pending.expected) {
                    if (isImageDataUrl(cfg.img)) pending.images.push(cfg.img);
                }
                if (pending.images.length >= pending.expected) {
                    chatBatches.get(socket.id).delete(batch);
                    finalizeChatBatch(socket.id, pending);
                }
                return;
            }

            // 纯文本发送，或图片批次的 head
            // （checkXSS 只过文本——DOMPurify 会剥掉 data: URI，所以图片
            // 载荷绝不能从它经过；与 peerAvatar 相同的拆分）
            const sanitized = checkXSS(typeof cfg.msg === 'string' ? cfg.msg : '');
            const text = typeof sanitized === 'string' ? sanitized.slice(0, limits.CHAT_TEXT_MAX) : '';
            const imageCount =
                Number.isInteger(cfg.imgs) && cfg.imgs > 0 && cfg.imgs <= limits.MAX_IMAGES_PER_MESSAGE ? cfg.imgs : 0;
            if (!text && !imageCount) return;

            const peer_name = peers[room_id]?.[senderUuid]?.peer_name; // 已 JOIN 的名字，服务端状态
            if (!peer_name) return;

            // 可选的回复引用随行（接收方渲染为引用块，并随该行一起
            // 持久化——形状校验在 chatStore.append 内统一执行）
            if (!imageCount) {
                const stored = chatStore.append(
                    room_id,
                    { name: peer_name, text, imgs: [], ...(cfg.reply ? { reply: cfg.reply } : {}) },
                    { persistent: !channelStore.isTemp(room_id) }
                );
                // 发送者已用本地时间戳渲染了自己的行；回传权威 ts，
                // 让编辑/撤回/回应能定位到那一行
                if (stored) socket.emit('chatAck', { ts: stored.ts });
                return;
            }

            const batch = typeof cfg.batch === 'string' && cfg.batch.length <= limits.IMG_BATCH_ID_MAX ? cfg.batch : '';
            if (!batch) return; // 图片批次必须携带客户端生成的 id
            chatBatchSweep();
            let batches = chatBatches.get(socket.id);
            if (!batches) {
                batches = new Map();
                chatBatches.set(socket.id, batches);
            } else if (batches.size >= CHAT_BATCHES_PER_SOCKET) {
                return; // 先完成在途批次，再开新批次
            }
            batches.set(batch, {
                room_id,
                name: peer_name,
                text,
                expected: imageCount,
                images: [],
                reply: cfg.reply ?? null, // append 落盘时统一归一化
                ts: Date.now(),
            });
        });

        /**
         * 已持久化聊天历史的向上滚动分页：客户端请求严格早于其游标
         * （`before` ts）的一页，并经 ack 拿回——请求与响应保持配对，
         * 无需任何客户端侧请求 id。只读且受成员门控；
         * 页大小由服务器固定（绝不信任客户端）。
         * 按 socket 节流：每次调用都执行一次裁剪
         * + 图片载荷估算，因此脚本化客户端
         * 绝不能空转磁盘。
         */
        socket.on('chatPage', (cfg, ack) => {
            const ctx = roomSender(socket, cfg, { sanitize: false }); // 只读：仅 before/count 字段
            if (!ctx) return;
            if (isChatPageFlooded(socket.id)) return;
            const before = Number.isFinite(ctx.config.before) && ctx.config.before > 0 ? ctx.config.before : 0;
            const page = chatStore.history(ctx.config.room_id, {
                persistent: !channelStore.isTemp(ctx.config.room_id),
                before,
            });
            if (typeof ack === 'function') ack(page);
        });

        /**
         * 投递后的消息生命周期：编辑 / 撤回 / emoji 回应。这些走 socket
         * （而非 DataChannel），让仅文字成员与中途加入者也能看到；
         * 服务器是历史存储的唯一写入者，
         * 所有人（含发送者）收到同一次广播。
         * 身份：操作者名字始终来自已 JOIN 的会话状态——
         * 因此编辑/撤回仅限于自己的行，
         * 例外是主持人可以撤回任何人的消息（管理需要）。
         */
        socket.on('chatEdit', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id } = config;
            if (isChatFlooded(socket.id)) return;

            const peer_name = peers[room_id]?.[senderUuid]?.peer_name;
            const ts = Number(config.ts);
            const text = typeof config.msg === 'string' ? config.msg.slice(0, limits.CHAT_TEXT_MAX) : '';
            if (!peer_name || !Number.isFinite(ts) || ts <= 0 || !text.trim()) return;

            const persistent = !channelStore.isTemp(room_id);
            const updated = chatStore.edit(room_id, { ts, name: peer_name, text }, { persistent });
            if (!updated) return;
            await broadcastToRoom(room_id, 'chatEdit', { ts, name: peer_name, text: updated.text });
        });

        socket.on('chatDelete', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id } = config;
            if (isChatFlooded(socket.id)) return;

            const peer_name = peers[room_id]?.[senderUuid]?.peer_name;
            const ts = Number(config.ts);
            const targetName = typeof config.name === 'string' ? config.name.slice(0, limits.PEER_NAME_MAX) : '';
            if (!peer_name || !Number.isFinite(ts) || ts <= 0 || !targetName) return;
            // 主持人可撤回任何人的消息；成员只能撤自己的
            const isPresenter = presenters[room_id]?.[senderUuid]?.is_presenter === true;
            if (targetName !== peer_name && !isPresenter) return;

            const persistent = !channelStore.isTemp(room_id);
            const updated = chatStore.remove(room_id, { ts, name: targetName }, { persistent });
            if (!updated) return;
            if (isPresenter && targetName !== peer_name) {
                audit.record('hostRecall', { channel: room_id, by: peer_name, target: targetName });
            }
            await broadcastToRoom(room_id, 'chatDelete', { ts, name: targetName, by: peer_name });
        });

        socket.on('chatReact', async (cfg) => {
            const ctx = roomSender(socket, cfg);
            if (!ctx) return;
            const { config, senderUuid } = ctx;
            const { room_id } = config;
            if (isChatFlooded(socket.id)) return;

            const peer_name = peers[room_id]?.[senderUuid]?.peer_name;
            const ts = Number(config.ts);
            const targetName = typeof config.name === 'string' ? config.name.slice(0, limits.PEER_NAME_MAX) : '';
            // checkXSS 绝不碰 emoji（DOMPurify 对非 ASCII 无标记字符串的
            // 改写虽无害，但仍像图片/emoji 路径一样保持载荷原文+上限）：
            // 改为直接做形状校验
            const emoji = typeof cfg.emoji === 'string' ? cfg.emoji.slice(0, limits.REACTION_EMOJI_MAX) : '';
            if (!peer_name || !Number.isFinite(ts) || ts <= 0 || !targetName || !emoji) return;

            const persistent = !channelStore.isTemp(room_id);
            const updated = chatStore.react(
                room_id,
                { ts, name: targetName, emoji, who: peer_name, op: cfg.op },
                { persistent }
            );
            if (!updated) return;
            await broadcastToRoom(room_id, 'chatReact', {
                ts,
                name: targetName,
                emoji,
                who: peer_name,
                reactions: updated.reactions || null,
            });
        });
    }

    /** 断开时按 socket 的清理（限流守卫 + 待决图片批次）。 */
    function onDisconnect(socket) {
        isChatFlooded.forget(socket.id); // 按 socket 的限流窗口随 socket 一起消亡
        isChatPageFlooded.forget(socket.id);
        chatBatches.delete(socket.id); // 待决图片批次随发送者一起消亡
    }

    return { register, onDisconnect };
}

module.exports = { createChatGateway };
