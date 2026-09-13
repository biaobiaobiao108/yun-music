export interface SongUrlFeatureContext {
    getSettings: () => Record<string, any>;
    getPlaylist: () => any[];
    getCurrentIndex: () => number;
    getPlayMode: () => string;
    getPreSelectedNextIndex: () => number | null;
    setPreSelectedNextIndex: (index: number | null) => void;
    getUserAuthHeaders: () => Record<string, string>;
    fetchCustomSources: (...args: any[]) => Promise<any>;
    cleanSongData: (song: any) => any;
    checkServerCache: (...args: any[]) => Promise<any>;
    triggerServerCache: (...args: any[]) => any;
    updateStorageStatsUI: (...args: any[]) => any;
    showInfo: (message: string) => void;
    showSuccess: (message: string) => void;
    showError: (message: string) => void;
}

export function initSongUrlFeature(context: SongUrlFeatureContext) {
    const API_BASE = '/api/music';
    const settings = new Proxy<Record<string, any>>({}, {
        get: (_target, property: string) => context.getSettings()[property],
        set: (_target, property: string, value: any) => {
            context.getSettings()[property] = value;
            return true;
        },
    });
    const currentPlaylist = new Proxy<any[]>([], {
        get: (_target, property: string | symbol) => Reflect.get(context.getPlaylist(), property),
    });
    const getUserAuthHeaders = context.getUserAuthHeaders;
    const fetchCustomSources = context.fetchCustomSources;
    const cleanSongData = context.cleanSongData;
    const checkServerCache = context.checkServerCache;
    const triggerServerCache = context.triggerServerCache;
    const updateStorageStatsUI = context.updateStorageStatsUI;
    const showInfo = context.showInfo;
    const showSuccess = context.showSuccess;
    const showError = context.showError;
    const BROKEN_SERVER_CACHE_TTL = 10 * 60 * 1000;

    const getServerCacheFailureKey = (song, quality) => {
        const songId = String(cleanSongData(song)?.id || song?.id || song?.songmid || '');
        const normalizedQuality = String(quality || '');
        if (!songId || !normalizedQuality) return null;
        return `lx_broken_server_cache_${encodeURIComponent(songId)}_${encodeURIComponent(normalizedQuality)}`;
    };

    const isServerCacheTemporarilyBypassed = (song, quality) => {
        const key = getServerCacheFailureKey(song, quality);
        if (!key) return false;
        try {
            const failedAt = Number(sessionStorage.getItem(key) || 0);
            if (!failedAt) return false;
            if (Date.now() - failedAt < BROKEN_SERVER_CACHE_TTL) return true;
            sessionStorage.removeItem(key);
        } catch (_) { }
        return false;
    };

    const markServerCacheFailure = (song, quality) => {
        const key = getServerCacheFailureKey(song, quality);
        if (!key) return;
        try { sessionStorage.setItem(key, String(Date.now())); } catch (_) { }
    };
function getSourceTypeText(sourceType) {
    const map = {
        'server_cache': '服务器本地缓存',
        'cache': '浏览器链接缓存',
        'normal': '在线解析'
    };
    return map[sourceType] || '解析成功';
}

// --- Expiration & Prefetch Management ---
/**
 * 探活 URL 是否依然有效 (不下载数据，仅检查响应状态)
 * @param {string} url 
 * @returns {Promise<boolean>}
 */
async function probeUrl(url) {
    if (!url) return false;
    // 本地 API 或 代理路径通常被认为有效
    if (url.startsWith('/') || url.includes(window.location.host)) return true;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

        // 使用 Range 请求 0-1 字节，以最小代价触发 CORS 检查和链接有效性验证
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { 'Range': 'bytes=0-1' },
                signal: controller.signal
            });

            // 探测请求不消费响应体，主动取消可以避免浏览器继续保留连接和缓冲区。
            try { await response.body?.cancel(); } catch (_) { }

            // 返回 200 或 206 表示链接依然可用
            return response.ok;
        } finally {
            clearTimeout(timeoutId);
        }
    } catch (e) {
        console.warn(`[Probe] URL probe failed: ${url.substring(0, 40)}...`, e.message);
        return false;
    }
}

