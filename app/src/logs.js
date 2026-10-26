'use strict';

const util = require('util');

const LOGS_DEBUG = process.env.LOGS_DEBUG ? process.env.LOGS_DEBUG === 'true' : false;
const LOGS_COLORS = process.env.LOGS_COLORS ? process.env.LOGS_COLORS === 'true' : true;
const LOGS_JSON = process.env.LOGS_JSON ? process.env.LOGS_JSON === 'true' : false;
const LOGS_JSON_PRETTY = process.env.LOGS_JSON_PRETTY ? process.env.LOGS_JSON_PRETTY === 'true' : false;

// Replaces the colors dependency: output is byte-identical (same SGR open code
// + \x1b[39m default-fg close as colors@1.4); LOGS_COLORS=false makes the
// wrappers identity functions, matching colors.disable().
const ansi = (code) => (text) => (LOGS_COLORS ? `\x1b[${code}m${text}\x1b[39m` : String(text));
const yellow = ansi(33);
const green = ansi(32);
const red = ansi(31);
const magenta = ansi(35);
const cyan = ansi(36);

const options = {
    depth: null,
    colors: LOGS_COLORS,
};
module.exports = class Logs {
    constructor(appName = 'miroTalkP2P') {
        this.appName = appName;
        this.debugOn = LOGS_DEBUG;
        this.timeStart = Date.now();
        this.timeEnd = null;
        this.timeElapsedMs = null;
        this.tzOptions = {
            timeZone: process.env.TZ || 'UTC',
            hour12: false,
        };
    }

    jsonLog(level, appName, msg, op, extra = {}) {
        const logObj = {
            timestamp: new Date().toISOString(),
            level,
            app: appName,
            message: msg,
            ...extra,
        };
        if (op && typeof op === 'object' && Object.keys(op).length > 0) {
            logObj.data = op;
        }

        // Output pretty JSON if LOGS_JSON_PRETTY is set, else compact one line JSON
        LOGS_JSON_PRETTY ? console.log(JSON.stringify(logObj, null, 2)) : console.log(JSON.stringify(logObj));
    }

    debug(msg, op = '') {
        if (!this.debugOn) return;
        this.timeEnd = Date.now();
        this.timeElapsedMs = this.getFormatTime(Math.floor(this.timeEnd - this.timeStart));
        if (LOGS_JSON) {
            this.jsonLog('debug', this.appName, msg, op, { elapsed: this.timeElapsedMs });
        } else {
            console.debug(
                '[' + this.getDateTime() + '] [' + yellow(this.appName) + '] ' + msg,
                util.inspect(op, options),
                magenta(this.timeElapsedMs)
            );
        }
        this.timeStart = Date.now();
    }

    log(msg, op = '') {
        if (LOGS_JSON) {
            this.jsonLog('log', this.appName, msg, op);
        } else {
            console.log(
                '[' + this.getDateTime() + '] [' + yellow(this.appName) + '] ' + msg,
                util.inspect(op, options)
            );
        }
    }

    info(msg, op = '') {
        if (LOGS_JSON) {
            this.jsonLog('info', this.appName, msg, op);
        } else {
            console.info(
                '[' + this.getDateTime() + '] [' + yellow(this.appName) + '] ' + green(msg),
                util.inspect(op, options)
            );
        }
    }

    warn(msg, op = '') {
        if (LOGS_JSON) {
            this.jsonLog('warn', this.appName, msg, op);
        } else {
            console.warn(
                '[' + this.getDateTime() + '] [' + yellow(this.appName) + '] ' + yellow(msg),
                util.inspect(op, options)
            );
        }
    }

    error(msg, op = '') {
        if (LOGS_JSON) {
            this.jsonLog('error', this.appName, msg, op);
        } else {
            console.error(
                '[' + this.getDateTime() + '] [' + yellow(this.appName) + '] ' + red(msg),
                util.inspect(op, options)
            );
        }
    }

    getDateTime(color = true) {
        const now = new Date();
        const currentTime = now.toLocaleString('en-US', this.tzOptions);
        const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
        const timestamp = `${currentTime}:${milliseconds}`;
        return color ? cyan(timestamp) : timestamp;
    }

    getFormatTime(ms) {
        let time = Math.floor(ms);
        let type = 'ms';
        if (ms >= 1000) {
            time = Math.floor((ms / 1000) % 60);
            type = 's';
        }
        if (ms >= 60000) {
            time = Math.floor((ms / 1000 / 60) % 60);
            type = 'm';
        }
        if (ms >= 3.6e6) {
            time = Math.floor((ms / 1000 / 60 / 60) % 24);
            type = 'h';
        }
        return '+' + time + type;
    }
};
