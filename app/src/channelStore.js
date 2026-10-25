'use strict';

/**
 * Persistent channel registry for the voice-channel edition of MiroTalk P2P.
 *
 * Channels live in a JSON file (app/src/channels.json by default) and are
 * managed at runtime through the /admin console. Host credentials are stored
 * as scrypt hashes — plaintext passwords never touch the disk. Every mutation
 * is written back atomically (temp file + rename) so a crash can never leave
 * a half-written registry behind.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Logs = require('./logs');
const limits = require('./limits');

const log = new Logs('channelStore');

const CHANNEL_ID_PATTERN = limits.CHANNEL_ID_RE;
// IDs colliding with Object.prototype properties would poison the in-memory
// maps keyed by channel id in server.js (a bracket lookup like map['constructor']
// resolves to the inherited value instead of our entry) — reject them outright.
// Exact match only: the id pattern is case-sensitive and generated ids (8 chars
// from a reduced alphabet) can never collide with these reserved names.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_CHANNELS = 500;
// Upper bound for live temporary rooms: getOrCreateTemp returns null at the cap
// so a flood of joins on random ids can't grow the in-memory map without bound.
const MAX_TEMP_ROOMS = 1000;
// Per-IP temp room quotas (counted on the normalized IP, see normalizeIp):
// a single visitor may keep at most MAX_TEMPS_PER_IP live rooms and create
// at most TEMP_CREATE_MAX_PER_WINDOW new ones per sliding window. Rooms count
// as "owned" from creation until the last peer leaves (or admin removal), so
// a normal "open, use, leave" cycle never hits either limit.
const MAX_TEMPS_PER_IP = 3;
const TEMP_CREATE_MAX_PER_WINDOW = 5;
// Quota bookkeeping: one small timestamp array per IP. Stale arrays are pruned
// on access; past this entry count the whole map is swept so IPs that never
// come back can't accumulate.
const TEMP_LOG_SWEEP_AT = 512;
const MIN_PARTICIPANTS = 2;
const USERNAME_PATTERN = /^\S{1,32}$/;
const MAX_PARTICIPANTS = 16; // mesh topology: keep small on purpose
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;
const PASSWORD_MAX = 64;
// per-channel chat retention override ceiling (hours) — same cap as the global setting
const RETENTION_MAX = 2160;

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

// Admin-managed runtime settings persisted alongside the channel list. The
// env value (TEMP_ROOMS_ENABLED etc.) only seeds the default on first boot;
// after that the console values in channels.json are the source of truth.
// Numeric entries bound the temp-room anti-abuse quotas (see getOrCreateTemp);
// all ranges are sanity caps so a hand-edited registry can't break the server.
const SETTINGS_SCHEMA = {
    tempRooms: { type: 'boolean', default: true },
    // live temp rooms across all IPs (0 = refuse every new one)
    tempMaxRooms: { type: 'number', min: 0, max: 10000, default: MAX_TEMP_ROOMS },
    // live temp rooms one IP may own at once (0 = refuse every new one)
    tempMaxPerIp: { type: 'number', min: 0, max: 100, default: MAX_TEMPS_PER_IP },
    // temp room creations per IP per sliding window (0 = refuse every new one)
    tempCreateMax: { type: 'number', min: 0, max: 1000, default: TEMP_CREATE_MAX_PER_WINDOW },
    // length of that sliding window, in minutes
    tempCreateWindowMin: { type: 'number', min: 1, max: 1440, default: 10 },
    // channels one socket may be joined to at once (a page joins exactly one)
    socketMaxChannels: { type: 'number', min: 1, max: 16, default: 2 },
    // how long text chat history is kept, in hours (0 = keep nothing) — see
    // chatStore.js; images are never persisted, only the text part is
    chatRetentionHours: { type: 'number', min: 0, max: 2160, default: 24 },
};
const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA);

/** Type+range check shared by the load path and the admin update API. */
function isValidSettingValue(value, rule) {
    if (rule.type === 'boolean') return typeof value === 'boolean';
    return Number.isInteger(value) && value >= rule.min && value <= rule.max;
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, expected] = parts;
    try {
        const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
        const expectedBuf = Buffer.from(expected, 'hex');
        return expectedBuf.length === actual.length && crypto.timingSafeEqual(actual, expectedBuf);
    } catch {
        return false;
    }
}

/** Constant-time string comparison for secrets (shared with server.js). */
function constantTimeEquals(a, b) {
    const bufA = Buffer.from(String(a ?? ''));
    const bufB = Buffer.from(String(b ?? ''));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA); // dummy compare keeps the timing profile flat
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a password against a stored hash, raw first, sanitized second.
 * Passwords are hashed and compared VERBATIM — a sanitizer would silently
 * rewrite secrets containing markup characters (<, >, &). Registries written
 * before that rule stored hashes of SANITIZED passwords; `legacySanitize`
 * (wired in from server.js, which owns the xss module) re-derives that form
 * so pre-fix stored hashes keep verifying.
 */