const PREFETCH_CACHE_MAX = 5;
const PREFETCH_CACHE_TTL = 30 * 60 * 1000;
const PREFETCH_FAILURE_TTL = 60 * 1000;
const PREFETCH_SONG_FIELDS = [
    'id', 'songmid', 'songId', 'source', 'name', 'singer', 'albumName', 'albumId',
    'interval', 'img', 'pic', 'types', '_types', 'hash', 'strMediaMid', 'albumMid',
    'copyrightId', 'lrcUrl', 'mrcUrl', 'trcUrl'
];
const PREFETCH_META_FIELDS = [
    'source', 'songId', 'name', 'songName', 'singer', 'singerName', 'albumName',
    'albumId', 'picUrl', 'img', 'interval', 'qualitys', 'types', '_types',
    'strMediaMid', 'albumMid', 'lrcUrl', 'mrcUrl', 'trcUrl'
];

function projectPrefetchSongInfo(songInfo) {
    if (!songInfo || typeof songInfo !== 'object') return undefined;

    const projected = {};
    PREFETCH_SONG_FIELDS.forEach(key => {
        if (songInfo[key] !== undefined && songInfo[key] !== null) projected[key] = songInfo[key];
    });

    if (songInfo.meta && typeof songInfo.meta === 'object') {
        const meta = {};
        PREFETCH_META_FIELDS.forEach(key => {
            if (songInfo.meta[key] !== undefined && songInfo.meta[key] !== null) meta[key] = songInfo.meta[key];
        });
        if (Object.keys(meta).length > 0) projected.meta = meta;
    }

    return Object.keys(projected).length > 0 ? projected : undefined;
}

const prefetchManager = {
    cache: new Map(), // Map<songId, lightweight prefetch result>
    inflight: new Map(), // Map<songId:quality, Promise<void>>
    version: 0,
    buffererSongId: null,
    bufferer: new Audio(), // 隐藏的缓冲器，仅用于加载媒体元数据

    init() {
        this.bufferer.muted = true;
        this.bufferer.preload = 'metadata'; // 预读地址与元数据，不主动缓冲整首歌曲
    },

    stopBufferer() {
        try { this.bufferer.pause(); } catch (_) { }
        this.bufferer.removeAttribute('src');
        try { this.bufferer.load(); } catch (_) { }
        this.buffererSongId = null;
    },

    set(songId, data) {
        const key = String(songId);
        const entry = {
            url: data.url,
            requestedQuality: data.requestedQuality || data.quality,
            quality: data.quality,
            sourceType: data.sourceType,
            sourceName: data.sourceName,
            requestedSource: data.requestedSource,
            downloadSource: data.downloadSource,
            switchedSource: data.switchedSource,
            originalSource: data.originalSource,
            cacheFile: data.cacheFile,
            songInfo: projectPrefetchSongInfo(data.songInfo),
            timestamp: Date.now()
        };
        this.cache.set(key, entry);

        // 核心升级：触发数据流预加载
        if (data.url) {
            // Only one hidden Audio request may be active. Replacing src alone
            // can leave the previous metadata request alive in some browsers.
            const currentBuffererUrl = this.bufferer.currentSrc || this.bufferer.src;
            if (currentBuffererUrl && currentBuffererUrl !== data.url) {
                this.stopBufferer();
            }
            console.log(`[Prefetch] Pre-loading metadata for ID: ${key}`);
            this.bufferer.src = data.url;
            this.buffererSongId = key;
            this.bufferer.load();
        }

        while (this.cache.size > PREFETCH_CACHE_MAX) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
    },
    get(songId, requestedQuality = null) {
        const key = String(songId);
        const data = this.cache.get(key);
        if (data && (Date.now() - data.timestamp < PREFETCH_CACHE_TTL) &&
            (!requestedQuality || !data.requestedQuality || String(data.requestedQuality) === String(requestedQuality))) {
            return data;
        }
        this.delete(key);
        return null;
    },
    delete(songId) {
        const key = String(songId);
        this.cache.delete(key);
        if (this.buffererSongId === key) this.stopBufferer();
    },
    clear() {
        this.version += 1;
        this.cache.clear();
        this.inflight.clear();
        this.stopBufferer();
    }
};
prefetchManager.init(); // 立即初始化缓冲器

// --- URL Fetching Logic (Unified Resolution) ---

/**
 * 统一的歌曲解析入口，支持播放和预读调用
 * 包含：本地/服务器缓存检查、在线解析、自动降级逻辑
 */
