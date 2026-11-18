'use strict';

/**
 * ==============================================
 * Voice Channels - 配置文件
 * ==============================================
 *
 * 本文件是中央配置来源。
 * 所有环境变量都在这里读取，代码库其余部分
 * 一律 import 配置值，
 * 而不是直接读 process.env。
 *
 * 安装：
 *   cp app/src/config.template.js app/src/config.js
 *   然后编辑 config.js（或 .env）以匹配你的环境。
 *
 * Docker/容器环境通过环境变量注入值，
 * 这些变量在启动时读取。
 */

require('dotenv').config();

// 工具：把 env 字符串解析为布尔值
function getEnvBoolean(key, force_true_if_undefined = false) {
    if (key === undefined && force_true_if_undefined) return true;
    return key === 'true';
}

// 工具：安全解析 JSON env 变量，失败时回退
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
    // 服务器
    // ==========================================
    server: {
        port: port,
        host: process.env.HOST || `http://localhost:${port}`,
        environment: process.env.NODE_ENV || 'development',
        // 在 nginx/traefik 之后？开启后 Express 才会信任 X-Forwarded-* 头
        trustProxy: !!getEnvBoolean(process.env.TRUST_PROXY),
        // Socket.IO 心跳——回收没有 FIN 就死掉的连接（断网、手机锁屏、
        // 笔记本休眠）的唯一手段。幽灵成员最多滞留
        // pingInterval + pingTimeout；下面的默认值把这一窗口压到 ~18s
        // （socket.io 默认 ≈ 45s）。
        pingInterval: Number(process.env.SOCKET_PING_INTERVAL) || 10000,
        pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT) || 8000,

        /**
         * 嵌入（iframe）限制
         * ---------------------------
         * 通过 HTTP `Content-Security-Policy: frame-ancestors` 头
         * 控制哪些源允许将本应用嵌入 <iframe>。
         *
         * - 空 / 未设置  → 仅同源：frame-ancestors 'self'（默认）
         * - 'none'         → 禁止一切嵌入
         * - 'self'         → 仅同源嵌入（与默认相同）
         * - 列表           → 逗号分隔的源，隐式包含 'self'
         *
         * 无论此设置如何，/admin 与 /api/admin/* 一律得到
         * frame-ancestors 'none' 与 X-Frame-Options: DENY。
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
    // 登录节流（admin 与 host 登录共用一个限流器）
    // ==========================================
    host: {
        maxLoginAttempts: Number(process.env.HOST_MAX_LOGIN_ATTEMPTS) || 5,
        minLoginBlockTime: Number(process.env.HOST_MIN_LOGIN_BLOCK_TIME) || 15, // 单位分钟
    },

    // ==========================================
    // 持久化频道（持久化频道 + 网页管理后台）
    // ==========================================
    // 频道保存在 app/src/channels.json，运行时经 /admin 后台管理。
    // 在密码与专用 JWT secret 两者都配置之前，admin 后台与所有
    // /api/admin/* 路由完全禁用（404）——没有任何不安全的默认值。
    // Docker 运行时把 channels.json 挂载为 volume，
    // 注册表才能在重启后存活。
    channels: {
        adminPassword: process.env.CHANNEL_ADMIN_PASSWORD || '',
        adminJwtSecret: process.env.CHANNEL_ADMIN_JWT_SECRET || '',
        adminJwtExp: process.env.CHANNEL_ADMIN_JWT_EXP || '24h',
        // host token 持久保存在浏览器里，登录状态可跨服务器重启保留，
        // 因此其有效期远长于 admin 后台会话。
        hostJwtExp: process.env.CHANNEL_HOST_JWT_EXP || '30d',
        // 未自行配置 hosts 的频道可接受这个共享口令作为 host 登录
        // （用户名任意填写）。留空则
        // 关闭该回退。
        defaultModerator: process.env.DEFAULT_CHANNEL_MODERATOR || '',
        autoInit: process.env.AUTO_INIT_CHANNELS ? getEnvBoolean(process.env.AUTO_INIT_CHANNELS) : true,
        // 临时房间：任何人打开 /c/<id> 即可得到一个内存房间
        // （无注册表条目、无 hosts）。默认开启，除非显式关闭。
        tempRooms: process.env.TEMP_ROOMS_ENABLED ? getEnvBoolean(process.env.TEMP_ROOMS_ENABLED) : true,
    },

    // ==========================================
    // API（旧版 /api/v1/stats，API-key 门控）
    // ==========================================
    api: {
        keySecret: process.env.API_KEY_SECRET,
    },

    // ==========================================
    // WebRTC ICE 服务器（STUN/TURN，join 时下发给客户端）
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
            // REST/HMAC 模式（coturn use-auth-secret）：设置后按进程铸造
            // 短时凭证，上面的静态 username / credential
            // 对 TURN 不再生效。
            secret: process.env.TURN_SERVER_SECRET || '',
            // 铸造凭证的有效期（秒）——超过 username 到期时间后 coturn
            // 会拒绝 allocate 请求；刷新发生在半衰期
            credentialTtlSec: Number(process.env.TURN_CREDENTIAL_TTL_SEC) || 12 * 3600,
        },
    },

    // ==========================================
    // IP 白名单
    // ==========================================
    ipWhitelist: {
        enabled: getEnvBoolean(process.env.IP_WHITELIST_ENABLED),
        allowed: parseJsonEnv(process.env.IP_WHITELIST_ALLOWED, []),
    },
};