function verifyPasswordCompat(password, stored, legacySanitize) {
    if (verifyPassword(password, stored)) return true;
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
 * Normalize a peer IP for per-IP temp room quotas: IPv6 collapses to its /64
 * prefix (one machine can rotate addresses inside it at will), mapped IPv4
 * (::ffff:1.2.3.4) keeps the IPv4 part, and "[v6]:port"/"v4:port" suffixes
 * are dropped. Returns '' for anything unusable — quota tracking is skipped
 * then (the global MAX_TEMP_ROOMS cap still applies).
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string') return '';
    let addr = ip.trim().toLowerCase().split('%')[0];
    if (!addr) return '';
    if (addr.startsWith('[')) {
        const end = addr.indexOf(']');
        addr = end > 0 ? addr.slice(1, end) : addr.slice(1);
    } else if ((addr.match(/:/g) || []).length === 1 && !addr.includes('::')) {
        addr = addr.split(':')[0]; // bare "v4:port" — handshake.address carries no port, XFF might
    }
    if (!addr.includes(':')) return addr; // IPv4

    const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return mapped[1];

    // Expand "::" compression so the first 4 hextets (= /64) can be sliced off
    const halves = addr.split('::');
    if (halves.length > 2) return addr; // malformed — track as-is rather than mis-group
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
    return groups
        .slice(0, 4)
        .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? g.padStart(4, '0') : g))
        .join(':');
}

/** Pattern + reserved-name check shared by isValidId and validateDefinition. */
function isAcceptableId(id) {
    return CHANNEL_ID_PATTERN.test(id) && !RESERVED_IDS.has(id);
}

/**
 * Validate an incoming channel definition (admin API payload).
 * Returns { ok, errors, value } — `value` contains normalized fields.
 * Host entries: password is required for NEW hosts; empty/missing password on
 * UPDATE keeps the existing hash for the same username.
 */
