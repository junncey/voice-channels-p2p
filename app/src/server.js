/*
http://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=Server

██╗███╗   ██╗███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗██╗   ██╗███████╗
██║████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝██║   ██║██╔════╝
██║██╔██╗ ██║█████╗     ██║   ███████║██████╔╝██║     █████╔╝ ██║   ██║█████╗
██║██║╚██╗██║██╔══╝     ██║   ██╔══██║██╔══██╗██║     ██╔═██╗ ██║   ██║██╔══╝
██║██║ ╚████║███████╗   ██║   ██║  ██║██║  ██║╚██████╗██║  ██╗╚██████╔╝███████╗
╚═╝╚═╝  ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝

Voice channel edition — persistent channels + admin console + guest direct join.

Based on MiroTalk P2P (https://github.com/miroslavpejic85/mirotalk, AGPLv3).
*/

'use strict';

require('dotenv').config();

const { Server } = require('socket.io');
const httpolyglot = require('httpolyglot');
const compression = require('compression');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const zlib = require('zlib');

const checkXSS = require('./xss.js');
const Validate = require('./validate');
const Logs = require('./logs');
const ChannelStore = require('./channelStore');
const ChatStore = require('./chatStore');
const Version = require('./version');
const Audit = require('./audit');
const limits = require('./limits');
const { pipeline, Readable } = require('stream');
const { createTarIterator } = require('./backup');
const { applyBackupArchive, RestoreError } = require('./restore');
const { applyEmbedHeaders } = require('./middleware/embedHeaders');

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

const keyPath = path.join(__dirname, '../ssl/key.pem');
const certPath = path.join(__dirname, '../ssl/cert.pem');
const options = {
    key: fs.readFileSync(keyPath, 'utf-8'),
    cert: fs.readFileSync(certPath, 'utf-8'),
};

const server = httpolyglot.createServer(options, app);

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

// Scheduled rolling backup (off unless CHANNEL_BACKUP_INTERVAL_HOURS is set):
// writes a tar.gz into CHANNEL_BACKUP_DIR and keeps the newest
// CHANNEL_BACKUP_KEEP archives. Read from env directly so existing config.js
// files (created before these options existed) keep working unchanged.
const BACKUP_INTERVAL_HOURS = Number(process.env.CHANNEL_BACKUP_INTERVAL_HOURS) || 0;
const BACKUP_KEEP = Math.max(1, Number(process.env.CHANNEL_BACKUP_KEEP) || 7);
const BACKUP_DIR = process.env.CHANNEL_BACKUP_DIR || path.join(__dirname, 'backups');

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
// In-memory room state (online peers per channel)
// ---------------------------------------------------------------------------
// peers/presenters are keyed by the SESSION uuid (peer_uuid from join), not
// socket.id: a page reconnecting after a network flap re-joins with the same
// uuid and RESUMES its session — the other members never saw a removePeer, so
// their peer connections stay alive and heal with an ICE restart instead of a
// full renegotiation. Each entry carries the socket_id it is bound to.

const channels = {}; // channelId -> { socketId: socket } (live signaling sockets)
const sockets = {}; // socketId -> socket
const peers = {}; // channelId -> { sessionUuid: peerInfo(+socket_id, ghost), 'lock', 'password', 'joinLock' }
const presenters = {}; // channelId -> { sessionUuid: {peer_ip, peer_name, is_presenter} }

const roomMetaKeys = new Set(['lock', 'password', 'joinLock']);

// Abnormal disconnects (VPN/accelerator switch, Wi-Fi flap, sleep) park the
// session as a GHOST: the peers entry (and presenter role) survive a grace
// window so the same uuid can rejoin and resume. Only when the grace expires
// do the remaining members get the removePeer broadcast. Ping-timeout deaths
// were already unreachable for ~pingInterval+pingTimeout, so their window is
// shorter (the recovery ladder on the other members' side escalates into its
// own signaling reconnect long before detection+15s).
const GHOST_GRACE_MS = Number(process.env.GHOST_GRACE_MS) || 15000;
const GHOST_GRACE_LATE_MS = Number(process.env.GHOST_GRACE_LATE_MS) || 5000;
const ghosts = new Map(); // ghostKey(channel, uuid) -> expiry timer

const ghostKey = (channel, uuid) => channel + '|' + uuid;

function getPeerCount(roomId) {
    if (!peers[roomId]) return 0;
    return Object.keys(peers[roomId]).filter((k) => !roomMetaKeys.has(k)).length;
}

/** Public peer list for a room, keyed by session uuid (drops the room meta
 *  keys). Ghosts stay listed: they are still members until their grace
 *  expires, and dropping them here would make every live client's member
 *  reconciliation tear down the very peer connection a resume would heal. */
function getRoomPeers(roomId) {
    const room = peers[roomId] || {};
    const list = {};
    for (const [uuid, info] of Object.entries(room)) {
        if (roomMetaKeys.has(uuid)) continue;
        list[uuid] = {
            peer_name: info.peer_name,
            peer_presenter: !!info.peer_presenter,
            peer_audio: !!info.peer_audio,
            peer_audio_status: !!info.peer_audio_status,
            peer_deafen: !!info.peer_deafen,
            peer_share: !!info.peer_share,
            peer_avatar: info.peer_avatar || null,
            joined_at: info.joined_at,
        };
    }
    return list;
}

/** Admin view of a room's membership: who is in, since when, in which state
 *  (ghost = abnormally disconnected, still inside its resume grace window). */
function getRoomMembers(roomId) {
    const room = peers[roomId];
    if (!room) return [];
    return Object.entries(room)
        .filter(([uuid]) => !roomMetaKeys.has(uuid))
        .map(([uuid, info]) => ({
            uuid,
            name: info.peer_name,
            presenter: !!info.peer_presenter,
            audio: !!info.peer_audio_status,
            ghost: !!info.ghost,
            joined_at: info.joined_at || 0,
        }))
        .sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0));
}

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
            ...channelStore.list({ includePrivate: false, onlineOf: (id) => getPeerCount(id) }),
            ...channelStore.listTemps({ onlineOf: (id) => getPeerCount(id) }),
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
        return res.json(channelStore.sanitize(channel, { online: getPeerCount(id) }));
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

// Host login -> JWT used as peer_token when joining the channel socket room
app.post('/api/host/login', loginLimiter, async (req, res) => {
    const { channelId, username, password } = sanitizeExceptSecrets(req.body, ['password']);

    if (!channelId || !username || !password) {
        return res.status(400).json({ error: 'Missing channelId, username or password' });
    }
    if (!channelsCfg.adminJwtSecret) {
        // per-channel hosts may exist, but there is no secret to sign tokens with
        log.warn('Host login rejected: CHANNEL_ADMIN_JWT_SECRET is not configured');
        return res.status(503).json({ error: 'server not configured' });
    }
    if (!channelStore.exists(channelId)) {
        return res.status(404).json({ error: 'Channel not found' });
    }

    const host = await channelStore.verifyHost(channelId, username, password);
    if (!host) {
        log.warn('Host login failed', { channelId, username: host || username, ip: getIP(req) });
        return res.status(401).json({ error: 'unauthorized' });
    }

    log.info('Host login ok', { channelId, username: host.username });
    const payload = { role: 'host', channelId, username: host.username };
    if (host.via) payload.via = host.via; // 'default-moderator' fallback marker, re-checked at join
    res.json({ token: signConsoleToken(payload, channelsCfg.hostJwtExp) });
});

// ---------------------------------------------------------------------------
// Admin API (all 404 until the console is enabled)
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
    if (!consoleEnabled) return res.status(404).json({ error: 'Not found' });
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyConsoleToken(token);
    if (!payload || payload.role !== 'admin') {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

app.post('/api/admin/login', loginLimiter, (req, res) => {
    if (!consoleEnabled) return res.status(404).json({ error: 'Not found' });
    // compared verbatim against the env secret — never sanitized (an env
    // password containing markup chars was unloginable before this fix)
    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'Missing password' });
    }
    if (!safeEqualStrings(password, channelsCfg.adminPassword)) {
        log.warn('Admin login failed', { ip: getIP(req) });
        return res.status(401).json({ error: 'unauthorized' });
    }
    log.info('Admin login ok', { ip: getIP(req) });
    res.json({ token: signConsoleToken({ role: 'admin' }) });
});

/**
 * Evict every peer from a channel (admin channel deletion). Each socket gets
 * a kickOut with the deletion reason, then a hard disconnect — the normal
 * disconnect cleanup tears the room structures down.
 */
