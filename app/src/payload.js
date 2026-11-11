/*
共享的请求载荷工具：「除密钥外全部清洗」的拆分逻辑（sanitizeExceptSecrets，
密码类字段原文保留）、在其上构建的管理端频道载荷，
以及错误路径用到的一个小型 JSON 序列化器。
*/

'use strict';

const checkXSS = require('./xss.js');

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
 * 照旧经过 checkXSS 清洗。
 */
function sanitizeChannelPayload(body) {
    const { password, hosts, ...safe } = sanitizeExceptSecrets(body, ['password']);
    const out = { ...safe, ...(typeof password === 'string' ? { password } : {}) };
    if (Array.isArray(hosts)) {
        out.hosts = hosts.map((h) => (h && typeof h === 'object' ? { ...sanitizeExceptSecrets(h, ['password']) } : h));
    }
    return out;
}

/** 对象转 JSON */
function toJson(data) {
    return JSON.stringify(data, null, 4);
}

module.exports = { sanitizeExceptSecrets, sanitizeChannelPayload, toJson };
