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
    adminCreateChannel: (body) => request('/api/admin/channels', { method: 'POST', body, admin: true }),
    adminUpdateChannel: (id, body) =>
        request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'PUT', body, admin: true }),
    adminDeleteChannel: (id) =>
        request(`/api/admin/channels/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
};
