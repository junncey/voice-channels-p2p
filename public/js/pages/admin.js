/**
 * Admin console — channel CRUD + host management.
 */

import { api, getAdminToken, setAdminToken } from '/js/core/api.js';
import { initI18n, t } from '/js/core/i18n.js';
import { initVersionCheck } from '/js/core/version.js';
import { $, el, formatDate } from '/js/core/utils.js';

const POLL_MS = 10000;

let channels = [];
let temps = [];
let editingId = null; // null = creating
let pendingDelete = null;
let settingsSaving = false; // don't clobber the toggle from a poll mid-save
const expandedRooms = new Set(); // channel ids whose member list row is open

boot();

async function boot() {
    await initI18n();
    initVersionCheck();
    bindUi();

    if (getAdminToken()) {
        showConsole();
    } else {
        showLogin();
    }
}

function bindUi() {
    $('#loginForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        $('#loginError').textContent = '';
        try {
            const { token } = await api.adminLogin($('#adminPass').value);
            setAdminToken(token);
            showConsole();
        } catch {
            $('#loginError').textContent = t('admin.loginFailed');
        }
    });

    $('#logoutBtn').addEventListener('click', () => {
        setAdminToken(null);
        location.reload();
    });

    $('#newChannelBtn').addEventListener('click', () => openEditor(null));
    $('#editorCancel').addEventListener('click', closeEditor);
    $('#editorForm').addEventListener('submit', onEditorSubmit);
    $('#addHostBtn').addEventListener('click', () => addHostRow('', ''));

    $('#tempSettingsBtn').addEventListener('click', openSettings);
    $('#settingsCancel').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
    $('#settingsForm').addEventListener('submit', onSettingsSubmit);

    $('#backupBtn').addEventListener('click', async () => {
        try {
            await api.adminBackup();
            toast(t('admin.backupDone'), 'ok');
        } catch {
            toast(t('common.error'), 'error');
        }
    });

    $('#confirmCancel').addEventListener('click', () => {
        pendingDelete = null;
        $('#confirmModal').classList.add('hidden');
    });
    $('#confirmOk').addEventListener('click', onDeleteConfirm);
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

function showLogin() {
    $('#loginView').classList.remove('hidden');
    $('#consoleView').classList.add('hidden');
    $('#adminPass').focus();
}

function showConsole() {
    $('#loginView').classList.add('hidden');
    $('#consoleView').classList.remove('hidden');
    load();
    clearInterval(showConsole._timer);
    showConsole._timer = setInterval(load, POLL_MS);
}

// ---------------------------------------------------------------------------
// channel table
// ---------------------------------------------------------------------------

async function load() {
    try {
        const data = await api.adminChannels();
        channels = data.channels || [];
        temps = data.temps || [];
        $('#loadError').textContent = '';
        syncSettingsFields(data.settings);
        renderTable();
    } catch (err) {
        if (err.status === 401) {
            setAdminToken(null);
            showLogin();
            return;
        }
        $('#loadError').textContent = t('admin.loadError');
    }
}

/** Reflect server settings in the form — unless a save is in flight. */
function syncSettingsFields(settings) {
    if (settingsSaving || !settings) return;
    $('#sTempRooms').checked = settings.tempRooms !== false;
    $('#sTempMaxRooms').value = settings.tempMaxRooms ?? 1000;
    $('#sTempMaxPerIp').value = settings.tempMaxPerIp ?? 3;
    $('#sTempCreateMax').value = settings.tempCreateMax ?? 5;
    $('#sTempCreateWindowMin').value = settings.tempCreateWindowMin ?? 10;
    $('#sSocketMaxChannels').value = settings.socketMaxChannels ?? 2;
    $('#sChatRetentionHours').value = settings.chatRetentionHours ?? 24;
}

function openSettings() {
    $('#settingsError').textContent = '';
    $('#settingsModal').classList.remove('hidden');
}

async function onSettingsSubmit(event) {
    event.preventDefault();
    $('#settingsError').textContent = '';
    settingsSaving = true;
    try {
        const { settings } = await api.adminUpdateSettings({
            tempRooms: $('#sTempRooms').checked,
            tempMaxRooms: Number($('#sTempMaxRooms').value),
            tempMaxPerIp: Number($('#sTempMaxPerIp').value),
            tempCreateMax: Number($('#sTempCreateMax').value),
            tempCreateWindowMin: Number($('#sTempCreateWindowMin').value),
            socketMaxChannels: Number($('#sSocketMaxChannels').value),
            chatRetentionHours: Number($('#sChatRetentionHours').value),
        });
        syncSettingsFields(settings);
        $('#settingsModal').classList.add('hidden');
        toast(t('admin.settingsSaved'), 'ok');
        load();
    } catch (err) {
        $('#settingsError').textContent = err.message || t('admin.settingsError');
    } finally {
        settingsSaving = false;
    }
}

