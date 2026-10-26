/*
http://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=Server

██╗███╗   ██╗███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗██╗   ██╗███████╗
██║████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝██║   ██║██╔════╝
██║╚██╗ ██║█████╔╝     ██║   ███████║██████╔╝██║     █████╔╝ ██║   ██║█████╔╝
██║╚██╔╝██║██╔══╝     ██║   ██╔══██║██╔══██╗██║     ██╔═██╗ ██║   ██║██╔══╝
██║██║╚████║███████╗   ██║   ██║  ██║██████╔╝╚██████╗██║  ██║╚██████╔╝███████╗
╚═╝╚═╝ ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝

Voice channel edition — persistent channels + admin console + guest direct join.

Based on MiroTalk P2P (https://github.com/miroslavpejic85/mirotalk, AGPLv3).

Assembly point: this file wires the express app, the HTTPS/HTTP server and
socket.io, the persistent stores, and the feature modules —

  rooms.js        in-memory room state + ghost/session lifecycle
  signaling.js    socket protocol (join/addPeer/relaySDP/relayICE/removePeer)
  chatGateway.js  chat socket domain (history copy + lifecycle broadcasts)
  adminApi.js     /api/admin/* + /api/host/* REST + backup/restore
*/

'use strict';

require('dotenv').config();

const { Server } = require('socket.io');
const http = require('http');
const https = require('https');
const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const checkXSS = require('./xss.js');
const Logs = require('./logs');
const ChannelStore = require('./channelStore');
const ChatStore = require('./chatStore');
const Version = require('./version');
const Audit = require('./audit');
const limits = require('./limits');
const { applyEmbedHeaders } = require('./middleware/embedHeaders');
const { createRooms } = require('./rooms');
const { createChatGateway } = require('./chatGateway');
const { registerSignaling } = require('./signaling');
const { registerAdminApi, BACKUP_INTERVAL_HOURS, BACKUP_KEEP } = require('./adminApi');

// one constant-time compare implementation for the whole server (channelStore
// owns it — it lives next to the password hashing it was built for)
const safeEqualStrings = ChannelStore.constantTimeEquals;

const log = new Logs('server');

// Central configuration (reads .env via dotenv internally)
const config = require('./config');

const app = express();

const port = config.server.port;
const host = config.server.host;
const trustProxy = config.server.trustProxy;

// ---------------------------------------------------------------------------
// HTTPS / HTTP server + Socket.IO
// ---------------------------------------------------------------------------

// Two supported TLS forms (docs/self-hosting.md):
//  - reverse proxy terminates TLS → container serves plain HTTP (default, no certs)
//  - native HTTPS → operator mounts real certs at app/ssl/, port serves HTTPS only
const keyPath = path.join(__dirname, '../ssl/key.pem');
const certPath = path.join(__dirname, '../ssl/cert.pem');
const nativeTls = fs.existsSync(keyPath) && fs.existsSync(certPath);
const server = nativeTls
    ? https.createServer(
          {
              key: fs.readFileSync(keyPath, 'utf-8'),
              cert: fs.readFileSync(certPath, 'utf-8'),
          },
          app
      )
    : http.createServer(app);

