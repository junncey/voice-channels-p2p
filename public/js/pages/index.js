/**
 * Homepage — public channel list, polled for online counts.
 */

import { api } from '/js/core/api.js';
import { initI18n, t } from '/js/core/i18n.js';
import { getTheme, toggleTheme } from '/js/core/theme.js';
import { $, el } from '/js/core/utils.js';

const POLL_MS = 15000;

// everything this app stores per-browser; nickname can be cleared separately.
// The theme choice (vc_theme) is deliberately NOT listed — "clear everything"
// must keep the user's palette.
const NICK_KEY = 'vc_nick';
const CONFIG_KEYS = ['vc_audio_settings', 'vc_peer_volumes', 'vc_send_key'];

const MOON_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
const SUN_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

boot();

async function boot() {
    await initI18n();
    bindThemeToggle();
    bindClearData();
    bindCreateTemp();
    await load();
    setInterval(load, POLL_MS);
}

// ----- dark/light theme pill (topbar) -----

function bindThemeToggle() {
    const button = $('#themeBtn');
    const icon = button.querySelector('.theme-icon');
    const label = button.querySelector('.theme-label');
    const render = () => {
        const light = getTheme() === 'light';
        icon.innerHTML = light ? SUN_SVG : MOON_SVG;
        label.textContent = t(light ? 'index.themeLight' : 'index.themeDark');
    };
    button.addEventListener('click', () => {
        toggleTheme();
        render();
    });
    render();
}

// ----- temporary rooms: spawn one by visiting a fresh /c/<id>; the server
// creates it in memory on first join and drops it when the last peer leaves -----

function bindCreateTemp() {
    $('#createTempBtn').addEventListener('click', () => {
        const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // same unambiguous set as the server
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        let id = '';
        for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
        location.href = `/c/${id}`;
    });
}

async function load() {
    const grid = $('#channelGrid');
    try {
        const { channels, settings } = await api.getPublicChannels();
        $('#statusHint').textContent = '';

        // temp rooms disabled by the admin — hide the spawn entry point
        $('#createTempBtn').classList.toggle('hidden', settings?.tempRooms === false);

        if (!channels.length) {
            grid.replaceChildren();
            $('#emptyState').classList.remove('hidden');
            return;
        }
        $('#emptyState').classList.add('hidden');
        grid.replaceChildren(...channels.map(renderCard));
    } catch {
        $('#statusHint').textContent = t('index.loadError');
    }
}

// ----- clear local user data (nickname only, or nickname + all settings) -----

function bindClearData() {
    const modal = $('#clearModal');
    const close = () => modal.classList.add('hidden');
    $('#clearDataBtn').addEventListener('click', () => modal.classList.remove('hidden'));
    $('#clearCancelBtn').addEventListener('click', close);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) close();
    });
    $('#clearNickBtn').addEventListener('click', () => {
        localStorage.removeItem(NICK_KEY);
        close();
        toast(t('index.cleared'), 'ok');
    });
    $('#clearAllBtn').addEventListener('click', () => {
        localStorage.removeItem(NICK_KEY);
        for (const key of CONFIG_KEYS) localStorage.removeItem(key);
        // persisted host logins and remembered channel passwords (one key per
        // channel) go with "everything"
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('vc_host_token_') || key.startsWith('vc_chan_pw_')) localStorage.removeItem(key);
        }
        close();
        toast(t('index.cleared'), 'ok');
    });
}

function toast(message, kind = '') {
    const node = el('div', { class: `toast ${kind}`, text: message });
    $('#toasts').append(node);
    setTimeout(() => node.remove(), 3200);
}

function renderCard(channel) {
    const busy = channel.online >= channel.maxParticipants;
    return el(
        'a',
        { class: 'channel-card', href: `/c/${encodeURIComponent(channel.id)}` },
        el(
            'div',
            { class: 'channel-card-top' },
            el('h3', { text: channel.name || channel.id }),
            channel.temporary
                ? el('span', { class: 'badge temp', text: t('index.tempBadge') })
                : null,
            channel.hasPassword
                ? el('span', { class: 'badge lock', title: t('index.locked'), text: '🔒' })
                : null,
            el(
                'span',
                { class: 'channel-online' + (busy ? ' busy' : '') },
                el('span', { class: 'dot' }),
                t('index.online', { n: channel.online })
            )
        ),
        el('p', { class: 'channel-card-desc', text: channel.description || '' }),
        el(
            'div',
            { class: 'channel-card-foot' },
            el('span', { class: 'channel-id-tag', text: `# ${channel.id}` }),
            el('span', { class: 'btn primary sm', text: t('index.join') })
        )
    );
}