function validateDefinition(input, { partial = false } = {}) {
    const errors = [];
    const value = {};

    if (!isPlainObject(input)) {
        return { ok: false, errors: ['payload must be an object'], value: null };
    }

    if (!partial || input.id !== undefined) {
        const id = typeof input.id === 'string' ? input.id.trim() : '';
        // empty id on CREATE means "auto-generate"; updates ignore the id field
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

    // Channel join password. CREATE: ''/undefined = no password. UPDATE:
    // undefined = keep, '' = clear, non-empty = replace the hash.
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

    // Per-channel chat retention override (hours). ''/null = inherit the
    // global setting; 0 = keep nothing for this channel; otherwise an integer.
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
     * @param {string}  [options.filePath]        registry file location
     * @param {boolean} [options.autoInit]        create an empty registry file when missing
     * @param {string}  [options.defaultModerator] shared-secret password for channels without
     *                                            configured hosts (see config.channels)
     * @param {object}  [options.defaultSettings] setting defaults seeded from env on first boot
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
        // env-seeded defaults (TEMP_ROOMS_ENABLED) win over the schema defaults
        this.applySettings(defaultSettings);
        this.channels = [];
        /** id -> ephemeral channel definition (see getTemp) */
        this.temps = new Map();
        /** normalizedIp -> creation timestamps inside the rate window */
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

    /** Parse a registry file into { channels, settings } — throws on unreadable/invalid JSON. */
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
     * The registry file could not be parsed: quarantine it (rename to
     * <file>.corrupt) so a future save can never silently overwrite the broken
     * data with an empty registry, then try to restore <file>.bak. Starts empty
     * only when neither file is usable.
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
        // best-effort backup of the previous state before every write, so a
        // corrupted main file can always be recovered (see recoverFromCorruptFile)
        try {
            if (fs.existsSync(this.filePath)) {
                fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
            }
        } catch (err) {
            log.warn('Channel registry backup failed', { file: this.filePath, error: err.message });
        }
        const data = JSON.stringify({ version: 1, settings: this.settings, channels: this.channels }, null, 4);
        const tmp = `${this.filePath}.tmp`;
        // mode 0o600: the registry holds password hashes (POSIX only; no-op on Windows)
        fs.writeFileSync(tmp, data, { encoding: 'utf8', mode: 0o600 });
        try {
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            // Docker often bind-mounts channels.json as a *single file*. rename() cannot
            // replace a mount point (EBUSY / EXDEV), so fall back to copying the payload
            // over it — overwriting the mounted file's content is allowed, only swapping
            // its inode is not.
            if (!['EBUSY', 'EXDEV', 'EPERM'].includes(err.code)) throw err;
            fs.copyFileSync(tmp, this.filePath);
            fs.unlinkSync(tmp);
        }
    }

    isValidId(id) {
        return typeof id === 'string' && isAcceptableId(id);
    }

    /**
     * Random 8-char id for channels created without an explicit one, e.g.
     * "k7x2m9qa". The alphabet drops look-alikes (0/o, 1/l/i) so the id stays
     * readable when spoken or typed from the /c/<id> link.
     */
    generateId() {
        const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
        for (;;) {
            let id = '';
            const bytes = crypto.randomBytes(8);
            for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
            // temp rooms live outside the registry — skip those ids too or the
            // generated channel would be shadowed by the live temp room
            if (!this.exists(id) && !this.temps.has(id)) return id;
        }
    }

    exists(id) {
        return this.channels.some((ch) => ch.id === id);
    }

    // ----- temporary (in-memory) channels -----
    // Spawned on first join for ids that aren't in the persistent registry.
    // Never written to channels.json; removed when the last peer leaves.

    getTemp(id) {
        return this.temps.get(id) || null;
    }

    isTemp(id) {
        return this.temps.has(id);
    }

    /**
     * Per-IP temp room quotas for a join that would CREATE a new room:
     * concurrent live rooms owned by the IP + creations inside the sliding
     * window. Pure check (no side effects beyond pruning expired timestamps)
     * so the join path can pick a specific error for the client; getOrCreateTemp
     * re-runs it as the real enforcement point.
     * @returns {{ok: true}|{ok: false, reason: 'per-ip-limit'|'rate-limit'}}
     */
    checkTempQuota(creatorIp) {
        const ip = normalizeIp(creatorIp);
        if (!ip) return { ok: true };
        return this.tempQuotaFor(ip);
    }

    /** Quota check on an already-normalized ip; prunes the ip's window in place. */
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

    /** Drop expired window arrays (and empty entries) across all tracked IPs. */
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
            // per-IP quotas (skip when the caller gave no attributable IP)
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
                creatorIp: ip || undefined, // server-side only; never leaves sanitize()
                createdAt: isoNow,
                updatedAt: isoNow,
            };
            this.temps.set(id, channel);
            if (ip) this.tempCreateLog.get(ip)?.push(now); // window array was just pruned by tempQuotaFor
            log.info('Temp channel created', { id });
        }
        return channel;
    }

    /** @returns {boolean} true when the temp room existed and was removed */
    removeTempIfEmpty(id, onlineCount = 0) {
        if (this.temps.has(id) && onlineCount <= 0) {
            this.temps.delete(id);
            log.info('Temp channel removed (empty)', { id });
            return true;
        }
        return false;
    }

    /** Force-remove a temp room regardless of occupancy (admin delete). */
    removeTemp(id) {
        if (!this.temps.has(id)) return { ok: false, errors: [`channel not found: ${id}`] };
        this.temps.delete(id);
        log.info('Temp channel removed (admin)', { id });
        return { ok: true };
    }

    getSettings() {
        return { ...this.settings };
    }

    /** Partial update of known settings; unknown keys are ignored, invalid values rejected. Persists atomically. */
    updateSettings(input) {
        if (!isPlainObject(input)) return { ok: false, errors: ['settings must be an object'] };
        const errors = [];
        const next = { ...this.settings };
        for (const key of SETTING_KEYS) {
            if (input[key] === undefined) continue;
            const rule = SETTINGS_SCHEMA[key];
            const value =
                rule.type === 'number' && typeof input[key] === 'string' && input[key].trim() !== ''
                    ? Number(input[key]) // accept numeric strings from HTML forms
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

    /** Raw definition (includes password hashes) — server-side use only. */
    get(id) {
        return this.channels.find((ch) => ch.id === id) || null;
    }

    /**
     * Sanitized copy safe to send to clients. `includePrivate` gates operator
     * data: host usernames ship only to the admin console, never to the
     * anonymous public endpoints (the frontend has no use for them).
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

    create(input) {
        const { ok, errors, value } = validateDefinition(input);
        if (!ok) return { ok: false, errors };

        if (this.channels.length >= MAX_CHANNELS) {
            return { ok: false, errors: [`registry full (max ${MAX_CHANNELS} channels)`] };
        }
        const id = value.id || this.generateId();
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
            hosts: (value.hosts || [])
                .filter((h) => h.password)
                .map((h) => ({ username: h.username, passwordHash: hashPassword(h.password) })),
            createdAt: now,
            updatedAt: now,
        };
        if (value.password) channel.passwordHash = hashPassword(value.password);
        if (value.chatRetentionHours !== null && value.chatRetentionHours !== undefined) {
            channel.chatRetentionHours = value.chatRetentionHours;
        }
        this.channels.push(channel);
        this.save();
        log.info('Channel created', { id: channel.id, name: channel.name, hosts: channel.hosts.length });
        // includePrivate: the create/update results feed the ADMIN console,
        // which needs the host usernames
        return { ok: true, channel: this.sanitize(channel, { includePrivate: true }) };
    }

    update(id, input) {
        const channel = this.get(id);
        if (!channel) return { ok: false, errors: [`channel not found: ${id}`] };

        const { ok, errors, value } = validateDefinition(input, { partial: true });
        if (!ok) return { ok: false, errors };

        if (value.name !== undefined) channel.name = value.name;
        if (value.description !== undefined) channel.description = value.description;
        if (value.public !== undefined) channel.public = value.public;
        if (value.maxParticipants !== undefined) channel.maxParticipants = value.maxParticipants;
        if (value.chatRetentionHours === null) delete channel.chatRetentionHours;
        else if (value.chatRetentionHours !== undefined) channel.chatRetentionHours = value.chatRetentionHours;

        if (value.hosts !== undefined) {
            channel.hosts = value.hosts.map((h) => {
                if (h.password) return { username: h.username, passwordHash: hashPassword(h.password) };
                // keep existing hash when the admin left the password field blank
                const existing = channel.hosts.find((prev) => prev.username === h.username);
                return { username: h.username, passwordHash: existing ? existing.passwordHash : '' };
            });
        }

        if (value.password !== undefined) {
            if (value.password) channel.passwordHash = hashPassword(value.password);
            else delete channel.passwordHash; // '' explicitly clears the password
        }

        channel.updatedAt = new Date().toISOString();
        this.save();
        log.info('Channel updated', { id: channel.id, hosts: channel.hosts.length });
        // admin-facing result (see create)
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
     * Verify host credentials for a channel.
     * Fallback: channels without configured hosts accept the shared
     * DEFAULT_CHANNEL_MODERATOR secret as the password (username is free-form).
     * Fallback logins carry `via: 'default-moderator'` so the join path can
     * re-check that the channel is STILL hostless before honoring the token.
     * @returns {{username: string, via?: string}|null}
     */
    verifyHost(id, username, password) {
        const channel = this.get(id);
        if (!channel || typeof password !== 'string' || !password) return null;

        if (Array.isArray(channel.hosts) && channel.hosts.length) {
            const host = channel.hosts.find((h) => h.username === username);
            if (host && host.passwordHash && verifyPasswordCompat(password, host.passwordHash, this.legacySanitize)) {
                return { username: host.username };
            }
            return null;
        }

        if (this.defaultModerator && constantTimeEquals(password, this.defaultModerator)) {
            return { username: (username || 'moderator').trim().slice(0, 32), via: 'default-moderator' };
        }
        return null;
    }

    /** True when the channel exists but has no hosts configured (fallback moderator territory). */
    isHostless(id) {
        const channel = this.get(id);
        return !!(channel && (!Array.isArray(channel.hosts) || channel.hosts.length === 0));
    }

    /** Join-time re-check: is this username still a configured host? */
    isHost(id, username) {
        const channel = this.get(id);
        return !!(channel && Array.isArray(channel.hosts) && channel.hosts.some((h) => h.username === username));
    }

    /** Verify a join password against the channel's stored hash. */
    verifyChannelPassword(id, password) {
        const channel = this.get(id) || this.getTemp(id);
        return Boolean(
            channel &&
            channel.passwordHash &&
            typeof password === 'string' &&
            verifyPasswordCompat(password, channel.passwordHash, this.legacySanitize)
        );
    }
}

module.exports = ChannelStore;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.verifyPasswordCompat = verifyPasswordCompat;
module.exports.constantTimeEquals = constantTimeEquals;
module.exports.validateDefinition = validateDefinition;
module.exports.CHANNEL_ID_PATTERN = CHANNEL_ID_PATTERN;
module.exports.MAX_PARTICIPANTS = MAX_PARTICIPANTS;
module.exports.MAX_TEMP_ROOMS = MAX_TEMP_ROOMS;
module.exports.MAX_TEMPS_PER_IP = MAX_TEMPS_PER_IP;
module.exports.TEMP_CREATE_MAX_PER_WINDOW = TEMP_CREATE_MAX_PER_WINDOW;
module.exports.SETTINGS_SCHEMA = SETTINGS_SCHEMA;
module.exports.normalizeIp = normalizeIp;