function renderTable() {
    const rows = $('#channelRows');
    $('#adminEmpty').classList.toggle('hidden', channels.length + temps.length > 0);

    const out = [];
    const pushWithMembers = (channel, isTemp) => {
        out.push(channelRow(channel, isTemp));
        if (expandedRooms.has(channel.id)) out.push(membersRow(channel, isTemp));
    };
    // registered channels first, then live temporary rooms (deletable only)
    channels.forEach((channel) => pushWithMembers(channel, false));
    temps.forEach((channel) => pushWithMembers(channel, true));
    rows.replaceChildren(...out);
}

function channelRow(channel, isTemp) {
    return el(
        'tr',
        {},
        el(
            'td',
            { class: 'name-cell' },
            channel.name || channel.id,
            channel.hasPassword ? el('span', { class: 'pw-flag', title: t('admin.hasPassword'), text: '🔒' }) : null
        ),
        el('td', { class: 'id-cell', text: channel.id }),
        el(
            'td',
            {},
            isTemp
                ? el('span', { class: 'badge temp', text: t('admin.temporary') })
                : el('span', {
                      class: 'badge' + (channel.public ? ' on' : ''),
                      text: channel.public ? t('admin.publicYes') : t('admin.publicNo'),
                  })
        ),
        el(
            'td',
            { class: 'count-cell' },
            el(
                'button',
                {
                    class: 'count-toggle' + ((channel.online ?? 0) > 0 ? ' has-members' : ''),
                    title: t('admin.members'),
                    onclick: () => {
                        if (expandedRooms.has(channel.id)) expandedRooms.delete(channel.id);
                        else expandedRooms.add(channel.id);
                        renderTable();
                    },
                },
                String(channel.online ?? 0)
            )
        ),
        el(
            'td',
            { class: 'hosts-cell', title: isTemp ? '—' : (channel.hosts || []).join(', ') || '—' },
            isTemp ? '—' : (channel.hosts || []).join(', ') || '—'
        ),
        el('td', { class: 'updated-cell', text: formatDate(isTemp ? channel.createdAt : channel.updatedAt) }),
        el(
            'td',
            { class: 'actions-cell' },
            // temp rooms have no editable config — they can only be destroyed
            ...(isTemp
                ? []
                : [
                      el('button', {
                          class: 'btn ghost sm',
                          text: t('admin.edit'),
                          onclick: () => openEditor(channel),
                      }),
                  ]),
            el('button', {
                class: 'btn danger sm',
                text: t('admin.delete'),
                onclick: () => confirmDelete(channel),
            })
        )
    );
}

/** Expandable sub-row: live member list with per-member kick. */
function membersRow(channel) {
    const members = channel.members || [];
    const cell = el('td', { colspan: '7', class: 'members-cell' });
    const content = [];
    if (!members.length) {
        content.push(el('span', { class: 'members-empty', text: t('admin.membersEmpty') }));
    } else {
        content.push(
            ...members.map((member) =>
                el(
                    'div',
                    { class: 'member-pill' + (member.ghost ? ' ghost' : '') },
                    el('span', { class: 'member-pill-name', text: member.name || '?' }),
                    member.presenter ? el('span', { class: 'badge host', text: t('channel.hostBadge') }) : null,
                    member.ghost ? el('span', { class: 'badge ghost-badge', text: t('admin.memberGhost') }) : null,
                    el(
                        'button',
                        {
                            class: 'btn danger sm',
                            text: t('admin.kick'),
                            onclick: () => kickMember(channel.id, member),
                        }
                    )
                )
            )
        );
    }
    // flex lives on the wrapper, never on the td (that would kill colspan)
    cell.append(el('div', { class: 'members-wrap' }, ...content));
    return el('tr', { class: 'members-row' }, cell);
}

async function kickMember(channelId, member) {
    try {
        await api.adminKick(channelId, member.uuid);
        toast(t('admin.kicked', { name: member.name || '?' }), 'ok');
        load();
    } catch (err) {
        toast(err.message || t('common.error'), 'error');
    }
}

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------

