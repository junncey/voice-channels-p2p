/**
 * Admin console — channel CRUD + host management.
 */

import { api, getAdminToken, setAdminToken } from '/js/core/api.js';
import { initI18n, t } from '/js/core/i18n.js';
import { $, el, formatDate } from '/js/core/utils.js';

const POLL_MS = 10000;

let channels = [];
let editingId = null; // null = creating
let pendingDelete = null;

boot();

async function boot() {
    await initI18n();
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
        $('#loadError').textContent = '';
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

function renderTable() {
    const rows = $('#channelRows');
    $('#adminEmpty').classList.toggle('hidden', channels.length > 0);

    rows.replaceChildren(
        ...channels.map((channel) =>
            el(
                'tr',
                {},
                el('td', { class: 'name-cell', text: channel.name || channel.id }),
                el('td', { class: 'id-cell', text: channel.id }),
                el(
                    'td',
                    {},
                    el('span', {
                        class: 'badge' + (channel.public ? ' on' : ''),
                        text: channel.public ? t('admin.publicYes') : t('admin.publicNo'),
                    })
                ),
                el(
                    'td',
                    { class: 'count-cell' + (channel.online ? '' : ' zero') },
                    String(channel.online ?? 0)
                ),
                el(
                    'td',
                    { class: 'hosts-cell', title: (channel.hosts || []).join(', ') || '—' },
                    (channel.hosts || []).join(', ') || '—'
                ),
                el('td', { class: 'updated-cell', text: formatDate(channel.updatedAt) }),
                el(
                    'td',
                    { class: 'actions-cell' },
                    el('button', {
                        class: 'btn ghost sm',
                        text: t('admin.edit'),
                        onclick: () => openEditor(channel),
                    }),
                    el('button', {
                        class: 'btn danger sm',
                        text: t('admin.delete'),
                        onclick: () => confirmDelete(channel),
                    })
                )
            )
        )
    );
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
    $('#fPublic').checked = channel ? channel.public !== false : true;

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
    $('#confirmText').textContent = t('admin.deleteConfirm', {
        name: channel.name || channel.id,
        n: channel.online ?? 0,
    });
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
