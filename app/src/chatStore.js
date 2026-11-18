'use strict';

/**
 * 语音频道版的聊天历史存储。
 *
 * 聊天本身走 WebRTC DataChannel 的点对点传输；发送者的页面会额外
 * 把每条消息（文字 + 压缩图片的 data URL）在这里中转一份，
 * 让迟到的加入者能追上进度。消息按频道保存为纯追加的 JSONL
 * （app/src/chat_history/<id>.jsonl），
 * 且任何交互路径都绝不重写文件：
 *
 *   - 新消息恰好追加一行；
 *   - 生命周期变更追加小事件行（`{"e":...}`），加载时按文件顺序
 *     重放：编辑、撤回、回应与前缀丢弃（留存窗口 /
 *     MAX_MESSAGES 上限）——因此即使是一个 12MB、图片为主的
 *     频道也以 O(1) 变更，人们聊天时绝不会有完整序列化
 *     卡住事件循环；
 *   - 文件仅在以下时机与内存对账：推迟的后台压缩
 *     （文件越过预算的 COMPACT_AT_RATIO 后排期，~1s 合并）、
 *     单次追加越过硬预算时的内联收缩
 *     （磁盘上界与旧的逐消息重写方案相同）、
 *     旧版 <id>.json 迁移，
 *     以及追加失败时的兜底。
 *
 * 无人持有内存的频道的留存修剪由 stat + 尾部采样驱动：
 * 留存期内未变化的文件直接跳过不读，
 * 整文件过期的凭尾部时间戳即可擦除，
 * 只有剩下的情况才付出完整解析的代价。
 *
 * 撕裂的尾行（追加中途崩溃）对纯追加日志是常态，直接跳过；
 * 每行都带有限 `ts`，restore 校验得以继续接受该格式。
 * 旧版 <id>.json（单个 JSON 数组）在首次加载时迁移为 JSONL。
 * 临时房间的历史只存内存；
 * 它随房间一起消失。
 */

const fs = require('fs');
const path = require('path');

const Logs = require('./logs');
const limits = require('./limits');
const events = require('./chatEvents');
const { writeFileAtomic } = require('./fsUtil');

const log = new Logs('chatStore');

// 与频道注册表相同的 id 空间——id 会成为文件名，
// 因此这个检查兼作路径穿越防护。
const { CHANNEL_ID_RE: ID_PATTERN } = limits;

const MAX_MESSAGES = 300; // 每频道：存储、驻内存并下发
// 每频道的磁盘预算，含图片；行从最旧一端丢弃直到文件装得下
// （图片占大头——文字行只有几百字节）。越过预算的
// COMPACT_AT_RATIO（90%）后追加照常工作；越线只排期一个
// 合并的后台压缩。只有硬预算才内联收缩，
// 峰值磁盘占用与从前一样有界。
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const COMPACT_AT_RATIO = 0.9;
// 越线后到后台压缩真正执行前的宽限期——
// 编辑/回应/消息的爆发合并成一次重写。
const COMPACT_DELAY_MS = 1000;
// 追平分页：每次请求只发一页——join 时一次、每次向上滚动一页。
// 字节预算（estimateBytes 按序列化后的 UTF-8 字节精确计）让单次
// emit 连同事件包封留在 socket.io 的 maxHttpBufferSize
// （server.js，2e6）之内——留出封包余量。
// （图片占大头——最新一行总是随行，较旧的先丢弃。）
const CHAT_PAGE_SIZE = 10;
const MAX_SEND_BYTES = 1_900_000;
// 后台修剪走查存储（内存条目 + 磁盘文件）的频率，
// 让超出留存窗口的消息真正消失——即使频道无人触碰
// （例如 admin 缩短了窗口之后）。
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// 清扫读取历史文件尾部多少字节来找最新行时间戳，
// 再决定是否值得付出完整解析。
const SWEEP_TAIL_BYTES = 64 * 1024;

