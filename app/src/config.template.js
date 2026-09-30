'use strict';

/**
 * ==============================================
 * Voice Channels - Configuration File
 * ==============================================
 *
 * This file is the central configuration source.
 * All environment variables are read here so the
 * rest of the codebase imports config values
 * instead of reading process.env directly.
 *
 * Setup:
 *   cp app/src/config.template.js app/src/config.js
 *   Then edit config.js (or .env) to match your environment.
 *
 * Docker/container environments inject values via
 * environment variables which are read at startup.
 */

require('dotenv').config();

// Helper: parse env string to boolean
function getEnvBoolean(key, force_true_if_undefined = false) {
    if (key == undefined && force_true_if_undefined) return true;
    return key == 'true' ? true : false;
}

// Helper: safely parse JSON env vars with a fallback
function parseJsonEnv(envValue, fallback) {
    if (!envValue) return fallback;
    try {
        return JSON.parse(envValue);
    } catch (e) {
        return fallback;
    }
}

const port = process.env.PORT || 3000;

module.exports = {
    // ==========================================
    // Server
    // ==========================================
    server: {
        port: port,
        host: process.env.HOST || `http://localhost:${port}`,
        environment: process.env.NODE_ENV || 'development',
        // Behind nginx/traefik? enable so Express honors X-Forwarded-* headers
        trustProxy: !!getEnvBoolean(process.env.TRUST_PROXY),
        // Socket.IO heartbeat — the only way to reap connections that die
        // without a FIN (network drop, phone lock screen, laptop sleep). A
        // ghost member lingers for up to pingInterval + pingTimeout; the
        // defaults below bound that to ~18s (socket.io defaults ≈ 45s).
        pingInterval: Number(process.env.SOCKET_PING_INTERVAL) || 10000,
        pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT) || 8000,

        /**
         * Embed (iframe) Restrictions
         * ---------------------------
         * Controls which origins are allowed to embed this app in an <iframe>
         * via the HTTP `Content-Security-Policy: frame-ancestors` header.
         *
         * - Empty / unset  → header NOT set, embedding allowed anywhere (default)
         * - 'none'         → block ALL embedding
         * - 'self'         → only same-origin embedding
         * - list           → comma-separated origins, 'self' implicitly included
         */
        embed: {
            allowedOrigins: process.env.ALLOWED_EMBED_ORIGINS
                ? process.env.ALLOWED_EMBED_ORIGINS.split(',')
                      .map((o) => o.trim())
                      .filter(Boolean)
                : [],
        },
    },

    // ==========================================
    // CORS
    // ==========================================
    cors: {
        origin: parseJsonEnv(process.env.CORS_ORIGIN, '*'),
        methods: parseJsonEnv(process.env.CORS_METHODS, ['GET', 'POST']),
    },

    // ==========================================
    // Login throttling (admin + host login share one limiter)
    // ==========================================
    host: {
        maxLoginAttempts: process.env.HOST_MAX_LOGIN_ATTEMPTS || 5,
        minLoginBlockTime: process.env.HOST_MIN_LOGIN_BLOCK_TIME || 15, // in minutes
    },

    // ==========================================
    // Persistent channels (持久化频道 + 网页管理后台)
    // ==========================================
    // Channels live in app/src/channels.json, managed at runtime via the /admin
    // console. The admin console and every /api/admin/* route stay completely
    // DISABLED (404) until BOTH a password and a dedicated JWT secret are
    // configured — there are no insecure defaults. Mount channels.json as a
    // volume when running in Docker so the registry survives restarts.
    channels: {
        adminPassword: process.env.CHANNEL_ADMIN_PASSWORD || '',
        adminJwtSecret: process.env.CHANNEL_ADMIN_JWT_SECRET || '',
        adminJwtExp: process.env.CHANNEL_ADMIN_JWT_EXP || '24h',
        // Host tokens are persisted in the browser so the login survives restarts,
        // hence a much longer lifetime than admin console sessions.
        hostJwtExp: process.env.CHANNEL_HOST_JWT_EXP || '30d',
        // Shared-secret password accepted as host login for channels that don't
        // configure their own hosts (username is free-form). Leave empty to
        // disable the fallback.
        defaultModerator: process.env.DEFAULT_CHANNEL_MODERATOR || '',
        autoInit: process.env.AUTO_INIT_CHANNELS ? getEnvBoolean(process.env.AUTO_INIT_CHANNELS) : true,
        // Ephemeral rooms: anyone may open /c/<id> and get an in-memory room
        // (no registry entry, no hosts). Enabled unless explicitly disabled.
        tempRooms: process.env.TEMP_ROOMS_ENABLED ? getEnvBoolean(process.env.TEMP_ROOMS_ENABLED) : true,
    },

    // ==========================================
    // API (legacy /api/v1/stats, API-key gated)
    // ==========================================
    api: {
        keySecret: process.env.API_KEY_SECRET,
    },

    // ==========================================
    // WebRTC ICE Servers (STUN/TURN, relayed to clients on join)
    // ==========================================
    webrtc: {
        stun: {
            enabled: getEnvBoolean(process.env.STUN_SERVER_ENABLED),
            url: process.env.STUN_SERVER_URL,
        },
        turn: {
            enabled: getEnvBoolean(process.env.TURN_SERVER_ENABLED),
            url: process.env.TURN_SERVER_URL,
            username: process.env.TURN_SERVER_USERNAME,
            credential: process.env.TURN_SERVER_CREDENTIAL,
        },
    },

    // ==========================================
    // IP Whitelist
    // ==========================================
    ipWhitelist: {
        enabled: getEnvBoolean(process.env.IP_WHITELIST_ENABLED),
        allowed: parseJsonEnv(process.env.IP_WHITELIST_ALLOWED, []),
    },
};
