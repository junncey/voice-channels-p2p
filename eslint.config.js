'use strict';

/**
 * ESLint flat config——只做静态检查，格式化交给 Prettier。
 * 本仓库并存两个世界：服务器端 CommonJS（app/src、tests、scripts）
 * 与浏览器端原生 ES modules（public/js，无构建步骤）。
 */

const js = require('@eslint/js');
const globals = require('globals');

// 共享规则集：recommended + 严格的未用变量检查（死导出与残留物正是本
// 配置存在之前悄悄混进来的东西）+ 文件行数预算，
// 防止代码库重新长出千行巨石文件
// （样式表经 scripts/check-file-size.js 执行同一预算）
const rules = {
    ...js.configs.recommended.rules,
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'max-lines': ['error', { max: 1000, skipBlankLines: false, skipComments: false }],
};

module.exports = [
    {
        ignores: [
            'node_modules/',
            // 本地运行时数据，不是代码
            'app/src/chat_history/',
            'app/src/backups/',
            'app/src/channels.json*',
            'app/src/audit.jsonl*',
        ],
    },
    {
        files: ['app/src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', '*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.mocha,
                should: 'readonly', // should.js 导出的全局断言助手
            },
        },
        rules,
    },
    {
        files: ['public/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                io: 'readonly', // socket.io 客户端，来自 <script src="/socket.io/socket.io.js">
            },
        },
        rules,
    },
];
