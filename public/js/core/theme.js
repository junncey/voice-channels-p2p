/**
 * Theme preference: dark (default) / light / auto (follow the OS, updated
 * live). Stored per-browser under vc_theme — deliberately NOT part of the
 * homepage "clear everything" sweep, so clearing user data keeps the chosen
 * palette. The pre-paint application lives in theme-boot.js (non-module,
 * <head>); this module owns runtime switching.
 */

const THEME_KEY = 'vc_theme';
const PREFS = ['dark', 'light', 'auto'];

let media = null;

function systemPrefersLight() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

/** Register the OS-change listener once; auto mode re-resolves live. */
function watchSystem() {
    if (media || typeof window.matchMedia !== 'function') return;
    media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
        if (getThemePref() === 'auto') applyPref('auto');
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange); // old Safari
}

/** The stored preference: 'dark' | 'light' | 'auto'. */
export function getThemePref() {
    const stored = document.documentElement.dataset.themePref || localStorage.getItem(THEME_KEY);
    return PREFS.includes(stored) ? stored : 'dark';
}

/** The palette actually on screen right now. */
export function getTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyPref(pref) {
    document.documentElement.dataset.themePref = pref;
    document.documentElement.dataset.theme = pref === 'auto' ? (systemPrefersLight() ? 'light' : 'dark') : pref;
    return pref;
}

/** Set the preference ('dark'|'light'|'auto'), persist it, apply it. */
export function setThemePref(pref) {
    const next = PREFS.includes(pref) ? pref : 'dark';
    try {
        localStorage.setItem(THEME_KEY, next);
    } catch {
        /* storage unavailable — the choice just won't persist */
    }
    if (next === 'auto') watchSystem();
    return applyPref(next);
}

/** Legacy helpers (index page cycles through the three states). */
export function setTheme(theme) {
    return setThemePref(theme);
}

export function toggleTheme() {
    const order = ['dark', 'light', 'auto'];
    return setThemePref(order[(order.indexOf(getThemePref()) + 1) % order.length]);
}
