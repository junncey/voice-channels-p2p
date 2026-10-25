'use strict';

// npx mocha test-logs.js
//
// Regression: log() called bare jsonLog(...) instead of this.jsonLog(...) —
// with LOGS_JSON=true every log() call threw a ReferenceError. The flag is
// read at module load, so the module is re-required under a pinned env.

require('should');

const LOGS_PATH = require.resolve('../app/src/logs');

describe('test-logs (JSON logging)', () => {
    after(() => {
        // leave the shared module cache in the pre-test state for other suites
        delete require.cache[LOGS_PATH];
        require(LOGS_PATH);
    });

    it('should emit valid JSON from log() with LOGS_JSON=true (missing this. regression)', () => {
        const prev = process.env.LOGS_JSON;
        process.env.LOGS_JSON = 'true';
        try {
            delete require.cache[LOGS_PATH];
            const FreshLogs = require(LOGS_PATH);
            const logs = new FreshLogs('test');

            const lines = [];
            const origLog = console.log;
            console.log = (line) => lines.push(line);
            try {
                logs.log('hello json', { code: 7 });
            } finally {
                console.log = origLog;
            }

            lines.should.have.length(1);
            const parsed = JSON.parse(lines[0]);
            parsed.level.should.equal('log');
            parsed.app.should.equal('test');
            parsed.message.should.equal('hello json');
            parsed.data.should.eql({ code: 7 });
        } finally {
            if (prev === undefined) delete process.env.LOGS_JSON;
            else process.env.LOGS_JSON = prev;
            delete require.cache[LOGS_PATH];
            require(LOGS_PATH);
        }
    });

    it('should cover the other levels under LOGS_JSON as well', () => {
        const prev = process.env.LOGS_JSON;
        const prevDebug = process.env.LOGS_DEBUG;
        process.env.LOGS_JSON = 'true';
        process.env.LOGS_DEBUG = 'true'; // debug() is gated on the flag
        try {
            delete require.cache[LOGS_PATH];
            const FreshLogs = require(LOGS_PATH);
            const logs = new FreshLogs('test');
            // jsonLog funnels EVERY level through console.log
            const lines = [];
            const origLog = console.log;
            console.log = (line) => lines.push(line);
            try {
                logs.debug('d');
                logs.info('i');
                logs.warn('w');
                logs.error('e');
            } finally {
                console.log = origLog;
            }
            lines.should.have.length(4);
            const seen = lines.map((line) => JSON.parse(line).level);
            seen.should.eql(['debug', 'info', 'warn', 'error']);
        } finally {
            if (prev === undefined) delete process.env.LOGS_JSON;
            else process.env.LOGS_JSON = prev;
            if (prevDebug === undefined) delete process.env.LOGS_DEBUG;
            else process.env.LOGS_DEBUG = prevDebug;
            delete require.cache[LOGS_PATH];
            require(LOGS_PATH);
        }
    });
});
