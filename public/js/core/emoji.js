/**
 * Emoji domain — the shared palette + glyph detection used by the chat
 * message list (emoji-only bubbles), the reaction picker and the composer
 * emoji button. Plain textContent, one popover at a time, closes on
 * outside click / Esc / pick.
 */

import { el } from './utils.js';

// emoji glyph runs: pictographics, skin tones, ZWJ sequences, keycaps,
// regional-indicator pairs, variation selectors and surrounding whitespace
// (the astral \u{...} escapes inside the character classes are deliberate —
// these regexes exist to match exactly those code points)
/* eslint-disable no-misleading-character-class */
const EMOJI_RUN_RE =
    /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\s])+$/u;
const EMOJI_CORE_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{20E3}]/u;
/* eslint-enable no-misleading-character-class */

/**
 * A message made only of a few emoji (no letters/digits) renders without the
 * bubble chrome — a lone emoji inside a normal bubble is indistinguishable
 * from a stray reaction chip.
 * @param {string} text
 */
export function isEmojiOnly(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 24 || !EMOJI_RUN_RE.test(trimmed)) return false;
    return EMOJI_CORE_RE.test(trimmed);
}

/** Palette offered by the reaction picker and the composer emoji button. */
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
 * @param {HTMLElement} anchor element to position near
 * @param {function(string): void} onPick called with the chosen emoji
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
    // clamp inside the viewport: prefer above-right of the anchor
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - pick.width - 8));
    const top =
        rect.top - pick.height - 6 > 8
            ? rect.top - pick.height - 6
            : Math.min(rect.bottom + 6, window.innerHeight - pick.height - 8);
    emojiPickerNode.style.left = `${left}px`;
    emojiPickerNode.style.top = `${top}px`;
    // the opening click itself must not count as "outside"
    setTimeout(() => {
        document.addEventListener('click', emojiPickerOutside, true);
        document.addEventListener('keydown', emojiPickerEsc, true);
    }, 0);
}
