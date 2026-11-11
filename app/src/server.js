/*
http://patorjk.com/software/taag/#p=display&f=ANSI%20Regular&t=Server

██╗███╗   ██╗███████╗████████╗ █████╗ ██████╗  ██████╗██╗  ██╗██╗   ██╗███████╗
██║████╗  ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔════╝██║ ██╔╝██║   ██║██╔════╝
██║╚██╗ ██║█████╔╝     ██║   ███████║██████╔╝██║     █████╔╝ ██║   ██║█████╔╝
██║╚██╔╝██║██╔══╝     ██║   ██╔══██║██╔══██╗██║     ██╔═██╗ ██║   ██║██╔══╝
██║██║╚████║███████╗   ██║   ██║  ██║██████╔╝╚██████╗██║  ██║╚██████╔╝███████╗
╚═╝╚═╝ ╚═══╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝

语音频道版——持久化频道 + 管理后台 + 访客直接加入。

基于 MiroTalk P2P（https://github.com/miroslavpejic85/mirotalk，AGPLv3）。

装配点：本文件把 express 应用、HTTPS/HTTP 服务器与
socket.io、持久化 store、功能模块接线到一起——

  rooms.js        内存房间状态 + 幽灵/会话生命周期
  signaling.js    socket 协议（join/addPeer/relaySDP/relayICE/removePeer）
  chatGateway.js  聊天 socket 域（历史副本 + 生命周期广播）
  adminApi.js     /api/admin/* + /api/host/* REST + 备份/恢复
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

// 全服务器共用的一个常数时间比较实现（由 channelStore 持有——
// 它就住在为之而建的密码哈希旁边）
const safeEqualStrings = ChannelStore.constantTimeEquals;

const log = new Logs('server');

// 中央配置（内部经 dotenv 读取 .env）
const config = require('./config');

const app = express();

const port = config.server.port;
const host = config.server.host;
const trustProxy = config.server.trustProxy;

// ---------------------------------------------------------------------------
// HTTPS / HTTP 服务器 + Socket.IO
// ---------------------------------------------------------------------------

// 两种支持的 TLS 形式（docs/self-hosting.md）：
//  - 反向代理终结 TLS → 容器走纯 HTTP（默认，无需证书）
//  - 原生 HTTPS → 运维者把真实证书挂到 app/ssl/，端口只服务 HTTPS
const keyPath = path.join(__dirname, '../ssl/key.pem');
const certPath = path.join(__dirname, '../ssl/cert.pem');
const keyExists = fs.existsSync(keyPath);
const certExists = fs.existsSync(certPath);
if (keyExists !== certExists) {
    // 证书只挂一半是配置错误，不是纯 HTTP 默认：
    // 静默改走 HTTP 会让上游期待 HTTPS 的代理束手无策
    log.error(
        `Native TLS needs both app/ssl/key.pem and app/ssl/cert.pem — only ${
            keyExists ? 'key.pem' : 'cert.pem'
        } is present. Mount both for native HTTPS, or remove both to serve plain HTTP behind a TLS-terminating reverse proxy.`
    );
    process.exit(1);
}
const nativeTls = keyExists && certExists;
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
    // 2MB：聊天历史的图片中转事件每次只携带一张压缩图片
    // （base64 至多 ~1.6MB，见 'chat' 处理器）。超过上限的包
    // 只会关掉它自己的连接，因此这个提升保持自我克制。
    maxHttpBufferSize: 2e6,
    transports: ['websocket'],
    cors: corsOptions,
    // 在 ~18s 内回收没有 FIN 就死掉的连接（幽灵成员）
    pingInterval: config.server.pingInterval,
    pingTimeout: config.server.pingTimeout,
}).listen(server);

// ---------------------------------------------------------------------------
// STUN / TURN ICE 服务器
// ---------------------------------------------------------------------------

// 两种 TURN 模式：
//  - 静态：TURN_SERVER_USERNAME/CREDENTIAL 原样下发（coturn 老式
//    长期凭证——可信局域网尚可，公网上有风险）
//  - REST/HMAC（设置 TURN_SERVER_SECRET 时推荐）：coturn 以
//    use-auth-secret 运行；本服务器铸造短时凭证
//    （username = unix 到期时间，password = base64(hmac-sha1(secret, username))），
//    并在半衰期刷新。任何长期凭证都绝不会下发到客户端。
const iceServers = []; // 静态条目（STUN + 可选的静态 TURN）
const stunServerUrl = config.webrtc.stun.url;
const turnServerUrl = config.webrtc.turn.url;
const turnServerUsername = config.webrtc.turn.username;
const turnServerCredential = config.webrtc.turn.credential;
const turnSecret = config.webrtc.turn.secret; // REST/HMAC 模式（覆盖静态 TURN 认证）
const turnTtlSec = config.webrtc.turn.credentialTtlSec || 12 * 3600;
// STUN_SERVER_URL 可含逗号分隔的多个 URL（多个解析器互为备份，
// 与下方 TURN 的处理方式一致）
const stunServerUrls = (stunServerUrl || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
if (config.webrtc.stun.enabled) stunServerUrls.forEach((url) => iceServers.push({ urls: url }));
// TURN_SERVER_URL 可含逗号分隔的多个 URL -> 每个 relay 一个 RTCIceServer
// （多个 coturn 实例互为备份；浏览器向每台服务器各收集一个 relay
// candidate，ICE 选用最先应答的那个）
const turnServerUrls = (turnServerUrl || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
const turnStaticAuth =
    config.webrtc.turn.enabled && turnServerUrls.length && turnServerUsername && turnServerCredential;
const turnDynamicAuth = config.webrtc.turn.enabled && turnServerUrls.length && turnSecret;
if (turnDynamicAuth) {
    // 两者都配置时 REST/HMAC 优先：不能因为静态凭证还留在 env 里，
    // 就让长期凭证继续下发到客户端。
    log.info('TURN REST/HMAC credentials enabled (use-auth-secret)', {
        ttl_sec: turnTtlSec,
        urls: turnServerUrls.length,
    });
} else if (turnStaticAuth) {
    turnServerUrls.forEach((url) => {
        iceServers.push({ urls: url, username: turnServerUsername, credential: turnServerCredential });
    });
}

// 铸造的凭证由进程内的所有客户端共享，并缓存到 TTL 过半为止
// （通话中途 rejoin 仍能继续工作）。
let turnCredCache = null; // { servers, expiresAtSec }

function mintTurnCredentials() {
    const expiresAtSec = Math.floor(Date.now() / 1000) + turnTtlSec;
    const username = String(expiresAtSec); // coturn REST API：username = 到期时间戳
    const password = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    return {
        servers: turnServerUrls.map((url) => ({ urls: url, username, credential: password })),
        expiresAtSec,
    };
}

/** 供新 addPeer 使用的 ICE 服务器列表（静态数组，或缓存的 HMAC 集）。 */
function getIceServers() {
    if (!turnDynamicAuth) return iceServers;
    if (!turnCredCache || turnCredCache.expiresAtSec - Math.floor(Date.now() / 1000) < turnTtlSec / 2) {
        turnCredCache = mintTurnCredentials();
    }
    return [...iceServers, ...turnCredCache.servers];
}