async function resolveSongUrl(song, quality, isSilent = false, isRetry = false, disableFallback = false) {
    try {
        const result = await fetchSongUrl(song, quality, isRetry, isSilent);
        if (result.errorMsg) throw new Error(result.errorMsg);
        return result;
    } catch (error) {
        if (disableFallback) {
            throw error;
        }

        // 默认降级/换源的 fallback 逻辑 (用于预读或下载等不直接受播放器重试接管的场景)
        const isPlatformNotSupported = error.message && (
            error.message.includes('未找到支持') ||
            error.message.includes('not supported')
        );

        // 解析降级/换源优先级
        const order = (settings.playbackErrorPriority || 'platform,quality,next').split(',');
        const steps = [];
        for (const key of order) {
            if (key === 'quality' && settings.enableAutoDegradeQuality !== false) {
                steps.push('degrade');
            } else if (key === 'platform' && settings.enableAutoSwitchSource !== false) {
                steps.push('switch_platform');
            }
        }

        const fallbackRetryMode = (isRetry === 'local_retry' || isRetry === 'download') ? isRetry : true;

        for (const step of steps) {
            if (step === 'degrade') {
                const nextQuality = isPlatformNotSupported ? null : window.QualityManager.getNextLowerQuality(quality, song);
                if (nextQuality) {
                    if (!isSilent) {
                        const fromName = window.QualityManager.getQualityDisplayName(quality);
                        const toName = window.QualityManager.getQualityDisplayName(nextQuality);
                        showInfo(`从 ${fromName} 降级到 ${toName} 播放...`);
                    }
                    return await resolveSongUrl(song, nextQuality, isSilent, fallbackRetryMode, false);
                }
            } else if (step === 'switch_platform') {
                if (!isSilent) {
                    console.log(`[AutoSource] 原始源解析失败，准备尝试全网匹配: ${song.name}`);
                }
                const matchedSong = await findOtherSourceMatch(song, isSilent);
                if (matchedSong) {
                    if (!isSilent) {
                        showInfo(`找到备选源，尝试从 ${getSourceName(matchedSong.source)} 播放...`);
                    }
                    const bestNextQuality = window.QualityManager.getBestQuality(matchedSong, settings.preferredQuality || 'flac');
                    const matchedResult = await fetchSongUrl(matchedSong, bestNextQuality, fallbackRetryMode, isSilent);
                    return {
                        ...matchedResult,
                        songInfo: matchedSong,
                        switchedSource: true,
                        originalSource: song.source
                    };
                }
            }
        }

        throw error;
    }
}

async function resolveDownloadSongUrl(song, quality, isSilent = true) {
    const tried = new Set();
    let lastError = null;

    const tryResolveCandidate = async (candidateSong, preferredQuality) => {
        const requestedQuality = preferredQuality || settings.preferredQuality || 'flac';
        let candidateQuality = window.QualityManager?.QUALITY_PRIORITY?.includes(requestedQuality)
            ? requestedQuality
            : (window.QualityManager
                ? window.QualityManager.getBestQuality(candidateSong, requestedQuality)
                : requestedQuality);

        while (candidateQuality) {
            const candidateId = candidateSong.id || candidateSong.songmid || candidateSong.songId || candidateSong.hash || candidateSong.copyrightId || candidateSong.mid || candidateSong.mediaMid || `${candidateSong.name || ''}_${candidateSong.singer || ''}_${candidateSong.interval || ''}`;
            const key = `${candidateSong.source || ''}_${candidateId}_${candidateQuality}`;
            if (tried.has(key)) break;
            tried.add(key);

            try {
                const result = await fetchSongUrl(candidateSong, candidateQuality, 'download', isSilent);
                if (result.errorMsg) throw new Error(result.errorMsg);
                return result;
            } catch (err) {
                lastError = err;
                console.warn(`[DownloadResolve] 解析失败: ${candidateSong.name} via ${candidateSong.source} (${candidateQuality})`, err);
                if (!window.QualityManager || settings.enableAutoDegradeQuality === false) break;
                candidateQuality = window.QualityManager.getNextLowerQuality(candidateQuality, candidateSong);
            }
        }

        return null;
    };

    const originalResult = await tryResolveCandidate(song, quality);
    if (originalResult) return originalResult;

    if (settings.enableAutoSwitchSource === false) {
        throw lastError || new Error('解析失败');
    }

    const matches = await findOtherSourceMatches(song, isSilent, { ignoreSupportedFilter: true });
    for (const matchedSong of matches) {
        const matchedResult = await tryResolveCandidate(matchedSong, quality);
        if (matchedResult) {
            return {
                ...matchedResult,
                songInfo: matchedSong,
                switchedSource: true,
                originalSource: song.source
            };
        }
    }

    throw lastError || new Error('未找到可下载的备选源');
}

