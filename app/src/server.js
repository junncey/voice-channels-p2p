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

const checkXSS = require('./xss.js');
const Validate = require('./validate');
const Logs = require('./logs');
const ChannelStore = require('./channelStore');
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
    maxHttpBufferSize: 1e6,
    transports: ['websocket'],
    cors: corsOptions,
    // reap connections that died without a FIN (ghost members) within ~18s
    pingInterval: config.server.pingInterval,
    pingTimeout: config.server.pingTimeout,
}).listen(server);

// ---------------------------------------------------------------------------
// STUN / TURN ICE servers
// ---------------------------------------------------------------------------

const iceServers = [];
const stunServerUrl = config.webrtc.stun.url;
const turnServerUrl = config.webrtc.turn.url;
const turnServerUsername = config.webrtc.turn.username;
const turnServerCredential = config.webrtc.turn.credential;
if (config.webrtc.stun.enabled && stunServerUrl) iceServers.push({ urls: stunServerUrl });
// TURN_SERVER_URL may hold several comma-separated URLs -> one RTCIceServer per relay
// (multiple coturn instances act as mutual backups; the browser collects a relay
// candidate per server and ICE picks whichever answers first)
const turnServerUrls = (turnServerUrl || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
if (config.webrtc.turn.enabled && turnServerUrls.length && turnServerUsername && turnServerCredential) {
    turnServerUrls.forEach((url) => {
        iceServers.push({ urls: url, username: turnServerUsername, credential: turnServerCredential });
    });
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
        return jwt.verify(token, channelsCfg.adminJwtSecret);
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

const channels = {}; // channelId -> { socketId: socket }
const sockets = {}; // socketId -> socket
const peers = {}; // channelId -> { socketId: peerInfo, 'lock', 'password', 'joinLock' }
const presenters = {}; // channelId -> { socketId: {peer_ip, peer_name, peer_uuid, is_presenter} }

const roomMetaKeys = new Set(['lock', 'password', 'joinLock']);

function getPeerCount(roomId) {
    if (!peers[roomId]) return 0;
    return Object.keys(peers[roomId]).filter((k) => !roomMetaKeys.has(k)).length;
}

/** Public peer list for a room (drops the room meta keys). */
function getRoomPeers(roomId) {
    const room = peers[roomId] || {};
    const list = {};
    for (const [socketId, info] of Object.entries(room)) {
        if (roomMetaKeys.has(socketId)) continue;
        list[socketId] = {
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
    helmet.referrerPolicy({ policy: 'no-referrer' })
);
app.use(applyEmbedHeaders);

const staticOptions = {
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

// Channel list (homepage)
app.get('/', (req, res) => {
    res.sendFile(views.index);
});

// Voice channel page — registered channels always resolve; any other valid id
// resolves when temporary rooms are enabled (the room is spawned on first join)
app.get('/c/:channelId', (req, res) => {
    const { channelId } = req.params;
    const known = channelStore.exists(channelId) || channelStore.isTemp(channelId);
    if (!known && !(tempRoomsEnabled() && channelStore.isValidId(channelId))) {
        return res.status(404).sendFile(views.notFound);
    }
    res.sendFile(views.channel);
});

// Legacy links compatibility: /join/<room> -> /c/<room>
app.get('/join/:roomId', (req, res) => {
    res.redirect(301, `/c/${req.params.roomId}`);
});

// Admin console (404 unless enabled via env)
app.get('/admin', (req, res) => {
    if (!consoleEnabled) return res.status(404).sendFile(views.notFound);
    res.sendFile(views.admin);
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
    res.json({ token: signConsoleToken({ role: 'host', channelId, username: host.username }, channelsCfg.hostJwtExp) });
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
    if (password !== channelsCfg.adminPassword) {
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
    const room = channels[channelId];
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
        channels: channelStore.list({ includePrivate: true, onlineOf: (id) => getPeerCount(id) }),
        temps: channelStore.listTemps({ onlineOf: (id) => getPeerCount(id) }),
        settings: channelStore.getSettings(),
    });
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
        return result.errors[0].includes('not found') ? res.status(404).json({ error: result.errors[0] }) : res.status(400).json({ error: result.errors.join('; ') });
    }
    res.json({ channel: result.channel });
});

app.delete('/api/admin/channels/:channelId', requireAdmin, (req, res) => {
    const id = req.params.channelId;
    // temp rooms live outside the persistent registry but are deletable too
    const result = channelStore.isTemp(id) ? channelStore.removeTemp(id) : channelStore.remove(id);
    if (!result.ok) return res.status(404).json({ error: result.errors[0] });
    const evicted = evictChannelPeers(id, 'channelDeleted');
    if (evicted) log.info('Channel deleted by admin, peers evicted', { channel: id, evicted });
    res.json({ success: true });
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
    log.info(
        `Voice channel server started → http${host.includes('localhost') ? '' : 's'}://${host} (port ${port})`
    );
    log.info('Server config', {
        environment: config.server.environment,
        app_version: require('../../package.json').version,
        node_version: process.versions.node,
        trust_proxy: trustProxy,
        channels_registered: channelStore.channels.length,
        channels_file: channelStore.filePath,
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
        for (let channel in socket.channels) {
            await removePeerFrom(channel, socket, reason);
        }
        log.debug('[' + socket.id + '] disconnected', { reason });
        delete sockets[socket.id];
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

        if (!Validate.isValidRoomName(channel) || !channelStore.isValidId(channel)) {
            log.warn('[' + socket.id + '] invalid channel id', { channel });
            return socket.emit('unauthorized');
        }

        if (channel in socket.channels) {
            return log.debug('[' + socket.id + '] [Warning] already joined', channel);
        }

        // Channel must be registered — or, with temporary rooms enabled, any
        // valid id spawns an ephemeral in-memory room
        let channelDef = channelStore.get(channel);
        if (!channelDef && tempRoomsEnabled()) {
            channelDef = channelStore.getOrCreateTemp(channel);
        }
        if (!channelDef) {
            log.warn('[' + socket.id + '] channel not found in registry', { channel });
            return socket.emit('channelNotFound');
        }

        // Presenter: valid host JWT issued for THIS channel, and the host must
        // still be configured (token may predate a config change).
        let is_presenter = false;
        if (peer_token) {
            const payload = verifyConsoleToken(peer_token);
            if (payload && payload.role === 'host' && payload.channelId === channel && channelStore.isHost(channel, payload.username)) {
                is_presenter = true;
                log.debug('[' + socket.id + '] joining as configured host', { channel, username: payload.username });
            } else {
                log.warn('[' + socket.id + '] invalid host token for channel', { channel });
                return socket.emit('unauthorized');
            }
        }

        // Persistent channel password (set in the admin console). Hosts
        // authenticate with their own credentials and always pass.
        if (!is_presenter && channelDef.passwordHash && !channelStore.verifyChannelPassword(channel, channel_password)) {
            log.debug('[' + socket.id + '] [Warning] channel password required/invalid', { channel });
            return socket.emit('channelPasswordRequired');
        }

        // A rejoin carrying the SAME peer_uuid + peer_name is this page's live
        // session reconnecting (each join() mints a fresh uuid): reap the
        // dead-but-unreaped socket so capacity / join-lock can't reject the
        // recovery rejoin. Never matches a second tab (it would have its own uuid).
        let is_rejoin = false;
        for (const [existingId, existing] of Object.entries(peers[channel] || {})) {
            if (!existing.peer_uuid || existing.peer_uuid !== peer_uuid || existing.peer_name !== peer_name) continue;
            is_rejoin = true;
            const oldSocket = sockets[existingId];
            if (oldSocket) {
                await removePeerFrom(channel, oldSocket, 'reconnected');
            } else {
                delete peers[channel][existingId];
                delete channels[channel]?.[existingId];
                delete presenters[channel]?.[existingId];
            }
            log.debug('[' + socket.id + '] reaped stale session on rejoin', { channel });
        }

        // Capacity hard check (hosts may always join to manage their channel)
        const maxParticipants = channelDef.maxParticipants || 8;
        if (!is_presenter && !is_rejoin && getPeerCount(channel) >= maxParticipants) {
            log.debug('[' + socket.id + '] channel is full', { channel, count: getPeerCount(channel), maxParticipants });
            return socket.emit('roomIsBusy', { maxParticipants });
        }

        // Room-level locks (read before any room structure is created so a
        // rejected join never leaves an empty room behind)
        const roomLocked = peers[channel]?.['lock'] === true && !safeEqualStrings(peers[channel]?.['password'], channel_password);
        if (roomLocked) {
            log.debug('[' + socket.id + '] [Warning] room is locked', { channel });
            return socket.emit('roomIsLocked');
        }

        const isPeerPresenterNow = (id, name, uuid) =>
            is_presenter ||
            !!(presenters[channel] &&
               presenters[channel][id] &&
               presenters[channel][id].is_presenter === true &&
               presenters[channel][id].peer_name === name &&
               presenters[channel][id].peer_uuid === uuid);

        // Room-level join lock blocks NEW joiners only — a reconnecting
        // member (same uuid, reaped above) was already inside.
        const joinLocked =
            peers[channel]?.['joinLock'] === true && !is_rejoin && !isPeerPresenterNow(socket.id, peer_name, peer_uuid);
        if (joinLocked) {
            log.debug('[' + socket.id + '] [Warning] room is join-locked', { channel });
            return socket.emit('roomIsJoinLocked');
        }

        // Auth passed — safe to create the room structures now
        if (!(channel in channels)) channels[channel] = {};
        if (!(channel in peers)) peers[channel] = {};
        if (!(channel in presenters)) presenters[channel] = {};

        if (is_presenter) {
            const presenter = { peer_ip, peer_name, peer_uuid, is_presenter: true };
            // Recover presenter status only from a disconnected socket. A live
            // presenter must never lose the role to another connection.
            for (const [existingPeerID, existing] of Object.entries(presenters[channel])) {
                if (
                    existingPeerID !== socket.id &&
                    !sockets[existingPeerID]?.connected &&
                    existing &&
                    existing.is_presenter === true &&
                    existing.peer_name === peer_name &&
                    existing.peer_uuid === peer_uuid
                ) {
                    delete presenters[channel][existingPeerID];
                    log.debug('[' + socket.id + '] presenter recovered on reconnect', { peer_name });
                    break;
                }
            }
            presenters[channel][socket.id] = presenter;
        }

        const isPresenter = isPeerPresenterNow(socket.id, peer_name, peer_uuid);

        peers[channel][socket.id] = {
            peer_name: peer_name,
            peer_presenter: isPresenter,
            peer_audio: config.peer_audio === true,
            peer_audio_status: config.peer_audio === true,
            joined_at: Date.now(),
        };

        await addPeerTo(channel);

        channels[channel][socket.id] = socket;
        socket.channels[channel] = channel;

        log.debug('[join] channel peers', { channel, peers: getRoomPeers(channel) });

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
     * Relay ICE to peers
     */
    socket.on('relayICE', async (config) => {
        if (!Validate.isValidData(config)) return;
        const { peer_id, ice_candidate } = config;
        if (!isRelayAllowed(socket, peer_id)) return;
        await sendToPeer(peer_id, sockets, 'iceCandidate', {
            peer_id: socket.id,
            ice_candidate: ice_candidate,
        });
    });

    /**
     * Relay SDP to peers
     */
    socket.on('relaySDP', async (config) => {
        if (!Validate.isValidData(config)) return;
        const { peer_id, session_description } = config;
        if (!isRelayAllowed(socket, peer_id)) return;
        log.debug('[' + socket.id + '] relay SessionDescription to [' + peer_id + ']', {
            type: session_description.type,
        });
        await sendToPeer(peer_id, sockets, 'sessionDescription', {
            peer_id: socket.id,
            session_description: session_description,
        });
    });

    /**
     * Handle Room action (presenter gated): lock/unlock/joinLock/checkPassword
     */
    socket.on('roomAction', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, peer_name, peer_uuid, password, action } = config;

        if (!peers[room_id]) return;

        const isPresenter = isPeerPresenter(room_id, socket.id, peer_name, peer_uuid);

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
                case 'checkPassword': {
                    const data = {
                        peer_name: peer_name,
                        action: action,
                        password: safeEqualStrings(password, peers[room_id]['password']) ? 'OK' : 'KO',
                    };
                    await sendToPeer(socket.id, sockets, 'roomAction', data);
                    break;
                }
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

        let peer_id_to_update = null;
        for (let peer_id in peers[room_id]) {
            if (peer_id == socket.id) {
                peers[room_id][peer_id]['peer_name'] = peer_name_new;
                if (presenters[room_id] && presenters[room_id][peer_id]) {
                    presenters[room_id][peer_id]['peer_name'] = peer_name_new;
                }
                peer_id_to_update = peer_id;
                log.debug('[' + socket.id + '] peer profile changed', { peer_name_old, peer_name_new });
                break;
            }
        }

        if (peer_id_to_update) {
            await sendToRoom(room_id, socket.id, 'peerName', {
                peer_id: peer_id_to_update,
                peer_name: peer_name_new,
            });
        }
    });

    /**
     * Host renames another peer (moderation). The renamed peer receives the
     * same peerName broadcast as everyone else and accepts the new name.
     */
    socket.on('peerRename', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, peer_id, peer_name, peer_uuid, peer_name_new } = config;

        if (!isPeerInRoom(room_id, socket.id)) {
            log.debug('peerRename blocked: sender is not a joined peer', { room_id, socket_id: socket.id });
            return;
        }
        if (!isPeerPresenter(room_id, socket.id, peer_name, peer_uuid)) {
            log.debug('peerRename blocked: sender is not the presenter', { room_id, socket_id: socket.id });
            return;
        }

        const name = typeof peer_name_new === 'string' ? peer_name_new.trim().slice(0, 24) : '';
        if (!name || !peers[room_id]?.[peer_id]) return;

        const old = peers[room_id][peer_id]['peer_name'];
        peers[room_id][peer_id]['peer_name'] = name;
        if (presenters[room_id] && presenters[room_id][peer_id]) {
            presenters[room_id][peer_id]['peer_name'] = name;
        }
        log.info('[' + socket.id + '] host renamed peer', { room_id, peer_id, from: old, to: name });

        // everyone INCLUDING the host gets the update — the host's member list
        // and the chat notice must follow too (sendToRoom would skip the sender)
        for (const sid in channels[room_id]) {
            await channels[room_id][sid].emit('peerName', { peer_id, peer_name: name, peer_name_old: old });
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
        if (!peers[room_id]?.[socket.id]) return;

        const valid =
            typeof avatar === 'string' &&
            avatar.length > 0 &&
            avatar.length <= 96 * 1024 &&
            /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar);
        if (valid) {
            peers[room_id][socket.id]['peer_avatar'] = avatar;
        } else {
            delete peers[room_id][socket.id]['peer_avatar'];
        }

        const peer_name = peers[room_id][socket.id]['peer_name'];
        log.debug('[' + socket.id + '] peer avatar ' + (valid ? 'set' : 'cleared'), { room_id });

        // everyone INCLUDING the sender — the sender's own DOM is already
        // up to date, the echo just keeps the room in lockstep
        for (const sid in channels[room_id]) {
            await channels[room_id][sid].emit('peerAvatar', {
                peer_id: socket.id,
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

        const { room_id, peer_name, peer_id, element, status } = config;

        if (!isPeerInRoom(room_id, socket.id)) {
            log.debug('peerStatus blocked: sender is not a joined peer', { room_id, socket_id: socket.id });
            return;
        }

        if (element !== 'audio') return;

        const data = { peer_id, peer_name, element, status: status === true };
        for (let id in peers[room_id]) {
            if (peers[room_id][id]['peer_name'] == peer_name && id == socket.id) {
                peers[room_id][id]['peer_audio_status'] = status === true;
                break;
            }
        }

        await sendToRoom(room_id, socket.id, 'peerStatus', data);
    });

    /**
     * Relay actions to peers (presenter gated for moderation actions)
     */
    socket.on('peerAction', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        const { room_id, peer_id, peer_uuid, peer_name, peer_action, send_to_all } = config;

        if (!isPeerInRoom(room_id, socket.id)) {
            log.debug('peerAction blocked: sender is not a joined peer', { room_id, socket_id: socket.id });
            return;
        }

        // Only the presenter may run moderation actions
        const presenterActions = ['muteAudio', 'ejectAll'];
        if (presenterActions.includes(peer_action)) {
            const isPresenter = isPeerPresenter(room_id, socket.id, peer_name, peer_uuid);
            if (!isPresenter) return;
        }

        const data = { peer_id, peer_name, peer_action };

        if (send_to_all) {
            await sendToRoom(room_id, socket.id, 'peerAction', data);
        } else {
            await sendToPeer(peer_id, sockets, 'peerAction', data);
        }
    });

    /**
     * Kick out peer from room (presenter only)
     */
    socket.on('kickOut', async (cfg) => {
        const config = checkXSS(cfg);
        if (!Validate.isValidData(config)) return;

        // peer_id here is the TARGET to kick; the caller's identity is the
        // server-controlled socket.id, not anything the client supplies.
        const { room_id, peer_id, peer_uuid, peer_name, peer_kicked_reason } = config;

        const isPresenter = isPeerPresenter(room_id, socket.id, peer_name, peer_uuid);
        if (isPresenter) {
            log.debug('[' + socket.id + '] kick out peer [' + peer_id + '] from room [' + room_id + ']');
            await sendToPeer(peer_id, sockets, 'kickOut', {
                peer_name: peer_name,
                peer_kicked_reason: peer_kicked_reason,
            });
        }
    });

    /**
     * Add peers to channel (mesh: notify every existing peer + the newcomer)
     * @param {string} channel channel id
     */
    async function addPeerTo(channel) {
        const roomPeers = getRoomPeers(channel);
        for (let id in channels[channel]) {
            await channels[channel][id].emit('addPeer', {
                peer_id: socket.id,
                peers: roomPeers,
                should_create_offer: false,
                iceServers: iceServers,
            });
            socket.emit('addPeer', {
                peer_id: id,
                peers: roomPeers,
                should_create_offer: true,
                iceServers: iceServers,
            });
            log.debug('[' + socket.id + '] emit addPeer [' + id + ']');
        }
    }

    /**
     * Remove peers from channel
     * @param {string} channel channel id
     */
    async function removePeerFrom(channel, socket, reason = 'unknown') {
        if (!(channel in socket.channels)) {
            return log.debug('[' + socket.id + '] [Warning] not in ', channel);
        }
        try {
            delete socket.channels[channel];
            delete channels[channel][socket.id];
            delete peers[channel][socket.id];
            delete presenters[channel]?.[socket.id];

            if (getPeerCount(channel) === 0) {
                delete peers[channel];
                delete presenters[channel];
                delete channels[channel]; // clean up to prevent memory leaks
                // an empty temporary room is gone for good
                channelStore.removeTempIfEmpty(channel, 0);
            }
        } catch (err) {
            log.error('Remove Peer', toJson(err));
        }

        log.debug('[removePeerFrom]', { channel, reason, peers_left: getPeerCount(channel) });

        for (let id in channels[channel]) {
            await channels[channel][id].emit('removePeer', { peer_id: socket.id });
            socket.emit('removePeer', { peer_id: id });
            log.debug('[' + socket.id + '] emit removePeer [' + id + ']');
        }
    }

    /**
     * Object to Json
     */
    function toJson(data) {
        return JSON.stringify(data, null, 4);
    }

    /**
     * Send async data to all peers in the same room except yourself
     */
    async function sendToRoom(room_id, socket_id, msg, config = {}) {
        for (let peer_id in channels[room_id]) {
            if (peer_id != socket_id) {
                await channels[room_id][peer_id].emit(msg, config);
            }
        }
    }

    /**
     * Send async data to specified peer
     */
    async function sendToPeer(peer_id, sockets, msg, config = {}) {
        if (peer_id in sockets) {
            await sockets[peer_id].emit(msg, config);
        }
    }
}); // end [io.sockets.on-connect]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a socket is a joined peer of the given room.
 */
function isPeerInRoom(room_id, socket_id) {
    return !!(room_id && peers[room_id] && peers[room_id][socket_id]);
}

/**
 * Relay gate (relaySDP / relayICE): sender and target must both be members of
 * the same channel, so a socket can never push signaling at peers it never
 * joined with.
 */
function isRelayAllowed(socket, peer_id) {
    if (!peer_id || typeof peer_id !== 'string') return false;
    for (const channel of Object.keys(socket.channels || {})) {
        if (channels[channel] && peer_id in channels[channel]) return true;
    }
    return false;
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
 * Check if peer is Presenter (server-controlled socket.id + stored identity).
 */
function isPeerPresenter(room_id, peer_id, peer_name, peer_uuid) {
    try {
        const roomPresentersMap = presenters[room_id];
        const stored = roomPresentersMap && roomPresentersMap[peer_id];
        if (!stored) return false;
        return (
            typeof stored === 'object' &&
            stored.is_presenter === true &&
            stored.peer_name === peer_name &&
            stored.peer_uuid === peer_uuid
        );
    } catch (err) {
        log.error('isPeerPresenter', err);
        return false;
    }
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