class ChatStore {
    /**
     * @param {object}   [options]
     * @param {string}   [options.dir]             历史目录
     * @param {function|number} [options.retentionHours] 在用的留存窗口，
     *     单位小时——channelId 的函数（按频道覆盖 → 全局回退），
     *     admin 改设置立即生效；0 = 一律不保留
     * @param {number}   [options.maxBytes]        每频道文件预算（测试用）
     * @param {number}   [options.sweepMs]         后台修剪间隔（0 = 关闭，测试用）
     */
    constructor({
        dir = path.join(__dirname, 'chat_history'),
        retentionHours = 24,
        maxBytes = MAX_FILE_BYTES,
        sweepMs = SWEEP_INTERVAL_MS,
    } = {}) {
        this.dir = dir;
        this.maxBytes = maxBytes > 0 ? maxBytes : MAX_FILE_BYTES;
        this.retentionHours = typeof retentionHours === 'function' ? retentionHours : () => retentionHours;
        /** channelId -> { persistent, messages: [{ts,name,text,...}], fileSize, pendingDrop, pendingDropTs } */
        this.channels = new Map();
        /** channelId -> { size, mtimeMs, retention, minTs }——让 sweep() 跳过未变化的空闲文件 */
        this.sweepState = new Map();
        this.compactPending = new Set();
        this.compactTimer = null;
        this.sweepTimer = null;
        if (sweepMs > 0) {
            this.sweepTimer = setInterval(() => {
                try {
                    this.sweep();
                } catch (err) {
                    log.error('Chat history sweep failed', { error: err.message });
                }
            }, sweepMs);
            this.sweepTimer.unref?.();
        }
        fs.mkdirSync(this.dir, { recursive: true });
    }

    /** 频道的规范（JSONL）历史文件。 */
    fileFor(id) {
        return path.join(this.dir, `${id}.jsonl`);
    }

    /** 频道的 JSONL 之前的历史文件（首次加载时迁移走）。 */
    legacyFileFor(id) {
        return path.join(this.dir, `${id}.json`);
    }

    /**
     * 此刻磁盘上真正持有该频道历史的文件
     * （迁移后为 JSONL，迁移前为旧版 JSON）。备份下载使用它，
     * 让归档始终反映真实的磁盘布局。
     */
    existingFileFor(id) {
        const jsonl = this.fileFor(id);
        if (fs.existsSync(jsonl)) return jsonl;
        const legacy = this.legacyFileFor(id);
        return fs.existsSync(legacy) ? legacy : jsonl;
    }

    /** 频道的留存窗口（毫秒）（0 = 功能关闭）。 */
    retentionMs(id) {
        const hours = Number(this.retentionHours(id));
        return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 0;
    }

    /** 频道的消息持有者（持久频道惰性加载文件）。 */
    entry(id, { persistent = true } = {}) {
        let entry = this.channels.get(id);
        if (!entry) {
            entry = { persistent, messages: persistent ? this.loadFile(id) : [], fileSize: null };
            if (persistent && entry.messages) {
                try {
                    entry.fileSize = fs.existsSync(this.fileFor(id)) ? fs.statSync(this.fileFor(id)).size : 0;
                } catch {
                    entry.fileSize = 0;
                }
            }
            entry.pendingDrop = 0;
            entry.pendingDropTs = undefined;
            this.channels.set(id, entry);
        }
        return entry;
    }

