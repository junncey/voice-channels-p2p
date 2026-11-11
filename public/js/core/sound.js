/**
 * 操作音效——频道活动的短提示音：peer 加入/离开、
 * 收到聊天消息、麦克风开/关反馈。内置文件位于 /sounds
 * （取自上游 MiroTalk）；每个事件都可以改指向另一个内置音
 * 或用户上传的音频文件。自定义文件只保存在本浏览器的
 * localStorage（经校验的 data:audio/ URL），
 * 绝不发送到服务器或其他 peer。
 *
 * 设置（vc_sound_settings）：{ enabled, volume, events: { peerJoin: { on,
 * sound, custom }, … } } — sound 是库文件名或 'custom'。
 */

import { createDropdown } from '/js/core/dropdown.js';
import { t } from '/js/core/i18n.js';
import { $, el } from '/js/core/utils.js';

const SETTINGS_KEY = 'vc_sound_settings';
const CUSTOM_MAX_BYTES = 512 * 1024; // 上传音效文件的大小上限
const CUSTOM_MAX_CHARS = 700 * 1024; // 其 base64 data URL 长度上限
// 只会作为源交给 new Audio()——但仍然校验，
// 防止手改过的 localStorage 值夹带非音频 URL
const AUDIO_DATA_URL_RE = /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

/** 内置音效库——/sounds 下的文件名（来自上游 MiroTalk）。 */
export const SOUND_LIBRARY = [
    'addPeer',
    'removePeer',
    'newMessage',
    'chatMessage',
    'notify',
    'alert',
    'ok',
    'on',
    'off',
    'click',
    'switch',
    'locked',
    'eject',
];

/** 可发声的应用事件及其默认库音效。 */
export const SOUND_EVENTS = [
    { key: 'peerJoin', sound: 'addPeer', label: 'sound.eventPeerJoin' },
    { key: 'peerLeave', sound: 'removePeer', label: 'sound.eventPeerLeave' },
    { key: 'message', sound: 'newMessage', label: 'sound.eventMessage' },
    { key: 'micOn', sound: 'on', label: 'sound.eventMicOn' },
    { key: 'micOff', sound: 'off', label: 'sound.eventMicOff' },
];

const UPLOAD_OPTION = '__upload__';
const PLAY_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>';

let settings = loadSettings();
let sinkRouter = null; // (audioEl) => void，把播放路由到选中的扬声器
let uploadTarget = null; // 等待自定义音效文件选择器的事件键
let fileInputEl = null; // 用于自定义音效上传的隐藏 <input type="file">

// ---------------------------------------------------------------------------
// 设置持久化
// ---------------------------------------------------------------------------

function defaultSettings() {
    return {
        enabled: true,
        volume: 0.5,
        events: Object.fromEntries(SOUND_EVENTS.map((def) => [def.key, { on: true, sound: def.sound, custom: '' }])),
    };
}

function loadSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        const events = Object.fromEntries(
            SOUND_EVENTS.map((def) => [def.key, { on: true, sound: def.sound, custom: '' }])
        );
        if (stored && typeof stored.events === 'object' && stored.events) {
            for (const def of SOUND_EVENTS) {
                const ev = stored.events[def.key];
                if (!ev || typeof ev !== 'object') continue;
                events[def.key] = {
                    on: ev.on !== false,
                    sound: SOUND_LIBRARY.includes(ev.sound) || ev.sound === 'custom' ? ev.sound : def.sound,
                    custom:
                        typeof ev.custom === 'string' &&
                        ev.custom.length <= CUSTOM_MAX_CHARS &&
                        AUDIO_DATA_URL_RE.test(ev.custom)
                            ? ev.custom
                            : '',
                };
            }
        }
        return {
            enabled: stored.enabled !== false,
            volume: typeof stored.volume === 'number' && stored.volume >= 0 && stored.volume <= 1 ? stored.volume : 0.5,
            events,
        };
    } catch {
        return defaultSettings();
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        return true;
    } catch {
        return false; // 存储已满/被禁用——设置仅在本会话内有效
    }
}

// ---------------------------------------------------------------------------
// 播放
// ---------------------------------------------------------------------------

function sourceFor(eventKey) {
    const ev = settings.events[eventKey];
    if (!ev) return '';
    if (ev.sound === 'custom' && ev.custom) return ev.custom;
    if (SOUND_LIBRARY.includes(ev.sound)) return `/sounds/${ev.sound}.mp3`;
    const def = SOUND_EVENTS.find((d) => d.key === eventKey);
    return def ? `/sounds/${def.sound}.mp3` : '';
}

/**
 * 播放某事件的提示音。{ force } 绕过总开关/单事件开关
 * （设置预览用），但绝不抛错——自动播放被拦或文件缺失
 * 只会静默无声。
 */
