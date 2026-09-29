/**
 * Homepage — public channel list, polled for online counts.
 */

import { api } from '/js/core/api.js';
import { initI18n, t } from '/js/core/i18n.js';
import { $, el } from '/js/core/utils.js';

const POLL_MS = 15000;

boot();

async function boot() {
    await initI18n();
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