    loadFile(id) {
        const file = this.fileFor(id);
        try {
            if (fs.existsSync(file)) return this.loadJsonlFile(file);
        } catch (err) {
            log.error('Chat history file unreadable', { file, error: err.message });
            return [];
        }
        // 还没有 JSONL——首次触碰时迁移旧版 <id>.json
        const legacy = this.legacyFileFor(id);
        if (!fs.existsSync(legacy)) return [];
        let messages;
        try {
            const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'));
            messages = Array.isArray(raw?.messages) ? raw.messages.filter(events.isPlainMessage) : [];
        } catch (err) {
            // 损坏的历史文件绝不能拖垮服务器——隔离它
            // （与频道注册表相同的模式）并以空状态启动
            try {
                fs.renameSync(legacy, `${legacy}.corrupt`);
            } catch {
                /* 无能为力 */
            }
            log.error('Chat history file unreadable, quarantined', { file: legacy, error: err.message });
            return [];
        }
        if (messages.length) {
            try {
                this.writeFile(id, messages);
            } catch (err) {
                // JSONL 写不进去；无论如何先返回已解析的行——
                // 旧文件未动，下次启动会重试迁移，
                // 而不是让会话从空视图开始
                log.warn('Chat history migration could not write JSONL, serving parsed rows', {
                    channel: id,
                    error: err.message,
                });
                return messages;
            }
        }
        try {
            fs.unlinkSync(legacy);
        } catch (err) {
            // Windows/杀软可能短暂占住刚读完的文件（EBUSY）：JSONL
            // 已是权威数据，留下一个旧文件总比隔离一份好的历史强。
            // 下次加载优先用 JSONL。
            log.warn('Legacy chat history file not removed after migration', { channel: id, error: err.message });
        }
        log.info('Chat history migrated to JSONL', { channel: id, messages: messages.length });
        return messages;
    }

    /**
     * 逐行解析 JSONL 历史文件，把生命周期事件行（`{"e":...}`）按文件
     * 顺序重放到消息行上。撕裂的尾行（追加中途崩溃）对纯追加日志
     * 是常态，静默跳过；仍解析失败的行带着 warn 跳过。
     * 每一行都是垃圾的文件
     * 产生空历史。
     */
    loadJsonlFile(file) {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return [];
        const lines = raw.split('\n');
        const messages = [];
        let bad = 0;
        for (const line of lines) {
            if (!line) continue;
            try {
                const row = JSON.parse(line);
                // 消息行绝不带 `e` 字段——它是事件标记
                if (row && typeof row === 'object' && !Array.isArray(row) && row.e !== undefined) {
                    events.applyEvent(messages, row); // 无效/未知事件只是不生效
                } else if (events.isPlainMessage(row)) {
                    messages.push(row);
                } else {
                    bad++;
                }
            } catch {
                bad++;
            }
        }
        if (bad && !messages.length) {
            // 完全乱码（不只是撕裂尾行）——隔离以供检查
            try {
                fs.renameSync(file, `${file}.corrupt`);
            } catch {
                /* 用已解析的内容继续 */
            }
            log.warn('Chat history file fully unparsable, quarantined', { file, bad_lines: bad });
            return [];
        }
        if (bad) log.warn('Chat history file had unparsable lines', { file, bad_lines: bad, kept: messages.length });
        return messages;
    }

