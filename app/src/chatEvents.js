/*
聊天行与事件行的共享形状/变更逻辑。

chatStore 的在线变更器（edit/remove/react）与 JSONL 事件行的加载重放
（applyEvent）在这里共用同一组实现——写入进程内存中的行与重放文件
得到的行永远一致（此前是两份逐行镜像、靠注释维系的同步义务）。
行级校验器（isPlain*，供历史文件与 restore 逐行校验复用）、
载荷归一化（sanitizeReply/sanitizeImages）与序列化工具
（serializeLines/estimateBytes）也住在这里。
*/

'use strict';

const limits = require('./limits');

const NAME_MAX = limits.PEER_NAME_MAX;
const TEXT_MAX = limits.CHAT_TEXT_MAX;
const REPLY_TEXT_MAX = limits.REPLY_TEXT_MAX;
const REACTION_EMOJI_MAX = limits.REACTION_EMOJI_MAX;
const MAX_IMAGES = limits.MAX_IMAGES_PER_MESSAGE;
const REACTIONS_MAX_EMOJI = limits.REACTIONS_MAX_EMOJI;
const REACTIONS_MAX_NAMES = limits.REACTIONS_MAX_NAMES;
const DATA_URL_RE = limits.IMAGE_DATA_URL_RE;
const MAX_IMAGE_CHARS = limits.IMAGE_MAX_CHARS;

/** 与客户端 composer 完全一致的 trim + 上限
 *  （input.trim().slice(0, 500)）。 */
function cleanChatText(text) {
    return typeof text === 'string' ? text.trim().slice(0, TEXT_MAX) : '';
}

/** 编辑一行（在线变更与事件重放共用）。 */
function applyEditText(row, cleanText) {
    row.text = cleanText;
    row.edited = true;
}

/** 撤回一行为墓碑：行保留 ts 以稳游标，文字/图片/回应消失
 *  （在线变更与事件重放共用）。 */
function applyDeleteRow(row) {
    row.deleted = true;
    row.text = '';
    delete row.imgs;
    delete row.reactions;
}

/**
 * 在行上切换一个回应。返回是否实际改变了回应映射——在线路径据此
 * 决定是否落事件行；重复/封顶的添加与不在场的移除天然是无操作
 * （返回 false），两种路径因此永远一致。
 */
function toggleReaction(row, emoji, who, op) {
    // 每个 emoji 的数组也要拷贝：原地变异会泄漏进 row.reactions，
    // 让下面的 changed 检查总是相等
    const reactions = { ...(row.reactions || {}) };
    const names = [...(reactions[emoji] || [])];
    const idx = names.indexOf(who);
    if (op === 'remove') {
        if (idx !== -1) names.splice(idx, 1);
    } else if (idx === -1) {
        // 添加（幂等）：竞态客户端的重复添加是无操作；
        // 封顶的添加同样无操作——重放时它本来就没生效
        if (Object.keys(reactions).length >= REACTIONS_MAX_EMOJI && !reactions[emoji]) return false;
        if (names.length >= REACTIONS_MAX_NAMES) return false;
        names.push(who);
    }
    if (names.length) reactions[emoji] = names;
    else delete reactions[emoji];
    const changed = JSON.stringify(reactions) !== JSON.stringify(row.reactions || {});
    if (Object.keys(reactions).length) row.reactions = reactions;
    else delete row.reactions;
    return changed;
}

/**
 * 把一条生命周期事件行重放到有序行列表上。与在线变更器完全
 * 共用实现（见上），重放文件总能得到与写入进程内存中相同的行；
 * 更新版本带来的未知事件种类被跳过。
 */
function applyEvent(messages, evt) {
    switch (evt.e) {
        case 'drop': {
            // 前缀丢弃：留存窗口 / 消息上限移走了前 n 行——精确计数，
            // 不依赖 ts/名字假设（`ts` 字段只是为了让 restore 校验
            // 接受这一行）
            if (!Number.isInteger(evt.n) || evt.n <= 0) return;
            messages.splice(0, Math.min(evt.n, messages.length));
            return;
        }
        case 'edit': {
            if (!isEventTarget(evt)) return;
            const text = cleanChatText(evt.text);
            if (!text) return;
            const row = findRowIn(messages, evt.ts, evt.name);
            if (!row || row.deleted) return;
            applyEditText(row, text);
            return;
        }
        case 'del': {
            if (!isEventTarget(evt)) return;
            const row = findRowIn(messages, evt.ts, evt.name);
            if (!row || row.deleted) return;
            applyDeleteRow(row);
            return;
        }
        case 'react': {
            if (!isEventTarget(evt)) return;
            const emoji = typeof evt.emoji === 'string' ? evt.emoji.trim().slice(0, REACTION_EMOJI_MAX) : '';
            const who = typeof evt.who === 'string' ? evt.who.slice(0, NAME_MAX) : '';
            if (!emoji || !who) return;
            const row = findRowIn(messages, evt.ts, evt.name);
            if (!row || row.deleted) return;
            toggleReaction(row, emoji, who, evt.op);
            return;
        }
        default:
            return;
    }
}