function evictChannelPeers(channelId, reason) {
    // Object.hasOwn: the id is client-visible via the admin API path
    const room = Object.hasOwn(channels, channelId) ? channels[channelId] : null;
    if (!room) return 0;
    let evicted = 0;
    for (const sock of Object.values(room)) {
        try {
            sock.emit('kickOut', { reason });
            // give the packet a beat to flush before the hard close (same
            // shape as the single-member admin kick)
            setTimeout(() => sock.disconnect(true), 100).unref?.();
            evicted++;
        } catch (err) {
            log.error('Evict peer failed', { channel: channelId, error: err.message });
        }
    }
    return evicted;
}

app.get('/api/admin/channels', requireAdmin, (req, res) => {
    res.json({
        channels: channelStore
            .list({ includePrivate: true, onlineOf: (id) => getPeerCount(id) })
            .map((channel) => ({ ...channel, members: getRoomMembers(channel.id) })),
        temps: channelStore
            .listTemps({ onlineOf: (id) => getPeerCount(id) })
            .map((channel) => ({ ...channel, members: getRoomMembers(channel.id) })),
        settings: channelStore.getSettings(),
    });
});

/**
 * Remove one member from a channel (admin console). A live socket gets the
 * same kickOut + hard disconnect the host path uses; a ghost (or a dead
 * socket) is expired on the spot — release + removePeer broadcast, no timer.
 */
