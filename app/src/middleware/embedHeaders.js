'use strict';

const config = require('../config');

/**
 * Embed (iframe) restrictions.
 *
 * Controls which origins may embed MiroTalk P2P in an <iframe> via CSP
 * `frame-ancestors` (and `X-Frame-Options` for legacy browsers).
 * Configured via ALLOWED_EMBED_ORIGINS env var. See config.server.embed.
 *
 * Fail-closed defaults: with no ALLOWED_EMBED_ORIGINS configured only
 * same-origin embedding is allowed ('self' is required — the app iframes its
 * own pages for share popups). The admin console is NEVER embeddable, whatever
 * the config says (frame-ancestors 'none' + X-Frame-Options: DENY).
 */
const embedAllowedOrigins = Array.isArray(config?.server?.embed?.allowedOrigins)
    ? config.server.embed.allowedOrigins
    : [];

function buildEmbedCsp(origins) {
    if (!origins || origins.length === 0) {
        // Default (no ALLOWED_EMBED_ORIGINS): same-origin only — never allow
        // embedding from anywhere.
        return { csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' };
    }
    // Single-token shortcuts
    if (origins.length === 1) {
        const single = origins[0].toLowerCase();
        if (single === 'none' || single === "'none'") {
            return { csp: "frame-ancestors 'none'", xfo: 'DENY' };
        }
        if (single === 'self' || single === "'self'") {
            return { csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' };
        }
    }
    // Build allow-list; always include 'self' implicitly so the app's own
    // pages can still iframe themselves (share popups, etc.)
    const sources = ["'self'"];
    for (const o of origins) {
        const v = o.trim();
        if (!v) continue;
        if (v.toLowerCase() === 'self' || v === "'self'") continue;
        if (v.toLowerCase() === 'none' || v === "'none'") continue;
        sources.push(v);
    }
    // X-Frame-Options cannot express multiple origins; omit it to avoid
    // contradicting the CSP (modern browsers prefer CSP anyway).
    return { csp: `frame-ancestors ${sources.join(' ')}`, xfo: null };
}

const embedCsp = buildEmbedCsp(embedAllowedOrigins);

/**
 * Per-path embed policy: the admin console and its API must never be framable,
 * regardless of the configured embed origins.
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
        // Merge with any existing CSP header set earlier in the chain (the
        // base helmet policy never sets frame-ancestors, so the merged header
        // contains exactly one)
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
