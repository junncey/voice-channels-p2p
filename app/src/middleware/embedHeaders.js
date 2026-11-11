'use strict';

const config = require('../config');

/**
 * 嵌入（iframe）限制。
 *
 * 通过 CSP `frame-ancestors`（并对老式浏览器附加 `X-Frame-Options`）
 * 控制哪些源可以将 MiroTalk P2P 嵌入 <iframe>。
 * 经 ALLOWED_EMBED_ORIGINS env 配置。见 config.server.embed。
 *
 * 默认 fail-closed：未配置 ALLOWED_EMBED_ORIGINS 时仅允许同源嵌入
 * （'self' 必需——应用自己会用 iframe 打开分享弹窗等页面）。
 * 无论配置如何，管理后台绝不可被嵌入
 * （frame-ancestors 'none' + X-Frame-Options: DENY）。
 */
const embedAllowedOrigins = Array.isArray(config?.server?.embed?.allowedOrigins)
    ? config.server.embed.allowedOrigins
    : [];

function buildEmbedCsp(origins) {
    if (!origins || origins.length === 0) {
        // 默认（无 ALLOWED_EMBED_ORIGINS）：仅允许同源——
        // 绝不放开来自任意来源的嵌入。
        return { csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' };
    }
    // 单 token 快捷写法
    if (origins.length === 1) {
        const single = origins[0].toLowerCase();
        if (single === 'none' || single === "'none'") {
            return { csp: "frame-ancestors 'none'", xfo: 'DENY' };
        }
        if (single === 'self' || single === "'self'") {
            return { csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' };
        }
    }
    // 构建允许列表；总是隐式包含 'self'，让应用自己的页面
    // 仍能 iframe 自己（分享弹窗等）
    const sources = ["'self'"];
    for (const o of origins) {
        const v = o.trim();
        if (!v) continue;
        if (v.toLowerCase() === 'self' || v === "'self'") continue;
        if (v.toLowerCase() === 'none' || v === "'none'") continue;
        sources.push(v);
    }
    // X-Frame-Options 无法表达多个源；省略它以避免与 CSP 矛盾
    // （反正现代浏览器优先采用 CSP）。
    return { csp: `frame-ancestors ${sources.join(' ')}`, xfo: null };
}

const embedCsp = buildEmbedCsp(embedAllowedOrigins);

/**
 * 按路径的嵌入策略：无论配置了哪些嵌入源，
 * 管理后台及其 API 都绝不允许被 iframe 嵌入。
 */
function embedPolicyFor(pathname) {
    if (pathname === '/admin' || pathname.startsWith('/api/admin/')) {
        return { csp: "frame-ancestors 'none'", xfo: 'DENY' };
    }
    return embedCsp;
}

const applyEmbedHeaders = (req, res, next) => {
    const policy = embedPolicyFor(req.path);
    if (policy) {
        // 与链路上游已设置的 CSP 头合并（基础 helmet 策略从不设置
        // frame-ancestors，因此合并后的头里恰好
        // 只有一个）
        const existing = res.getHeader('Content-Security-Policy');
        const merged = existing ? `${existing}; ${policy.csp}` : policy.csp;
        res.setHeader('Content-Security-Policy', merged);
        if (policy.xfo) {
            res.setHeader('X-Frame-Options', policy.xfo);
        }
    }
    next();
};

module.exports = {
    applyEmbedHeaders,
    buildEmbedCsp,
    embedPolicyFor,
    embedAllowedOrigins,
    embedCsp,
};