app.post('/api/admin/kick', requireAdmin, (req, res) => {
    const body = checkXSS(req.body) || {};
    const { channel, uuid } = body;
    if (typeof channel !== 'string' || typeof uuid !== 'string' || !isPeerInRoom(channel, uuid)) {
        return res.status(404).json({ error: 'member not found' });
    }
    const target = liveSessionSocket(channel, uuid);
    if (target) {
        target.emit('kickOut', { reason: 'removed by admin' });
        // give the packet a beat to flush before the hard close (same shape as
        // evictChannelPeers, with the race closed)
        setTimeout(() => target.disconnect(true), 100).unref?.();
        log.info('Admin kicked member', { channel, uuid });
        audit.record('adminKick', { channel, uuid, name: peers[channel]?.[uuid]?.peer_name });
    } else {
        const entry = peers[channel][uuid];
        clearTimeout(ghosts.get(ghostKey(channel, uuid)));
        ghosts.delete(ghostKey(channel, uuid));
        releaseRoomEntry(channel, uuid);
        broadcastRemovePeer(channel, uuid, entry?.socket_id);
        log.info('Admin expired ghost member', { channel, uuid });
        audit.record('adminKickGhost', { channel, uuid, name: entry?.peer_name });
    }
    res.json({ success: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
    res.json({ settings: channelStore.getSettings() });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
    const result = channelStore.updateSettings(checkXSS(req.body) || {});
    if (!result.ok) return res.status(400).json({ error: result.errors.join('; ') });
    res.json({ settings: result.settings });
});

app.post('/api/admin/channels', requireAdmin, async (req, res) => {
    const result = await channelStore.create(sanitizeChannelPayload(req.body));
    if (!result.ok) return res.status(400).json({ error: result.errors.join('; ') });
    audit.record('channelCreate', { id: result.channel.id, name: result.channel.name });
    res.status(201).json({ channel: result.channel });
});

app.put('/api/admin/channels/:channelId', requireAdmin, async (req, res) => {
    const result = await channelStore.update(req.params.channelId, sanitizeChannelPayload(req.body));
    if (!result.ok) {
        return result.errors[0].includes('not found')
            ? res.status(404).json({ error: result.errors[0] })
            : res.status(400).json({ error: result.errors.join('; ') });
    }
    audit.record('channelUpdate', { id: result.channel.id });
    res.json({ channel: result.channel });
});

app.delete('/api/admin/channels/:channelId', requireAdmin, (req, res) => {
    const id = req.params.channelId;
    // temp rooms live outside the persistent registry but are deletable too
    const result = channelStore.isTemp(id) ? channelStore.removeTemp(id) : channelStore.remove(id);
    if (!result.ok) return res.status(404).json({ error: result.errors[0] });
    // the persisted chat history is part of the channel — gone with it
    chatStore.removeChannel(id);
    const evicted = evictChannelPeers(id, 'channelDeleted');
    if (evicted) log.info('Channel deleted by admin, peers evicted', { channel: id, evicted });
    audit.record('channelDelete', { id, evicted });
    res.json({ success: true });
});

/**
 * One-file server backup: channels.json + every persisted chat history file
 * as a tar.gz download (restore = unpack over a fresh data directory).
 * Streamed end-to-end (tar iterator -> gzip transform -> response), so the
 * whole archive is never held in memory regardless of history volume.
 */
/**
 * Backup payload shared by the admin download and the scheduled backup:
 * channels.json + every persisted chat history file as archive entries,
 * preflighted for readability so failures surface as a clean error instead
 * of a mid-stream abort after download headers are already sent.
 */
function collectBackupEntries() {
    const entries = [];
    if (fs.existsSync(channelStore.filePath)) {
        entries.push({ name: path.basename(channelStore.filePath), path: channelStore.filePath });
    }
    for (const id of chatStore.listFiles()) {
        const file = chatStore.existingFileFor(id);
        if (fs.existsSync(file)) entries.push({ name: `chat_history/${id}${path.extname(file)}`, path: file });
    }
    for (const entry of entries) fs.accessSync(entry.path, fs.constants.R_OK);
    return entries;
}

app.get('/api/admin/backup', requireAdmin, (req, res) => {
    try {
        const entries = collectBackupEntries();
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        res.set({
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="voice-channels-backup-${stamp}.tar.gz"`,
            'Cache-Control': 'no-store',
        });
        pipeline(Readable.from(createTarIterator(entries)), zlib.createGzip(), res, (err) => {
            if (err) log.error('Backup stream failed', { files: entries.length, error: err.message });
            else {
                log.info('Admin backup served', { files: entries.length });
                audit.record('backup', { files: entries.length });
            }
        });
    } catch (err) {
        log.error('Admin backup failed', { error: err.message });
        res.status(500).json({ error: 'backup failed' });
    }
});

/**
 * Restore a backup archive (see restore.js). The upload arrives as a raw
 * tar.gz body (bounded by the express.raw limit); every entry is validated
 * before anything on disk is replaced. Whole-state: history of channels not
 * present in the archive is removed. Best run while nobody is connected —
 * live sessions keep their in-memory rooms either way.
 */
// 64MB gzipped ceiling: a real archive (12MB/channel history budget) stays far
// below it, and the body + decompressed form both live in memory on a small host
app.post('/api/admin/restore', requireAdmin, express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'empty upload' });
    }
    try {
        const stats = await applyBackupArchive(req.body, { channelStore, chatStore });
        audit.record('restore', { channels: stats.channels, histories: stats.histories });
        // the rendered page cache embeds nothing channel-specific, but a
        // restored registry deserves a fresh start for any memoized views
        res.json({ success: true, ...stats });
    } catch (err) {
        const status = err instanceof RestoreError ? err.status : 500;
        if (status === 500) log.error('Admin restore failed', { error: err.message });
        res.status(status).json({ error: err.message });
    }
});

/** Newest-first tail of the audit trail (membership + admin data ops). */
app.get('/api/admin/audit', requireAdmin, (req, res) => {
    const limit = Number(req.query.limit) || 200;
    res.set('Cache-Control', 'no-store');
    res.json({ events: audit.tail(limit) });
});

/**
 * Server statistics for the admin console: registry/temp-room counts, live
 * membership, persisted history footprint and a per-channel online table.
 * Message counts come from the in-memory caches — channels nobody touched
 * since boot report their file size only (cheap; never a full disk walk).
 */
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store');
    let onlineTotal = 0;
    const activeChannels = [];
    for (const roomId of Object.keys(peers)) {
        const online = getPeerCount(roomId);
        if (!online) continue;
        onlineTotal += online;
        activeChannels.push({
            id: roomId,
            name: channelStore.get(roomId)?.name || channelStore.getTemp(roomId)?.name || roomId,
            temporary: channelStore.isTemp(roomId),
            online,
        });
    }
    let historyBytes = 0;
    let historyFiles = 0;
    let storedMessages = 0;
    for (const id of chatStore.listFiles()) {
        historyFiles++;
        try {
            historyBytes += fs.statSync(chatStore.existingFileFor(id)).size;
        } catch {
            /* raced a delete — the walk only feeds a summary */
        }
        const cached = chatStore.channels.get(id);
        if (cached) storedMessages += cached.messages.length;
    }
    activeChannels.sort((a, b) => b.online - a.online);
    res.json({
        registeredChannels: channelStore.channels.length,
        tempRooms: channelStore.temps.size,
        activeChannels,
        onlineTotal,
        historyFiles,
        historyBytes,
        storedMessages,
        retentionHours: channelStore.settings.chatRetentionHours,
        tempRoomsEnabled: tempRoomsEnabled(),
        consoleEnabled,
        scheduledBackup: BACKUP_INTERVAL_HOURS > 0 ? `${BACKUP_INTERVAL_HOURS}h × ${BACKUP_KEEP}` : 'off',
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.versions.node,
        appVersion: require('../../package.json').version,
    });
});

/**
 * Host export of a channel's chat history as Markdown (host JWT gated, same
 * re-checks as the join path: the host must still be configured for the
 * channel, or the fallback must still be valid for a hostless one).
 */
app.get('/api/host/:channelId/export', (req, res) => {
    const channelId = req.params.channelId;
    if (!channelStore.exists(channelId) || !channelsCfg.adminJwtSecret) {
        return res.status(404).json({ error: 'Not found' });
    }
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyConsoleToken(token);
    const fallbackOk =
        payload?.via === 'default-moderator' &&
        Boolean(channelsCfg.defaultModerator) &&
        channelStore.isHostless(channelId);
    if (!payload || payload.role !== 'host' || payload.channelId !== channelId || !payload.username) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    if (!channelStore.isHost(channelId, payload.username) && !fallbackOk) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const rows = chatStore.exportAll(channelId);
    const channel = channelStore.get(channelId);
    const lines = [`# ${channel.name || channelId} — ${tStamp(new Date())}`, ''];
    for (const row of rows) {
        const when = new Date(row.ts);
        let body = row.deleted ? '（已撤回）' : row.text || '';
        if (!row.deleted && Array.isArray(row.imgs))
            body += body ? ` [${row.imgs.length} image(s)]` : `[${row.imgs.length} image(s)]`;
        if (row.reply) body = `> ${row.reply.name}: ${row.reply.text}\n${body}`;
        const edited = !row.deleted && row.edited ? '（已编辑）' : '';
        lines.push(`**${tStamp(when)} ${row.name}:${edited}** ${body}`);
    }
    lines.push('');
    const md = lines.join('\n');
    res.set({
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="chat-${channelId}.md"`,
        'Cache-Control': 'no-store',
    });
    res.send(md);
    log.info('Host chat export served', { channel: channelId, rows: rows.length, host: payload.username });
});

/** Local-time-ish stamp for the export (server clock; readable is the goal). */
function tStamp(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

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
    for (const roomId of Object.keys(peers)) {
        totalRooms++;
        totalPeers += getPeerCount(roomId);
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
// Start
// ---------------------------------------------------------------------------

server.listen(port, null, () => {
    log.info(`Voice channel server started → http${host.includes('localhost') ? '' : 's'}://${host} (port ${port})`);
    log.info('Server config', {
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
    if (BACKUP_INTERVAL_HOURS > 0) startScheduledBackup();
});

// ---------------------------------------------------------------------------
// Scheduled rolling backup — same archive as the admin download, written to
// BACKUP_DIR on an interval and pruned to the newest BACKUP_KEEP files.
// ---------------------------------------------------------------------------

function startScheduledBackup() {
    const intervalMs = BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
    const run = () => {
        writeScheduledBackup()
            .then((file) => log.info('Scheduled backup written', { file }))
            .catch((err) => log.error('Scheduled backup failed', { error: err.message }));
    };
    // first copy right away (so a fresh deploy has one), then on the interval
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
}

/** Build the backup archive into BACKUP_DIR; resolves with the file path. */
function writeScheduledBackup() {
    return new Promise((resolve, reject) => {
        let entries;
        try {
            entries = collectBackupEntries();
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        } catch (err) {
            return reject(err);
        }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const outFile = path.join(BACKUP_DIR, `voice-channels-backup-${stamp}.tar.gz`);
        const out = fs.createWriteStream(outFile);
        pipeline(Readable.from(createTarIterator(entries)), zlib.createGzip(), out, (err) => {
            if (err) {
                fs.unlink(outFile, () => {});
                return reject(err);
            }
            pruneScheduledBackups();
            audit.record('scheduledBackup', { file: path.basename(outFile), entries: entries.length });
            resolve(outFile);
        });
    });
}

/** Keep only the newest BACKUP_KEEP archives in BACKUP_DIR. */
function pruneScheduledBackups() {
    try {
        const files = fs
            .readdirSync(BACKUP_DIR)
            .filter((name) => name.startsWith('voice-channels-backup-') && name.endsWith('.tar.gz'))
            .sort(); // stamps sort lexicographically = chronologically
        for (const name of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
            fs.unlinkSync(path.join(BACKUP_DIR, name));
        }
    } catch (err) {
        log.warn('Scheduled backup prune failed', { error: err.message });
    }
}

// ---------------------------------------------------------------------------
// Socket.IO signaling — mesh P2P (unchanged protocol core)
// ---------------------------------------------------------------------------

io.sockets.on('connect', async (socket) => {
    log.debug('[' + socket.id + '] connection accepted', {
        host: socket.handshake.headers.host.split(':')[0],
    });

    socket.channels = {};
    sockets[socket.id] = socket;

    /**
     * On peer disconnected
     */
    socket.on('disconnect', async (reason) => {
        // Intentional leaves (leave(), kickOut, admin evict, our own B1
        // rebuild) tear the session down at once. Everything else
        // (VPN/accelerator switch, network flap, sleep) becomes a ghost: the
        // session entry survives its grace window so the same uuid can
        // resume seamlessly.
        const intentional = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';
        for (const channel of Object.keys(socket.channels)) {
            if (intentional) await removePeerFrom(channel, socket, reason);
            else await detachAsGhost(channel, socket, reason);
        }
        log.debug('[' + socket.id + '] disconnected', { reason });
        delete sockets[socket.id];
        isChatFlooded.forget(socket.id); // per-socket rate windows die with the socket
        isChatPageFlooded.forget(socket.id);
        chatBatches.delete(socket.id); // pending image batches die with the sender
    });

    /**
     * On peer join — channel must exist in the persistent registry.
     * Presenter rights come ONLY from a valid host JWT for this channel.
     */
    socket.on('join', async (cfg) => {
        // set once room state has been written, so the catch below can roll a
        // half-joined socket back out (and skip rollback when a concurrent
        // same-uuid join owns the slot instead)
        let claimed = null;
        const handleJoin = async () => {
            const peer_ip = getSocketIP(socket);
            // channel_password stays raw — it is hash-verified, and a sanitizer
            // would silently change the effective secret (pre-fix stored hashes
            // keep verifying via channelStore's verifyPasswordCompat fallback)
            const config = sanitizeExceptSecrets(cfg, ['channel_password']);

            if (!Validate.isValidData(config)) return;
            // never log credentials (host JWT / room password)
            const { peer_token, channel_password, ...joinLogData } = config;
            log.debug('[' + socket.id + '] join', joinLogData);

            const { channel, peer_uuid } = config;

            // Brute-force guard: a source with too many consecutive failed
            // join authentications is silently ignored for the cooldown window
            if (isJoinThrottled(peer_ip)) {
                log.warn('[' + socket.id + '] join dropped: auth-failure cooldown', { channel });
                return;
            }

            if (!Validate.isValidRoomName(channel) || !channelStore.isValidId(channel)) {
                log.warn('[' + socket.id + '] invalid channel id', { channel });
                recordJoinFailure(peer_ip);
                return socket.emit('unauthorized');
            }

            // peer_uuid becomes the room-state key for this session (resume
            // matching, relay targets) — a strict uuid shape keeps it from ever
            // colliding with the room meta keys or polluting object prototypes
            if (!Validate.isValidSessionUuid(peer_uuid)) {
                log.warn('[' + socket.id + '] invalid peer_uuid', { channel });
                recordJoinFailure(peer_ip);
                return socket.emit('unauthorized');
            }

            // The join name rides every membership broadcast — require a real
            // string and cap it like every other name path (peerName/peerRename
            // cap at PEER_NAME_MAX), so a scripted join cannot push a
            // socket-packet-sized name into room state and member cards
            if (typeof config.peer_name !== 'string' || !config.peer_name.trim()) {
                log.warn('[' + socket.id + '] invalid peer_name', { channel });
                recordJoinFailure(peer_ip);
                return socket.emit('unauthorized');
            }
            const peer_name = config.peer_name.slice(0, limits.PEER_NAME_MAX);

            if (Object.hasOwn(socket.channels, channel)) {
                return log.debug('[' + socket.id + '] [Warning] already joined', channel);
            }

            // one page = one channel; a socket juggling several live channels at
            // once is a scripted client, not a browser visitor (admin-tunable:
            // settings.socketMaxChannels)
            const socketMaxChannels = channelStore.settings.socketMaxChannels;
            if (Object.keys(socket.channels).length >= socketMaxChannels) {
                log.warn('[' + socket.id + '] socket channel limit reached', {
                    channel,
                    joined: Object.keys(socket.channels),
                });
                return socket.emit('channelLimitReached', { max: socketMaxChannels });
            }

            // Channel must be registered — or, with temporary rooms enabled, any
            // valid id MAY become an ephemeral in-memory room. Temp creation is
            // DEFERRED until every auth check passed so a rejected join (bad
            // token/password) can never spawn (and later leak) an empty room.
            let channelDef = channelStore.get(channel);
            const wouldCreateTemp = !channelDef && tempRoomsEnabled();
            if (!channelDef && !wouldCreateTemp) {
                log.warn('[' + socket.id + '] channel not found in registry', { channel });
                return socket.emit('channelNotFound');
            }

            // Presenter: valid host JWT issued for THIS channel, and the host must
            // still be configured (token may predate a config change). Fallback
            // tokens (via: 'default-moderator', issued by host login for channels
            // without configured hosts) stay valid only while the channel is STILL
            // hostless and the shared default-moderator feature is enabled.
            let is_presenter = false;
            if (peer_token) {
                const payload = verifyConsoleToken(peer_token);
                const fallbackModeratorOk =
                    payload?.via === 'default-moderator' &&
                    Boolean(channelsCfg.defaultModerator) &&
                    channelStore.isHostless(channel);
                if (
                    payload &&
                    payload.role === 'host' &&
                    payload.channelId === channel &&
                    payload.username &&
                    (channelStore.isHost(channel, payload.username) || fallbackModeratorOk)
                ) {
                    is_presenter = true;
                    log.debug('[' + socket.id + '] joining as host', {
                        channel,
                        username: payload.username,
                        via: payload.via || 'configured',
                    });
                } else {
                    log.warn('[' + socket.id + '] invalid host token for channel', { channel });
                    recordJoinFailure(peer_ip);
                    return socket.emit('unauthorized');
                }
            }

            // Persistent channel password (set in the admin console). Hosts
            // authenticate with their own credentials and always pass. A pending
            // temp room (channelDef still null) has no password yet.
            // Verification is async (threadpool scrypt) — a wrong-password
            // join flood must not stall the event loop.
            if (
                !is_presenter &&
                channelDef?.passwordHash &&
                !(await channelStore.verifyChannelPassword(channel, channel_password))
            ) {
                log.debug('[' + socket.id + '] [Warning] channel password required/invalid', { channel });
                recordJoinFailure(peer_ip);
                return socket.emit('channelPasswordRequired');
            }

            // Session resume: a rejoin carrying the SAME peer_uuid is this page's
            // session reconnecting (each join() mints a fresh uuid). While the
            // previous socket's entry is still in its ghost grace window, REBIND
            // it to the new socket and keep the session — the other members never
            // saw a removePeer, their peer connections stay up and heal via ICE
            // restart instead of a full renegotiation. A name change or a still
            // LIVE old socket is not a resume: evict the old session and rebuild.
            // (Never matches a second tab — it would have its own uuid.)
            let is_rejoin = false;
            let resumed = false;
            let keepJoinedAt = Date.now();
            const existingEntry = Object.hasOwn(peers, channel) ? peers[channel][peer_uuid] : null;
            if (existingEntry && !roomMetaKeys.has(peer_uuid)) {
                const nameMatches = existingEntry.peer_name === peer_name;
                if (existingEntry.ghost && nameMatches) {
                    is_rejoin = true;
                    resumed = true;
                    keepJoinedAt = existingEntry.joined_at;
                    clearTimeout(ghosts.get(ghostKey(channel, peer_uuid)));
                    ghosts.delete(ghostKey(channel, peer_uuid));
                    delete channels[channel]?.[existingEntry.socket_id];
                    if (sockets[existingEntry.socket_id]) delete sockets[existingEntry.socket_id].channels[channel]; // dead socket bookkeeping
                    existingEntry.ghost = false;
                    existingEntry.socket_id = socket.id;
                    log.debug('[' + socket.id + '] session resumed in grace window', { channel });
                } else {
                    is_rejoin = nameMatches; // same session returning under a live socket: capacity/lock bypass parity
                    await reapSession(channel, peer_uuid, existingEntry);
                    log.debug('[' + socket.id + '] reaped stale session on rejoin', { channel, resumed: false });
                }
            }

            // Capacity hard check (hosts may always join to manage their channel)
            const maxParticipants = channelDef?.maxParticipants || limits.DEFAULT_MAX_PARTICIPANTS;
            if (!is_presenter && !is_rejoin && getPeerCount(channel) >= maxParticipants) {
                log.debug('[' + socket.id + '] channel is full', {
                    channel,
                    count: getPeerCount(channel),
                    maxParticipants,
                });
                return socket.emit('roomIsBusy', { maxParticipants });
            }

            // Room-level locks (read before any room structure is created so a
            // rejected join never leaves an empty room behind). The room password
            // is stored verbatim by roomAction and compared verbatim here.
            const roomLocked =
                peers[channel]?.['lock'] === true && !safeEqualStrings(peers[channel]?.['password'], channel_password);
            if (roomLocked) {
                log.debug('[' + socket.id + '] [Warning] room is locked', { channel });
                recordJoinFailure(peer_ip);
                return socket.emit('roomIsLocked');
            }

            const isPresenterNow = is_presenter || presenters[channel]?.[peer_uuid]?.is_presenter === true;

            // Room-level join lock blocks NEW joiners only — a reconnecting
            // member (same uuid, resumed or reaped above) was already inside.
            const joinLocked = peers[channel]?.['joinLock'] === true && !is_rejoin && !isPresenterNow;
            if (joinLocked) {
                log.debug('[' + socket.id + '] [Warning] room is join-locked', { channel });
                return socket.emit('roomIsJoinLocked');
            }

            // Auth passed — only now materialize a pending temporary room, so a
            // rejected join never leaves one behind (getOrCreateTemp returns null
            // at the global / per-IP caps)
            if (!channelDef) {
                if (channelStore.getTemp(channel)) {
                    // joining a room someone already spawned: no creation, no quota
                } else {
                    const quota = channelStore.checkTempQuota(peer_ip);
                    if (!quota.ok) {
                        log.warn('[' + socket.id + '] temp room quota exceeded', { channel, reason: quota.reason });
                        return socket.emit('tempRoomLimitReached', {
                            reason: quota.reason,
                            max: channelStore.settings.tempMaxPerIp,
                        });
                    }
                    channelDef = channelStore.getOrCreateTemp(channel, { creatorIp: peer_ip });
                    if (!channelDef) {
                        log.warn('[' + socket.id + '] temp room cap reached', { channel });
                        return socket.emit('channelNotFound');
                    }
                }
            }

            // Auth passed — safe to create the room structures now
            if (!Object.hasOwn(channels, channel)) channels[channel] = {};
            if (!Object.hasOwn(peers, channel)) peers[channel] = {};
            if (!Object.hasOwn(presenters, channel)) presenters[channel] = {};

            if (is_presenter) {
                // keyed by session uuid: the presenter role survives reconnects
                // (the ghost grace keeps the entry) and can only ever be held by
                // a session that presented valid host credentials at join time
                presenters[channel][peer_uuid] = { peer_ip, peer_name, is_presenter: true };
                log.debug('[' + socket.id + '] joining as host', {
                    channel,
                    username: peer_name,
                });
            }

            const isPresenter = isPresenterNow;

            peers[channel][peer_uuid] = {
                peer_name: peer_name,
                peer_presenter: isPresenter,
                peer_audio: config.peer_audio === true,
                peer_audio_status: config.peer_audio === true,
                joined_at: keepJoinedAt,
                socket_id: socket.id,
                ghost: false,
            };
            claimed = { channel, uuid: peer_uuid };

            await addPeerTo(channel, socket, peer_uuid, { rejoin: resumed });

            // Same-uuid race: a concurrent join may have claimed (or reaped and
            // replaced) the slot while addPeerTo awaited. If the uuid no longer
            // points at THIS socket, the other session won — stand down without
            // touching room state. The mesh self-heals: peer connections are
            // uuid-keyed, so the winner's addPeer supersedes ours.
            if (peers[channel]?.[peer_uuid]?.socket_id !== socket.id) {
                claimed = null;
                log.warn('[' + socket.id + '] concurrent same-uuid join lost the race, standing down', { channel });
                return socket.emit('kickOut', { peer_kicked_reason: 'session superseded' });
            }

            channels[channel][socket.id] = socket;
            socket.channels[channel] = { uuid: peer_uuid, name: peer_name };

            // info (not debug): membership is the one thing an operator must be
            // able to reconstruct from default logs, plus the audit trail
            log.info('[join] peer joined', {
                channel,
                name: peer_name,
                uuid: peer_uuid,
                presenter: isPresenter,
                resumed,
                peers: getPeerCount(channel),
            });
            audit.record('join', {
                channel,
                name: peer_name,
                presenter: isPresenter,
                resumed,
                ip: getSocketIP(socket),
            });

            joinFailures.delete(joinFailKey(peer_ip)); // a successful join resets the failure counter

            // Catch the newcomer up on the persisted chat history BEFORE
            // serverInfo, so it renders above the "you joined" line. Emitted on
            // every (re)join — possibly empty — so the client sees exactly one
            // block per join and can ignore the replays after reconnects. Only
            // the newest page rides along; the client pulls older ones via
            // 'chatPage' when it scrolls to the top. chatStore.history() applies
            // the page-size AND payload budgets and reports hasMore.
            const chatPage = chatStore.history(channel, { persistent: !channelStore.isTemp(channel) });
            await sendToPeer(socket.id, sockets, 'chatHistory', chatPage);

            // Send room info to the joined peer
            await sendToPeer(socket.id, sockets, 'serverInfo', {
                peers_count: getPeerCount(channel),
                peers: getRoomPeers(channel),
                is_presenter: isPresenter,
                join_locked: peers[channel]['joinLock'] === true,
                room_locked: peers[channel]['lock'] === true,
                maxRoomParticipants: maxParticipants,
            });
        };

        try {
            await handleJoin();
        } catch (err) {
            // a failed join must never leave half-built room state behind (the
            // global unhandledRejection net only logs) — tell the client and
            // roll back whatever this join had claimed
            log.error('Join handler failed', { socket_id: socket.id, error: err.message, stack: err.stack });
            if (
                claimed &&
                Object.hasOwn(peers, claimed.channel) &&
                peers[claimed.channel][claimed.uuid]?.socket_id === socket.id
            ) {
                delete socket.channels[claimed.channel];
                delete channels[claimed.channel]?.[socket.id];
                releaseRoomEntry(claimed.channel, claimed.uuid);
                broadcastRemovePeer(claimed.channel, claimed.uuid, socket.id);
                log.warn('Join rolled back after handler error', { channel: claimed.channel, uuid: claimed.uuid });
            }
            socket.emit('joinError', { error: 'join failed' });
        }
    });

    /**
     * Relay ICE to peers (peer_id = target session uuid)
     */
    socket.on('relayICE', async (config) => {
        if (!Validate.isValidData(config)) return;
        const { peer_id, ice_candidate } = config;
        const channel = sharedRoom(socket, peer_id);
        const target = channel && liveSessionSocket(channel, peer_id);
        if (!target) return;
        target.emit('iceCandidate', {
            peer_id: socket.channels[channel].uuid,
            ice_candidate: ice_candidate,
        });
    });

    /**
     * Relay SDP to peers (peer_id = target session uuid)
     */
    socket.on('relaySDP', async (config) => {
        if (!Validate.isValidData(config)) return;
        const { peer_id, session_description } = config;
        const channel = sharedRoom(socket, peer_id);
        const target = channel && liveSessionSocket(channel, peer_id);
        if (!target) return;
        log.debug('[' + socket.id + '] relay SessionDescription to [' + peer_id + ']', {
            type: session_description.type,
        });
        target.emit('sessionDescription', {
            peer_id: socket.channels[channel].uuid,
            session_description: session_description,
        });
    });

    /**
     * Handle Room action (presenter gated): lock/unlock/joinLock.
     * (A former `checkPassword` action was removed: nothing in the client used
     * it and it let any socket probe the room password unauthenticated.)
     */
    socket.on('roomAction', async (cfg) => {
        // the room lock password is stored/compared verbatim (memory-only, so
        // no legacy form exists) — sanitize everything EXCEPT the secret
        const config = sanitizeExceptSecrets(cfg, ['password']);
        if (!Validate.isValidData(config)) return;

        const { room_id, password, action } = config;

        // the sender must be a joined member of the room (also blocks probes
        // against arbitrary or inherited map keys)
        const senderUuid = roomSessionUuid(socket, room_id);
        if (!senderUuid) return;

        const isPresenter = presenters[room_id]?.[senderUuid]?.is_presenter === true;
        const peer_name = peers[room_id][senderUuid].peer_name;

        try {
            switch (action) {
                case 'lock':
                    if (!isPresenter) return;
                    peers[room_id]['lock'] = true;
                    peers[room_id]['password'] = password;
                    await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                    break;
                case 'unlock':
                    if (!isPresenter) return;
                    delete peers[room_id]['lock'];
                    delete peers[room_id]['password'];
                    await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                    break;
                case 'joinLockOn':
                    if (!isPresenter) return;
                    peers[room_id]['joinLock'] = true;
                    await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                    break;
                case 'joinLockOff':
                    if (!isPresenter) return;
                    delete peers[room_id]['joinLock'];
                    await sendToRoom(room_id, socket.id, 'roomAction', { peer_name, action });
                    break;
                default:
                    break;
            }
        } catch (err) {
            log.error('Room action', toJson(err));
        }
    });

    /**
     * Relay NAME to peers
     */
    socket.on('peerName', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id, peer_name_old } = config;
        // same 24-char cap as the join path (see handleJoin)
        const peer_name_new =
            typeof config.peer_name_new === 'string'
                ? config.peer_name_new.slice(0, limits.PEER_NAME_MAX)
                : config.peer_name_new;

        const entry = Object.hasOwn(peers, room_id) ? peers[room_id][senderUuid] : null;
        if (!entry) return;

        entry['peer_name'] = peer_name_new;
        if (presenters[room_id] && presenters[room_id][senderUuid]) {
            presenters[room_id][senderUuid]['peer_name'] = peer_name_new;
        }
        log.debug('[' + socket.id + '] peer profile changed', { peer_name_old, peer_name_new });

        await sendToRoom(room_id, socket.id, 'peerName', {
            peer_id: senderUuid,
            peer_name: peer_name_new,
        });
    });

    /**
     * Host renames another peer (moderation). The renamed peer receives the
     * same peerName broadcast as everyone else and accepts the new name.
     */
    socket.on('peerRename', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id, peer_id } = config;

        if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) {
            log.debug('peerRename blocked: sender is not the presenter', { room_id, socket_id: socket.id });
            return;
        }

        const name =
            typeof config.peer_name_new === 'string' ? config.peer_name_new.trim().slice(0, limits.PEER_NAME_MAX) : '';
        // the rename target must be a joined member of the room
        if (!name || !isPeerInRoom(room_id, peer_id)) return;

        const old = peers[room_id][peer_id]['peer_name'];
        peers[room_id][peer_id]['peer_name'] = name;
        if (presenters[room_id] && presenters[room_id][peer_id]) {
            presenters[room_id][peer_id]['peer_name'] = name;
        }
        log.info('[' + socket.id + '] host renamed peer', { room_id, peer_id, from: old, to: name });

        // everyone INCLUDING the host gets the update — the host's member list
        // and the chat notice must follow too (sendToRoom would skip the sender)
        for (const sock of Object.values(channels[room_id] || {})) {
            sock.emit('peerName', { peer_id, peer_name: name, peer_name_old: old });
        }
    });

    /**
     * Set/clear a peer's custom avatar. The data URL never goes through
     * checkXSS (DOMPurify strips data: URIs) — it is validated against a
     * strict whitelist + size cap instead, exactly like the DataChannel
     * image protocol, and is only ever rendered as an <img src>.
     */
    socket.on('peerAvatar', async (cfg) => {
        const ctx = roomSender(socket, cfg, { sanitize: false }); // data URLs never ride checkXSS
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id, avatar } = config;

        const valid =
            typeof avatar === 'string' &&
            avatar.length > 0 &&
            avatar.length <= limits.AVATAR_MAX_CHARS &&
            limits.IMAGE_DATA_URL_RE.test(avatar);
        if (valid) {
            peers[room_id][senderUuid]['peer_avatar'] = avatar;
        } else {
            delete peers[room_id][senderUuid]['peer_avatar'];
        }

        const peer_name = peers[room_id][senderUuid]['peer_name'];
        log.debug('[' + socket.id + '] peer avatar ' + (valid ? 'set' : 'cleared'), { room_id });

        // everyone INCLUDING the sender — the sender's own DOM is already
        // up to date, the echo just keeps the room in lockstep
        for (const sock of Object.values(channels[room_id] || {})) {
            sock.emit('peerAvatar', {
                peer_id: senderUuid,
                peer_name,
                avatar: valid ? avatar : null,
            });
        }
    });

    /**
     * Relay audio/deafen/share status to peers. 'audio' is the mic state;
     * 'deafen' marks a member who silenced ALL remote audio locally;
     * 'share' marks a member whose captured system/tab sound is mixed into
     * their outgoing stream ("listen together").
     */
    socket.on('peerStatus', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id, element, status } = config;

        if (element === 'audio') peers[room_id][senderUuid]['peer_audio_status'] = status === true;
        else if (element === 'deafen') peers[room_id][senderUuid]['peer_deafen'] = status === true;
        else if (element === 'share') peers[room_id][senderUuid]['peer_share'] = status === true;
        else return;

        await sendToRoom(room_id, socket.id, 'peerStatus', {
            peer_id: senderUuid,
            peer_name: peers[room_id][senderUuid]['peer_name'],
            element,
            status: status === true,
        });
    });

    /**
     * Chat persistence: the DataChannel mesh delivers messages live; the
     * SENDER relays a copy here so it lands in the history store for late
     * joiners. The server never broadcasts on this path — storage only.
     *
     * A submit with images = one HEAD event ({msg, batch, imgs: count}) plus
     * one event per image ({batch, img: dataUrl}) — each image rides alone
     * because a whole batch can exceed the socket.io packet cap. Flood-gated
     * and member-gated; contents are never logged.
     */
    socket.on('chat', async (cfg) => {
        const ctx = roomSender(socket, cfg, { sanitize: false }); // image payloads ride raw
        if (!ctx) return;
        const senderUuid = ctx.senderUuid;
        const { room_id } = ctx.config;

        if (isChatFlooded(socket.id)) {
            log.debug('[' + socket.id + '] chat dropped: flood guard', { room_id });
            return;
        }

        // image part of a pending batch
        if (typeof cfg.img === 'string') {
            const batch = typeof cfg.batch === 'string' && cfg.batch.length <= 64 ? cfg.batch : '';
            const pending = batch ? chatBatches.get(socket.id)?.get(batch) : null;
            if (!pending || pending.room_id !== room_id) return;
            // push only up to the announced count so duplicate/extra events can't bloat the row
            if (pending.images.length < pending.expected) {
                const image = sanitizeChatImage(cfg.img);
                if (image) pending.images.push(image);
            }
            if (pending.images.length >= pending.expected) {
                chatBatches.get(socket.id).delete(batch);
                finalizeChatBatch(socket.id, pending);
            }
            return;
        }

        // text-only send, or the head of an image batch
        // (checkXSS on the text ONLY — DOMPurify strips data: URIs, so image
        // payloads must never ride through it; same split as peerAvatar)
        const sanitized = checkXSS(typeof cfg.msg === 'string' ? cfg.msg : '');
        const text = typeof sanitized === 'string' ? sanitized.slice(0, limits.CHAT_TEXT_MAX) : '';
        const imageCount = Number.isInteger(cfg.imgs) && cfg.imgs > 0 && cfg.imgs <= 9 ? cfg.imgs : 0;
        if (!text && !imageCount) return;

        const peer_name = peers[room_id]?.[senderUuid]?.peer_name; // the JOINED name, server-side state
        if (!peer_name) return;

        // optional reply quote riding along (rendered as a quote block by the
        // receiver and persisted with the row)
        const reply = sanitizeChatReply(cfg.reply);
        if (!imageCount) {
            const stored = chatStore.append(
                room_id,
                { name: peer_name, text, imgs: [], ...(reply ? { reply } : {}) },
                { persistent: !channelStore.isTemp(room_id) }
            );
            // the sender rendered its own row with a local timestamp; hand back
            // the authoritative ts so edit/recall/reaction can find that row
            if (stored) socket.emit('chatAck', { ts: stored.ts });
            return;
        }

        const batch = typeof cfg.batch === 'string' && cfg.batch.length <= 64 ? cfg.batch : '';
        if (!batch) return; // image batches must carry a client-generated id
        chatBatchSweep();
        let batches = chatBatches.get(socket.id);
        if (!batches) {
            batches = new Map();
            chatBatches.set(socket.id, batches);
        } else if (batches.size >= CHAT_BATCHES_PER_SOCKET) {
            return; // finish what's in flight before opening another batch
        }
        batches.set(batch, { room_id, name: peer_name, text, expected: imageCount, images: [], reply, ts: Date.now() });
    });

    /**
     * Scroll-up pagination for the persisted chat history: the client asks
     * for the page strictly older than its cursor (`before` ts) and gets it
     * back on the ack — request and response stay paired without any
     * client-side request ids. Read-only and member-gated; the page size is
     * server-fixed (never trusted from the client). Throttled per socket:
     * every call runs a prune + image-payload estimate, so a scripted client
     * must not be able to spin the disk.
     */
    socket.on('chatPage', (cfg, ack) => {
        const ctx = roomSender(socket, cfg, { sanitize: false }); // read-only: only before/count fields
        if (!ctx) return;
        if (isChatPageFlooded(socket.id)) return;
        const before = Number.isFinite(ctx.config.before) && ctx.config.before > 0 ? ctx.config.before : 0;
        const page = chatStore.history(ctx.config.room_id, {
            persistent: !channelStore.isTemp(ctx.config.room_id),
            before,
        });
        if (typeof ack === 'function') ack(page);
    });

    /**
     * Message lifecycle after delivery: edit / recall / emoji reaction. These
     * ride the socket (not the DataChannel) so text-only members and
     * mid-session joiners see them too; the server is the single writer of
     * the history store, everyone (sender included) gets one broadcast.
     * Identity: the acting name always comes from the JOINED session state —
     * edits/recalls are therefore limited to one's own rows, except that a
     * presenter may recall anything (moderation).
     */
    socket.on('chatEdit', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id } = config;
        if (isChatFlooded(socket.id)) return;

        const peer_name = peers[room_id]?.[senderUuid]?.peer_name;
        const ts = Number(config.ts);
        const text = typeof config.msg === 'string' ? config.msg.slice(0, limits.CHAT_TEXT_MAX) : '';
        if (!peer_name || !Number.isFinite(ts) || ts <= 0 || !text.trim()) return;

        const persistent = !channelStore.isTemp(room_id);
        const updated = chatStore.edit(room_id, { ts, name: peer_name, text }, { persistent });
        if (!updated) return;
        await broadcastToRoom(room_id, 'chatEdit', { ts, name: peer_name, text: updated.text });
    });

    socket.on('chatDelete', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id } = config;
        if (isChatFlooded(socket.id)) return;

        const peer_name = peers[room_id]?.[senderUuid]?.peer_name;
        const ts = Number(config.ts);
        const targetName = typeof config.name === 'string' ? config.name.slice(0, limits.PEER_NAME_MAX) : '';
        if (!peer_name || !Number.isFinite(ts) || ts <= 0 || !targetName) return;
        // presenters may recall anyone's message; members only their own
        const isPresenter = presenters[room_id]?.[senderUuid]?.is_presenter === true;
        if (targetName !== peer_name && !isPresenter) return;

        const persistent = !channelStore.isTemp(room_id);
        const updated = chatStore.remove(room_id, { ts, name: targetName }, { persistent });
        if (!updated) return;
        if (isPresenter && targetName !== peer_name) {
            audit.record('hostRecall', { channel: room_id, by: peer_name, target: targetName });
        }
        await broadcastToRoom(room_id, 'chatDelete', { ts, name: targetName, by: peer_name });
    });

    socket.on('chatReact', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id } = config;
        if (isChatFlooded(socket.id)) return;

        const peer_name = peers[room_id]?.[senderUuid]?.peer_name;
        const ts = Number(config.ts);
        const targetName = typeof config.name === 'string' ? config.name.slice(0, limits.PEER_NAME_MAX) : '';
        // checkXSS never sees the emoji (DOMPurify would mangle non-ASCII
        // markup-free strings harmlessly, but keep the payload raw + capped
        // like the image/emoji paths): shape-check it directly instead
        const emoji = typeof cfg.emoji === 'string' ? cfg.emoji.slice(0, limits.REACTION_EMOJI_MAX) : '';
        if (!peer_name || !Number.isFinite(ts) || ts <= 0 || !targetName || !emoji) return;

        const persistent = !channelStore.isTemp(room_id);
        const updated = chatStore.react(
            room_id,
            { ts, name: targetName, emoji, who: peer_name, op: cfg.op },
            { persistent }
        );
        if (!updated) return;
        await broadcastToRoom(room_id, 'chatReact', {
            ts,
            name: targetName,
            emoji,
            who: peer_name,
            reactions: updated.reactions || null,
        });
    });

    /**
     * Relay actions to peers (presenter gated for moderation actions).
     * peer_id (when targeted) is the target's session uuid.
     */
    socket.on('peerAction', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id, peer_id, peer_action, send_to_all } = config;

        // Only the presenter may run moderation actions
        const presenterActions = ['muteAudio', 'ejectAll'];
        if (presenterActions.includes(peer_action)) {
            if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) return;
        }

        const targetName = isPeerInRoom(room_id, peer_id) ? peers[room_id][peer_id].peer_name : config.peer_name;
        const data = { peer_id, peer_name: targetName, peer_action };

        if (send_to_all) {
            await sendToRoom(room_id, socket.id, 'peerAction', data);
        } else {
            // targeted action: the target must share a room with the sender
            // (same membership gate as the SDP/ICE relay)
            const channel = sharedRoom(socket, peer_id);
            const target = channel && liveSessionSocket(channel, peer_id);
            if (!target) return;
            target.emit('peerAction', data);
        }
    });

    /**
     * Kick out peer from room (presenter only). peer_id is the TARGET's
     * session uuid; the caller's identity is the server-bound session, not
     * anything the client supplies.
     */
    socket.on('kickOut', async (cfg) => {
        const ctx = roomSender(socket, cfg);
        if (!ctx) return;
        const { config, senderUuid } = ctx;
        const { room_id, peer_id, peer_kicked_reason } = config;

        if (!isPeerInRoom(room_id, peer_id)) return;

        if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) return;

        const target = liveSessionSocket(room_id, peer_id);
        if (!target) return;
        log.info('[' + socket.id + '] kick out peer [' + peer_id + '] from room [' + room_id + ']', {
            by: peers[room_id][senderUuid].peer_name,
            target: peers[room_id][peer_id]?.peer_name,
        });
        audit.record('hostKick', {
            channel: room_id,
            by: peers[room_id][senderUuid].peer_name,
            target: peers[room_id][peer_id]?.peer_name,
            reason: peer_kicked_reason,
        });
        target.emit('kickOut', {
            peer_name: peers[room_id][senderUuid].peer_name,
            peer_kicked_reason: peer_kicked_reason,
        });
    });

    /**
     * Add peers to channel (mesh: notify every existing peer + the newcomer).
     * Peer ids are SESSION uuids — on a resume both sides already carry the
     * peer connection (the client's mesh.addPeer no-ops for known ids), so
     * this costs a sync event, not a renegotiation.
     * @param {string} channel channel id
     * @param {object} joiner the joining socket
     * @param {string} joinerUuid its session uuid
     * @param {object} [opts] { rejoin } — true suppresses the client-side join announcement
     */
    async function addPeerTo(channel, joiner, joinerUuid, { rejoin = false } = {}) {
        const roomPeers = getRoomPeers(channel);
        for (const [id, sock] of Object.entries(channels[channel] || {})) {
            if (id === joiner.id) continue; // joiner is told about everyone below
            const memberUuid = sock.channels?.[channel]?.uuid;
            if (!memberUuid || memberUuid === joinerUuid) continue;
            sock.emit('addPeer', {
                peer_id: joinerUuid,
                peers: roomPeers,
                should_create_offer: false,
                rejoin,
                iceServers: getIceServers(),
            });
            joiner.emit('addPeer', {
                peer_id: memberUuid,
                peers: roomPeers,
                should_create_offer: true,
                rejoin,
                iceServers: getIceServers(),
            });
            log.debug('[' + joiner.id + '] emit addPeer [' + memberUuid + ']');
        }
    }

    /**
     * Send async data to all peers in the same room except yourself
     */
    async function sendToRoom(room_id, socket_id, msg, config = {}) {
        // Object.hasOwn keeps inherited keys ('constructor' etc.) out of the lookup
        const room = room_id && Object.hasOwn(channels, room_id) ? channels[room_id] : {};
        for (const [peer_id, sock] of Object.entries(room)) {
            if (peer_id != socket_id) {
                sock.emit(msg, config);
            }
        }
    }

    /**
     * Send async data to EVERY member of a room, sender included — used by
     * chat lifecycle events (edit/recall/react) where the sender's DOM must
     * follow the server-persisted result like everyone else's.
     */
    async function broadcastToRoom(room_id, msg, config = {}) {
        for (const sock of Object.values(channels[room_id] || {})) {
            sock.emit(msg, config);
        }
    }

    /**
     * Send async data to specified peer
     */
    async function sendToPeer(peer_id, sockets, msg, config = {}) {
        if (peer_id && Object.hasOwn(sockets, peer_id)) {
            sockets[peer_id].emit(msg, config);
        }
    }
}); // end [io.sockets.on-connect]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Join authentication cooldown (brute-force guard)
// ---------------------------------------------------------------------------

