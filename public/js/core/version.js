/**
 * Frontend version guard.
 *
 * Every page ships with its build id baked into the HTML (`<meta name="vc-build">`)
 * and compares it with the id the server reports on GET /api/version, polled
 * every 5 minutes while the tab is visible (and immediately when it regains
 * focus). On a mismatch a slim bar appears at the top of the page offering a
 * reload. The bar is in normal flow, so it never covers the page; dismissing it
 * only silences that one build, a newer one prompts again.
 */

import { t } from './i18n.js';
import { el } from './utils.js';

// Deploys are rare and switching back to the tab checks right away, so a slow
// background poll is enough — 12 requests/hour/tab instead of 60.
const CHECK_MS = 5 * 60_000;
const BODY_CLASS = 'has-update-bar';
const HEIGHT_VAR = '--update-bar-h';

const INFO_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>';
const X_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>';

let loaded = null; // build id this page was served with
let dismissedBuild = null; // build closed via × — a newer build re-prompts
let bar = null;
let inFlight = false;
let isBusy = null;

/**
 * @param {object}   [options]
 * @param {function} [options.isBusy] returns true while reloading would interrupt
 *        the user (an active call) — the reload then asks for confirmation
 */
export function initVersionCheck(options = {}) {
    isBusy = typeof options.isBusy === 'function' ? options.isBusy : null;
    loaded = bakedBuild();
    check();
    setInterval(() => {
        if (!document.hidden) check();
    }, CHECK_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
    });
}

/** Build id the server baked into this page — the exact code it is running. */
function bakedBuild() {
    const meta = document.querySelector('meta[name="vc-build"]');
    return meta ? meta.getAttribute('content') : null;
}

async function check() {
    if (inFlight) return;
    inFlight = true;
    let build = null;
    try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (res.ok) build = (await res.json()).build;
    } catch {
        // server restarting or unreachable — retry on the next cycle
    } finally {
        inFlight = false;
    }
    if (!build) return;

    if (!loaded) {
        // no baked id (page HTML served by an older build) — fall back to the
        // first response we can get
        loaded = build;
    } else if (build !== loaded && build !== dismissedBuild) {
        showUpdateBar(build);
    }
}

function showUpdateBar(build) {
    if (bar) return;
    bar = el(
        'div',
        { class: 'update-bar', role: 'status' },
        el('span', { class: 'update-icon', html: INFO_SVG, 'aria-hidden': 'true' }),
        el('span', { class: 'update-text', text: t('update.availableDesc') }),
        el('button', {
            class: 'update-link',
            type: 'button',
            text: t('update.refreshNow'),
            onclick: () => {
                if (isBusy && isBusy() && !window.confirm(t('update.reloadInCall'))) return;
                reloadNow();
            },
        }),
        el('button', {
            class: 'update-close',
            type: 'button',
            html: X_SVG,
            'aria-label': t('update.dismiss'),
            onclick: () => dismissBuild(build),
        })
    );
    document.body.prepend(bar);
    document.body.classList.add(BODY_CLASS);
    // measured, not hard-coded: the bar wraps to two lines on narrow screens
    // and the outage banner keeps its distance from it
    document.body.style.setProperty(HEIGHT_VAR, `${bar.offsetHeight}px`);
}

/**
 * A script-driven reload is still a navigation: pages that guard against
 * accidental exits (an active call) would otherwise confirm twice — once from
 * this bar, once from the browser's own prompt. Announce the intent first so
 * they can stand down; the listener runs synchronously, before beforeunload.
 */
function reloadNow() {
    window.dispatchEvent(new Event('vc:unload-intent'));
    location.reload();
}

function dismissBuild(build) {
    dismissedBuild = build;
    if (bar) bar.remove();
    bar = null;
    document.body.classList.remove(BODY_CLASS);
    document.body.style.removeProperty(HEIGHT_VAR);
}
