/**
 * 轻量语义键 i18n（默认中文，可选英文）。
 * 用法：
 *   await initI18n();
 *   t('channel.micOn')                     -> 麦克风已开启
 *   t('index.online', { n: 3 })             -> 3 人在线
 * 静态 DOM 翻译经 data-i18n / data-i18n-ph（placeholder）属性完成。
 */

const DEFAULT_LANG = 'zh';
const LANG_KEY = 'vc_lang';

let dict = {};
let currentLang = DEFAULT_LANG;

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
    currentLang = lang;
    document.documentElement.lang = lang;
    try {
        const res = await fetch(`/lang/${lang}.json`, { cache: 'no-cache' });
        if (res.ok) dict = await res.json();
    } catch {
        dict = {};
    }
    applyStaticTranslations();
}

/** 当前生效的语言代码（'zh' | 'en'）。 */
export function getLang() {
    return currentLang;
}

/**
 * 切换 UI 语言。所有静态内容在启动时经 data-i18n 属性翻译，
 * 因此最省事且正确的重渲染方式就是整页刷新——
 * 何时刷新可接受由调用方决定（并在其提示中说明）。
 */
export function setLang(lang) {
    if (lang !== 'zh' && lang !== 'en') return;
    localStorage.setItem(LANG_KEY, lang);
    location.reload();
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