function normalizeSongMatchText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[（(].*?[）)]/g, '')
        .replace(/[\s·・,，.。!！?？:：;；'"‘’“”《》<>【】[\]()（）\-_/\\]/g, '');
}

function isSingerMatch(sourceSinger, targetSinger) {
    const sourceText = normalizeSongMatchText(sourceSinger);
    const targetText = normalizeSongMatchText(targetSinger);
    if (!targetText) return true;
    if (!sourceText) return false;
    if (sourceText.includes(targetText) || targetText.includes(sourceText)) return true;

    const splitSinger = value => String(value || '')
        .toLowerCase()
        .split(/[、,，/&／|;；]+/)
        .map(normalizeSongMatchText)
        .filter(Boolean);
    const sourceParts = splitSinger(sourceSinger);
    const targetParts = splitSinger(targetSinger);
    return sourceParts.some(sourcePart => targetParts.some(targetPart => sourcePart.includes(targetPart) || targetPart.includes(sourcePart)));
}

function getSongMatchScore(item, song) {
    const targetName = normalizeSongMatchText(song.name);
    const itemName = normalizeSongMatchText(item.name);
    if (!targetName || !itemName) return -1;
    if (!itemName.includes(targetName) && !targetName.includes(itemName)) return -1;

    if (!isSingerMatch(item.singer, song.singer)) return -1;

    const targetDuration = timeToSeconds(song.interval);
    const itemDuration = timeToSeconds(item.interval);
    let durationScore = 0;
    if (targetDuration > 0 && itemDuration > 0) {
        const durationDiff = Math.abs(targetDuration - itemDuration);
        if (durationDiff > 8) return -1;
        durationScore = 8 - durationDiff;
    }

    let nameScore = 0;
    if (itemName === targetName) nameScore = 20;
    else if (itemName.includes(targetName) || targetName.includes(itemName)) nameScore = 10;

    const sameAlbum = item.albumName && song.albumName && normalizeSongMatchText(item.albumName) === normalizeSongMatchText(song.albumName);
    return nameScore + durationScore + (sameAlbum ? 3 : 0);
}

function getSongDurationDiff(item, song) {
    const targetDuration = timeToSeconds(song.interval);
    const itemDuration = timeToSeconds(item.interval);
    if (targetDuration <= 0 || itemDuration <= 0) return null;
    return Math.abs(targetDuration - itemDuration);
}

/**
 * 跨平台寻找相同歌曲的匹配逻辑
 * 基本规则：歌名+歌手+时长匹配
 */
async function findOtherSourceMatch(song, isSilent = false) {
    const matches = await findOtherSourceMatches(song, isSilent);
    return matches[0] || null;
}

async function findOtherSourceMatches(song, isSilent = false, options = {}) {
    if (!song.name || !song.singer) return [];

    try {
        // 1. 获取当前自定义源支持解析的平台（支持的平台）
        const list = await fetchCustomSources();
        let supportedPlatforms = null;
        if (Array.isArray(list)) {
            supportedPlatforms = new Set();
            list.forEach(src => {
                if (src.enabled && src.status === 'success' && Array.isArray(src.supportedSources)) {
                    src.supportedSources.forEach(platform => {
                        supportedPlatforms.add(platform);
                    });
                }
            });
        }

        // 2. 切换到和当前不同源，并且根据优先级排列 (网易、QQ、酷我、酷狗、咪咕)
        const baseOrder = ['wy', 'tx'];
        const searchSourcesOrdered = baseOrder.filter(s => s !== song.source);

        // 3. 过滤出自定义源支持解析的平台
        let searchSources = searchSourcesOrdered;
        if (supportedPlatforms && !options.ignoreSupportedFilter) {
            searchSources = searchSourcesOrdered.filter(s => supportedPlatforms.has(s));
        }

        // 4. 如果发现没有其他支持的平台可供切换
        if (searchSources.length === 0) {
            console.log(`[AutoSource] 换源跳过：没有其他自定义源支持的平台。当前源: ${song.source}`);
            if (!isSilent) showError('未找到自定义源下支持的平台下的对应歌曲');
            return [];
        }

        const query = `${song.name} ${song.singer}`;
        const headers = { 'Content-Type': 'application/json' };
        Object.assign(headers, getUserAuthHeaders());

        if (!isSilent) showInfo('正在自动尝试换源匹配...');

        const searchPromises = searchSources.map(s =>
            fetch(`${API_BASE}/search?name=${encodeURIComponent(query)}&source=${s}&page=1`, { headers })
                .then(res => res.json())
                .then(data => Array.isArray(data) ? data.map(item => ({ ...item, source: s })) : [])
                .catch(() => [])
        );

        const allResults = await Promise.all(searchPromises);
        const flatResults = allResults.flat();

        if (flatResults.length === 0) return [];

        const matches = [];

        // 匹配算法
        for (const item of flatResults) {
            const score = getSongMatchScore(item, song);
            if (score < 0) continue;

            const durationDiff = getSongDurationDiff(item, song);
            console.log(`[AutoSource] 匹配成功: ${item.name} via ${item.source} (score: ${score}, 时长误差: ${durationDiff === null ? '未知' : `${durationDiff}s`})`);
            matches.push({ ...item, _matchScore: score });
        }

        if (matches.length === 0) {
            console.log(`[AutoSource] 未找到合适的匹配结果 (Total searched: ${flatResults.length})`);
        }
        return matches.sort((a, b) => (b._matchScore || 0) - (a._matchScore || 0));
    } catch (e) {
        console.warn('[AutoSource] 匹配逻辑执行出错:', e);
        return [];
    }
}

/**
 * 辅助：将 mm:ss 转换为秒数
 */
function timeToSeconds(timeStr) {
    if (!timeStr || !timeStr.includes(':')) return 0;
    const parts = timeStr.split(':');
    if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }
    return 0;
}

