'use strict';

/**
 * Render HTML template with provided data
 * @param {string} templateId - ID of the <template> element
 * @param {object} data - Data to populate the template
 * @param {object} data.text - Key-value pairs for text content (data-template-text)
 * @param {object} data.html - Key-value pairs for HTML content (data-template-html
 * @param {object} data.attrs - Key-value pairs for attributes (data-template-attr-*)
 * @returns {string} Rendered HTML string
 */
function renderRoomTemplate(templateId, { text = {}, html = {}, attrs = {} } = {}) {
    const template = document.getElementById(templateId);
    if (!template || !template.content) return '';

    const wrapper = document.createElement('div');
    wrapper.appendChild(template.content.cloneNode(true));

    wrapper.querySelectorAll('*').forEach((element) => {
        element.getAttributeNames().forEach((name) => {
            if (!name.startsWith('data-template-attr-')) return;

            const attrName = name.replace('data-template-attr-', '');
            const key = element.getAttribute(name);
            const value = attrs[key];

            value === undefined || value === null
                ? element.removeAttribute(attrName)
                : element.setAttribute(attrName, value);

            element.removeAttribute(name);
        });
    });

    wrapper.querySelectorAll('[data-template-text]').forEach((element) => {
        const key = element.getAttribute('data-template-text');
        element.textContent = text[key] ?? '';
    });

    wrapper.querySelectorAll('[data-template-html]').forEach((element) => {
        const key = element.getAttribute('data-template-html');
        element.innerHTML = html[key] ?? '';
    });

    return wrapper.innerHTML.trim();
}
