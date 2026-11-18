/*
管理后台 + host 的 REST 面，及其背后的恢复机制。

所有 /api/admin/* 与 /api/host/*（含 host 登录与聊天导出）都在这里：
在 CHANNEL_ADMIN_PASSWORD 与 CHANNEL_ADMIN_JWT_SECRET 两者都配置之前，
后台完全禁用——每条路由一律 404。
定时滚动备份在 scheduledBackup.js（其载荷收集也供这里的下载端点
复用）。JWT 签发/校验与登录限流器由 server.js（装配点）注入。
*/

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const { pipeline, Readable } = require('stream');

const checkXSS = require('./xss.js');
const { createTarIterator } = require('./backup');
const { applyBackupArchive, RestoreError } = require('./restore');
const { sanitizeExceptSecrets, sanitizeChannelPayload, hostTokenValidFor } = require('./payload');
const { BACKUP_INTERVAL_HOURS, BACKUP_KEEP } = require('./scheduledBackup');

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
        scheduledBackup,
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

    // host 登录 -> JWT，作为加入频道 socket 房间时的 peer_token
    app.post('/api/host/login', loginLimiter, async (req, res) => {
        const { channelId, username, password } = sanitizeExceptSecrets(req.body, ['password']);

        if (!channelId || !username || !password) {
            return res.status(400).json({ error: 'Missing channelId, username or password' });
        }
        if (!channelsCfg.adminJwtSecret) {
            // 按频道的 hosts 可能存在，但没有可用于签发 token 的 secret
            log.warn('Host login rejected: CHANNEL_ADMIN_JWT_SECRET is not configured');
            return res.status(503).json({ error: 'server not configured' });
        }
        if (!channelStore.exists(channelId)) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const host = await channelStore.verifyHost(channelId, username, password);
        if (!host) {
            log.warn('Host login failed', { channelId, username, ip: getIP(req) });
            return res.status(401).json({ error: 'unauthorized' });
        }

        log.info('Host login ok', { channelId, username: host.username });
        const payload = { role: 'host', channelId, username: host.username };
        if (host.via) payload.via = host.via; // 'default-moderator' 回退标记，join 时会复查
        res.json({ token: signConsoleToken(payload, channelsCfg.hostJwtExp) });
    });

    // -------------------------------------------------------------------------
    // Admin API（后台未启用前全部 404）
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
        // 与 env secret 原文比对——绝不清洗（含标记字符的 env 密码
        // 在此修复之前根本无法登录）
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
     * 把某频道的所有 peer 全部逐出（admin 删除频道）。每个 socket 先收到
     * 带删除原因的 kickOut，再硬断开——正常的断开清理
     * 会把房间结构拆除。
     */
    function evictChannelPeers(channelId, reason) {
        // Object.hasOwn：该 id 经 admin API 路径对客户端可见
        const room = Object.hasOwn(channels, channelId) ? channels[channelId] : null;
        if (!room) return 0;
        let evicted = 0;
        for (const sock of Object.values(room)) {
            try {
                sock.emit('kickOut', { reason });
                // 给数据包留一拍冲刷时间再硬关闭（与单成员 admin 踢人
                // 相同的形状）
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
     * 从频道移除单个成员（admin 后台）。活着的 socket 得到与 host 路径
     * 相同的 kickOut + 硬断开；幽灵（或已死 socket）当场过期——
     * 释放 + removePeer 广播，不走定时器。
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
            // 给数据包留一拍冲刷时间再硬关闭（形状同 evictChannelPeers，
            // 并已闭合竞态）
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
        // 临时房间不在持久注册表内，但同样可删除
        const result = channelStore.isTemp(id) ? channelStore.removeTemp(id) : channelStore.remove(id);
        if (!result.ok) return res.status(404).json({ error: result.errors[0] });
        // 持久化的聊天历史是频道的一部分——随之删除
        chatStore.removeChannel(id);
        const evicted = evictChannelPeers(id, 'channelDeleted');
        if (evicted) log.info('Channel deleted by admin, peers evicted', { channel: id, evicted });
        audit.record('channelDelete', { id, evicted });
        res.json({ success: true });
    });

    /**
     * 单文件服务器备份：channels.json + 每个持久化的聊天历史文件
     * 以 tar.gz 下载（恢复 = 解压覆盖到全新数据目录）。
     * 端到端流式（tar 迭代器 -> gzip 变换 -> 响应），
     * 因此无论历史体量多大，整个归档都不会整体驻留内存。
     */
    app.get('/api/admin/backup', requireAdmin, (req, res) => {
        try {
            const entries = scheduledBackup.collectEntries();
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
     * 恢复备份归档（见 restore.js）。上传以原始 tar.gz 请求体到达
     * （受 express.raw 限制约束）；磁盘上的任何东西被替换之前，
     * 每个条目都先校验。全量状态：归档里没有的频道，
     * 其历史会被移除。最好在无人连接时执行——
     * 不过无论何时，在线会话都保留其内存中的房间。
     */
    // 64MB gzip 上限：真实归档（每频道历史预算 12MB）远低于它，
    // 而请求体 + 解压形态都要驻留在小主机的内存里
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

    /** 审计轨迹的最新在前尾部（成员事件 + admin 数据操作）。 */
    app.get('/api/admin/audit', requireAdmin, (req, res) => {
        const limit = Number(req.query.limit) || 200;
        res.set('Cache-Control', 'no-store');
        res.json({ events: audit.tail(limit) });
    });

    /**
     * 供 admin 后台使用的服务器统计：注册表/临时房间计数、在线成员、
     * 持久化历史的磁盘占用，以及按频道的在线表。
     * 消息计数来自内存缓存——启动以来无人触碰的频道
     * 只报告文件大小（便宜；绝不全盘遍历）。
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
                /* 与删除竞态——遍历只为汇总服务 */
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
     * 主持人把频道聊天历史导出为 Markdown（host JWT 门控，
     * 与 join 路径相同的复查：该频道必须仍配置着此主持人，
     * 或对无主频道回退仍有效）。
     */
    app.get('/api/host/:channelId/export', (req, res) => {
        const channelId = req.params.channelId;
        if (!channelStore.exists(channelId) || !channelsCfg.adminJwtSecret) {
            return res.status(404).json({ error: 'Not found' });
        }
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        const payload = verifyConsoleToken(token);
        // 与 join 路径共用的复查（payload.hostTokenValidFor）：
        // 该频道必须仍配置着此主持人，或对无主频道的回退仍有效
        if (!hostTokenValidFor(payload, channelId, { channelsCfg, channelStore })) {
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

    /** 导出用的时间戳（近似本地时区，取服务器时钟；以可读为目标）。 */
    function tStamp(date) {
        const p = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
    }
}

module.exports = { registerAdminApi };