// Consecutive failed join authentications (invalid id, bad/missing host token,
// wrong channel or room password) per client IP. Keyed by IP, NOT socket.id:
// a reconnecting client mints a fresh socket (and a fresh counter), which made
// the old per-socket limit trivially bypassable. At JOIN_FAIL_LIMIT further
// joins from that IP are ignored for JOIN_FAIL_COOLDOWN_MS — the join path
// must not become a password brute-force oracle. The counter resets on a
// successful join; the limit sits above the old per-socket 5 so a NAT
// household collectively mistyping one password does not lock itself out.
const JOIN_FAIL_LIMIT = 10;
const JOIN_FAIL_COOLDOWN_MS = 60 * 1000;
const JOIN_FAIL_SWEEP_AT = 1024;
const joinFailures = new Map(); // normalized ip -> { count, ts } (ts = last failure)

function joinFailKey(ip) {
    // normalize so IPv6 rotation inside one /64 cannot mint fresh counters
    return ChannelStore.normalizeIp(ip) || String(ip || '');
}

function isJoinThrottled(ip) {
    const entry = joinFailures.get(joinFailKey(ip));
    if (!entry || entry.count < JOIN_FAIL_LIMIT) return false;
    // the window is measured from the last failure; once it elapses the source
    // gets a fresh attempt (a new failure re-arms the cooldown)
    return Date.now() - entry.ts < JOIN_FAIL_COOLDOWN_MS;
}

