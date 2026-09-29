/**
 * Shared DOM / formatting helpers.
 */

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
        else if (key === 'html') node.innerHTML = value; // only for trusted static markup
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

export function debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}
