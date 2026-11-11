/**
 * 前端版本守卫。
 *
 * 每个页面的 HTML 里都烙有本页 build id（`<meta name="vc-build">`），
 * 与服务器在 GET /api/version 上报的 id 比对；标签页可见期间
 * 每 5 分钟轮询一次（重新获得焦点时立即查）。不一致时
 * 页面顶部出现一条细横条，提示可以刷新。横条处于正常文档流，
 * 因此绝不会遮住页面；关闭它只对这一个 build 静音，
 * 更新的 build 会再次提示。
 */

import { t } from './i18n.js';
import { el } from './utils.js';

// 部署不频繁，且切回标签页会立即检查，所以慢速的
// 后台轮询就足够——每标签页每小时 12 次请求而非 60 次。
const CHECK_MS = 5 * 60_000;
const BODY_CLASS = 'has-update-bar';
const HEIGHT_VAR = '--update-bar-h';

const INFO_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>';
const X_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>';

let loaded = null; // 本页被服务时的 build id
let dismissedBuild = null; // 经 × 关闭的 build——更新的 build 会再次提示
let bar = null;
let inFlight = false;
let isBusy = null;

/**
 * @param {object}   [options]
 * @param {function} [options.isBusy] 刷新会打断用户（通话中）时返回 true
 *        ——此时刷新会先请求确认
 */
export function initVersionCheck(options = {}) {
    isBusy = typeof options.isBusy === 'function' ? options.isBusy : null;
    loaded = bakedBuild();
    check();
    setInterval(() => {
        if (!document.hidden) check();
    }, CHECK_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
    });
}

/** 服务器烙进本页的 build id——即它正在运行的确切代码。 */
function bakedBuild() {
    const meta = document.querySelector('meta[name="vc-build"]');
    return meta ? meta.getAttribute('content') : null;
}

async function check() {
    if (inFlight) return;
    inFlight = true;
    let build = null;
    try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (res.ok) build = (await res.json()).build;
    } catch {
        // 服务器重启中或不可达——下一轮再试
    } finally {
        inFlight = false;
    }
    if (!build) return;

    if (!loaded) {
        // 没有烙印 id（页面 HTML 由更旧的 build 提供）——回退到
        // 能拿到的第一个响应
        loaded = build;
    } else if (build !== loaded && build !== dismissedBuild) {
        showUpdateBar(build);
    }
}

function showUpdateBar(build) {
    if (bar) return;
    bar = el(
        'div',
        { class: 'update-bar', role: 'status' },
        el('span', { class: 'update-icon', html: INFO_SVG, 'aria-hidden': 'true' }),
        el('span', { class: 'update-text', text: t('update.availableDesc') }),
        el('button', {
            class: 'update-link',
            type: 'button',
            text: t('update.refreshNow'),
            onclick: () => {
                if (isBusy && isBusy() && !window.confirm(t('update.reloadInCall'))) return;
                reloadNow();
            },
        }),
        el('button', {
            class: 'update-close',
            type: 'button',
            html: X_SVG,
            'aria-label': t('update.dismiss'),
            onclick: () => dismissBuild(build),
        })
    );
    document.body.prepend(bar);
    document.body.classList.add(BODY_CLASS);
    // 实测而非硬编码：横条在窄屏会折成两行，
    // 离线横幅要与它保持距离
    document.body.style.setProperty(HEIGHT_VAR, `${bar.offsetHeight}px`);
}

/**
 * 脚本触发的刷新仍然是一次导航：防误退出的页面（通话中）
 * 否则会确认两次——一次来自本横条，一次来自浏览器自己的弹窗。
 * 先广播刷新意图，让它们解除拦截；监听器同步执行，
 * 赶在 beforeunload 之前。
 *
 * 刷新前还要先清空 SW 的静态缓存：不清的话 stale-while-revalidate
 * 会在这一次刷新中继续端出旧的 js/css
 * （后台再验证只会在下一次刷新时生效），
 * 「立即刷新」就变成了要刷两次的事。
 */
function reloadNow() {
    window.dispatchEvent(new Event('vc:unload-intent'));
    purgeStaticCache().finally(() => location.reload());
}

/** 请求控管中的 SW 丢弃其静态缓存；无论何种情况都
 *  快速 resolve（没有 SW、还没有 controller、或 worker 卡死
 *  都绝不能拖延刷新）。 */
function purgeStaticCache() {
    const sw = navigator.serviceWorker;
    if (!sw?.controller) return Promise.resolve();
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(resolve, 400);
        channel.port1.onmessage = () => {
            clearTimeout(timer);
            resolve();
        };
        sw.controller.postMessage({ type: 'vc-purge-static' }, [channel.port2]);
    });
}

function dismissBuild(build) {
    dismissedBuild = build;
    if (bar) bar.remove();
    bar = null;
    document.body.classList.remove(BODY_CLASS);
    document.body.style.removeProperty(HEIGHT_VAR);
}
