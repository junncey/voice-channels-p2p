/**
 * 共享的 DOM / 格式化工具。
 */
import { t } from './i18n.js';

export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * 小型元素构建器。
 * el('div', { class: 'a', text: 'hi', dataset: { id: 1 } }, child1, child2)
 */
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html')
            node.innerHTML = value; // 仅用于可信的静态标记
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

/** @提及的词边界断言（后面不紧跟字母/数字/下划线）——高亮
 *  （chat.js）与桌面通知判定（notify.js）共用：改一处漏一处
 *  会造成两者的提及判定不一致。 */
export const MENTION_BOUNDARY = '(?![\\p{L}\\p{N}_])';

/** 由昵称确定性推导头像颜色。 */
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

/** crypto.randomUUID 仅在安全上下文（https / localhost）存在；局域网
 *  http://IP 等非安全上下文退回 getRandomValues 手拼 RFC 4122 v4——
 *  服务端 join 会校验 peer_uuid 形状，退回版必须同形。 */
export function randomUuid() {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b); // 非 SecureContext 也可用
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10x
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // clipboard API 不可用（非安全上下文）——传统回退
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
 * 短暂的 toast 通知，堆入页面的 #toasts 容器
 * （index/channel/admin 共用同一标记），稍后自动移除。
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

// ----- 按用户音量记忆（vc_peer_volumes）的清洗 -----

// 滑杆值域 0..300%（members.js 的 memberVolumeNode）
const PEER_VOLUME_MAX = 3;

/**
 * 清洗持久化的按用户音量记录：只接受可 coerce 到 0..3 的有限数
 * （越界夹取），null/undefined/NaN/对象一律丢弃回默认——坏值会让
 * 增益算出 NaN（setTargetAtTime 抛 TypeError）或离谱放大。夹取后
 * 等于 1 的条目与默认等价，不保留（与 savePeerVolume 的不变量一致）。
 * @param {unknown} stored localStorage 解析出的任意值
 * @returns {Record<string, number>} 干净的 名字 → 音量 映射
 */
export function sanitizePeerVolumes(stored) {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const out = {};
    for (const [name, volume] of Object.entries(stored)) {
        if (!name || volume === null || volume === undefined) continue;
        const value = Number(volume);
        if (!Number.isFinite(value)) continue;
        const clamped = Math.min(PEER_VOLUME_MAX, Math.max(0, value));
        if (clamped !== 1) out[name] = clamped;
    }
    return out;
}
