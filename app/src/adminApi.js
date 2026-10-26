/*
Admin console + host REST surface, and the backup/restore machinery behind it.

Everything /api/admin/* and /api/host/* lives here (host login + chat export
included): the console stays completely DISABLED — 404 on every route — until
both CHANNEL_ADMIN_PASSWORD and CHANNEL_ADMIN_JWT_SECRET are configured.
Also owns the scheduled rolling backup (same archive as the admin download).
JWT signing/verification and the login rate limiter are injected by server.js
(the assembly point); everything here moved out of server.js verbatim.
*/

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { pipeline, Readable } = require('stream');

const checkXSS = require('./xss.js');
const { createTarIterator } = require('./backup');
const { applyBackupArchive, RestoreError } = require('./restore');
const { sanitizeExceptSecrets, sanitizeChannelPayload } = require('./payload');

// Scheduled rolling backup (off unless CHANNEL_BACKUP_INTERVAL_HOURS is set):
// writes a tar.gz into CHANNEL_BACKUP_DIR and keeps the newest
// CHANNEL_BACKUP_KEEP archives. Read from env directly so existing config.js
// files (created before these options existed) keep working unchanged.
const BACKUP_INTERVAL_HOURS = Number(process.env.CHANNEL_BACKUP_INTERVAL_HOURS) || 0;
const BACKUP_KEEP = Math.max(1, Number(process.env.CHANNEL_BACKUP_KEEP) || 7);
const BACKUP_DIR = process.env.CHANNEL_BACKUP_DIR || path.join(__dirname, 'backups');

function registerAdminApi(
    app,
    {
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
    }
) {
    const {
        channels,
        peers,
        ghosts,
        ghostKey,
        getPeerCount,
        getRoomMembers,
        isPeerInRoom,
        liveSessionSocket,
        releaseRoomEntry,
        broadcastRemovePeer,
    } = rooms;

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

    // -------------------------------------------------------------------------
    // Admin API (all 404 until the console is enabled)
    // -------------------------------------------------------------------------

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

    return { startScheduledBackup };

    // -------------------------------------------------------------------------
    // Scheduled rolling backup — same archive as the admin download, written to
    // BACKUP_DIR on an interval and pruned to the newest BACKUP_KEEP files.
    // -------------------------------------------------------------------------

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
}

module.exports = { registerAdminApi, BACKUP_INTERVAL_HOURS, BACKUP_KEEP };