function openEditor(channel) {
    editingId = channel ? channel.id : null;
    $('#editorTitle').textContent = channel
        ? `${t('admin.edit')} · ${channel.name || channel.id}`
        : t('admin.newChannel');
    $('#editorSubmit').textContent = channel ? t('admin.save') : t('admin.create');
    $('#editorError').textContent = '';

    $('#idField').classList.toggle('hidden', !!channel);
    $('#fId').value = channel ? channel.id : '';
    $('#fId').disabled = !!channel;
    $('#fName').value = channel ? channel.name : '';
    $('#fDesc').value = channel ? channel.description || '' : '';
    $('#fMax').value = channel ? channel.maxParticipants || 8 : 8;
    // per-channel retention override: '' = inherit the global setting
    $('#fRetention').value = channel?.chatRetentionHours != null ? String(channel.chatRetentionHours) : '';
    $('#fPublic').checked = channel ? channel.public !== false : true;

    // channel password: never echoed back — blank keeps the stored one, an
    // explicit checkbox clears it (only offered when one is set)
    $('#fPassword').value = '';
    const hasPassword = !!channel?.hasPassword;
    $('#pwHint').textContent = editingId && hasPassword
        ? t('admin.field.passwordEditHint')
        : t('admin.field.passwordCreateHint');
    $('#fClearPwRow').classList.toggle('hidden', !(editingId && hasPassword));
    $('#fClearPw').checked = false;

    const hostRows = $('#hostRows');
    hostRows.replaceChildren();
    if (channel && channel.hosts?.length) {
        channel.hosts.forEach((username) => addHostRow(username, ''));
    } else {
        addHostRow('', '');
    }

    $('#editorModal').classList.remove('hidden');
    if (!channel) $('#fId').focus();
    else $('#fName').focus();
}

function addHostRow(username = '', password = '') {
    const row = el('div', { class: 'host-row' });
    const user = el('input', {
        class: 'input',
        maxlength: 32,
        value: username,
        autocomplete: 'off',
    });
    const pass = el('input', {
        class: 'input',
        type: 'password',
        maxlength: 64,
        value: password,
        autocomplete: 'new-password',
    });
    user.setAttribute('placeholder', t('admin.field.hostUsername'));
    pass.setAttribute('placeholder', editingId ? t('admin.field.hostPasswordKeep') : t('admin.field.hostPassword'));
    row.append(
        user,
        pass,
        el('button', { class: 'btn danger sm', type: 'button', text: '✕', onclick: () => row.remove() })
    );
    $('#hostRows').append(row);
}

function collectHosts() {
    return [...$('#hostRows').querySelectorAll('.host-row')]
        .map((row) => {
            const [user, pass] = row.querySelectorAll('input');
            return { username: user.value.trim(), password: pass.value };
        })
        .filter((h) => h.username || h.password);
}

function closeEditor() {
    editingId = null;
    $('#editorModal').classList.add('hidden');
}

async function onEditorSubmit(event) {
    event.preventDefault();
    $('#editorError').textContent = '';

    const body = {
        name: $('#fName').value.trim(),
        description: $('#fDesc').value.trim(),
        public: $('#fPublic').checked,
        maxParticipants: Number($('#fMax').value) || 8,
        hosts: collectHosts(),
    };
    if (!editingId) body.id = $('#fId').value.trim();

    // retention override: '' = inherit (null), otherwise an hour count
    const retention = $('#fRetention').value.trim();
    if (retention !== '') body.chatRetentionHours = Number(retention);
    else if (editingId) body.chatRetentionHours = null; // editing: blank clears the override

    // channel password tri-state: filled = set/replace, '' = clear (checkbox),
    // omitted = leave unchanged
    const password = $('#fPassword').value;
    if (password) body.password = password;
    else if (editingId && $('#fClearPw').checked) body.password = '';

    try {
        if (editingId) {
            await api.adminUpdateChannel(editingId, body);
            toast(t('admin.saved'), 'ok');
        } else {
            const { channel } = await api.adminCreateChannel(body);
            // surface the id — it may have been auto-generated
            toast(t('admin.created', { id: channel.id }), 'ok');
        }
        closeEditor();
        load();
    } catch (err) {
        $('#editorError').textContent = err.message || t('common.error');
    }
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

function confirmDelete(channel) {
    pendingDelete = channel;
    $('#confirmText').textContent = channel.temporary
        ? t('admin.deleteTempConfirm', { name: channel.name || channel.id, n: channel.online ?? 0 })
        : t('admin.deleteConfirm', { name: channel.name || channel.id, n: channel.online ?? 0 });
    $('#confirmModal').classList.remove('hidden');
}

async function onDeleteConfirm() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    pendingDelete = null;
    $('#confirmModal').classList.add('hidden');
    try {
        await api.adminDeleteChannel(id);
        toast(t('admin.deleted'), 'ok');
        load();
    } catch (err) {
        toast(err.message || t('common.error'), 'error');
    }
}

// ---------------------------------------------------------------------------

function toast(message, kind = '') {
    const node = el('div', { class: `toast ${kind}`, text: message });
    $('#toasts').append(node);
    setTimeout(() => node.remove(), 3200);
}
