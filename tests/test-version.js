'use strict';

// npx mocha test-version.js

require('should');

const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const { computeBuildId, getVersionInfo } = require('../app/src/version');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

describe('test-version', () => {
    describe('0. computeBuildId', () => {
        let dir;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-version-'));
            fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(1)');
        });

        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('should return a 12-char hex id', () => {
            computeBuildId(dir).should.match(/^[0-9a-f]{12}$/);
        });

        it('should be stable for unchanged content', () => {
            const first = computeBuildId(dir);
            computeBuildId(dir).should.equal(first);
        });

        it('should ignore mtime-only changes', () => {
            const first = computeBuildId(dir);
            const future = new Date(Date.now() + 10_000);
            fs.utimesSync(path.join(dir, 'a.js'), future, future);
            computeBuildId(dir).should.equal(first);
        });

        it('should change when file content changes', () => {
            const first = computeBuildId(dir);
            fs.writeFileSync(path.join(dir, 'a.js'), 'console.log(2)');
            computeBuildId(dir).should.not.equal(first);
        });

        it('should change when a file is added in a subdirectory', () => {
            const first = computeBuildId(dir);
            fs.mkdirSync(path.join(dir, 'sub'));
            fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'x');
            computeBuildId(dir).should.not.equal(first);
        });
    });

    describe('1. getVersionInfo', () => {
        it('should expose the package.json version', () => {
            getVersionInfo(PUBLIC_DIR).version.should.equal(pkg.version);
        });

        it('should expose a 12-char build id for public/', () => {
            getVersionInfo(PUBLIC_DIR).build.should.match(/^[0-9a-f]{12}$/);
        });

        it('should memoize the info object', () => {
            getVersionInfo(PUBLIC_DIR).should.equal(getVersionInfo(PUBLIC_DIR));
        });
    });
});
