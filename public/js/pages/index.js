/**
 * 首页 — 公开频道列表，轮询在线人数。其上是纯本地的
 * 导航辅助：对已加载列表的实时搜索、按频道收藏
 * 与「最近访问」一行（全部存 localStorage，
 * 不涉及服务器状态）。
 */

import { api } from '/js/core/api.js';
import { initI18n, t, getLang, setLang } from '/js/core/i18n.js';
import { getThemePref, setThemePref } from '/js/core/theme.js';
import { initVersionCheck } from '/js/core/version.js';
import { $, el, toast } from '/js/core/utils.js';

const POLL_MS = 15000;

// 本应用按浏览器存储的全部键；昵称可单独清除。
// 主题偏好（vc_theme）刻意不列入 ——「清除全部」
// 必须保留用户的配色选择。
const NICK_KEY = 'vc_nick';
const CONFIG_KEYS = [
    'vc_audio_settings',
    'vc_peer_volumes',
    'vc_avatar',
    'vc_send_key',
    'vc_sound_settings',
    'vc_notify',
    'vc_fav_channels',
    'vc_recent_channels',
];
const FAV_KEY = 'vc_fav_channels'; // [频道 ID]
const RECENT_KEY = 'vc_recent_channels'; // [{id, ts}] 新的在前
const RECENT_MAX = 6;

const MOON_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
const SUN_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const AUTO_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/></svg>';
const STAR_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

boot();

async function boot() {
    await initI18n();
    initVersionCheck();
    bindThemeToggle();
    bindLangSwitch();
    bindClearData();
    bindCreateTemp();
    bindSearch();
    await load();
    setInterval(load, POLL_MS);
}

// ----- dark/light/auto 主题胶囊按钮（顶栏）—— 在三态间循环切换

function bindThemeToggle() {
    const button = $('#themeBtn');
    const icon = button.querySelector('.theme-icon');
    const label = button.querySelector('.theme-label');
    const render = () => {
        const pref = getThemePref(); // dark | light | auto
        icon.innerHTML = pref === 'light' ? SUN_SVG : pref === 'auto' ? AUTO_SVG : MOON_SVG;
        label.textContent = t(
            pref === 'light' ? 'index.themeLight' : pref === 'auto' ? 'index.themeAuto' : 'index.themeDark'
        );
    };
    button.addEventListener('click', () => {
        const order = ['dark', 'light', 'auto'];
        setThemePref(order[(order.indexOf(getThemePref()) + 1) % order.length]);
        render();
    });
    render();
}

// ----- 语言切换（双向开关；切换后重载页面，让所有静态文案一并翻转）

function bindLangSwitch() {
    const wrap = $('#langSwitch');
    const render = () => {
        for (const btn of wrap.querySelectorAll('.lang-opt')) {
            btn.classList.toggle('active', btn.dataset.lang === getLang());
        }
    };
    wrap.addEventListener('click', (event) => {
        const lang = event.target.closest('.lang-opt')?.dataset.lang;
        if (lang && lang !== getLang()) setLang(lang);
    });
    render();
}

// ----- 临时房间：访问一个全新的 /c/<id> 即可生成；服务器在首次
// join 时于内存中创建它，最后一个成员离开即销毁 -----

function bindCreateTemp() {
    $('#createTempBtn').addEventListener('click', () => {
        const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // 与服务器一致的无歧义字符集
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        let id = '';
        for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
        location.href = `/c/${id}`;
    });
}

// ----- 收藏 + 最近访问（仅 localStorage） -----

function loadList(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function loadFavorites() {
    return loadList(FAV_KEY).filter((id) => typeof id === 'string');
}

function toggleFavorite(id) {
    const favs = loadFavorites();
    const at = favs.indexOf(id);
    if (at === -1) favs.unshift(id);
    else favs.splice(at, 1);
    localStorage.setItem(FAV_KEY, JSON.stringify(favs.slice(0, 50)));
    render();
}

function noteVisit(id) {
    const recent = loadList(RECENT_KEY).filter((item) => item && item.id !== id);
    recent.unshift({ id, ts: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)));
}