/**
 * 辅助：获取源名称
 */
function getSourceName(source) {
    const names = { tx: 'QQ', wy: '网易' };
    return names[source] || source.toUpperCase();
}

/**
 * 从服务端缓存播放地址提取播放触达所需的信息。
 * 服务端缓存地址中的文件名可能包含子目录，整个文件名会先被
 * encodeURIComponent，所以这里不能只按普通 URL path 分段解码。
 */
function getServerCacheFileDescriptor(url, location = '') {
    if (!url || typeof url !== 'string') return null;
    const prefix = '/api/music/cache/file/';
    try {
        const parsed = new URL(url, window.location.origin);
        if (!parsed.pathname.startsWith(prefix)) return null;

        const encodedTarget = parsed.pathname.slice(prefix.length);
        const separator = encodedTarget.indexOf('/');
        const encodedUsername = separator >= 0 ? encodedTarget.slice(0, separator) : '';
        const encodedFilename = separator >= 0 ? encodedTarget.slice(separator + 1) : encodedTarget;
        const folder = parsed.searchParams.get('folder');
        if (!encodedFilename || (folder !== 'cache' && folder !== 'music')) return null;

        return {
            username: encodedUsername ? decodeURIComponent(encodedUsername) : '_open',
            filename: decodeURIComponent(encodedFilename),
            folder,
            location,
        };
    } catch (_) {
        return null;
    }
}

/**
 * 统一应用代理逻辑，处理 HTTPS 环境下的 HTTP 链接及跨域限制 (CORS) 问题
 * 增强：开启自动代理后，通过探测链接可用性（包括跨域兼容性）来自动决定是否启用服务器代理
 */
async function applyAutoProxy(url, song) {
    if (!url) return url;

    // 已经过代理或为本地路径的无需处理
    if (url.startsWith('/api/music/download') || url.startsWith('/') || url.includes(window.location.host)) {
        return url;
    }

    // 优先级 1：如果手动开启了“播放音乐代理”，则无条件走代理 (用于解决 IP 封锁或跨域限制)
    if (settings.enableProxyPlayback) {
        console.log(`[Proxy] Forced proxy enabled for: ${song.name}`);
        // 如果同时启用了自定义代理，优先使用（客户端直接请求，不经服务器中转）
        if (settings.enableCustomProxy && settings.customProxyUrl) {
            const proxyUrl = settings.customProxyUrl.replace('{url}', url);
            console.log(`[Proxy] Custom proxy applied (forced): ${song.name} -> ${proxyUrl}`);
            return proxyUrl;
        }
        const filename = `${song.singer} - ${song.name}.mp3`;
        return `/api/music/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}&inline=1`;
    }

    const isHttpsEnv = window.location.protocol === 'https:';
    const isHttpLink = url.startsWith('http://');

    // 优先级 2：自动检测并处理跨域风险 (CORS) 或 混合内容 (Mixed Content)
    if (settings.enableAutoProxy) {
        // 探测流程：检测该 URL 是否能被当前浏览器直接访问
        // 如果是 HTTPS 环境下的 HTTP 链接，先尝试升级 https 探测，否则直接探测原链接
        const probeUrl = (isHttpsEnv && isHttpLink) ? url.replace('http://', 'https://') : url;

        console.log(`[Proxy] Auto-proxy evaluating (CORS/Safety probe): ${song.name}`);

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000); // 2秒探测超时

            // 如果此处 fetch 报错（如 CORS policy block），则会进入 catch
            try {
                const response = await fetch(probeUrl, {
                    method: 'GET',
                    headers: { 'Range': 'bytes=0-1' }, // 轻量探测
                    signal: controller.signal
                });
                try { await response.body?.cancel(); } catch (_) { }

                if (response.ok) {
                    console.log(`[Proxy] Probe Success (Direct Play): ${song.name} via ${probeUrl}`);
                    return probeUrl;
                }
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (e) {
            // 探测失败：可能是跨域拦截、证书错误、或者源不支持 HTTPS
            console.warn(`[Proxy] Probe failed (CORS risk or unreachable), falling back to server proxy: ${song.name}`, e.message);
        }

        // 回退逻辑：探测失败后根据设置启用自定义代理或服务器代理
        if (settings.enableCustomProxy && settings.customProxyUrl) {
            const proxyUrl = settings.customProxyUrl.replace('{url}', url);
            console.log(`[Proxy] Custom proxy fallback: ${song.name} -> ${proxyUrl}`);
            return proxyUrl;
        }

        console.log(`[Proxy] Server proxy fallback: ${song.name}`);
        const filename = `${song.singer} - ${song.name}.mp3`;
        return `/api/music/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}&inline=1`;
    }

    return url;
}

