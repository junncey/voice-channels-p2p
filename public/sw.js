/*
Minimal service worker — the PWA's offline shell + second-open speedup.
Registered from theme-boot.js (every page) at window load; scope '/' per
manifest.webmanifest.

Strategies (per roadmap item 22, kept deliberately minimal — runtime caching
only, no precache list to maintain):

  navigations      network-first. HTML is no-cache server-side and carries the
                   build id the version banner compares against, so the shell
                   must never be served stale while online. A successful
                   navigation is cached under BOTH the route URL and its shell
                   asset path, so an offline visit to a never-opened /c/<id>
                   route still finds a shell.
  /images/**       cache-first. The server already sends 7-day immutable for
                   them; the SW only adds offline survival.
  other same-origin stale-while-revalidate: js/css/lang/manifest serve instantly
                   GETs             from cache and refresh in the background. The update banner's
                   reload sends 'vc-purge-static' first (see version.js), so a
                   deploy never needs the classic SWR double reload.
                   /sounds/** falls here too, and media elements ask for them
                   with Range headers — the server answers 206 Partial Content,
                   which cache.put() refuses. Only full 200 responses are ever
                   cached, and a refused put must never break the response.

/api/**, /socket.io/**, non-GET and cross-origin requests pass straight
through — API responses and the signaling stream must never come from a cache.

Cache names carry a manual version: bump the suffix when the strategy or the
asset layout changes so activate() drops the old buckets.
*/

'use strict';

// SW 的全部逻辑包在一个 IIFE 里：顶层只有 self.addEventListener 注册，
// 其余（缓存名/助手）保持局部——不向 SW 全局作用域漏任何隐式声明
(() => {
    // v3：音频元素带 Range 头探测 /sounds/**，服务端回 206 部分响应——
    // cache.put() 对它抛 TypeError 且曾经的 put 是悬空 Promise（Uncaught
    // in promise）。入缓存改为仅限完整 200，put 全部尽力而为不再抛错。
    const STATIC_CACHE = 'vc-static-v3';
    const IMAGE_CACHE = 'vc-img-v2';
    const KNOWN_CACHES = [STATIC_CACHE, IMAGE_CACHE];

    self.addEventListener('install', () => {
        // take over from an older worker immediately — assets are same-URL SWR, so
        // a mid-session swap cannot mix versions (the purge message keeps
        // banner-triggered reloads coherent)
        self.skipWaiting();
    });

    self.addEventListener('activate', (event) => {
        event.waitUntil(
            (async () => {
                const names = await caches.keys();
                await Promise.all(names.filter((n) => !KNOWN_CACHES.includes(n)).map((n) => caches.delete(n)));
                await self.clients.claim();
            })()
        );
    });

    self.addEventListener('message', (event) => {
        if (event.data?.type !== 'vc-purge-static') return;
        event.waitUntil(
            caches.delete(STATIC_CACHE).then(() => {
                // ack over the MessageChannel the page transferred, when present —
                // version.js resolves its reload on this
                event.ports[0]?.postMessage({ ok: true });
            })
        );
    });

    self.addEventListener('fetch', (event) => {
        const request = event.request;
        if (request.method !== 'GET') return;

        const url = new URL(request.url);
        if (url.origin !== self.location.origin) return;
        // live data must never be served from a cache
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

        if (request.mode === 'navigate') {
            event.respondWith(navigate(request, url));
        } else if (url.pathname.startsWith('/images/')) {
            event.respondWith(cacheFirst(request, IMAGE_CACHE));
        } else {
            event.respondWith(staleWhileRevalidate(request));
        }
    });

    /** Only a complete 200 may enter a Cache — partial (206) replies to
     *  media Range probes make cache.put() throw, and must not be kept. */
    function cacheable(response) {
        return response.status === 200;
    }

    /** Network-first for page loads; offline it serves the cached shell. */
    async function navigate(request, url) {
        try {
            const fresh = await fetch(request);
            if (cacheable(fresh)) {
                await put(STATIC_CACHE, request, fresh);
                const shell = shellFor(url.pathname);
                if (shell !== url.pathname) await put(STATIC_CACHE, shell, fresh);
            }
            return fresh;
        } catch {
            const cached = await caches.match(request);
            if (cached) return cached;
            const shell = await caches.match(shellFor(url.pathname));
            if (shell) return shell;
            throw new Error('offline: no shell cached');
        }
    }

    /** The static asset behind a server-rendered route, for offline fallback. */
    function shellFor(pathname) {
        if (pathname === '/admin' || pathname === '/admin.html') return '/admin.html';
        if (pathname.startsWith('/c/') || pathname === '/channel.html') return '/channel.html';
        return '/index.html';
    }

    /** Serve from cache, fall back to network (and fill the cache). */
    async function cacheFirst(request, cacheName) {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (cacheable(fresh)) await put(cacheName, request, fresh);
        return fresh;
    }

    /** Respond from cache immediately; refresh the entry in the background. */
    async function staleWhileRevalidate(request) {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(request);
        const refreshing = fetch(request)
            .then((fresh) => {
                if (cacheable(fresh)) put(STATIC_CACHE, request, fresh);
                return fresh;
            })
            .catch(() => null); // offline with a cached copy: the stale answer wins
        if (cached) {
            return cached; // `refreshing` settles on its own and never rejects
        }
        const fresh = await refreshing;
        if (!fresh) throw new Error('offline: not cached');
        return fresh;
    }

    /** Cache a successful response clone under the exact request URL.
     *  Best effort: a refused put (quota, engine quirks) must never break
     *  the live response — rejections are swallowed, never floated. */
    async function put(cacheName, request, response) {
        const snapshot = response.clone(); // clone before the caller consumes the body
        try {
            const cache = await caches.open(cacheName);
            await cache.put(request, snapshot);
        } catch {
            /* best effort — serving beats caching */
        }
    }
})();
