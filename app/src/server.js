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
const { pipeline, Readable } = require('stream');
const { createTarIterator } = require('./backup');
const { applyEmbedHeaders } = require('./middleware/embedHeaders');

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
const turnStaticAuth = config.webrtc.turn.enabled && turnServerUrls.length && turnServerUsername && turnServerCredential;
const turnDynamicAuth = config.webrtc.turn.enabled && turnServerUrls.length && turnSecret;
if (turnDynamicAuth) {
    // REST/HMAC wins when both are configured: nothing long-lived should keep
    // travelling to clients just because static creds are still in the env.
    log.info('TURN REST/HMAC credentials enabled (use-auth-secret)', { ttl_sec: turnTtlSec, urls: turnServerUrls.length });
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

const channelStore = new ChannelStore({
    filePath: path.join(__dirname, 'channels.json'),
    autoInit: channelsCfg.autoInit !== false,
    defaultModerator: channelsCfg.defaultModerator,
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
    },
};
app.use(express.static(dir.public, staticOptions));

app.use(cors(corsOptions));
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
        return res.status(404).sendFile(views.notFound);
    }
    sendPage(res, views.channel);
});

// Legacy links compatibility: /join/<room> -> /c/<room>
app.get('/join/:roomId', (req, res) => {
    res.redirect(301, `/c/${req.params.roomId}`);
});

