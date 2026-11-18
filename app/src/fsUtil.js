/*
共享的文件系统写入工具：曾经三处逐字重复的「原子写」模式
（channelStore 注册表 / chatStore 历史 / restore 恢复）的单一实现。
*/

'use strict';

const fs = require('fs');

/**
 * 原子全量写入：先写 <file>.tmp，再 rename 换正身。
 * Docker 常把单文件（channels.json、chat_history/<id>.jsonl）以
 * bind-mount 形式挂载——rename() 无法替换挂载点
 * （EBUSY / EXDEV / EPERM），回退为把载荷复制过去：
 * 覆盖挂载文件的内容是允许的，只有换掉它的 inode 不行。
 * @param {string} file 目标路径
 * @param {string|Buffer} data 载荷
 * @param {object} [options]
 * @param {number} [options.mode] 新建文件时的权限位（仅 POSIX 生效；
 *     注册表存有密码哈希时用 0o600）
 */
function writeFileAtomic(file, data, { mode } = {}) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
    try {
        fs.renameSync(tmp, file);
    } catch (err) {
        if (!['EBUSY', 'EXDEV', 'EPERM'].includes(err.code)) throw err;
        fs.copyFileSync(tmp, file);
        fs.unlinkSync(tmp);
    }
}

module.exports = { writeFileAtomic };