    /**
     * 存一条聊天消息。`imgs` 是已校验的 data:image/* URL 数组
     * （此前已在服务端清洗；此处再校验一次）。
     * `reply` 是对被回复行的可选引用（{name, text, ts}）。
     * 返回存储后的消息或 null（功能关闭、id/载荷非法）。
     * `ts` 覆盖参数供测试使用。
     */
    append(id, { name, text, imgs = [], reply = null }, { persistent = true, ts = Date.now() } = {}) {
        if (!ID_PATTERN.test(id)) return null;
        if (this.retentionMs(id) <= 0) return null;

        // 与客户端输入框完全一致的 trim + 上限（input.trim().slice(500)），
        // 存储的消息绝不与实时渲染的出现偏差
        const cleanName = typeof name === 'string' ? name.slice(0, limits.PEER_NAME_MAX) : '';
        const cleanText = events.cleanChatText(text);
        const images = events.sanitizeImages(imgs);
        if (!cleanText && !images.length) return null;

        const entry = this.entry(id, { persistent });
        const message = { ts, name: cleanName, text: cleanText };
        if (images.length) message.imgs = images; // 纯文字行省略该字段：保持文件紧凑
        const cleanReply = events.sanitizeReply(reply);
        if (cleanReply) message.reply = cleanReply;
        entry.messages.push(message);
        if (!persistent) {
            this.prune(entry.messages, Date.now(), id);
            while (entry.messages.length > MAX_MESSAGES) entry.messages.shift();
            return message;
        }

        this.trimEntry(entry, id);
        // 丢弃只发生在前缀，所以消息幸存，除非它从尾部消失
        // （即整段历史在它周围过期了）
        const kept = entry.messages[entry.messages.length - 1] === message;
        if (!kept || !(entry.fileSize > 0)) {
            // 整段历史过期、首行入档、或磁盘状态未知
            // （例如迁移失败）：一次规范写入把它落定
            this.save(id, entry);
            return message;
        }
        // O(1) 路径：待决前缀丢弃作为一行可重放标记随行，
        // 消息是另一行——预算由推迟的压缩执行
        // （或在 appendLines 内越过硬预算时内联执行）
        const lines = [];
        if (entry.pendingDrop > 0) {
            lines.push({ e: 'drop', ts: entry.pendingDropTs ?? 0, n: entry.pendingDrop });
            entry.pendingDrop = 0;
            entry.pendingDropTs = undefined;
        }
        lines.push(message);
        this.appendLines(id, entry, lines);
        return message;
    }

    /**
     * 单次写入追加一行或多行 JSONL。失败回退为全量重写。
     * 越过 COMPACT_AT_RATIO 排期后台压缩；
     * 越过硬预算则内联收缩，
     * 即使图片洪泛下峰值磁盘占用依然有界。
     */
    appendLines(id, entry, rows) {
        const line = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
        try {
            fs.appendFileSync(this.fileFor(id), line);
            entry.fileSize = (entry.fileSize || 0) + line.length;
            if (entry.fileSize >= this.maxBytes) this.save(id, entry);
            else if (entry.fileSize >= this.maxBytes * COMPACT_AT_RATIO) this.scheduleCompact(id);
        } catch (err) {
            log.warn('Chat history append failed, rewriting', { channel: id, error: err.message });
            this.save(id, entry);
        }
    }

    /**
     * 对条目行做留存修剪 + MAX_MESSAGES 上限，把每一条被丢弃的行
     * 记入 entry.pendingDrop，让下一个丢弃标记（或全量重写）
     * 保持磁盘重放与内存一致——包括发生在读取路径
     * （history/export）上、从不写盘的丢弃。
     * save() 在每次成功的全量重写时落定这笔账。
     */
    trimEntry(entry, id, now = Date.now()) {
        const { dropped, lastTs } = this.prune(entry.messages, now, id);
        let capDropped = 0;
        let capLastTs;
        while (entry.messages.length > MAX_MESSAGES) {
            capLastTs = entry.messages.shift().ts;
            capDropped++;
        }
        if (dropped > 0 || capDropped > 0) {
            entry.pendingDrop = (entry.pendingDrop || 0) + dropped + capDropped;
            // cap drops sit after prune drops in the prefix, so they are the
            // newer end of what left
            const latestDroppedTs = capLastTs ?? lastTs;
            if (latestDroppedTs !== undefined) entry.pendingDropTs = latestDroppedTs;
        }
    }

    /** 把待决前缀丢弃冲刷为一行可重放标记。 */
    emitDropMarker(id, entry) {
        const n = entry.pendingDrop || 0;
        if (n <= 0) return;
        const evt = { e: 'drop', ts: entry.pendingDropTs ?? 0, n };
        entry.pendingDrop = 0;
        entry.pendingDropTs = undefined;
        this.appendLines(id, entry, [evt]);
    }

