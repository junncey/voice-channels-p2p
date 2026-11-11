/**
 * Shared DOM / formatting helpers.
 */
import { t } from './i18n.js';

export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Tiny element builder.
 * el('div', { class: 'a', text: 'hi', dataset: { id: 1 } }, child1, child2)
 */
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html')
            node.innerHTML = value; // only for trusted static markup
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
        if (child === undefined || child === null) continue;
        node.append(child.nodeType ? child : document.createTextNode(child));
    }
    return node;
}

export function formatTime(date = new Date()) {
    const d = new Date(date);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

export function formatDate(date = new Date()) {
    const d = new Date(date);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd} ${formatTime(d)}`;
}

/** Deterministic avatar color from a name. */
export function avatarColor(name = '') {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return `hsl(${hash % 360}, 55%, 45%)`;
}

export function randomNick(prefix = '游客') {
    const rand = Math.random().toString(36).slice(2, 6);
    return `${prefix}-${rand}`;
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // clipboard API unavailable (insecure context) — legacy fallback
        try {
            const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
            ta.value = text;
            document.body.append(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Transient toast notification, stacked into the page's #toasts container
 * (shared markup across index/channel/admin) and auto-removed after a beat.
 */
export function toast(message, kind = '') {
    const box = $('#toasts');
    if (!box) return;
    const node = el('div', { class: `toast ${kind}`, text: message });
    box.append(node);
    setTimeout(() => node.remove(), 3200);
}

// ----- 键位显示与校验（按键说话的自定义绑定键用） -----

/** 纯修饰键（Shift/Ctrl/Alt/Meta 的左右任一）：单独按住构不成一个可绑定的说话键。 */
const MODIFIER_RE = /^(Shift|Control|Alt|Meta)(Left|Right)$/;

export function isModifierCode(code) {
    return MODIFIER_RE.test(code);
}

// 少数键名无法从 event.code 机械推导，走 key.* 词典词条；箭头键用通用符号
const KEY_LABELS = { Space: 'space', Tab: 'tab', CapsLock: 'capsLock', Backquote: 'backquote', Enter: 'enter' };
const ARROW_LABELS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

/** event.code 的本地化显示名：KeyV→V、Digit1→1、F1-12 原样，特殊键查词条，其余原样返回。 */
export function keyLabel(code) {
    if (!code) return '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return t('key.numpad', { n: code.slice(6) });
    if (ARROW_LABELS[code]) return ARROW_LABELS[code];
    const named = KEY_LABELS[code];
    return named ? t(`key.${named}`) : code;
}

/** 校验存储的说话键值：仅接受形如 KeyboardEvent.code 的单键，修饰键与非法值回退 KeyV。 */
export function normalizePttKey(value) {
    return typeof value === 'string' && /^[A-Z][A-Za-z0-9]{1,20}$/.test(value) && !isModifierCode(value)
        ? value
        : 'KeyV';
}