// 拦截所有频道卡片链接，让访问在跳转前先记入「最近访问」
document.addEventListener('click', (event) => {
    const card = event.target.closest?.('a.channel-card');
    if (card?.dataset?.id) noteVisit(card.dataset.id);
});

// ----- 对已加载列表的实时搜索 -----

let searchQuery = '';

function bindSearch() {
    $('#channelSearch').addEventListener('input', (event) => {
        searchQuery = event.target.value.trim().toLowerCase();
        render();
    });
}

async function load() {
    try {
        const { channels, settings } = await api.getPublicChannels();
        $('#statusHint').textContent = '';
        // 管理员已关闭临时房间 —— 隐藏生成入口
        $('#createTempBtn').classList.toggle('hidden', settings?.tempRooms === false);
        cache = Array.isArray(channels) ? channels : [];
        render();
    } catch {
        $('#statusHint').textContent = t('index.loadError');
    }
}

let cache = [];

function matches(channel) {
    if (!searchQuery) return true;
    return (
        (channel.name || '').toLowerCase().includes(searchQuery) ||
        channel.id.toLowerCase().includes(searchQuery) ||
        (channel.description || '').toLowerCase().includes(searchQuery)
    );
}

function render() {
    const grid = $('#channelGrid');
    const shown = cache.filter(matches);
    grid.replaceChildren(...shown.map(renderCard));
    $('#emptyState').classList.toggle('hidden', cache.length > 0);

    renderGroupRow(
        $('#recentRow'),
        $('#recentGrid'),
        loadList(RECENT_KEY).map((item) => item.id)
    );
    renderGroupRow($('#favRow'), $('#favGrid'), loadFavorites());
}

/** 单个可选分组行（收藏 / 最近访问）；无卡片时隐藏。 */
function renderGroupRow(row, grid, ids) {
    const byId = new Map(cache.map((channel) => [channel.id, channel]));
    // 搜索词同样过滤分组；未知 ID（已删除/临时房间）自然淘汰
    const cards = [...new Set(ids)]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .filter(matches);
    row.classList.toggle('hidden', cards.length === 0);
    grid.replaceChildren(...cards.map((channel) => renderCard(channel)));
}

// ----- 清除本地用户数据（仅昵称，或昵称 + 全部设置） -----

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
        // 持久化的主持人登录凭据与记住的频道密码（每频道一个键）
        // 随「清除全部」一并清理
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('vc_host_token_') || key.startsWith('vc_chan_pw_')) localStorage.removeItem(key);
        }
        close();
        toast(t('index.cleared'), 'ok');
        render();
    });
}

function renderCard(channel) {
    const busy = channel.online >= channel.maxParticipants;
    const favs = loadFavorites();
    const fav = favs.includes(channel.id);
    return el(
        'a',
        { class: 'channel-card', href: `/c/${encodeURIComponent(channel.id)}`, dataset: { id: channel.id } },
        el(
            'div',
            { class: 'channel-card-top' },
            el('h3', { text: channel.name || channel.id }),
            channel.temporary ? el('span', { class: 'badge temp', text: t('index.tempBadge') }) : null,
            channel.hasPassword ? el('span', { class: 'badge lock', title: t('index.locked'), text: '🔒' }) : null,
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
            el(
                'span',
                { class: 'channel-card-actions' },
                el('button', {
                    class: 'fav-btn' + (fav ? ' on' : ''),
                    type: 'button',
                    title: fav ? t('index.unfavorite') : t('index.favorite'),
                    'aria-label': 'favorite',
                    html: STAR_SVG,
                    onclick: (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleFavorite(channel.id);
                    },
                }),
                el('span', { class: 'btn primary sm', text: t('index.join') })
            )
        )
    );
}
