'use strict';

/*
 * 经 GET /api/version 下发给页面的前端版本信息。
 *
 * `build` 是 public/ 下所有文件（相对路径+内容）的指纹，
 * 因此任何前端改动都能被检测到，无需手动递增
 * package.json 版本号——纯后端部署也绝不会把
 * 已打开的页面误标记为过期。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUILD_ID_LENGTH = 12;

function listFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFiles(full));
        else if (entry.isFile()) out.push(full);
    }
    return out;
}

function computeBuildId(publicDir) {
    const hash = crypto.createHash('sha256');
    for (const file of listFiles(publicDir).sort()) {
        hash.update(path.relative(publicDir, file).replace(/\\/g, '/'));
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    }
    return hash.digest('hex').slice(0, BUILD_ID_LENGTH);
}

let cached = null;

function getVersionInfo(publicDir) {
    if (!cached) {
        cached = {
            version: require('../../package.json').version,
            build: computeBuildId(publicDir),
        };
    }
    return cached;
}

const BUILD_META_NAME = 'vc-build';

/**
 * 把 build id 烤进页面 <head>。
 *
 * 页面第一次 /api/version 的响应并不能证明它运行的是什么：部署可能落在
 * 页面加载与该调用之间，若把更新后的 id 当作「自己的」，更新提示就会
 * 永远被静默掩盖。把 id 写进 HTML 后，
 * 每个页面都能确切知道自己启动于哪个 build。
 */
function injectBuildMeta(html, build) {
    const meta = `<meta name="${BUILD_META_NAME}" content="${build}" />`;
    const existing = new RegExp(`<meta\\s+name=["']${BUILD_META_NAME}["'][^>]*>`, 'i');
    if (existing.test(html)) return html.replace(existing, meta);
    return html.replace(/<head([^>]*)>/i, `<head$1>\n        ${meta}`);
}

module.exports = { computeBuildId, getVersionInfo, injectBuildMeta, BUILD_META_NAME };
