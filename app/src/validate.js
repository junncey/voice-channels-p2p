'use strict';

const path = require('path');

const checkXSS = require('./xss.js');

function isValidRoomName(input) {
    if (!input || typeof input !== 'string') {
        return false;
    }
    const room = checkXSS(input);
    return !room ? false : !hasPathTraversal(room);
}

function hasPathTraversal(input) {
    if (!input || typeof input !== 'string') {
        return false;
    }

    let decodedInput = input;
    try {
        decodedInput = decodeURIComponent(input);
        decodedInput = decodeURIComponent(decodedInput);
    } catch (err) {
        /* 百分号编码畸形——改为分析原始输入 */
    }

    const pathTraversalPattern = /(\.\.(\/|\\))+/;
    const excessiveDotsPattern = /(\.{4,}\/+|\.{4,}\\+)/;
    const complexTraversalPattern = /(\.{2,}(\/+|\\+))/;

    if (complexTraversalPattern.test(decodedInput)) {
        return true;
    }

    const normalizedPath = path.normalize(decodedInput);

    if (pathTraversalPattern.test(normalizedPath) || excessiveDotsPattern.test(normalizedPath)) {
        return true;
    }

    return false;
}

function isValidData(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    return Object.keys(data).length > 0;
}

// 标准 8-4-4-4-12 十六进制 uuid（任意版本）——房间 peer 表所用的会话键。
// 刻意采用严格形状：该值会成为对象键，
// 因此绝不能与房间元键
// （'lock'/'password'/'joinLock'）或 '__proto__' 发生碰撞。
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionUuid(input) {
    return typeof input === 'string' && SESSION_UUID_RE.test(input);
}

module.exports = {
    isValidRoomName,
    hasPathTraversal,
    isValidData,
    isValidSessionUuid,
};
