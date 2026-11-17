'use strict';

/**
 * 一次性 exe 图标生成器（无图像依赖）：复用 gen-pwa-icons 的品牌渲染器，
 * 以 16~256px 多尺寸生成 Windows ICO（≤128px 为 32bpp BMP 条目、256 为
 * PNG 条目），供 helper/app-audio-bridge 经 winresource 嵌进 exe 资源。
 * 重新生成（改品牌图形后）：
 *   node scripts/gen-helper-ico.js
 * 输出：helper/app-audio-bridge/assets/icon.ico。
 */

const fs = require('fs');
const path = require('path');
const { renderIcon, encodePng } = require('./gen-pwa-icons');

/** 单尺寸 32bpp BMP 条目（bottom-up BGRA + 全零 AND 掩码，透明交给 alpha）。 */
function encodeBmpEntry(rows) {
    const h = rows.length;
    const w = rows[0].length;
    const maskRow = Math.ceil(w / 32) * 4; // 1bpp 掩码行按 4 字节对齐
    const dataSize = h * w * 4 + h * maskRow;
    const out = Buffer.alloc(40 + dataSize); // BITMAPINFOHEADER + 像素 + 掩码
    out.writeUInt32LE(40, 0); // biSize
    out.writeInt32LE(w, 4);
    out.writeInt32LE(h * 2, 8); // 高度翻倍：像素区 + AND 掩码区
    out.writeUInt16LE(1, 12); // planes
    out.writeUInt16LE(32, 14); // bit count
    out.writeUInt32LE(0, 16); // BI_RGB
    out.writeUInt32LE(dataSize, 20);
    let at = 40;
    for (let y = h - 1; y >= 0; y--) {
        for (const [r, g, b, a] of rows[y]) {
            out[at++] = b;
            out[at++] = g;
            out[at++] = r;
            out[at++] = a;
        }
    }
    // AND 掩码保持全 0：透明度由 alpha 字节承担（Buffer.alloc 已置零）
    return out;
}

/** 组装 ICO 容器：ICONDIR + 每条目 ICONDIRENTRY + 图像数据。 */
function buildIco(sizes) {
    const entries = sizes.map((size) => ({
        size,
        data: size <= 128 ? encodeBmpEntry(renderIcon(size)) : encodePng(renderIcon(size)),
    }));
    const headerSize = 6 + entries.length * 16;
    const total = headerSize + entries.reduce((sum, e) => sum + e.data.length, 0);
    const ico = Buffer.alloc(total);
    ico.writeUInt16LE(1, 2); // type: icon
    ico.writeUInt16LE(entries.length, 4);
    let offset = headerSize;
    entries.forEach((entry, i) => {
        const at = 6 + i * 16;
        ico[at] = entry.size >= 256 ? 0 : entry.size; // 256 记 0
        ico[at + 1] = ico[at];
        ico.writeUInt16LE(1, at + 4); // planes
        ico.writeUInt16LE(32, at + 6); // bit count
        ico.writeUInt32LE(entry.data.length, at + 8);
        ico.writeUInt32LE(offset, at + 12);
        entry.data.copy(ico, offset);
        offset += entry.data.length;
    });
    return ico;
}

const out = path.join(__dirname, '..', 'helper', 'app-audio-bridge', 'assets', 'icon.ico');
fs.writeFileSync(out, buildIco([16, 24, 32, 48, 64, 128, 256]));
console.log('wrote', out, fs.statSync(out).size, 'bytes');
