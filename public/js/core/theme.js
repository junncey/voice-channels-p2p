/**
 * 主题偏好：dark（默认）/ light / auto（跟随操作系统，实时更新）。
 * 按浏览器存于 vc_theme——刻意不参与首页的「清除全部」清扫，
 * 因此清除用户数据后保留所选配色。
 * 绘制前的应用逻辑在 theme-boot.js（非模块，<head> 内）；
 * 本模块负责运行时切换。
 */

const THEME_KEY = 'vc_theme';
const PREFS = ['dark', 'light', 'auto'];

let media = null;

function systemPrefersLight() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** 只注册一次系统变化监听；auto 模式实时重新解析。 */
function watchSystem() {
    if (media || typeof window.matchMedia !== 'function') return;
    media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
        if (getThemePref() === 'auto') applyPref('auto');
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange); // 旧版 Safari
}

/** 存储的偏好：'dark' | 'light' | 'auto'。 */
export function getThemePref() {
    const stored = document.documentElement.dataset.themePref || localStorage.getItem(THEME_KEY);
    return PREFS.includes(stored) ? stored : 'dark';
}

/** 当前屏幕上实际生效的配色。 */
export function getTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyPref(pref) {
    document.documentElement.dataset.themePref = pref;
    document.documentElement.dataset.theme = pref === 'auto' ? (systemPrefersLight() ? 'light' : 'dark') : pref;
    return pref;
}

/** 设置偏好（'dark'|'light'|'auto'），持久化并应用。 */
export function setThemePref(pref) {
    const next = PREFS.includes(pref) ? pref : 'dark';
    try {
        localStorage.setItem(THEME_KEY, next);
    } catch {
        /* 存储不可用——该选择只是不会持久化 */
    }
    if (next === 'auto') watchSystem();
    return applyPref(next);
}
