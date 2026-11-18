'use strict';

/**
 * MiroTalk P2P 语音频道版的持久化频道注册表。
 *
 * 频道保存在 JSON 文件里（默认 app/src/channels.json），运行时
 * 经 /admin 后台管理。host 凭证以 scrypt 哈希存储——
 * 明文密码绝不落盘。哈希与校验都是异步的
 * （线程池 scrypt；create/update/verifyHost/
 * verifyChannelPassword 返回 Promise），密码工作绝不阻塞
 * 事件循环。每次变更都原子写回（临时文件 + rename），
 * 崩溃绝不会留下写了一半的注册表。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Logs = require('./logs');
const limits = require('./limits');
const { writeFileAtomic } = require('./fsUtil');

const log = new Logs('channelStore');

const CHANNEL_ID_PATTERN = limits.CHANNEL_ID_RE;
// 与 Object.prototype 属性撞名的 ID 会污染 server.js 里以频道 id
// 为键的内存映射（map['constructor'] 这样的方括号查找会解析到
// 继承值而不是我们的条目）——直接拒绝。
// 仅精确匹配：id 模式区分大小写，且生成的 id（8 字符、
// 取自精简字母表）绝不可能与这些保留名碰撞。
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CHANNELS = 500;
// 活跃临时房间的上限：达到上限时 getOrCreateTemp 返回 null，
// 随机 id 的 join 洪泛就无法让内存映射无界增长。
const MAX_TEMP_ROOMS = 1000;
// 按 IP 的临时房间配额（按归一化 IP 计，见 normalizeIp）：
// 单个访客最多可持有 MAX_TEMPS_PER_IP 个活跃房间，每个滑动窗口
// 最多创建 TEMP_CREATE_MAX_PER_WINDOW 个新房间。房间从创建起
// 到最后一名成员离开（或 admin 删除）都算「持有」，
// 因此正常的「打开、使用、离开」周期绝不会触达任一上限。
const MAX_TEMPS_PER_IP = 3;
const TEMP_CREATE_MAX_PER_WINDOW = 5;
// 配额记账：每个 IP 一个小时间戳数组。过期数组在访问时修剪；
// 超过此条目数就全量清扫整个映射，
// 一去不回的 IP 无法持续累积。
const TEMP_LOG_SWEEP_AT = 512;
const MIN_PARTICIPANTS = 2;
const USERNAME_PATTERN = /^\S{1,32}$/;
const MAX_PARTICIPANTS = 16; // mesh 拓扑：刻意保持较小
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;
const PASSWORD_MAX = 64;
// 按频道的聊天留存覆盖上限（小时）——与全局设置同一上限
const RETENTION_MAX = 2160;

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

/**
 * crypto.scrypt 的 Promise 化。所有哈希/校验都经过这里——
 * scryptSync（N=16384 ≈ 50-100ms）跑在事件循环上，一波
 * 错误密码的 join 或 host 登录会卡住所有其他请求；
 * 异步形式改跑在 libuv 线程池上。N 是安全参数，
 * 刻意不调低。
 */
const scryptAsync = (password, salt, keylen, options) =>
    new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)));
    });