function recordJoinFailure(ip) {
    const key = joinFailKey(ip);
    const entry = joinFailures.get(key) || { count: 0, ts: 0 };
    entry.count++;
    entry.ts = Date.now();
    joinFailures.set(key, entry);
    // IPs that never come back must not accumulate forever
    if (joinFailures.size > JOIN_FAIL_SWEEP_AT) {
        const now = Date.now();
        for (const [stale, e] of joinFailures) {
            if (e.count < JOIN_FAIL_LIMIT || now - e.ts >= JOIN_FAIL_COOLDOWN_MS) joinFailures.delete(stale);
        }
    }
}

// ---------------------------------------------------------------------------
// Chat history flood guard
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate guard: timestamps per key inside the window, true once
 * the key is over its budget. Shared by the chat persistence and the history
 * pagination paths — both touch disk per call, so a scripted client must not
 * be able to spin either.
 */
function makeRateGuard({ max, windowMs }) {
    const stamps = new Map(); // key -> timestamps inside the window
    const guard = (key, now = Date.now()) => {
        const list = (stamps.get(key) || []).filter((ts) => now - ts < windowMs);
        if (list.length >= max) {
            stamps.set(key, list);
            return true;
        }
        list.push(now);
        stamps.set(key, list);
        return false;
    };
    guard.forget = (key) => stamps.delete(key); // socket gone: drop its window
    return guard;
}

