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

describe('test-logs (ANSI color switch, colors-dependency replacement)', () => {
    // LOGS_COLORS is read at module load; re-require under a pinned env (same
    // pattern as the JSON suite above).
    const capture = (FreshLogs, method, msg) => {
        const logs = new FreshLogs('test');
        const args = [];
        const sink = { log: console.log, info: console.info, warn: console.warn, error: console.error };
        console.log = console.info = console.warn = console.error = (...a) => args.push(a);
        try {
            logs[method](msg);
        } finally {
            console.log = sink.log;
            console.info = sink.info;
            console.warn = sink.warn;
            console.error = sink.error;
        }
        return String(args[0][0]);
    };

    after(() => {
        delete require.cache[LOGS_PATH];
        require(LOGS_PATH);
    });

    it('should emit no ANSI escapes with LOGS_COLORS=false', () => {
        const prev = process.env.LOGS_COLORS;
        const prevJson = process.env.LOGS_JSON;
        process.env.LOGS_COLORS = 'false';
        process.env.LOGS_JSON = 'false';
        try {
            delete require.cache[LOGS_PATH];
            const line = capture(require(LOGS_PATH), 'error', 'boom');
            line.should.not.containEql('\x1b');
            line.should.containEql('boom');
        } finally {
            if (prev === undefined) delete process.env.LOGS_COLORS;
            else process.env.LOGS_COLORS = prev;
            if (prevJson === undefined) delete process.env.LOGS_JSON;
            else process.env.LOGS_JSON = prevJson;
            delete require.cache[LOGS_PATH];
            require(LOGS_PATH);
        }
    });

    it('should color output byte-identically to colors@1.4 with LOGS_COLORS=true', () => {
        const prev = process.env.LOGS_COLORS;
        const prevJson = process.env.LOGS_JSON;
        process.env.LOGS_COLORS = 'true';
        process.env.LOGS_JSON = 'false';
        try {
            delete require.cache[LOGS_PATH];
            const FreshLogs = require(LOGS_PATH);
            const line = capture(FreshLogs, 'error', 'boom');
            // app name yellow, message red; colors@1.4 closes fg with \x1b[39m
            line.should.containEql('\x1b[33mtest\x1b[39m');
            line.should.containEql('\x1b[31mboom\x1b[39m');
            const info = capture(FreshLogs, 'info', 'ok');
            info.should.containEql('\x1b[32mok\x1b[39m');
        } finally {
            if (prev === undefined) delete process.env.LOGS_COLORS;
            else process.env.LOGS_COLORS = prev;
            if (prevJson === undefined) delete process.env.LOGS_JSON;
            else process.env.LOGS_JSON = prevJson;
            delete require.cache[LOGS_PATH];
            require(LOGS_PATH);
        }
    });
});