// 与频道列表一同持久化的 admin 管理运行时设置。
// env 值（TEMP_ROOMS_ENABLED 等）只在首次启动时播种默认；
// 此后 channels.json 里的后台值才是权威来源。
// 数字条目限定临时房间防滥用配额（见 getOrCreateTemp）；
// 所有范围都是健全性上限，手改的注册表无法搞坏服务器。
const SETTINGS_SCHEMA = {
    tempRooms: { type: 'boolean', default: true },
    // 所有 IP 合计的活跃临时房间（0 = 拒绝一切新建）
    tempMaxRooms: { type: 'number', min: 0, max: 10000, default: MAX_TEMP_ROOMS },
    // 单个 IP 同时可持有的活跃临时房间（0 = 拒绝一切新建）
    tempMaxPerIp: { type: 'number', min: 0, max: 100, default: MAX_TEMPS_PER_IP },
    // 每 IP 每滑动窗口的临时房间创建数（0 = 拒绝一切新建）
    tempCreateMax: { type: 'number', min: 0, max: 1000, default: TEMP_CREATE_MAX_PER_WINDOW },
    // 该滑动窗口的长度，单位分钟
    tempCreateWindowMin: { type: 'number', min: 1, max: 1440, default: 10 },
    // 单个 socket 同时可加入的频道数（一个页面恰好加入一个）
    socketMaxChannels: { type: 'number', min: 1, max: 16, default: 2 },
    // 文字聊天历史保留多久，单位小时（0 = 一律不保留）——见
    // chatStore.js；图片绝不持久化，只有文字部分入库
    chatRetentionHours: { type: 'number', min: 0, max: 2160, default: 24 },
};
const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA);

/** 加载路径与 admin 更新 API 共用的类型+范围检查。 */
function isValidSettingValue(value, rule) {
    if (rule.type === 'boolean') return typeof value === 'boolean';
    return Number.isInteger(value) && value >= rule.min && value <= rule.max;
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS)).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, expected] = parts;
    try {
        const actual = await scryptAsync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
        const expectedBuf = Buffer.from(expected, 'hex');
        return expectedBuf.length === actual.length && crypto.timingSafeEqual(actual, expectedBuf);
    } catch {
        return false;
    }
}

/** 密钥的常数时间字符串比较（与 server.js 共享）。 */
function constantTimeEquals(a, b) {
    const bufA = Buffer.from(String(a ?? ''));
    const bufB = Buffer.from(String(b ?? ''));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA); // 哑比较让时间曲线保持平坦
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 用存储的哈希校验密码：先原文，后清洗形态。
 * 密码一律原文哈希与比对——清洗器会静默改写含标记字符
 * （<、>、&）的密钥。在该规则之前写入的注册表存的是
 * 清洗后密码的哈希；`legacySanitize`（由持有 xss 模块的
 * server.js 注入）重推出该形态，
 * 让修复前的存量哈希仍能通过校验。
 */
async function verifyPasswordCompat(password, stored, legacySanitize) {
    if (await verifyPassword(password, stored)) return true;
    if (typeof legacySanitize === 'function' && typeof password === 'string') {
        const legacyForm = legacySanitize(password);
        if (typeof legacyForm === 'string' && legacyForm !== password) {
            return verifyPassword(legacyForm, stored);
        }
    }
    return false;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 为按 IP 的临时房间配额归一化 peer IP：IPv6 收敛到 /64 前缀
 * （同一台机器可在前缀内随意轮换地址），映射的 IPv4
 * （::ffff:1.2.3.4）保留 IPv4 部分，"[v6]:port"/"v4:port"
 * 后缀剥掉。无法使用的输入返回 ''——此时跳过配额记账
 * （全局 MAX_TEMP_ROOMS 上限仍然生效）。
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string') return '';
    let addr = ip.trim().toLowerCase().split('%')[0];
    if (!addr) return '';
    if (addr.startsWith('[')) {
        const end = addr.indexOf(']');
        addr = end > 0 ? addr.slice(1, end) : addr.slice(1);
    } else if ((addr.match(/:/g) || []).length === 1 && !addr.includes('::')) {
        addr = addr.split(':')[0]; // 裸 "v4:port"——handshake.address 不带端口，XFF 可能带
    }
    if (!addr.includes(':')) return addr; // IPv4

    const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return mapped[1];

    // 展开 "::" 压缩，才能切掉前 4 个 hextet（= /64）
    const halves = addr.split('::');
    if (halves.length > 2) return addr; // 畸形——按原样记录，不强行分组
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
    return groups
        .slice(0, 4)
        .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? g.padStart(4, '0') : g))
        .join(':');
}

/** isValidId 与 validateDefinition 共用的模式 + 保留名检查。 */
function isAcceptableId(id) {
    return CHANNEL_ID_PATTERN.test(id) && !RESERVED_IDS.has(id);
}

