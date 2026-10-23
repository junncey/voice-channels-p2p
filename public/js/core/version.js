/**
 * Frontend version guard: polls the server build fingerprint
 * (GET /api/version); when it no longer matches the build this page was
 * loaded with, a soft top-center banner offers a refresh. Used by all
 * pages (index/channel/admin).
 */

import { t } from './i18n.js';
import { el } from './utils.js';

const CHECK_MS = 60_000;

const INFO_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>';
const X_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>';

let loaded = null; // build fingerprint this page booted with
let dismissedBuild = null; // build closed via × — a newer build re-prompts
let banner = null;
let inFlight = false;

export function initVersionCheck() {
    check();
    setInterval(() => {
        if (!document.hidden) check();
    }, CHECK_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
    });
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
        // first successful fetch = the build this page is actually running
        loaded = build;
    } else if (build !== loaded && build !== dismissedBuild) {
        showUpdateBanner(build);
    }
}

function showUpdateBanner(build) {
    if (banner) return;
    banner = el(
        'div',
        { class: 'update-banner', role: 'status' },
        el('span', { class: 'update-icon', html: INFO_SVG, 'aria-hidden': 'true' }),
        el('span', { class: 'update-text', text: t('update.availableDesc') }),
        el('button', {
            class: 'update-link',
            type: 'button',
            text: t('update.refreshNow'),
            onclick: () => location.reload(),
        }),
        el('button', {
            class: 'update-close',
            type: 'button',
            html: X_SVG,
            'aria-label': t('update.dismiss'),
            onclick: () => {
                dismissedBuild = build;
                banner.remove();
                banner = null;
            },
        })
    );
    document.body.append(banner);
}