// Per-socket persistence rate: human typing never approaches this; a scripted
// flood would grow (and constantly rewrite) the history files. The live P2P
// delivery is unaffected — only the history copy is dropped. The budget must
// cover image batches too (1 head + up to 9 image events).
const isChatFlooded = makeRateGuard({ max: 24, windowMs: 10 * 1000 });

// Pending image batches: head event received, image events still arriving.
// Keyed per socket so ids can never collide across senders; entries flush
// (with whatever images arrived) after the TTL.
const CHAT_BATCH_TTL_MS = 30 * 1000;
const CHAT_BATCHES_PER_SOCKET = 3;
const chatBatches = new Map(); // socket.id -> Map(batchId -> pending)

// The batch TTL must also fire without new traffic: a sender whose image
// events never completed would otherwise hold its pending batches (up to
// 3 × ~1.6MB) in memory until it disconnects. The sweep-on-new-batch alone
// is not enough for a socket that simply goes idle.
setInterval(() => {
    try {
        chatBatchSweep();
    } catch (err) {
        log.error('Chat batch sweep failed', { error: err.message });
    }
}, 60 * 1000).unref?.();

function sanitizeChatImage(url) {
    return typeof url === 'string' &&
        url.length > 0 &&
        url.length <= limits.IMAGE_MAX_CHARS &&
        limits.IMAGE_DATA_URL_RE.test(url)
        ? url
        : '';
}

