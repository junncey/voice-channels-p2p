/*
Shared request-payload helpers: the sanitize-except-secrets split that keeps
password-like fields verbatim, the admin channel payload built on top of it,
and a tiny JSON serializer used by the error paths.
*/

'use strict';

const checkXSS = require('./xss.js');

/**
 * checkXSS minus the secret fields: passwords must reach the hasher/comparer
 * VERBATIM — DOMPurify silently rewrites strings containing markup characters
 * (<, >, &), which would change the effective password and cut its entropy.
 * Everything else is sanitized as usual; the raw secrets are merged back in.
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
 * Admin channel create/update payload: the channel password and every host
 * password stay raw (see sanitizeExceptSecrets); host usernames and the rest
 * of the definition go through checkXSS as before.
 */
function sanitizeChannelPayload(body) {
    const { password, hosts, ...safe } = sanitizeExceptSecrets(body, ['password']);
    const out = { ...safe, ...(typeof password === 'string' ? { password } : {}) };
    if (Array.isArray(hosts)) {
        out.hosts = hosts.map((h) => (h && typeof h === 'object' ? { ...sanitizeExceptSecrets(h, ['password']) } : h));
    }
    return out;
}

/** Object to Json */
function toJson(data) {
    return JSON.stringify(data, null, 4);
}

module.exports = { sanitizeExceptSecrets, sanitizeChannelPayload, toJson };