/**
 * 校验传入的频道定义（admin API 载荷）。
 * 返回 { ok, errors, value }——`value` 含归一化后的字段。
 * host 条目：新 host 必须给密码；UPDATE 时密码留空/缺省
 * 则同用户名保留既有哈希。
 */
function validateDefinition(input, { partial = false } = {}) {
    const errors = [];
    const value = {};

    if (!isPlainObject(input)) {
        return { ok: false, errors: ['payload must be an object'], value: null };
    }

    if (!partial || input.id !== undefined) {
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        // CREATE 时空 id 意为「自动生成」；更新时忽略 id 字段
        if (!id && partial) {
            errors.push(`id must match ${CHANNEL_ID_PATTERN} (3-32 chars: letters, digits, -, _)`);
        } else if (id && RESERVED_IDS.has(id)) {
            errors.push(`id is reserved: ${id}`);
        } else if (id && !CHANNEL_ID_PATTERN.test(id)) {
            errors.push(`id must match ${CHANNEL_ID_PATTERN} (3-32 chars: letters, digits, -, _)`);
        } else {
            value.id = id;
        }
    }

    if (!partial || input.name !== undefined) {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || name.length > NAME_MAX) {
            errors.push(`name is required (1-${NAME_MAX} chars)`);
        } else {
            value.name = name;
        }
    }

    if (input.description !== undefined) {
        const description = typeof input.description === 'string' ? input.description.trim() : '';
        if (description.length > DESCRIPTION_MAX) {
            errors.push(`description too long (max ${DESCRIPTION_MAX} chars)`);
        } else {
            value.description = description;
        }
    }

    if (input.public !== undefined) {
        value.public = Boolean(input.public);
    }

    if (input.maxParticipants !== undefined) {
        const n = Number(input.maxParticipants);
        if (!Number.isInteger(n) || n < MIN_PARTICIPANTS || n > MAX_PARTICIPANTS) {
            errors.push(`maxParticipants must be an integer between ${MIN_PARTICIPANTS} and ${MAX_PARTICIPANTS}`);
        } else {
            value.maxParticipants = n;
        }
    }

    if (input.hosts !== undefined) {
        if (!Array.isArray(input.hosts)) {
            errors.push('hosts must be an array');
        } else {
            const hosts = [];
            const seen = new Set();
            for (const entry of input.hosts) {
                if (!isPlainObject(entry)) {
                    errors.push('each host must be an object {username, password}');
                    break;
                }
                const username = typeof entry.username === 'string' ? entry.username.trim() : '';
                const password = typeof entry.password === 'string' ? entry.password : '';
                if (!USERNAME_PATTERN.test(username)) {
                    errors.push(`invalid host username: "${username}" (1-32 chars, no spaces)`);
                    break;
                }
                if (seen.has(username)) {
                    errors.push(`duplicate host username: "${username}"`);
                    break;
                }
                seen.add(username);
                hosts.push({ username, password });
            }
            value.hosts = hosts;
        }
    }

    // 频道加入密码。CREATE：''/undefined = 无密码。UPDATE：
    // undefined = 保留，'' = 清除，非空 = 替换哈希。
    if (input.password !== undefined) {
        if (typeof input.password !== 'string') {
            errors.push('password must be a string');
        } else if (input.password.length > PASSWORD_MAX) {
            errors.push(`password too long (max ${PASSWORD_MAX} chars)`);
        } else if (input.password && !input.password.trim()) {
            errors.push('password must not be blank');
        } else {
            value.password = input.password;
        }
    }

    // 按频道的聊天留存覆盖（小时）。''/null = 继承全局设置；
    // 0 = 该频道一律不保留；否则为整数。
    if (input.chatRetentionHours !== undefined) {
        const raw = input.chatRetentionHours;
        if (raw === null || raw === '') {
            value.chatRetentionHours = null;
        } else {
            const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
            if (!Number.isInteger(n) || n < 0 || n > RETENTION_MAX) {
                errors.push(
                    `chatRetentionHours must be an integer between 0 and ${RETENTION_MAX} (or empty to inherit)`
                );
            } else {
                value.chatRetentionHours = n;
            }
        }
    }

    return { ok: errors.length === 0, errors, value };
}

