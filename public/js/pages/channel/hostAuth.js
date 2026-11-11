/*
主持人登录 + 频道密码持久化。

主持人令牌存 localStorage，登录凭据因此能熬过浏览器重启
（服务器在每次 join 时重新授予主持人身份）。旧版本存进
sessionStorage 的令牌一经发现就晋升到 localStorage；已过期的
就地丢弃，join 不必因它们而失败。

频道密码按频道记忆，让回头访客保住自动 join 流程；服务器
在每次 join 时仍会校验它（过期的记忆值只会让覆盖层
重新弹出，不会挡住页面）。主持人永远不需要它
（其 JWT 绕过频道密码）。

两个 load 函数是纯导出（channel.js 在任何工厂存在之前
就要用它们）；弹窗接线与其他子模块一样，
以工厂形式提供。
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
                // 主持人身份在 join 时授予 —— 带令牌重进一次
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