// ---------------------------------------------------------------------------
// 持久化频道注册表 + 管理后台
// ---------------------------------------------------------------------------

const channelsCfg = config.channels || {};

// 接上修复前的密码兼容垫片：在密码改为原文比对之前写入的注册表，
// 保存的是经 DOMPurify 清洗后密钥的哈希；
// verifyPasswordCompat 以该形式回退重推（原文优先）。
const channelStore = new ChannelStore({
    filePath: path.join(__dirname, 'channels.json'),
    autoInit: channelsCfg.autoInit !== false,
    defaultModerator: channelsCfg.defaultModerator,
    legacySanitize: (pw) => checkXSS(pw),
    // env 播种首次启动的默认值；此后由 admin 开关持久化
    defaultSettings: { tempRooms: channelsCfg.tempRooms !== false },
});

// 临时房间功能的运行时权威来源（由 admin 管理，
// 持久化在 channels.json——env 值只播种了初始默认）
const tempRoomsEnabled = () => channelStore.settings.tempRooms !== false;

// 文字聊天历史：投递仍走 DataChannel mesh 的 P2P，但发送者（SENDER）
// 会把每条文字消息在这里中转一份副本，让迟到的加入者能追上进度。
// 留存时长可由 admin 调整（channels.json 的 chatRetentionHours，
// 0 = 一律不保留）；单个频道可覆盖全局窗口（自己的
// chatRetentionHours 字段，null/缺省 = 继承）。临时房间的历史
// 只存内存。
const chatStore = new ChatStore({
    dir: path.join(__dirname, 'chat_history'),
    retentionHours: (roomId) =>
        channelStore.get(roomId)?.chatRetentionHours ?? channelStore.settings.chatRetentionHours,
});

