/**
 * Homepage — public channel list, polled for online counts.
 */

import { api } from '/js/core/api.js';
import { initI18n, t } from '/js/core/i18n.js';
import { $, el } from '/js/core/utils.js';

const POLL_MS = 15000;

// everything this app stores per-browser; nickname can be cleared separately
const NICK_KEY = 'vc_nick';
const CONFIG_KEYS = ['vc_audio_settings', 'vc_peer_volumes'];

boot();

async function boot() {
    await initI18n();
    bindClearData();
    await load();
    setInterval(load, POLL_MS);
}

async function load() {
    const grid = $('#channelGrid');
    try {
        const { channels } = await api.getPublicChannels();
        $('#statusHint').textContent = '';

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
