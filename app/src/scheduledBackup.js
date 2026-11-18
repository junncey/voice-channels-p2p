/*
定时滚动备份（与管理端下载相同的归档格式）。

未设置 CHANNEL_BACKUP_INTERVAL_HOURS 即关闭：向 CHANNEL_BACKUP_DIR
写入 tar.gz，只保留最新的 CHANNEL_BACKUP_KEEP 份归档。
env 直读，让既有的 config.js（创建于这些选项出现之前）
无需改动即可继续工作。这里的一切是从 adminApi.js 原样迁出的。
*/

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline, Readable } = require('stream');

const { createTarIterator } = require('./backup');

const BACKUP_INTERVAL_HOURS = Number(process.env.CHANNEL_BACKUP_INTERVAL_HOURS) || 0;
const BACKUP_KEEP = Math.max(1, Number(process.env.CHANNEL_BACKUP_KEEP) || 7);
const BACKUP_DIR = process.env.CHANNEL_BACKUP_DIR || path.join(__dirname, 'backups');

/**
 * 创建定时备份器。`collectEntries` 也供管理端下载端点
 * （/api/admin/backup）复用。
 */
function createScheduledBackup({ channelStore, chatStore, audit, log }) {
    /**
     * 备份载荷：channels.json + 每个持久化的聊天历史文件作为归档条目，
     * 预检可读性，让失败以干净的错误呈现，
     * 而不是在下载头已发出之后中途掐断流。
     */
    function collectEntries() {
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

    /** 按间隔执行（立即先备一份——全新部署也有一份）。 */
    function start() {
        const intervalMs = BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
        const run = () => {
            write()
                .then((file) => log.info('Scheduled backup written', { file }))
                .catch((err) => log.error('Scheduled backup failed', { error: err.message }));
        };
        run();
        const timer = setInterval(run, intervalMs);
        timer.unref?.();
    }

    /** 把备份归档写进 BACKUP_DIR；以文件路径 resolve。 */
    function write() {
        return new Promise((resolve, reject) => {
            let entries;
            try {
                entries = collectEntries();
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
                prune();
                audit.record('scheduledBackup', { file: path.basename(outFile), entries: entries.length });
                resolve(outFile);
            });
        });
    }

    /** 只保留 BACKUP_DIR 里最新的 BACKUP_KEEP 份归档。 */
    function prune() {
        try {
            const files = fs
                .readdirSync(BACKUP_DIR)
                .filter((name) => name.startsWith('voice-channels-backup-') && name.endsWith('.tar.gz'))
                .sort(); // 时间戳按字典序排序 = 按时间序排序
            for (const name of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
                fs.unlinkSync(path.join(BACKUP_DIR, name));
            }
        } catch (err) {
            log.warn('Scheduled backup prune failed', { error: err.message });
        }
    }

    return { collectEntries, start };
}

module.exports = { createScheduledBackup, BACKUP_INTERVAL_HOURS, BACKUP_KEEP };