    /**
     * 编辑调用者自己的消息（按 ts + 发送者名字匹配——
     * 名字是这个系统唯一的身份）。墓碑不可编辑。
     * 返回更新后的消息或 null。
     */
    edit(id, { ts, name, text }, { persistent = true } = {}) {
        const row = this.findRow(id, ts, name, { persistent });
        if (!row || row.deleted) return null;
        const cleanText = events.cleanChatText(text);
        if (!cleanText) return null;
        // 变更与 applyEvent('edit') 重放共用同一实现（chatEvents）
        events.applyEditText(row, cleanText);
        this.persistEvent(id, persistent, { e: 'edit', ts, name, text: cleanText });
        return row;
    }

    /**
     * 撤回（软删除）一条消息：该行保留为墓碑，
     * 分页游标与回复引用得以继续解析，但文字/图片已消失。
     */
    remove(id, { ts, name }, { persistent = true } = {}) {
        const row = this.findRow(id, ts, name, { persistent });
        if (!row || row.deleted) return null;
        // 变更与 applyEvent('del') 重放共用同一实现（chatEvents）
        events.applyDeleteRow(row);
        this.persistEvent(id, persistent, { e: 'del', ts, name });
        return row;
    }

    /**
     * 在消息的某个 emoji 上切换一个回应者。`who` 是操作成员
     * 在服务端的已加入名字。返回更新后的消息或 null。
     */
    react(id, { ts, name, emoji, who, op }, { persistent = true } = {}) {
        const row = this.findRow(id, ts, name, { persistent });
        if (!row || row.deleted) return null;
        const cleanEmoji = typeof emoji === 'string' ? emoji.trim().slice(0, limits.REACTION_EMOJI_MAX) : '';
        const whoName = typeof who === 'string' ? who.slice(0, limits.PEER_NAME_MAX) : '';
        if (!cleanEmoji || !whoName) return null;

        // 变更与 applyEvent('react') 重放共用同一实现（chatEvents）；
        // changed=false（重复/封顶/空移除）不落事件行
        const changed = events.toggleReaction(row, cleanEmoji, whoName, op);
        if (changed) {
            this.persistEvent(id, persistent, {
                e: 'react',
                ts,
                name,
                emoji: cleanEmoji,
                who: whoName,
                op: op === 'remove' ? 'remove' : 'add',
            });
        }
        return row;
    }

    /**
     * 把一条生命周期事件持久化为 O(1) 追加；全量重写只是
     * 文件缺失或为空的条目（迁移失败、全新磁盘状态）
     * 的兜底。
     */
    persistEvent(id, persistent, evt) {
        if (!persistent) return;
        const entry = this.channels.get(id);
        if (!entry) return;
        if (entry.fileSize > 0) this.appendLines(id, entry, [evt]);
        else this.save(id, entry);
    }

