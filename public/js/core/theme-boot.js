/* 在 <head> 中同步执行（CSP 禁止内联脚本），让正确的配色
 * 在首次绘制前就落到 <html> 上——浅色主题用户加载页面时
 * 不会闪一下深色。偏好取值：'dark'（默认）、
 * 'light'、'auto'（= 跟随操作系统，实时）。 */
(function () {
    let pref = 'dark';
    try {
        const stored = localStorage.getItem('vc_theme');
        if (stored === 'light' || stored === 'dark' || stored === 'auto') pref = stored;
    } catch (e) {
        /* 隐私模式等——保持默认 */
    }
    function resolve() {
        if (pref !== 'auto') return pref;
        try {
            return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        } catch (e) {
            return 'dark';
        }
    }
    function apply() {
        document.documentElement.dataset.theme = resolve();
        document.documentElement.dataset.themePref = pref;
    }
    apply();
    try {
        const mq = window.matchMedia('(prefers-color-scheme: light)');
        const onChange = function () {
            if (pref === 'auto') apply();
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {
        /* 该引擎不支持实时切换——下次刷新时重新解析 */
    }

    /* SW（离线 shell + 缓存资产）——在 load 之后注册，
     * 因此绝不与首次绘制争抢。尽力而为：没有它每个页面
     * 照常工作。策略在 /sw.js。 */
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function (e) {
                /* 不支持/被拦截——普通 HTTP 路径不受影响 */
            });
        });
    }
})();
