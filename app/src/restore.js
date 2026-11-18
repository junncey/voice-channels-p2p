'use strict';

/**
 * Admin 备份恢复：把 GET /api/admin/backup 产出的 tar.gz 解回运行中的
 * 服务器——channels.json 进注册表，chat_history/*
 * 进历史目录。一切先经过校验，然后才替换任何文件
 * （先把整个归档解析进内存，再应用），因此截断或恶意的上传
 * 绝不会留下一台半恢复状态的服务器。
 *
 * 恢复是全量状态语义：归档里没有的频道，其历史文件会被移除，
 * 与「把备份解压覆盖到一个全新数据目录」的行为一致。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const Logs = require('./logs');
const { readTar } = require('./backup');
const limits = require('./limits');
const { writeFileAtomic } = require('./fsUtil');

const log = new Logs('restore');

const ID_PATTERN = limits.CHANNEL_ID_RE;
const REGISTRY_NAME = 'channels.json';
// 注册表最坏也就几百 KB；单个历史文件受 store 自身 12MB 磁盘预算约束。
// 整归档上限防止恶意或误传的上传把小主机 OOM：请求体先缓冲，
// 再 gunzip 进内存，然后解析——
// 每个阶段各有自己的天花板。
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024; // 解压后的 tar

class RestoreError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** 对原始归档 buffer 做 gunzip，解压尺寸有硬上限。 */
function gunzipBounded(gzipBuf, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        const stream = zlib.createGunzip();
        stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                stream.destroy();
                reject(new RestoreError('decompressed archive exceeds the size limit', 413));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('error', (err) => reject(new RestoreError(`invalid gzip archive: ${err.message}`)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.end(gzipBuf);
    });
}

/**
 * 校验并应用备份归档。
 * @param {Buffer} gzipBuf 原始 tar.gz 字节
 * @param {object} stores
 * @param {import('./channelStore')} stores.channelStore
 * @param {import('./chatStore')} stores.chatStore
 * @returns {Promise<{channels: number, histories: number}>}
 */
async function applyBackupArchive(gzipBuf, { channelStore, chatStore }) {
    if (!Buffer.isBuffer(gzipBuf) || !gzipBuf.length) throw new RestoreError('empty upload');
    const tar = await gunzipBounded(gzipBuf, MAX_ARCHIVE_BYTES);

    // ---- 第 1 遍：把所有条目解析进内存（尚未写任何东西） ----
    let registryRaw = null;
    /** id -> { ext: '.jsonl'|'.json', data: Buffer } */
    const histories = new Map();
    try {
        await readTar(tar, {
            maxFileBytes: MAX_REGISTRY_BYTES,
            maxTotalBytes: MAX_ARCHIVE_BYTES,
            onFile: (name, data) => {
                if (name === REGISTRY_NAME) {
                    registryRaw = data;
                    return;
                }
                const m = name.match(new RegExp(`^chat_history/(${limits.CHANNEL_ID_SOURCE})\\.(jsonl|json)$`));
                if (!m) throw new RestoreError(`unexpected archive entry: ${name}`);
                const id = m[1];
                const prev = histories.get(id);
                // 两者同时出现时，JSONL 条目优先于旧版 JSON 条目
                if (!prev || (prev.ext === '.json' && m[2] === 'jsonl')) {
                    histories.set(id, { ext: `.${m[2]}`, data });
                }
            },
        });
    } catch (err) {
        // tar 结构问题是客户端输入错误，不是服务器故障
        if (err instanceof RestoreError) throw err;
        throw new RestoreError(err.message);
    }
    if (!registryRaw) throw new RestoreError('archive is missing channels.json');

    // ---- 第 2 遍：校验内容（解析形状；依然什么都没写） ----
    let registry;
    try {
        registry = JSON.parse(registryRaw.toString('utf8'));
    } catch (err) {
        throw new RestoreError(`channels.json is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(registry.channels)) throw new RestoreError('channels.json has no channels array');
    if (
        registry.channels.length &&
        !registry.channels.every((ch) => ch && typeof ch === 'object' && ID_PATTERN.test(String(ch.id)))
    ) {
        throw new RestoreError('channels.json contains invalid channel ids');
    }
    for (const [id, entry] of histories) {
        if (entry.data.length > MAX_HISTORY_FILE_BYTES) throw new RestoreError(`history file too large: ${id}`);
        if (entry.ext === '.json') {
            try {
                const parsed = JSON.parse(entry.data.toString('utf8'));
                if (!Array.isArray(parsed?.messages)) throw new Error('no messages array');
            } catch (err) {
                throw new RestoreError(`history file ${id}.json is invalid: ${err.message}`);
            }
        } else {
            const lines = entry.data.toString('utf8').split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const row = JSON.parse(line);
                    if (!row || typeof row !== 'object' || !Number.isFinite(row.ts)) throw new Error('bad row');
                } catch (err) {
                    throw new RestoreError(`history file ${id}.jsonl has an invalid line: ${err.message}`);
                }
            }
        }
    }

    // ---- 第 3 遍：应用（先注册表，再历史文件，然后清扫） ----
    // 注册表：校验过的原始内容经由 store 自身成为新的 channels.json，
    // 这样 settings/哈希以一次原子形状同时落进内存与磁盘
    // （store 自己的 save() 负责 tmp+rename+.bak）
    const registryTmp = `${channelStore.filePath}.restore`;
    fs.writeFileSync(registryTmp, registryRaw, 'utf8');
    try {
        const parsed = channelStore.readRegistryFile(registryTmp);
        // 先给在线状态拍快照：若持久化 save() 失败，内存必须仍与我们
        // 手上的磁盘保持一致（applySettings 是原地变异，
        // 因此 settings 的拷贝是真快照，不是共享引用）
        const prevChannels = channelStore.channels;
        const prevSettings = { ...channelStore.settings };
        channelStore.channels = parsed.channels;
        channelStore.applySettings(parsed.settings);
        try {
            channelStore.save();
        } catch (saveErr) {
            channelStore.channels = prevChannels;
            channelStore.settings = prevSettings;
            throw saveErr;
        }
    } catch (err) {
        throw new RestoreError(`registry rejected: ${err.message}`);
    } finally {
        try {
            fs.unlinkSync(registryTmp);
        } catch {
            /* 早已不存在 */
        }
    }

    // 历史文件：按其在归档里的扩展名写入（旧版 .json 条目在首次加载时
    // 迁移为 .jsonl，与老安装的行为完全一致）。即使中途失败也必须在
    // finally 里 reload——内存缓存绝不能继续持有已被替换前的旧行。
    try {
        for (const [id, entry] of histories) {
            writeFileAtomic(path.join(chatStore.dir, `${id}${entry.ext}`), entry.data);
        }
        // 全量状态语义：归档里没有的频道，其历史文件一律删除
        for (const id of chatStore.listFiles()) {
            if (!histories.has(id)) chatStore.removeChannel(id);
        }
    } finally {
        chatStore.reload(); // 内存缓存惰性加载新文件
    }

    log.info('Backup restored', { channels: registry.channels.length, histories: histories.size });
    return { channels: registry.channels.length, histories: histories.size };
}

module.exports = { applyBackupArchive, RestoreError };
