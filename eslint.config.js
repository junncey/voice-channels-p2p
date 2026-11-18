'use strict';

/**
 * ESLint flat config——只做静态检查，格式化交给 Prettier。
 * 本仓库并存两个世界：服务器端 CommonJS（app/src、tests、scripts）
 * 与浏览器端原生 ES modules（public/js，无构建步骤）。
 */

const js = require('@eslint/js');
const globals = require('globals');

// 共享规则集：recommended + 严格的未用变量检查（死导出与残留物正是本
// 配置存在之前悄悄混进来的东西）+ 文件行数预算。
// 预算按**纯代码行**计（注释与空行不数——本库的注释密度
// 是核心资产，不该被计税）。1200 代码行按 26-40% 的实测注释
// 密度约合 1700 实际行，明显宽于旧的 1000 总行口径
// （旧口径下 ~700 代码行即触顶）。样式表走
// scripts/check-file-size.js 的原始行预算（CSS 注释稀少，
// 原始行≈代码行）。
// 另有几条零噪音的防回归规则：松散相等只在刻意处出现
// （smart 允许 == null 探测）、不再新增 var、隐式全局在无构建的
// 浏览器模块里最危险（写错变量名不报错、直接污染 window）
const rules = {
    ...js.configs.recommended.rules,
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    'max-lines': ['error', { max: 1200, skipBlankLines: true, skipComments: true }],
    eqeqeq: ['error', 'smart'],
    'prefer-const': 'error',
    'no-var': 'error',
    'no-implicit-globals': 'error',
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
    {
        // service worker：经典脚本（非 module），此前不匹配任何
        // files 块、游离在全部规则之外——规则真空补上
        files: ['public/sw.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: {
                ...globals.serviceworker,
                ...globals.browser,
            },
        },
        rules,
    },
];