// 在密码与专用 JWT secret 两者都配置之前，admin 后台完全禁用
// （/admin 与所有 /api/admin/* 路由一律 404）
// ——没有任何不安全的默认值。
const consoleEnabled = Boolean(channelsCfg.adminPassword && channelsCfg.adminJwtSecret);
if (!consoleEnabled) {
    log.warn(
        'Admin console disabled — set CHANNEL_ADMIN_PASSWORD and CHANNEL_ADMIN_JWT_SECRET to enable /admin and channel management'
    );
}

// 追加式审计轨迹：即使 debug 日志关闭，成员变动（join/leave/kick）
// 与 admin 数据操作也会落在这里。VC_AUDIT_FILE
// 可重定向（集成测试把它指向临时文件）。
const audit = new Audit(process.env.VC_AUDIT_FILE || path.join(__dirname, 'audit.jsonl'));

// 房间状态 + 会话生命周期（由信令协议、聊天网关
// 与 admin 后台 REST 面共享）
const rooms = createRooms({ channelStore, chatStore, audit, log });

// 聊天 socket 域：历史副本持久化 + 生命周期广播
const chatGateway = createChatGateway({ rooms, chatStore, channelStore, audit, log });

/** 用专用的后台 secret 签发 admin / host token。 */
function signConsoleToken(payload, expiresIn) {
    return jwt.sign(payload, channelsCfg.adminJwtSecret, { expiresIn: expiresIn || channelsCfg.adminJwtExp || '24h' });
}

/** @returns {object|null} 解码后的 payload，无效/过期时为 null */
function verifyConsoleToken(token) {
    if (!token || typeof token !== 'string') return null;
    try {
        // 钉死算法，用其他 alg 签发的 token 绝不被接受
        return jwt.verify(token, channelsCfg.adminJwtSecret, { algorithms: ['HS256'] });
    } catch {
        return null;
    }
}

// admin / host 登录共用的登录限流（只按 IP 节流：客户端提供的
// username 每次请求都可变，能换到新桶）。
const maxAttempts = config.host.maxLoginAttempts;
const minBlockTime = config.host.minLoginBlockTime;
const loginLimiter = rateLimit({
    windowMs: minBlockTime * 60 * 1000,
    max: maxAttempts,
    message: { error: `Too many login attempts. Please try again after ${minBlockTime} minute(s).` },
    keyGenerator: (req) => getIP(req),
});

// 公共 REST 面（/api/channels、/api/version 等）的粗粒度安全网，
// 否则它们无认证且无限制。额度足够宽裕，
// 首页 15s 轮询绝不会触顶（每个打开的标签页 ≈ 12 req/5min）；
// admin 路由自带 JWT，只需要为备份留出余量。
const apiLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    message: { error: 'Too many requests' },
    keyGenerator: (req) => getIP(req),
});

// ---------------------------------------------------------------------------
// 页面视图
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
// 中间件
// ---------------------------------------------------------------------------

app.set('trust proxy', trustProxy);

const ipWhitelist = config.ipWhitelist;

// 护栏：IP_WHITELIST_ENABLED=true 而没有 TRUST_PROXY=true 几乎总是
// 配置错误（X-Forwarded-For 会是攻击者可控的）。
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
            // 404.html 带有内联 <style> 块；内联样式无法执行脚本
            styleSrc: ["'self'", "'unsafe-inline'"],
            // 聊天图片以 data: URL 传输；音频播放与输入框的
            // 待发图片预览（object URL）用 blob:
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:', 'data:'],
            connectSrc: ["'self'"], // socket.io websocket（同源）已由 'self' 覆盖
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
        },
    }),
    helmet.noSniff(),
    helmet.referrerPolicy({ policy: 'no-referrer' }),
    // HSTS（默认 180 天）；纯 HTTP 下浏览器会忽略该头
    helmet.hsts()
);
app.use(applyEmbedHeaders);

const staticOptions = {
    // "/" 必须落到页面路由，index.html 才能带着自己的 build id 下发
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
        // 缓存策略：图标/图片绝不原地变更 → 长缓存。
        // 其余（js/css/lang）给短新鲜窗口，之后必须回源验证，
        // 部署几分钟内即可生效，版本检查横幅兜底
        // （HTML 本身 no-cache）。
        if (path.dirname(filePath).endsWith(path.join('public', 'images'))) {
            res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        }
    },
};
app.use(express.static(dir.public, staticOptions));