class ChannelStore {
    /**
     * @param {object} [options]
     * @param {string}  [options.filePath]        注册表文件位置
     * @param {boolean} [options.autoInit]        缺失时创建空的注册表文件
     * @param {string}  [options.defaultModerator] 未配置 hosts 的频道的共享口令
     *                                            （见 config.channels）
     * @param {object}  [options.defaultSettings] 首次启动时由 env 播种的设置默认值
     */
    constructor({
        filePath = path.join(__dirname, 'channels.json'),
        autoInit = true,
        defaultModerator = '',
        defaultSettings = {},
        legacySanitize = null,
    } = {}) {
        this.filePath = filePath;
        this.defaultModerator = String(defaultModerator || '');
        this.legacySanitize = legacySanitize; // see verifyPasswordCompat
        this.settings = Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([key, rule]) => [key, rule.default]));
        // env 播种的默认值（TEMP_ROOMS_ENABLED）优先于 schema 默认
        this.applySettings(defaultSettings);
        this.channels = [];
        /** id -> 临时频道定义（见 getTemp） */
        this.temps = new Map();
        /** normalizedIp -> 限流窗口内的创建时间戳 */
        this.tempCreateLog = new Map();
        this.load({ createIfMissing: autoInit });
    }

    load({ createIfMissing = false } = {}) {
        try {
            if (fs.existsSync(this.filePath)) {
                const { channels, settings } = this.readRegistryFile(this.filePath);
                this.channels = channels;
                this.applySettings(settings);
                log.info('Channel registry loaded', { file: this.filePath, channels: this.channels.length });
            } else if (createIfMissing) {
                this.save();
                log.info('Channel registry created', { file: this.filePath });
            }
        } catch (err) {
            log.error('Failed to load channel registry', { file: this.filePath, error: err.message });
            this.recoverFromCorruptFile(err);
        }
    }

    /** 把注册表文件解析为 { channels, settings }——JSON 不可读/无效时抛错。 */
    readRegistryFile(file) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            channels: Array.isArray(raw.channels)
                ? raw.channels.filter((ch) => isPlainObject(ch) && this.isValidId(ch.id))
                : [],
            settings: isPlainObject(raw.settings) ? raw.settings : {},
        };
    }

    applySettings(settings) {
        for (const key of SETTING_KEYS) {
            if (isValidSettingValue(settings[key], SETTINGS_SCHEMA[key])) this.settings[key] = settings[key];
        }
    }

    /**
     * 注册表文件无法解析：隔离它（改名为 <file>.corrupt），
     * 让未来的 save 绝不会用空注册表静默覆盖坏数据，
     * 然后尝试从 <file>.bak 恢复。仅当两个文件都不可用时
     * 才以空状态启动。
     */
    recoverFromCorruptFile(err) {
        const corruptPath = `${this.filePath}.corrupt`;
        try {
            fs.renameSync(this.filePath, corruptPath);
            log.error('Channel registry quarantined', { from: this.filePath, to: corruptPath, error: err.message });
        } catch (quarantineErr) {
            log.error('Channel registry could not be quarantined', {
                file: this.filePath,
                error: quarantineErr.message,
            });
        }
        const backupPath = `${this.filePath}.bak`;
        try {
            if (fs.existsSync(backupPath)) {
                const { channels, settings } = this.readRegistryFile(backupPath);
                this.channels = channels;
                this.applySettings(settings);
                log.warn('Channel registry restored from backup', { file: backupPath, channels: this.channels.length });
                return;
            }
        } catch (bakErr) {
            log.error('Channel registry backup unreadable', { file: backupPath, error: bakErr.message });
        }
        this.channels = [];
    }

    save() {
        // 每次写入前尽力备份上一状态，主文件损坏时总能恢复
        // （见 recoverFromCorruptFile）
        try {
            if (fs.existsSync(this.filePath)) {
                fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
            }
        } catch (err) {
            log.warn('Channel registry backup failed', { file: this.filePath, error: err.message });
        }
        const data = JSON.stringify({ version: 1, settings: this.settings, channels: this.channels }, null, 4);
        // mode 0o600：注册表存有密码哈希（仅 POSIX；Windows 上无效）
        writeFileAtomic(this.filePath, data, { mode: 0o600 });
    }

    isValidId(id) {
        return typeof id === 'string' && isAcceptableId(id);
    }

    /**
     * 为未显式指定 id 的频道生成随机 8 字符 id，例如
     * "k7x2m9qa"。字母表剔除易混淆字符（0/o、1/l/i），
     * 口述或从 /c/<id> 链接手打时依然可读。
     */
    generateId() {
        const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
        for (;;) {
            let id = '';
            const bytes = crypto.randomBytes(8);
            for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
            // 临时房间在注册表之外——这些 id 也要跳过，否则生成的频道
            // 会被在用的临时房间遮蔽
            if (!this.exists(id) && !this.temps.has(id)) return id;
        }
    }

    exists(id) {
        return this.channels.some((ch) => ch.id === id);
    }

    // ----- 临时（内存）频道 -----
    // 不在持久注册表内的 id 在首次 join 时生成。
    // 绝不写入 channels.json；最后一名成员离开时移除。

    getTemp(id) {
        return this.temps.get(id) || null;
    }

    isTemp(id) {
        return this.temps.has(id);
    }

    /**
     * 对将 CREATE 新房间的 join 的按 IP 临时房间配额：
     * 该 IP 持有的并发活跃房间数 + 滑动窗口内的创建次数。
     * 纯检查（除修剪过期时间戳外无副作用），
     * 让 join 路径能为客户端挑选具体错误；getOrCreateTemp
     * 重跑它作为真正的执行点。
     * @returns {{ok: true}|{ok: false, reason: 'per-ip-limit'|'rate-limit'}}
     */
    checkTempQuota(creatorIp) {
        const ip = normalizeIp(creatorIp);
        if (!ip) return { ok: true };
        return this.tempQuotaFor(ip);
    }

    /** 对已归一化 ip 的配额检查；就地修剪该 ip 的窗口。 */
    tempQuotaFor(ip, now = Date.now()) {
        const windowMs = this.settings.tempCreateWindowMin * 60 * 1000;
        let owned = 0;
        for (const ch of this.temps.values()) {
            if (ch.creatorIp === ip) owned++;
        }
        if (owned >= this.settings.tempMaxPerIp) return { ok: false, reason: 'per-ip-limit' };

        const window = (this.tempCreateLog.get(ip) || []).filter((ts) => now - ts < windowMs);
        this.tempCreateLog.set(ip, window);
        if (this.tempCreateLog.size > TEMP_LOG_SWEEP_AT) this.sweepTempCreateLog(now);
        if (window.length >= this.settings.tempCreateMax) return { ok: false, reason: 'rate-limit' };
        return { ok: true };
    }

    /** 丢弃所有被追踪 IP 的过期窗口数组（及空条目）。 */
    sweepTempCreateLog(now = Date.now()) {
        const windowMs = this.settings.tempCreateWindowMin * 60 * 1000;
        for (const [ip, stamps] of this.tempCreateLog) {
            const live = stamps.filter((ts) => now - ts < windowMs);
            if (live.length) this.tempCreateLog.set(ip, live);
            else this.tempCreateLog.delete(ip);
        }
    }

    getOrCreateTemp(id, { maxParticipants = limits.DEFAULT_MAX_PARTICIPANTS, creatorIp } = {}) {
        let channel = this.temps.get(id);
        if (!channel) {
            if (this.temps.size >= this.settings.tempMaxRooms) {
                log.warn('Temp channel cap reached, refusing to create', { id, cap: this.settings.tempMaxRooms });
                return null;
            }
            // 按 IP 配额（调用方未给出可归属 IP 时跳过）
            const ip = normalizeIp(creatorIp);
            const now = Date.now();
            if (ip && !this.tempQuotaFor(ip, now).ok) {
                log.warn('Temp channel per-IP quota exceeded, refusing to create', { id });
                return null;
            }
            const isoNow = new Date(now).toISOString();
            channel = {
                id,
                name: id,
                description: '',
                public: true,
                maxParticipants,
                hosts: [],
                temporary: true,
                creatorIp: ip || undefined, // 仅服务端；绝不离开 sanitize()
                createdAt: isoNow,
                updatedAt: isoNow,
            };
            this.temps.set(id, channel);
            if (ip) this.tempCreateLog.get(ip)?.push(now); // 窗口数组刚被 tempQuotaFor 修剪过
            log.info('Temp channel created', { id });
        }
        return channel;
    }

    /** @returns {boolean} 临时房间存在且被移除时为 true */
    removeTempIfEmpty(id, onlineCount = 0) {
        if (this.temps.has(id) && onlineCount <= 0) {
            this.temps.delete(id);
            log.info('Temp channel removed (empty)', { id });
            return true;
        }
        return false;
    }

    /** 无论占用情况强制移除临时房间（admin 删除）。 */
    removeTemp(id) {
        if (!this.temps.has(id)) return { ok: false, errors: [`channel not found: ${id}`] };
        this.temps.delete(id);
        log.info('Temp channel removed (admin)', { id });
        return { ok: true };
    }

    getSettings() {
        return { ...this.settings };
    }

    /** 部分更新已知设置；未知键忽略，非法值拒绝。原子持久化。 */
    updateSettings(input) {
        if (!isPlainObject(input)) return { ok: false, errors: ['settings must be an object'] };
        const errors = [];
        const next = { ...this.settings };
        for (const key of SETTING_KEYS) {
            if (input[key] === undefined) continue;
            const rule = SETTINGS_SCHEMA[key];
            const value =
                rule.type === 'number' && typeof input[key] === 'string' && input[key].trim() !== ''
                    ? Number(input[key]) // 接受 HTML 表单提交的数字字符串
                    : input[key];
            if (!isValidSettingValue(value, rule)) {
                errors.push(this.describeSettingError(key, rule));
            } else {
                next[key] = value;
            }
        }
        if (errors.length) return { ok: false, errors };
        this.settings = next;
        this.save();
        log.info('Settings updated', this.settings);
        return { ok: true, settings: this.getSettings() };
    }

    describeSettingError(key, rule) {
        if (rule.type === 'boolean') return `${key} must be a boolean`;
        return `${key} must be an integer between ${rule.min} and ${rule.max}`;
    }

    listTemps({ onlineOf = null } = {}) {
        return [...this.temps.values()].map((ch) => this.sanitize(ch, { online: onlineOf ? onlineOf(ch.id) : null }));
    }

    /** 原始定义（含密码哈希）——仅服务端使用。 */
    get(id) {
        return this.channels.find((ch) => ch.id === id) || null;
    }

    /**
     * 可安全下发给客户端的清洗副本。`includePrivate` 门控运营数据：
     * host 用户名只发给 admin 后台，绝不发给匿名的公共端点
     * （前端用不上它们）。
     */
    sanitize(channel, { includePrivate = false, online = null } = {}) {
        if (!channel) return null;
        const out = {
            id: channel.id,
            name: channel.name,
            description: channel.description || '',
            public: channel.public !== false,
            maxParticipants: channel.maxParticipants || limits.DEFAULT_MAX_PARTICIPANTS,
            hasPassword: Boolean(channel.passwordHash),
            temporary: channel.temporary === true,
            chatRetentionHours: channel.chatRetentionHours ?? null,
            createdAt: channel.createdAt,
            updatedAt: channel.updatedAt,
        };
        if (includePrivate) {
            out.hosts = Array.isArray(channel.hosts) ? channel.hosts.map((h) => h.username) : [];
        }
        if (online !== null) out.online = online;
        return out;
    }

    list({ includePrivate = false, onlineOf = null } = {}) {
        return this.channels
            .filter((ch) => includePrivate || ch.public !== false)
            .map((ch) =>
                this.sanitize(ch, {
                    includePrivate,
                    online: onlineOf ? onlineOf(ch.id) : null,
                })
            );
    }

    async create(input) {
        const { ok, errors, value } = validateDefinition(input);
        if (!ok) return { ok: false, errors };

        if (this.channels.length >= MAX_CHANNELS) {
            return { ok: false, errors: [`registry full (max ${MAX_CHANNELS} channels)`] };
        }
        const id = value.id || this.generateId();
        if (this.exists(id)) {
            return { ok: false, errors: [`channel id already exists: ${id}`] };
        }

        // 先把每个密钥都哈希完（异步 scrypt），让下方的变更 + save
        // 保持为一段同步区。await 会让出事件循环，
        // 因此 push 之前必须重查上面的守卫——重复提交
        // 或重试的请求可能带着相同 id 溜过预检查。
        const hostsInput = value.hosts || [];
        const [hostHashes, passwordHash] = await Promise.all([
            Promise.all(hostsInput.map((h) => (h.password ? hashPassword(h.password) : null))),
            value.password ? hashPassword(value.password) : null,
        ]);
        if (this.channels.length >= MAX_CHANNELS) {
            return { ok: false, errors: [`registry full (max ${MAX_CHANNELS} channels)`] };
        }
        if (this.exists(id)) {
            return { ok: false, errors: [`channel id already exists: ${id}`] };
        }

        const now = new Date().toISOString();
        const channel = {
            id,
            name: value.name,
            description: value.description || '',
            public: value.public !== false,
            maxParticipants: value.maxParticipants || limits.DEFAULT_MAX_PARTICIPANTS,
            hosts: hostsInput
                .map((h, i) => (h.password ? { username: h.username, passwordHash: hostHashes[i] } : null))
                .filter(Boolean),
            createdAt: now,
            updatedAt: now,
        };
        if (passwordHash) channel.passwordHash = passwordHash;
        if (value.chatRetentionHours !== null && value.chatRetentionHours !== undefined) {
            channel.chatRetentionHours = value.chatRetentionHours;
        }
        this.channels.push(channel);
        this.save();
        log.info('Channel created', { id: channel.id, name: channel.name, hosts: channel.hosts.length });
        // includePrivate：create/update 的结果供 ADMIN 后台使用，
        // 它需要 host 用户名
        return { ok: true, channel: this.sanitize(channel, { includePrivate: true }) };
    }

    async update(id, input) {
        const channel = this.get(id);
        if (!channel) return { ok: false, errors: [`channel not found: ${id}`] };

        const { ok, errors, value } = validateDefinition(input, { partial: true });
        if (!ok) return { ok: false, errors };

        // 在碰频道之前先哈希新密钥（异步 scrypt），让下方的变更 + save
        // 保持为一段同步区——见 create()。
        const [hostHashes, newChannelHash] = await Promise.all([
            value.hosts !== undefined
                ? Promise.all(value.hosts.map((h) => (h.password ? hashPassword(h.password) : null)))
                : null,
            value.password ? hashPassword(value.password) : null,
        ]);

        // 上面的 await 会让出事件循环——若并发的
        // remove()/restore 已把该频道移出注册表，则中止
        if (!this.channels.includes(channel)) {
            return { ok: false, errors: [`channel not found: ${id}`] };
        }

        if (value.name !== undefined) channel.name = value.name;
        if (value.description !== undefined) channel.description = value.description;
        if (value.public !== undefined) channel.public = value.public;
        if (value.maxParticipants !== undefined) channel.maxParticipants = value.maxParticipants;
        if (value.chatRetentionHours === null) delete channel.chatRetentionHours;
        else if (value.chatRetentionHours !== undefined) channel.chatRetentionHours = value.chatRetentionHours;

        if (value.hosts !== undefined) {
            channel.hosts = value.hosts.map((h, i) => {
                if (h.password) return { username: h.username, passwordHash: hostHashes[i] };
                // admin 留空密码字段时保留既有哈希
                const existing = channel.hosts.find((prev) => prev.username === h.username);
                return { username: h.username, passwordHash: existing ? existing.passwordHash : '' };
            });
        }

        if (value.password !== undefined) {
            if (newChannelHash) channel.passwordHash = newChannelHash;
            else delete channel.passwordHash; // '' 显式清除密码
        }

        channel.updatedAt = new Date().toISOString();
        this.save();
        log.info('Channel updated', { id: channel.id, hosts: channel.hosts.length });
        // 面向 admin 的结果（见 create）
        return { ok: true, channel: this.sanitize(channel, { includePrivate: true }) };
    }

    remove(id) {
        const before = this.channels.length;
        this.channels = this.channels.filter((ch) => ch.id !== id);
        if (this.channels.length === before) return { ok: false, errors: [`channel not found: ${id}`] };
        this.save();
        log.info('Channel removed', { id });
        return { ok: true };
    }

    /**
     * 校验频道的 host 凭证。
     * 回退：未配置 hosts 的频道接受共享的
     * DEFAULT_CHANNEL_MODERATOR 口令作为密码（用户名任意）。
     * 回退登录携带 `via: 'default-moderator'`，让 join 路径在
     * 采信该 token 前能复查频道是否仍然无主。
     * @returns {Promise<{username: string, via?: string}|null>}
     */
    async verifyHost(id, username, password) {
        const channel = this.get(id);
        if (!channel || typeof password !== 'string' || !password) return null;

        if (Array.isArray(channel.hosts) && channel.hosts.length) {
            const host = channel.hosts.find((h) => h.username === username);
            if (
                host &&
                host.passwordHash &&
                (await verifyPasswordCompat(password, host.passwordHash, this.legacySanitize))
            ) {
                return { username: host.username };
            }
            return null;
        }

        if (this.defaultModerator && constantTimeEquals(password, this.defaultModerator)) {
            return { username: (username || 'moderator').trim().slice(0, 32), via: 'default-moderator' };
        }
        return null;
    }

    /** 频道存在但未配置任何 host 时为 true（回退主持人的地盘）。 */
    isHostless(id) {
        const channel = this.get(id);
        return !!(channel && (!Array.isArray(channel.hosts) || channel.hosts.length === 0));
    }

    /** join 时复查：该用户名仍是已配置的 host 吗？ */
    isHost(id, username) {
        const channel = this.get(id);
        return !!(channel && Array.isArray(channel.hosts) && channel.hosts.some((h) => h.username === username));
    }

    /** 用频道存储的哈希校验加入密码（异步 scrypt）。 */
    async verifyChannelPassword(id, password) {
        const channel = this.get(id) || this.getTemp(id);
        if (!channel || !channel.passwordHash || typeof password !== 'string') return false;
        return verifyPasswordCompat(password, channel.passwordHash, this.legacySanitize);
    }
}

module.exports = ChannelStore;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.verifyPasswordCompat = verifyPasswordCompat;
module.exports.constantTimeEquals = constantTimeEquals;
module.exports.MAX_TEMP_ROOMS = MAX_TEMP_ROOMS;
module.exports.MAX_TEMPS_PER_IP = MAX_TEMPS_PER_IP;
module.exports.TEMP_CREATE_MAX_PER_WINDOW = TEMP_CREATE_MAX_PER_WINDOW;
module.exports.SETTINGS_SCHEMA = SETTINGS_SCHEMA;
module.exports.normalizeIp = normalizeIp;
