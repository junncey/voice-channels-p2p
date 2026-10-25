'use strict';

// npx mocha test-i18n.js
//
// zh/en dictionary parity: a key that exists in only one language silently
// falls back to the raw key on screen (i18n.js t()), and a missing
// {placeholder} renders literally — both are regressions no other test sees.

require('should');

const fs = require('fs');
const path = require('path');

const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'lang', 'zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'lang', 'en.json'), 'utf8'));

/** Sorted placeholder names of a template string: "hi {name}" -> "name" */
function placeholders(value) {
    return [...String(value).matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(',');
}

describe('test-i18n (dictionary parity)', () => {
    it('should define the exact same key set in zh and en', () => {
        const zhKeys = Object.keys(zh).sort();
        const enKeys = Object.keys(en).sort();
        zhKeys.should.eql(enKeys);
    });

    it('should have non-empty values for every key in both languages', () => {
        for (const [key, value] of Object.entries(zh)) {
            String(value).trim().should.not.be.empty(`zh.${key}`);
        }
        for (const [key, value] of Object.entries(en)) {
            String(value).trim().should.not.be.empty(`en.${key}`);
        }
    });

    it('should use the same {placeholders} in both languages per key', () => {
        for (const key of Object.keys(zh)) {
            placeholders(zh[key]).should.equal(placeholders(en[key]), `placeholder mismatch at ${key}`);
        }
    });
});