export function playSound(event, { force = false } = {}) {
    const ev = settings.events[event];
    if (!ev || (!force && (!settings.enabled || !ev.on))) return;
    const url = sourceFor(event);
    if (!url) return;
    const audio = new Audio(url);
    audio.volume = Math.min(1, Math.max(0, settings.volume));
    if (sinkRouter) sinkRouter(audio);
    audio.play().catch(() => {});
}

// ---------------------------------------------------------------------------
// 设置 UI（频道设置弹窗）
// ---------------------------------------------------------------------------

/**
 * 绑定频道设置弹窗的音效区块。在 initI18n 之后调用。
 * @param {object} options
 * @param {function(HTMLAudioElement):void} options.applySink 把播放路由到选中的输出设备
 * @param {function(string,string):void} options.toast 错误上报（message, kind）
 */
export function initSoundSettings({ applySink = null, toast = () => {} } = {}) {
    sinkRouter = applySink;

    const toggle = $('#soundToggle');
    const slider = $('#soundVolumeSlider');
    toggle.checked = settings.enabled;
    slider.value = String(Math.round(settings.volume * 100));
    $('#soundVolumeVal').textContent = `${Math.round(settings.volume * 100)}%`;

    toggle.addEventListener('change', () => {
        settings.enabled = toggle.checked;
        saveSettings();
    });
    slider.addEventListener('input', () => {
        settings.volume = Number(slider.value) / 100;
        $('#soundVolumeVal').textContent = `${slider.value}%`;
        saveSettings();
    });

    fileInputEl = el('input', { type: 'file', accept: 'audio/*', class: 'hidden', 'aria-hidden': 'true' });
    document.body.append(fileInputEl);
    fileInputEl.addEventListener('change', async () => {
        const file = fileInputEl.files?.[0];
        fileInputEl.value = ''; // 允许重复选择同一个文件
        const target = uploadTarget;
        uploadTarget = null;
        if (!file || !target) return;
        const error = await importCustomSound(target, file);
        if (error) toast(t(error), 'warn');
        renderEventRows();
    });

    renderEventRows();
}

function renderEventRows() {
    const list = $('#soundEventList');
    if (!list) return;
    list.replaceChildren(
        ...SOUND_EVENTS.map((def) => {
            const ev = settings.events[def.key];
            const dropdown = createDropdown({
                getItems: () => [
                    ...SOUND_LIBRARY.map((name) => ({ value: name, label: name })),
                    ...(ev.custom ? [{ value: 'custom', label: t('sound.custom') }] : []),
                    { value: UPLOAD_OPTION, label: t('sound.upload') },
                ],
                getValue: () => ev.sound,
                onSelect: (value) => {
                    if (value === UPLOAD_OPTION) {
                        uploadTarget = def.key;
                        fileInputEl?.click();
                        return;
                    }
                    ev.sound = value;
                    saveSettings();
                },
            });
            return el(
                'div',
                { class: 'sound-event' + (ev.on ? '' : ' off') },
                el('button', {
                    class: 'icon-btn sound-preview-btn',
                    type: 'button',
                    title: t('sound.preview'),
                    'aria-label': t('sound.preview'),
                    html: PLAY_SVG,
                    onclick: () => playSound(def.key, { force: true }),
                }),
                el('span', { class: 'sound-event-name', text: t(def.label) }),
                el('div', { class: 'sound-event-pick' }, dropdown.el),
                el('input', {
                    type: 'checkbox',
                    class: 'switch',
                    checked: ev.on ? '' : undefined,
                    'aria-label': t(def.label),
                    onchange: (event) => {
                        ev.on = event.target.checked;
                        saveSettings();
                        event.target.closest('.sound-event')?.classList.toggle('off', !ev.on);
                    },
                })
            );
        })
    );
}

/** 把用户选择的音频文件存为该事件的自定义音效。'' = 成功。 */
async function importCustomSound(eventKey, file) {
    if (!file.type.startsWith('audio/')) return 'sound.unsupported';
    if (file.size > CUSTOM_MAX_BYTES) return 'sound.tooLarge';
    const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
    });
    if (!dataUrl || !AUDIO_DATA_URL_RE.test(dataUrl) || dataUrl.length > CUSTOM_MAX_CHARS) return 'sound.unsupported';

    const previous = { ...settings.events[eventKey] };
    settings.events[eventKey].custom = dataUrl;
    settings.events[eventKey].sound = 'custom';
    if (!saveSettings()) {
        settings.events[eventKey] = previous; // 配额超限——没存进去的就别保留
        return 'sound.storageFull';
    }
    playSound(eventKey, { force: true }); // 即时确认
    return '';
}
