/**
 * REST client. Admin JWT is kept in sessionStorage (per tab, cleared on close).
 */

const ADMIN_TOKEN_KEY = 'vc_admin_token';

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export const getAdminToken = () => sessionStorage.getItem(ADMIN_TOKEN_KEY);
export const setAdminToken = (token) =>
    token ? sessionStorage.setItem(ADMIN_TOKEN_KEY, token) : sessionStorage.removeItem(ADMIN_TOKEN_KEY);

async function request(path, { method = 'GET', body, admin = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (admin) {
        const token = getAdminToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        if (res.status === 401 && admin) setAdminToken(null);
        throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
    }
    return data;
}

export const api = {
    /* public */
    getPublicChannels: () => request('/api/channels'),
    getChannel: (id) => request(`/api/channels/${encodeURIComponent(id)}`),

    /* host */
    hostLogin: (channelId, username, password) =>
        request('/api/host/login', { method: 'POST', body: { channelId, username, password } }),

    /* admin */
    adminLogin: (password) => request('/api/admin/login', { method: 'POST', body: { password } }),
    adminChannels: () => request('/api/admin/channels', { admin: true }),
    adminGetSettings: () => request('/api/admin/settings', { admin: true }),
    adminUpdateSettings: (body) => request('/api/admin/settings', { method: 'PUT', body, admin: true }),
    adminCreateChannel: (body) => request('/api/admin/channels', { method: 'POST', body, admin: true }),
    adminUpdateChannel: (id, body) =>
        request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'PUT', body, admin: true }),
    adminDeleteChannel: (id) =>
        request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
    adminKick: (channel, uuid) =>
        request('/api/admin/kick', { method: 'POST', body: { channel, uuid }, admin: true }),

    /** Download the server backup (channels.json + chat history) as tar.gz. */
    adminBackup() {
        return fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${getAdminToken()}` } }).then(
            async (res) => {
                if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
                const url = URL.createObjectURL(await res.blob());
                const link = document.createElement('a');
                const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1];
                link.href = url;
                link.download = name || 'voice-channels-backup.tar.gz';
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
            }
        );
    },

    /** Download the channel chat history as Markdown (host token required). */
    hostExport(channelId, hostToken) {
        return fetch(`/api/host/${encodeURIComponent(channelId)}/export`, {
            headers: { Authorization: `Bearer ${hostToken}` },
        }).then(async (res) => {
            if (res.status === 404) throw new ApiError('not found', 404);
            if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
            const url = URL.createObjectURL(await res.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = `chat-${channelId}.md`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
    },
};
