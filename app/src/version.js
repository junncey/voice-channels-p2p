'use strict';

/*
 * Frontend version info served to pages via GET /api/version.
 *
 * `build` is a fingerprint of every file under public/ (relative path +
 * content), so any frontend change is detected without bumping the
 * package.json version by hand — and backend-only deploys never mark
 * already-open pages as stale.
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
 * Bake the build id into a page's <head>.
 *
 * A page's FIRST /api/version response is not proof of what it is running: a
 * deploy can land between the page load and that call, and treating the newer
 * id as "mine" would silently hide the update forever. With the id in the HTML
 * every page knows exactly which build it booted with.
 */
function injectBuildMeta(html, build) {
    const meta = `<meta name="${BUILD_META_NAME}" content="${build}" />`;
    const existing = new RegExp(`<meta\\s+name=["']${BUILD_META_NAME}["'][^>]*>`, 'i');
    if (existing.test(html)) return html.replace(existing, meta);
    return html.replace(/<head([^>]*)>/i, `<head$1>\n        ${meta}`);
}

module.exports = { computeBuildId, getVersionInfo, injectBuildMeta, BUILD_META_NAME };
