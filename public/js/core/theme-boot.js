/* Applied synchronously in <head> (CSP forbids inline scripts) so the
 * correct palette is on <html> before the first paint — no dark flash
 * when a light-theme user loads a page. Preference values: 'dark' (default),
 * 'light', 'auto' (= follow the OS, live). */
(function () {
    var pref = 'dark';
    try {
        var stored = localStorage.getItem('vc_theme');
        if (stored === 'light' || stored === 'dark' || stored === 'auto') pref = stored;
    } catch (e) {
        /* private mode etc. — stay on the default */
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
        var mq = window.matchMedia('(prefers-color-scheme: light)');
        var onChange = function () {
            if (pref === 'auto') apply();
        };
        if (mq.addEventListener) mq.addEventListener('change', onChange);
        else if (mq.addListener) mq.addListener(onChange);
    } catch (e) {
        /* no live switching on this engine — the next reload re-resolves */
    }

    /* Service worker (offline shell + cached assets) — registered after load
     * so it never competes with first paint. Best-effort: every page works
     * without it. Strategy lives in /sw.js. */
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('/sw.js').catch(function (e) {
                /* unsupported/blocked — the plain HTTP path is unaffected */
            });
        });
    }
})();
