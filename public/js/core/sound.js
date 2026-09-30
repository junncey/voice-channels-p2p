/**
 * Operation sound effects — short chimes for channel activity: peer join /
 * leave, incoming chat messages, mic on/off feedback. Built-in files ship in
 * /sounds (taken from upstream MiroTalk); every event can be re-pointed at
 * another built-in or at a user-uploaded audio file. Custom files are kept
 * ONLY in this browser's localStorage (validated data:audio/ URLs) and are
 * never sent to the server or other peers.
 *
 * Settings (vc_sound_settings): { enabled, volume, events: { peerJoin: { on,
 * sound, custom }, … } } — sound is a library file name or 'custom'.
 */

import { createDropdown } from '/js/core/dropdown.js';
import { t } from '/js/core/i18n.js';
import { $, el } from '/js/core/utils.js';

const SETTINGS_KEY = 'vc_sound_settings';
const CUSTOM_MAX_BYTES = 512 * 1024; // uploaded sound file size cap
const CUSTOM_MAX_CHARS = 700 * 1024; // its base64 data URL length cap
// only ever handed to new Audio() as a source — but validate anyway so a
// hand-edited localStorage value can't smuggle in a non-audio URL
const AUDIO_DATA_URL_RE = /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

/** Built-in sound library — file names under /sounds (from upstream MiroTalk). */
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

/** App events that can chime, and their default library sound. */
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
let sinkRouter = null; // (audioEl) => void, routes playback to the selected speaker
let uploadTarget = null; // event key awaiting the custom-sound file picker
let fileInputEl = null; // hidden <input type="file"> for custom sound uploads

// ---------------------------------------------------------------------------
// settings persistence
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
        return false; // storage full / disabled — settings live for this session only
    }
}

// ---------------------------------------------------------------------------
// playback
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
 * Play an event's chime. { force } bypasses the master/per-event switches
 * (used by the settings preview) but never throws — a blocked autoplay or a
 * missing file just stays silent.
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
// settings UI (channel settings modal)
// ---------------------------------------------------------------------------

/**
 * Wire the sound section of the channel settings modal. Call after initI18n.
 * @param {object} options
 * @param {function(HTMLAudioElement):void} options.applySink route playback to the selected output device
 * @param {function(string,string):void} options.toast error reporting (message, kind)
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
        fileInputEl.value = ''; // allow re-picking the same file
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

/** Store a user-picked audio file as this event's custom sound. '' = ok. */
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
        settings.events[eventKey] = previous; // quota exceeded — don't keep what wasn't stored
        return 'sound.storageFull';
    }
    playSound(eventKey, { force: true }); // immediate confirmation
    return '';
}
