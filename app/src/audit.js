'use strict';

/**
 * 轻量追加式审计轨迹（JSONL）：谁加入/离开/被踢、
 * 管理端数据操作（备份/恢复、频道增删改）。成员事件在常规日志路径
 * 默认被 debug 门控，所以当有人问「昨晚频道里都有谁」时，
 * 看这个文件就对了。
 *
 * 文件位于 channels.json 旁（默认 app/src/audit.jsonl），
 * 超过 MAX_BYTES 轮转为 <file>.1，并在内存里保留最后 MAX_LINES
 * 行供 admin tail 端点使用——刻意保持极小。
 */

const fs = require('fs');
const path = require('path');

const Logs = require('./logs');

const log = new Logs('audit');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_LINES = 2000; // 内存尾部（admin 端点最多返回这个数）
const MAX_FIELDS = 24; // 每事件字段数上限，硬形状守卫
const VALUE_MAX = 200; // 每个标量值上限，保证文件可 grep

class Audit {
    /** @param {string} [file] 审计 JSONL 文件位置 */
    constructor(file = path.join(__dirname, 'audit.jsonl')) {
        this.file = file;
        this.lines = [];
        this.tornTail = false; // 磁盘最后一行是撕裂写：下次追加前先补 \n
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            this.loadTail();
        } catch (err) {
            log.warn('Audit trail unavailable', { error: err.message });
        }
    }

    /** 追加一条事件：audit('join', { channel: 'x', name: 'alice' })。 */
    record(event, fields = {}) {
        const entry = { t: new Date().toISOString(), event: String(event).slice(0, 32) };
        let count = 0;
        for (const [key, value] of Object.entries(fields || {})) {
            if (count >= MAX_FIELDS) break;
            if (value === undefined || value === null) continue;
            const k = String(key).slice(0, 32);
            entry[k] =
                typeof value === 'object'
                    ? JSON.stringify(value).slice(0, VALUE_MAX * 4)
                    : String(value).slice(0, VALUE_MAX);
            count++;
        }
        const line = JSON.stringify(entry);
        this.lines.push(line);
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        try {
            this.rotateIfNeeded();
            // 撕裂尾部（追加中途崩溃）绝不能吞掉下一条事件
            fs.appendFileSync(this.file, (this.tornTail ? '\n' : '') + line + '\n', 'utf8');
            this.tornTail = false;
        } catch (err) {
            log.warn('Audit write failed', { error: err.message });
        }
        return entry;
    }

    rotateIfNeeded() {
        try {
            const stat = fs.statSync(this.file);
            if (stat.size < MAX_BYTES) return;
            fs.renameSync(this.file, `${this.file}.1`); // 旧的 .1 被丢弃
            log.info('Audit trail rotated', { file: this.file });
        } catch (err) {
            if (err.code !== 'ENOENT') log.warn('Audit rotate check failed', { error: err.message });
        }
    }

    /** 把已有审计文件的尾部行载入内存。 */
    loadTail() {
        if (!fs.existsSync(this.file)) return;
        const raw = fs.readFileSync(this.file, 'utf8');
        if (!raw.trim()) return;
        let lines = raw.split('\n').filter(Boolean);
        // 撕裂的尾行（追加中途崩溃）被丢弃并记住
        try {
            JSON.parse(lines[lines.length - 1]);
        } catch {
            lines = lines.slice(0, -1);
            this.tornTail = true;
        }
        this.lines = lines.slice(-MAX_LINES);
    }

    /**
     * 供管理后台使用的最新在前尾部。惰性解析并跳过
     * 无法解析的行（文件是纯追加的；撕裂尾行在意料之中）。
     * @returns {Array<object>}
     */
    tail(limit = 200) {
        const n = Math.max(1, Math.min(Number(limit) || 200, MAX_LINES));
        const out = [];
        for (let i = this.lines.length - 1; i >= 0 && out.length < n; i--) {
            try {
                out.push(JSON.parse(this.lines[i]));
            } catch {
                /* 跳过撕裂行 */
            }
        }
        return out;
    }
}

module.exports = Audit;