server.on('clientError', (err, socket) => {
    err.code === 'HPE_HEADER_OVERFLOW' || err.message === 'Parse Error'
        ? log.warn('Client HTTP parse error', { error: err.message, code: err.code })
        : log.warn('Client connection error', { error: err.message, code: err.code });
    if (socket && !socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

const corsOptions = {
    origin: config.cors.origin,
    methods: config.cors.methods,
};

const io = new Server({
    // 2MB: chat-history image relay events carry ONE compressed image each
    // (up to ~1.6MB of base64, see the 'chat' handler). A packet over the
    // limit closes its own connection, so the raise stays self-limiting.
    maxHttpBufferSize: 2e6,
    transports: ['websocket'],
    cors: corsOptions,
    // reap connections that died without a FIN (ghost members) within ~18s
    pingInterval: config.server.pingInterval,
    pingTimeout: config.server.pingTimeout,
}).listen(server);

// ---------------------------------------------------------------------------
// STUN / TURN ICE servers
// ---------------------------------------------------------------------------

// Two TURN modes:
//  - static: TURN_SERVER_USERNAME/CREDENTIAL relayed as-is (legacy coturn
//    long-term credentials — fine on a trusted LAN, risky on the open net)
//  - REST/HMAC (recommended when TURN_SERVER_SECRET is set): coturn runs with
//    use-auth-secret; this server mints short-lived credentials
//    (username = unix expiry, password = base64(hmac-sha1(secret, username)))
//    and refreshes them at half-life. Nothing long-lived ever reaches a client.
const iceServers = []; // static entries (STUN + optionally static TURN)
const stunServerUrl = config.webrtc.stun.url;
const turnServerUrl = config.webrtc.turn.url;
const turnServerUsername = config.webrtc.turn.username;
const turnServerCredential = config.webrtc.turn.credential;
const turnSecret = config.webrtc.turn.secret; // REST/HMAC mode (overrides static TURN auth)
const turnTtlSec = config.webrtc.turn.credentialTtlSec || 12 * 3600;
if (config.webrtc.stun.enabled && stunServerUrl) iceServers.push({ urls: stunServerUrl });
// TURN_SERVER_URL may hold several comma-separated URLs -> one RTCIceServer per relay
// (multiple coturn instances act as mutual backups; the browser collects a relay
// candidate per server and ICE picks whichever answers first)
const turnServerUrls = (turnServerUrl || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
const turnStaticAuth =
    config.webrtc.turn.enabled && turnServerUrls.length && turnServerUsername && turnServerCredential;
const turnDynamicAuth = config.webrtc.turn.enabled && turnServerUrls.length && turnSecret;
if (turnDynamicAuth) {
    // REST/HMAC wins when both are configured: nothing long-lived should keep
    // travelling to clients just because static creds are still in the env.
    log.info('TURN REST/HMAC credentials enabled (use-auth-secret)', {
        ttl_sec: turnTtlSec,
        urls: turnServerUrls.length,
    });
} else if (turnStaticAuth) {
    turnServerUrls.forEach((url) => {
        iceServers.push({ urls: url, username: turnServerUsername, credential: turnServerCredential });
    });
}

// Minted credentials are shared by every client of the process and cached
// until half of their TTL has passed (a rejoin mid-call keeps working).
let turnCredCache = null; // { servers, expiresAtSec }

function mintTurnCredentials() {
    const expiresAtSec = Math.floor(Date.now() / 1000) + turnTtlSec;
    const username = String(expiresAtSec); // coturn REST API: username = expiry timestamp
    const password = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    return {
        servers: turnServerUrls.map((url) => ({ urls: url, username, credential: password })),
        expiresAtSec,
    };
}

/** ICE server list for a fresh addPeer (static array, or cached HMAC set). */
function getIceServers() {
    if (!turnDynamicAuth) return iceServers;
    if (!turnCredCache || turnCredCache.expiresAtSec - Math.floor(Date.now() / 1000) < turnTtlSec / 2) {
        turnCredCache = mintTurnCredentials();
    }
    return [...iceServers, ...turnCredCache.servers];
}

// ---------------------------------------------------------------------------
// Persistent channel registry + admin console
// ---------------------------------------------------------------------------

const channelsCfg = config.channels || {};

// Wire the pre-fix password compatibility shim: registries written before
// passwords were compared verbatim hold hashes of DOMPurify-sanitized secrets;
// verifyPasswordCompat re-derives that form as a fallback (raw first).
const channelStore = new ChannelStore({
    filePath: path.join(__dirname, 'channels.json'),
    autoInit: channelsCfg.autoInit !== false,
    defaultModerator: channelsCfg.defaultModerator,
    legacySanitize: (pw) => checkXSS(pw),
    // env seeds the first-boot default; afterwards the admin toggle persists
    defaultSettings: { tempRooms: channelsCfg.tempRooms !== false },
});

// Runtime source of truth for the temporary-rooms feature (admin-managed,
// persisted in channels.json — the env value only seeded the initial default)
const tempRoomsEnabled = () => channelStore.settings.tempRooms !== false;

// Text chat history: delivery stays P2P over the DataChannel mesh, but the
// SENDER relays a copy of every text message here so late joiners can catch
// up. Retention is admin-tunable (chatRetentionHours in channels.json, 0 =
// keep nothing); a channel may override the global window (its own
// chatRetentionHours field, null/absent = inherit). Temp rooms keep history
// in memory only.
const chatStore = new ChatStore({
    dir: path.join(__dirname, 'chat_history'),
    retentionHours: (roomId) =>
        channelStore.get(roomId)?.chatRetentionHours ?? channelStore.settings.chatRetentionHours,
});

// The admin console stays completely DISABLED (404 on /admin and every
// /api/admin/* route) until BOTH a password and a dedicated JWT secret are
// configured — there are no insecure defaults.
const consoleEnabled = Boolean(channelsCfg.adminPassword && channelsCfg.adminJwtSecret);
if (!consoleEnabled) {
    log.warn(
        'Admin console disabled — set CHANNEL_ADMIN_PASSWORD and CHANNEL_ADMIN_JWT_SECRET to enable /admin and channel management'
    );
}

// Append-only audit trail: membership changes (join/leave/kick) and admin
// data operations land here even with debug logging off. VC_AUDIT_FILE
// redirects it (the integration tests point it at a throwaway file).
const audit = new Audit(process.env.VC_AUDIT_FILE || path.join(__dirname, 'audit.jsonl'));

// Room state + session lifecycle (shared by the signaling protocol, the chat
// gateway and the admin console REST surface)
const rooms = createRooms({ channelStore, chatStore, audit, log });

// Chat socket domain: history-copy persistence + lifecycle broadcasts
const chatGateway = createChatGateway({ rooms, chatStore, channelStore, audit, log });

/** Sign admin / host tokens with the dedicated console secret. */
function signConsoleToken(payload, expiresIn) {
    return jwt.sign(payload, channelsCfg.adminJwtSecret, { expiresIn: expiresIn || channelsCfg.adminJwtExp || '24h' });
}

/** @returns {object|null} decoded payload or null when invalid/expired */
function verifyConsoleToken(token) {
    if (!token || typeof token !== 'string') return null;
    try {
        // pin the algorithm so tokens signed with another alg are never accepted
        return jwt.verify(token, channelsCfg.adminJwtSecret, { algorithms: ['HS256'] });
    } catch {
        return null;
    }
}

// Login rate limiting shared by admin / host login (throttled by IP only: a
// client-supplied username can be varied per request to get a fresh bucket).
const maxAttempts = config.host.maxLoginAttempts;
const minBlockTime = config.host.minLoginBlockTime;
const loginLimiter = rateLimit({
    windowMs: minBlockTime * 60 * 1000,
    max: maxAttempts,
    message: { error: `Too many login attempts. Please try again after ${minBlockTime} minute(s).` },
    keyGenerator: (req) => getIP(req),
});

// Coarse safety net for the public REST surface (/api/channels, /api/version,
// …) which is otherwise unauthenticated and unlimited. Generous enough that
// the homepage's 15s polling never trips it (≈ 12 req/5min per open tab);
// admin routes carry their own JWTs and only need the headroom for backups.
const apiLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    message: { error: 'Too many requests' },
    keyGenerator: (req) => getIP(req),
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const dir = {
    public: path.join(__dirname, '../../', 'public'),
};

const views = {
    index: path.join(dir.public, 'index.html'),
    channel: path.join(dir.public, 'channel.html'),
    admin: path.join(dir.public, 'admin.html'),
    notFound: path.join(dir.public, '404.html'),
};

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------

app.set('trust proxy', trustProxy);

const ipWhitelist = config.ipWhitelist;

// Guardrail: IP_WHITELIST_ENABLED=true without TRUST_PROXY=true is almost
// always a misconfiguration (X-Forwarded-For would be attacker-controlled).
if (ipWhitelist.enabled && !trustProxy) {
    const optIn = String(process.env.IP_WHITELIST_ALLOW_UNTRUSTED_PROXY || '').toLowerCase() === 'true';
    if (!optIn) {
        log.error(
            'IP_WHITELIST_ENABLED=true requires TRUST_PROXY=true so the real client IP can be resolved from a trusted reverse proxy. ' +
                'If this instance has no proxy in front and you understand that only direct socket addresses will be evaluated, ' +
                'set IP_WHITELIST_ALLOW_UNTRUSTED_PROXY=true to acknowledge.'
        );
        process.exit(1);
    }
}

app.use(
    helmet.contentSecurityPolicy({
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            // 404.html carries an inline <style> block; inline styles cannot execute script
            styleSrc: ["'self'", "'unsafe-inline'"],
            // chat images travel as data: URLs; audio playback and the
            // composer's pending-image previews (object URLs) use blob:
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:', 'data:'],
            connectSrc: ["'self'"], // socket.io websocket (same-origin) is covered by 'self'
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
        },
    }),
    helmet.noSniff(),
    helmet.referrerPolicy({ policy: 'no-referrer' }),
    // HSTS (180-day default); over plain HTTP browsers ignore the header
    helmet.hsts()
);
app.use(applyEmbedHeaders);

const staticOptions = {
    // "/" must reach the page route so index.html is served with its build id
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
        // Cache policy: icons/images never change in place → cache hard.
        // Everything else (js/css/lang) gets a short freshness window and must
        // revalidate afterwards, so a deploy shows up within minutes while the
        // version-check banner still covers the gap (HTML itself is no-cache).
        if (path.dirname(filePath).endsWith(path.join('public', 'images'))) {
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        }
    },
};
app.use(express.static(dir.public, staticOptions));

// CORS before the API limiter: preflight OPTIONS requests are protocol
// overhead, not API traffic, and must not burn the rate budget
app.use(cors(corsOptions));

// REST-wide safety net (login endpoints keep their stricter limiter — order
// matters: the specific limiter must run first, so mount this after routes…
// except Express matches in registration order, hence the skip below)
app.use('/api', (req, res, next) => {
    // already throttled harder by their own limiter
    if (req.path === '/admin/login' || req.path === '/host/login') return next();
    return apiLimiter(req, res, next);
});

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
    if (!ipWhitelist.enabled) return next();
    const clientIP = getIP(req);
    if (ipWhitelist.allowed.includes(clientIP)) return next();
    log.info('Forbidden: Access denied from this IP address', { clientIP });
    res.status(403).json({ error: 'Forbidden', message: 'Access denied from this IP address.' });
});