// Admin console (404 unless enabled via env)
app.get('/admin', (req, res) => {
    if (!consoleEnabled) return res.status(404).sendFile(views.notFound);
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

// Channel metadata for the channel page (works for unlisted channels too)
app.get('/api/channels/:channelId', (req, res) => {
    const id = req.params.channelId;
    const channel = channelStore.get(id) || channelStore.getTemp(id);
    if (channel) {
        return res.json(channelStore.sanitize(channel, { includePrivate: true, online: getPeerCount(id) }));
    }
    // unknown id: with temp rooms enabled, any valid id MAY become a room the
    // moment someone joins — serve a virtual preview instead of a 404
    if (tempRoomsEnabled() && channelStore.isValidId(id)) {
        return res.json({
            id,
            name: id,
            description: '',
            public: true,
            maxParticipants: 8,
            hosts: [],
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

// Host login -> JWT used as peer_token when joining the channel socket room
app.post('/api/host/login', loginLimiter, (req, res) => {
    const safeBody = checkXSS(req.body) || {};
    const { channelId, username, password } = safeBody;

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

    const host = channelStore.verifyHost(channelId, username, password);
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
    const safeBody = checkXSS(req.body) || {};
    const { password } = safeBody;
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
            sock.disconnect(true);
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
    } else {
        const entry = peers[channel][uuid];
        clearTimeout(ghosts.get(ghostKey(channel, uuid)));
        ghosts.delete(ghostKey(channel, uuid));
        releaseRoomEntry(channel, uuid);
        broadcastRemovePeer(channel, uuid, entry?.socket_id);
        log.info('Admin expired ghost member', { channel, uuid });
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

app.post('/api/admin/channels', requireAdmin, (req, res) => {
    const result = channelStore.create(checkXSS(req.body) || {});
    if (!result.ok) return res.status(400).json({ error: result.errors.join('; ') });
    res.status(201).json({ channel: result.channel });
});

app.put('/api/admin/channels/:channelId', requireAdmin, (req, res) => {
    const result = channelStore.update(req.params.channelId, checkXSS(req.body) || {});
    if (!result.ok) {
        return result.errors[0].includes('not found')
            ? res.status(404).json({ error: result.errors[0] })
            : res.status(400).json({ error: result.errors.join('; ') });
    }
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
    res.json({ success: true });
});

/**
 * One-file server backup: channels.json + every persisted chat history file
 * as a tar.gz download (restore = unpack over a fresh data directory).
 * Streamed end-to-end (tar iterator -> gzip transform -> response), so the
 * whole archive is never held in memory regardless of history volume.
 */
app.get('/api/admin/backup', requireAdmin, (req, res) => {
    try {
        const entries = [];
        const registry = path.basename(channelStore.filePath);
        if (fs.existsSync(channelStore.filePath)) entries.push({ name: registry, path: channelStore.filePath });
        for (const id of chatStore.listFiles()) {
            const file = chatStore.fileFor(id);
            if (fs.existsSync(file)) entries.push({ name: `chat_history/${id}.json`, path: file });
        }
        // preflight readability so failures surface as a clean 500 instead of a
        // mid-stream abort after the download headers are already sent
        for (const entry of entries) fs.accessSync(entry.path, fs.constants.R_OK);
        const stamp = new Date().toISOString().slice(0, 10);
        res.set({
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="voice-channels-backup-${stamp}.tar.gz"`,
            'Cache-Control': 'no-store',
        });
        pipeline(Readable.from(createTarIterator(entries)), zlib.createGzip(), res, (err) => {
            if (err) log.error('Backup stream failed', { files: entries.length, error: err.message });
            else log.info('Admin backup served', { files: entries.length });
        });
    } catch (err) {
        log.error('Admin backup failed', { error: err.message });
        res.status(500).json({ error: 'backup failed' });
    }
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
        let body = row.text || '';
        if (Array.isArray(row.imgs)) body += body ? ` [${row.imgs.length} image(s)]` : `[${row.imgs.length} image(s)]`;
        if (row.reply) body = `> ${row.reply.name}: ${row.reply.text}\n${body}`;
        lines.push(`**${tStamp(when)} ${row.name}:** ${body}`);
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
    res.status(404).sendFile(views.notFound);
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
    });
});

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
        joinFailures.delete(socket.id); // per-socket state cleanup
        chatSends.delete(socket.id);
        chatBatches.delete(socket.id); // pending image batches die with the sender
    });

    /**
     * On peer join — channel must exist in the persistent registry.
     * Presenter rights come ONLY from a valid host JWT for this channel.
     */
    socket.on('join', async (cfg) => {
        const peer_ip = getSocketIP(socket);
        const config = checkXSS(cfg);

        if (!Validate.isValidData(config)) return;
        // never log credentials (host JWT / room password)
        const { peer_token, channel_password, ...joinLogData } = config;
        log.debug('[' + socket.id + '] join', joinLogData);

        const { channel, peer_uuid, peer_name } = config;

        // Brute-force guard: a socket with too many consecutive failed join
        // authentications is silently ignored for the cooldown window
        if (isJoinThrottled(socket.id)) {
            log.warn('[' + socket.id + '] join dropped: auth-failure cooldown', { channel });
            return;
        }

        if (!Validate.isValidRoomName(channel) || !channelStore.isValidId(channel)) {
            log.warn('[' + socket.id + '] invalid channel id', { channel });
            recordJoinFailure(socket.id);
            return socket.emit('unauthorized');
        }

        // peer_uuid becomes the room-state key for this session (resume
        // matching, relay targets) — a strict uuid shape keeps it from ever
        // colliding with the room meta keys or polluting object prototypes
        if (!Validate.isValidSessionUuid(peer_uuid)) {
            log.warn('[' + socket.id + '] invalid peer_uuid', { channel });
            recordJoinFailure(socket.id);
            return socket.emit('unauthorized');
        }

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
                recordJoinFailure(socket.id);
                return socket.emit('unauthorized');
            }
        }

        // Persistent channel password (set in the admin console). Hosts
        // authenticate with their own credentials and always pass. A pending
        // temp room (channelDef still null) has no password yet.
        if (
            !is_presenter &&
            channelDef?.passwordHash &&
            !channelStore.verifyChannelPassword(channel, channel_password)
        ) {
            log.debug('[' + socket.id + '] [Warning] channel password required/invalid', { channel });
            recordJoinFailure(socket.id);
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
            const oldSocket = sockets[existingEntry.socket_id];
            if (existingEntry.ghost && nameMatches) {
                is_rejoin = true;
                resumed = true;
                keepJoinedAt = existingEntry.joined_at;
                clearTimeout(ghosts.get(ghostKey(channel, peer_uuid)));
                ghosts.delete(ghostKey(channel, peer_uuid));
                delete channels[channel]?.[existingEntry.socket_id];
                if (oldSocket) delete oldSocket.channels[channel]; // dead socket bookkeeping
                existingEntry.ghost = false;
                existingEntry.socket_id = socket.id;
                log.debug('[' + socket.id + '] session resumed in grace window', { channel });
            } else {
                is_rejoin = nameMatches; // same session returning under a live socket: capacity/lock bypass parity
                if (oldSocket && oldSocket.connected) {
                    await removePeerFrom(channel, oldSocket, 'reconnected');
                } else {
                    clearTimeout(ghosts.get(ghostKey(channel, peer_uuid)));
                    ghosts.delete(ghostKey(channel, peer_uuid));
                    releaseRoomEntry(channel, peer_uuid);
                    broadcastRemovePeer(channel, peer_uuid, existingEntry.socket_id);
                }
                log.debug('[' + socket.id + '] reaped stale session on rejoin', { channel, resumed: false });
            }
        }

        // Capacity hard check (hosts may always join to manage their channel)
        const maxParticipants = channelDef?.maxParticipants || 8;
        if (!is_presenter && !is_rejoin && getPeerCount(channel) >= maxParticipants) {
            log.debug('[' + socket.id + '] channel is full', {
                channel,
                count: getPeerCount(channel),
                maxParticipants,
            });
            return socket.emit('roomIsBusy', { maxParticipants });
        }

        // Room-level locks (read before any room structure is created so a
        // rejected join never leaves an empty room behind)
        const roomLocked =
            peers[channel]?.['lock'] === true && !safeEqualStrings(peers[channel]?.['password'], channel_password);
        if (roomLocked) {
            log.debug('[' + socket.id + '] [Warning] room is locked', { channel });
            recordJoinFailure(socket.id);
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
            const existingTemp = channelStore.getTemp(channel);
            if (existingTemp) {
                // joining a room someone already spawned: no creation, no quota
                channelDef = existingTemp;
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

        await addPeerTo(channel, socket, peer_uuid, { rejoin: resumed });

        channels[channel][socket.id] = socket;
        socket.channels[channel] = { uuid: peer_uuid, name: peer_name };

        log.debug('[join] channel peers', { channel, peers: getRoomPeers(channel) });

        joinFailures.delete(socket.id); // a successful join resets the failure counter

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
        await target.emit('iceCandidate', {
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
        await target.emit('sessionDescription', {
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
        const config = checkXSS(cfg);
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
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, peer_name_old, peer_name_new } = config;

        const senderUuid = roomSessionUuid(socket, room_id);
        const entry = senderUuid && Object.hasOwn(peers, room_id) ? peers[room_id][senderUuid] : null;
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
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, peer_id, peer_name_new } = config;

        const senderUuid = roomSessionUuid(socket, room_id);
        if (!senderUuid) {
            log.debug('peerRename blocked: sender is not a joined peer', { room_id, socket_id: socket.id });
            return;
        }
        if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) {
            log.debug('peerRename blocked: sender is not the presenter', { room_id, socket_id: socket.id });
            return;
        }

        const name = typeof peer_name_new === 'string' ? peer_name_new.trim().slice(0, 24) : '';
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
            await sock.emit('peerName', { peer_id, peer_name: name, peer_name_old: old });
        }
    });

    /**
     * Set/clear a peer's custom avatar. The data URL never goes through
     * checkXSS (DOMPurify strips data: URIs) — it is validated against a
     * strict whitelist + size cap instead, exactly like the DataChannel
     * image protocol, and is only ever rendered as an <img src>.
     */
    socket.on('peerAvatar', async (cfg) => {
        if (!Validate.isValidData(cfg)) return;

        const { room_id, avatar } = cfg;
        const senderUuid = roomSessionUuid(socket, room_id);
        if (!senderUuid) return;

        const valid =
            typeof avatar === 'string' &&
            avatar.length > 0 &&
            avatar.length <= 96 * 1024 &&
            /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar);
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
            await sock.emit('peerAvatar', {
                peer_id: senderUuid,
                peer_name,
                avatar: valid ? avatar : null,
            });
        }
    });

    /**
     * Relay audio status to peers
     */
    socket.on('peerStatus', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, element, status } = config;

        const senderUuid = roomSessionUuid(socket, room_id);
        if (!senderUuid) {
            log.debug('peerStatus blocked: sender is not a joined peer', { room_id, socket_id: socket.id });
            return;
        }

        if (element !== 'audio') return;

        peers[room_id][senderUuid]['peer_audio_status'] = status === true;

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
        if (!Validate.isValidData(cfg)) return;
        const { room_id } = cfg;
        const senderUuid = roomSessionUuid(socket, room_id);
        if (!senderUuid) return;

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
        const text = typeof sanitized === 'string' ? sanitized.slice(0, 500) : '';
        const imageCount = Number.isInteger(cfg.imgs) && cfg.imgs > 0 && cfg.imgs <= 9 ? cfg.imgs : 0;
        if (!text && !imageCount) return;

        const peer_name = peers[room_id]?.[senderUuid]?.peer_name; // the JOINED name, server-side state
        if (!peer_name) return;

        // optional reply quote riding along (rendered as a quote block by the
        // receiver and persisted with the row)
        const reply = sanitizeChatReply(cfg.reply);
        if (!imageCount) {
            chatStore.append(
                room_id,
                { name: peer_name, text, imgs: [], ...(reply ? { reply } : {}) },
                { persistent: !channelStore.isTemp(room_id) }
            );
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
     * client-side request ids. Read-only: member-gated but not flood-gated,
     * and the page size is server-fixed (never trusted from the client).
     */
    socket.on('chatPage', (cfg, ack) => {
        if (!Validate.isValidData(cfg)) return;
        const { room_id } = cfg;
        if (!roomSessionUuid(socket, room_id)) return;
        const before = Number.isFinite(cfg.before) && cfg.before > 0 ? cfg.before : 0;
        const page = chatStore.history(room_id, {
            persistent: !channelStore.isTemp(room_id),
            before,
        });
        if (typeof ack === 'function') ack(page);
    });

    /**
     * Relay actions to peers (presenter gated for moderation actions).
     * peer_id (when targeted) is the target's session uuid.
     */
    socket.on('peerAction', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, peer_id, peer_action, send_to_all } = config;

        const senderUuid = roomSessionUuid(socket, room_id);
        if (!senderUuid) {
            log.debug('peerAction blocked: sender is not a joined peer', { room_id, socket_id: socket.id });
            return;
        }

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
            await target.emit('peerAction', data);
        }
    });

    /**
     * Kick out peer from room (presenter only). peer_id is the TARGET's
     * session uuid; the caller's identity is the server-bound session, not
     * anything the client supplies.
     */
    socket.on('kickOut', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, peer_id, peer_kicked_reason } = config;

        const senderUuid = roomSessionUuid(socket, room_id);
        if (!senderUuid || !isPeerInRoom(room_id, peer_id)) return;

        if (presenters[room_id]?.[senderUuid]?.is_presenter !== true) return;

        const target = liveSessionSocket(room_id, peer_id);
        if (!target) return;
        log.debug('[' + socket.id + '] kick out peer [' + peer_id + '] from room [' + room_id + ']');
        await target.emit('kickOut', {
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
            await sock.emit('addPeer', {
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
                await sock.emit(msg, config);
            }
        }
    }

    /**
     * Send async data to specified peer
     */
    async function sendToPeer(peer_id, sockets, msg, config = {}) {
        if (peer_id && Object.hasOwn(sockets, peer_id)) {
            await sockets[peer_id].emit(msg, config);
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
// wrong channel or room password) per socket.id. At JOIN_FAIL_LIMIT further
// joins from that socket are ignored for JOIN_FAIL_COOLDOWN_MS — the join path
// must not become a password brute-force oracle. The counter resets on a
// successful join and on disconnect.
const JOIN_FAIL_LIMIT = 5;
const JOIN_FAIL_COOLDOWN_MS = 60 * 1000;
const joinFailures = new Map(); // socket.id -> { count, ts } (ts = last failure)

function isJoinThrottled(socketId) {
    const entry = joinFailures.get(socketId);
    if (!entry || entry.count < JOIN_FAIL_LIMIT) return false;
    // the window is measured from the last failure; once it elapses the socket
    // gets a fresh attempt (a new failure re-arms the cooldown)
    return Date.now() - entry.ts < JOIN_FAIL_COOLDOWN_MS;
}

function recordJoinFailure(socketId) {
    const entry = joinFailures.get(socketId) || { count: 0, ts: 0 };
    entry.count++;
    entry.ts = Date.now();
    joinFailures.set(socketId, entry);
}

// ---------------------------------------------------------------------------
// Chat history flood guard
// ---------------------------------------------------------------------------

// Per-socket persistence rate: human typing never approaches this; a scripted
// flood would grow (and constantly rewrite) the history files. The live P2P
// delivery is unaffected — only the history copy is dropped. The budget must
// cover image batches too (1 head + up to 9 image events).
const CHAT_FLOOD_MAX = 24;
const CHAT_FLOOD_WINDOW_MS = 10 * 1000;
const chatSends = new Map(); // socket.id -> timestamps inside the window

// Pending image batches: head event received, image events still arriving.
// Keyed per socket so ids can never collide across senders; entries flush
// (with whatever images arrived) after the TTL.
const CHAT_BATCH_TTL_MS = 30 * 1000;
const CHAT_BATCHES_PER_SOCKET = 3;
const chatBatches = new Map(); // socket.id -> Map(batchId -> pending)

// The persisted-image whitelist — validated directly, never routed through
// checkXSS (DOMPurify strips data: URIs). Same rules as the peerAvatar
// handler; the size cap mirrors the client transfer cap (images.js).
const CHAT_IMAGE_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const CHAT_IMAGE_MAX_CHARS = 1600 * 1024;

function sanitizeChatImage(url) {
    return typeof url === 'string' && url.length > 0 && url.length <= CHAT_IMAGE_MAX_CHARS && CHAT_IMAGE_RE.test(url)
        ? url
        : '';
}

/** Optional reply-quote payload on a chat event: strict shape, tiny caps. */
function sanitizeChatReply(reply) {
    if (!reply || typeof reply !== 'object') return null;
    const name = typeof reply.name === 'string' ? reply.name.slice(0, 24) : '';
    const text = typeof reply.text === 'string' ? reply.text.slice(0, 80) : '';
    const ts = Number(reply.ts);
    if (!name || !text || !Number.isFinite(ts) || ts <= 0) return null;
    return { name, text, ts };
}

function isChatFlooded(socketId, now = Date.now()) {
    const stamps = (chatSends.get(socketId) || []).filter((ts) => now - ts < CHAT_FLOOD_WINDOW_MS);
    if (stamps.length >= CHAT_FLOOD_MAX) {
        chatSends.set(socketId, stamps);
        return true;
    }
    stamps.push(now);
    chatSends.set(socketId, stamps);
    return false;
}

/** Store a completed (or TTL-expired) batch as one history row. */
function finalizeChatBatch(socketId, pending) {
    chatStore.append(
        pending.room_id,
        {
            name: pending.name,
            text: pending.text,
            imgs: pending.images,
            ...(pending.reply ? { reply: pending.reply } : {}),
        },
        { persistent: !channelStore.isTemp(pending.room_id) }
    );
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
    log.debug('[ghost] grace expired, session removed', { channel, uuid, name });
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
    log.debug('[removePeerFrom]', { channel, reason, uuid: session.uuid, peers_left: getPeerCount(channel) });
}

/**
 * Object to Json
 */
function toJson(data) {
    return JSON.stringify(data, null, 4);
}

/**
 * Constant-time string comparison for secrets (room passwords, API keys).
 */
function safeEqualStrings(a, b) {
    const bufA = Buffer.from(String(a ?? ''));
    const bufB = Buffer.from(String(b ?? ''));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA); // dummy compare keeps the timing profile flat
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Get ip (honours trust proxy settings)
 */
function getIP(req) {
    return req.ip || (req.socket && req.socket.remoteAddress);
}

function getSocketIP(socket) {
    if (trustProxy) {
        const forwarded = socket.handshake.headers['x-forwarded-for'] || socket.handshake.headers['X-Forwarded-For'];
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