function buildServerPlaybackProxyUrl(url, song) {
    if (!/^https?:\/\//i.test(String(url || ''))) return null;
    const filename = `${song?.singer || 'unknown'} - ${song?.name || 'download'}.mp3`;
    return `/api/music/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}&inline=1`;
}

async function fetchSongUrl(song, quality, isRetry = false, isSilent = false) {
    const cleanedSong = cleanSongData(song);
    const cacheKey = `lx_url_${cleanedSong.id}_${quality}`;

    // 0. 本地文件/带有本地播放 URL 的歌曲：直接播放本地文件，无需走在线 API 解析
    if ((song.isLocal || song.url?.startsWith('/api/music/cache/file/')) && song.url && !isRetry) {
        console.log(`[Cache] Direct Local File Hit: ${song.name}`);
        let localUrl = await applyAutoProxy(song.url, song);
        return {
            url: localUrl,
            sourceType: 'server_cache',
            quality: song.quality || quality,
            cacheFile: getServerCacheFileDescriptor(localUrl),
        };
    }

    const shouldBypassServerCache = isRetry === 'local_retry' || isRetry === 'download';

    const allowServerCache = settings.preferServerCache !== false &&
        !shouldBypassServerCache &&
        !isServerCacheTemporarilyBypassed(cleanedSong, quality);
    if (allowServerCache) {
        let cacheResult = await checkServerCache(cleanedSong, quality, !!isRetry);
        if (cacheResult.exists && !cacheResult.isCollision) {
            const actualQuality = cacheResult.quality || quality;
            console.log(`[Cache] Server Hit: ${cleanedSong.name} (${actualQuality})`);
            let serverCacheUrl = cacheResult.url;
            // 应用代理逻辑 (以防服务器缓存返回的是原始 HTTP 链接)
            serverCacheUrl = await applyAutoProxy(serverCacheUrl, song);
            return {
                url: serverCacheUrl,
                sourceType: 'server_cache',
                quality: actualQuality,
            cacheFile: getServerCacheFileDescriptor(serverCacheUrl, cacheResult.location),
            };
        }
    }

    const allowLinkCache = !isRetry && settings.enableSongUrlCache !== false;
    if (allowLinkCache) {
        let cachedUrl = localStorage.getItem(cacheKey);
        if (cachedUrl) {
            console.log(`[Cache] Link Hit: ${cleanedSong.name} (${quality})`);
            const rawUrl = cachedUrl;
            cachedUrl = await applyAutoProxy(cachedUrl, song);
            if (settings.enableServerCache && !isSilent && isRetry !== 'download' && !rawUrl.includes('/api/music/cache/file/')) {
                triggerServerCache(song, rawUrl, quality);
            }
            return {
                url: cachedUrl,
                playbackProxyUrl: buildServerPlaybackProxyUrl(rawUrl, song),
                sourceType: 'cache',
                quality,
            };
        }
    }

    const reqId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let progressEs = null;
    try {
        progressEs = new EventSource(`/api/music/progress?reqId=${reqId}`);
        progressEs.onmessage = (e) => {
            if (isSilent) return;
            try {
                const attempt = JSON.parse(e.data);
                const songNamePrefix = attempt.name || song.name || '';
                const msg = `[${songNamePrefix}] ${attempt.message || (attempt.status === 'success' ? '解析成功' : '解析失败')}`;
                if (attempt.status === 'success') showSuccess(msg);
                else showError(msg);
            } catch (_) { }
        };
    } catch (_) { }

    const headers = { 'Content-Type': 'application/json' };
    // 携带认证信息 (Token 或密码)
    Object.assign(headers, getUserAuthHeaders());
    headers['x-req-id'] = reqId;

    // [Fix] 给予 SSE 连接极短的建连时间，确保并发请求下后端能优先捕获到 SSE 客户端
    await new Promise(r => setTimeout(r, 50));

    try {
        const res = await fetch(`${API_BASE}/url`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                songInfo: song,
                quality,
                enableAutoSwitchApiSource: settings.enableAutoSwitchApiSource !== false
            })
        });

        if (!res.ok) {
            let errorMsg = `HTTP ${res.status}`;
            let result = {};
            try {
                result = await res.json();
                if (result.message || result.error) errorMsg = result.message || result.error;
            } catch (e) { }
            throw { message: errorMsg, attempts: result.attempts };
        }

        const result = await res.json();
        if (result.url) {
            // 使用异步统一代理函数
            const finalUrl = await applyAutoProxy(result.url, song);

            if (settings.enableSongUrlCache !== false) {
                try {
                    localStorage.setItem(cacheKey, finalUrl);
                    updateStorageStatsUI();
                } catch (e) { }
            }
            if (settings.enableServerCache && !isSilent && isRetry !== 'download' && !finalUrl.includes('/api/music/cache/file/')) {
                // [Fix] 传递原始 result.url 而非经过 applyAutoProxy 处理后的相对代理路径，
                // 否则后端下载器会因无法识别相对路径而报 ERR_INVALID_URL 错误。
                triggerServerCache(song, result.url, quality);
            }
            console.log(`[Resolve] Online Success: ${song.name} via ${result.sourceName || 'Unknown'}`);
            return {
                url: finalUrl,
                // If a direct media request is rejected by the browser, keep a
                // streamable server fallback without making the first play wait
                // for the background cache file to finish.
                playbackProxyUrl: buildServerPlaybackProxyUrl(result.url, song),
                sourceType: 'normal',
                quality: result.type || quality,
                sourceName: result.sourceName,
                requestedSource: result.requestedSource || song.source,
                downloadSource: result.downloadSource || song.source,
                songInfo: song,
                errorMsg: result.errorMsg
            };
        }
        throw new Error('服务器未返回播放链接');
    } finally {
        if (progressEs) { progressEs.close(); progressEs = null; }
    }
}

