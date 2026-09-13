import {
    escapeHtmlText,
    safeImageUrl,
    safeInlineJson,
    safeInlineString,
} from '../player_security';
import { registerPlayerEventAction } from '../player_events';
import { updatePaginationInfo } from '../legacy/batch_pagination';

export type SearchFeatureContext = {
    getSettings: () => Record<string, any>;
    getCurrentPage: () => number;
    setCurrentPage: (page: number) => void;
    getCurrentListData: () => any;
    getUserAuthHeaders: () => Record<string, string>;
    switchTab: (tabId: string, preserveSearchNavigation?: boolean) => void;
    setCurrentSearchScope: (scope: string) => void;
    loadLibraryData?: (...args: any[]) => any;
    isArtistFavorited?: (...args: any[]) => boolean;
    isAlbumFavorited?: (...args: any[]) => boolean;
    updateAlbumLibraryMeta?: (...args: any[]) => any;
    renderLibraryArtists: (...args: any[]) => any;
    renderLibraryAlbums: (...args: any[]) => any;
    playFromView: (index: number) => any;
    showInfo: (...args: any[]) => any;
    showError: (...args: any[]) => any;
};

export function initSearchFeature(context: SearchFeatureContext) {
    const API_BASE = '/api/music';
    const settings = new Proxy<Record<string, any>>({}, {
        get: (_target, property) => context.getSettings()?.[property],
        set: (_target, property, value) => {
            const current = context.getSettings();
            if (current) current[property] = value;
            return true;
        },
    });
    const pageState = {
        get value() {
            return context.getCurrentPage();
        },
        set value(value: number) {
            context.setCurrentPage(value);
        },
    };
    const switchTab = context.switchTab;
    const setCurrentSearchScope = context.setCurrentSearchScope;
    const getUserAuthHeaders = context.getUserAuthHeaders;
    const showInfo = context.showInfo;
    const showError = context.showError;
    const loadLibraryData = (...args: any[]) => context.loadLibraryData?.(...args);
    const isArtistFavorited = (...args: any[]) => typeof context.isArtistFavorited === 'function'
        ? context.isArtistFavorited(...args)
        : false;
    const isAlbumFavorited = (...args: any[]) => typeof context.isAlbumFavorited === 'function'
        ? context.isAlbumFavorited(...args)
        : false;
    const updateAlbumLibraryMeta = (...args: any[]) => context.updateAlbumLibraryMeta?.(...args);
    const renderLibraryArtists = context.renderLibraryArtists;
    const renderLibraryAlbums = context.renderLibraryAlbums;
    const playFromView = context.playFromView;
    const hideSearchSuggestions = () => (window as any).hideSearchSuggestions?.();
    let currentSearch = { name: '', source: 'wy' };
    let lastRenderedSearchKey: string | null = null;
    let hotSearchStateSerial = 0;

    function getSearchStateKey() {
        const input = document.getElementById('search-input') as HTMLInputElement | null;
        const type = document.getElementById('search-type') as HTMLSelectElement | null;
        const source = document.getElementById('search-source') as HTMLSelectElement | null;
        return [
            String(window.currentSearchScope || 'network'),
            String(type?.value || 'song'),
            String(source?.value || 'wy'),
            input?.value.trim() || '',
        ].join('|');
    }

    function hasSearchContent() {
        const container = document.getElementById('search-results');
        return Boolean(container?.children.length && !container.querySelector('.fa-spinner'));
    }

    function getCurrentLocalSongList() {
        const listData = context.getCurrentListData();
        if (!listData) return [];

        if (window.currentSearchScope === 'local_all') {
            return [
                ...(Array.isArray(listData.defaultList) ? listData.defaultList : []),
                ...(Array.isArray(listData.loveList) ? listData.loveList : []),
                ...(Array.isArray(listData.userList) ? listData.userList : []).flatMap(list =>
                    Array.isArray(list?.list) ? list.list : []
                ),
            ];
        }

        const listId = String(window.currentViewingListId || 'default');
        if (listId === 'default') return Array.isArray(listData.defaultList) ? listData.defaultList : [];
        if (listId === 'love') return Array.isArray(listData.loveList) ? listData.loveList : [];

        const userList = (Array.isArray(listData.userList) ? listData.userList : [])
            .find(list => String(list?.id) === listId);
        return Array.isArray(userList?.list) ? userList.list : [];
    }

    function ensureSearchContent() {
        const input = document.getElementById('search-input') as HTMLInputElement | null;
        if (!input?.value.trim()) return;

        const stateKey = getSearchStateKey();
        if (lastRenderedSearchKey === stateKey && hasSearchContent()) return;
        if (searchRequestController && !searchRequestController.signal.aborted) return;
        void doSearch();
    }

    const applyArtistFavoriteToggle = async (element, args) => {
        const [id, source, name, image] = args.map(String);
        const toggle = (window as any).toggleArtistFavorite;
        if (typeof toggle !== 'function') return;
        const favorited = await toggle(id, source, name, image);
        const button = element as HTMLButtonElement;
        const isHeader = button.id === 'artist-header-fav-btn';
        button.className = isHeader
            ? `absolute top-2 right-12 md:top-4 md:right-16 w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-full transition-all z-30 shadow-sm active:scale-90 ${favorited ? 'bg-rose-500 text-white' : 'bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 t-text-main'}`
            : `search-result-favorite-btn absolute -top-1 -right-1 w-6 h-6 md:w-7 md:h-7 rounded-full flex items-center justify-center transition-all shadow-md z-10 ${favorited ? 'bg-rose-500 text-white opacity-100' : 'bg-black/30 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}`;
        button.title = favorited ? '取消收藏' : '收藏歌手';
        button.setAttribute('aria-label', favorited ? '取消收藏' : '收藏歌手');
    };

    registerPlayerEventAction('search-toggle-artist-favorite', async (_event, element, args) => {
        await applyArtistFavoriteToggle(element, args);
    });

    const applyAlbumFavoriteToggle = async (element, args) => {
        const [id, source, name, image, artistName] = args.map(String);
        const toggle = (window as any).toggleAlbumFavorite;
        if (typeof toggle !== 'function') return;
        const favorited = await toggle(id, source, name, image, artistName);
        const button = element as HTMLButtonElement;
        button.className = `search-result-favorite-btn absolute top-1.5 right-1.5 w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-sm ${favorited ? 'bg-rose-500 text-white opacity-100' : 'bg-black/30 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}`;
        button.title = favorited ? '取消收藏' : '收藏专辑';
        button.setAttribute('aria-label', favorited ? '取消收藏' : '收藏专辑');
    };

    registerPlayerEventAction('search-toggle-album-favorite', async (_event, element, args) => {
        await applyAlbumFavoriteToggle(element, args);
    });

    registerPlayerEventAction('search-row-activate', (_event, _element, args) => {
        const [itemId, index] = args;
        const playerWindow = window as any;
        if (playerWindow.batchMode) {
            playerWindow.handleBatchSelect?.(itemId, !playerWindow.selectedItems?.has(String(itemId)));
        } else {
            playFromView(Number(index));
        }
    });

function handleSearchKeyPress(e) {
    if (e.key === 'Enter') {
        if (typeof hideSearchSuggestions === 'function') hideSearchSuggestions();
        doSearch();
    }
}

function updateHeaderAppearanceIcon() {
    const icon = document.getElementById('header-theme-icon');
    if (!icon) return;
    const currentAttr = document.documentElement.getAttribute('data-appearance');
    const isDark = currentAttr === 'dark' || (!currentAttr && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (isDark) {
        icon.className = 'fas fa-sun text-sm text-amber-400';
    } else {
        icon.className = 'fas fa-moon text-sm text-gray-600';
    }
}
(window as any).updateHeaderAppearanceIcon = updateHeaderAppearanceIcon;

function toggleHeaderAppearance() {
    const currentAttr = document.documentElement.getAttribute('data-appearance');
    const isDark = currentAttr === 'dark' || (!currentAttr && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const targetMode = isDark ? 'light' : 'dark';
    if (typeof (window as any).setAppearance === 'function') {
        (window as any).setAppearance(targetMode);
    } else {
        document.documentElement.setAttribute('data-appearance', targetMode);
        localStorage.setItem('lx_appearance', targetMode);
    }
    updateHeaderAppearanceIcon();
}
(window as any).toggleHeaderAppearance = toggleHeaderAppearance;



/**
 * 快速跳转到搜索页并执行查询
 * @param {string} query 搜索关键词
 * @param {string} source 可选，切换到指定搜索源
 */
function performSearch(query, source = null, type = 'song') {
    if (!query || query === '暂无播放' || query === '选择一首歌曲播放') return;

    // 预处理：移除括号及其内容 (支持中英文括号)，通常用于移除“歌曲名 (DJ版)”中的补充信息
    let cleanedQuery = query.replace(/\s*[\(\uff08].*?[\)\uff09]\s*/g, ' ').trim();
    // 避免因为移除内容导致的连续多余空格
    cleanedQuery = cleanedQuery.replace(/\s+/g, ' ');

    // 切换到搜索页
    switchTab('search');

    // 如果指定了源且属于支持的源，则更新选择框
    const sourceEl = document.getElementById('search-source');
    const typeEl = document.getElementById('search-type');
    const validSources = ['wy', 'tx'];
    const searchType = ['song', 'singer', 'album'].includes(type) ? type : 'song';
    if (typeEl) {
        typeEl.value = searchType;
        const customSelectManager = (window as any).CustomSelectManager;
        if (typeof customSelectManager?.syncUI === 'function') customSelectManager.syncUI(typeEl);
    }
    if (source && sourceEl && validSources.includes(source)) {
        sourceEl.value = source;
    }
    if ((searchType === 'singer' || searchType === 'album') && sourceEl && !['wy', 'tx'].includes(sourceEl.value)) {
        sourceEl.value = 'wy';
    }
    applySearchTypeSourceRestrictions();

    // 重置搜索范围到全网搜索
    if (typeof window.currentSearchScope !== 'undefined') {
        setCurrentSearchScope('network');
    }

    // 设置搜索框内容
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = cleanedQuery || query; // 如果清理后为空，回退到原查询
        // 触发搜索
        doSearch();
    }
}
window.performSearch = performSearch;

let lastSearchResultList = null;
let lastSearchType = null;

function handleSearchTypeChange() {
    applySearchTypeSourceRestrictions();
    doSearch();
}

function applySearchTypeSourceRestrictions() {
    const typeSelect = document.getElementById('search-type');
    const sourceSelect = document.getElementById('search-source');
    if (!typeSelect || !sourceSelect) return;

    if (typeSelect.value === 'singer' || typeSelect.value === 'album') {
        // 只有 wy 和 tx 支持歌手/专辑搜索
        if (sourceSelect.value !== 'wy' && sourceSelect.value !== 'tx') {
            sourceSelect.value = 'wy';
        }
        // 禁用不支持的选项
        Array.from(sourceSelect.options).forEach(opt => {
            opt.disabled = (opt.value !== 'wy' && opt.value !== 'tx');
        });
    } else {
        Array.from(sourceSelect.options).forEach(opt => { opt.disabled = false; });
    }

    const customSelectManager = (window as any).CustomSelectManager;
    if (typeof customSelectManager?.syncUI === 'function') customSelectManager.syncUI(sourceSelect);
}
window.handleSearchTypeChange = handleSearchTypeChange;

const SOURCES = ['wy', 'tx'];

type SearchRequestContext = {
    serial: number;
    controller: AbortController;
};

let searchRequestSerial = 0;
let searchRequestController: AbortController | null = null;
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

function beginSearchRequest(): SearchRequestContext {
    searchRequestController?.abort();
    const controller = new AbortController();
    searchRequestController = controller;
    return { serial: ++searchRequestSerial, controller };
}

function invalidateSearchRequest() {
    searchRequestController?.abort();
    searchRequestController = null;
    searchRequestSerial += 1;
    if (prefetchTimer !== null) {
        clearTimeout(prefetchTimer);
        prefetchTimer = null;
    }
}

function isSearchRequestCurrent(request: SearchRequestContext) {
    return request.serial === searchRequestSerial && !request.controller.signal.aborted;
}

type AlbumRequestContext = {
    serial: number;
    controller: AbortController;
    id: string;
    source: string;
};

let albumRequestSerial = 0;
let albumRequestController: AbortController | null = null;

function beginAlbumRequest(id, source): AlbumRequestContext {
    albumRequestController?.abort();
    const controller = new AbortController();
    albumRequestController = controller;
    return { serial: ++albumRequestSerial, controller, id: String(id), source: String(source) };
}

function invalidateAlbumRequest() {
    albumRequestController?.abort();
    albumRequestController = null;
    albumRequestSerial += 1;
}

function isAlbumRequestCurrent(request: AlbumRequestContext) {
    return request.serial === albumRequestSerial
        && !request.controller.signal.aborted
        && String(window.currentAlbumId) === request.id
        && String(window.currentAlbumSource) === request.source;
}

let searchDetailOpen = false;

type SearchDetailHistoryState = {
    page: 'search-detail';
    kind: 'artist' | 'album';
    id: string;
    source: string;
    order?: string;
    tab?: string;
};

function syncSearchDetailHeaderVisibility() {
    const header = document.getElementById('search-results-header');
    if (header) header.classList.toggle('hidden', searchDetailOpen);
    const paginationBar = document.getElementById('search-pagination-bar');
    if (paginationBar) paginationBar.classList.toggle('hidden', searchDetailOpen);
}

function setSearchDetailOpen(value: boolean) {
    searchDetailOpen = value;
    syncSearchDetailHeaderVisibility();
    if (!value) {
        document.getElementById('search-results')?.classList.remove('artist-detail-active');
    }
}

function renderTrackListHeader({ includeBackToolbar = false, extraClass = '' } = {}) {
    const backToolbar = includeBackToolbar ? `
        <div class="player-detail-list-toolbar flex items-center gap-2 px-1 pt-1">
            <button type="button" data-event-click-action="goBackToSearch"
                class="list-header-back t-text-muted hover:t-text-main hover:t-bg-track rounded-lg transition-colors"
                title="返回列表" aria-label="返回列表">
                <i class="fas fa-arrow-left text-xs" aria-hidden="true"></i>
                <span class="text-xs font-medium">返回列表</span>
            </button>
        </div>
    ` : '';

    return backToolbar;
}

//搜索歌曲
async function doSearch(page = 1, append = false, prefetch = false) {
    if (prefetch && searchDetailOpen) return;
    if (!append) (window as any).resetSharedBatchSelection?.();
    hotSearchStateSerial += 1;
    if (!prefetch) {
        setSearchDetailOpen(false);
        if (window.history.state?.page === 'search-detail') {
            window.history.replaceState({ page: 'search' }, '');
        }
    }
    invalidateSearchRequest();
    invalidateAlbumRequest();
    const typeEl = document.getElementById('search-type');
    const type = typeEl ? typeEl.value : 'song';

    // 触发搜索时隐藏联想词
    if (typeof hideSearchSuggestions === 'function') hideSearchSuggestions();

    // 新搜索开始，隐藏返回按钮并清空记录
    const backBtn = document.getElementById('search-back-btn');
    if (backBtn) backBtn.classList.add('hidden');
    lastSearchResultList = null;
    lastSearchType = null;

    // 只有在开启全新搜索（第一页且非追加模式）时才重置局部过滤状态
    if (window.ListSearch && page === 1 && !append) window.ListSearch.resetState();

    const input = document.getElementById('search-input').value.trim();
    const resultsContainer = document.getElementById('search-results');

    // Local Search Logic
    const isLibrarySearch = window.currentSearchScope === 'lib_artists' || window.currentSearchScope === 'lib_albums';
    const isLocalSongSearch = type === 'song' && (window.currentSearchScope === 'local_list' || window.currentSearchScope === 'local_all');

    if (isLibrarySearch || isLocalSongSearch) {
        const localSongList = isLocalSongSearch ? getCurrentLocalSongList() : [];
        if (!input) {
            if (window.currentSearchScope === 'lib_artists') renderLibraryArtists((window as any).getActiveLibraryList?.('artists') || window.libraryData.artists);
            else if (window.currentSearchScope === 'lib_albums') renderLibraryAlbums((window as any).getActiveLibraryList?.('albums') || window.libraryData.albums);
            else renderResults(localSongList);
            return;
        }

        let targets = [];
        if (window.currentSearchScope === 'lib_artists') targets = (window as any).getActiveLibraryList?.('artists') || window.libraryData.artists;
        else if (window.currentSearchScope === 'lib_albums') targets = (window as any).getActiveLibraryList?.('albums') || window.libraryData.albums;
        else {
            targets = localSongList;
        }

        const lower = input.toLowerCase();
        const filtered = (Array.isArray(targets) ? targets : []).filter(item =>
            (item.name && item.name.toLowerCase().includes(lower)) ||
            (item.singer && item.singer.toLowerCase().includes(lower)) ||
            (item.artistName && item.artistName.toLowerCase().includes(lower)) ||
            (item.id && String(item.id).toLowerCase().includes(lower))
        );

        if (window.currentSearchScope === 'lib_artists') renderLibraryArtists(filtered);
        else if (window.currentSearchScope === 'lib_albums') renderLibraryAlbums(filtered);
        else renderResults(filtered);
        lastRenderedSearchKey = getSearchStateKey();
        return;
    }

    // Network Search Logic
    const source = document.getElementById('search-source').value;
    const SEARCH_PAGE_SIZE = 20;
    const SEARCH_RESULT_LIMIT = 99;
    const fetchPages = type === 'song' ? (append ? (prefetch ? 3 : 1) : 5) : 1;
    const requestSearchKey = getSearchStateKey();

    // 保存到缓存
    localStorage.setItem('search-source', source);

    if (!input) {
        showInitialSearchState();
        return;
    }

    const request = beginSearchRequest();

    if (!append) {
        currentSearch = { name: input, source };
        pageState.value = 1;
        window.currentNetworkPage = page;
        resultsContainer.innerHTML = '<div class="flex items-center justify-center h-full"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';
    } else {
        window.currentNetworkPage = page;
    }

    try {
        const headers = {};
        Object.assign(headers, getUserAuthHeaders());

        let list = [];
        if (source === 'all') {
            // Aggregate Search (Only supported for songs)
            const pageInfoEl = document.getElementById('page-info');
            if (pageInfoEl) pageInfoEl.innerText = `聚合搜索 (前20条/源)`;

            const promises = SOURCES.map(s =>
                fetch(`${API_BASE}/search?name=${encodeURIComponent(input)}&source=${s}&page=1&type=${type}`, {
                    headers,
                    signal: request.controller.signal,
                })
                    .then(res => res.json())
                    .then(data => data.map(item => ({ ...item, source: s })))
                    .catch(e => {
                        console.warn(`[聚合搜索] ${s} 源失败:`, e);
                        return [];
                    })
            );
            const results = await Promise.all(promises);
            list = results.flat();
            (window as any).searchHasMore = false;
        } else {
            // Single Source Search — 支持前端决定拉取多少页
            const res = await fetch(`${API_BASE}/search?name=${encodeURIComponent(input)}&source=${source}&type=${type}&page=${page}&pages=${fetchPages}&limit=${SEARCH_RESULT_LIMIT}`, {
                headers,
                signal: request.controller.signal,
            });

            if (!res.ok) {
                throw new Error(`搜索请求失败: ${res.status} ${res.statusText}`);
            }

            const data = await res.json();

            // 检查返回的数据是否为数组
            if (!Array.isArray(data)) {
                console.error('[Search] 后端返回非数组数据:', data);
                throw new Error(data.error || data.message || '搜索返回的数据格式错误');
            }

            list = data.map(item => ({ ...item, source }));
            const minimumPageResult = append ? SEARCH_PAGE_SIZE : SEARCH_RESULT_LIMIT;
            (window as any).searchHasMore = list.length >= minimumPageResult;
        }

        // 进入专辑/歌手详情后，旧搜索请求即使晚返回也不能覆盖详情页。
        if (!isSearchRequestCurrent(request)) return;
        window.currentNetworkPage = page + fetchPages - 1;

        // song/singer/album 统一支持 append 追加翻页
        if (append && (type === 'song' || type === 'singer' || type === 'album')) {
            // [Fix] Ensure each new song has unique ID
            if (list && list.length > 0) {
                list.forEach((item, idx) => {
                    if (!item.id || item.id === 'undefined') {
                        item.id = item.songmid || item.songId || item.hash || item.copyrightId || item.mid || item.mediaMid || `temp_${Date.now()}_${idx}_append`;
                    }
                });
            }
            const existingIds = new Set((window.viewingPlaylist || []).map(item => String(item.id)));
            const newItems = list.filter(item => !existingIds.has(String(item.id)));

            if (newItems.length > 0) {
                const combinedList = [...(window.viewingPlaylist || []), ...newItems];
                if (!prefetch) pageState.value++;
                if (type === 'singer') renderSingerResults(combinedList);
                else if (type === 'album') renderAlbumResults(combinedList);
                else renderResults(combinedList);
            } else {
                (window as any).searchHasMore = false;
                updatePaginationInfo(0, 0, (window.viewingPlaylist || []).length, pageState.value, Math.max(1, pageState.value));
                showInfo('没有更多搜索结果了');
            }
        } else {
            if (type === 'singer') renderSingerResults(list);
            else if (type === 'album') renderAlbumResults(list);
            else renderResults(list);
        }
        if (getSearchStateKey() === requestSearchKey) {
            lastRenderedSearchKey = requestSearchKey;
        }
    } catch (e) {
        if (e?.name === 'AbortError' || !isSearchRequestCurrent(request)) return;
        console.error('[Search] 搜索失败:', e);
        if (append) {
            try {
                showError(`搜索追加出错: ${e.message}`);
            } catch (err) {
                showError(`搜索追加出错: ${e.message}`);
            }
        } else {
            resultsContainer.innerHTML = `<div class="text-center text-red-500 p-8">搜索出错: ${escapeHtmlText(e.message)}</div>`;
        }
    }
}

function changePage(delta) {
    const source = document.getElementById('search-source').value;
    if (source === 'all') {
        showInfo('聚合搜索模式暂不支持翻页');
        return;
    }
    const newPage = pageState.value + delta;
    if (newPage < 1) return;
    doSearch(newPage);
}

// ========== 热搜功能 ==========
let hotSearchCache = null;
let hotSearchCacheTime = 0;
const HOT_SEARCH_CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

async function fetchHotSearch(source = 'wy') {
    // 检查缓存（必须匹配 source）
    if (hotSearchCache &&
        hotSearchCache.source === source && // Add checking source
        Date.now() - hotSearchCacheTime < HOT_SEARCH_CACHE_DURATION) {
        return hotSearchCache;
    }

    try {
        // [优化] 使用低优先级 fetch 获取热搜，避免阻塞主加载
        const res = await fetch(`${API_BASE}/hotSearch?source=${source}`, { priority: 'low' });
        if (!res.ok) {
            throw new Error(`获取热搜失败: ${res.status}`);
        }
        const data = await res.json();

        // 更新缓存
        hotSearchCache = data;
        // Ensure data also carries the source info if not present
        if (!hotSearchCache.source) hotSearchCache.source = source;

        hotSearchCacheTime = Date.now();

        return data;
    } catch (e) {
        console.error('[HotSearch] 获取热搜失败:', e);
        return null;
    }
}

function renderHotSearch(data) {
    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');
    if (!container) return;

    // 隐藏表头
    if (header) {
        header.classList.add('hidden');
    }

    // [Fix] If limit is 0, treat as disabled and show default state
    if (!data || !data.list || data.list.length === 0 || settings.hotSearchLimit === 0) {
        // 显示默认空白状态
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full t-text-muted space-y-4">
                <i class="fas fa-music text-6xl opacity-20"></i>
                <p>输入关键词开始搜索音乐</p>
            </div>
        `;
        lastRenderedSearchKey = getSearchStateKey();
        return;
    }

    const sourceTag = getSourceTag(data.source);
    // [Fix] Correctly handle 0, do not fall back to 20 if 0 is set
    const limit = (settings.hotSearchLimit !== undefined && settings.hotSearchLimit !== null) ? settings.hotSearchLimit : 20;
    const keywords = data.list.slice(0, limit); // 使用设置的数量

    container.innerHTML = `
        <div class="hot-search-container px-4 py-8 md:p-8">
            <div class="flex items-center mb-6">
                <i class="fas fa-fire text-orange-500 text-2xl mr-3"></i>
                <h3 class="text-xl font-bold t-text-main">热门搜索</h3>
                <span class="ml-3">${sourceTag}</span>
            </div>
            <div class="hot-search-list grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 md:gap-3">
                ${keywords.map((keyword, index) => {
                    const keywordText = String(keyword ?? '');
                    const escapedKeyword = escapeHtmlText(keywordText);
                    return `
                    <button data-event-click-action="handleHotSearchClick" data-event-click-args="[${safeInlineString(keywordText)}]"
                            class="hot-search-item player-motion-item group flex items-center px-2.5 py-3 md:p-3 t-bg-panel hover:bg-emerald-50 border t-border-main hover:border-emerald-400 rounded-lg transition-all shadow-sm hover:shadow-md overflow-hidden h-14" style="--player-motion-index: ${Math.min(index, 7)};">
                        <span class="rank flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold mr-3 ${index < 3 ? 'bg-gradient-to-r from-orange-400 to-red-500 text-white' : 'bg-gray-100 text-gray-500'
        }">
                            ${index + 1}
                        </span>
                        <span class="keyword flex-1 text-left text-sm font-medium t-text-main group-hover:text-emerald-600 truncate">
                            ${escapedKeyword}
                        </span>
                        <i class="fas fa-search text-xs text-gray-300 group-hover:text-emerald-500 transition-colors ml-2"></i>
                    </button>
                `}).join('')}
            </div>
            <div class="mt-6 text-center">
                <button data-event-click-action="showInitialSearchState"
                        class="text-sm t-text-muted hover:text-emerald-500 transition-colors">
                    <i class="fas fa-sync-alt mr-1"></i>
                    刷新热搜
                </button>
            </div>
        </div>
    `;
    lastRenderedSearchKey = getSearchStateKey();

    // 动态检测溢出并应用滚动效果
    setTimeout(() => {
        const items = container.querySelectorAll('.hot-search-item .keyword');
        items.forEach(el => {
            if (el.scrollWidth > el.clientWidth) {
                const text = el.textContent.trim();
                el.classList.remove('truncate');
                // 使用 mask-image 实现渐变列表
                el.innerHTML = `
                    <div class="w-full overflow-hidden relative" style="mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%); -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);">
                        <div class="inline-block whitespace-nowrap animate-marquee hover-scroll-paused" style="will-change: transform;">
                             <span>${escapeHtmlText(text)}</span>
                             <span class="mx-8"></span>
                             <span>${escapeHtmlText(text)}</span>
                             <span class="mx-8"></span>
                        </div>
                    </div>
                `;
            }
        });
    }, 0);
}

function handleHotSearchClick(keyword) {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = keyword;
        doSearch();
    }
}

function showInitialSearchState() {
    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');
    if (!container) return;

    const requestSerial = ++hotSearchStateSerial;
    invalidateSearchRequest();
    lastRenderedSearchKey = null;
    document.getElementById('search-pagination-bar')?.classList.add('hidden');

    // 隐藏表头
    if (header) {
        header.classList.add('hidden');
    }

    // 显示加载状态
    container.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full t-text-muted space-y-4">
            <i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i>
            <p>正在加载热门搜索...</p>
        </div>
    `;

    // 异步获取并显示热搜
    const sourceSelect = document.getElementById('search-source');
    const source = sourceSelect ? sourceSelect.value : 'wy';

    fetchHotSearch(source).then(data => {
        const input = document.getElementById('search-input') as HTMLInputElement | null;
        if (requestSerial !== hotSearchStateSerial || input?.value.trim()) return;
        renderHotSearch(data);
    }).catch(err => {
        if (requestSerial !== hotSearchStateSerial) return;
        console.error('[HotSearch] 显示热搜失败:', err);
        // 失败时显示默认状态
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center h-full t-text-muted space-y-4">
                <i class="fas fa-music text-6xl opacity-20"></i>
                <p>输入关键词开始搜索音乐</p>
            </div>
        `;
        lastRenderedSearchKey = getSearchStateKey();
    });
}


function getQualityTags(item) {
    const resolvedQuality = item.quality || item.type;
    if (resolvedQuality) {
        const badgeLabel = window.QualityManager?.getQualityBadgeLabel
            ? window.QualityManager.getQualityBadgeLabel(resolvedQuality)
            : String(resolvedQuality).toUpperCase();
        const badgeClass = window.QualityManager?.getQualityBadgeClass
            ? window.QualityManager.getQualityBadgeClass(resolvedQuality)
            : 'badge-quality-runtime';
        return `<span class="${badgeClass} flex-shrink-0">${escapeHtmlText(badgeLabel)}</span>`;
    }

    const tags = [];
    // 兼容多种音质字段位置:
    // 1. types / _types (旧版/部分源)
    // 2. qualitys / _qualitys (新版/标准)
    // 3. meta.qualitys (收藏列表)
    const rawTypes = item.types || item._types ||
        item.qualitys || item._qualitys ||
        (item.meta && (item.meta.qualitys || item.meta._qualitys)) ||
        {};

    // Normalize types check
    let has320 = false;
    let hasFlac = false;
    let hasHiRes = false;
    let hasAtmos = false;
    let hasMaster = false;

    if (Array.isArray(rawTypes)) {
        const isConcrete = t => !(t && t.isPlatformQuality);
        has320 = rawTypes.some(t => t.type === '320k');
        hasFlac = rawTypes.some(t => t.type === 'flac');
        hasHiRes = rawTypes.some(t => (t.type === 'flac24bit' || t.type === 'hires') && isConcrete(t));
        hasAtmos = rawTypes.some(t => (t.type === 'atmos' || t.type === 'atmos_plus') && isConcrete(t));
        hasMaster = rawTypes.some(t => t.type === 'master' && isConcrete(t));
    } else {
        has320 = !!rawTypes['320k'];
        hasFlac = !!rawTypes['flac'];
        hasHiRes = !!(rawTypes['flac24bit'] && !rawTypes['flac24bit'].isPlatformQuality) || !!(rawTypes.hires && !rawTypes.hires.isPlatformQuality);
        hasAtmos = !!(rawTypes.atmos && !rawTypes.atmos.isPlatformQuality) || !!(rawTypes.atmos_plus && !rawTypes.atmos_plus.isPlatformQuality);
        hasMaster = !!(rawTypes.master && !rawTypes.master.isPlatformQuality);
    }

    // [New] 额外检查具体音质字段 (适用于本地歌曲或已确定音质的播放中歌曲)
    const q = item.quality || item.type;
    if (q) {
        if (q === 'master') hasMaster = true;
        else if (q === 'atmos' || q === 'atmos_plus') hasAtmos = true;
        else if (q === 'flac24bit' || q === 'hires') hasHiRes = true;
        else if (q === 'flac') hasFlac = true;
        else if (q === '320k') has320 = true;
    }

    if (hasMaster) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-purple border border-purple-200 dark:border-purple-500/30 transition-colors">Master</span>');
    else if (hasAtmos) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-blue border border-cyan-200 dark:border-cyan-500/30 transition-colors">Atmos</span>');
    else if (hasHiRes) tags.push('<span class="badge-quality-hires flex-shrink-0">Hi-Res</span>');
    else if (hasFlac) tags.push('<span class="badge-quality-sq flex-shrink-0">SQ</span>');
    else if (has320) tags.push('<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-blue border border-blue-200 dark:border-blue-500/30 transition-colors">高品质</span>');

    return tags.join('');
}
window.getQualityTags = getQualityTags;

function getSourceTag(source) {
    const colors = {
        tx: 't-badge-green border-green-200 dark:border-emerald-500/30',
        wy: 't-badge-red border-red-200 dark:border-red-500/30'
    };
    const names = { tx: 'QQ', wy: '网易' };
    const color = colors[source] || 't-bg-main t-text-muted t-border-main';
    const name = escapeHtmlText(names[source] || String(source || '').toUpperCase());
    return `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] font-bold border ${color} mr-1">${name}</span>`;
}
window.getSourceTag = getSourceTag;

function makeKeyboardActivatable(element, label, activate) {
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
    element.setAttribute('aria-label', label);
    element.addEventListener('keydown', (event) => {
        if (event.target !== element || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        activate(event);
    });
}

function isSearchResultFavoriteTarget(event?: Event) {
    const target = event?.target;
    if (target && typeof (target as Element).closest === 'function'
        && (target as Element).closest('.search-result-favorite-btn')) return true;
    return typeof event?.composedPath === 'function'
        && event.composedPath().some(item => item && typeof (item as Element).matches === 'function'
            && (item as Element).matches('.search-result-favorite-btn'));
}



function renderSingerResults(list) {
    const container = document.getElementById('search-results');
    if (!container) return;
    const normalizedList = Array.isArray(list) ? list : [];
    container.classList.remove('artist-detail-active');
    container.classList.remove('lib-view-active');
    const header = document.getElementById('search-results-header');
    if (header) header.classList.add('hidden');
    // 搜索歌手时隐藏底部分页栏
    const paginationBar = document.getElementById('search-pagination-bar');
    if (paginationBar) paginationBar.classList.add('hidden');

    window.viewingPlaylist = normalizedList;

    if (normalizedList.length === 0) {
        container.innerHTML = '<div class="flex items-center justify-center min-h-48 p-8 text-center t-text-muted">未找到相关歌手</div>';
        return;
    }

    container.innerHTML = '<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-2 md:gap-4 p-3 md:p-6"></div>';
    const grid = container.querySelector('div');
    normalizedList.forEach((singer, idx) => {
        const singerId = String(singer.id ?? '');
        const singerSource = String(singer.source || 'wy');
        const singerName = String(singer.name || '未命名歌手');
        const singerImage = safeImageUrl(singer.picUrl);
        const div = document.createElement('div');
        div.className = 'player-motion-item group flex flex-col items-center p-2 md:p-4 rounded-2xl transition-all hover:t-bg-panel hover:shadow-md cursor-pointer border border-transparent hover:border-emerald-500/30';
        div.style.setProperty('--player-motion-index', String(Math.min(idx, 7)));
        div.dataset.singerId = singerId;
        div.dataset.singerSource = singerSource;
        const activateSinger = (event?: Event) => {
            if (isSearchResultFavoriteTarget(event)) return;
            enterArtist(singerId, singerSource);
        };
        div.onclick = activateSinger;
        makeKeyboardActivatable(div, `打开歌手 ${singerName}`, activateSinger);
        const aliasHtml = singer.alias && singer.alias.length
            ? `<span class="text-[9px] md:text-[10px] t-text-muted text-center truncate w-full mt-0.5 md:mt-1">${escapeHtmlText(singer.alias[0])}</span>`
            : '';
        div.innerHTML = `
            <div class="relative mb-2 md:mb-3">
                <div class="w-16 h-16 sm:w-24 sm:h-24 md:w-32 md:h-32 rounded-full overflow-hidden shadow-sm">
                    <img src="${escapeHtmlText(singerImage)}" alt="${escapeHtmlText(singerName)}头像" width="128" height="128" loading="lazy" decoding="async"
                         data-event-error-action="fallback-image"
                         class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500">
                </div>
                <button type="button" id="singer-fav-${escapeHtmlText(singerId)}" aria-label="${isArtistFavorited(singerId, singerSource) ? '取消收藏' : '收藏歌手'}" class="search-result-favorite-btn absolute -top-1 -right-1 w-6 h-6 md:w-7 md:h-7 rounded-full flex items-center justify-center transition-all shadow-md z-10 ${isArtistFavorited(singerId, singerSource) ? 'bg-rose-500 text-white opacity-100' : 'bg-black/30 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}"
                        title="${isArtistFavorited(singerId, singerSource) ? '取消收藏' : '收藏歌手'}"
                        data-event-click-action="search-toggle-artist-favorite" data-event-click-args="[${safeInlineString(singerId)}, ${safeInlineString(singerSource)}, ${safeInlineString(singerName)}, ${safeInlineString(singer.picUrl || '')}]" data-event-stop="true">
                    <i class="fas fa-heart text-[10px]"></i>
                </button>
            </div>
            <span class="text-[11px] md:text-sm font-bold t-text-main text-center truncate w-full" title="${escapeHtmlText(singerName)}">${escapeHtmlText(singerName)}</span>
            <div class="flex flex-col items-center mt-1">
                ${aliasHtml}
                <div class="mt-1">${getSourceTag ? getSourceTag(singer.source || 'wy') : (singer.source || 'wy').toUpperCase()}</div>
            </div>
            <span class="hidden md:inline-block text-[10px] px-2 py-0.5 mt-2 rounded bg-emerald-500 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                ${escapeHtmlText(singer.albumSize || 0)} 专辑
            </span>
        `;
        const favoriteButton = div.querySelector('.search-result-favorite-btn');
        favoriteButton?.addEventListener('click', event => {
            event.stopPropagation();
            void applyArtistFavoriteToggle(favoriteButton, [singerId, singerSource, singerName, singer.picUrl || '']);
        });
        grid.appendChild(div);
    });
}

function renderAlbumResults(list) {
    const container = document.getElementById('search-results');
    if (!container) return;
    const normalizedList = Array.isArray(list) ? list : [];
    container.classList.remove('artist-detail-active');
    container.classList.remove('lib-view-active');
    const header = document.getElementById('search-results-header');
    if (header) header.classList.add('hidden');
    // 搜索专辑时隐藏底部分页栏
    const paginationBar = document.getElementById('search-pagination-bar');
    if (paginationBar) paginationBar.classList.add('hidden');

    window.viewingPlaylist = normalizedList;

    if (normalizedList.length === 0) {
        container.innerHTML = '<div class="flex items-center justify-center min-h-48 p-8 text-center t-text-muted">未找到相关专辑</div>';
        return;
    }

    container.innerHTML = '<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 p-6"></div>';
    const grid = container.querySelector('div');
    normalizedList.forEach((item, index) => {
        const albumId = String(item.id ?? '');
        const albumSource = String(item.source || 'wy');
        const albumName = String(item.name || '未命名专辑');
        const albumImage = safeImageUrl(item.picUrl);
        const div = document.createElement('div');
        div.className = 'player-motion-item group flex flex-col p-3 rounded-2xl transition-all hover:t-bg-panel hover:shadow-lg cursor-pointer border border-transparent hover:border-emerald-500/20';
        div.style.setProperty('--player-motion-index', String(Math.min(index, 7)));
        const activateAlbum = (event?: Event) => {
            if (isSearchResultFavoriteTarget(event)) return;
            enterAlbum(albumId, albumSource);
        };
        div.onclick = activateAlbum;
        makeKeyboardActivatable(div, `打开专辑 ${albumName}`, activateAlbum);
        const publishDate = item.publishTime ? new Date(item.publishTime).toLocaleDateString() : '';
        div.innerHTML = `
            <div class="aspect-square rounded-xl overflow-hidden shadow-md mb-3 relative">
                <img src="${escapeHtmlText(albumImage)}" alt="${escapeHtmlText(albumName)}封面" width="320" height="320" loading="lazy" decoding="async"
                     data-event-error-action="fallback-image"
                     class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
                <button type="button" id="album-fav-${escapeHtmlText(albumId)}" aria-label="${isAlbumFavorited(albumId, albumSource) ? '取消收藏' : '收藏专辑'}" class="search-result-favorite-btn absolute top-1.5 right-1.5 w-7 h-7 rounded-full flex items-center justify-center transition-all shadow-sm ${isAlbumFavorited(albumId, albumSource) ? 'bg-rose-500 text-white opacity-100' : 'bg-black/30 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100'}"
                        title="${isAlbumFavorited(albumId, albumSource) ? '取消收藏' : '收藏专辑'}"
                        data-event-click-action="search-toggle-album-favorite" data-event-click-args="[${safeInlineString(albumId)}, ${safeInlineString(albumSource)}, ${safeInlineString(albumName)}, ${safeInlineString(item.picUrl || '')}, ${safeInlineString(item.artistName || '')}]" data-event-stop="true">
                    <i class="fas fa-heart text-xs"></i>
                </button>
            </div>
            <span class="text-sm font-bold t-text-main line-clamp-2 h-10 leading-5 mb-1" title="${escapeHtmlText(albumName)}">${escapeHtmlText(albumName)}</span>
            <div class="flex items-center justify-between mt-1">
                <span class="text-[10px] t-text-muted truncate flex-1">${escapeHtmlText(item.artistName || '未知歌手')}</span>
                <span class="text-[10px] t-text-muted ml-2">${escapeHtmlText(publishDate)}</span>
            </div>
        `;
        const favoriteButton = div.querySelector('.search-result-favorite-btn');
        favoriteButton?.addEventListener('click', event => {
            event.stopPropagation();
            void applyAlbumFavoriteToggle(favoriteButton, [albumId, albumSource, albumName, item.picUrl || '', item.artistName || '']);
        });
        grid.appendChild(div);
    });
}

function formatPlayCount(count) {
    if (!count) return '0';
    if (count > 100000000) return (count / 100000000).toFixed(1) + '亿';
    if (count > 10000) return (count / 10000).toFixed(1) + '万';
    return count;
}

function searchBySinger(name, source = null) {
    performSearch(name, source, 'singer');
}
window.searchBySinger = searchBySinger;

let currentArtistId = null;
let currentArtistSource = 'wy';
let currentArtistInfo = null;
window.currentArtistId = null;
window.currentArtistSource = 'wy';
window.currentArtistOrder = 'hot';

type ArtistRequestContext = {
    serial: number;
    controller: AbortController;
};

let artistRequestSerial = 0;
let artistRequestController: AbortController | null = null;
let artistSongsUsesServerPagination = false;
let artistSongsTotal = 0;
let artistSongsPageSize = 20;
const ARTIST_SONG_PAGE_CACHE_MAX = 24;
const artistSongsPageCache = new Map<number, any[]>();

function getArtistSongsCachedPage(page) {
    const cached = artistSongsPageCache.get(page);
    if (cached) {
        artistSongsPageCache.delete(page);
        artistSongsPageCache.set(page, cached);
    }
    return cached;
}

function setArtistSongsCachedPage(page, list) {
    artistSongsPageCache.delete(page);
    artistSongsPageCache.set(page, list);
    while (artistSongsPageCache.size > ARTIST_SONG_PAGE_CACHE_MAX) {
        const oldestPage = artistSongsPageCache.keys().next().value;
        if (oldestPage === undefined) break;
        artistSongsPageCache.delete(oldestPage);
    }
}

function getArtistSongsPageSize() {
    if (settings?.itemsPerPage === 'all') return 100;
    const configured = Number.parseInt(settings?.itemsPerPage || '20', 10);
    return Math.min(100, Math.max(1, Number.isFinite(configured) ? configured : 20));
}

function resetArtistSongsCache() {
    artistSongsUsesServerPagination = false;
    artistSongsTotal = 0;
    artistSongsPageSize = getArtistSongsPageSize();
    artistSongsPageCache.clear();
    window.currentArtistSongsCache = null;
    window.artistSongsPage = 1;
}

function beginArtistRequest(): ArtistRequestContext {
    artistRequestController?.abort();
    const controller = new AbortController();
    artistRequestController = controller;
    return { serial: ++artistRequestSerial, controller };
}

function invalidateArtistRequest() {
    artistRequestController?.abort();
    artistRequestController = null;
    artistRequestSerial += 1;
}

function isArtistRequestCurrent(request: ArtistRequestContext, id, source, tab, order = null) {
    return request.serial === artistRequestSerial
        && !request.controller.signal.aborted
        && String(window.currentArtistId) === String(id)
        && window.currentArtistSource === source
        && window.currentArtistTab === tab
        && (order === null || window.currentArtistOrder === order);
}

async function enterArtist(id, source = 'wy', order = 'hot', tab = 'songs', isBack = false) {
    invalidateSearchRequest();
    invalidateAlbumRequest();
    setSearchDetailOpen(true);
    const typeEl = document.getElementById('search-type');

    // 记录返回状态 (仅当从非歌手列表进入 且 不是从子页面返回时)
    if (!isBack && document.getElementById('artist-detail-header') === null) {
        lastSearchType = typeEl ? typeEl.value : 'singer';
        lastSearchResultList = [...(window.viewingPlaylist || [])];
        currentArtistInfo = null; // 重置缓存
        window.history.pushState({
            page: 'search-detail',
            kind: 'artist',
            id: String(id),
            source: String(source),
            order: String(order),
            tab,
        } satisfies SearchDetailHistoryState, '');
    }

    const previousArtistOrder = window.currentArtistOrder || 'hot';
    const isDifferentArtist = String(currentArtistId || '') !== String(id) || currentArtistSource !== source;
    const isDifferentOrder = previousArtistOrder !== order;
    if (isDifferentArtist || (tab === 'songs' && isDifferentOrder)) {
        resetArtistSongsCache();
        if (window.ListSearch) window.ListSearch.resetState();
    }
    if (isDifferentArtist) {
        window.currentArtistAlbumsCache = null;
        artistAlbumsPage = 1;
        artistAlbumsTotal = 0;
        artistAlbumsUsesServerPagination = false;
        artistAlbumsPageCache.clear();
    }

    currentArtistId = id;
    currentArtistSource = source;
    window.currentArtistId = id;
    window.currentArtistSource = source;
    window.currentArtistOrder = order;
    window.currentArtistTab = tab;
    const request = beginArtistRequest();
    const resultsContainer = document.getElementById('search-results');
    const needsArtistInfo = !currentArtistInfo
        || String(currentArtistInfo.id) !== String(id)
        || currentArtistInfo.source !== source;
    // 详情资料和当前标签数据互不依赖；并行发起可消除一次完整网络往返。
    const pendingContent = needsArtistInfo
        ? (tab === 'songs'
            ? loadArtistSongs(id, source, order, false, request, window.artistSongsPage || 1)
            : loadArtistAlbums(id, source, false, request))
        : null;

    // 只有在没有缓存或者 ID 变化时才获取详情
    if (needsArtistInfo) {
        // 如果还没有头部，显示加载
        if (!document.getElementById('artist-detail-header')) {
            resultsContainer.innerHTML = '<div class="flex items-center justify-center h-full"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';
        }

        try {
            const detailRes = await fetch(`${API_BASE}/artistDetail?id=${id}&source=${source}`, {
                signal: request.controller.signal,
            });
            if (!detailRes.ok) throw new Error('Failed to fetch artist detail');
            const detail = await detailRes.json();
            if (!isArtistRequestCurrent(request, id, source, tab, tab === 'songs' ? order : null)) return;
            currentArtistInfo = detail;
        } catch (e) {
            if (e?.name === 'AbortError' || !isArtistRequestCurrent(request, id, source, tab, tab === 'songs' ? order : null)) return;
            showError(`获取歌手详情失败: ${e.message}`);
            goBackToSearch();
            return;
        }
    }

    if (!isArtistRequestCurrent(request, id, source, tab, tab === 'songs' ? order : null)) return;

    // 渲染头部
    renderArtistHeader(currentArtistInfo, tab, order);

    // 加载具体内容
    if (pendingContent) {
        await pendingContent;
        if (!isArtistRequestCurrent(request, id, source, tab, tab === 'songs' ? order : null)) return;
    }
    const contentStillLoading = document.querySelector('#artist-detail-content .fa-spinner') !== null;
    if (tab === 'songs' && (!pendingContent || contentStillLoading)) {
        // 请求可能比歌手资料更早完成，此时内容容器还不存在；缓存命中会立即补绘。
        await loadArtistSongs(id, source, order, false, request, window.artistSongsPage || 1);
    } else if (tab === 'albums' && (!pendingContent || contentStillLoading)) {
        await loadArtistAlbums(id, source, false, request);
    }

    if (!isArtistRequestCurrent(request, id, source, tab, tab === 'songs' ? order : null)) return;
    const backBtn = document.getElementById('search-back-btn');
    if (backBtn) backBtn.classList.remove('hidden');
}

let isArtistFolded = false;

function renderArtistHeader(info, activeTab, order) {
    const container = document.getElementById('search-results');
    const isMobile = window.innerWidth < 768;
    const artistIdValue = String(info.id ?? '');
    const artistSourceValue = String(info.source ?? 'wy');
    const artistNameValue = String(info.name ?? '未命名歌手');
    const artistAvatar = safeImageUrl(info.avatar);
    const artistId = escapeHtmlText(artistIdValue);
    const artistSource = escapeHtmlText(artistSourceValue);
    const artistName = escapeHtmlText(artistNameValue);
    const artistDescription = escapeHtmlText(info.desc || '暂无简介');
    const artistIdArg = safeInlineString(artistIdValue);
    const artistSourceArg = safeInlineString(artistSourceValue);
    const artistOrderArg = safeInlineString(String(order));
    const artistNameArg = safeInlineString(artistNameValue);
    const artistAvatarArg = safeInlineString(artistAvatar);

    // 计算各状态下的样式类和内联样式，确保与 toggleArtistFold 完全一致
    const headerPadding = isArtistFolded ? 'p-3 md:p-4' : 'p-6 md:p-8';
    const nameTransform = isArtistFolded
        ? (isMobile ? 'translate(40px, -30px) scale(0.65)' : 'translate(30px, 0px) scale(0.65)')
        : 'translate(0, 0) scale(1)';
    const tabsClass = '';

    container.classList.remove('lib-view-active');
    container.classList.add('artist-detail-active');

    let headerHtml = `
        <div id="artist-detail-view" class="artist-detail-view flex flex-1 min-h-0 flex-col overflow-y-auto custom-scrollbar">
        <div id="artist-detail-header" class="relative ${headerPadding} ${isArtistFolded ? 'is-folded' : ''} t-bg-panel/50 border-b t-border-main transition-all duration-500 ease-in-out overflow-hidden group/header" style="${isArtistFolded ? 'min-height: ' + (isMobile ? '0px' : '90px') + ';' : ''}">
            <!-- Small Absolute Back Button -->
            <button data-event-click-action="goBackToSearch" class="absolute top-2 left-2 md:top-4 md:left-4 w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-full bg-emerald-500/80 hover:bg-emerald-500 text-white transition-all z-30 shadow-md active:scale-90" title="返回搜索">
                <i class="fas fa-arrow-left"></i>
            </button>
            <!-- Favorite Button (Artist) -->
            <button id="artist-header-fav-btn"
                data-event-click-action="search-toggle-artist-favorite" data-event-click-args="[${artistIdArg}, ${artistSourceArg}, ${artistNameArg}, ${artistAvatarArg}]"
                class="absolute top-2 right-12 md:top-4 md:right-16 w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-full ${isArtistFavorited(artistIdValue, artistSourceValue) ? 'bg-rose-500 text-white' : 'bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 t-text-main'} transition-all z-30 shadow-sm active:scale-90"
                title="${isArtistFavorited(info.id, info.source) ? '取消收藏' : '收藏歌手'}">
                <i class="fas fa-heart"></i>
            </button>

            <!-- Fold Toggle Button -->
            <button id="artist-fold-btn" data-event-click-action="toggleArtistFold" class="absolute top-2 right-2 md:top-4 md:right-4 w-8 h-8 md:w-10 md:h-10 flex items-center justify-center rounded-full bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 t-text-main transition-all z-30 shadow-sm active:scale-90" title="折叠/展开">
                <i class="fas fa-chevron-up transition-transform duration-500 ${isArtistFolded ? 'rotate-180' : ''}" id="artist-fold-icon"></i>
            </button>

            <div id="artist-main-layout" class="flex flex-col md:flex-row gap-6 md:gap-8 ${isArtistFolded && isMobile ? 'items-start text-left' : 'items-center md:items-start text-center md:text-left'} transition-all duration-500">
                <div id="artist-avatar-container" class="w-32 h-32 md:w-40 md:h-40 rounded-full overflow-hidden shadow-2xl ring-4 ring-emerald-500/20 flex-shrink-0 transition-all duration-500 origin-center" style="${isArtistFolded ? 'transform: scale(0); opacity: 0; width: 0; height: 0; margin: 0;' : ''}">
                    <img src="${escapeHtmlText(artistAvatar)}" alt="${artistName}头像" width="160" height="160" loading="lazy" decoding="async"
                         data-event-error-action="fallback-image"
                         class="w-full h-full object-cover">
                </div>
                <div class="flex-1 min-w-0">
                    <h2 id="artist-name-display" class="text-3xl md:text-4xl font-black t-text-main mb-2 transition-all duration-500 origin-left pointer-events-none" style="transform: ${nameTransform}; margin-bottom: ${isArtistFolded ? '0' : ''};">${artistName}</h2>
                    <div id="artist-collapsible-section" class="transition-all duration-500 ${isArtistFolded ? 'opacity-0 max-h-0' : 'opacity-100 max-h-[500px]'}">
                        <div id="artist-stats-bar" class="flex flex-wrap justify-center md:justify-start gap-3 mb-3 text-sm font-medium transition-all duration-500">
                            <span class="px-3 py-1 rounded-full t-bg-main t-text-muted border t-border-main">
                                <i class="fas fa-music mr-1.5 text-emerald-500"></i>${Number(info.musicSize) || 0} 歌曲
                            </span>
                            <span class="px-3 py-1 rounded-full t-bg-main t-text-muted border t-border-main">
                                <i class="fas fa-compact-disc mr-1.5 text-blue-500"></i>${Number(info.albumSize) || 0} 专辑
                            </span>
                        </div>
                        <div class="relative group">
                            <p id="artist-bio-text" class="text-sm t-text-muted leading-relaxed line-clamp-3 overflow-y-auto max-h-32 transition-all cursor-pointer bg-black/5 dark:bg-white/5 p-3 rounded-lg custom-scrollbar" 
                            data-event-click-action="this.classList.toggle" data-event-click-args="[&quot;line-clamp-3&quot;]" title="点击展开/收回详情">
                                ${artistDescription}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <div id="artist-tabs-bar" class="artist-detail-tabs-bar flex items-center justify-between sticky top-0 z-30 px-3 md:px-6 py-2 t-bg-main border-b t-border-main shadow-sm transition-all duration-300 ${tabsClass}" style="min-height: 40px; height: 40px;">
            <div class="artist-tabs-group flex items-center gap-6 md:gap-8">
                <button data-event-click-action="enterArtist" data-event-click-args="[${artistIdArg}, ${artistSourceArg}, ${artistOrderArg}, &quot;songs&quot;]"
                        class="artist-tab text-sm font-bold transition-all relative py-1 ${activeTab === 'songs' ? 't-text-main' : 't-text-muted hover:t-text-main'}">
                    所有歌曲
                    ${activeTab === 'songs' ? '<div class="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full"></div>' : ''}
                </button>
                <button data-event-click-action="enterArtist" data-event-click-args="[${artistIdArg}, ${artistSourceArg}, ${artistOrderArg}, &quot;albums&quot;]"
                        class="artist-tab text-sm font-bold transition-all relative py-1 ${activeTab === 'albums' ? 't-text-main' : 't-text-muted hover:t-text-main'}">
                    所有专辑
                    ${activeTab === 'albums' ? '<div class="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-500 rounded-full"></div>' : ''}
                </button>
            </div>
            
            ${activeTab === 'songs' ? `
            <div class="flex items-center gap-2 relative z-30">
                <div class="artist-tabs-sort flex items-center p-0.5 t-bg-panel rounded-lg border t-border-main shadow-sm">
                    <button data-event-click-action="enterArtist" data-event-click-args="[${artistIdArg}, ${artistSourceArg}, &quot;hot&quot;, &quot;songs&quot;]"
                            class="px-3 py-1 text-xs font-bold rounded-md transition-all ${order === 'hot' ? 'bg-emerald-500 text-white shadow-sm' : 't-text-muted hover:t-bg-track'}">
                        热门
                    </button>
                    <button data-event-click-action="enterArtist" data-event-click-args="[${artistIdArg}, ${artistSourceArg}, &quot;time&quot;, &quot;songs&quot;]"
                            class="px-3 py-1 text-xs font-bold rounded-md transition-all ${order === 'time' ? 'bg-emerald-500 text-white shadow-sm' : 't-text-muted hover:t-bg-track'}">
                        最新
                    </button>
                </div>
                <div class="artist-action-capsule flex items-center p-0.5 t-bg-panel rounded-lg border t-border-main shadow-sm">
                    <button type="button" data-event-click-action="toggleBatchMode" data-list-action="batch"
                            class="w-7 h-7 flex items-center justify-center rounded-md transition-all ${window.batchMode ? 'bg-emerald-500 text-white shadow-sm' : 't-text-muted hover:t-text-main hover:t-bg-track'}"
                            title="多选操作" aria-label="多选操作" aria-pressed="${window.batchMode ? 'true' : 'false'}">
                        <i class="fas fa-tasks text-xs" aria-hidden="true"></i>
                    </button>
                    <button type="button" data-event-click-action="ListSearch.toggleBar" data-list-action="search"
                            class="w-7 h-7 flex items-center justify-center rounded-md transition-all t-text-muted hover:t-text-main hover:t-bg-track"
                            title="搜索当前列表" aria-label="搜索当前列表">
                        <i class="fas fa-search text-xs" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
            ` : ''}
        </div>
        <div id="artist-detail-content" class="player-track-list-content flex-1 p-2 md:p-4">
            <div class="flex items-center justify-center py-10">
                <i class="fas fa-spinner fa-spin text-2xl text-emerald-500"></i>
            </div>
        </div>
        </div>
    `;
    container.innerHTML = headerHtml;
}

function toggleArtistFold() {
    const header = document.getElementById('artist-detail-header');
    const avatar = document.getElementById('artist-avatar-container');
    const collapsible = document.getElementById('artist-collapsible-section');
    const name = document.getElementById('artist-name-display');
    const tabsBar = document.getElementById('artist-tabs-bar');
    const foldIcon = document.getElementById('artist-fold-icon');
    const mainLayout = document.getElementById('artist-main-layout');

    if (!header) return;

    isArtistFolded = header.classList.toggle('is-folded');
    const isMobile = window.innerWidth < 768;

    if (isArtistFolded) {
        // 折叠状态
        header.classList.remove('p-6', 'md:p-8');
        header.classList.add('p-3', 'md:p-4');
        header.style.minHeight = isMobile ? '0px' : '90px';

        // 手机版强制左对齐，方便定位到返回键右侧
        if (isMobile) {
            mainLayout.classList.remove('items-center', 'text-center');
            mainLayout.classList.add('items-start', 'text-left');
        }

        avatar.style.transform = 'scale(0)';
        avatar.style.opacity = '0';
        avatar.style.width = '0';
        avatar.style.height = '0';
        avatar.style.margin = '0';

        collapsible.style.maxHeight = '0';
        collapsible.style.opacity = '0';
        collapsible.style.marginTop = '0';

        tabsBar.classList.remove('mt-8', 'mt-1');

        // 响应式偏移
        if (isMobile) {
            name.style.transform = 'translate(40px, -30px) scale(0.65)';
        } else {
            name.style.transform = 'translate(30px, 0px) scale(0.65)';
        }
        name.style.marginBottom = '0';

        foldIcon.style.transform = 'rotate(180deg)';
    } else {
        // 展开状态
        header.classList.add('p-6', 'md:p-8');
        header.classList.remove('p-3', 'md:p-4');
        header.style.minHeight = '';

        if (isMobile) {
            mainLayout.classList.add('items-center', 'text-center');
            mainLayout.classList.remove('items-start', 'text-left');
        }

        avatar.style.transform = 'scale(1)';
        avatar.style.opacity = '1';
        avatar.style.width = '';
        avatar.style.height = '';
        avatar.style.margin = '';

        collapsible.style.maxHeight = '500px';
        collapsible.style.opacity = '1';
        collapsible.style.marginTop = '';

        tabsBar.classList.remove('mt-8', 'mt-1');

        name.style.transform = 'translate(0, 0) scale(1)';
        name.style.marginBottom = '';

        foldIcon.style.transform = 'rotate(0deg)';
    }
}
window.toggleArtistFold = toggleArtistFold;

async function loadArtistSongs(
    id,
    source,
    order,
    forceFetch = false,
    requestContext: ArtistRequestContext | null = null,
    requestedPage = window.artistSongsPage || 1,
) {
    const request = requestContext || beginArtistRequest();
    const page = Math.max(1, Number.parseInt(String(requestedPage), 10) || 1);
    const cachedPage = getArtistSongsCachedPage(page);
    // Check if we can use cache to speed up UI transitions (like batch mode toggle)
    if (!forceFetch && cachedPage && String(window.currentArtistId) === String(id) && window.currentArtistOrder === order && window.currentArtistSource === source) {
        if (!isArtistRequestCurrent(request, id, source, 'songs', order)) return;
        window.currentArtistSongsCache = cachedPage;
        renderArtistSongsUI(cachedPage, page);
        return;
    }

    if (!isArtistRequestCurrent(request, id, source, 'songs', order)) return;
    renderArtistSongsLoading();

    try {
        const pageSize = getArtistSongsPageSize();
        const query = new URLSearchParams({
            id: String(id),
            source: String(source),
            order: String(order),
            page: String(page),
            limit: String(pageSize),
        });
        const res = await fetch(`${API_BASE}/artistSongs?${query.toString()}`, {
            signal: request.controller.signal,
        });
        if (!res.ok) throw new Error('Failed to fetch songs');
        const data = await res.json();
        const list = Array.isArray(data) ? data : (Array.isArray(data?.list) ? data.list : []);

        if (!isArtistRequestCurrent(request, id, source, 'songs', order)) return;

        // [Fix] 唯一 ID
        list.forEach((item, idx) => {
            if (!item.id || item.id === 'undefined') {
                item.id = item.songmid || item.songId || item.hash || item.copyrightId || item.mid || item.mediaMid || `art_${id}_${page}_${idx}`;
            }
        });

        // 只缓存已访问页，避免高产歌手一次性传输和解析上千首歌曲。
        artistSongsUsesServerPagination = !Array.isArray(data);
        artistSongsPageSize = Number(data?.limit) || pageSize;
        artistSongsTotal = artistSongsUsesServerPagination
            ? Math.max(Number(data?.total) || 0, (page - 1) * artistSongsPageSize + list.length)
            : list.length;
        setArtistSongsCachedPage(page, list);
        window.currentArtistSongsCache = list;
        window.currentArtistId = id;
        window.currentArtistSource = source;
        window.currentArtistOrder = order;
        window.artistSongsPage = page;

        renderArtistSongsUI(list, page);
    } catch (e) {
        if (e?.name === 'AbortError' || !isArtistRequestCurrent(request, id, source, 'songs', order)) return;
        showError(`加载歌曲失败: ${e.message}`);
        goBackToSearch();
    }
}
window.loadArtistSongs = loadArtistSongs;

function renderArtistSongsLoading() {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;
    window.viewingPlaylist = [];
    content.innerHTML = `
        <div class="flex items-center justify-center py-12 t-text-muted">
            <i class="fas fa-spinner fa-spin text-2xl text-emerald-500 mr-3"></i>
            <span class="text-sm font-medium">正在加载歌曲...</span>
        </div>
    `;
}

function animateArtistDetailContent(content: HTMLElement) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    content.classList.remove('player-detail-content-entering');
    void content.offsetWidth;
    content.classList.add('player-detail-content-entering');
    window.setTimeout(() => {
        if (content.isConnected) content.classList.remove('player-detail-content-entering');
    }, 240);
}

function getArtistSongsPageMetrics(list) {
    const displayList = window.ListSearch
        ? window.ListSearch.getDisplayList(list)
        : list.map((item, index) => ({ item, originalIndex: index }));
    const serverPageIsFiltered = artistSongsUsesServerPagination && displayList.length !== list.length;
    const totalItems = artistSongsUsesServerPagination && !serverPageIsFiltered
        ? artistSongsTotal
        : displayList.length;
    let itemsPerPage = artistSongsUsesServerPagination && !serverPageIsFiltered
        ? artistSongsPageSize
        : ((settings && settings.itemsPerPage === 'all') ? totalItems : parseInt((settings && settings.itemsPerPage) || 20));
    if (!itemsPerPage || itemsPerPage <= 0) itemsPerPage = 20;
    const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
    return { displayList, itemsPerPage, totalItems, totalPages, usesServerPagination: artistSongsUsesServerPagination && !serverPageIsFiltered };
}

function renderArtistSongsUI(list, page) {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;

    window.viewingPlaylist = list;

    if (!list || list.length === 0) {
        content.innerHTML = '<div class="text-center py-10 t-text-muted">暂无歌曲</div>';
        return;
    }

    // 前端分页逻辑，分页数量与列表搜索后的可见结果保持一致
    const { displayList, itemsPerPage, totalItems, totalPages, usesServerPagination } = getArtistSongsPageMetrics(list);

    // 使用传入的 page 或者全局 artistSongsPage，默认第1页
    if (page !== undefined) window.artistSongsPage = page;
    if (!window.artistSongsPage || window.artistSongsPage < 1) window.artistSongsPage = 1;
    if (window.artistSongsPage > totalPages) window.artistSongsPage = totalPages;

    const artistPage = window.artistSongsPage;
    const startIndex = (artistPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const indexedDisplayList = usesServerPagination ? displayList : displayList.slice(startIndex, endIndex);

    let html = `
        <div class="space-y-1">
            ${indexedDisplayList.map((obj, displayIndex) => {
        const { item, originalIndex: playlistIndex } = obj;
        const index = usesServerPagination ? startIndex + playlistIndex : playlistIndex;
        const itemIdValue = String(item.id ?? '');
        const itemId = escapeHtmlText(itemIdValue);
        const itemIdArg = safeInlineString(itemIdValue);
        const itemName = escapeHtmlText(item.name || '未命名歌曲');
        const itemSinger = escapeHtmlText(item.singer || '未知歌手');
        const itemAlbum = escapeHtmlText(item.albumName || '-');
        const itemInterval = escapeHtmlText(item.interval || '--:--');
        const itemImage = escapeHtmlText(getImgUrl(item));
        const isSelected = window.selectedItems.has(itemIdValue);
        const isMatched = window.ListSearch && window.ListSearch.isMatched(index);
        const isCurrentMatch = window.ListSearch && window.ListSearch.isCurrentMatch(index);

        let rowClass = 'player-track-grid player-track-grid--network player-motion-item p-3 rounded-xl hover:t-bg-panel transition-all group cursor-pointer border border-transparent ';
        if (isCurrentMatch) rowClass += 'search-current ';
        else if (isMatched) rowClass += 'search-match ';
        if (isSelected) rowClass += 'row-selected ring-1 ring-emerald-500/30 ';
        if (displayIndex > 12) rowClass += 'deferred-list-item ';

        const selectionLabel = isSelected ? '取消选择' : '选择';
        const selectionAttributes = window.batchMode
            ? `aria-pressed="${isSelected}"`
            : '';

        return `
                <div role="button" tabindex="0" aria-label="${window.batchMode ? `${selectionLabel} ${itemName}` : `播放 ${itemName}`}" ${selectionAttributes}
                     data-selection-state="${isSelected ? 'selected' : 'unselected'}"
                     class="${rowClass}" style="--player-motion-index: ${Math.min(displayIndex, 7)};" data-song-id="${itemId}"
                     data-event-click-action="search-row-activate" data-event-click-args="[${itemIdArg}, ${playlistIndex}]"
                     data-event-keydown-action="search-row-activate" data-event-keydown-args="[${itemIdArg}, ${playlistIndex}]" data-event-keys="Enter, " data-event-target-self="true" data-event-prevent="true">
                    <!-- Index -->
                    <div class="player-track-index text-center flex items-center justify-center font-mono text-xs t-text-muted group-hover:t-text-main">
                        <span class="index-num">${index + 1}</span>
                    </div>

                    <!-- Title -->
                    <div class="player-track-title flex items-center gap-3 min-w-0">
                        <div class="w-10 h-10 md:w-12 md:h-12 rounded-lg overflow-hidden flex-shrink-0 shadow-sm relative">
                            <img src="${itemImage}" alt="${itemName}专辑封面" width="48" height="48" loading="lazy" decoding="async"
                                 data-event-error-action="fallback-image"
                                 class="w-full h-full object-cover">
                            <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                <i class="fas fa-play text-white text-xs"></i>
                            </div>
                        </div>
                        <div class="min-w-0 flex-1">
                            <div class="font-bold t-text-main text-sm md:text-base leading-tight truncate group-hover:text-emerald-600 transition-colors">${itemName}</div>
                            <div class="flex items-center gap-1 mt-1">
                                ${getSourceTag ? getSourceTag(item.source) : ''}
                                ${getQualityTags ? getQualityTags(item) : ''}
                            </div>
                        </div>
                    </div>

                    <!-- Artist -->
                    <div class="player-track-artist text-sm t-text-muted items-center truncate">
                        ${itemSinger}
                    </div>

                    <!-- Album -->
                    <div class="player-track-album text-sm t-text-muted items-center truncate">
                        ${itemAlbum}
                    </div>

                    <!-- Duration -->
                    <div class="player-track-duration items-center justify-center text-xs font-mono t-text-muted">
                        ${itemInterval}
                    </div>

                    <!-- Actions -->
                    <div class="player-track-actions flex items-center justify-end gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                        <button class="p-1.5 hover:bg-emerald-50 rounded-lg text-emerald-600 transition-colors" title="播放" data-event-click-action="playFromView" data-event-click-args="[${playlistIndex}]" data-event-stop="true">
                            <i class="fas fa-play w-3.5 h-3.5"></i>
                        </button>
                        <button class="p-1.5 hover:bg-blue-50 rounded-lg text-blue-600 transition-colors" title="下载" data-event-click-action="downloadSong" data-event-click-args="[${safeInlineJson(item)}]" data-event-stop="true">
                            <i class="fas fa-download w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </div>
            `;
    }).join('')}
        </div>

        <!-- 歌手详情内部分页控件 -->
        <div class="player-pagination-bar artist-songs-pagination">
            <button type="button" data-event-click-action="artistSongsPrevPage"
                class="player-pagination-button" aria-label="上一页" title="上一页"
                ${artistPage <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left" aria-hidden="true"></i><span class="hidden sm:inline">上一页</span>
            </button>
            <div class="player-pagination-center">
                <span id="artist-songs-page-info" class="player-pagination-info t-text-muted">第 ${artistPage} / ${totalPages} 页 (${totalItems} 首)</span>
                <div class="player-pagination-jump">
                    <label for="artist-songs-page-input" class="sr-only">跳转到歌手歌曲页码</label>
                    <input id="artist-songs-page-input" type="number" min="1" max="${totalPages}" inputmode="numeric" enterkeyhint="go"
                        value="${artistPage}" aria-label="跳转到歌手歌曲页码"
                        data-event-keydown-action="artistSongsGoToPage" data-event-key="Enter">
                    <span aria-hidden="true"></span>
                    <button type="button" data-event-click-action="artistSongsGoToPage">跳转</button>
                </div>
            </div>
            <button type="button" data-event-click-action="artistSongsNextPage"
                class="player-pagination-button" aria-label="下一页" title="下一页"
                ${artistPage >= totalPages ? 'disabled' : ''}>
                <span class="hidden sm:inline">下一页</span><i class="fas fa-chevron-right" aria-hidden="true"></i>
            </button>
        </div>
    `;
    content.innerHTML = html;
    animateArtistDetailContent(content);

    // Init Marquee if needed (though we use truncate here)
    if (window.applyMarqueeChecks) applyMarqueeChecks();
}
window.renderArtistSongsUI = renderArtistSongsUI;

// 歌手详情页内部翻页函数
function artistSongsPrevPage() {
    if (!window.artistSongsPage || window.artistSongsPage <= 1) return;
    if (artistSongsUsesServerPagination) {
        void loadArtistSongs(window.currentArtistId, window.currentArtistSource || 'wy', window.currentArtistOrder || 'hot', false, null, window.artistSongsPage - 1);
        return;
    }
    const list = window.currentArtistSongsCache;
    if (!list) return;
    renderArtistSongsUI(list, window.artistSongsPage - 1);
}
function artistSongsNextPage() {
    const list = window.currentArtistSongsCache;
    if (!list) return;
    const { totalPages } = getArtistSongsPageMetrics(list);
    if ((window.artistSongsPage || 1) >= totalPages) return;
    if (artistSongsUsesServerPagination) {
        void loadArtistSongs(window.currentArtistId, window.currentArtistSource || 'wy', window.currentArtistOrder || 'hot', false, null, (window.artistSongsPage || 1) + 1);
        return;
    }
    renderArtistSongsUI(list, (window.artistSongsPage || 1) + 1);
}
function artistSongsGoToPage() {
    const list = window.currentArtistSongsCache;
    const input = document.getElementById('artist-songs-page-input') as HTMLInputElement | null;
    if (!list || !input) return;

    const { totalPages } = getArtistSongsPageMetrics(list);
    const requestedPage = Number.parseInt(input.value, 10);
    if (!Number.isFinite(requestedPage)) return;

    const targetPage = Math.min(totalPages, Math.max(1, requestedPage));
    if (artistSongsUsesServerPagination) {
        void loadArtistSongs(window.currentArtistId, window.currentArtistSource || 'wy', window.currentArtistOrder || 'hot', false, null, targetPage);
        return;
    }
    renderArtistSongsUI(list, targetPage);
}
window.artistSongsPrevPage = artistSongsPrevPage;
window.artistSongsNextPage = artistSongsNextPage;
window.artistSongsGoToPage = artistSongsGoToPage;

const ARTIST_ALBUM_PAGE_SIZE = 50;
// 音源接口本身按 50 张专辑分页；详情页一次只渲染/请求一页。
const ARTIST_ALBUM_RENDER_PAGE_SIZE = ARTIST_ALBUM_PAGE_SIZE;
const ARTIST_ALBUM_PAGE_CACHE_MAX = 12;
let artistAlbumsPage = 1;
let artistAlbumsTotal = 0;
let artistAlbumsUsesServerPagination = false;
const artistAlbumsPageCache = new Map<number, any[]>();

function getArtistAlbumsCachedPage(page) {
    const cached = artistAlbumsPageCache.get(page);
    if (cached) {
        artistAlbumsPageCache.delete(page);
        artistAlbumsPageCache.set(page, cached);
    }
    return cached;
}

function setArtistAlbumsCachedPage(page, list) {
    artistAlbumsPageCache.delete(page);
    artistAlbumsPageCache.set(page, list);
    while (artistAlbumsPageCache.size > ARTIST_ALBUM_PAGE_CACHE_MAX) {
        const oldestPage = artistAlbumsPageCache.keys().next().value;
        if (oldestPage === undefined) break;
        artistAlbumsPageCache.delete(oldestPage);
    }
}

function renderArtistAlbumsLoading(loaded = 0, total = 0) {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;
    const progressText = loaded > 0
        ? '正在加载专辑第 ' + loaded + (total > 0 ? '/' + total : '') + ' 张...'
        : '正在加载专辑...';
    const wrapper = document.createElement('div');
    const icon = document.createElement('i');
    const label = document.createElement('span');
    wrapper.className = 'flex items-center justify-center py-12 t-text-muted';
    icon.className = 'fas fa-spinner fa-spin text-2xl text-emerald-500 mr-3';
    label.className = 'text-sm font-medium';
    label.textContent = progressText;
    wrapper.append(icon, label);
    content.replaceChildren(wrapper);
}

async function loadArtistAlbums(id, source, forceFetch = false, requestContext: ArtistRequestContext | null = null, requestedPage = artistAlbumsPage || 1) {
    const request = requestContext || beginArtistRequest();
    const page = Math.max(1, Number.parseInt(String(requestedPage), 10) || 1);
    const cachedPage = getArtistAlbumsCachedPage(page);
    if (!forceFetch && cachedPage && String(window.currentArtistId) === String(id) && window.currentArtistSource === source) {
        if (!isArtistRequestCurrent(request, id, source, 'albums')) return;
        window.currentArtistAlbumsCache = cachedPage;
        renderArtistAlbumsUI(cachedPage, page);
        return;
    }

    if (!isArtistRequestCurrent(request, id, source, 'albums')) return;
    renderArtistAlbumsLoading();

    try {
        const query = new URLSearchParams({ id: String(id), source: String(source), page: String(page) });
        const res = await fetch(API_BASE + '/artistAlbums?' + query.toString(), { signal: request.controller.signal });
        if (!res.ok) throw new Error('Failed to fetch artist albums page ' + page);
        const data = await res.json();
        const list = (Array.isArray(data.list) ? data.list : []).map(album => ({ ...album, source: album.source || source }));
        if (!isArtistRequestCurrent(request, id, source, 'albums')) return;

        artistAlbumsUsesServerPagination = true;
        artistAlbumsTotal = Math.max(Number(data.total) || 0, (page - 1) * ARTIST_ALBUM_PAGE_SIZE + list.length);
        setArtistAlbumsCachedPage(page, list);
        window.currentArtistAlbumsCache = list;
        window.currentArtistAlbumsTotal = artistAlbumsTotal;
        artistAlbumsPage = page;

        if (window.currentArtistTab === 'albums') {
            renderArtistAlbumsUI(list, page);
        }
    } catch (e) {
        if (e?.name === 'AbortError' || !isArtistRequestCurrent(request, id, source, 'albums')) return;
        showError(`加载专辑失败: ${e.message}`);
        goBackToSearch();
    }
}

function renderArtistAlbumsUI(list, requestedPage = artistAlbumsPage) {
    const content = document.getElementById('artist-detail-content');
    if (!content) return;

    if (!list || list.length === 0) {
        content.innerHTML = '<div class="text-center py-10 t-text-muted">暂无专辑</div>';
        return;
    }

    const artistName = currentArtistInfo?.name || '';
    const usesServerPagination = artistAlbumsUsesServerPagination;
    const totalItems = usesServerPagination ? artistAlbumsTotal : list.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / ARTIST_ALBUM_RENDER_PAGE_SIZE));
    artistAlbumsPage = Math.min(totalPages, Math.max(1, Number(requestedPage) || 1));
    const startIndex = (artistAlbumsPage - 1) * ARTIST_ALBUM_RENDER_PAGE_SIZE;
    const visibleAlbums = usesServerPagination ? list : list.slice(startIndex, startIndex + ARTIST_ALBUM_RENDER_PAGE_SIZE);
    const html = `
        <div class="artist-albums-grid p-2 md:p-4 animate-in fade-in duration-300">
            ${visibleAlbums.map((album, visibleIndex) => {
                const index = startIndex + visibleIndex;
                const albumId = album.id ?? album.mid;
                const albumSource = album.source || window.currentArtistSource || 'wy';
                const albumName = album.name || '未知专辑';
                const favorited = isAlbumFavorited(albumId, albumSource);
                return `
                <div class="artist-album-card player-motion-item group flex flex-col p-3 rounded-2xl transition-all hover:t-bg-panel hover:shadow-lg cursor-pointer border border-transparent hover:border-emerald-500/20" style="--player-motion-index: ${Math.min(index, 7)};" data-album-index="${visibleIndex}">
                    <div class="aspect-square rounded-xl overflow-hidden shadow-md mb-3 relative bg-gray-100 dark:bg-gray-800">
                        <img src="${escapeHtmlText(getImgUrl(album))}" alt="${escapeHtmlText(albumName)}封面" width="320" height="320" loading="lazy" decoding="async"
                             data-event-error-action="fallback-image"
                             class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
                        <div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                             <div class="w-12 h-12 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-lg transform translate-y-4 group-hover:translate-y-0 transition-transform duration-300">
                                <i class="fas fa-play"></i>
                             </div>
                        </div>
                        <div class="absolute top-1.5 right-1.5 flex gap-1.5">
                            <button type="button" class="artist-album-download-btn w-8 h-8 rounded-full bg-black/45 hover:bg-emerald-500 text-white flex items-center justify-center opacity-100 sm:opacity-0 group-hover:opacity-100 transition-all shadow-sm disabled:opacity-60 disabled:cursor-wait" data-album-index="${visibleIndex}" title="下载本专辑全部歌曲">
                                <i class="fas fa-download text-xs"></i>
                            </button>
                            <button type="button" class="artist-album-favorite-btn w-8 h-8 rounded-full flex items-center justify-center transition-all shadow-sm ${favorited ? 'bg-rose-500 text-white opacity-100' : 'bg-black/45 hover:bg-rose-500 text-white opacity-100 sm:opacity-0 group-hover:opacity-100'}" data-album-index="${visibleIndex}" title="${favorited ? '取消收藏' : '收藏专辑'}">
                                <i class="fas fa-heart text-xs"></i>
                            </button>
                        </div>
                    </div>
                    <span class="text-sm font-bold t-text-main line-clamp-2 h-10 leading-5 mb-1 group-hover:text-emerald-600 transition-colors" title="${escapeHtmlText(albumName)}">${escapeHtmlText(albumName)}</span>
                    <div class="flex items-center justify-between mt-1">
                        <span class="text-[10px] t-text-muted">${escapeHtmlText(album.publishTime || '')}</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 font-bold">${Number(album.total ?? album.count ?? album.size ?? album.songCount ?? 0) || 0} 首</span>
                    </div>
                </div>
            `;
            }).join('')}
        </div>
        ${totalPages > 1 ? `
        <div class="player-pagination-bar artist-albums-pagination">
            <button type="button" data-event-click-action="artistAlbumsGoToPage" data-event-click-args="[${artistAlbumsPage - 1}]"
                class="player-pagination-button" aria-label="上一页" title="上一页" ${artistAlbumsPage <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left" aria-hidden="true"></i><span class="hidden sm:inline">上一页</span>
            </button>
            <div class="player-pagination-center">
                <span class="player-pagination-info t-text-muted">第 ${artistAlbumsPage} / ${totalPages} 页 (${totalItems} 张)</span>
            </div>
            <button type="button" data-event-click-action="artistAlbumsGoToPage" data-event-click-args="[${artistAlbumsPage + 1}]"
                class="player-pagination-button" aria-label="下一页" title="下一页" ${artistAlbumsPage >= totalPages ? 'disabled' : ''}>
                <span class="hidden sm:inline">下一页</span><i class="fas fa-chevron-right" aria-hidden="true"></i>
            </button>
        </div>` : ''}
    `;
    content.innerHTML = html;
    animateArtistDetailContent(content);

    content.querySelectorAll('.artist-album-card').forEach(card => {
        card.addEventListener('click', () => {
            const album = visibleAlbums[Number(card.dataset.albumIndex)];
            if (album) enterAlbum(album.id ?? album.mid, album.source || window.currentArtistSource || 'wy');
        });
    });
    content.querySelectorAll('.artist-album-download-btn').forEach(button => {
        button.addEventListener('click', async event => {
            event.stopPropagation();
            const album = visibleAlbums[Number(button.dataset.albumIndex)];
            if (album) await downloadArtistAlbumSongs(album, button);
        });
    });
    content.querySelectorAll('.artist-album-favorite-btn').forEach(button => {
        button.addEventListener('click', async event => {
            event.stopPropagation();
            const album = visibleAlbums[Number(button.dataset.albumIndex)];
            if (!album) return;
            const albumId = album.id ?? album.mid;
            const albumSource = album.source || window.currentArtistSource || 'wy';
            const favorited = await toggleAlbumFavorite(albumId, albumSource, album.name || '未知专辑', getImgUrl(album), album.artistName || album.singer || artistName);
            button.className = 'artist-album-favorite-btn w-8 h-8 rounded-full flex items-center justify-center transition-all shadow-sm ' + (favorited ? 'bg-rose-500 text-white opacity-100' : 'bg-black/45 hover:bg-rose-500 text-white opacity-100 sm:opacity-0 group-hover:opacity-100');
            button.title = favorited ? '取消收藏' : '收藏专辑';
        });
    });
}
window.renderArtistAlbumsUI = renderArtistAlbumsUI;

function artistAlbumsGoToPage(page) {
    const list = window.currentArtistAlbumsCache;
    if (!Array.isArray(list)) return;
    const targetPage = Math.max(1, Number(page) || 1);
    if (artistAlbumsUsesServerPagination && !artistAlbumsPageCache.has(targetPage)) {
        void loadArtistAlbums(window.currentArtistId, window.currentArtistSource || 'wy', false, null, targetPage);
        return;
    }
    renderArtistAlbumsUI(artistAlbumsUsesServerPagination ? getArtistAlbumsCachedPage(targetPage) || list : list, targetPage);
    document.getElementById('artist-detail-view')?.scrollTo({ top: 0, behavior: 'smooth' });
}
window.artistAlbumsGoToPage = artistAlbumsGoToPage;

async function downloadArtistAlbumSongs(album, button) {
    if (typeof window.batchDownloadSongs !== 'function') {
        showError('批量下载功能未就绪');
        return;
    }

    const albumId = album.id ?? album.mid;
    const albumSource = album.source || window.currentArtistSource || 'wy';
    const albumName = album.name || '未知专辑';
    if (albumId === undefined || albumId === null || albumId === '') {
        showError(`专辑「${albumName}」缺少有效 ID，无法下载`);
        return;
    }
    const icon = button?.querySelector('i');
    if (button) button.disabled = true;
    if (icon) icon.className = 'fas fa-spinner fa-spin text-xs';

    try {
        const query = new URLSearchParams({ id: String(albumId), source: albumSource });
        const res = await fetch(API_BASE + '/albumSongs?' + query.toString());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const rawSongs = Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : []);
        if (rawSongs.length === 0) {
            showError(`专辑「${albumName}」没有可下载的歌曲`);
            return;
        }

        const songs = rawSongs.map(song => ({
            ...song,
            source: song.source || albumSource,
            albumName: song.albumName || albumName,
            meta: {
                ...(song.meta || {}),
                albumId: song.meta?.albumId || song.albumId || albumId,
                albumName: song.meta?.albumName || albumName
            }
        }));
        await window.batchDownloadSongs(songs, {
            clearSelection: false,
            selectionLabel: `专辑「${albumName}」共 ${songs.length} 首歌曲`
        });
    } catch (e) {
        console.error('[ArtistAlbums] 读取专辑歌曲失败:', albumName, e);
        showError(`读取专辑「${albumName}」失败: ${e.message}`);
    } finally {
        if (button) button.disabled = false;
        if (icon) icon.className = 'fas fa-download text-xs';
    }
}
window.downloadArtistAlbumSongs = downloadArtistAlbumSongs;

async function enterAlbum(id, source = 'wy', fromHistory = false) {
    invalidateSearchRequest();
    invalidateArtistRequest();
    invalidateAlbumRequest();
    const albumId = String(id);
    const albumSource = String(source);
    window.currentAlbumId = albumId;
    window.currentAlbumSource = albumSource;
    setSearchDetailOpen(true);
    const request = beginAlbumRequest(albumId, albumSource);
    // 保存进入专辑前的上下文，如果是从歌手页进入，则记录歌手 ID
    const artistHeader = document.getElementById('artist-detail-header');
    if (artistHeader) {
        window.tempArtistContext = {
            id: window.currentArtistId,
            source: window.currentArtistSource,
            tab: window.currentArtistTab || 'albums',
            order: window.currentArtistOrder || 'hot'
        };
        artistHeader.remove(); // 进入专辑详情时移除歌手头部，保持界面整洁
    } else {
        window.tempArtistContext = null;
    }

    const typeEl = document.getElementById('search-type');
    if (!artistHeader) {
        lastSearchType = typeEl ? typeEl.value : 'album';
        lastSearchResultList = [...(window.viewingPlaylist || [])];
    }
    if (!fromHistory) {
        window.history.pushState({
            page: 'search-detail',
            kind: 'album',
            id: albumId,
            source: albumSource,
        } satisfies SearchDetailHistoryState, '');
    }

    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = '<div class="flex items-center justify-center h-full"><i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i></div>';

    try {
        const res = await fetch(`${API_BASE}/albumSongs?id=${encodeURIComponent(albumId)}&source=${encodeURIComponent(albumSource)}`, {
            signal: request.controller.signal,
        });
        if (!res.ok) throw new Error('Failed to fetch album songs');
        const data = await res.json();
        if (!isAlbumRequestCurrent(request)) return;
        const songList = data.list || (Array.isArray(data) ? data : []);
        renderResults(songList);
        const pageInfoEl = document.getElementById('page-info');
        if (pageInfoEl) pageInfoEl.innerText = `专辑歌曲列表`;

        // [新增] 如果该专辑已收藏，则异步丰富其元数据
        if (isAlbumFavorited(albumId, albumSource)) {
            updateAlbumLibraryMeta(albumId, albumSource, data);
        }

        const backBtn = document.getElementById('search-back-btn');
        if (backBtn) backBtn.classList.remove('hidden');
    } catch (e) {
        if (e?.name === 'AbortError' || !isAlbumRequestCurrent(request)) return;
        console.error('[Search] 获取专辑歌曲失败:', e);
        showError(`获取专辑歌曲失败: ${e.message}`);
        resultsContainer.innerHTML = `<div class="text-center text-red-500 p-8">
            <p>获取专辑歌曲失败：${escapeHtmlText(e.message)}</p>
            <button type="button" data-event-click-action="goBackToSearch" class="mt-4 px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600">返回专辑搜索</button>
        </div>`;
        const backBtn = document.getElementById('search-back-btn');
        if (backBtn) backBtn.classList.remove('hidden');
    }
}

function goBackToSearch(fromPopState = false) {
    invalidateSearchRequest();
    invalidateArtistRequest();
    invalidateAlbumRequest();
    if (!fromPopState) {
        if (window.history.state && window.history.state.page === 'search-detail') {
            window.history.back();
            return;
        }
    }

    // 如果有暂存的歌手上下文，优先返回歌手页
    if (window.tempArtistContext) {
        const ctx = window.tempArtistContext;
        window.tempArtistContext = null; // 用完即弃
        enterArtist(ctx.id, ctx.source, ctx.order, ctx.tab, true);
        return;
    }

    if (!lastSearchResultList) {
        setSearchDetailOpen(false);
        return;
    }

    setSearchDetailOpen(false);

    restoreSearchResults();

    currentArtistId = null;
    window.currentArtistId = null;
    window.currentAlbumId = null;
    window.currentAlbumSource = null;
}

function restoreSearchResults() {
    if (!lastSearchResultList) return false;

    const container = document.getElementById('search-results');
    const header = document.getElementById('search-results-header');

    // 清除详情页专用头部
    const detailHeader = document.getElementById('artist-detail-header');
    if (detailHeader) detailHeader.remove();

    // 恢复搜索结果列表头部
    if (header) header.classList.remove('hidden');

    if (window.currentSearchScope === 'lib_artists') {
        renderLibraryArtists(lastSearchResultList);
    } else if (window.currentSearchScope === 'lib_albums') {
        renderLibraryAlbums(lastSearchResultList);
    } else if (lastSearchType === 'singer') {
        renderSingerResults(lastSearchResultList);
    } else if (lastSearchType === 'album') {
        renderAlbumResults(lastSearchResultList);
    } else {
        renderResults(lastSearchResultList);
    }

    const backBtn = document.getElementById('search-back-btn');
    if (backBtn) backBtn.classList.add('hidden');

    const pageInfoEl = document.getElementById('page-info');
    if (pageInfoEl) {
        if (window.currentSearchScope === 'lib_artists') pageInfoEl.innerText = `收藏歌手`;
        else if (window.currentSearchScope === 'lib_albums') pageInfoEl.innerText = `收藏专辑`;
        else pageInfoEl.innerText = `搜索结果`;
    }

    lastRenderedSearchKey = getSearchStateKey();

    return true;
}
window.goBackToSearch = goBackToSearch;

function leaveSearchView() {
    invalidateSearchRequest();
    invalidateArtistRequest();
    invalidateAlbumRequest();
    setSearchDetailOpen(false);
    window.tempArtistContext = null;
    currentArtistId = null;
    currentArtistInfo = null;
    window.currentArtistId = null;
    window.currentAlbumId = null;
    window.currentAlbumSource = null;

    restoreSearchResults();

    if (window.history.state?.page === 'search-detail') {
        window.history.replaceState({ page: 'tab', tabId: 'search' }, '');
    }
}

function handleSearchPopState(historyState: any) {
    if (historyState?.page === 'search-detail') {
        // 浏览器从其它主页面返回搜索详情时，先恢复搜索视图；保留当前 History 项，
        // 避免 switchTab 的常规清理逻辑把正在恢复的详情路由替换掉。
        switchTab('search', true);
        const id = historyState.id;
        const source = historyState.source || 'wy';
        if (id === undefined || id === null || id === '') return false;

        // 通过前进按钮恢复详情时，不再新建 History 项。
        window.tempArtistContext = null;
        if (historyState.kind === 'album') {
            void enterAlbum(String(id), String(source), true);
            return true;
        }
        if (historyState.kind === 'artist') {
            void enterArtist(String(id), String(source), historyState.order || 'hot', historyState.tab || 'songs', true);
            return true;
        }
        return false;
    }

    if (searchDetailOpen) {
        switchTab('search', true);
        goBackToSearch(true);
        return true;
    }

    return false;
}

window.enterArtist = enterArtist;

// Helper for loose image paths
function getImgUrl(item) {
    if (!item) return '/music/assets/yun-yin.png';
    const s = item;
    // 优先从标准 meta 获取
    if (s.meta && s.meta.picUrl) return safeImageUrl(s.meta.picUrl);
    // 兼容各种 SDK 的原始字段
    return safeImageUrl(s.img || s.pic || s.picUrl || s.picture ||
        (s.album && (s.album.picUrl || s.album.img || s.album.pic)) ||
        (s.al && (s.al.picUrl || s.al.img)) ||
        (s.meta && (s.meta.img || s.meta.pic)) ||
        '/music/assets/yun-yin.png');
}

// List search logic is now handled by ListSearch service in list_search.js
function renderResults(list) {
    const container = document.getElementById('search-results');
    container.classList.remove('artist-detail-active');
    container.classList.remove('lib-view-active');
    const header = document.getElementById('search-results-header');
    // 搜索歌曲时恢复底部分页栏显示
    const paginationBar = document.getElementById('search-pagination-bar');
    if (paginationBar) paginationBar.classList.toggle('hidden', searchDetailOpen);
    // 重置歌手详情分页（进入歌曲搜索视图时清空）
    window.artistSongsPage = 1;

    // Determine if we should show the album column
    // Search results (network) show album, collections (local) do not
    const showAlbum = window.currentSearchScope === 'network';


    // Update Header
    if (header) {
        header.classList.toggle('hidden', searchDetailOpen);
        header.classList.toggle('player-track-grid--no-album', !showAlbum);
    }

    container.innerHTML = searchDetailOpen
        ? renderTrackListHeader({ extraClass: `${showAlbum ? '' : 'player-track-grid--no-album '}px-3 py-1.5 rounded-t-2xl shadow-sm`, includeBackToolbar: true })
        : '';

    // [Fix] 确保每个歌曲都有唯一的 ID，防止批量操作时因为 ID 缺失(undefined)导致只能选中一个
    // 很多源(如酷狗、咪咕)返回的原始数据可能只有 hash 或 copyrightsId 而没有 id 字段
    if (list && list.length > 0) {
        list.forEach((item, idx) => {
            if (!item.id || item.id === 'undefined') {
                item.id = item.songmid || item.songId || item.hash || item.copyrightId || item.mid || item.mediaMid || `temp_${Date.now()}_${idx}`;
            }
        });
    }

    window.viewingPlaylist = list;

    if (!list || list.length === 0) {
        const emptyState = '<div class="text-center t-text-muted p-8">未找到相关结果</div>';
        if (searchDetailOpen) container.insertAdjacentHTML('beforeend', emptyState);
        else container.innerHTML = emptyState;
        updatePaginationInfo(0, 0, 0, 1, 1);
        return;
    }

    // Applying Unified Filter with original index preservation BEFORE pagination
    const indexedDisplayList = window.ListSearch.getDisplayList(list);

    // Pagination
    const totalItems = indexedDisplayList.length;
    let itemsPerPage = settings.itemsPerPage === 'all' ? totalItems : parseInt(settings.itemsPerPage);
    if (itemsPerPage <= 0) itemsPerPage = 20;
    const totalPages = Math.ceil(totalItems / (itemsPerPage || 1));

    // Bounds check
    if (pageState.value > totalPages) pageState.value = totalPages || 1;
    if (pageState.value < 1) pageState.value = 1;

    const startIndex = (pageState.value - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);

    const pageList = indexedDisplayList.slice(startIndex, endIndex);

    pageList.forEach((obj, pageIndex) => {
        const { item, originalIndex: actualIndexInOriginal } = obj;
        const itemIdValue = String(item.id ?? '');
        const itemId = escapeHtmlText(itemIdValue);
        const itemIdArg = safeInlineString(itemIdValue);
        const itemName = escapeHtmlText(item.name || '未命名歌曲');
        const itemSingerValue = String(item.singer || '未知歌手');
        const itemSinger = escapeHtmlText(itemSingerValue);
        const itemSingerArg = safeInlineString(itemSingerValue);
        const itemAlbum = escapeHtmlText(item.albumName || '-');
        const itemInterval = escapeHtmlText(item.interval || '--:--');
        const row = document.createElement('div');
        row.id = `gl-row-${actualIndexInOriginal}`;
        row.dataset.songId = String(item.id);

        const isMatched = window.ListSearch.isMatched(actualIndexInOriginal);
        const isCurrentMatch = window.ListSearch.isCurrentMatch(actualIndexInOriginal);
        const isSelected = window.selectedItems.has(itemIdValue);

        let rowClass = `player-track-grid player-track-grid--network player-motion-item p-3 rounded-xl hover:t-bg-panel group transition-colors cursor-pointer min-h-[50px] items-center touch-manipulation ${showAlbum ? '' : 'player-track-grid--no-album '}`;
        if (isCurrentMatch) rowClass += 'search-current ';
        else if (isMatched) rowClass += 'search-match ';
        if (isSelected) rowClass += 'row-selected ring-1 ring-emerald-500/30 ';
        if (pageIndex > 12) rowClass += 'deferred-list-item ';

        const selectionLabel = isSelected ? '取消选择' : '选择';
        row.className = rowClass;
        row.style.setProperty('--player-motion-index', String(Math.min(pageIndex, 7)));
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.dataset.selectionState = isSelected ? 'selected' : 'unselected';
        if (window.batchMode) row.setAttribute('aria-pressed', String(isSelected));
        row.setAttribute('aria-label', window.batchMode ? `${selectionLabel} ${itemName}` : `播放 ${itemName}`);

        // Add click listener for the row
        row.onclick = (e) => {
            if (window.batchMode) {
                const id = String(item.id);
                const isChecked = !window.selectedItems.has(id);
                window.handleBatchSelect(id, isChecked);
            } else {
                // If not in batch mode, clicking row plays the song
                playFromView(actualIndexInOriginal);
            }
        };
        row.onkeydown = (e) => {
            if (e.target !== row) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                row.click();
            }
        };

        // Image
        const imgUrl = getImgUrl(item);

        row.innerHTML = `
            <!-- Index -->
            <div class="player-track-index text-center font-mono t-text-muted text-xs md:text-sm flex items-center justify-center">
                <span class="index-num">${actualIndexInOriginal + 1}</span>
            </div>

            <!-- Title (Image + Text) -->
            <div class="player-track-title flex items-center overflow-hidden pr-2">
                <div class="relative w-10 h-10 md:w-12 md:h-12 mr-3 md:mr-4 flex-shrink-0 group cursor-pointer">
                     <img data-src="${escapeHtmlText(imgUrl)}" src="/music/assets/yun-yin.png" alt="${itemName}专辑封面" width="48" height="48"
                          loading="lazy" decoding="async"
                          class="lazy-image w-full h-full rounded-lg object-cover shadow-sm group-hover:shadow-md transition-all group-hover:scale-105 duration-300 dynamic-logo is-placeholder" 
                           data-event-error-action="fallback-image">
                     <div class="absolute inset-0 bg-black/20 rounded-lg hidden group-hover:flex items-center justify-center transition-all">
                        <i class="fas fa-play text-white text-xs md:text-sm"></i>
                     </div>
                </div>
                <div class="min-w-0 flex-1 flex flex-col justify-center overflow-hidden">
                    <div class="font-bold t-text-main text-sm md:text-base leading-tight hover:text-emerald-600 transition-colors">
                         ${createMarqueeHtml(item.name)}
                    </div>
                    <div class="flex items-center gap-1 mt-0.5 md:mt-1 pr-2 overflow-hidden">
                         ${getSourceTag(item.source)}
                         ${getQualityTags(item)}
                             <div class="player-track-compact-meta flex-1 min-w-0">
                            ${createMarqueeHtml(item.singer, 'text-[10px] t-text-muted')}
                         </div>
                    </div>
                </div>
            </div>

            <!-- Artist (Hidden on Mobile) -->
            <div class="player-track-artist t-text-muted text-sm md:text-base items-center hover:text-emerald-600 transition-colors cursor-pointer overflow-hidden"
                 title="${itemSinger}"
                 data-event-click-action="performSearch" data-event-click-args="[${itemSingerArg}, ${safeInlineString(item.source || '')}, &quot;singer&quot;]" data-event-stop="true">
                ${createMarqueeHtml(item.singer)}
            </div>

            <!-- Album (Hidden until LG) -->
            ${showAlbum ? `
            <div class="player-track-album t-text-muted text-sm truncate flex items-center" title="${itemAlbum}">
                ${itemAlbum}
            </div>
            ` : ''}

            <!-- Duration (Hidden until MD) -->
            <div class="player-track-duration t-text-muted text-sm font-mono text-center flex items-center justify-center">
                ${itemInterval}
            </div>

            <!-- Actions -->
            <div class="player-track-actions flex items-center justify-end gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                <button class="p-2 sm:p-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 rounded-lg text-emerald-600 transition-colors touch-manipulation min-w-[36px] min-h-[36px] hidden sm:flex items-center justify-center" 
                        title="播放" 
                        aria-label="播放 ${itemName}"
                        data-event-click-action="playFromView" data-event-click-args="[${actualIndexInOriginal}]" data-event-stop="true">
                    <i class="fas fa-play text-xs sm:text-sm"></i>
                </button>
                <button class="p-2 sm:p-1.5 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-lg text-blue-600 transition-colors touch-manipulation min-w-[36px] min-h-[36px] flex items-center justify-center" 
                        title="下载" 
                        aria-label="下载 ${itemName}"
                        data-event-click-action="downloadSong" data-event-click-args="[${safeInlineJson(item)}]" data-event-stop="true">
                    <i class="fas fa-download text-xs sm:text-sm"></i>
                </button>
                ${window.currentSearchScope !== 'network' ? `
                <button class="p-2 sm:p-1.5 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg text-red-600 transition-colors touch-manipulation min-w-[36px] min-h-[36px] flex items-center justify-center" 
                        title="删除" 
                        aria-label="删除 ${itemName}"
                        data-event-click-action="deleteSingleSong" data-event-click-args="[${itemIdArg}]" data-event-stop="true">
                    <i class="fas fa-trash text-xs sm:text-sm"></i>
                </button>
                ` : ''}
            </div>
        `;

        container.appendChild(row);
    });

    // Update pagination info
    updatePaginationInfo(startIndex + 1, endIndex, totalItems, pageState.value, totalPages);

    // Init Lazy Loader
    lazyLoadImages(container);
    applyMarqueeChecks(container);

    // [Prefetch] 自动后台预加载逻辑
    if (!searchDetailOpen && window.currentSearchScope === 'network'
        && settings.itemsPerPage !== 'all' && pageState.value === totalPages) {
        const FETCH_PAGES_STEP = 3;
        const nextNetPage = (window.currentNetworkPage || 1) + 1;

        // 避免重复触发
        if (!window._prefetchingPending || window._prefetchingPending !== nextNetPage) {
            window._prefetchingPending = nextNetPage;
            console.log(`[Prefetch] 触及本地末页 (${totalPages})，自动拉取后续 ${FETCH_PAGES_STEP} 页... (Next URL Page: ${nextNetPage})`);

            // 延迟一点触发，确保 UI 先更新
            prefetchTimer = setTimeout(() => {
                prefetchTimer = null;
                if (searchDetailOpen) return;
                doSearch(nextNetPage, true, true).finally(() => {
                    // 完成后清除标志，但不再主动重置，防止同一页重复触发
                });
            }, 500);
        }
    }
}
window.renderResults = renderResults;

// Generic Marquee Helper
function createMarqueeHtml(text, className = '') {
    // Return a container marked for dynamic checking
    // different screens are different, so we check overflow after render
    // Added min-w-0 to prevent flex item from expanding beyond parent
    const safeText = escapeHtmlText(text);
    return `<div class="truncate dynamic-marquee min-w-0 ${className}" data-text="${safeText}">${safeText}</div>`;
}
//滚动显示
function applyMarqueeChecks(root = document) {
    // Wait for render
    setTimeout(() => {
        const scope = root || document;
        const elements = scope.querySelectorAll('.dynamic-marquee.truncate');
        elements.forEach(el => {
            if (el.scrollWidth > el.clientWidth) {
                const text = el.getAttribute('data-text') || el.innerText;

                // 必须保留 overflow-hidden 以限制宽度
                el.classList.remove('truncate');
                el.classList.add('overflow-hidden');

                // 使用 mask-image 实现边缘渐隐效果
                const maskStyle = 'mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%); -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);';

                const wrapper = document.createElement('div');
                wrapper.className = 'w-full relative';
                wrapper.setAttribute('style', maskStyle);
                const track = document.createElement('div');
                track.className = 'inline-block whitespace-nowrap animate-marquee hover:pause-animation';
                const firstText = document.createElement('span');
                firstText.textContent = text;
                const firstGap = document.createElement('span');
                firstGap.className = 'mx-8';
                const secondText = document.createElement('span');
                secondText.textContent = text;
                const secondGap = document.createElement('span');
                secondGap.className = 'mx-8';
                track.append(firstText, firstGap, secondText, secondGap);
                wrapper.appendChild(track);
                el.replaceChildren(wrapper);
            }
        });
    }, 50);
}

// Re-check marquees on resize
window.addEventListener('resize', () => {
    clearTimeout(window._marqueeResizeTimer);
    window._marqueeResizeTimer = setTimeout(applyMarqueeChecks, 300);
});

// Lazy Loading Logic
let imageObserver;

function lazyLoadImages(root = document) {
    const scope = root || document;
    const loadImage = (img) => {
        const src = img.getAttribute('data-src');
        if (!src) return;
        if (img.src.includes('yun-yin.png')) {
            img.classList.add('is-placeholder');
        }
        img.onload = () => {
            img.classList.remove('is-placeholder', 'opacity-0');
            img.removeAttribute('data-src');
        };
        img.onerror = () => {
            // Local music rows own their fallback chain: first try the
            // authenticated cache-cover endpoint, then the song's remote
            // cover, and only then render the default logo. Do not replace
            // that image from this generic loader during the same error event.
            if (img.classList.contains('lm-cover-image')) return;
            img.src = '/music/assets/yun-yin.png';
            img.classList.add('is-placeholder');
            img.removeAttribute('data-src');
        };
        // Register handlers before assigning src so cached responses cannot
        // win the race and leave a stale placeholder or broken image state.
        img.src = src;
    };

    if ('IntersectionObserver' in window) {
        if (!imageObserver) {
            imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    loadImage(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, {
            rootMargin: '100px 0px', // Load before it comes into view
            threshold: 0.01
        });
        }

        const images = scope.querySelectorAll('img.lazy-image[data-src]');
        images.forEach(img => {
            imageObserver.observe(img);
        });
    } else {
        // Fallback for older browsers
        const images = scope.querySelectorAll('img.lazy-image[data-src]');
        images.forEach(loadImage);
    }
}
window.lazyLoadImages = lazyLoadImages;
window.unobserveLazyImages = function (root = document) {
    if (!imageObserver) return;
    const scope = root || document;
    scope.querySelectorAll('img.lazy-image').forEach(img => imageObserver.unobserve(img));
};

// List search logic is now handled by ListSearch service




    return {
        handleSearchKeyPress,
        updateHeaderAppearanceIcon,
        toggleHeaderAppearance,
        performSearch,
        handleSearchTypeChange,
        applySearchTypeSourceRestrictions,
        doSearch,
        changePage,
        fetchHotSearch,
        renderHotSearch,
        handleHotSearchClick,
        showInitialSearchState,
        ensureSearchContent,
        getQualityTags,
        getSourceTag,
        makeKeyboardActivatable,
        renderSingerResults,
        renderAlbumResults,
        formatPlayCount,
        searchBySinger,
        beginArtistRequest,
        invalidateArtistRequest,
        isArtistRequestCurrent,
        enterArtist,
        renderArtistHeader,
        toggleArtistFold,
        loadArtistSongs,
        renderArtistSongsLoading,
        renderArtistSongsUI,
        artistSongsPrevPage,
        artistSongsNextPage,
        renderArtistAlbumsLoading,
        loadArtistAlbums,
        renderArtistAlbumsUI,
        downloadArtistAlbumSongs,
        enterAlbum,
        goBackToSearch,
        leaveSearchView,
        handleSearchPopState,
        getImgUrl,
        renderResults,
        createMarqueeHtml,
        applyMarqueeChecks,
        lazyLoadImages,
    };
}