/** Optional reply-quote payload on a chat event: strict shape, tiny caps. */
function sanitizeChatReply(reply) {
    if (!reply || typeof reply !== 'object') return null;
    const name = typeof reply.name === 'string' ? reply.name.slice(0, limits.PEER_NAME_MAX) : '';
    const text = typeof reply.text === 'string' ? reply.text.slice(0, limits.REPLY_TEXT_MAX) : '';
    const ts = Number(reply.ts);
    if (!name || !text || !Number.isFinite(ts) || ts <= 0) return null;
    return { name, text, ts };
}

// chatPage is read-only but not free (prune + per-row payload estimate per
// call), so a member cannot spin it either. Looser than the write budget —
// a fast scroll through history legitimately fires bursts of pages.
const isChatPageFlooded = makeRateGuard({ max: 30, windowMs: 10 * 1000 });

/** Store a completed (or TTL-expired) batch as one history row. */
function finalizeChatBatch(socketId, pending) {
    const stored = chatStore.append(
        pending.room_id,
        {
            name: pending.name,
            text: pending.text,
            imgs: pending.images,
            ...(pending.reply ? { reply: pending.reply } : {}),
        },
        { persistent: !channelStore.isTemp(pending.room_id) }
    );
    // same authoritative-ts handshake as the text path (see the chat handler)
    if (stored) sockets[socketId]?.emit('chatAck', { ts: stored.ts });
}