let shufflePool: number[] = [];
let lastPlaylistFingerprint = '';

function getPlaylistFingerprint(list: any[]): string {
    if (!list || list.length === 0) return '';
    return `${list.length}_${list[0]?.id || ''}_${list[list.length - 1]?.id || ''}`;
}

function getNextIndex(isManual = false) {
    if (!currentPlaylist || currentPlaylist.length === 0) return -1;

    // [Random Prefetch Fix] 如果处于随机播放模式，且已有预选内容，优先返回预选（仅自动播放时采用预选）
    if (context.getPlayMode() === 'random' && !isManual && context.getPreSelectedNextIndex() !== null) {
        if (context.getPreSelectedNextIndex() >= 0 && context.getPreSelectedNextIndex() < currentPlaylist.length) {
            return context.getPreSelectedNextIndex();
        }
        context.setPreSelectedNextIndex(null); // 重置失效索引
    }

    let nextIndex;
    switch (context.getPlayMode()) {
        case 'single':
            if (isManual) {
                // 手动切歌时按顺序切到下一首
                nextIndex = context.getCurrentIndex() + 1;
                if (nextIndex >= currentPlaylist.length) nextIndex = 0;
            } else {
                nextIndex = context.getCurrentIndex();
            }
            break;
        case 'random':
            if (currentPlaylist.length === 1) {
                nextIndex = 0;
            } else {
                const currentFp = getPlaylistFingerprint(currentPlaylist);
                if (currentFp !== lastPlaylistFingerprint) {
                    lastPlaylistFingerprint = currentFp;
                    shufflePool = [];
                }

                // 过滤掉超出范围的索引
                shufflePool = shufflePool.filter(idx => idx >= 0 && idx < currentPlaylist.length);

                // 洗牌池耗尽，重新进行 Fisher-Yates 洗牌填充
                if (shufflePool.length === 0) {
                    const pool: number[] = [];
                    const currentIdx = context.getCurrentIndex();
                    for (let i = 0; i < currentPlaylist.length; i++) {
                        if (i !== currentIdx) pool.push(i);
                    }
                    // Fisher-Yates shuffle
                    for (let i = pool.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        const temp = pool[i];
                        pool[i] = pool[j];
                        pool[j] = temp;
                    }
                    shufflePool = pool;
                }

                nextIndex = shufflePool.pop();
                if (typeof nextIndex !== 'number' || nextIndex < 0 || nextIndex >= currentPlaylist.length) {
                    nextIndex = (context.getCurrentIndex() + 1) % currentPlaylist.length;
                }
            }
            break;
        case 'order':
            nextIndex = context.getCurrentIndex() + 1;
            if (nextIndex >= currentPlaylist.length) return -1;
            break;
        case 'list':
        default:
            nextIndex = context.getCurrentIndex() + 1;
            if (nextIndex >= currentPlaylist.length) nextIndex = 0;
            break;
    }
    return nextIndex;
}

