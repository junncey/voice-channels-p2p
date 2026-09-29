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

const log = new Logs('channelStore');

const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const USERNAME_PATTERN = /^\S{1,32}$/;
const MAX_CHANNELS = 500;
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 16; // mesh topology: keep small on purpose
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;
const PASSWORD_MAX = 64;

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

// Admin-managed runtime settings persisted alongside the channel list. The
// env value (TEMP_ROOMS_ENABLED etc.) only seeds the default on first boot;
// after that the console toggle in channels.json is the source of truth.
const SETTING_KEYS = ['tempRooms'];

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

function constantTimeEquals(a, b) {
    const bufA = Buffer.from(String(a ?? ''));
    const bufB = Buffer.from(String(b ?? ''));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    constructor({ filePath = path.join(__dirname, 'channels.json'), autoInit = true, defaultModerator = '', defaultSettings = {} } = {}) {
        this.filePath = filePath;
        this.defaultModerator = String(defaultModerator || '');
        this.settings = { tempRooms: true, ...defaultSettings };
        this.channels = [];
        /** id -> ephemeral channel definition (see getTemp) */
        this.temps = new Map();
        this.load({ createIfMissing: autoInit });
    }

    load({ createIfMissing = false } = {}) {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.channels = Array.isArray(raw.channels)
                    ? raw.channels.filter((ch) => isPlainObject(ch) && this.isValidId(ch.id))
                    : [];
                if (isPlainObject(raw.settings)) {
                    for (const key of SETTING_KEYS) {
                        if (typeof raw.settings[key] === 'boolean') this.settings[key] = raw.settings[key];
                    }
                }
                log.info('Channel registry loaded', { file: this.filePath, channels: this.channels.length });
            } else if (createIfMissing) {
                this.save();
                log.info('Channel registry created', { file: this.filePath });
            }
        } catch (err) {
            log.error('Failed to load channel registry', { file: this.filePath, error: err.message });
            this.channels = [];
        }
    }

    save() {
        const data = JSON.stringify({ version: 1, settings: this.settings, channels: this.channels }, null, 4);
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, data, 'utf8');
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
        return typeof id === 'string' && CHANNEL_ID_PATTERN.test(id);
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
            if (!this.exists(id)) return id;
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

    getOrCreateTemp(id, { maxParticipants = 8 } = {}) {
        let channel = this.temps.get(id);
        if (!channel) {
            const now = new Date().toISOString();
            channel = {
                id,
                name: id,
                description: '',
                public: true,
                maxParticipants,
                hosts: [],
                temporary: true,
                createdAt: now,
                updatedAt: now,
            };
            this.temps.set(id, channel);
            log.info('Temp channel created', { id });
        }
        return channel;
    }

    removeTempIfEmpty(id, onlineCount = 0) {
        if (this.temps.has(id) && onlineCount <= 0) {
            this.temps.delete(id);
            log.info('Temp channel removed (empty)', { id });
        }
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

    /** Partial update of known boolean settings; persists atomically. */
    updateSettings(input) {
        if (!isPlainObject(input)) return { ok: false, errors: ['settings must be an object'] };
        const errors = [];
        const next = { ...this.settings };
        for (const key of SETTING_KEYS) {
            if (input[key] === undefined) continue;
            if (typeof input[key] !== 'boolean') {
                errors.push(`${key} must be a boolean`);
            } else {
                next[key] = input[key];
            }
        }
        if (errors.length) return { ok: false, errors };
        this.settings = next;
        this.save();
        log.info('Settings updated', this.settings);
        return { ok: true, settings: this.getSettings() };
    }

    listTemps({ onlineOf = null } = {}) {
        return [...this.temps.values()].map((ch) =>
            this.sanitize(ch, { online: onlineOf ? onlineOf(ch.id) : null }),
        );
    }

    /** Raw definition (includes password hashes) — server-side use only. */
    get(id) {
        return this.channels.find((ch) => ch.id === id) || null;
    }

    /** Sanitized copy safe to send to clients. */
    sanitize(channel, { includePrivate = false, online = null } = {}) {
        if (!channel) return null;
        const out = {
            id: channel.id,
            name: channel.name,
            description: channel.description || '',
            public: channel.public !== false,
            maxParticipants: channel.maxParticipants || 8,
            hosts: Array.isArray(channel.hosts) ? channel.hosts.map((h) => h.username) : [],
            hasPassword: Boolean(channel.passwordHash),
            temporary: channel.temporary === true,
            createdAt: channel.createdAt,
            updatedAt: channel.updatedAt,
        };
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
            maxParticipants: value.maxParticipants || 8,
            hosts: (value.hosts || [])
                .filter((h) => h.password)
                .map((h) => ({ username: h.username, passwordHash: hashPassword(h.password) })),
            createdAt: now,
            updatedAt: now,
        };
        if (value.password) channel.passwordHash = hashPassword(value.password);
        this.channels.push(channel);
        this.save();
        log.info('Channel created', { id: channel.id, name: channel.name, hosts: channel.hosts.length });
        return { ok: true, channel: this.sanitize(channel) };
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
        return { ok: true, channel: this.sanitize(channel) };
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
     * @returns {{username: string}|null}
     */
    verifyHost(id, username, password) {
        const channel = this.get(id);
        if (!channel || typeof password !== 'string' || !password) return null;

        if (Array.isArray(channel.hosts) && channel.hosts.length) {
            const host = channel.hosts.find((h) => h.username === username);
            if (host && host.passwordHash && verifyPassword(password, host.passwordHash)) {
                return { username: host.username };
            }
            return null;
        }

        if (this.defaultModerator && constantTimeEquals(password, this.defaultModerator)) {
            return { username: (username || 'moderator').trim().slice(0, 32) };
        }
        return null;
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
            verifyPassword(password, channel.passwordHash)
        );
    }
}

module.exports = ChannelStore;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.validateDefinition = validateDefinition;
module.exports.CHANNEL_ID_PATTERN = CHANNEL_ID_PATTERN;
module.exports.MAX_PARTICIPANTS = MAX_PARTICIPANTS;
