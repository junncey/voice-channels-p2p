'use strict';

/**
 * One-shot PWA icon generator (no image dependencies): renders the app glyph
 * — a green mic capsule inside its sound arc on the dark brand rounded
 * square — straight into PNG files via zlib. Rerun with:
 *   node scripts/gen-pwa-icons.js
 * Outputs: public/images/icon-192.png, icon-512.png, icon-maskable-512.png.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [19, 26, 35, 255]; // #131a23
const ACCENT = [61, 220, 151, 255]; // #3ddc97

/** Signed distance to a capsule (rounded line) from p1 to p2 with radius r. */
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

/** Signed distance to a ring segment (lower arc around cx,cy). */
function distArc(px, py, cx, cy, radius, width, minY) {
    const d = Math.hypot(px - cx, py - cy);
    const ring = Math.abs(d - radius) - width;
    if (py < minY) {
        // outside the angular span: distance to the nearest arc endpoint
        const end = Math.sqrt(Math.max(0, (minY - cy) * (minY - cy) - 0)); // horizontal chord at minY
        return Math.max(ring, Math.abs(py - minY) + 1e9 * 0 + Math.max(0, d - Math.hypot(end, minY - cy)));
    }
    return ring;
}

/** Signed distance to a rounded rectangle centered in the canvas. */
function distRoundedRect(px, py, size, inset, radius) {
    const half = size / 2 - inset;
    const qx = Math.abs(px - size / 2) - (half - radius);
    const qy = Math.abs(py - size / 2) - (half - radius);
    const ox = Math.max(qx, 0);
    const oy = Math.max(qy, 0);
    return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 1px-smoothed coverage from a signed distance (in pixels). */
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
    const scale = maskable ? 0.78 : 1; // maskable: keep the glyph inside the 80% safe zone
    const rows = [];
    for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            let pixel = [0, 0, 0, 0];
            // background: full square for maskable, rounded square otherwise
            const bgAlpha = maskable ? 1 : cover(distRoundedRect(px, py, size, 2, size * 0.22));
            if (bgAlpha > 0) pixel = mix(pixel, BG, bgAlpha);
            // glyph: mic capsule + sound arc + stand, all accent colored
            const cx = size / 2;
            const cy = s(0.4) * scale + (size * (1 - scale)) / 2;
            const dMic = distCapsule(px, py, cx, cy, cx, cy, s(0.085) * scale);
            const arcR = s(0.185) * scale;
            const arcTop = cy + s(0.02) * scale; // arc spans the lower ~70% around the mic
            const dxn = (px - cx) / Math.max(arcR, 1e-6);
            const dyn = (py - cy) / Math.max(arcR, 1e-6);
            const inArcSpan = dyn > -0.15 && Math.hypot(dxn, dyn) > 0.99; // rough lower arc
            const dArc = Math.abs(Math.hypot(px - cx, py - cy) - arcR) - s(0.018) * scale;
            const arcPenalty = dyn < -0.15 ? Math.abs(dyn + 0.15) * arcR + 10 : 0;
            const dStand =
                Math.abs(px - cx) -
                s(0.016) * scale +
                Math.max(0, py - s(0.615) * scale - (size * (1 - scale)) / 2, 0) * 0; // vertical stand
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

/** Encode RGBA rows into a PNG buffer (color type 6, no filtering). */
function encodePng(rows) {
    const height = rows.length;
    const width = rows[0].length;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    let at = 0;
    for (let y = 0; y < height; y++) {
        raw[at++] = 0; // filter: none
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
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// minimal CRC32 (PNG polynomial), table-based
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
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size, opts] of [
    ['icon-192.png', 192, {}],
    ['icon-512.png', 512, {}],
    ['icon-maskable-512.png', 512, { maskable: true }],
]) {
    fs.writeFileSync(path.join(outDir, name), encodePng(renderIcon(size, opts)));
    console.log('wrote', path.join(outDir, name));
}