// Prefetch next song helper (Recursive Discovery)
async function prefetchNextSong(startFromIndex = null, depth = 0) {
    if (settings.enablePreloader === false || depth > 5) return;

    let targetIndex = startFromIndex;
    if (targetIndex === null) {
        targetIndex = getNextIndex();
        // [Random Prefetch Fix] 如果是随机模式，且尚未有预选结果，将本次生成的索引存入预选
        if (context.getPlayMode() === 'random' && context.getPreSelectedNextIndex() === null) {
            context.setPreSelectedNextIndex(targetIndex);
        }
    }
    if (targetIndex === -1 || targetIndex === context.getCurrentIndex()) return;

    const nextSong = currentPlaylist[targetIndex];
    if (!nextSong) return;

    // 如果这首已经被标记为不可播放，拉下一首
    const prefetchUnavailableUntil = Number(nextSong._prefetchUnavailableUntil || 0);
    if (prefetchUnavailableUntil > Date.now()) {
        const followingIndex = (targetIndex + 1) >= currentPlaylist.length ? 0 : targetIndex + 1;
        return prefetchNextSong(followingIndex, depth + 1);
    }
    if (prefetchUnavailableUntil) delete nextSong._prefetchUnavailableUntil;

    let prefetchVersion = prefetchManager.version;
    try {
        const targetQual = window.QualityManager.getBestQuality(nextSong, settings.preferredQuality || 'flac');
        const prefetchKey = `${String(nextSong.id)}:${String(targetQual)}`;
        const pending = prefetchManager.inflight.get(prefetchKey);
        if (pending) return pending;

        prefetchVersion = prefetchManager.version;
        const work = (async () => {
            // 1. 检查内存缓存
            let result = prefetchManager.get(nextSong.id, targetQual);
            if (result) {
                if (await probeUrl(result.url)) return;
                prefetchManager.delete(nextSong.id);
            }

            // 2. 复用统一解析逻辑 (resolveSongUrl)，且开启静默模式
            result = await resolveSongUrl(nextSong, targetQual, true);

            // 3. 探活获取到的链接
            if (!(await probeUrl(result.url))) {
                localStorage.removeItem(`lx_url_${cleanSongData(nextSong).id}_${targetQual}`);
                result = await resolveSongUrl(nextSong, targetQual, true, true);
            }

            if (prefetchManager.version !== prefetchVersion) return;
            prefetchManager.set(nextSong.id, { ...result, requestedQuality: targetQual });
            delete nextSong._prefetchUnavailableUntil;
            const sourceDesc = getSourceTypeText(result.sourceType);
            console.log(`[Prefetch] Readied: ${nextSong.name} (${result.quality} / ${sourceDesc})`);
        })();
        prefetchManager.inflight.set(prefetchKey, work);
        try {
            return await work;
        } finally {
            if (prefetchManager.inflight.get(prefetchKey) === work) {
                prefetchManager.inflight.delete(prefetchKey);
            }
        }

    } catch (e) {
        if (prefetchManager.version !== prefetchVersion) return;
        console.warn(`[Prefetch] Skip unplayable [${nextSong.name}]:`, e.message);
        // A transient resolver/network failure must not permanently poison the
        // playlist item. Keep only a short-lived hint for automatic skipping.
        nextSong._prefetchUnavailableUntil = Date.now() + PREFETCH_FAILURE_TTL;

        // 递归探测
        const followingIndex = (targetIndex + 1) >= currentPlaylist.length ? 0 : targetIndex + 1;
        if (followingIndex !== context.getCurrentIndex()) {
            return prefetchNextSong(followingIndex, depth + 1);
        }
    }
}


    const feature = {
        getSourceTypeText,
        getSourceName,
        probeUrl,
        prefetchManager,
        resolveSongUrl,
        resolveDownloadSongUrl,
        findOtherSourceMatch,
        findOtherSourceMatches,
        applyAutoProxy,
        fetchSongUrl,
        buildServerPlaybackProxyUrl,
        markServerCacheFailure,
        getNextIndex,
        prefetchNextSong,
    };
    return feature;
}