// CORS 放在 API 限流器之前：预检 OPTIONS 请求是协议开销，
// 不是 API 流量，不能烧掉限流额度
app.use(cors(corsOptions));

// REST 全域安全网（登录端点保留自己更严的限流器——顺序有讲究：
// 专用限流器必须先跑，所以本应挂在这些路由之后……
// 但 Express 按注册顺序匹配，因此有了下面的 skip）
app.use('/api', (req, res, next) => {
    // 已被自己的限流器更严地节流
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
// 页面
// ---------------------------------------------------------------------------

// 页面在 <meta> 里携带自己的 build id（见 app/src/version.js），
// 并以 `Cache-Control: no-cache` 下发，重载时总是回源验证 HTML，
// 而不是从 HTTP 缓存里跑一份过期副本。渲染结果做了记忆化：
// 运行中的容器里前端文件不会变。
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

/** 404 页面带错误回调：缺少 404.html 时绝不能挂起请求
 *  （不带回调的 sendFile 在失败时永远不会结束响应）。 */
function sendNotFound(res) {
    res.status(404).sendFile(views.notFound, (err) => {
        if (err && !res.headersSent) res.status(500).type('text').send('Not found');
    });
}

// 频道列表（首页）
app.get('/', (req, res) => {
    sendPage(res, views.index);
});

// 语音频道页面——已注册频道总能解析；其他合法 id 在临时房间开启时
// 也解析（房间在首次 join 时生成）
app.get('/c/:channelId', (req, res) => {
    const { channelId } = req.params;
    const known = channelStore.exists(channelId) || channelStore.isTemp(channelId);
    if (!known && !(tempRoomsEnabled() && channelStore.isValidId(channelId))) {
        return sendNotFound(res);
    }
    sendPage(res, views.channel);
});

// 旧链接兼容：/join/<room> -> /c/<room>
app.get('/join/:roomId', (req, res) => {
    res.redirect(301, `/c/${req.params.roomId}`);
});

// admin 后台（未用 env 启用时 404）
app.get('/admin', (req, res) => {
    if (!consoleEnabled) return sendNotFound(res);
    sendPage(res, views.admin);
});

// 旧版单段链接 -> /c/<id>（老的 /<room> 分享 URL）
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

// 公开频道 + 在线人数（首页）；活跃的临时房间以 `temporary` 标记
// 追加在后，访客可以发现并加入它们
app.get('/api/channels', (req, res) => {
    res.json({
        settings: { tempRooms: tempRoomsEnabled() },
        channels: [
            ...channelStore.list({ includePrivate: false, onlineOf: (id) => rooms.getPeerCount(id) }),
            ...channelStore.listTemps({ onlineOf: (id) => rooms.getPeerCount(id) }),
        ],
    });
});

// 频道页所需的频道元数据（未公开频道也可用）。
// includePrivate 保持关闭：host 用户名是管理后台的运营数据，
// 不是给匿名访客看的。
app.get('/api/channels/:channelId', (req, res) => {
    const id = req.params.channelId;
    const channel = channelStore.get(id) || channelStore.getTemp(id);
    if (channel) {
        return res.json(channelStore.sanitize(channel, { online: rooms.getPeerCount(id) }));
    }
    // 未知 id：临时房间开启时，任何合法 id 在有人 join 的瞬间就可能
    // 变成房间——返回虚拟预览而不是 404
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

// 前端版本 + public/ 指纹：已打开的页面轮询它，
// 当自己加载时的 build 不再是最新的就提示重载
app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(Version.getVersionInfo(dir.public));
});

// 管理后台 + host 的 REST 面（所有 /api/admin/* 与 /api/host/*，
// 含备份/恢复与定时备份）
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
// 旧版 API v1（仅统计，API-key 门控）
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
// 404 + 错误处理器
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
// Socket.IO 信令——mesh P2P（协议核心未变）
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
// 启动
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
 * 获取 IP（遵循 trust proxy 设置）
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

// 被 reject 的异步 socket 处理器绝不能带崩整个进程
// （Node >= 15 遇未处理 rejection 会终止）：记日志并继续服务。
process.on('unhandledRejection', (reason) => {
    log.error(
        'Unhandled promise rejection',
        reason instanceof Error ? { error: reason.message, stack: reason.stack } : { reason: String(reason) }
    );
});
