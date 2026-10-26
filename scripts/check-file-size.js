'use strict';

/**
 * CSS file-size budget — the stylesheet counterpart of ESLint's max-lines
 * rule for JS (see eslint.config.js): every .css file under public/css must
 * stay under MAX_LINES lines. Enforced by `npm run lint` (CI runs the same).
 *
 * Zero dependencies on purpose: walk the css dir, count lines, exit 1 with
 * the offenders listed when any file is over budget.
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
