/**
 * Theme preference (dark default / light). Stored per-browser under
 * vc_theme — deliberately NOT part of the homepage "clear everything"
 * sweep, so clearing user data keeps the chosen palette.
 * The pre-paint application lives in theme-boot.js (non-module, <head>).
 */

const THEME_KEY = 'vc_theme';

export function getTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
        localStorage.setItem(THEME_KEY, next);
    } catch {
        /* storage unavailable — the choice just won't persist */
    }
    return next;
}

export function toggleTheme() {
    return setTheme(getTheme() === 'light' ? 'dark' : 'light');
}