/** edit/del/react 事件行携带的行身份（ts + 发送者名字）。 */
function isEventTarget(evt) {
    return Number.isFinite(evt.ts) && typeof evt.name === 'string' && !!evt.name;
}

/** 在普通行列表中按 ts + 发送者名字找行（从最新端扫起）。 */
function findRowIn(messages, ts, name) {
    if (!Number.isFinite(ts) || typeof name !== 'string') return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const row = messages[i];
        if (row.ts === ts && row.name === name) return row;
    }
    return null;
}

/** 行列表序列化为 JSONL 文本。 */
function serializeLines(messages) {
    return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
}

function isPlainMessage(m) {
    return (
        m &&
        typeof m === 'object' &&
        !Array.isArray(m) &&
        Number.isFinite(m.ts) &&
        typeof m.name === 'string' &&
        typeof m.text === 'string' &&
        (m.reply === undefined || isPlainReply(m.reply)) &&
        (m.edited === undefined || typeof m.edited === 'boolean') &&
        (m.deleted === undefined || typeof m.deleted === 'boolean') &&
        (m.reactions === undefined || isPlainReactions(m.reactions)) &&
        (m.imgs === undefined ||
            // 旧版行（≤ voice.21）只存图片数量——加载时接受，
            // 升级绝不丢掉更早的历史；客户端以「[image×N]」
            // 占位符展示（数据本身从未存在）
            Number.isInteger(m.imgs) ||
            (Array.isArray(m.imgs) && m.imgs.every((s) => typeof s === 'string')))
    );
}

/** 被回复行的引用摘要——形状检查保持宽松（历史文件里的既有行
 *  照常加载）；入站载荷的严格校验见 sanitizeReply。 */
function isPlainReply(reply) {
    return (
        reply &&
        typeof reply === 'object' &&
        !Array.isArray(reply) &&
        typeof reply.name === 'string' &&
        typeof reply.text === 'string' &&
        Number.isFinite(reply.ts)
    );
}

/** 回应映射：emoji -> 回应者名字数组（仅纯字符串）。 */
function isPlainReactions(reactions) {
    if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return false;
    for (const names of Object.values(reactions)) {
        if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return false;
    }
    return true;
}

/**
 * 归一化传入的回复载荷以供存储；null = 丢弃。
 * 严格形状：名字与摘要非空（截断后仍非空）、ts 为正有限数——
 * 实时路径（chatGateway）与存储路径共用这一份，
 * 两条路径对同一字段的接受度一致。
 */
function sanitizeReply(reply) {
    if (!isPlainReply(reply)) return null;
    const name = reply.name.slice(0, NAME_MAX);
    const text = reply.text.slice(0, REPLY_TEXT_MAX);
    const ts = Number(reply.ts);
    if (!name || !text || !Number.isFinite(ts) || ts <= 0) return null;
    return { name, text, ts };
}

/** 只保留白名单内、尺寸封顶的 data:image/* URL，至多 MAX_IMAGES 张。 */
function sanitizeImages(input) {
    const images = [];
    if (!Array.isArray(input)) return images;
    for (const item of input) {
        if (images.length >= MAX_IMAGES) break;
        if (typeof item === 'string' && item.length > 0 && item.length <= MAX_IMAGE_CHARS && DATA_URL_RE.test(item)) {
            images.push(item);
        }
    }
    return images;
}

/** 单行序列化后的精确 UTF-8 字节数——发送预算必须按线上形态计，
 *  中日韩文字每个码点 3 字节，按字符数估会三倍低估。 */
function estimateBytes(message) {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

module.exports = {
    cleanChatText,
    applyEditText,
    applyDeleteRow,
    toggleReaction,
    applyEvent,
    isEventTarget,
    findRowIn,
    serializeLines,
    isPlainMessage,
    isPlainReply,
    isPlainReactions,
    sanitizeReply,
    sanitizeImages,
    estimateBytes,
};
