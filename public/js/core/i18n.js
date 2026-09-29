/**
 * Lightweight semantic-key i18n (zh default, en optional).
 * Usage:
 *   await initI18n();
 *   t('channel.micOn')                     -> 麦克风已开启
 *   t('index.online', { n: 3 })             -> 3 人在线
 * Static DOM translation via data-i18n / data-i18n-ph (placeholder) attributes.
 */

const DEFAULT_LANG = 'zh';
const LANG_KEY = 'vc_lang';

let dict = {};

function resolveLang() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('lang');
    if (fromUrl && /^[a-z]{2}$/.test(fromUrl)) {
        localStorage.setItem(LANG_KEY, fromUrl);
        return fromUrl;
    }
    const stored = localStorage.getItem(LANG_KEY);
    if (stored && /^[a-z]{2}$/.test(stored)) return stored;
    const nav = (navigator.language || '').slice(0, 2).toLowerCase();
    return nav === 'zh' || nav === 'en' ? nav : DEFAULT_LANG;
}

export async function initI18n() {
    const lang = resolveLang();
    document.documentElement.lang = lang;
    try {
        const res = await fetch(`/lang/${lang}.json`, { cache: 'no-cache' });
        if (res.ok) dict = await res.json();
    } catch {
        dict = {};
    }
    applyStaticTranslations();
}

export function t(key, vars) {
    let text = dict[key] ?? key;
    if (vars) {
        for (const [name, value] of Object.entries(vars)) {
            text = text.split(`{${name}}`).join(String(value));
        }
    }
    return text;
}

export function applyStaticTranslations(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((node) => {
        node.textContent = t(node.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-ph]').forEach((node) => {
        node.setAttribute('placeholder', t(node.dataset.i18nPh));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((node) => {
        node.setAttribute('title', t(node.dataset.i18nTitle));
    });
}
