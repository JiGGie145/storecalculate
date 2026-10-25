const CACHE_NAME = 'ledger-flow-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(SHELL_URLS);

        const page = await cache.match('/index.html');
        const markup = await page.text();
        const assets = [...markup.matchAll(/(?:src|href)="([^"]+)"/g)]
            .map(match => match[1])
            .filter(path => path.startsWith('/') && !path.startsWith('/api/'));

        await Promise.all(assets.map(async path => {
            try {
                const response = await fetch(path);
                if (response.ok) await cache.put(path, response);
            } catch {
                return;
            }
        }));

        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);

    if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);

        if (cached) return cached;

        try {
            const response = await fetch(request);
            if (response.ok) await cache.put(request, response.clone());
            return response;
        } catch (error) {
            if (request.mode === 'navigate') {
                return (await cache.match('/index.html')) || Response.error();
            }
            throw error;
        }
    })());
});