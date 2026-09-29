/**
 * Custom dropdown listbox — replaces native <select> for device pickers.
 * Native select popups misplace themselves inside overlays that use
 * backdrop-filter/transform (and in scaled webviews); this component renders
 * its own menu, fixed-positioned in <body>, so it always sits under the
 * trigger. Keyboard: Enter/Space/ArrowDown open, arrows navigate, Enter picks,
 * Esc / outside click closes.
 */

import { el } from './utils.js';

const CHEVRON_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

/**
 * @param {object} options
 * @param {function():Array<{value:string,label:string}>} options.getItems
 * @param {function():string} options.getValue   current value id
 * @param {function(value:string):void} options.onSelect
 * @returns {{ el:HTMLButtonElement, refresh:Function, close:Function, setDisabled:Function }}
 */
export function createDropdown({ getItems, getValue, onSelect }) {
    let open = false;
    let activeIndex = -1;

    const trigger = el('button', { type: 'button', class: 'dropdown-trigger', 'aria-haspopup': 'listbox' });
    const menu = el('ul', { class: 'dropdown-menu hidden', role: 'listbox' });

    function items() {
        return getItems() || [];
    }

    function renderTrigger() {
        const current = items().find((item) => item.value === getValue());
        trigger.replaceChildren(
            el('span', { class: 'dropdown-value', text: current ? current.label : '—' }),
            el('span', { class: 'dropdown-chevron', html: CHEVRON_SVG })
        );
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function optionNodes() {
        return [...menu.children];
    }

    function updateActive() {
        optionNodes().forEach((node, index) => node.classList.toggle('active', index === activeIndex));
        const active = optionNodes()[activeIndex];
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function renderMenu() {
        const current = getValue();
        menu.replaceChildren(
            ...items().map((item, index) =>
                el('li', {
                    class: 'dropdown-option' + (item.value === current ? ' selected' : ''),
                    role: 'option',
                    'aria-selected': item.value === current ? 'true' : 'false',
                    text: item.label,
                    title: item.label,
                    onclick: () => pick(item.value),
                    onmouseenter: () => {
                        activeIndex = index;
                        updateActive();
                    },
                })
            )
        );
        activeIndex = Math.max(0, items().findIndex((item) => item.value === current));
        updateActive();
    }

    function pick(value) {
        if (value !== getValue()) onSelect(value);
        renderTrigger();
        close();
    }

    function position() {
        const rect = trigger.getBoundingClientRect();
        menu.style.minWidth = `${rect.width}px`;
        menu.style.maxWidth = `${Math.min(420, window.innerWidth - 16)}px`;
        let top = rect.bottom + 6;
        if (top + menu.offsetHeight > window.innerHeight - 8) {
            top = Math.max(8, rect.top - menu.offsetHeight - 6); // flip above when space runs out
        }
        menu.style.top = `${top}px`;
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    }

    function openMenu() {
        if (open || trigger.disabled) return;
        open = true;
        renderTrigger();
        renderMenu();
        document.body.append(menu);
        menu.classList.remove('hidden');
        position();
        document.addEventListener('pointerdown', onDocPointer, true);
        document.addEventListener('keydown', onDocKey, true);
        window.addEventListener('resize', close);
        window.addEventListener('scroll', onScroll, true);
    }

    function close() {
        if (!open) return;
        open = false;
        renderTrigger();
        menu.classList.add('hidden');
        menu.remove();
        document.removeEventListener('pointerdown', onDocPointer, true);
        document.removeEventListener('keydown', onDocKey, true);
        window.removeEventListener('resize', close);
        window.removeEventListener('scroll', onScroll, true);
    }

    function onDocPointer(event) {
        if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
    }

    function onScroll(event) {
        if (menu.contains(event.target)) return; // scrolling the menu itself is fine
        close();
    }

    function onDocKey(event) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            return;
        }
        const count = items().length;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            activeIndex = event.key === 'ArrowDown' ? Math.min(count - 1, activeIndex + 1) : Math.max(0, activeIndex - 1);
            updateActive();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const item = items()[activeIndex];
            if (item) pick(item.value);
        }
    }

    trigger.addEventListener('click', () => (open ? close() : openMenu()));
    trigger.addEventListener('keydown', (event) => {
        if (!open && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            openMenu();
        }
    });

    renderTrigger();

    return {
        el: trigger,
        refresh() {
            renderTrigger();
            if (open) renderMenu();
        },
        close,
        setDisabled(disabled) {
            trigger.disabled = disabled;
            if (disabled) close();
        },
    };
}