/** Flush expired pending batches so a sender whose image events never
 * completed doesn't lose the text of the message. */
function chatBatchSweep(now = Date.now()) {
    for (const [socketId, batches] of chatBatches) {
        for (const [batch, pending] of batches) {
            if (now - pending.ts > CHAT_BATCH_TTL_MS) {
                batches.delete(batch);
                finalizeChatBatch(socketId, pending);
            }
        }
        if (!batches.size) chatBatches.delete(socketId);
    }
}

/**
 * Check if a session uuid is a joined member of the given room. Ghosts count
 * as members — they are still inside their grace window.
 */
function isPeerInRoom(room_id, peer_uuid) {
    if (!room_id || !peer_uuid || !Object.hasOwn(peers, room_id)) return false;
    // room meta keys ('lock'/'password'/'joinLock') are never members
    return Object.hasOwn(peers[room_id], peer_uuid) && !roomMetaKeys.has(peer_uuid);
}

/**
 * The sender's session uuid in a room, when the sender has actually joined
 * it (server-side state — clients cannot claim another session's identity).
 */
function roomSessionUuid(socket, roomId) {
    const uuid = socket.channels?.[roomId]?.uuid;
    return uuid && isPeerInRoom(roomId, uuid) ? uuid : null;
}

/**
 * Shared preamble of the room-scoped socket handlers: sanitize the payload
 * (callers carrying fields that must stay raw — images, emoji — opt out and
 * sanitize their text fields individually), drop malformed packets, and
 * resolve the sender's joined-session uuid for the room the packet names.
 * Returns null when the packet must be dropped silently.
 */
function roomSender(socket, raw, { sanitize = true } = {}) {
    const config = sanitize ? checkXSS(raw) : raw;
    if (!Validate.isValidData(config)) return null;
    const senderUuid = roomSessionUuid(socket, config.room_id);
    return senderUuid ? { config, senderUuid } : null;
}

/**
 * First room shared by the sender and the target session uuid (relay gate:
 * a socket can only signal peers it joined with). Null when unrelated.
 */
function sharedRoom(socket, peerUuid) {
    if (!peerUuid || typeof peerUuid !== 'string') return null;
    for (const channel of Object.keys(socket.channels || {})) {
        if (isPeerInRoom(channel, peerUuid)) return channel;
    }
    return null;
}

/** Live socket of a session uuid in a room — null for ghosts / dead sockets. */
function liveSessionSocket(channel, peerUuid) {
    if (!isPeerInRoom(channel, peerUuid)) return null;
    const sock = sockets[peers[channel][peerUuid].socket_id];
    return sock && sock.connected ? sock : null;
}

/**
 * Park an abnormally-disconnected session as a ghost: the peers entry (and
 * presenter role) survive the grace window while the dead socket leaves the
 * delivery maps. Members keep their peer connections — a resume inside the
 * window heals them with an ICE restart instead of a full renegotiation.
 */
function detachAsGhost(channel, socket, reason) {
    const session = socket.channels[channel];
    const entry = session && isPeerInRoom(channel, session.uuid) ? peers[channel][session.uuid] : null;
    if (!entry) {
        // join never completed for this channel — plain removal
        return removePeerFrom(channel, socket, reason);
    }
    entry.ghost = true;
    delete channels[channel]?.[socket.id];
    const delay = reason === 'ping timeout' ? GHOST_GRACE_LATE_MS : GHOST_GRACE_MS;
    const key = ghostKey(channel, session.uuid);
    clearTimeout(ghosts.get(key));
    ghosts.set(
        key,
        setTimeout(() => expireGhost(channel, session.uuid), delay)
    );
    log.debug('[' + socket.id + '] session ghosted', { channel, reason, resume_window_ms: delay });
}

/** Grace expired with no resume — the session is really gone. */
function expireGhost(channel, uuid) {
    ghosts.delete(ghostKey(channel, uuid));
    const entry = Object.hasOwn(peers, channel) ? peers[channel][uuid] : null;
    if (!entry || !entry.ghost) return;
    const socketId = entry.socket_id;
    const name = entry.peer_name;
    releaseRoomEntry(channel, uuid);
    broadcastRemovePeer(channel, uuid, socketId);
    log.info('[ghost] grace expired, session removed', { channel, uuid, name });
    audit.record('ghostExpire', { channel, name });
}

/**
 * Drop a session's room registration (peers/presenters) and clean up an
 * emptied room. No signaling — callers decide whether to broadcast.
 */
function releaseRoomEntry(channel, uuid) {
    if (!Object.hasOwn(peers, channel)) return;
    try {
        delete peers[channel][uuid];
        delete presenters[channel]?.[uuid];

        if (getPeerCount(channel) === 0) {
            delete peers[channel];
            delete presenters[channel];
            delete channels[channel]; // clean up to prevent memory leaks
            // an empty temporary room is gone for good — its (memory-only)
            // chat history goes with it
            if (channelStore.removeTempIfEmpty(channel, 0)) {
                chatStore.removeChannel(channel);
            }
        }
    } catch (err) {
        log.error('Release room entry', toJson(err));
    }
}

/** Broadcast removePeer for a session to everyone left in the room. */
function broadcastRemovePeer(channel, uuid, socketId) {
    for (const [id, sock] of Object.entries(channels[channel] || {})) {
        sock.emit('removePeer', { peer_id: uuid });
        log.debug('emit removePeer [' + uuid + '] -> [' + id + ']');
    }
    if (socketId && Object.hasOwn(sockets, socketId)) {
        sockets[socketId].emit('removePeer', { peer_id: uuid });
    }
}

/**
 * Teardown for a session entry about to be replaced by a rejoining same-uuid
 * socket: a LIVE old socket leaves through the normal removePeer path; a
 * ghost (or already-dead socket) is expired on the spot. Used by the join
 * handler's reconciliation of a pre-existing entry and of a slot claimed by
 * a concurrent same-uuid join.
 */
async function reapSession(channel, uuid, entry) {
    const oldSocket = sockets[entry.socket_id];
    if (oldSocket && oldSocket.connected) {
        await removePeerFrom(channel, oldSocket, 'reconnected');
        return;
    }
    clearTimeout(ghosts.get(ghostKey(channel, uuid)));
    ghosts.delete(ghostKey(channel, uuid));
    releaseRoomEntry(channel, uuid);
    broadcastRemovePeer(channel, uuid, entry.socket_id);
}

/**
 * Remove a socket's session from a channel: release the room entry and
 * broadcast removePeer to the room.
 * @param {string} channel channel id
 * @param {object} socket the (possibly already dead) member socket
 * @param {string} reason disconnect reason (logging only)
 */
function removePeerFrom(channel, socket, reason = 'unknown') {
    const session = socket.channels[channel];
    if (!session) {
        return log.debug('[' + socket.id + '] [Warning] not in ', channel);
    }
    delete socket.channels[channel];
    delete channels[channel]?.[socket.id];
    clearTimeout(ghosts.get(ghostKey(channel, session.uuid)));
    ghosts.delete(ghostKey(channel, session.uuid));
    releaseRoomEntry(channel, session.uuid);
    broadcastRemovePeer(channel, session.uuid, socket.id);
    log.info('[leave] peer removed', {
        channel,
        reason,
        name: session.name,
        uuid: session.uuid,
        peers_left: getPeerCount(channel),
    });
    audit.record('leave', { channel, name: session.name, reason });
}

/**
 * Object to Json
 */
function toJson(data) {
    return JSON.stringify(data, null, 4);
}

/**
 * Get ip (honours trust proxy settings)
 */
function getIP(req) {
    return req.ip || (req.socket && req.socket.remoteAddress);
}

function getSocketIP(socket) {
    if (trustProxy) {
        // Node lowercases incoming header names — the camel-case lookup was
        // dead code
        const forwarded = socket.handshake.headers['x-forwarded-for'];
        if (forwarded) return forwarded.split(',')[0].trim();
    }
    return socket.handshake.address;
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
