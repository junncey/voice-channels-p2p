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

module.exports = { computeBuildId, getVersionInfo };
