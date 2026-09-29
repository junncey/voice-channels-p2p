/* Applied synchronously in <head> (CSP forbids inline scripts) so the
 * correct palette is on <html> before the first paint — no dark flash
 * when a light-theme user loads a page. Dark is the default. */
(function () {
    var theme = 'dark';
    try {
        var stored = localStorage.getItem('vc_theme');
        if (stored === 'light') theme = 'light';
    } catch (e) {
        /* private mode etc. — stay on the default */
    }
    document.documentElement.dataset.theme = theme;
})();
