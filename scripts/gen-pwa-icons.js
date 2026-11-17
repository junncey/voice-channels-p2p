'use strict';

/**
 * PWA 图标生成器（无图像依赖）：直接经 zlib 把应用图形——深色品牌圆角
 * 方块上、声波弧线环抱的绿色麦克胶囊——渲染成 PNG 文件。
 * 重新生成：
 *   node scripts/gen-pwa-icons.js
 * 输出：public/images/icon-192.png、icon-512.png、icon-maskable-512.png。
 * 渲染器与 PNG 编码同时导出，供 scripts/gen-helper-ico.js 生成 exe 图标。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [19, 26, 35, 255]; // #131a23
const ACCENT = [61, 220, 151, 255]; // #3ddc97

/** 到胶囊（圆头线段）p1→p2、半径 r 的有符号距离。 */
function distCapsule(px, py, x1, y1, x2, y2, r) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy) - r;
}

/** 到画布中心圆角矩形的有符号距离。 */
function distRoundedRect(px, py, size, inset, radius) {
    const half = size / 2 - inset;
    const qx = Math.abs(px - size / 2) - (half - radius);
    const qy = Math.abs(py - size / 2) - (half - radius);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 由有符号距离（像素）得出的 1px 平滑覆盖率。 */
function cover(d) {
    return Math.max(0, Math.min(1, 0.5 - d));
}

function mix(base, over, alpha) {
    return [
        Math.round(base[0] + (over[0] - base[0]) * alpha),
        Math.round(base[1] + (over[1] - base[1]) * alpha),
        Math.round(base[2] + (over[2] - base[2]) * alpha),
        Math.round(base[3] + (over[3] - base[3]) * alpha),
    ];
}

function renderIcon(size, { maskable = false } = {}) {
    const s = (frac) => frac * size;
    const scale = maskable ? 0.78 : 1; // maskable：图形收进 80% 安全区内
    const rows = [];
    for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            let pixel = [0, 0, 0, 0];
            // 背景：maskable 用满幅方块，其余用圆角方块
            const bgAlpha = maskable ? 1 : cover(distRoundedRect(px, py, size, 2, size * 0.22));
            if (bgAlpha > 0) pixel = mix(pixel, BG, bgAlpha);
            // 图形：麦克胶囊 + 声波弧 + 支架，全部用强调色
            const cx = size / 2;
            const cy = s(0.4) * scale + (size * (1 - scale)) / 2;
            const dMic = distCapsule(px, py, cx, cy, cx, cy, s(0.085) * scale);
            const arcR = s(0.185) * scale;
            const dyn = (py - cy) / Math.max(arcR, 1e-6);
            const dArc = Math.abs(Math.hypot(px - cx, py - cy) - arcR) - s(0.018) * scale;
            const arcPenalty = dyn < -0.15 ? Math.abs(dyn + 0.15) * arcR + 10 : 0;
            const standTop = cy + arcR * 0.92;
            const dStandSeg = distCapsule(px, py, cx, standTop, cx, standTop + s(0.075) * scale, s(0.016) * scale);
            const dBase = distCapsule(
                px,
                py,
                cx - s(0.1) * scale,
                standTop + s(0.075) * scale,
                cx + s(0.1) * scale,
                standTop + s(0.075) * scale,
                s(0.016) * scale
            );
            const glyph = Math.min(dMic, dArc + arcPenalty, dStandSeg, dBase);
            const gAlpha = cover(glyph);
            if (gAlpha > 0 && bgAlpha > 0.5) pixel = mix(pixel, ACCENT, gAlpha);
            row.push(pixel);
        }
        rows.push(row);
    }
    return rows;
}

/** 把 RGBA 行编码为 PNG 缓冲（color type 6，无滤波）。 */
function encodePng(rows) {
    const height = rows.length;
    const width = rows[0].length;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    let at = 0;
    for (let y = 0; y < height; y++) {
        raw[at++] = 0; // 滤波：无
        for (const [r, g, b, a] of rows[y]) {
            raw[at++] = r;
            raw[at++] = g;
            raw[at++] = b;
            raw[at++] = a;
        }
    }
    const idat = zlib.deflateSync(raw, { level: 9 });
    const chunk = (type, data) => {
        const out = Buffer.alloc(8 + data.length + 4);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'ascii');
        data.copy(out, 8);
        out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // 位深
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// 极简 CRC32（PNG 多项式），查表实现
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const outDir = path.join(__dirname, '..', 'public', 'images');
if (require.main === module) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, size, opts] of [
        ['icon-192.png', 192, {}],
        ['icon-512.png', 512, {}],
        ['icon-maskable-512.png', 512, { maskable: true }],
    ]) {
        fs.writeFileSync(path.join(outDir, name), encodePng(renderIcon(size, opts)));
        console.log('wrote', path.join(outDir, name));
    }
}

module.exports = { renderIcon, encodePng };
