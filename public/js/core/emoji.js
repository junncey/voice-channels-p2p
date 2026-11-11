/**
 * emoji 域——聊天消息列表（纯 emoji 气泡）、回应选择器与输入框
 * emoji 按钮共用的调色板 + 字形检测。
 * 纯 textContent 渲染，同一时间只有一个弹层，
 * 点击外部 / Esc / 选中即关闭。
 */

import { el } from './utils.js';

// emoji 字形串：象形字符、肤色修饰、ZWJ 序列、键帽符号、
// 区域指示符对、变体选择符与周边空白
// （字符类里的星体 \u{...} 转义是有意为之——
// 这些正则的存在就是为了精确匹配那些码点）
/* eslint-disable no-misleading-character-class */
const EMOJI_RUN_RE =
    /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\s])+$/u;
const EMOJI_CORE_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{20E3}]/u;
/* eslint-enable no-misleading-character-class */

/**
 * 仅由少量 emoji 组成（不含字母/数字）的消息渲染时去掉气泡外框——
 * 普通气泡里的单个 emoji 看起来会与散落的回应 chip
 * 难以区分。
 * @param {string} text
 */
export function isEmojiOnly(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 24 || !EMOJI_RUN_RE.test(trimmed)) return false;
    return EMOJI_CORE_RE.test(trimmed);
}

/** 回应选择器与输入框 emoji 按钮提供的调色板。 */
export const EMOJIS = [
    '👍',
    '👎',
    '❤️',
    '😂',
    '😭',
    '😮',
    '🥳',
    '🎉',
    '🔥',
    '👀',
    '🙏',
    '👌',
    '🤔',
    '😅',
    '😢',
    '😡',
    '🥰',
    '😎',
    '🤝',
    '👏',
    '💯',
    '🤣',
    '😍',
    '🥺',
    '😴',
    '🫡',
    '✅',
    '❌',
    '⚡',
    '🌙',
];

let emojiPickerNode = null;

export function closeEmojiPicker() {
    if (!emojiPickerNode) return;
    emojiPickerNode.remove();
    document.removeEventListener('click', emojiPickerOutside, true);
    document.removeEventListener('keydown', emojiPickerEsc, true);
    emojiPickerNode = null;
}

function emojiPickerOutside(event) {
    if (emojiPickerNode && !emojiPickerNode.contains(event.target)) closeEmojiPicker();
}

function emojiPickerEsc(event) {
    if (event.key === 'Escape') closeEmojiPicker();
}

/**
 * @param {HTMLElement} anchor 定位参考元素
 * @param {function(string): void} onPick 选中 emoji 时以该 emoji 回调
 */
export function openEmojiPicker(anchor, onPick) {
    closeEmojiPicker();
    emojiPickerNode = el(
        'div',
        { class: 'emoji-picker', role: 'menu' },
        ...EMOJIS.map((emoji) =>
            el('button', {
                class: 'emoji-picker-item',
                type: 'button',
                text: emoji,
                onclick: () => {
                    closeEmojiPicker();
                    onPick(emoji);
                },
            })
        )
    );
    document.body.append(emojiPickerNode);
    const rect = anchor.getBoundingClientRect();
    const pick = emojiPickerNode.getBoundingClientRect();
    // 限制在视口内：优先放在锚点上方偏右
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - pick.width - 8));
    const top =
        rect.top - pick.height - 6 > 8
            ? rect.top - pick.height - 6
            : Math.min(rect.bottom + 6, window.innerHeight - pick.height - 8);
    emojiPickerNode.style.left = `${left}px`;
    emojiPickerNode.style.top = `${top}px`;
    // 打开它的那次点击本身不能算作「外部」
    setTimeout(() => {
        document.addEventListener('click', emojiPickerOutside, true);
        document.addEventListener('keydown', emojiPickerEsc, true);
    }, 0);
}
