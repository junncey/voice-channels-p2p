'use strict';

// npx mocha test-i18n.js
//
// zh/en 词典对齐：只存在于单一语言的键会在界面上静默回退成原始键名
// （i18n.js 的 t()），缺失的 {placeholder} 会原样渲染——这两种回归
// 其他测试都覆盖不到。

require('should');

const fs = require('fs');
const path = require('path');

const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'lang', 'zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'lang', 'en.json'), 'utf8'));

/** 取模板字符串中占位符名的排序列表："hi {name}" -> "name" */
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

    // 仅靠对齐检查抓不到两个词典同时缺失的键——缺了它们 PTT 按键绑定
    // UI 和 keyLabel() 会静默降级
    it('should carry the PTT binding and key-label entries in both dictionaries', () => {
        for (const key of [
            'settings.pttKey',
            'settings.pttKeyRecord',
            'settings.pttKeyInvalid',
            'settings.pushToTalkHint',
            'channel.pttOn',
            'key.space',
            'key.tab',
            'key.capsLock',
            'key.backquote',
            'key.enter',
            'key.numpadEnter',
            'key.numpad',
        ]) {
            should.exist(zh[key], `zh is missing ${key}`);
            should.exist(en[key], `en is missing ${key}`);
        }
    });
});
