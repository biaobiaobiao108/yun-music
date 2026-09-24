// Bump this whenever the React shell or its static contract changes so an
// already-open player cannot keep serving a stale UI bundle indefinitely.
const CACHE_NAME = 'yun-yin-web-react-50f202d';
const VERSIONED_ASSET_CACHE = 'yun-yin-web-react-assets-50f202d';
const MAX_VERSIONED_ASSETS = 80;
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './login.html',
    // CSS
    './css/theme_variables.css',
    './assets/fontawesome/css/solid-subset.min.css',
    // React 入口为哈希文件名，采用 Network First 动态加入缓存，
    // 避免把过期的入口固定写入安装清单。
    './css/tailwind.generated.css',
    // 静态资源
    './assets/yun-yin.png',
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
    /\/(?:app|login)-[a-z0-9]+\.(?:js|css)$/i.test(url.pathname) ||
    /\/js\/chunks\/[^/]+-[a-z0-9]+\.(?:js|css)$/i.test(url.pathname)
);

const cacheVersionedAsset = async (request, response) => {
    if (!response || response.status !== 200 || response.type !== 'basic') return;
    const cache = await caches.open(VERSIONED_ASSET_CACHE);
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    const overflow = keys.length - MAX_VERSIONED_ASSETS;
    if (overflow > 0) {
        await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
    }
};

const cacheFirstVersionedAsset = async (request) => {
    const cache = await caches.open(VERSIONED_ASSET_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    void cacheVersionedAsset(request, response).catch(() => undefined);
    return response;
};

const KNOWN_CACHES = [CACHE_NAME, VERSIONED_ASSET_CACHE];

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => Promise.all(
            cacheNames.map((cacheName) => {
                if (!KNOWN_CACHES.includes(cacheName)) {
                    console.log('[SW] Deleting old cache:', cacheName);
                    return caches.delete(cacheName);
                }
                return undefined;
            })
        ))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. 过滤非 http(s) 协议 (如 chrome-extension://)，避免 cache.put 报错
    if (!url.protocol.startsWith('http')) return;

    // 2. 忽略所有音频请求、下载请求和 API 请求，让浏览器直接处理
    // 拦截下载会导致大文件占用 Cache 且单个失败可能引起 SW state 不良
    const isApiOrAudio = url.pathname.includes('/api/') ||
        url.href.match(/\.(mp3|flac|m4a|ogg|aac)(\?.*)?$/i);

    if (isApiOrAudio) {
        return; // 直接 return 就不走 event.respondWith，相当于不拦截
    }

    // 3. HTML 与未哈希资源采用 Network First，保证入口和主题配置及时更新。
    if (event.request.method !== 'GET') return;

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache)).catch(() => undefined);
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

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
                        cache.put(event.request, responseToCache).catch(err => {
                            console.error('[SW] Cache put error:', err);
                        });
                    });
                }
                return response;
            })
            .catch(() => {
                // 网络不可用时，尝试从缓存获取
                return caches.match(event.request);
            })
    );
});
