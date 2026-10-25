'use strict';

/**
 * ESLint flat config — static checks only, formatting stays with Prettier.
 * Two worlds share this repo: CommonJS on the server (app/src, tests,
 * scripts) and native ES modules in the browser (public/js, no build step).
 */

const js = require('@eslint/js');
const globals = require('globals');

// shared rule set: recommended + a strict unused check (dead exports and
// leftovers are exactly what crept in before this config existed)
const rules = {
    ...js.configs.recommended.rules,
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
};

module.exports = [
    {
        ignores: [
            'node_modules/',
            // local runtime data, not code
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
                should: 'readonly', // should.js exports a global assertion helper
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
                io: 'readonly', // socket.io client from <script src="/socket.io/socket.io.js">
            },
        },
        rules,
    },
];
