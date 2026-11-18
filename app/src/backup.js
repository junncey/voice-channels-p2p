'use strict';

/**
 * 供 admin 备份下载使用的极简 ustar tar 写入器（零外部依赖）：
 * channels.json + 每个已留存的聊天历史文件，以 tar.gz 流式输出。
 * 只产出短文件名的普通文件——这是每个 tar 实现都能理解的
 * ustar 子集。
 */

const fs = require('fs');

const BLOCK = 512;

/** 八进制 ASCII 编码，结尾 NUL/空格（tar 头字段）。 */
function octal(value, length) {
    return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** 头校验和：全部 512 字节求和，checksum 字段本身按空格计。 */
function headerChecksum(header) {
    let sum = 0;
    for (const byte of header) sum += byte;
    return sum;
}

/** 普通文件的一个 512 字节 ustar 头。 */
function fileHeader(name, size, mtime) {
    const header = Buffer.alloc(BLOCK);
    header.write(name.slice(0, 100), 0, 100, 'utf8'); // 文件名
    header.write(octal(0o644, 8), 100); // 权限
    header.write(octal(0, 8), 108); // uid
    header.write(octal(0, 8), 116); // gid
    header.write(octal(size, 12), 124); // 大小
    header.write(octal(mtime, 12), 136); // mtime
    header.write('        ', 148); // chksum 占位：8 个空格
    header.write('0', 156); // typeflag：普通文件
    header.write('ustar\0', 257, 'binary'); // magic
    header.write('00', 263); // version
    const sum = headerChecksum(header);
    header.write(octal(sum, 8), 148);
    return header;
}

/**
 * 异步生成器，逐块产出 tar 归档——HTTP 备份的流式实现：
 * 文件载荷绝不整体驻留内存，每个条目按块从磁盘读取，
 * 背压由消费侧的 stream.Readable.from 处理。
 * @param {Array<{name: string, path?: string, data?: Buffer, mtime?: number}>} files
 *   带 `data` 的条目原样 yield；带 `path` 的条目从磁盘流式读取
 *   （调用方必须已确认文件存在且可读）。
 */
async function* createTarIterator(files) {
    for (const file of files) {
        const mtime = Number.isFinite(file.mtime) ? Math.floor(file.mtime / 1000) : Math.floor(Date.now() / 1000);
        if (Buffer.isBuffer(file.data)) {
            yield fileHeader(file.name, file.data.length, mtime);
            yield file.data;
            const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
            if (pad) yield Buffer.alloc(pad);
            continue;
        }
        // fd 钉住 inode，size 以 fstat 为准，流按头声明的 size
        // 精确截断（end = size-1）：迭代期间 chatStore 对活跃频道
        // 的追加写、或压缩重写的 rename 换文件，都不再撕裂归档
        // （否则 tar 头声明的字节数与实际载荷错位 → 整个备份损坏）
        const fd = fs.openSync(file.path, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            yield fileHeader(file.name, size, mtime);
            if (size > 0) {
                const stream = fs.createReadStream(null, {
                    fd,
                    start: 0,
                    end: size - 1,
                    highWaterMark: 64 * 1024,
                    // autoClose 默认连显式 fd 一起自动释放（Node 24
                    // 实测），生命周期统一交给下面的 finally
                    autoClose: false,
                });
                for await (const chunk of stream) yield chunk;
            }
            const pad = (BLOCK - (size % BLOCK)) % BLOCK;
            if (pad) yield Buffer.alloc(pad);
        } finally {
            try {
                fs.closeSync(fd);
            } catch {
                /* 流异常路径可能已释放 */
            }
        }
    }
    yield Buffer.alloc(BLOCK * 2); // 归档结束标记
}

// ---------------------------------------------------------------------------
// 读取侧（admin 恢复）：严格的 ustar 解析器，只接受写入器产出的那个
// 子集——普通文件、短文件名、校验 checksum。畸形归档（checksum 不符、
// 意外的 typeflag、读取不足）一律抛 Error 拒绝，
// 而不是向磁盘写入任何东西。
// ---------------------------------------------------------------------------

/** 解析八进制 tar 头字段（NUL/空格结尾）。 */
function parseOctal(block, offset, length) {
    const raw = block.toString('utf8', offset, offset + length).replace(/[\0 ]/g, '');
    const value = parseInt(raw, 8);
    return Number.isFinite(value) ? value : NaN;
}

/**
 * 遍历单个 buffer 中的整个 tar 归档。文件按顺序交给
 * `onFile(name, buffer)`；目录与归档结束标记
 * 会终止解析。强制执行单文件与总量上限。
 * @param {Buffer} tar 原始（已解压）归档
 * @param {object} [options]
 * @param {number} [options.maxFileBytes] 单条目上限
 * @param {number} [options.maxTotalBytes] 整个归档上限
 * @param {function(string, Buffer): (void|Promise<void>)} [options.onFile]
 * @returns {Promise<{files: number, bytes: number}>}
 */
async function readTar(
    tar,
    { maxFileBytes = 64 * 1024 * 1024, maxTotalBytes = 1024 * 1024 * 1024, onFile = null } = {}
) {
    if (!Buffer.isBuffer(tar) || tar.length < BLOCK) throw new Error('archive too short');
    let offset = 0;
    let files = 0;
    let bytes = 0;
    let sawEnd = false;
    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        // 两个连续全零块 = 归档结束
        if (header.every((b) => b === 0)) {
            sawEnd = true;
            break;
        }
        // checksum：全部头字节求和，chksum 字段按空格计
        const stored = parseOctal(header, 148, 8);
        const actual = headerChecksum(header) - sumRange(header, 148, 8) + 8 * 0x20;
        if (!Number.isFinite(stored) || stored !== actual) throw new Error(`tar checksum mismatch at offset ${offset}`);
        const size = parseOctal(header, 124, 12);
        if (!Number.isFinite(size) || size < 0) throw new Error('tar entry has invalid size');
        if (size > maxFileBytes) throw new Error('tar entry exceeds the per-file size cap');
        const typeflag = String.fromCharCode(header[156]);
        let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
        const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
        if (prefix) name = `${prefix}/${name}`;
        offset += BLOCK;
        const content = tar.subarray(offset, offset + size);
        if (content.length < size) throw new Error(`archive truncated inside entry ${name}`);
        if (typeflag === '0' || typeflag === '\0') {
            if (!name) throw new Error('tar entry has an empty name');
            bytes += size;
            if (bytes > maxTotalBytes) throw new Error('archive exceeds the total size cap');
            if (onFile) await onFile(name, Buffer.from(content));
            files++;
        } else if (typeflag !== '5') {
            // 符号链接/设备/长名扩展绝不会出现在我们自己的备份里——
            // 对无法归类的条目类型宁可拒绝，
            // 也不静默跳过
            throw new Error(`unsupported tar entry type "${typeflag}" (${name})`);
        }
        offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    }
    if (!sawEnd) throw new Error('archive is missing its end-of-archive marker (truncated?)');
    if (!files) throw new Error('archive contains no files');
    return { files, bytes };
}

/** 字节区间求和（checksum 字段自身的字节，上方计算时已排除）。 */
function sumRange(block, start, length) {
    let sum = 0;
    for (let i = start; i < start + length; i++) sum += block[i];
    return sum;
}

module.exports = { fileHeader, createTarIterator, readTar };
