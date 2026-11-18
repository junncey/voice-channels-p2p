/*
测试公共工具。注意：这里绝不能 require app/src/config.js——
config 按 env 缓存，会污染 test-server.js 的 env 预设
（参见 test-embed-headers.js 的缓存自清理）。
*/

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { fileHeader } = require('../app/src/backup');

/** 新建一次性临时目录（测试自清理用 rmSync 即可）。 */
function tempDir(prefix = 'vc-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 用 backup.js 的同一个 ustar 头构建器把内存条目打包成
 * tar buffer——测试 fixture 专用（生产路径走流式的
 * createTarIterator）。校验和由读取侧强制执行，
 * 两侧格式知识仍单源。
 * @param {Array<{name: string, data: Buffer, mtime?: number}>} files
 * @returns {Buffer}
 */
function tarFiles(files) {
    const chunks = [];
    for (const file of files) {
        if (!Buffer.isBuffer(file.data)) continue;
        const mtime = Number.isFinite(file.mtime) ? Math.floor(file.mtime / 1000) : Math.floor(Date.now() / 1000);
        chunks.push(fileHeader(file.name, file.data.length, mtime));
        chunks.push(file.data);
        const BLOCK = 512;
        const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
        if (pad) chunks.push(Buffer.alloc(pad));
    }
    chunks.push(Buffer.alloc(512 * 2)); // 归档结束标记
    return Buffer.concat(chunks);
}

/**
 * 动态 import 浏览器 ES 模块（public/js/**）供 Node 侧测试。
 * @param {string} relPath 相对仓库根的模块路径，如 'public/js/core/utils.js'
 */
async function importBrowserModule(relPath) {
    const { pathToFileURL } = await import('node:url');
    return import(pathToFileURL(path.join(__dirname, '..', relPath)).href);
}

module.exports = { tempDir, tarFiles, importBrowserModule };
