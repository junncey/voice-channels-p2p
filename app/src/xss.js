'use strict';

const { JSDOM } = require('jsdom');
const DOMPurify = require('dompurify');
const he = require('he');

// 用 jsdom 初始化 DOMPurify
const window = new JSDOM('').window;
const purify = DOMPurify(window);

const Logger = require('./logs');
const log = new Logger('Xss');

// 配置 DOMPurify
purify.setConfig({
    ALLOWED_TAGS: ['a', 'img', 'div', 'span', 'svg', 'g', 'p'], // 仅允许特定标签
    ALLOWED_ATTR: ['href', 'src', 'title', 'id', 'class', 'target', 'width', 'height'], // 仅允许特定属性
    ALLOWED_URI_REGEXP: /^(?!\s*(?:data|javascript|vbscript|file|view-source)\s*:)/i, // 禁止危险 URI（不区分大小写，忽略前导空白）
});

// 清理有问题的属性
function cleanAttributes(node) {
    if (node.nodeType === window.Node.ELEMENT_NODE) {
        // 移除危险属性
        const dangerousAttributes = ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onchange', 'oninput'];
        dangerousAttributes.forEach((attr) => {
            if (node.hasAttribute(attr)) {
                node.removeAttribute(attr);
            }
        });

        // 处理 'data:' URI 的特殊情况
        const src = node.getAttribute('src');
        if (src && src.startsWith('data:')) {
            node.removeAttribute('src');
        }

        // 移除不安全的 'style' 属性
        if (node.hasAttribute('style')) {
            const style = node.getAttribute('style');
            if (style.includes('javascript:') || style.includes('data:')) {
                node.removeAttribute('style');
            }
        }

        // 'title' 属性含危险内容时移除
        if (node.hasAttribute('title')) {
            const title = node.getAttribute('title');
            if (title.includes('javascript:') || title.includes('data:') || title.includes('onerror')) {
                node.removeAttribute('title');
            }
        }
    }
}

// 挂钩清理可能引发 XSS 的特定属性
purify.addHook('beforeSanitizeAttributes', cleanAttributes);

// 检查并清洗数据的主函数
const checkXSS = (dataObject) => {
    try {
        return sanitizeData(dataObject);
    } catch (error) {
        log.error('Sanitization error:', error);
        return null; // fail closed：无法清洗的数据绝不放行
    }
};

function needsDecoding(str) {
    const urlEncodedPattern = /%[0-9A-Fa-f]{2}/g;
    return urlEncodedPattern.test(str);
}

function safeDecodeURIComponent(str) {
    try {
        return decodeURIComponent(str);
    } catch (e) {
        log.error('Malformed URI component detected:', str);
        return str; // 解码失败时返回原字符串
    }
}

function sanitizeData(data) {
    if (typeof data === 'string') {
        // 解码 HTML 实体与 URL 编码内容
        const decodedData = needsDecoding(data) ? he.decode(safeDecodeURIComponent(data)) : he.decode(data);
        return purify.sanitize(decodedData);
    }

    if (Array.isArray(data)) {
        return data.map(sanitizeData);
    }

    if (data && typeof data === 'object') {
        return sanitizeObject(data);
    }

    return data; // 数字、布尔、null、undefined 直接返回
}

// 清洗对象属性
function sanitizeObject(obj) {
    return Object.keys(obj).reduce((acc, key) => {
        acc[key] = sanitizeData(obj[key]);
        return acc;
    }, {});
}

module.exports = checkXSS;