    /** 按 ts + 发送者名字找行；不存在（或频道未知）时为 null。 */
    findRow(id, ts, name, { persistent = true } = {}) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return null;
        if (!Number.isFinite(ts) || ts <= 0 || typeof name !== 'string' || !name) return null;
        const entry = this.entry(id, { persistent });
        return events.findRowIn(entry.messages, ts, name);
    }

    /**
     * 给加入者/向上滚动取的一页留存消息，最旧在前，
     * 在载荷预算之内（最新一行总是随行，较旧的先丢弃）。
     * `before`（一个 ts）向后翻页：只考虑严格更早的行。
     * ts 是唯一游标且不唯一，因此页边界绝不切开共享同一 ts 的组
     * ——整组随更旧的一页（或本页）走，
     * 否则下一页的游标会永远跳过它的剩余部分。
     * `hasMore` 表示存储里
     * 是否还有更旧的行
     * （已被 MAX_MESSAGES 移出的行永久消失，不计数）。
     */
    history(id, { persistent = true, before = 0, limit = CHAT_PAGE_SIZE, maxBytes = MAX_SEND_BYTES } = {}) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return { messages: [], hasMore: false };
        const entry = this.entry(id, { persistent });
        this.trimEntry(entry, id);

        const messages = entry.messages;
        let end = messages.length;
        if (Number.isFinite(before) && before > 0) {
            while (end > 0 && messages[end - 1].ts >= before) end--;
        }
        const count = Number.isFinite(limit) && limit > 0 ? limit : CHAT_PAGE_SIZE;
        const start = Math.max(0, end - count);

        const picked = [];
        let used = 0;
        let i = end - 1;
        for (; i >= start; i--) {
            const size = events.estimateBytes(messages[i]);
            // 页内最新一行总是随行；一旦触及预算，较旧的先丢弃，
            // 等下一页
            if (picked.length && used + size > maxBytes) break;
            picked.push(messages[i]);
            used += size;
        }
        // 治愈落在同 ts 组内部的切口（limit 或预算造成）：
        // 游标无法单独寻址的行必须整组发送
        while (i >= 0 && messages[i].ts === messages[i + 1]?.ts) {
            picked.push(messages[i]);
            i--;
        }
        const first = end - picked.length;
        return { messages: messages.slice(first, end), hasMore: first > 0 };
    }

    /**
     * 原地丢弃早于频道留存窗口的行。
     * 返回丢了几行与被丢的最新 ts（没丢时为 undefined），
     * 调用方据此为磁盘日志记前缀丢弃账。
     */
    prune(messages, now = Date.now(), id = null) {
        // 不带 id 的调用方（旧版）回退为无参解析
        const retention = this.retentionMs(id);
        if (retention <= 0) {
            const all = messages.length;
            const lastTs = all ? messages[all - 1].ts : undefined;
            messages.length = 0;
            return { dropped: all, lastTs };
        }
        const cutoff = now - retention;
        let drop = 0;
        while (drop < messages.length && messages[drop].ts <= cutoff) drop++;
        const lastTs = drop > 0 ? messages[drop - 1].ts : undefined;
        if (drop > 0) messages.splice(0, drop);
        return { dropped: drop, lastTs };
    }

    /**
     * 频道的完整留存历史，最旧在前，不分页（主持人导出）。
     * 先修剪，过期行绝不进入导出。
     */
    exportAll(id) {
        if (!ID_PATTERN.test(id) || this.retentionMs(id) <= 0) return [];
        const entry = this.entry(id, { persistent: true });
        this.trimEntry(entry, id);
        return entry.messages.map((m) => ({ ...m }));
    }

    /**
     * 原子全量重写（tmp + rename；单文件 bind mount 用内容复制）。
     * 也是压缩点：事件行折叠回普通行，行从最旧一端丢弃
     * 直到文件装进磁盘预算。只在交互路径之外被调用
     * （推迟的压缩、迁移、硬预算收缩、
     * 各处兜底）。
     */
    save(id, entry) {
        try {
            if (!entry.messages.length) {
                for (const file of [this.fileFor(id), this.legacyFileFor(id)]) {
                    try {
                        fs.unlinkSync(file);
                    } catch {
                        /* 早已不存在 */
                    }
                }
                entry.fileSize = 0;
                entry.pendingDrop = 0;
                entry.pendingDropTs = undefined;
                return;
            }
            // 从最旧一端收缩，直到文件装进磁盘预算。
            // 用字节长度而非 String#length：UTF-8 下中日韩文字
            // 每个码单元 3 字节，而预算是磁盘预算。
            let lines = events.serializeLines(entry.messages);
            let bytes = Buffer.byteLength(lines, 'utf8');
            while (bytes > this.maxBytes && entry.messages.length > 1) {
                entry.messages.shift();
                lines = events.serializeLines(entry.messages);
                bytes = Buffer.byteLength(lines, 'utf8');
            }
            this.writeFile(id, entry.messages, lines);
            entry.fileSize = bytes;
            // 文件现已镜像内存，任何待决的前缀丢弃记账随之落定
            // ——每次全量重写都必须经过这里
            entry.pendingDrop = 0;
            entry.pendingDropTs = undefined;
        } catch (err) {
            log.error('Chat history save failed', { channel: id, error: err.message });
        }
    }

    writeFile(id, messages, lines = events.serializeLines(messages)) {
        writeFileAtomic(this.fileFor(id), lines);
    }

    /**
     * 为频道排期合并的后台压缩：第一次越线启动定时器，
     * 后续越线只是加入批次。运行在交互之间，
     * 绝不在交互之中。
     */
    scheduleCompact(id) {
        if (this.compactPending.has(id)) return;
        this.compactPending.add(id);
        if (this.compactTimer) return;
        this.compactTimer = setTimeout(() => {
            this.compactTimer = null;
            const ids = [...this.compactPending];
            this.compactPending.clear();
            for (const pendingId of ids) {
                try {
                    this.runCompact(pendingId);
                } catch (err) {
                    log.error('Chat history compaction failed', { channel: pendingId, error: err.message });
                }
            }
        }, COMPACT_DELAY_MS);
        this.compactTimer.unref?.();
    }

    /** 把某频道的文件与内存对账：修剪、重写、丢弃标记折叠。 */
    runCompact(id) {
        const entry = this.channels.get(id); // 仅窥视——绝不在此惰性加载
        if (!entry) return;
        this.trimEntry(entry, id);
        this.save(id, entry); // 落定 pendingDrop——磁盘现已镜像内存
    }

    /** 彻底遗忘某频道（房间销毁 / admin 删除 / 恢复）。 */
    removeChannel(id) {
        if (typeof id !== 'string' || !id) return;
        this.channels.delete(id);
        this.sweepState.delete(id);
        for (const file of [this.fileFor(id), this.legacyFileFor(id)]) {
            try {
                fs.unlinkSync(file);
            } catch (err) {
                if (err.code !== 'ENOENT') log.warn('Chat history removal failed', { channel: id, error: err.message });
            }
        }
    }

    /** 丢弃全部内存缓存条目，下次读取从磁盘重载。 */
    reload() {
        this.channels.clear();
        this.sweepState.clear(); // 被恢复/替换的文件必须重新检查
    }

    /**
     * 后台清扫：修剪每个内存频道与每个磁盘文件
     * （覆盖留存窗口缩短后无人触碰的频道），
     * 删除最终为空的一切。
     * 功能关闭时抹掉全部历史。
     *
     * 仅存磁盘的频道尽可能走廉价路径：size/mtime 未变、
     * 窗口未变、且最旧的留存行尚未到达自身过期时间的文件，
     * 不可能有东西可修剪；
     * 整文件过期的凭一段尾部采样即可擦除。
     * 只有剩下的情况才付出完整解析的代价。
     */
    sweep(now = Date.now()) {
        for (const [id, entry] of [...this.channels]) {
            if (this.retentionMs(id) <= 0) {
                // 该频道自己的覆盖把它关闭——整体丢弃
                if (entry.persistent) this.removeChannel(id);
                else this.channels.delete(id);
                continue;
            }
            this.trimEntry(entry, id, now);
            if (!(entry.pendingDrop > 0)) continue;
            if (!entry.persistent) {
                entry.pendingDrop = 0;
                entry.pendingDropTs = undefined;
                if (!entry.messages.length) this.channels.delete(id);
                continue;
            }
            if (!entry.messages.length || !(entry.fileSize > 0)) {
                this.save(id, entry); // settles pendingDrop — disk mirrors memory now
            } else {
                this.emitDropMarker(id, entry);
            }
        }
        for (const id of this.listFiles()) {
            if (this.channels.has(id)) continue;
            if (this.retentionMs(id) <= 0) {
                this.removeChannel(id); // 按频道的覆盖关闭了它
                continue;
            }
            const retention = this.retentionMs(id);
            let st = null;
            try {
                st = fs.statSync(this.fileFor(id));
            } catch {
                /* 仅有旧文件的频道（或与删除竞态）——走完整路径 */
            }
            const seen = this.sweepState.get(id);
            if (
                st &&
                seen &&
                seen.size === st.size &&
                seen.mtimeMs === st.mtimeMs &&
                seen.retention === retention &&
                now < seen.minTs + retention
            ) {
                continue; // 文件未变，自上次检查以来不可能有过期
            }
            // 尾部探测：连最新一行都超出窗口时，整个文件都可丢
            // ——不必解析几 MB 才知道这一点
            if (st && st.size > 0) {
                const latest = this.tailLatestMessageTs(this.fileFor(id), st.size);
                if (latest !== null && latest <= now - retention) {
                    this.save(id, { persistent: true, messages: [] });
                    this.sweepState.delete(id);
                    continue;
                }
            }
            // loadFile() 自己可能把旧 .json 迁移为 .jsonl——存在性检查
            // 放在它之后，刚完成的迁移才不会被
            // 立刻再次重写
            const messages = this.loadFile(id);
            const before = messages.length;
            this.prune(messages, now, id);
            if (messages.length !== before || !fs.existsSync(this.fileFor(id))) {
                this.save(id, { persistent: true, messages });
            }
            // 记住检查后的形态，让空闲频道跳过之后每次清扫，
            // 直到文件变化、窗口移动、
            // 或最旧的留存行到达自身过期时间
            try {
                const after = fs.statSync(this.fileFor(id));
                this.sweepState.set(id, {
                    size: after.size,
                    mtimeMs: after.mtimeMs,
                    retention,
                    minTs: messages.length ? messages[0].ts : 0,
                });
            } catch {
                this.sweepState.delete(id); // 文件最终消失（全部过期）
            }
        }
    }

    /**
     * 历史文件最后 SWEEP_TAIL_BYTES 里找到的最新消息行 ts，
     * 尾部不可读/含糊时为 null（此时调用方回退完整检查）。
     * 事件行携带的 ts 属于文件里已有的行，
     * 因此绝不会抬高最大值。
     */
    tailLatestMessageTs(file, size) {
        const start = Math.max(0, size - SWEEP_TAIL_BYTES);
        const len = size - start;
        const buf = Buffer.allocUnsafe(len);
        try {
            const fd = fs.openSync(file, 'r');
            try {
                const read = fs.readSync(fd, buf, 0, len, start);
                if (read !== len) return null;
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return null;
        }
        let text = buf.toString('utf8');
        if (start > 0) {
            // 块可能从行中间（或码点中间）开始：丢弃到第一个
            // 完整换行为止的碎片
            const nl = text.indexOf('\n');
            if (nl === -1) return null;
            text = text.slice(nl + 1);
        }
        let maxTs = null;
        for (const line of text.split('\n')) {
            if (!line) continue;
            try {
                const row = JSON.parse(line);
                if (
                    row &&
                    typeof row === 'object' &&
                    !Array.isArray(row) &&
                    row.e === undefined &&
                    Number.isFinite(row.ts)
                ) {
                    if (maxTs === null || row.ts > maxTs) maxTs = row.ts;
                }
            } catch {
                return null; // 撕裂或异质尾部——交给完整检查
            }
        }
        return maxTs;
    }

    /** 磁盘上有历史文件（JSONL 或旧版 JSON）的频道 id。 */
    listFiles() {
        try {
            const ids = new Set();
            for (const name of fs.readdirSync(this.dir)) {
                for (const ext of ['.jsonl', '.json']) {
                    if (name.endsWith(ext)) ids.add(name.slice(0, -ext.length));
                }
            }
            return [...ids].filter((id) => ID_PATTERN.test(id));
        } catch {
            return [];
        }
    }

    destroy() {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
        if (this.compactTimer) clearTimeout(this.compactTimer);
        this.compactTimer = null;
        this.compactPending.clear();
        this.sweepState.clear();
    }
}

module.exports = ChatStore;
module.exports.MAX_MESSAGES = MAX_MESSAGES;
module.exports.CHAT_PAGE_SIZE = CHAT_PAGE_SIZE;
