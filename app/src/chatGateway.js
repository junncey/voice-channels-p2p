/*
Chat socket domain: the five chat lifecycle handlers (chat / chatPage /
chatEdit / chatDelete / chatReact) plus everything only they need — the
per-socket rate guards and the pending image-batch assembly.

Live delivery stays P2P over the DataChannel mesh; this gateway only handles
the sender's history-store copy and the lifecycle broadcasts. Everything here
moved out of server.js verbatim (pure extraction — room state and helpers are
injected via `rooms`).
*/

'use strict';

const checkXSS = require('./xss.js');
const limits = require('./limits');

/**
 * Sliding-window rate guard: timestamps per key inside the window, true once
 * the key is over its budget. Shared by the chat persistence and the history
 * pagination paths — both touch disk per call, so a scripted client must not
 * be able to spin either.
 */
function makeRateGuard({ max, windowMs }) {
    const stamps = new Map(); // key -> timestamps inside the window
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
    guard.forget = (key) => stamps.delete(key); // socket gone: drop its window
    return guard;
}

function createChatGateway({ rooms, chatStore, channelStore, audit, log }) {
    const { peers, presenters, sockets, roomSender, broadcastToRoom } = rooms;

    // Per-socket persistence rate: human typing never approaches this; a scripted
    // flood would grow (and constantly rewrite) the history files. The live P2P
    // delivery is unaffected — only the history copy is dropped. The budget must
    // cover image batches too (1 head + up to 9 image events).
    const isChatFlooded = makeRateGuard({ max: 24, windowMs: 10 * 1000 });

    // chatPage is read-only but not free (prune + per-row payload estimate per
    // call), so a member cannot spin it either. Looser than the write budget —
    // a fast scroll through history legitimately fires bursts of pages.
    const isChatPageFlooded = makeRateGuard({ max: 30, windowMs: 10 * 1000 });

    // Pending image batches: head event received, image events still arriving.
    // Keyed per socket so ids can never collide across senders; entries flush
    // (with whatever images arrived) after the TTL.
    const CHAT_BATCH_TTL_MS = 30 * 1000;
    const CHAT_BATCHES_PER_SOCKET = 3;
    const chatBatches = new Map(); // socket.id -> Map(batchId -> pending)

    // The batch TTL must also fire without new traffic: a sender whose image
    // events never completed would otherwise hold its pending batches (up to
    // 3 × ~1.6MB) in memory until it disconnects. The sweep-on-new-batch alone
    // is not enough for a socket that simply goes idle.
    setInterval(() => {
        try {
            chatBatchSweep();
        } catch (err) {
            log.error('Chat batch sweep failed', { error: err.message });
        }
    }, 60 * 1000).unref?.();

    function sanitizeChatImage(url) {
        return typeof url === 'string' &&
            url.length > 0 &&
            url.length <= limits.IMAGE_MAX_CHARS &&
            limits.IMAGE_DATA_URL_RE.test(url)
            ? url
            : '';
    }

    /** Optional reply-quote payload on a chat event: strict shape, tiny caps. */
    function sanitizeChatReply(reply) {
        if (!reply || typeof reply !== 'object') return null;
        const name = typeof reply.name === 'string' ? reply.name.slice(0, limits.PEER_NAME_MAX) : '';
        const text = typeof reply.text === 'string' ? reply.text.slice(0, limits.REPLY_TEXT_MAX) : '';
        const ts = Number(reply.ts);
        if (!name || !text || !Number.isFinite(ts) || ts <= 0) return null;
        return { name, text, ts };
    }

    /** Store a completed (or TTL-expired) batch as one history row. */
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
        // same authoritative-ts handshake as the text path (see the chat handler)
        if (stored) sockets[socketId]?.emit('chatAck', { ts: stored.ts });
    }

    /** Flush expired pending batches so a sender whose image events never
     * completed doesn't lose the text of the message. */
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

    /** Wire the five chat handlers onto a freshly connected socket. */
    function register(socket) {
        /**
         * Chat persistence: the DataChannel mesh delivers messages live; the
         * SENDER relays a copy here so it lands in the history store for late
         * joiners. The server never broadcasts on this path — storage only.
         *
         * A submit with images = one HEAD event ({msg, batch, imgs: count}) plus
         * one event per image ({batch, img: dataUrl}) — each image rides alone
         * because a whole batch can exceed the socket.io packet cap. Flood-gated
         * and member-gated; contents are never logged.
         */
        socket.on('chat', async (cfg) => {
            const ctx = roomSender(socket, cfg, { sanitize: false }); // image payloads ride raw
            if (!ctx) return;
            const senderUuid = ctx.senderUuid;
            const { room_id } = ctx.config;

            if (isChatFlooded(socket.id)) {
                log.debug('[' + socket.id + '] chat dropped: flood guard', { room_id });
                return;
            }

            // image part of a pending batch
            if (typeof cfg.img === 'string') {
                const batch = typeof cfg.batch === 'string' && cfg.batch.length <= 64 ? cfg.batch : '';
                const pending = batch ? chatBatches.get(socket.id)?.get(batch) : null;
                if (!pending || pending.room_id !== room_id) return;
                // push only up to the announced count so duplicate/extra events can't bloat the row
                if (pending.images.length < pending.expected) {
                    const image = sanitizeChatImage(cfg.img);
                    if (image) pending.images.push(image);
                }
                if (pending.images.length >= pending.expected) {
                    chatBatches.get(socket.id).delete(batch);
                    finalizeChatBatch(socket.id, pending);
                }
                return;
            }

            // text-only send, or the head of an image batch
            // (checkXSS on the text ONLY — DOMPurify strips data: URIs, so image
            // payloads must never ride through it; same split as peerAvatar)
            const sanitized = checkXSS(typeof cfg.msg === 'string' ? cfg.msg : '');
            const text = typeof sanitized === 'string' ? sanitized.slice(0, limits.CHAT_TEXT_MAX) : '';
            const imageCount = Number.isInteger(cfg.imgs) && cfg.imgs > 0 && cfg.imgs <= 9 ? cfg.imgs : 0;
            if (!text && !imageCount) return;

            const peer_name = peers[room_id]?.[senderUuid]?.peer_name; // the JOINED name, server-side state
            if (!peer_name) return;

            // optional reply quote riding along (rendered as a quote block by the
            // receiver and persisted with the row)
            const reply = sanitizeChatReply(cfg.reply);
            if (!imageCount) {
                const stored = chatStore.append(
                    room_id,
                    { name: peer_name, text, imgs: [], ...(reply ? { reply } : {}) },
                    { persistent: !channelStore.isTemp(room_id) }
                );
                // the sender rendered its own row with a local timestamp; hand back
                // the authoritative ts so edit/recall/reaction can find that row
                if (stored) socket.emit('chatAck', { ts: stored.ts });
                return;
            }

            const batch = typeof cfg.batch === 'string' && cfg.batch.length <= 64 ? cfg.batch : '';
            if (!batch) return; // image batches must carry a client-generated id
            chatBatchSweep();
            let batches = chatBatches.get(socket.id);
            if (!batches) {
                batches = new Map();
                chatBatches.set(socket.id, batches);
            } else if (batches.size >= CHAT_BATCHES_PER_SOCKET) {
                return; // finish what's in flight before opening another batch
            }
            batches.set(batch, {
                room_id,
                name: peer_name,
                text,
                expected: imageCount,
                images: [],
                reply,
                ts: Date.now(),
            });
        });

        /**
         * Scroll-up pagination for the persisted chat history: the client asks
         * for the page strictly older than its cursor (`before` ts) and gets it
         * back on the ack — request and response stay paired without any
         * client-side request ids. Read-only and member-gated; the page size is
         * server-fixed (never trusted from the client). Throttled per socket:
         * every call runs a prune + image-payload estimate, so a scripted client
         * must not be able to spin the disk.
         */
        socket.on('chatPage', (cfg, ack) => {
            const ctx = roomSender(socket, cfg, { sanitize: false }); // read-only: only before/count fields
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
         * Message lifecycle after delivery: edit / recall / emoji reaction. These
         * ride the socket (not the DataChannel) so text-only members and
         * mid-session joiners see them too; the server is the single writer of
         * the history store, everyone (sender included) gets one broadcast.
         * Identity: the acting name always comes from the JOINED session state —
         * edits/recalls are therefore limited to one's own rows, except that a
         * presenter may recall anything (moderation).
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
            // presenters may recall anyone's message; members only their own
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
            // checkXSS never sees the emoji (DOMPurify would mangle non-ASCII
            // markup-free strings harmlessly, but keep the payload raw + capped
            // like the image/emoji paths): shape-check it directly instead
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

    /** Per-socket cleanup on disconnect (guards + pending image batches). */
    function onDisconnect(socket) {
        isChatFlooded.forget(socket.id); // per-socket rate windows die with the socket
        isChatPageFlooded.forget(socket.id);
        chatBatches.delete(socket.id); // pending image batches die with the sender
    }

    return { register, onDisconnect };
}

module.exports = { createChatGateway };
