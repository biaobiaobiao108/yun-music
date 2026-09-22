const CACHE_NAME = 'yun-yin-admin-react-8648403';
const VERSIONED_ASSET_CACHE = 'yun-yin-admin-react-assets-8648403';
const MAX_VERSIONED_ASSETS = 60;
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './assets/yun-yin.png',
    './manifest.json',
    './tailwind.generated.css',
    './music/assets/fontawesome/css/solid-subset.min.css'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

const isVersionedAsset = (url) => (
    /\/(?:app|login)-[a-z0-9]+\.js$/i.test(url.pathname) ||
    /\/js\/chunks\/[^/]+-[a-z0-9]+\.js$/i.test(url.pathname)
);

const cacheFirstVersionedAsset = async (request) => {
    const cache = await caches.open(VERSIONED_ASSET_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        const overflow = keys.length - MAX_VERSIONED_ASSETS;
        if (overflow > 0) await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
    }
    return response;
};

self.addEventListener('fetch', (event) => {
    // Only cache GET requests
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith('http')) return;

    // [Fix] Do not cache API requests
    if (event.request.url.includes('/api/')) return;
    // [Fix] Do not cache Music Player files (dev mode)
    if (event.request.url.includes('/music/')) return;

    // [Fix] Do not cache external resources (CDN, placeholders, etc.)
    const url = new URL(event.request.url);
    if (url.origin !== location.origin) return;

    if (isVersionedAsset(url)) {
        event.respondWith(cacheFirstVersionedAsset(event.request));
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // 如果请求成功，更新缓存并返回
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            })
            .catch(() => {
                // 网络不可用时，尝试从缓存获取
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) return cachedResponse;
                    throw new Error('Network failed and no cache available');
                });
            }).catch((error) => {
                console.error('[SW] Fetch failed:', event.request.url, error);
                return new Response('Network error', {
                    status: 408,
                    statusText: 'Request Timeout'
                });
            })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (![CACHE_NAME, VERSIONED_ASSET_CACHE].includes(cacheName)) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});
