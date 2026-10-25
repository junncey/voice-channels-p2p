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
        /* malformed percent-encoding — analyze the raw input instead */
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

// Standard 8-4-4-4-12 hex uuid (any version) — the session key a room's peer
// map is keyed by. Strict shape on purpose: the value becomes an object key,
// so it must never be able to collide with the room meta keys
// ('lock'/'password'/'joinLock') or with '__proto__'.
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
