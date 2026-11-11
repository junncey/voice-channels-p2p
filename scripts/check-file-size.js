'use strict';

/**
 * CSS 文件行数预算——JS 侧 ESLint max-lines 规则（见 eslint.config.js）
 * 的样式表对应物：public/css 下每个 .css 文件都必须低于 MAX_LINES 行。
 * 由 `npm run lint` 强制执行（CI 跑的是同一命令）。
 *
 * 刻意零依赖：遍历 css 目录、数行数，任何文件超预算就列出违规项并以
 * 退出码 1 结束。
 */

const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'public', 'css');
const MAX_LINES = 1000;

const files = fs
    .readdirSync(CSS_DIR)
    .filter((name) => name.endsWith('.css'))
    .sort();

const offenders = [];
for (const name of files) {
    const content = fs.readFileSync(path.join(CSS_DIR, name), 'utf8');
    const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
    if (lines > MAX_LINES) offenders.push(`  ${name}: ${lines} lines (max ${MAX_LINES})`);
}

if (offenders.length) {
    console.error(`CSS size budget exceeded (max ${MAX_LINES} lines per file):`);
    for (const line of offenders) console.error(line);
    console.error('Split the file by section — keep the cascade order via the <link> order in the HTML.');
    process.exit(1);
}

console.log(`CSS size budget OK: ${files.length} file(s) within ${MAX_LINES} lines`);
