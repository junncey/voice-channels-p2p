/*
聊天行渲染的共享纯工具：@提及高亮、文本节点/气泡构建、
载荷校验器（回复引用/图片/回应表）与图片灯箱。从 chat.js
拆出——这些没有消息列表的闭包依赖，可独立单测；
chat.js 只保留列表状态、装配与生命周期。
*/

import { el, MENTION_BOUNDARY } from './utils.js';
import { isEmojiOnly } from './emoji.js';
import { DATA_URL_RE, MAX_TRANSFER_CHARS } from './images.js';

/** 转义成员名以用于 @提及 RegExp。 */
export function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 消息载荷中的回复引用，渲染/存储前先形状校验并截断
 * ——与频道页的历史与实时路径共用。
 */
export function validReply(reply) {
    if (
        !reply ||
        typeof reply !== 'object' ||
        typeof reply.name !== 'string' ||
        typeof reply.text !== 'string' ||
        !Number.isFinite(reply.ts)
    ) {
        return null;
    }
    return { name: reply.name.slice(0, 24), text: reply.text.slice(0, 80), ts: reply.ts };
}

/** 持久化的图片 URL，触碰 DOM 前重新校验。 */
export function validImages(imgs) {
    return (Array.isArray(imgs) ? imgs : [])
        .filter(
            (src) =>
                typeof src === 'string' && src.length > 0 && src.length <= MAX_TRANSFER_CHARS && DATA_URL_RE.test(src)
        )
        .slice(0, 9);
}

/** 消息载荷中的回应表，渲染前先形状校验。 */
export function validReactions(reactions) {
    if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return null;
    const out = {};
    for (const [emoji, names] of Object.entries(reactions)) {
        if (typeof emoji !== 'string' || emoji.length > 16) continue;
        if (Array.isArray(names)) out[emoji] = names.filter((n) => typeof n === 'string').slice(0, 50);
    }
    return Object.keys(out).length ? out : null;
}

/**
 * 文本渲染器工厂：绑定提及名单/自己名字/已编辑标记文案的
 * 获取方式（chat.js 传入自己的 options 闭包），
 * 返回的 textBubble/textNode 签名与拆分前完全一致。
 */
export function createTextRenderers({ getNames, getMe, editedText }) {
    /**
     * 把文本拆成节点，高亮在线成员的 `@name`（自己的名字
     * 用更强的样式）。只有纯文本节点——
     * 绝不内插任何 HTML。
     */
    function mentionSegments(text) {
        const names = [...new Set(getNames().filter(Boolean))];
        const me = getMe();
        if (!names.length || !text.includes('@')) return [text];
        const pattern = new RegExp(`(@(?:${names.map(escapeRegExp).join('|')}))${MENTION_BOUNDARY}`, 'gu');
        const out = [];
        let last = 0;
        for (const match of text.matchAll(pattern)) {
            const at = match.index;
            if (at > last) out.push(text.slice(last, at));
            const name = match[1].slice(1);
            out.push(el('span', { class: 'mention' + (name === me ? ' self' : ''), text: match[1] }));
            last = at + match[1].length;
        }
        if (last < text.length) out.push(text.slice(last));
        return out.length ? out : [text];
    }

    function textNode(text, edited) {
        const node = el('div', { class: 'msg-text' }, ...mentionSegments(text));
        if (edited) node.append(el('span', { class: 'msg-edited', text: editedText }));
        return node;
    }

    /** 带 @提及高亮的纯文本气泡（含已编辑标记）。 */
    function textBubble(text, edited = false) {
        const bubble = el('div', { class: 'msg-bubble' }, textNode(text, edited));
        // 已编辑标记在 .msg-text 内，配上超大字形会撑爆，
        // 所以编辑过的消息保持普通气泡
        if (!edited && isEmojiOnly(text)) bubble.classList.add('emoji-only');
        return bubble;
    }

    return { textBubble, textNode };
}

/**
 * 图片灯箱（点击图片全尺寸查看）：点背景或 Esc 关闭，
 * 顶栏带下载按钮。src 必须是已校验过的 data URL。
 */
export function createLightbox(downloadText) {
    let node = null;

    const onEsc = (event) => {
        if (event.key === 'Escape') close();
    };

    function open(src, alt) {
        close();
        const img = el('img', { alt });
        img.src = src;
        const download = el('a', { class: 'btn ghost sm', download: alt || 'image', href: src, text: downloadText });
        download.setAttribute('download', alt || 'image');
        node = el(
            'div',
            { class: 'lightbox', onclick: () => close() },
            el('div', { class: 'lightbox-bar', onclick: (e) => e.stopPropagation() }, download),
            img
        );
        document.body.append(node);
        document.addEventListener('keydown', onEsc);
    }

    function close() {
        if (!node) return;
        document.removeEventListener('keydown', onEsc);
        node.remove();
        node = null;
    }

    return { open, close };
}