app.use((req, res, next) => {
    log.debug('New request:', { ip: getIP(req), method: req.method, path: req.originalUrl });
    next();
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

// Pages carry their build id in a <meta> (see app/src/version.js) and are sent
// `Cache-Control: no-cache`, so a reload always revalidates the HTML instead of
// running a stale copy out of the HTTP cache. Rendered copies are memoized:
// frontend files never change inside a running container.
const renderedPages = new Map();

function sendPage(res, file, status = 200) {
    let html = renderedPages.get(file);
    if (!html) {
        const { build } = Version.getVersionInfo(dir.public);
        html = Version.injectBuildMeta(fs.readFileSync(file, 'utf8'), build);
        renderedPages.set(file, html);
    }
    res.status(status).set('Cache-Control', 'no-cache').type('html').send(html);
}

/** 404 page with an error callback: a missing 404.html must not hang the
 *  request (sendFile without one never ends the response on failure). */
function sendNotFound(res) {
    res.status(404).sendFile(views.notFound, (err) => {
        if (err && !res.headersSent) res.status(500).type('text').send('Not found');
    });
}

// Channel list (homepage)
app.get('/', (req, res) => {
    sendPage(res, views.index);
});

// Voice channel page — registered channels always resolve; any other valid id
// resolves when temporary rooms are enabled (the room is spawned on first join)
app.get('/c/:channelId', (req, res) => {
    const { channelId } = req.params;
    const known = channelStore.exists(channelId) || channelStore.isTemp(channelId);
    if (!known && !(tempRoomsEnabled() && channelStore.isValidId(channelId))) {
        return sendNotFound(res);
    }
    sendPage(res, views.channel);
});

// Legacy links compatibility: /join/<room> -> /c/<room>
app.get('/join/:roomId', (req, res) => {
    res.redirect(301, `/c/${req.params.roomId}`);
});

// Admin console (404 unless enabled via env)
app.get('/admin', (req, res) => {
    if (!consoleEnabled) return sendNotFound(res);
    sendPage(res, views.admin);
});

// Legacy single-segment links -> /c/<id> (old shared /<room> URLs)
app.get('/:roomId', (req, res) => {
    const { roomId } = req.params;
    if (!roomId || roomId === 'admin' || roomId === 'favicon.ico') {
        return res.redirect('/');
    }
    res.redirect(301, `/c/${roomId}`);
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Public channels with online counts (homepage); active temporary rooms are
// appended with a `temporary` flag so visitors can discover and join them
app.get('/api/channels', (req, res) => {
    res.json({
        settings: { tempRooms: tempRoomsEnabled() },
        channels: [
            ...channelStore.list({ includePrivate: false, onlineOf: (id) => rooms.getPeerCount(id) }),
            ...channelStore.listTemps({ onlineOf: (id) => rooms.getPeerCount(id) }),
        ],
    });
});

// Channel metadata for the channel page (works for unlisted channels too).
// includePrivate stays off: host usernames are operator data for the admin
// console, not for anonymous visitors.
app.get('/api/channels/:channelId', (req, res) => {
    const id = req.params.channelId;
    const channel = channelStore.get(id) || channelStore.getTemp(id);
    if (channel) {
        return res.json(channelStore.sanitize(channel, { online: rooms.getPeerCount(id) }));
    }
    // unknown id: with temp rooms enabled, any valid id MAY become a room the
    // moment someone joins — serve a virtual preview instead of a 404
    if (tempRoomsEnabled() && channelStore.isValidId(id)) {
        return res.json({
            id,
            name: id,
            description: '',
            public: true,
            maxParticipants: limits.DEFAULT_MAX_PARTICIPANTS,
            hasPassword: false,
            temporary: true,
        });
    }
    return res.status(404).json({ error: 'Channel not found' });
});

// Frontend version + public/ fingerprint: open pages poll this and prompt a
// reload when the build they were loaded with is no longer current
app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(Version.getVersionInfo(dir.public));
});

// Admin console + host REST surface (all /api/admin/* and /api/host/*,
// including backup/restore and the scheduled backup)
const adminApi = registerAdminApi(app, {
    rooms,
    channelStore,
    chatStore,
    audit,
    log,
    consoleEnabled,
    channelsCfg,
    tempRoomsEnabled,
    loginLimiter,
    signConsoleToken,
    verifyConsoleToken,
    safeEqualStrings,
    getIP,
});

// ---------------------------------------------------------------------------
// Legacy API v1 (stats only, API-key gated)
// ---------------------------------------------------------------------------

app.get('/api/v1/stats', (req, res) => {
    const api_key_secret = config.api.keySecret;
    const { authorization } = req.headers;
    if (!api_key_secret || !safeEqualStrings(authorization, api_key_secret)) {
        return res.status(403).json({ error: 'Unauthorized!' });
    }
    let totalRooms = 0;
    let totalPeers = 0;
    for (const roomId of Object.keys(rooms.peers)) {
        totalRooms++;
        totalPeers += rooms.getPeerCount(roomId);
    }
    res.json({
        success: true,
        timestamp: new Date().toISOString(),
        totalRooms,
        totalPeers,
        registeredChannels: channelStore.channels.length,
    });
});

// ---------------------------------------------------------------------------
// 404 + error handler
// ---------------------------------------------------------------------------

app.use((req, res) => {
    sendNotFound(res);
});

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ status: 400, message: 'Invalid JSON' });
    }
    if (err instanceof URIError) {
        return res.status(400).json({ status: 400, message: 'Invalid URL encoding' });
    }
    log.error('Unhandled error', { url: req.url, error: err.message, stack: err.stack });
    res.status(500).json({ status: 500, message: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Socket.IO signaling — mesh P2P (unchanged protocol core)
// ---------------------------------------------------------------------------

registerSignaling(io, {
    rooms,
    chatGateway,
    channelStore,
    chatStore,
    audit,
    log,
    channelsCfg,
    tempRoomsEnabled,
    getIceServers,
    verifyConsoleToken,
    safeEqualStrings,
    trustProxy,
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(port, null, () => {
    const shownHost = host.replace(/^\w+:\/\//, '');
    log.info(`Voice channel server started → ${nativeTls ? 'https' : 'http'}://${shownHost} (port ${port})`);
    log.info('Server config', {
        tls: nativeTls ? 'native (app/ssl/*.pem)' : 'off (terminate at a reverse proxy)',
        environment: config.server.environment,
        app_version: require('../../package.json').version,
        node_version: process.versions.node,
        trust_proxy: trustProxy,
        channels_registered: channelStore.channels.length,
        channels_file: channelStore.filePath,
        chat_history_dir: chatStore.dir,
        chat_retention_hours: channelStore.settings.chatRetentionHours,
        admin_console: consoleEnabled ? 'enabled' : 'disabled',
        default_moderator_fallback: channelsCfg.defaultModerator ? 'enabled' : 'disabled',
        ice_servers: iceServers.length,
        ip_whitelist: ipWhitelist.enabled ? ipWhitelist : false,
        api_key_secret: config.api.keySecret ? 'configured' : 'not set',
        scheduled_backup: BACKUP_INTERVAL_HOURS > 0 ? `every ${BACKUP_INTERVAL_HOURS}h, keep ${BACKUP_KEEP}` : 'off',
    });
    if (BACKUP_INTERVAL_HOURS > 0) adminApi.startScheduledBackup();
});

/**
 * Get ip (honours trust proxy settings)
 */
function getIP(req) {
    return req.ip || (req.socket && req.socket.remoteAddress);
}

process.on('SIGINT', () => {
    log.debug('PROCESS', 'SIGINT');
    process.exit();
});

process.on('SIGTERM', () => {
    log.debug('PROCESS', 'SIGTERM');
    process.exit();
});

// A rejected async socket handler must never take the whole process down
// (Node >= 15 terminates on unhandled rejections): log and keep serving.
process.on('unhandledRejection', (reason) => {
    log.error(
        'Unhandled promise rejection',
        reason instanceof Error ? { error: reason.message, stack: reason.stack } : { reason: String(reason) }
    );
});
