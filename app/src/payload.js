/*
共享的请求载荷工具：「除密钥外全部清洗」的拆分逻辑（sanitizeExceptSecrets，
密码类字段原文保留）、在其上构建的管理端频道载荷、data-URL 图片载荷的
白名单校验、host JWT 的频道级复查，以及错误路径用到的一个小型 JSON
序列化器。
*/

'use strict';

const checkXSS = require('./xss.js');
const limits = require('./limits');

/**
 * checkXSS 的「密钥豁免」版：密码必须原封不动地到达哈希/比对函数——
 * DOMPurify 会静默改写含标记字符（<、>、&）的字符串，
 * 这会改变实际生效的密码、削弱其熵。
 * 其余字段照常清洗；原始密钥最后再合并回去。
 */
function sanitizeExceptSecrets(raw, secretKeys) {
    if (!raw || typeof raw !== 'object') return {};
    const secrets = {};
    for (const key of secretKeys) {
        if (typeof raw[key] === 'string') secrets[key] = raw[key];
    }
    const safe = checkXSS({ ...raw, ...Object.fromEntries(secretKeys.map((k) => [k, undefined])) }) || {};
    return { ...safe, ...secrets };
}

/**
 * 管理端频道创建/更新载荷：频道密码与每个主持人密码保持原文
 * （见 sanitizeExceptSecrets）；主持人用户名及定义的其余部分
 * 照旧经过 checkXSS 清洗。hosts 必须从原文单独处理——外层
 * 清洗会递归进数组，把密码里的标记字符改写掉（对改写后的
 * 字符串做哈希，真实密码就永远对不上，host 无法登录）。
 */
function sanitizeChannelPayload(body) {
    if (!body || typeof body !== 'object') return {};
    const { hosts, ...rest } = body;
    const { password, ...safe } = sanitizeExceptSecrets(rest, ['password']);
    const out = { ...safe, ...(typeof password === 'string' ? { password } : {}) };
    if (Array.isArray(hosts)) {
        out.hosts = hosts.map((h) => (h && typeof h === 'object' ? { ...sanitizeExceptSecrets(h, ['password']) } : h));
    }
    return out;
}

/**
 * data:image/* 白名单校验（直接按正则校验，绝不经过 checkXSS——
 * DOMPurify 会剥掉 data: URI）。长度上限按用途传入：
 * 聊天图 1.6MB（limits.IMAGE_MAX_CHARS）、头像 96KB
 * （limits.AVATAR_MAX_CHARS）。
 */
function isImageDataUrl(url, maxChars = limits.IMAGE_MAX_CHARS) {
    return typeof url === 'string' && url.length > 0 && url.length <= maxChars && limits.IMAGE_DATA_URL_RE.test(url);
}

/**
 * host JWT 对某频道此刻是否仍然有效——join 路径与 host 导出端点
 * 共用的同一套复查：有效签发 + 角色为 host + 频道匹配 + 用户名在场，
 * 且该频道仍配置着此主持人，或对无主频道的 default-moderator
 * 回退仍然开启（token 可能早于配置变更签发）。
 */
function hostTokenValidFor(payload, channelId, { channelsCfg, channelStore }) {
    if (!payload || payload.role !== 'host' || payload.channelId !== channelId || !payload.username) return false;
    const fallbackOk =
        payload.via === 'default-moderator' &&
        Boolean(channelsCfg.defaultModerator) &&
        channelStore.isHostless(channelId);
    return channelStore.isHost(channelId, payload.username) || fallbackOk;
}

/** 对象转 JSON */
function toJson(data) {
    return JSON.stringify(data, null, 4);
}

module.exports = { sanitizeExceptSecrets, sanitizeChannelPayload, isImageDataUrl, hostTokenValidFor, toJson };
