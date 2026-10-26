/*
Host login + channel-password persistence.

The host token lives in localStorage so the login survives browser restarts
(the server re-grants presenter status on every join). Tokens stored in
sessionStorage by older versions are promoted on sight; expired ones are
dropped locally so the join never has to fail because of them.

The channel password is remembered per channel so returning visitors keep
the auto-join flow; the server still validates it on every join (a stale
value just re-opens the overlay). Hosts never need it (their JWT bypasses
the channel password).

The load functions are plain exports (channel.js needs them before any
factory exists); the modal wiring comes as a factory like the other
submodules.
*/

const HOST_TOKEN_PREFIX = 'vc_host_token_';
const CHANNEL_PW_PREFIX = 'vc_chan_pw_';

function jwtExpiresAt(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
    } catch {
        return 0;
    }
}

export function loadHostToken(channelId) {
    const key = HOST_TOKEN_PREFIX + channelId;
    let token = localStorage.getItem(key) || sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (token && jwtExpiresAt(token) <= Date.now()) {
        localStorage.removeItem(key);
        token = null;
    }
    if (token) localStorage.setItem(key, token);
    return token || '';
}

export function loadChannelPw(channelId) {
    return localStorage.getItem(CHANNEL_PW_PREFIX + channelId) || '';
}

export function createHostAuth({ s, x, channelId, api, t, $ }) {
    function saveHostToken(token) {
        localStorage.setItem(HOST_TOKEN_PREFIX + channelId, token);
    }

    function clearHostToken() {
        localStorage.removeItem(HOST_TOKEN_PREFIX + channelId);
        sessionStorage.removeItem(HOST_TOKEN_PREFIX + channelId);
    }

    function saveChannelPw(password) {
        localStorage.setItem(CHANNEL_PW_PREFIX + channelId, password);
    }

    function clearChannelPw() {
        localStorage.removeItem(CHANNEL_PW_PREFIX + channelId);
    }

    function openHostModal() {
        $('#hostLoginError').textContent = '';
        $('#hostModal').classList.remove('hidden');
        $('#hostUser').focus();
    }

    function closeHostModal() {
        $('#hostModal').classList.add('hidden');
    }

    async function onHostLoginSubmit(event) {
        event.preventDefault();
        const username = $('#hostUser').value.trim();
        const password = $('#hostPass').value;
        $('#hostLoginError').textContent = '';
        try {
            const { token } = await api.hostLogin(channelId, username, password);
            saveHostToken(token);
            s.hostToken = token;
            $('#hostReadyHint').classList.remove('hidden');
            closeHostModal();
            if (!s.joined) x.join({ textOnly: false });
            else {
                // presenter status is granted at join time — rejoin with the token
                s.intentionalUnload = true;
                location.reload();
            }
        } catch (err) {
            const key = err?.status === 503 ? 'channel.hostLoginUnavailable' : 'channel.hostLoginFailed';
            $('#hostLoginError').textContent = t(key);
        }
    }

    return {
        saveHostToken,
        clearHostToken,
        saveChannelPw,
        clearChannelPw,
        openHostModal,
        closeHostModal,
        onHostLoginSubmit,
    };
}
