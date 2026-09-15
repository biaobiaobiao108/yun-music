import './legacy/quality';
import './legacy/idb_store';
import { handleBatchSelect } from './legacy/batch_pagination';
import { downloadSong } from './legacy/single_song_ops';
import './legacy/list_search';
import './legacy/pwa';
import './legacy/theme_manager';
import './legacy/common_ui';
import './legacy/ios_background_audio';
import './legacy/lyric_parser';
import { initAccessibleOverlays } from './accessible_overlays';
import {
    ensureLeaderboardLoaded,
    ensureLocalMusicLoaded,
    ensureMarkedLoaded,
    ensureLyricCardLoaded,
    ensureSoundEffectsLoaded,
    ensureVisualizerLoaded,
    openLyricCard,
    toggleSoundEffects,
} from './player_runtime';
import {
    escapeHtmlText,
    renderSafeMarkdown,
    safeImageUrl,
    safeInlineJson,
    safeInlineString,
} from './player_security';
import {
    DEFAULT_SETTINGS,
    FIXED_PLAYER_SETTINGS,
    normalizeDownloadConcurrency,
    normalizeStoredSettings,
    serializeSettings,
} from './player_settings';
import { initCustomSelectManager } from './custom_select';
import { initSearchTips } from './search_tips';
import { showInput, showOptions, showSelect } from './player_dialogs';
import { initPlayerNotifications, toUserMessage } from './player_notifications';
import { loadPlayerFeature } from './player_feature_loader';
import { setPlayerDrawerOpen } from './features/player_drawer';
import { initQueueFeature } from './features/queue';
import { initPlaylistModalFeature } from './features/playlist_modal';
import { initLibraryFeature } from './features/library';
import { initAuthFeature } from './features/auth';
import { initSettingsFeature } from './features/settings';
import { initSongUrlFeature } from './features/song_url';
import { initLyricFeature } from './features/lyrics';
import { initSearchFeature } from './features/search';
import { initPlaybackFeature, type PlaybackState } from './features/playback';
import { initShortcutsFeature } from './features/shortcuts';
import {
    createTabSwitcher,
    getPlayerViewDirection,
    prefersReducedPlayerMotion,
    transitionPlayerView,
} from './features/navigation';
import { bindPlayerEvents, registerPlayerEventAction } from './player_events';
import { DownloadManager } from './legacy/download_manager';
import { createSongListManager, type SongListManagerApi } from './legacy/songlist_manager';
import {
    registerAdminSessionChecker,
    registerDownloadManager,
    registerSongListManager,
} from './player_services';

/*
 * Copyright 2026 xcq0607 (https://github.com/xcq0607)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const API_BASE = '/api/music';
// 认证功能在入口后段初始化，前面的功能模块通过稳定桥接函数访问它，
// 避免在模块组装阶段把尚未赋值的认证方法传进去。
type PlayerAuthBridge = {
    getUserAuthHeaders: () => Record<string, string>;
    isUserLoggedIn: () => boolean;
};
let playerAuthBridge: PlayerAuthBridge | null = null;
const getPlayerUserAuthHeaders = () => playerAuthBridge?.getUserAuthHeaders() ?? {};
const isPlayerUserLoggedIn = () => playerAuthBridge?.isUserLoggedIn() ?? false;

let songListManager: SongListManagerApi;
let downloadManager: DownloadManager;

// 认证状态先于功能模块组装，避免前置模块捕获未初始化的变量。
let userName: string | null = localStorage.getItem('lx_user_name');
let userSessionActive = false;
let adminSessionActive = false;
let authEnabled = false;

registerAdminSessionChecker(() => adminSessionActive);

let currentPage = 1;
window.currentPage = 1;

function setPlayerPage(page: number) {
    const nextPage = Number(page);
    currentPage = Number.isFinite(nextPage) && nextPage > 0 ? Math.floor(nextPage) : 1;
    window.currentPage = currentPage;
    return currentPage;
}

(window as any).setPlayerPage = setPlayerPage;

function resetSharedBatchSelection() {
    window.selectedItems?.clear();
    window.selectedSongObjects?.clear();
    for (const id of ['batch-selected-count', 'sl-batch-selected-count', 'lb-batch-selected-count']) {
        const count = document.getElementById(id);
        if (count) count.textContent = '0';
    }
    if (typeof updateBatchToolbar === 'function') updateBatchToolbar();
    if (typeof (window as any).syncSelectionPresentation === 'function') (window as any).syncSelectionPresentation();
}

(window as any).resetSharedBatchSelection = resetSharedBatchSelection;

function clearLibraryBatchContext() {
    if (window.libraryBatchMode === 'artist' && typeof exitLibraryArtistBatch === 'function') {
        exitLibraryArtistBatch();
    } else if (window.libraryBatchMode === 'album' && typeof exitLibraryAlbumBatch === 'function') {
        exitLibraryAlbumBatch();
    } else {
        window.libraryBatchMode = false;
        window.libraryBatchSelected?.clear();
    }
}

let currentPlaylist = [];
let currentIndex = -1;
let preSelectedNextIndex = null; // 预先选定的下一首索引 (用于确保随机模式下的预读一致性)
window.viewingPlaylist = []; // Currently displayed list in UI
let currentPlayingScope = 'network'; // Scope for active playback
window.currentSearchScope = 'network'; // 'network', 'local_list', 'local_all' - Scope for UI view
let currentPlayingSong = null; // Track currently playing song independently of view
window.batchCollectSongs = null; // Store songs for batch collection modal
const audio = document.getElementById('audio-player');
let currentPlaybackRate = 1.0;
let clearSearchNavigation = () => {};

// 搜索详情和歌词详情都是当前 SPA 进程内的临时视图。页面刷新后无法恢复它们
// 的内存上下文，因此将遗留的详情状态归一化为普通播放器入口，避免下一次
// back/forward 把旧页面状态误当成当前视图。
const initialNavigationPage = window.history.state?.page;
if (!initialNavigationPage || initialNavigationPage === 'search-detail' || initialNavigationPage === 'player-detail') {
    window.history.replaceState({ page: 'player' }, '');
}

function setCurrentSearchScope(scope: string) {
    window.currentSearchScope = scope;
}

function isCurrentlyViewingLocalList(targetListId?: string): boolean {
    const searchView = document.getElementById('view-search');
    if (!searchView || searchView.classList.contains('hidden')) return false;

    const slDetail = document.getElementById('songlist-detail-view');
    if (slDetail && !slDetail.classList.contains('hidden') && !slDetail.classList.contains('translate-x-full')) return false;

    if (window.currentSearchScope !== 'local_list') return false;
    if (targetListId && window.currentViewingListId !== targetListId) return false;
    return true;
}
(window as any).isCurrentlyViewingLocalList = isCurrentlyViewingLocalList;

window.openLyricCard = openLyricCard;
window.toggleSoundEffects = toggleSoundEffects;

initAccessibleOverlays();

const {
    showToast,
    showSuccess,
    showInfo,
    showError,
    showPlaybackStatus,
    showLoading,
    hideLoading,
    dismissAllToasts,
} = initPlayerNotifications(() => ({ createMarqueeHtml, applyMarqueeChecks }));

// Sleep timer is intentionally loaded on first use. The legacy HTML still
// calls these names, so keep stable window proxies while moving the actual
// implementation out of the initial bundle.
function loadSleepTimerFeature() {
    return loadPlayerFeature(
        'sleep-timer',
        () => import('./sleep_timer'),
        '正在加载睡眠定时功能...'
    );
}

function callSleepTimerFeature(name: string, args: any[]) {
    return loadSleepTimerFeature().then((feature) => {
        const handler = (feature as any)[name];
        return typeof handler === 'function' ? handler(...args) : undefined;
    });
}

Object.assign(window, {
    openSleepTimerModal: (...args: any[]) => callSleepTimerFeature('openSleepTimerModal', args),
    closeSleepTimerModal: (...args: any[]) => callSleepTimerFeature('closeSleepTimerModal', args),
    setSleepTimer: (...args: any[]) => callSleepTimerFeature('setSleepTimer', args),
    cancelSleepTimer: (...args: any[]) => callSleepTimerFeature('cancelSleepTimer', args),
    showCustomTimerInput: (...args: any[]) => callSleepTimerFeature('showCustomTimerInput', args),
    applyCustomTimer: (...args: any[]) => callSleepTimerFeature('applyCustomTimer', args),
});

const queueFeature = initQueueFeature({
    getPlaylist: () => currentPlaylist,
    setPlaylist: (playlist) => { currentPlaylist = playlist; },
    getCurrentIndex: () => currentIndex,
    setCurrentIndex: (index) => { currentIndex = index; },
    getAudio: () => audio as HTMLMediaElement | null,
    playSong: (song, index) => playSong(song, index),
    savePlaybackState: () => savePlaybackState(),
    closeMobileSidebar: () => toggleSidebar(false),
    applyMarqueeChecks: () => applyMarqueeChecks(),
    createMarqueeHtml: (text, className) => createMarqueeHtml(text, className),
    escapeHtmlText,
    getImgUrl: (song) => getImgUrl(song),
    getSourceTag: (source) => getSourceTag(source),
    getQualityTags: (song) => getQualityTags(song),
    showInfo,
    showSuccess,
    showSelect,
    resetPlayer: () => resetPlayer(),
});
const { renderQueue, updateQueueBadge } = queueFeature;

function loadCommentsFeature() {
    return loadPlayerFeature(
        'comments',
        () => import('./features/comments').then(({ initCommentsFeature }) => initCommentsFeature({
            getActiveSong: () => currentPlayingSong,
            escapeHtmlText,
        })),
        '正在加载评论功能...'
    );
}

function callCommentsFeature(name: string, args: any[] = []) {
    return loadCommentsFeature().then((feature) => {
        const handler = (feature as any)[name];
        return typeof handler === 'function' ? handler(...args) : undefined;
    });
}

function toggleCommentModal(...args: any[]) { return callCommentsFeature('toggleCommentModal', args); }
function switchCommentType(...args: any[]) { return callCommentsFeature('switchCommentType', args); }
function refreshComments(...args: any[]) { return callCommentsFeature('refreshComments', args); }
function fetchComments(...args: any[]) { return callCommentsFeature('fetchComments', args); }
function toggleSongInList(...args: any[]) { return callCommentsFeature('toggleSongInList', args); }

function loadCustomSourcesFeature() {
    return loadPlayerFeature(
        'custom-sources',
        () => import('./features/custom_sources').then(({ initCustomSourcesFeature }) => initCustomSourcesFeature({
            getUserAuthHeaders: getPlayerUserAuthHeaders,
            getCurrentListData: () => currentListData,
            getSettings: () => settings,
            isUserLoggedIn: isPlayerUserLoggedIn,
            isAdminSessionActive: () => adminSessionActive,
            handleAdminAuth,
            updateSetting,
            createMarqueeHtml: (text, className) => createMarqueeHtml(text, className),
            applyMarqueeChecks: () => applyMarqueeChecks(),
            escapeHtmlText,
            showInput,
            showSelect,
            showSuccess,
            showInfo,
            showError,
        })),
        '正在加载自定义音源管理...'
    );
}

function callCustomSourcesFeature(name: string, args: any[] = []) {
    return loadCustomSourcesFeature().then((feature) => {
        const handler = (feature as any)[name];
        return typeof handler === 'function' ? handler(...args) : undefined;
    });
}

function loadCustomSources(...args: any[]) { return callCustomSourcesFeature('loadCustomSources', args); }
function fetchCustomSources(...args: any[]) { return callCustomSourcesFeature('fetchCustomSources', args); }
function renderCustomSources(...args: any[]) { return callCustomSourcesFeature('renderCustomSources', args); }
function handleFileUpload(...args: any[]) { return callCustomSourcesFeature('handleFileUpload', args); }
function handleUrlImport(...args: any[]) { return callCustomSourcesFeature('handleUrlImport', args); }
function openCustomSourceModal(...args: any[]) { return callCustomSourcesFeature('openCustomSourceModal', args); }
function closeCustomSourceModal(...args: any[]) { return callCustomSourcesFeature('closeCustomSourceModal', args); }
function switchCustomSourceMode(...args: any[]) { return callCustomSourcesFeature('switchCustomSourceMode', args); }
function toggleSource(...args: any[]) { return callCustomSourcesFeature('toggleSource', args); }
function deleteSource(...args: any[]) { return callCustomSourcesFeature('deleteSource', args); }
function reloadSource(...args: any[]) { return callCustomSourcesFeature('reloadSource', args); }
function togglePublicSourcesSetting(...args: any[]) { return callCustomSourcesFeature('togglePublicSourcesSetting', args); }

const playlistModalFeature = initPlaylistModalFeature({
    getCurrentPlayingSong: () => currentPlayingSong,
    getCurrentListData: () => currentListData,
    isUserLoggedIn: isPlayerUserLoggedIn,
    requireAdminForOpenWrite: (action) => requireAdminForOpenWrite(action),
    renderMyLists: (data) => renderMyLists(data),
    isCurrentlyViewingLocalList: (listId) => isCurrentlyViewingLocalList(listId),
    handleListClick: (listId, skipAutoUpdate) => handleListClick(listId, skipAutoUpdate),
    pushDataChange: (data) => pushDataChange(data),
    refreshUserListData: () => refreshUserListData(),
    exitBatchMode: () => (window as any).exitBatchMode?.(),
    deselectAll: () => (window as any).deselectAll?.(),
    getUserAuthHeaders: getPlayerUserAuthHeaders,
    showError,
    showInfo,
    showSuccess,
    handleCreateList: () => handleCreateList(),
    updatePlayerInfo: (song, quality) => updatePlayerInfo(song, quality),
});
const {
    renderPlaylistAddGrid,
    openPlaylistAddModal,
    closePlaylistAddModal,
    cleanSongData,
    handleTogglePlaylist,
} = playlistModalFeature;

function loadCacheFeature() {
    return loadPlayerFeature(
        'cache',
        () => import('./features/cache').then(({ initCacheFeature }) => initCacheFeature({
            getUserAuthHeaders: getPlayerUserAuthHeaders,
            isAdminSessionActive: () => adminSessionActive,
            getSettings: () => settings,
            setSettings: (nextSettings) => {
                settings = nextSettings;
                window.settings = nextSettings;
            },
            persistSettings: () => persistSettings(),
            pushSettingsToServer: () => pushSettingsToServer(),
            setPlayerDrawerOpen,
            showSelect,
            showSuccess,
            showInfo,
            showError,
            escapeHtmlText,
            defaultSettings: DEFAULT_SETTINGS,
            getDownloadStatusHtml: (icon, message, loading) => downloadManager.getStatusHtml(icon, message, loading),
        })),
        '正在加载缓存管理...'
    );
}

function callCacheFeature(name: string, args: any[] = []) {
    return loadCacheFeature().then((feature) => {
        const handler = (feature as any)[name];
        return typeof handler === 'function' ? handler(...args) : undefined;
    });
}

function updateStorageStatsUI(...args: any[]) { return callCacheFeature('updateStorageStatsUI', args); }
function resetAllSettings(...args: any[]) { return callCacheFeature('resetAllSettings', args); }
function clearCache(...args: any[]) { return callCacheFeature('clearCache', args); }
function updateServerCacheSize(...args: any[]) { return callCacheFeature('updateServerCacheSize', args); }
function toggleCacheDrawer(...args: any[]) { return callCacheFeature('toggleCacheDrawer', args); }
function refreshCacheList(...args: any[]) { return callCacheFeature('refreshCacheList', args); }
function retryCacheLyric(...args: any[]) { return callCacheFeature('retryCacheLyric', args); }
function downloadAllCacheLyrics(...args: any[]) { return callCacheFeature('downloadAllCacheLyrics', args); }
function toggleCacheBatchMode(...args: any[]) { return callCacheFeature('toggleCacheBatchMode', args); }
function exitCacheBatchMode(...args: any[]) { return callCacheFeature('exitCacheBatchMode', args); }
function toggleCacheSelection(...args: any[]) { return callCacheFeature('toggleCacheSelection', args); }
function selectAllCache(...args: any[]) { return callCacheFeature('selectAllCache', args); }
function deselectAllCache(...args: any[]) { return callCacheFeature('deselectAllCache', args); }
function updateCacheBatchCount(...args: any[]) { return callCacheFeature('updateCacheBatchCount', args); }
function removeCacheItem(...args: any[]) { return callCacheFeature('removeCacheItem', args); }
function batchDeleteCache(...args: any[]) { return callCacheFeature('batchDeleteCache', args); }
function clearServerCache(...args: any[]) { return callCacheFeature('clearServerCache', args); }

const libraryFeature = initLibraryFeature({
    getUserAuthHeaders: getPlayerUserAuthHeaders,
    isUserLoggedIn: isPlayerUserLoggedIn,
    isAdminSessionActive: () => adminSessionActive,
    requireAdminForOpenWrite: (action) => requireAdminForOpenWrite(action),
    showInfo,
    showSuccess,
    showError,
    showSelect,
    makeKeyboardActivatable: (element, label, activate) => makeKeyboardActivatable(element, label, activate),
    enterArtist: (id, source) => enterArtist(id, source),
    enterAlbum: (id, source) => enterAlbum(id, source),
    downloadArtistAlbumSongs: (album, button) => downloadArtistAlbumSongs(album, button),
    exitListSecondaryModes: () => exitListSecondaryModes(),
    leaveSearchNavigation: () => clearSearchNavigation(),
    setCurrentSearchScope,
    getSourceTag: (source) => getSourceTag(source),
});
const {
    loadLibraryData,
    saveLibraryArtists,
    saveLibraryAlbums,
    toggleArtistFavorite,
    isArtistFavorited,
    toggleAlbumFavorite,
    updateAlbumLibraryMeta,
    syncAllLibraryAlbums,
    isAlbumFavorited,
    renderLibraryArtists,
    renderLibraryAlbums,
    handleArtistLibraryClick,
    handleAlbumLibraryClick,
    enterLibraryArtistBatch,
    exitLibraryArtistBatch,
    toggleLibArtistBatchSelect,
    libSelectAllArtists,
    libDeselectAllArtists,
    libDeleteSelectedArtists,
    removeLibraryArtist,
    enterLibraryAlbumBatch,
    exitLibraryAlbumBatch,
    toggleLibAlbumBatchSelect,
    libSelectAllAlbums,
    libDeselectAllAlbums,
    libDeleteSelectedAlbums,
    removeLibraryAlbum,
} = libraryFeature;

const searchFeature = initSearchFeature({
    getSettings: () => settings,
    getCurrentPage: () => currentPage,
    setCurrentPage: (page) => {
        setPlayerPage(page);
    },
    getCurrentListData: () => currentListData,
    getUserAuthHeaders: getPlayerUserAuthHeaders,
    switchTab: (tabId, preserveSearchNavigation) => switchTab(tabId, preserveSearchNavigation),
    setCurrentSearchScope,
    loadLibraryData: (...args) => loadLibraryData(...args),
    isArtistFavorited: (...args) => isArtistFavorited(...args),
    isAlbumFavorited: (...args) => isAlbumFavorited(...args),
    updateAlbumLibraryMeta: (...args) => updateAlbumLibraryMeta(...args),
    renderLibraryArtists: (...args) => renderLibraryArtists(...args),
    renderLibraryAlbums: (...args) => renderLibraryAlbums(...args),
    playFromView: (index) => playFromView(index),
    showInfo,
    showError,
});
const {
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
} = searchFeature;
clearSearchNavigation = leaveSearchView;
Object.assign(window, { getImgUrl, createMarqueeHtml, applyMarqueeChecks });

// Initialize Unified Search for Global (Favorites/Search)
window.goToPage = function (page) {
    setPlayerPage(page);
    // Local favorite lists are already loaded in memory. Sending their page
    // through the network-search path can replace the list with unrelated
    // results when this callback is used by local-list search navigation.
    if (window.currentSearchScope === 'local_list' || window.currentSearchScope === 'local_all') {
        renderResults(window.viewingPlaylist || []);
        return;
    }
    if (typeof doSearch === 'function') void doSearch(currentPage);
};

function initGlobalListSearch() {
    if (window.ListSearch) {
        window.ListSearch.init('global', {
            renderCallback: () => renderResults(window.viewingPlaylist),
            paginationCallback: (page, index) => {
                window.goToPage(page);
                setTimeout(() => window.ListSearch.scrollToMatch(index), 300);
            },
            getList: () => window.viewingPlaylist,
            itemsPerPage: settings.itemsPerPage === 'all' ? 999999 : parseInt(settings.itemsPerPage)
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initGlobalListSearch();
});

// Settings & Batch Selection
let settings = { ...DEFAULT_SETTINGS };

function persistSettings() {
    localStorage.setItem('lx_settings', JSON.stringify(serializeSettings(settings)));
}

// 歌词原始数据，用于设置切换时重新渲染
let currentRawLrc = '';
let currentRawTlrc = '';
let currentRawRlrc = '';
let currentRawKlrc = ''; // 逐词歌词 (klyric/lxlyric)
let lastLyricSongId = null; // 追踪上次加载歌词的歌曲ID

let currentRecoveryState = null; // 播放失败自动恢复状态管理

// 从 localStorage 加载设置
try {
    const saved = localStorage.getItem('lx_settings');
    if (saved) {
        const parsed = JSON.parse(saved);
        settings = normalizeStoredSettings({ ...settings, ...parsed });
        persistSettings();
    }
} catch (e) {
    console.error('[Settings] 加载设置失败:', e);
}
window.settings = settings; // 显式挂载到 window

// Player-owned managers are regular modules. Their DOM events are delegated by
// the modules themselves, so HTML does not need global manager proxies.
songListManager = createSongListManager({ downloadSong, handleBatchSelect });
registerSongListManager(songListManager);
downloadManager = new DownloadManager();
registerDownloadManager(downloadManager);
function openLocalModeSettings() {
    switchTab('settings');
    setTimeout(() => document.getElementById('btn-mode-local')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}
registerPlayerEventAction('open-local-mode-settings', () => openLocalModeSettings());
registerPlayerEventAction('update-server-cache-location', (_event, element, args) => {
    const value = args[0] ?? (element as HTMLSelectElement).value;
    updateSetting('serverCacheLocation', value);
    updateServerCacheConfig(value);
});
registerPlayerEventAction('update-server-cache-naming', (_event, element, args) => {
    const value = args[0] ?? (element as HTMLInputElement).value;
    updateSetting('serverCacheNamingPattern', value);
    updateServerCacheConfig(null, value);
});
registerPlayerEventAction('trigger-player-like', () => {
    document.getElementById('player-like-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
registerPlayerEventAction('open-script-file', () => {
    document.getElementById('script-file')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
registerPlayerEventAction('set-lyric-lines', (_event, _element, args) => {
    const lines = String(args[0] ?? '');
    (window as any).lyricCard?.setLyricLines(Number(lines));
    document.querySelectorAll<HTMLElement>('.lc-lines-btn').forEach(button => {
        button.classList.toggle('lc-btn-active', button.dataset.lines === lines);
    });
});
bindPlayerEvents();

window.networkListUpdateMap = new Set();
let networkListAutoCheckTimer = null;
let networkListCheckInFlight = false;

function parseNetworkListAutoCheckInterval(value) {
    const minIntervalMs = 30 * 1000;
    if (value === undefined || value === null) return 0;
    const raw = String(value).trim().toLowerCase();
    if (raw === '' || raw === '0' || raw === 'off' || raw === 'none' || raw === 'disable') return 0;
    const matched = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
    if (!matched) return null;
    const count = parseFloat(matched[1]);
    const unit = matched[2] || 'h';
    if (!Number.isFinite(count) || count < 0) return null;
    let intervalMs = null;
    switch (unit) {
        case 'ms': intervalMs = count; break;
        case 's': intervalMs = count * 1000; break;
        case 'm': intervalMs = count * 60 * 1000; break;
        case 'h': intervalMs = count * 60 * 60 * 1000; break;
        case 'd': intervalMs = count * 24 * 60 * 60 * 1000; break;
        default: return null;
    }
    return Math.max(intervalMs, minIntervalMs);
}

function setupNetworkListAutoCheck() {
    if (networkListAutoCheckTimer) {
        clearInterval(networkListAutoCheckTimer);
        networkListAutoCheckTimer = null;
    }
    if (!settings.autoUpdateNetworkList) {
        return;
    }
    const intervalMs = parseNetworkListAutoCheckInterval(settings.networkListAutoCheckInterval);
    if (intervalMs === null || intervalMs <= 0) {
        return;
    }
    networkListAutoCheckTimer = setInterval(() => {
        checkNetworkListUpdates().catch(err => console.error('[AutoCheck] 网络歌单检测失败:', err));
    }, intervalMs);
    console.log('[AutoCheck] 已设置网络歌单自动检测间隔：', settings.networkListAutoCheckInterval, '(', intervalMs, 'ms )');
}

async function checkNetworkListUpdates(manual = false) {
    // 定时器间隔可能短于网络响应时间；禁止同一批歌单检查重叠，避免重复请求。
    if (networkListCheckInFlight) return;
    networkListCheckInFlight = true;
    try {
    if (!currentListData || !Array.isArray(currentListData.userList) || currentListData.userList.length === 0) {
        if (manual && window.showToast) showToast('info', '当前没有可检查的网络歌单', 3000);
        return;
    }

    const targetLists = currentListData.userList.filter(l => l && l.sourceListId && l.source);
    if (targetLists.length === 0) {
        if (manual && window.showToast) showToast('info', '当前没有可检查的网络歌单', 3000);
        return;
    }

    const changedLists = [];
    const failedLists = [];

    for (const list of targetLists) {
        try {
            const url = `${API_BASE}/songList/detail?source=${encodeURIComponent(list.source)}&id=${encodeURIComponent(list.sourceListId)}&page=1`;
            const res = await fetch(url);
            const data = await res.json();
            if (!data || !Array.isArray(data.list)) {
                throw new Error('远端歌单数据不完整');
            }

            const remoteList = data.list.map(item => {
                const formatted = formatSongToLxMusicStandard(item);
                if (!formatted.source) formatted.source = list.source;
                return formatted;
            });

            const localList = Array.isArray(list.list) ? list.list : [];
            const sameLength = localList.length === remoteList.length;
            const sameIds = sameLength && localList.every((item, index) => item && remoteList[index] && String(item.id || '') === String(remoteList[index].id || '') && String(item.source || '') === String(remoteList[index].source || ''));
            if (!sameIds) {
                window.networkListUpdateMap.add(list.id);
                changedLists.push(list.name || list.id || list.sourceListId);
            } else {
                window.networkListUpdateMap.delete(list.id);
            }
        } catch (err) {
            console.error('[CheckNetworkListUpdates] 检查失败:', list.name || list.id || list.sourceListId, err);
            failedLists.push(list.name || list.id || list.sourceListId);
        }
    }

    if (typeof renderMyLists === 'function') {
        renderMyLists(currentListData);
    }

    if (manual) {
        const changedListNames = changedLists.map(escapeHtmlText);
        const failedListNames = failedLists.map(escapeHtmlText);
        if (changedLists.length > 0) {
            showSuccess(`检测到 ${changedLists.length} 个歌单已更新：${changedListNames.join('、')}`);
        } else if (failedLists.length === 0) {
            showSuccess('所有网络歌单均为最新状态');
        }
        if (failedLists.length > 0) {
            showError(`部分歌单检测失败：${failedListNames.join('、')}`);
        }
    } else if (changedLists.length > 0 && window.showToast) {
        showToast('info', `检测到 ${changedLists.length} 个网络歌单有更新`, 5000);
    }
    } finally {
        networkListCheckInFlight = false;
    }
}

window.checkNetworkListUpdates = checkNetworkListUpdates;



// Initial Sync for Server Cache Config
setTimeout(() => {
    if (settings.serverCacheLocation && window.updateServerCacheConfig) {
        console.log('[ServerCache] Syncing config:', settings.serverCacheLocation, settings.serverCacheNamingPattern);
        window.updateServerCacheConfig(settings.serverCacheLocation, settings.serverCacheNamingPattern);
    }
}, 2000);

window.batchMode = false;
window.selectedItems = new Set();
window.selectedSongObjects = new Map();
let expandBtnTimeout = null; // 展开按钮淡化计时器
let toggleLyricsBtnTimeout = null; // 歌词按钮淡化计时器

// ===== 认证功能 =====
const authFeature = initAuthFeature({
    getUserName: () => userName,
    setUserName: (value) => { userName = value; },
    isUserSessionActive: () => userSessionActive,
    setUserSessionActive: (active) => { userSessionActive = active; },
    showSelect,
    handleLogout: (skipConfirm) => handleUserLogout(skipConfirm),
    onSessionChanged: (active) => {
        syncUserSessionStatus();
        if (active) {
            updateAdminUI();
            syncSettingsUI();
        }
    },
});
playerAuthBridge = authFeature;
const {
    getUserAuthHeaders,
    isUserLoggedIn,
    isPublicLibraryContext,
    ensureUserSession,
    updateUserUI,
    handleHeaderLogout,
} = authFeature;
const settingsFeature = initSettingsFeature({
    getSettings: () => settings,
    setSettings: (nextSettings) => {
        settings = nextSettings;
        window.settings = nextSettings;
    },
    persistSettings: () => persistSettings(),
    syncSettingsUI: () => syncSettingsUI(),
    setupNetworkListAutoCheck: () => setupNetworkListAutoCheck(),
    pushSoundEffects: () => {
        if (window.soundEffects && typeof window.soundEffects.pushToServer === 'function') {
            window.soundEffects.pushToServer();
        }
    },
    fetchSoundEffects: () => {
        if (window.soundEffects && typeof window.soundEffects.fetchFromServer === 'function') {
            window.soundEffects.fetchFromServer();
        }
    },
    getUserName: () => userName,
    showSuccess,
    showError,
});
const {
    pushSettingsToServer,
    manualSaveSettings,
    fetchSettingsFromServer,
} = settingsFeature;
const songUrlFeature = initSongUrlFeature({
    getSettings: () => settings,
    getPlaylist: () => currentPlaylist,
    getCurrentIndex: () => currentIndex,
    getPlayMode: () => playMode,
    getPreSelectedNextIndex: () => preSelectedNextIndex,
    setPreSelectedNextIndex: (index) => { preSelectedNextIndex = index; },
    getUserAuthHeaders,
    fetchCustomSources,
    cleanSongData,
    checkServerCache: (...args) => checkServerCache(...args),
    updateStorageStatsUI,
    showInfo,
    showSuccess,
    showError,
    showPlaybackStatus,
});
const {
    getSourceTypeText,
    getSourceName,
    resolveSongUrl,
    resolveDownloadSongUrl,
    findOtherSourceMatch,
    findOtherSourceMatches,
    applyAutoProxy,
    fetchSongUrl,
    getNextIndex,
    prefetchNextSong,
    prefetchManager,
} = songUrlFeature;

async function fetchPublicListData() {
    const enablePublicFavorites = !!window.lx_config?.['user.enablePublicFavorites'];
    const enablePublicNonAdminAccess = !!window.lx_config?.['user.enablePublicNonAdminAccess'];
    const isAdmin = adminSessionActive;
    const isUserLoggedIn = typeof window.isUserLoggedIn === 'function' ? window.isUserLoggedIn() : false;

    if (!enablePublicFavorites) return false;

    // 如果开启了公开收藏，但没开启非管理员访问，且既没登录个人账号也没登录管理员，则不可访问公开收藏
    if (!enablePublicNonAdminAccess && !isAdmin && !isUserLoggedIn) {
        console.log('[PublicList] 未开启非管理员访问且未登录管理员/个人账号，禁止加载公开歌单');
        return false;
    }

    try {
        console.log('[PublicList] 正在获取 _open 公共歌单数据...');
        const res = await fetch('/api/user/list?user=_open', {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (res.ok) {
            const listData = await res.json();
            if (listData) {
                listData.username = '_open';
                // 将公共列表保存为 window.publicListData，切换展示用
                window.publicListData = listData;
                currentListData = listData;
                window.currentListData = listData;
                renderMyLists(listData);
                console.log('[PublicList] 公共歌单数据加载成功');
                if (typeof loadLibraryData === 'function') {
                    await loadLibraryData();
                }
                return true;
            }
        }
    } catch (err) {
        console.warn('[PublicList] 加载公共歌单失败:', err);
    }
    return false;
}
window.fetchPublicListData = fetchPublicListData;

async function reloadUserFavorites() {
    try {
        if (!isUserLoggedIn()) {
            // 未登录个人账号时，加载 _open 公开歌单
            const loaded = await fetchPublicListData();
            if (loaded) return;
            currentListData = null;
            window.currentListData = null;
            renderMyLists(null);
            return;
        }

        // 1. 先恢复已缓存的个人数据（避免切换时白屏）
        if (window.myPersonalListData) {
            currentListData = window.myPersonalListData;
            window.currentListData = window.myPersonalListData;
            renderMyLists(window.myPersonalListData);
        } else {
            currentListData = null;
            window.currentListData = null;
        }

        // 2. 再从服务器拉最新数据
        const res = await fetch('/api/user/list', {
            credentials: 'same-origin',
            cache: 'no-store'
        });
        if (res.ok) {
            const listData = await res.json();
            if (listData) {
                currentListData = listData;
                window.currentListData = listData;
                window.myPersonalListData = listData;
                renderMyLists(listData);
                await window.ListStore.set(listData).catch(e => console.error('[IDBStore] 保存失败:', e));
                if (typeof loadLibraryData === 'function') {
                    await loadLibraryData();
                }
            }
        }
    } catch (e) {
        console.error('[ReloadFavorites] Error:', e);
    }
}
window.reloadUserFavorites = reloadUserFavorites;

window.isViewingPublicFavorites = false;

async function handleTogglePublicFavorites() {
    clearLibraryBatchContext();
    resetSharedBatchSelection();
    window.isViewingPublicFavorites = !window.isViewingPublicFavorites;
    if (window.isViewingPublicFavorites) {
        // 切换到公开列表之前，先保存当前个人数据
        if (currentListData && currentListData.username !== '_open') {
            window.myPersonalListData = currentListData;
        }
        showInfo('已切换至【公开收藏】列表 (_open)');
        const loaded = await fetchPublicListData();
        if (!loaded) {
            showError('加载公开收藏失败');
            window.isViewingPublicFavorites = false;
            // 恢复个人列表
            if (window.myPersonalListData) {
                currentListData = window.myPersonalListData;
                window.currentListData = window.myPersonalListData;
                renderMyLists(window.myPersonalListData);
            }
        } else {
            if (typeof loadLibraryData === 'function') {
                await loadLibraryData();
            }
        }
    } else {
        showInfo('已切换至【个人收藏】列表');
        await reloadUserFavorites();
        if (typeof loadLibraryData === 'function') {
            await loadLibraryData();
        }
    }
}
window.handleTogglePublicFavorites = handleTogglePublicFavorites;

// 页面加载时：检查是否开启认证，若开启则显示登出按钮
let resolveUserSessionReady: (() => void) | null = null;
const userSessionReady = Promise.race([
    new Promise<void>((resolve) => {
        resolveUserSessionReady = resolve;
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
]);

(async () => {
    try {
        const response = await fetch('/api/music/config');
        const config = await response.json();
        window.lx_config = config; // 获取公共配置供权限模块使用
        authEnabled = config['player.enableAuth'] === true;

        // 若开启认证，显示登出按钮
        if (authEnabled) {
            const logoutBtn = document.getElementById('logout-btn');
            if (logoutBtn) {
                logoutBtn.classList.remove('hidden');
                logoutBtn.classList.add('flex');
            }
        }

        // 获取到公共配置后，立即刷新一次 UI 状态 (管理员按钮/设置项禁用等)
        if (typeof syncSettingsUI === 'function') syncSettingsUI();
        else if (typeof updateAdminUI === 'function') updateAdminUI();

        // Restore the HttpOnly user session after a browser restart.
        try {
            const userSessionRes = await fetch('/api/user/auth/verify', {
                credentials: 'same-origin'
            });
            const userSessionData = await userSessionRes.json();
            if (userSessionData.valid && userSessionData.username) {
                userSessionActive = true;
                userName = userSessionData.username;
                localStorage.setItem('lx_user_name', userSessionData.username);
            }
        } catch (e) {
            console.warn('[Auth] 用户会话恢复失败:', e);
        }

        // The settings card can render before this asynchronous cookie check
        // finishes. Keep its status synchronized with the authoritative session
        // result instead of leaving the initial "未登录" placeholder visible.
        syncUserSessionStatus();

        resolveUserSessionReady?.();

        // [新增] 公开受限用户自动尝试从服务器拉取配置 (_open)
        if (config['user.enablePublicRestriction']) {
            console.log('[Auth] 检测到公开限制已开启，尝试拉取公共配置...');
            if (typeof fetchSettingsFromServer === 'function') {
                await fetchSettingsFromServer();
            }
        }

        // [新增] 检查公开收藏功能：若无账号登录且开启了公开收藏，尝试拉取公共歌单
        if (config['user.enablePublicFavorites'] && !isUserLoggedIn()) {
            console.log('[Auth] 检测到已开启公开收藏且无账号登录，正在拉取公共歌单...');
            const loaded = await fetchPublicListData();
            if (!loaded) {
                renderMyLists(null);
            }
        }

        // [新增] 更新 UI 上的用户名状态
        updateUserUI();

    } catch (error) {
        console.error('[Auth] 初始化检查失败:', error);
        resolveUserSessionReady?.();
    }
})();

// 登出：调用服务端清除 Session，清除本地全量缓存，跳转到登录页
async function handleLogout() {
    try {
        await fetch('/api/music/auth/logout', { method: 'POST' });
    } catch (e) {
        console.error('[Auth] 登出请求失败:', e);
    }

    try {
        if (typeof audio !== 'undefined' && audio) {
            audio.pause();
            audio.currentTime = 0;
            audio.src = '';
        }
        prefetchManager.clear();
        if (window.ListStore && typeof window.ListStore.remove === 'function') {
            await window.ListStore.remove().catch(() => {});
        }
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
        }
    } catch (e) {}

    const agreementAccepted = localStorage.getItem('lx_agreement_accepted');
    localStorage.clear();
    sessionStorage.clear();
    if (agreementAccepted) localStorage.setItem('lx_agreement_accepted', agreementAccepted);

    const playerPath = (window.CONFIG && window.CONFIG['player.path']) || (window.lx_config && window.lx_config['player.path']) || '/music';
    const normalizedPlayerPath = (playerPath === '/' || playerPath === '') ? '' : playerPath.replace(/\/+$/, '');
    window.location.replace(`${normalizedPlayerPath}/login`);
}
// ===== 认证代码结束 =====

// 音质选择器初始化
document.addEventListener('DOMContentLoaded', () => {
    // 音质选择器初始化
    const qualitySelect = document.getElementById('quality-select');
    if (qualitySelect && settings.preferredQuality) {
        qualitySelect.value = settings.preferredQuality;
    }

    const proxyDownload = document.getElementById('toggle-proxy-download');
    if (proxyDownload) proxyDownload.checked = settings.enableProxyDownload;

    const autoProxy = document.getElementById('toggle-auto-proxy');
    if (autoProxy) autoProxy.checked = settings.enableAutoProxy;

    // Initialize Custom Proxy UI
    const customProxyToggle = document.getElementById('toggle-custom-proxy');
    if (customProxyToggle) customProxyToggle.checked = settings.enableCustomProxy;
    const customProxyInput = document.getElementById('custom-proxy-url-input');
    if (customProxyInput) customProxyInput.value = settings.customProxyUrl || '';
    const customProxyRow = document.getElementById('custom-proxy-url-row');
    if (customProxyRow) customProxyRow.classList.toggle('hidden', !settings.enableCustomProxy);

    const hotSearchLimitInput = document.getElementById('hot-search-limit-input');
    if (hotSearchLimitInput) {
        hotSearchLimitInput.value = (settings.hotSearchLimit !== undefined && settings.hotSearchLimit !== null) ? settings.hotSearchLimit : 20;
    }

    // Initialize Song List module after the DOM is ready.
    songListManager.init();

    // Initialize Lyric Font Size UI
    const lyricFontSizeSlider = document.getElementById('lyric-font-size-slider');
    const lyricFontSizeValue = document.getElementById('lyric-font-size-value');
    if (lyricFontSizeSlider && lyricFontSizeValue) {
        const size = settings.lyricFontSize || 1.25;
        lyricFontSizeSlider.value = size;
        lyricFontSizeValue.innerText = size;
        document.documentElement.style.setProperty('--lyric-font-size', `${size}rem`);
    }

    // Initialize Lyric Font Family UI
    const lyricFontFamilySelect = document.getElementById('lyric-font-family-select');
    if (lyricFontFamilySelect) {
        const fontFamily = settings.lyricFontFamily || '';
        // Check if value exists in default options, if not create it (unless empty)
        if (fontFamily) {
            let exists = Array.from(lyricFontFamilySelect.options).some(opt => opt.value === fontFamily);
            if (!exists) {
                const option = document.createElement('option');
                option.value = fontFamily;
                option.textContent = fontFamily; // Fallback display name
                lyricFontFamilySelect.add(option, null);
            }
            lyricFontFamilySelect.value = fontFamily;
            document.documentElement.style.setProperty('--lyric-font-family', fontFamily);
        }
    }

    // Initialize Progress & Volume Dragging
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) {
        progressContainer.addEventListener('mousedown', (e) => startDragging(e, 'progress'));
        progressContainer.addEventListener('touchstart', (e) => startDragging(e, 'progress'), { passive: false });
    }

    const volumeContainer = document.getElementById('volume-container');
    if (volumeContainer) {
        volumeContainer.addEventListener('mousedown', (e) => startDragging(e, 'volume'));
        volumeContainer.addEventListener('touchstart', (e) => startDragging(e, 'volume'), { passive: false });
    }

    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('touchmove', handleDragMove, { passive: false });
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('touchend', stopDragging);

    // 同步所有设置 UI
    syncSettingsUI();
    updateUserUI();
});

// Dragging Logic
let isDragging = null; // 'progress' or 'volume'
let dragPercentage = 0; // Temp value for progress smoothing
let lastSeekTime = 0; // Throttling for live seeking
let lastSeekPct = -1; // 上次执行 seek 时的进度百分比，用于避免原地抖动
const SEEK_THROTTLE_MS = 100; // How often to update audio position while dragging (ms)

function startDragging(e, type) {
    if (e.type === 'touchstart') e.preventDefault(); // Prevent scrolling while seeking
    isDragging = type;
    if (type === 'progress') lastSeekPct = -1; // 重置
    handleDragMove(e);
}

function stopDragging() {
    if (isDragging === 'progress' && Number.isFinite(dragPercentage) && audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = dragPercentage * audio.duration;
        if (typeof lyricPlayer !== 'undefined' && lyricPlayer) {
            if (!audio.paused) {
                lyricPlayer.play(audio.currentTime * 1000);
            } else {
                lyricPlayer.pause();
                const lineNum = findCurrentLyricLine(audio.currentTime * 1000);
                if (lineNum !== undefined && lineNum >= 0) {
                    syncLyricByLineNum(lineNum);
                }
            }
            scrollToActiveLine(true);
        }
    }
    isDragging = null;
    lastSeekPct = -1;
}

function handleDragMove(e) {
    if (!isDragging) return;

    if (e.type === 'touchmove') e.preventDefault(); // Prevent scrolling

    const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;

    if (isDragging === 'progress') {
        const container = document.getElementById('progress-container');
        if (!container || !audio.duration || !Number.isFinite(audio.duration)) return;
        const rect = container.getBoundingClientRect();
        const x = clientX - rect.left;
        const pct = Math.max(0, Math.min(1, x / rect.width));

        dragPercentage = pct;

        // 1. Update UI immediately (Smooth preview without network Range request flood)
        document.getElementById('progress-bar').style.width = `${pct * 100}%`;
        document.getElementById('time-current').innerText = formatTime(pct * audio.duration);
        document.getElementById('progress-container')?.setAttribute('aria-valuenow', String(Math.round(pct * 100)));

        // 2. Synchronize lyric preview during scrubbing
        if (typeof lyricPlayer !== 'undefined' && lyricPlayer && typeof findCurrentLyricLine === 'function') {
            const previewTime = pct * audio.duration * 1000;
            const lineNum = findCurrentLyricLine(previewTime);
            if (lineNum !== undefined && lineNum >= 0) {
                syncLyricByLineNum(lineNum);
            }
        }
    } else if (isDragging === 'volume') {
        const container = document.getElementById('volume-container');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const x = clientX - rect.left;
        const pct = Math.max(0, Math.min(1, x / rect.width));
        currentVolume = pct;
        audio.volume = pct;
        isMuted = false;
        updateVolumeUI();
        // Debounce saving if needed, but simple localstorage here
        localStorage.setItem('lx_volume', currentVolume.toString());
    }
}

function changeProxyDownload(enabled) {
    updateSetting('enableProxyDownload', enabled);
}

function changeAutoProxy(enabled) {
    updateSetting('enableAutoProxy', enabled);
}

function changeHotSearchLimit(value) {
    const limit = parseInt(value);
    // [Fix] Allow 0, Check Range 0-50
    if (!isNaN(limit) && limit >= 0 && limit <= 50) {
        updateSetting('hotSearchLimit', limit);
    } else {
        showError('请输入 0 到 50 之间的数字');
        // Reset input
        const input = document.getElementById('hot-search-limit-input');
        if (input) input.value = settings.hotSearchLimit || 20;
    }
}

function changeLyricFontSize(value) {
    const size = parseFloat(value);
    if (!isNaN(size)) {
        updateSetting('lyricFontSize', size);
    }
}

// 读取本地字体
/**
 * 通用加载本地字体逻辑
 * @param {string} targetSelectId - 目标下拉框的 ID，默认为设置页的 'lyric-font-family-select'
 * @param {HTMLElement} btnEl - 触发按钮的引用，用于显示加载动画
 */
async function loadLocalFonts(targetSelectId = 'lyric-font-family-select', btnEl = null) {
    if (!('queryLocalFonts' in window)) {
        showError('抱歉，您的浏览器不支持读取本地字体功能 (Local Font Access API)。\n建议使用 Chrome / Edge 浏览器，并确保在 HTTPS 环境下使用。');
        return;
    }

    const btn = btnEl || document.querySelector('button[data-event-click-action="loadLocalFonts"]');
    const originalText = btn ? btn.innerHTML : '';

    try {
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>读取中...';
        }

        const fonts = await window.queryLocalFonts();
        const fontSelect = document.getElementById(targetSelectId);
        if (!fontSelect) return;

        // Use a set to store unique families
        const fontFamilies = new Set();
        fonts.forEach(font => fontFamilies.add(font.family));

        // Sort alphabetically
        const sortedFamilies = Array.from(fontFamilies).sort();

        if (sortedFamilies.length === 0) {
            showError('未能获取到字体列表');
            return;
        }

        // Remove existing local fonts group if exists
        const oldGroup = fontSelect.querySelector('optgroup[data-source="local"]');
        if (oldGroup) {
            oldGroup.remove();
        }

        // Create a single group for local fonts
        const group = document.createElement('optgroup');
        group.dataset.source = 'local';
        group.label = `本地已安装字体 (${sortedFamilies.length})`;

        sortedFamilies.forEach(family => {
            const option = document.createElement('option');
            // 如果是歌词卡片，保持带引号格式；如果是设置页，保持原样（lyric-card.js 会处理字体族名称）
            option.value = targetSelectId === 'lc-font-select' ? `"${family}", sans-serif` : family;
            option.textContent = family;
            group.appendChild(option);
        });
        fontSelect.appendChild(group);

        showSuccess(`成功获取 ${sortedFamilies.length} 个本地字体！`);

    } catch (err) {
        console.error('[Font] Error loading fonts:', err);
        showError('获取字体失败: ' + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

function changeLyricFontFamily(value) {
    updateSetting('lyricFontFamily', value.trim());
}

// 切换音质偏好
function changeQualityPreference(quality) {
    updateSetting('preferredQuality', quality);
}


// Tab Switching (Delegated to modular Navigation Feature)
const switchTab = createTabSwitcher({
    handleFavoritesClick: () => handleFavoritesClick(),
    clearSearchNavigation: () => clearSearchNavigation(),
    updateUserUI: () => updateUserUI(),
    syncSettingsUI: () => syncSettingsUI(),
    updateAdminUI: () => updateAdminUI(),
    setCurrentSearchScope: (scope) => setCurrentSearchScope(scope),
    exitListSecondaryModes: () => exitListSecondaryModes(),
    toggleSidebar: (forceState) => toggleSidebar(forceState),
    initGlobalListSearch: () => initGlobalListSearch(),
    showInitialSearchState: () => showInitialSearchState(),
    ensureSearchContent: () => ensureSearchContent(),
    songListManager,
    ensureLeaderboardLoaded: () => ensureLeaderboardLoaded(),
    ensureLocalMusicLoaded: () => ensureLocalMusicLoaded(),
    showError: (msg) => showError(msg),
    loadCustomSources: () => loadCustomSources(),
    loadAboutContent: () => loadAboutContent(),
    toggleBatchMode: () => toggleBatchMode(),
    clearPendingTimeouts: () => {
        if (expandBtnTimeout) clearTimeout(expandBtnTimeout);
        if (toggleLyricsBtnTimeout) clearTimeout(toggleLyricsBtnTimeout);
    },
});
(window as any).switchTab = switchTab;

/**
 * 退出列表的二级模式（搜索框和批量模式）
 */
function exitListSecondaryModes() {
    if (window.ListSearch && window.ListSearch.state.active) {
        window.ListSearch.resetState();
    }
    if (window.batchMode) {
        // 搜索/歌单界面退出
        const batchToolbar = document.getElementById('batch-toolbar');
        const slBatchToolbar = document.getElementById('sl-batch-toolbar');
        if ((batchToolbar && !batchToolbar.classList.contains('hidden')) || (slBatchToolbar && !slBatchToolbar.classList.contains('hidden'))) {
            if (typeof toggleBatchMode === 'function') toggleBatchMode();
        }

        // 排行榜界面退出
        const lbBatchToolbar = document.getElementById('lb-batch-toolbar');
        if (lbBatchToolbar && !lbBatchToolbar.classList.contains('hidden')) {
            if (typeof toggleLbBatchMode === 'function') toggleLbBatchMode();
        }
    }
    if (window.libraryBatchMode) clearLibraryBatchContext();
}

// Load About Content
async function loadAboutContent() {
    const aboutContainer = document.getElementById('about-content');
    if (!aboutContainer) return;

    try {
        const response = await fetch('/music/about.md');
        if (!response.ok) throw new Error('Failed to load about.md');
        const text = await response.text();

        // Render Markdown. The parser is only needed when the About tab is opened.
        await ensureMarkedLoaded().catch(() => undefined);
        if ((window as any).marked) {
            // Replace the build hash placeholder; application version is intentionally not shown in the UI.
            const buildHash = (window.CONFIG && window.CONFIG.buildHash) || 'unknown';
            const content = text.replace(/{{buildHash}}/g, buildHash);
            renderSafeMarkdown(aboutContainer, content);
        } else aboutContainer.innerText = text;
        aboutContainer.classList.remove('animate-pulse');
    } catch (e) {
        console.error('Failed to load about content:', e);
        aboutContainer.innerHTML = '<p class="text-red-500">加载关于页面失败，请稍后重试。</p>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // 恢复搜索来源缓存
    const cachedSearchSource = localStorage.getItem('search-source');
    if (cachedSearchSource) {
        const searchSourceEl = document.getElementById('search-source');
        if (searchSourceEl) searchSourceEl.value = cachedSearchSource;
    }

    // 为展开按钮添加悬放恢复逻辑
    const expandBtn = document.getElementById('btn-expand-panel');
    if (expandBtn) {
        expandBtn.addEventListener('mouseenter', () => {
            if (expandBtnTimeout) clearTimeout(expandBtnTimeout);
            expandBtn.classList.remove('faint');
        });
        expandBtn.addEventListener('mouseleave', () => {
            const footer = document.getElementById('player-footer');
            if (footer && footer.classList.contains('translate-y-[110%]')) {
                startExpandBtnTimer();
            }
        });
    }

    // 为歌词详情顶栏按钮添加悬停恢复逻辑
    const toggleLyricsBtn = document.getElementById('btn-toggle-lyrics');
    if (toggleLyricsBtn) {
        toggleLyricsBtn.addEventListener('mouseenter', () => {
            if (toggleLyricsBtnTimeout) clearTimeout(toggleLyricsBtnTimeout);
            toggleLyricsBtn.classList.remove('faint');
        });
        toggleLyricsBtn.addEventListener('mouseleave', () => {
            const view = document.getElementById('view-player-detail');
            if (view && !view.classList.contains('translate-y-[100%]')) {
                startToggleLyricsBtnTimer();
            }
        });
    }
});

// ==================== 播放队列 (Queue) 逻辑 ====================
// --- Native Drag & Drop Handlers (Removed, replaced by SortableJS) ---
// ===============================================

// Search logic moved to features/search.ts
// Playback Logic
let currentLoadingSongId = null; // Track currently loading song
let loadingRequestCounter = 0;   // To identify unique play requests
let currentLoadingRequestId = 0; // Track latest request ID

let currentQuality = null; // 当前播放音质 (从 settings.preferredQuality 动态获取)
let currentSourceType = 'normal'; // 当前链接来源类型: 'normal' | 'cache' | 'server_cache'

const playbackState: PlaybackState = {
    get currentLoadingSongId() { return currentLoadingSongId; },
    set currentLoadingSongId(value) { currentLoadingSongId = value; },
    get loadingRequestCounter() { return loadingRequestCounter; },
    set loadingRequestCounter(value) { loadingRequestCounter = value; },
    get currentLoadingRequestId() { return currentLoadingRequestId; },
    set currentLoadingRequestId(value) { currentLoadingRequestId = value; },
    get currentQuality() { return currentQuality; },
    set currentQuality(value) { currentQuality = value; },
    get currentSourceType() { return currentSourceType; },
    set currentSourceType(value) { currentSourceType = value; },
    get currentRecoveryState() { return currentRecoveryState; },
    set currentRecoveryState(value) { currentRecoveryState = value; },
    get currentPlaylist() { return currentPlaylist; },
    set currentPlaylist(value) { currentPlaylist = value; },
    get currentIndex() { return currentIndex; },
    set currentIndex(value) { currentIndex = value; },
    get preSelectedNextIndex() { return preSelectedNextIndex; },
    set preSelectedNextIndex(value) { preSelectedNextIndex = value; },
    get currentPlayingScope() { return currentPlayingScope; },
    set currentPlayingScope(value) { currentPlayingScope = value; },
    get currentPlayingSong() { return currentPlayingSong; },
    set currentPlayingSong(value) { currentPlayingSong = value; },
    get playMode() { return playMode; },
    set playMode(value) { playMode = value; },
    get currentRawLrc() { return currentRawLrc; },
    set currentRawLrc(value) { currentRawLrc = value; },
    get currentRawTlrc() { return currentRawTlrc; },
    set currentRawTlrc(value) { currentRawTlrc = value; },
    get currentRawRlrc() { return currentRawRlrc; },
    set currentRawRlrc(value) { currentRawRlrc = value; },
    get currentRawKlrc() { return currentRawKlrc; },
    set currentRawKlrc(value) { currentRawKlrc = value; },
    get isUserScrolling() { return isUserScrolling; },
    set isUserScrolling(value) { isUserScrolling = value; },
    get scrollLockTimeout() { return scrollLockTimeout; },
    set scrollLockTimeout(value) { scrollLockTimeout = value; },
    get lyricPlayer() { return lyricPlayer; },
    set lyricPlayer(value) { lyricPlayer = value; },
    get currentVolume() { return currentVolume; },
    set currentVolume(value) { currentVolume = value; },
    get isMuted() { return isMuted; },
    set isMuted(value) { isMuted = value; },
};
const playbackFeature = initPlaybackFeature({
    audio: audio as HTMLAudioElement,
    state: playbackState,
    getSettings: () => settings,
    getViewingPlaylist: () => window.viewingPlaylist,
    getCurrentSearchScope: () => window.currentSearchScope,
    getCurrentListData: () => currentListData,
    getUserAuthHeaders,
    resolveSongUrl,
    triggerServerCache: (...args) => triggerServerCache(...args),
    getSourceTypeText,
    getSourceName,
    findOtherSourceMatch,
    getNextIndex,
    prefetchNextSong,
    prefetchManager,
    fetchLyric: (...args) => fetchLyric(...args),
    updateMediaSessionMetadata: (...args) => updateMediaSessionMetadata(...args),
    updateLyricDetailInfo: (...args) => updateLyricDetailInfo(...args),
    renderQueue,
    updateQueueBadge,
    cleanSongData,
    getImgUrl,
    getQualityTags,
    getSourceTag,
    applyMarqueeChecks,
    performSearch,
    showOptions,
    openPlaylistAddModal,
    toggleCurrentLike: () => toggleLove(),
    isUserLoggedIn,
    toggleDetailCover: (...args) => toggleDetailCover(...args),
    showInfo,
    showSuccess,
    showError,
    showPlaybackStatus,
    pushDataChange: (...args) => pushDataChange(...args),
    renderMyLists: (...args) => renderMyLists(...args),
});
const {
    playFromView,
    runRecoveryFlow,
    playSong,
    setPlayerStatus,
    savePlayHistory,
    addToDefaultList,
    updatePlaylist,
    setImg,
    updatePlayerInfo,
    changePlaybackQuality,
    togglePlay,
    updatePlayButton,
    playNext,
    playPrev,
    fadeVolume,
} = playbackFeature;

function resetPlayer() {
    try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
    } catch (e) {}
    prefetchManager.clear();

    currentPlayingSong = null;
    (window as any).currentPlayingSong = null;
    currentIndex = -1;
    currentPlaylist = [];
    preSelectedNextIndex = null;
    currentLoadingSongId = null;
    currentQuality = null;

    updatePlayButton(false);
    updatePlayerInfo(null);
    setPlayerStatus('', false);

    const progressBar = document.getElementById('progress-bar');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');
    if (progressBar) progressBar.style.width = '0%';
    if (timeCurrent) timeCurrent.innerText = '00:00';
    if (timeTotal) timeTotal.innerText = '00:00';
    document.getElementById('progress-container')?.setAttribute('aria-valuenow', '0');

    if (lyricPlayer) {
        try { lyricPlayer.pause(); } catch (e) {}
    }
    if (typeof renderLyric === 'function') {
        renderLyric([], '暂无播放');
    }
    currentRawLrc = '';
    currentRawTlrc = '';
    currentRawRlrc = '';
    currentRawKlrc = '';

    try {
        localStorage.removeItem('lx_playback_state');
    } catch (e) {}

    renderQueue();
    updateQueueBadge();
}
(window as any).resetPlayer = resetPlayer;

// 获取来源类型的中文描述
// --- Server Cache Helpers ---
async function checkServerCache(song, quality, exactQuality = false, timeoutMs = 2500, externalSignal?: AbortSignal) {
    const controller = new AbortController();
    const boundedTimeoutMs = Math.max(100, Math.min(Number(timeoutMs) || 2500, 2500));
    const timeoutId = setTimeout(() => controller.abort(), boundedTimeoutMs);
    const abortFromCaller = () => controller.abort();
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
        const username = currentListData?.username || '';
        const params = new URLSearchParams({
            name: song.name,
            singer: song.singer,
            source: song.source,
            songmid: song.songmid || (song.meta && (song.meta.songmid || song.meta.songId)) || '',
            songId: song.songId || (song.meta && song.meta.songId) || '',
            id: song.id || '',
            quality: quality || ''
        });
        if (exactQuality) params.append('exactQuality', '1');
        const headers = {};
        Object.assign(headers, getUserAuthHeaders());

        const res = await fetch(`/api/music/cache/check?${params}`, { headers, signal: controller.signal });
        if (res.ok) {
            const data = await res.json();
            return data; // 返回完整数据对象，包含 exists, isCollision, url 等
        }
        // 401/403 means cache playback is unavailable for this session, not
        // that the cache service is broken. Other failures are kept distinct
        // so the caller can avoid silently falling through to paid playback.
        if (res.status === 401 || res.status === 403) {
            return { exists: false, authRequired: true };
        }
        return { exists: false, unavailable: true, status: res.status };
    } catch (e) {
        if (e?.name !== 'AbortError') console.error('[ServerCache] Check failed:', e);
        return { exists: false, unavailable: true };
    } finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', abortFromCaller);
    }
}

/**
 * 管理员权限验证通用处理逻辑
 * 如果检测到 403 错误，弹出密码输入框并保存密码后重试
 */
async function handleAdminAuth(message) {
    const pass = await showInput('管理员身份验证', message, {
        placeholder: '请输入后台管理密码',
        inputType: 'password'
    });
    if (pass) {
        try {
            const response = await fetch('/api/admin/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ password: pass }),
            });

            if (response.ok) {
                adminSessionActive = true;
                updateAdminUI(); // 更新 UI 状态
                return true;
            } else {
                const result = await response.json();
                showError(result.error || '密码验证失败');
                return false;
            }
        } catch (err) {
            console.error('Admin verification error:', err);
            showError('服务器验证出错，请稍后重试');
            return false;
        }
    }
    return false;
}
window.handleAdminAuth = handleAdminAuth;

/**
 * 如果当前正在操作 _open 公开用户数据，且未登录管理员，则弹出登录设置并返回 false。
 * 已登录管理员返回 true，允许继续操作。
 */
async function requireAdminForOpenWrite(action) {
    const isOpen = currentListData?.username === '_open' || window.isViewingPublicFavorites;
    if (!isOpen) return true; // 不是 _open 数据，无需验证
    if (adminSessionActive) return true; // 已登录管理员
    // 弹出管理员登录弹窗
    const authorized = await handleAdminAuth(`该操作需要管理员权限：${action || '修改公开内容'}`);
    return authorized;
}
window.requireAdminForOpenWrite = requireAdminForOpenWrite;

// 管理员登录处理
async function handleAdminLogin() {
    const authorized = await handleAdminAuth('请输入管理员密码进行登录验证');
    if (authorized) {
        showSuccess('管理员已登录');
        updateAdminUI();
        syncSettingsUI();
        if (typeof renderCustomSources === 'function') renderCustomSources();

        // 未登录用户账号时：管理员应载入 _open 公开列表并对其操作
        if (!isUserLoggedIn()) {
            const loaded = await fetchPublicListData();
            if (loaded) {
                await loadLibraryData();
            }
        }
        if (typeof window.LocalMusicManager?.fetchData === 'function') {
            window.LocalMusicManager.fetchData(true);
        }
        // 已登录用户账号时：不改变当前展示列表，管理员密码仅用于操作授权
    }
}
window.handleAdminLogin = handleAdminLogin;

// 管理员退出登录处理
async function handleAdminLogout() {
    if (!(await showSelect('管理员登出', '确定要退出管理员身份吗？'))) return;
    try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    adminSessionActive = false;
    updateAdminUI();
    syncSettingsUI();

    // [核心新增] 如果当前使用的是 _open 公共列表，登出管理员后锁定列表显示
    if (window.lx_config?.['user.enablePublicFavorites'] && (!userSessionActive || !userName)) {
        const enablePublicNonAdminAccess = !!window.lx_config?.['user.enablePublicNonAdminAccess'];
        if (!enablePublicNonAdminAccess) {
            currentListData = null;
            window.currentListData = null;
            if (typeof renderMyLists === 'function') {
                renderMyLists(null);
            }
        } else {
            fetchPublicListData();
        }
    }
    if (typeof window.LocalMusicManager?.fetchData === 'function') {
        window.LocalMusicManager.fetchData(true);
    }

    showSuccess('管理员已登出');
}
window.handleAdminLogout = handleAdminLogout;

// 更新管理员相关 UI 元素
function updateAdminUI() {
    const isAdmin = adminSessionActive;
    const isPublic = !currentListData?.username || currentListData?.username === 'default';

    // 自定义源部分的标签和按钮
    const adminTag = document.getElementById('settings-admin-tag');
    const loginBtn = document.getElementById('btn-admin-login');
    const logoutBtn = document.getElementById('btn-admin-logout');
    const scopeTag = document.getElementById('settings-source-scope-tag');

    if (adminTag) adminTag.classList.toggle('hidden', !isAdmin);
    if (logoutBtn) logoutBtn.classList.toggle('hidden', !isAdmin);
    if (loginBtn) {
        // 只要未登录管理员，就显示「管理员登录」按钮
        loginBtn.classList.toggle('hidden', isAdmin);
    }
    const manageBtn = document.getElementById('btn-custom-source-manage');
    if (manageBtn) {
        const isPublicRestrictionEnabled = !!window.lx_config?.['user.enablePublicRestriction'];
        const isUser = userSessionActive;
        // 如果开启了公开限制，且既不是管理员也不是登录用户，则隐藏管理入口（或之后显示锁定界面）
        // 这里根据用户要求，只要登录了就不隐藏
        const isRestricted = isPublicRestrictionEnabled && !isAdmin && !isUser;
        manageBtn.classList.toggle('hidden', isRestricted);
    }
    if (scopeTag) {
        scopeTag.classList.toggle('hidden', !isPublic);
    }

}

const serverCacheRequests = new Set<string>();

function normalizeServerCacheUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;

    try {
        const parsed = new URL(value.trim(), window.location.origin);

        // Auto-proxy playback stores a same-origin proxy path in the browser
        // URL cache. Recover its original remote URL before asking the server
        // cache to download it; the server cache endpoint only accepts a
        // public absolute HTTP(S) URL.
        if (parsed.origin === window.location.origin) {
            if (parsed.pathname !== '/api/music/download') return null;
            const nestedUrl = parsed.searchParams.get('url');
            if (!nestedUrl) return null;
            const nested = new URL(nestedUrl);
            if (nested.protocol !== 'http:' && nested.protocol !== 'https:') return null;
            return nested.toString();
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return parsed.toString();
    } catch (_) {
        return null;
    }
}

async function triggerServerCache(song, url, quality) {
    const remoteUrl = normalizeServerCacheUrl(url);
    if (!remoteUrl) return false;

    const cleanedSong = cleanSongData(song);
    const requestKey = `${cleanedSong?.id || song?.id || song?.songmid || song?.songId || ''}_${quality || 'unknown'}`;
    if (!requestKey || serverCacheRequests.has(requestKey)) return false;
    serverCacheRequests.add(requestKey);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30 * 1000);
    try {
        console.log('[ServerCache] Triggering background download for:', song.name);
        const username = currentListData?.username || '';
        const headers = { 'Content-Type': 'application/json' };
        Object.assign(headers, getUserAuthHeaders());


        const coverUrl = typeof getImgUrl === 'function' ? getImgUrl(song) : (song.img || song.meta?.picUrl || '');
        const songInfoForCache = {
            ...song,
            img: song.img || coverUrl,
            meta: {
                ...(song.meta || {}),
                picUrl: song.meta?.picUrl || coverUrl
            }
        };

        const response = await fetch('/api/music/cache/download', {
            method: 'POST',
            headers: headers,
            signal: controller.signal,
            body: JSON.stringify({ 
                songInfo: songInfoForCache,
                url: remoteUrl,
                quality,
                background: true,
                namingPattern: window.settings?.serverCacheNamingPattern || 'simple',
                embedLyric: !!(window.settings?.embedLyricToFile ?? true)
            })
        });
        if (!response.ok) {
            console.warn(`[ServerCache] Trigger rejected with HTTP ${response.status}`);
            return false;
        }
        // 移除 403 自动重试逻辑，API 不再报 403
        return true;
    } catch (e) {
        console.error('[ServerCache] Trigger failed:', e);
        return false;
    }
    finally {
        clearTimeout(timeoutId);
        serverCacheRequests.delete(requestKey);
    }
}

let lastNamingPattern = window.settings?.serverCacheNamingPattern || 'simple';

async function updateServerCacheConfig(location, pattern) {
    const loc = location || window.settings?.serverCacheLocation || 'root';
    const pat = pattern || window.settings?.serverCacheNamingPattern || 'simple';
    const oldPattern = lastNamingPattern;

    const headers = { 'Content-Type': 'application/json' };
    // 会话凭据由同源 HttpOnly Cookie 自动携带
    Object.assign(headers, getUserAuthHeaders());

    try {
        const response = await fetch('/api/music/cache/config', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                location: loc,
                namingPattern: pat
            })
        });
        if (!response.ok) {
            console.warn('[ServerCache] Config update failed:', response.status);
            // 失败时回滚 UI
            if (typeof syncSettingsUI === 'function') {
                if (location) syncSettingsUI('serverCacheLocation', settings.serverCacheLocation);
                if (pattern) syncSettingsUI('serverCacheNamingPattern', settings.serverCacheNamingPattern);
            }
        } else {
            console.log('[Cache] 服务器配置已同步:', loc, pat);

            // 如果命名模式真的发生了变化（且不是初始化同步）
            if (pattern && oldPattern && pattern !== oldPattern) {
                const confirmed = await showSelect('歌曲命名格式变更', `检测到命名方式已更改为 "${pat}"。是否将服务器上已下载的本地歌曲重新命名为新的格式？<br><br><span class="text-xs opacity-70">注：这会同时移动对应的歌词文件，确保播放器能正常识别。</span>`, {
                    confirmText: '现在重命名',
                    cancelText: '保持现状',
                    confirmColor: 'bg-emerald-500'
                });

                if (confirmed) {
                    showLoading('正在重命名服务器文件...');
                    try {
                        const renameRes = await fetch('/api/music/cache/rename', {
                            method: 'POST',
                            headers: headers
                        });
                        const renameData = await renameRes.json();
                        hideLoading();
                        if (renameData.success) {
                            showToast('success', `重命名完成！成功: ${renameData.successCount}, 跳过: ${renameData.skipCount}, 失败: ${renameData.failCount}`);
                            // 刷新可能的列表显示
                            if (typeof refreshCacheList === 'function') refreshCacheList();
                        } else {
                            showToast('error', '重命名操作失败: ' + (renameData.message || '未知错误'));
                        }
                    } catch (e) {
                        hideLoading();
                        showToast('error', '重命名请求异常');
                        console.error(e);
                    }
                }
            }
            lastNamingPattern = pat; // 更新最后同步的模式
        }
    } catch (e) {
        console.error('[ServerCache] Config update failed:', e);
    }
}
window.updateServerCacheConfig = updateServerCacheConfig; // Expose global

/**
 * playFromView handles user click on a song in the search/list view.
 * It ensures the playback queue is updated to match the viewed list.
 */
// Playback orchestration moved to features/playback.ts
// Audio Events
audio.addEventListener('timeupdate', () => {
    if (isDragging === 'progress') return; // Skip updating UI while user is dragging

    const current = audio.currentTime;
    const duration = audio.duration;


    document.getElementById('time-current').innerText = formatTime(current);
    document.getElementById('time-total').innerText = formatTime(duration);

    const pct = (current / duration) * 100;
    document.getElementById('progress-bar').style.width = `${pct}%`;
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) {
        progressContainer.setAttribute('aria-valuemax', String(Number.isFinite(duration) ? Math.round(duration) : 0));
        progressContainer.setAttribute('aria-valuenow', String(Number.isFinite(current) ? Math.round(current) : 0));
    }

    // [iOS Fix] Throttled Media Session Position update for Dynamic Island / Lock Screen
    // 每秒同步一次进度，防止 iOS 将 Web Audio 桥接流识别为不可拖拽的“直播”
    const now = Date.now();
    if ('mediaSession' in navigator && (!window._lastMedPosUpdate || now - window._lastMedPosUpdate > 1000)) {
        updatePositionState();
        window._lastMedPosUpdate = now;
    }

    // 自动恢复：保存播放进度 (节流)
    if (settings.autoResume && (!window._lastStateSave || now - window._lastStateSave > 5000)) {
        savePlaybackState();
        window._lastStateSave = now;
    }
});

// Screen Wake Lock (NoSleep.js) Wrapper
let noSleepInstance = null;
function toggleNoSleep(enable) {
    if (typeof NoSleep === 'undefined') return;
    if (!noSleepInstance) {
        noSleepInstance = new NoSleep();
    }
    if (enable && settings.keepScreenAwake) {
        if (!noSleepInstance.isEnabled) {
            noSleepInstance.enable().catch(e => console.warn('[NoSleep] 启用失败:', e));
        }
    } else {
        if (noSleepInstance && noSleepInstance.isEnabled) {
            noSleepInstance.disable();
        }
    }
}

// Update Media Session State on Play/Pause
audio.addEventListener('play', () => {
    toggleNoSleep(true);
    // 确保播放时应用设置的倍速
    audio.playbackRate = currentPlaybackRate;

    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
        updatePositionState(); // 恢复调用，防止播放瞬间系统推断的外插值错误飞越到最后
    }

    // [Fix] 这里的状态更新确保 UI 与实际播放状态同步 (e.g. 键盘媒体键控制)
    setPlayerStatus('', true); // 使用智能状态显示
    updatePlayButton(true);

    // [Notice] 我们不再在这里调用 lyricPlayer.play，而是等待 'playing' 事件
    // 这样可以避免在网络缓冲时歌词就开始跑
    if (lyricPlayer) {
        isUserScrolling = false; // 切回自动滚动模式

        // 隐藏滚动指示器
        const indicator = document.getElementById('lyric-scroll-indicator');
        if (indicator) {
            indicator.classList.add('hidden');
            indicator.style.display = 'none';
        }
    }
});

audio.addEventListener('playing', () => {
    // [Fix] 'playing' 事件表示音频真正开始震动输出，此时同步最准确
    setPlayerStatus('', true); // 恢复正常播放状态
    if ('mediaSession' in navigator) {
        updatePositionState(); // 立即同步

        // [iOS Stability Fix] 针对 iOS 刷新后失效的问题，在 500ms 和 1200ms 再次强制刷新
        // 确保系统在处理完 Web Audio 桥接流后，能再次接收到正确、有时长的 PositionState
        setTimeout(updatePositionState, 500);
        setTimeout(updatePositionState, 1200);
    }
    if (lyricPlayer) {
        lyricPlayer.play(audio.currentTime * 1000);
        isUserScrolling = false;
        scrollToActiveLine(true); // 强制对齐
    }
});

audio.addEventListener('pause', () => {
    toggleNoSleep(false);
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
    }

    // [Fix] 这里的状态更新确保 UI 与实际播放状态同步
    setPlayerStatus('', false); // 使用智能状态显示
    updatePlayButton(false);

    if (lyricPlayer) {
        lyricPlayer.pause();
    }
    if (wordAnimationId) cancelAnimationFrame(wordAnimationId); // 立即停止行动画
    if (settings.autoResume) savePlaybackState();
});

// ========================================
// Auto-Resume State Logic
// ========================================

function savePlaybackState() {
    if (!currentPlayingSong) return;
    try {
        const state = {
            song: currentPlayingSong,
            index: currentIndex,
            time: audio.currentTime,
            scope: currentPlayingScope,
            listId: window.currentViewingListId,
            // [Fix] 保存整个当前播放队列副本。
            // 限制长度为 300 首以兼顾性能和容量（通常足够临时列表使用）
            playlist: currentPlaylist ? currentPlaylist.slice(0, 300) : null,
            playMode: playMode,
            quality: currentQuality,
            timestamp: Date.now()
        };
        localStorage.setItem('lx_playback_state', JSON.stringify(state));
    } catch (e) {
        console.error('[Resume] 无法保存播放状态:', e);
    }
}

async function restorePlaybackState() {
    if (!settings.autoResume) {
        return;
    }

    try {
        const saved = localStorage.getItem('lx_playback_state');
        if (!saved) {
            return;
        }

        const state = JSON.parse(saved);
        if (!state || !state.song) {
            return;
        }

        console.log('[Resume] 正在恢复上次内容:', state.song.name, '队列长度:', state.playlist ? state.playlist.length : 0);

        // 1. 恢复播放模式
        if (state.playMode) {
            playMode = state.playMode;
            updatePlayModeUI();
        }

        // 2. 恢复播放列表 (优先从持久化队列恢复)
        if (state.playlist && state.playlist.length > 0) {
            currentPlaylist = state.playlist;
            currentPlayingScope = state.scope || 'network';
        } else if (['local_list', 'local_all', 'songlist'].includes(state.scope)) {
            // 回退逻辑：如果队列没存，根据作用域恢复
            currentPlayingScope = state.scope;
        }

        currentIndex = state.index >= 0 ? state.index : 0;
        currentPlayingSong = state.song;
        window.currentPlayingSong = state.song;
        currentQuality = state.quality || null;

        // 3. 更新 UI (静默更新)
        updatePlayerInfo(state.song, currentQuality);
        updateMediaSessionMetadata(state.song);
        renderQueue(); // 提前渲染队列 UI
        updateQueueBadge();

        // 4. 设置恢复时间点
        const resumeTime = state.time || 0;
        window._resumeInfo = {
            time: resumeTime,
            song: state.song
        };

        // 5. 延迟加载播放源（静默模式）但不强制切换 Tab 破坏默认入口设置
        setTimeout(() => {
            // 恢复时只复用服务端缓存或重新解析在线地址，不直接拿本地保存的远程链接。
            // 这类签名 URL 可能已经过期；使用专用 restore 模式会跳过浏览器链接缓存，
            // 但仍允许命中服务端缓存，避免用户第一次点击播放时才触发换源。
            playSong(state.song, currentIndex, null, true, 'restore');
        }, 800);

    } catch (e) {
        console.error('[Resume] 恢复播放状态失败:', e);
    }
}

// 辅助函数：根据 ID 查找列表内容
function findListById(data, id) {
    if (!data) return null;
    if (id === 'default') return data.defaultList;
    if (id === 'love') return data.loveList;
    const ul = data.userList.find(l => l.id === id);
    return ul ? ul.list : null;
}

// 辅助函数：获取所有歌曲（我的收藏）
function getAllSongs(data) {
    if (!data) return [];
    let all = [...data.defaultList, ...data.loveList];
    data.userList.forEach(l => {
        all = all.concat(l.list);
    });
    // 去重
    const seen = new Set();
    return all.filter(s => {
        const sid = s.id || s.songmid;
        if (seen.has(sid)) return false;
        seen.add(sid);
        return true;
    });
}

function updatePositionState() {
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
        const duration = audio.duration;
        const currentTime = audio.currentTime;
        // 确保当 duration 有效，避免传入 NaN/Infinity
        if (Number.isFinite(duration) && duration > 0) {
            try {
                const pos = Math.max(0, Math.min(currentTime, duration));
                // 显式同步播放状态，解决 iOS UI 有时出现的按钮与实际状态不同步的问题
                if (audio.paused) {
                    navigator.mediaSession.playbackState = 'paused';
                } else {
                    navigator.mediaSession.playbackState = 'playing';
                }

                navigator.mediaSession.setPositionState({
                    duration: duration,
                    playbackRate: audio.playbackRate || 1,
                    position: pos
                });
            } catch (e) {
                console.warn('[MediaSession] Failed to update position state:', e);
            }
        }
    }
}
window.updatePositionState = updatePositionState; // 暴露给保活模块调用

// 歌曲播放结束时根据播放模式处理
audio.addEventListener('ended', () => {
    if (playMode === 'single') {
        audio.currentTime = 0;
        audio.play().then(() => {
            updatePlayButton(true);
            if (lyricPlayer) {
                lyricPlayer.play(0);
                scrollToActiveLine(true);
            }
        }).catch((err) => {
            console.warn('[Player] 单曲循环快速重播失败，降级重新加载:', err);
            playNext(0, false);
        });
        return;
    }
    playNext(0, false);
});

audio.addEventListener('canplay', () => {
    if ('mediaSession' in navigator) {
        updatePositionState();
    }
});

// Additional events to sync progress
audio.addEventListener('loadedmetadata', updatePositionState);
audio.addEventListener('ratechange', updatePositionState);
audio.addEventListener('seeking', updatePositionState);
audio.addEventListener('seeked', () => {
    updatePositionState();
    setTimeout(updatePositionState, 200); // 针对跳转后的 iOS 二次确认
    if (lyricPlayer) {
        if (!audio.paused) {
            lyricPlayer.play(audio.currentTime * 1000);
        } else {
            // 如果处于暂停状态，只同步位置不启动计时器
            lyricPlayer.pause();
            const time = audio.currentTime * 1000;
            // 找到当前行并高亮
            const lineNum = findCurrentLyricLine(time);
            if (lineNum !== undefined && lineNum >= 0) {
                syncLyricByLineNum(lineNum);
            }
        }
    }
});
audio.addEventListener('waiting', () => {
    setPlayerStatus('缓冲歌曲中', null, true);
    if (lyricPlayer) {
        lyricPlayer.pause();
    }
});

audio.addEventListener('stalled', () => {
    setPlayerStatus('缓冲歌曲中', null, true);
});

// Initialize Media Session Actions
if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => {
        togglePlay();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        togglePlay();
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
        playPrev();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        playNext();
    });

    // Support seeking (Bidirectional Progress Control)
    navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) {
            audio.currentTime = details.seekTime;
            updatePositionState();
        }
    });

    /* 
    // 注释掉以下两个 Handler 以确保 iOS 优先显示“上一曲/下一曲”按钮
    // 进度条的拖动由上面的 'seekto' 处理，不依赖这两个按钮
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const skipTime = details.seekOffset || 10;
        audio.currentTime = Math.max(audio.currentTime - skipTime, 0);
        updatePositionState();
    });
 
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const skipTime = details.seekOffset || 10;
        audio.currentTime = Math.min(audio.currentTime + skipTime, audio.duration);
        updatePositionState();
    });
    */
}

function updateMediaSessionMetadata(song) {
    if (!('mediaSession' in navigator)) return;

    const imgUrl = getImgUrl(song);
    // Ensure absolute URL if possible
    const fullImgUrl = new URL(imgUrl, window.location.href).href;

    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.name,
            artist: song.singer,
            album: song.albumName || '',
            artwork: [
                { src: fullImgUrl, sizes: '96x96', type: 'image/jpeg' },
                { src: fullImgUrl, sizes: '128x128', type: 'image/jpeg' },
                { src: fullImgUrl, sizes: '192x192', type: 'image/jpeg' },
                { src: fullImgUrl, sizes: '256x256', type: 'image/jpeg' },
                { src: fullImgUrl, sizes: '384x384', type: 'image/jpeg' },
                { src: fullImgUrl, sizes: '512x512', type: 'image/jpeg' }
            ]
        });
        // Reset playback state logic is handled by event listeners, but metadata update often implies new song start
        // updatePositionState() will be called when loadedmetadata fires for new source
    } catch (e) {
        console.warn('[MediaSession] Failed to update metadata:', e);
    }
}


function seek(e) {
    // Prevent seek if audio is not ready or has infinite duration (live stream)
    if (!audio.duration || !Number.isFinite(audio.duration)) return;

    const container = document.getElementById('progress-container');
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width)); // Clamp between 0 and 1
    const time = pct * audio.duration;

    // Ensure time is valid
    if (Number.isFinite(time)) {
        audio.currentTime = time;
    }
}

function handleProgressKeydown(event: KeyboardEvent) {
    if (!audio.duration || !Number.isFinite(audio.duration)) return;
    const step = audio.duration * 0.05;
    let nextTime = audio.currentTime;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextTime -= step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextTime += step;
    else if (event.key === 'Home') nextTime = 0;
    else if (event.key === 'End') nextTime = audio.duration;
    else return;

    event.preventDefault();
    audio.currentTime = Math.max(0, Math.min(audio.duration, nextTime));
}
window.handleProgressKeydown = handleProgressKeydown;

// ========== 音量控制 ==========
let currentVolume = 0.75; // 默认音量 75%
let isMuted = false;

// 初始化音量
audio.volume = currentVolume;
updateVolumeUI();

// 设置音量
function setVolume(e) {
    const container = document.getElementById('volume-container');
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width)); // 限制在 0-1 之间

    currentVolume = pct;
    audio.volume = currentVolume;
    isMuted = false;

    updateVolumeUI();

    // 保存到本地存储
    try {
        localStorage.setItem('lx_volume', currentVolume.toString());
    } catch (e) {
        console.error('[Volume] 保存音量失败:', e);
    }
}

function handleVolumeKeydown(event: KeyboardEvent) {
    let nextVolume = currentVolume;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextVolume -= 0.05;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextVolume += 0.05;
    else if (event.key === 'Home') nextVolume = 0;
    else if (event.key === 'End') nextVolume = 1;
    else return;

    event.preventDefault();
    currentVolume = Math.max(0, Math.min(1, nextVolume));
    audio.volume = currentVolume;
    isMuted = false;
    updateVolumeUI();
    try {
        localStorage.setItem('lx_volume', currentVolume.toString());
    } catch (error) {
        console.warn('[Volume] 保存音量失败:', error);
    }
}
window.handleVolumeKeydown = handleVolumeKeydown;

// 切换静音
function toggleMute() {
    isMuted = !isMuted;
    audio.muted = isMuted;
    updateVolumeUI();
}

// 更新音量 UI
function updateVolumeUI() {
    const volumeBar = document.getElementById('volume-bar');
    const volumeIcon = document.getElementById('volume-icon');

    if (volumeBar) {
        const displayVolume = isMuted ? 0 : currentVolume;
        volumeBar.style.width = `${displayVolume * 100}%`;
        document.getElementById('volume-container')?.setAttribute('aria-valuenow', String(Math.round(displayVolume * 100)));
    }

    if (volumeIcon) {
        if (isMuted || currentVolume === 0) {
            volumeIcon.className = 'fas fa-volume-mute w-4';
        } else if (currentVolume < 0.5) {
            volumeIcon.className = 'fas fa-volume-down w-4';
        } else {
            volumeIcon.className = 'fas fa-volume-up w-4';
        }
    }
}

// ========== 播放模式 ==========
let playMode = 'list'; // 'list': 列表循环, 'single': 单曲循环, 'random': 随机播放, 'order': 顺序播放

// 设置播放模式
function setPlayMode(mode) {
    playMode = mode;
    // [Random Prefetch Fix] 切换模式时清空预读预选索引
    preSelectedNextIndex = null;
    updatePlayModeUI();

    // 保存到本地存储
    try {
        localStorage.setItem('lx_play_mode', mode);
    } catch (e) {
        console.error('[PlayMode] 保存播放模式失败:', e);
    }

    // Close menu (Mobile/Click mode)
    const menu = document.getElementById('play-mode-menu');
    if (menu) menu.classList.remove('force-visible');
    document.getElementById('play-mode-btn')?.setAttribute('aria-expanded', 'false');

    // 使用统一的 Toast 系统显示提示
    showSuccess(`播放模式：${getPlayModeName(mode)}`);
}

// 切换播放模式菜单（适配移动端点击）
function togglePlayModeMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('play-mode-menu');
    if (menu) {
        const isOpening = !menu.classList.contains('force-visible');
        menu.classList.toggle('force-visible', isOpening);
        document.getElementById('play-mode-btn')?.setAttribute('aria-expanded', String(isOpening));
    }
}

// 切换播放倍速菜单（适配移动端点击）
function togglePlaybackRateMenu(e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('playback-rate-menu');
    if (menu) {
        const isOpening = !menu.classList.contains('force-visible');
        menu.classList.toggle('force-visible', isOpening);
        document.getElementById('playback-rate-btn')?.setAttribute('aria-expanded', String(isOpening));
    }
}

// 设置播放倍速
function setPlaybackRate(rate) {
    currentPlaybackRate = parseFloat(rate);
    audio.playbackRate = currentPlaybackRate;
    if (lyricPlayer) {
        lyricPlayer.setPlaybackRate(currentPlaybackRate);
        // 强制同步当前音频时间，确保位置严格匹配
        lyricPlayer.play(audio.currentTime * 1000);
        isUserScrolling = false; // 重置手动滚动模式，进入自动跟随
        scrollToActiveLine(true); // 立即对齐并滚动到当前行
    }
    updatePlaybackRateUI();

    // 关闭菜单
    const menu = document.getElementById('playback-rate-menu');
    if (menu) menu.classList.remove('force-visible');
    document.getElementById('playback-rate-btn')?.setAttribute('aria-expanded', 'false');

    // 增加提示
    showInfo(`播放速度：${rate}x`);
}

// 更新播放倍速 UI
function updatePlaybackRateUI() {
    const btn = document.getElementById('playback-rate-btn');
    if (btn) {
        btn.innerText = currentPlaybackRate === 1.0 ? '1.0x' : `${currentPlaybackRate}x`;
        btn.classList.toggle('text-emerald-500', currentPlaybackRate !== 1.0);
        btn.setAttribute('aria-label', `播放速度：${currentPlaybackRate} 倍`);
    }

    const options = document.querySelectorAll('.playback-rate-option');
    options.forEach(opt => {
        const rate = parseFloat(opt.dataset.rate);
        const selected = rate === currentPlaybackRate;
        opt.setAttribute('aria-pressed', String(selected));
        opt.classList.remove('active-option', 'font-bold');
    });
}

// 监听全局点击，关闭菜单
document.addEventListener('click', (e) => {
    // 关闭播放模式菜单
    const pmMenu = document.getElementById('play-mode-menu');
    const pmBtn = document.getElementById('play-mode-btn');
    if (pmMenu && pmBtn && !pmMenu.contains(e.target) && !pmBtn.contains(e.target)) {
        pmMenu.classList.remove('force-visible');
        pmBtn.setAttribute('aria-expanded', 'false');
    }

    // 关闭倍速菜单
    const prMenu = document.getElementById('playback-rate-menu');
    const prBtn = document.getElementById('playback-rate-btn');
    if (prMenu && prBtn && !prMenu.contains(e.target) && !prBtn.contains(e.target)) {
        prMenu.classList.remove('force-visible');
        prBtn.setAttribute('aria-expanded', 'false');
    }
});

// 更新播放模式 UI
function updatePlayModeUI() {
    const btn = document.getElementById('play-mode-btn');
    const options = document.querySelectorAll('.play-mode-option');

    // 更新按钮图标和颜色
    if (btn) {
        const icons = {
            'list': 'fa-redo',
            'single': 'fa-redo-alt',
            'random': 'fa-random',
            'order': 'fa-play'
        };
        const colors = {
            'list': 'text-emerald-500',
            'single': 'text-blue-500',
            'random': 'text-purple-500',
            'order': 'text-gray-500'
        };

        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = `fas ${icons[playMode]}`;
            Object.values(colors).forEach(color => btn.classList.remove(color));
            btn.classList.add(colors[playMode]);
            btn.title = getPlayModeName(playMode);
            btn.setAttribute('aria-label', `播放模式：${getPlayModeName(playMode)}`);
        }
    }

    // Keep the selected state semantic without adding a persistent visual fill.
    options.forEach(opt => {
        const selected = opt.dataset.mode === playMode;
        opt.setAttribute('aria-pressed', String(selected));
        opt.classList.remove('active-option', 'font-bold');
    });
}

function getPlayModeName(mode) {
    const names = {
        'list': '列表循环',
        'single': '单曲循环',
        'random': '随机播放',
        'order': '顺序播放'
    };
    return names[mode] || '未知';
}

function formatTime(s) {
    if (!s || isNaN(s)) return '00:00';
    const min = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${min < 10 ? '0' + min : min}:${sec < 10 ? '0' + sec : sec}`;
}


// Load settings from localStorage
function loadSettings() {
    try {
        const saved = localStorage.getItem('lx_settings');
        if (saved) {
            const loaded = JSON.parse(saved);
            settings = normalizeStoredSettings({ ...settings, ...loaded });
            persistSettings();
            console.log('[Settings] 加载设置成功:', settings);
        }
    } catch (e) {
        console.error('[Settings] 加载设置失败:', e);
    }

    // 同步 UI 状态
    syncSettingsUI();
    setupNetworkListAutoCheck();
}

// ========== 键盘快捷键逻辑 ==========
let seekTimer = null;
let isLongPress = false;

function handleSeekKey(direction, action) {
    if (action === 'down') {
        if (seekTimer) return; // 已经在处理中

        // 初始步长跳转 (默认 5% 长度)
        let delta = direction === 'forward' ? 10 : -10;
        if (audio.duration && Number.isFinite(audio.duration)) {
            delta = audio.duration * (direction === 'forward' ? 0.05 : -0.05);
        }

        audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + delta));

        // 设置长按逻辑 (500ms 后进入连续推进模式)
        seekTimer = setTimeout(() => {
            isLongPress = true;
            seekTimer = setInterval(() => {
                const step = direction === 'forward' ? 2 : -2; // 每 100ms 推进 2s = 20s/s
                audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + step));
            }, 100);
        }, 500);
    } else {
        // 松开按键，重置状态
        if (seekTimer) {
            if (isLongPress) clearInterval(seekTimer);
            else clearTimeout(seekTimer);
            seekTimer = null;
            isLongPress = false;
        }
    }
}

function changeVolume(delta) {
    currentVolume = Math.max(0, Math.min(1, currentVolume + delta));
    audio.volume = currentVolume;
    isMuted = false;
    updateVolumeUI();
    try {
        localStorage.setItem('lx_volume', currentVolume.toString());
    } catch (e) { }
}

// 注册全局键盘监听
initShortcutsFeature({
    getSettings: () => settings,
    togglePlay: () => togglePlay(),
    changeVolume: (delta) => changeVolume(delta),
    handleSeekKey: (dir, st) => handleSeekKey(dir, st),
    playPrev: () => playPrev(),
    playNext: () => playNext(),
    toggleLyrics: () => toggleLyrics(),
    switchTab: (tabId) => switchTab(tabId),
    updateSetting: (key, val) => updateSetting(key, val),
    toggleCacheDrawer: () => {
        if (typeof toggleCacheDrawer === 'function') toggleCacheDrawer();
    },
    getDownloadManager: () => downloadManager,
});

window.getUserName = () => userName;

async function updateSetting(key, value) {
    if (key in FIXED_PLAYER_SETTINGS) value = true;
    if (SETTINGS_UI_MAP[key]?.normalize) {
        value = SETTINGS_UI_MAP[key].normalize(value);
    }
    const restrictedKeys = ['serverCacheLocation', 'serverCacheNamingPattern', 'downloadConcurrency', 'preferredQuality', 'enablePublicSources'];
    const isPublic = !isUserLoggedIn() || currentListData?.username === '_open' || currentListData?.username === 'default' || window.isViewingPublicFavorites;
    const enablePublicRestriction = window.lx_config?.['user.enablePublicRestriction'];
    const enableLoginCacheRestriction = window.lx_config?.['user.enableLoginCacheRestriction'];
    const isAdmin = adminSessionActive;

    // 权限校验：针对不同用户类型的受限设置项校验 (置灰逻辑由 syncSettingsUI 同步)
    const isRestricted = !isAdmin && (
        (isPublic && enablePublicRestriction) ||
        (!isPublic && enableLoginCacheRestriction)
    );

    if (restrictedKeys.includes(key) && isRestricted) {
        showError('权限不足：公开受限模式下修改该设置项受限，请先验证管理员身份。');
        const authorized = await handleAdminAuth('该设置项受限，请输入管理员密码以修改');
        if (!authorized) {
            syncSettingsUI(key, settings[key]); // 还原 UI
            return;
        }
    }

    if (key === 'networkListAutoCheckInterval') {
        const intervalMs = parseNetworkListAutoCheckInterval(value);
        if (intervalMs === null) {
            showError('无效的自动检测间隔，请使用 30m / 6h / 1d 等格式');
            syncSettingsUI(key, settings[key]);
            return;
        }
    }

    settings[key] = value;
    window.settings = settings; // 确保全局引用同步
    try {
        persistSettings();
        console.log(`[Settings] ${key} 已更新为:`, value);
    } catch (e) {
        console.error('[Settings] 保存设置失败:', e);
    }
    // 实时同步 UI 并应用效果
    syncSettingsUI(key, value);
    if (key === 'networkListAutoCheckInterval' || key === 'autoUpdateNetworkList') {
        setupNetworkListAutoCheck();
    }

    // [New] Push to server if enabled
    if (settings.saveAccountSettingsToFile) {
        pushSettingsToServer();
    }

    // Special handlers for visual changes
    if (key.includes('Visualizer') || key.startsWith('visualizer')) {
        if (window.musicVisualizer) {
            // 如果正在播放且开启了开关，尝试强制初始化 (防止第一次点击开关没反应)
            if (typeof audio !== 'undefined' && !audio.paused && (settings.showFooterVisualizer || settings.showDetailVisualizer)) {
                window.musicVisualizer.init();
            }
            window.musicVisualizer.applySettings();
        } else {
            // Visualization is an optional, animation-heavy feature. Load it only
            // when the user first changes a visualization setting.
            ensureVisualizerLoaded().then(() => window.musicVisualizer?.applySettings()).catch(() => {
                console.warn('[Visualizer] 可视化模块加载失败');
            });
        }

        // 更新透明度数值显示
        if (key === 'visualizerOpacity') {
            const el = document.getElementById('visualizer-opacity-value');
            if (el) el.innerText = value;
        }
    }

    if (key === 'playerBackground') {
        applyPlayerBackground(value);
    }

    if (key === 'enablePublicSources') {
        if (typeof updateSourceScopeUI === 'function') updateSourceScopeUI();
        if (typeof renderCustomSources === 'function') renderCustomSources();
    }
}
//缓存设置
// 核心设置项映射表: [key]: { id: 'element-id', type: 'checkbox|value|custom', action: (val) => { ... } }
const SETTINGS_UI_MAP = {
    // 逻辑 (Logic)
    defaultEntry: { id: 'setting-default-entry', type: 'value' },
    defaultDownloadTarget: { id: 'setting-default-download-target', type: 'value' },
    defaultDownloadQuality: {
        id: 'setting-default-download-quality',
        type: 'value',
        action: (v, isSingle) => {
            if (isSingle && window.showSuccess && window.QualityManager) {
                window.showSuccess(`默认下载音质已设置为: ${window.QualityManager.getQualityDisplayName(v)}`);
            }
        }
    },
    switchPlaylistOnSearchPlay: { id: 'setting-switch-playlist-search', type: 'checkbox' },
    switchPlaylistOnSongListPlay: { id: 'setting-switch-playlist-songlist', type: 'checkbox' },
    autoResume: { id: 'setting-auto-resume', type: 'checkbox' },
    autoCompactPlaybar: { id: 'setting-auto-compact-playbar', type: 'checkbox' },
    enableAutoSwitchSource: { id: 'setting-auto-switch-source', type: 'checkbox' },
    enableAutoSwitchApiSource: { id: 'setting-auto-switch-api-source', type: 'checkbox' },
    enableAutoSkipOnError: { id: 'setting-auto-skip-on-error', type: 'checkbox' },
    enableAutoDegradeQuality: { id: 'setting-auto-degrade-quality', type: 'checkbox' },
    playbackErrorPriority: { id: 'setting-playback-error-priority', type: 'value' },
    enablePreloader: { id: 'setting-enable-preloader', type: 'checkbox' },
    deduplicatePlaylistByQuality: { id: 'setting-deduplicate-playlist', type: 'checkbox' },
    enableSmtcLyric: {
        id: 'setting-enable-smtc-lyric',
        type: 'checkbox',
        action: (v) => {
            // 关闭时立即恢复 MediaSession title / artist 为歌曲名 / 歌手名
            if (!v && 'mediaSession' in navigator && navigator.mediaSession.metadata && currentPlayingSong) {
                try {
                    navigator.mediaSession.metadata.title = currentPlayingSong.name;
                    navigator.mediaSession.metadata.artist = currentPlayingSong.singer;
                } catch (e) { /* ignore */ }
            }
        }
    },
    downloadConcurrency: {
        id: 'setting-download-concurrency',
        type: 'value',
        normalize: normalizeDownloadConcurrency,
        action: (v) => {
            downloadManager.updateMaxConcurrent(v);
        }
    },
    enableKeyboardShortcuts: { id: 'setting-enable-shortcuts', type: 'checkbox' },
    enableCrossfade: { id: 'setting-enable-crossfade', type: 'checkbox' },
    keepScreenAwake: {
        id: 'setting-keep-screen-awake',
        type: 'checkbox',
        action: (v) => toggleNoSleep(v && !audio.paused)
    },
    // 显示 (Display)
    showSidebarSongInfo: {
        id: 'setting-show-sidebar-info',
        type: 'checkbox',
        action: (v) => {
            const sidebarInfo = document.querySelector('.sidebar-song-info-wrapper');
            if (sidebarInfo) v ? sidebarInfo.classList.add('md:block') : sidebarInfo.classList.remove('md:block');
        }
    },
    showLyricTranslation: {
        id: 'setting-show-lyric-translation',
        type: 'checkbox',
        action: () => (lyricPlayer && currentRawLrc) && applyLyricUpdate()
    },
    showLyricRoma: {
        id: 'setting-show-lyric-roma',
        type: 'checkbox',
        action: () => (lyricPlayer && currentRawLrc) && applyLyricUpdate()
    },
    swapLyricTransRoma: {
        id: 'setting-swap-lyric-trans-roma',
        type: 'checkbox',
        action: () => (lyricPlayer && currentRawLrc) && applyLyricUpdate()
    },
    enableLyricGlow: {
        id: 'setting-enable-lyric-glow',
        type: 'checkbox',
        action: (v) => {
            // 同时更新歌词详情容器和歌词内容容器，实现实时生效
            const dv = document.getElementById('view-player-detail');
            if (dv) v ? dv.classList.add('enable-lyric-glow') : dv.classList.remove('enable-lyric-glow');
            const lc = document.getElementById('lyric-content');
            if (lc) v ? lc.classList.add('enable-lyric-glow') : lc.classList.remove('enable-lyric-glow');
        }
    },
    playerBackground: {
        id: 'setting-player-background',
        type: 'value',
        action: (v) => applyPlayerBackground(v)
    },
    lyricFontSize: {
        id: 'lyric-font-size-slider',
        type: 'value',
        action: (v) => {
            const valEl = document.getElementById('lyric-font-size-value');
            if (valEl) valEl.innerText = v;
            document.documentElement.style.setProperty('--lyric-font-size', `${v}rem`);
        }
    },
    lyricFontFamily: {
        id: 'lyric-font-family-select',
        type: 'value',
        action: (v) => document.documentElement.style.setProperty('--lyric-font-family', v || 'inherit')
    },

    // 视觉效果 (Visualizer)
    showFooterVisualizer: { id: 'setting-show-footer-visualizer', type: 'checkbox' },
    footerVisualizerStyle: { id: 'setting-footer-visualizer-style', type: 'value' },
    showDetailVisualizer: { id: 'setting-show-detail-visualizer', type: 'checkbox' },
    detailVisualizerStyle: { id: 'setting-detail-visualizer-style', type: 'value' },
    visualizerGlobalStyle: { id: 'setting-visualizer-global-style', type: 'value' },
    visualizerOpacity: {
        id: 'setting-visualizer-opacity',
        type: 'value',
        action: (v) => {
            const valEl = document.getElementById('visualizer-opacity-value');
            if (valEl) valEl.innerText = v;
        }
    },

    // 系统 & 网络 (System & Network)
    autoUpdateNetworkList: { id: 'setting-auto-update-list', type: 'checkbox' },
    networkListAutoCheckInterval: { id: 'setting-network-list-auto-check-interval', type: 'value' },
    saveAccountSettingsToFile: { id: 'setting-save-settings-to-file', type: 'checkbox' },
    serverCacheLocation: { id: 'setting-server-cache-location', type: 'value' },
    serverCacheNamingPattern: {
        id: 'setting-server-cache-naming',
        type: 'value',
        normalize: value => value === 'standard' ? 'standard' : 'simple'
    },
    enableProxyDownload: { id: 'toggle-proxy-download', type: 'checkbox' },
    enableAutoProxy: { id: 'toggle-auto-proxy', type: 'checkbox' },
    enableCustomProxy: {
        id: 'toggle-custom-proxy',
        type: 'checkbox',
        action: (v) => {
            const row = document.getElementById('custom-proxy-url-row');
            if (row) row.classList.toggle('hidden', !v);
        }
    },
    customProxyUrl: { id: 'custom-proxy-url-input', type: 'value' },
    enablePublicSources: { id: 'toggle-public-sources', type: 'checkbox' },
    preferredQuality: {
        id: 'quality-select',
        type: 'value',
        action: (v, isSingle) => {
            if (isSingle && window.showSuccess && window.QualityManager) {
                window.showSuccess(`默认音质已设置为: ${window.QualityManager.getQualityDisplayName(v)}`);
            }
        }
    },
    hotSearchLimit: {
        id: 'hot-search-limit-input',
        type: 'value',
        action: () => document.getElementById('search-results-header')?.classList.contains('hidden') && showInitialSearchState()
    },
    itemsPerPage: { id: 'items-per-page-select', type: 'value' },
};

//缓存设置项
function syncSettingsUI(key = null, value = null) {
    const isPublic = !isUserLoggedIn() || currentListData?.username === '_open' || currentListData?.username === 'default' || window.isViewingPublicFavorites;
    const enablePublicRestriction = window.lx_config?.['user.enablePublicRestriction'];
    const enableLoginCacheRestriction = window.lx_config?.['user.enableLoginCacheRestriction'];
    const isAdmin = adminSessionActive;
    const restrictedKeys = ['serverCacheLocation', 'serverCacheNamingPattern', 'downloadConcurrency', 'preferredQuality', 'enablePublicSources'];

    const updateItem = (itemKey, itemValue, isSingle) => {
        const config = SETTINGS_UI_MAP[itemKey];
        if (!config) return;

        if (config.normalize) itemValue = config.normalize(itemValue);
        if (settings[itemKey] !== itemValue) {
            settings[itemKey] = itemValue;
            window.settings = settings;
        }
        const el = document.getElementById(config.id);
        if (el) {
            if (config.type === 'checkbox') el.checked = !!itemValue;
            else el.value = itemValue;

            // 禁用受限设置项 (针对公开受限或登录用户受限)
            const isRestricted = !isAdmin && (
                (isPublic && enablePublicRestriction) ||
                (!isPublic && enableLoginCacheRestriction)
            );

            if (restrictedKeys.includes(itemKey) && isRestricted) {
                el.disabled = true;
                const container = el.closest('.flex.items-center.justify-between') || el.closest('.setting-item') || el.parentElement;
                if (container) container.classList.add('opacity-40', 'pointer-events-none');
            } else if (restrictedKeys.includes(itemKey)) {
                el.disabled = false;
                const container = el.closest('.flex.items-center.justify-between') || el.closest('.setting-item') || el.parentElement;
                if (container) container.classList.remove('opacity-40', 'pointer-events-none');
            }
        }

        if (config.action) config.action(itemValue, isSingle);
    };

    // [新增] 更新管理员 UI 状态 (标签、按钮)
    if (typeof updateAdminUI === 'function') updateAdminUI();

    if (key !== null && value !== null) {
        // 单项更新
        updateItem(key, value, true);
    } else {
        // 全局同步
        Object.keys(SETTINGS_UI_MAP).forEach(itemKey => {
            const val = settings[itemKey];
            // 处理默认值逻辑 (如果 settings 中没有，则可能需要 fallback 或跳过)
            if (val !== undefined) {
                updateItem(itemKey, val, false);
            }
        });
    }

    // 更新存储统计与缓存大小
    updateStorageStatsUI();
    updateServerCacheSize();
}

/**
 * 应用播放页背景样式
 * @param {string} mode - 'blur', 'solid', 'dark'
 */
function applyPlayerBackground(mode) {
    const detailBg = document.getElementById('view-player-detail');
    const bgCover = document.getElementById('detail-bg-cover');
    const bgOverlay = document.getElementById('player-detail-bg-overlay');
    if (!detailBg || !bgCover || !bgOverlay) return;

    console.log(`[PlayerBackground] Applying style: ${mode}`);

    // 重置默认状态
    bgCover.style.display = 'block';
    bgOverlay.className = 'absolute inset-0 t-bg-panel/30 backdrop-blur-3xl';
    bgOverlay.style.backgroundColor = '';
    bgOverlay.style.backdropFilter = '';
    detailBg.style.backgroundColor = '';

    if (mode === 'solid') {
        bgCover.style.display = 'none';
        bgOverlay.className = 'absolute inset-0 t-bg-panel';
        bgOverlay.style.backdropFilter = 'none';
    } else if (mode === 'dark') {
        bgCover.style.display = 'none';
        bgOverlay.className = 'absolute inset-0';
        bgOverlay.style.backgroundColor = '#000000';
        bgOverlay.style.backdropFilter = 'none';
    }
    // 'blur' 模式由上面的重置逻辑处理
}

window.switchTab = switchTab;
window.handleSearchKeyPress = handleSearchKeyPress;
window.doSearch = doSearch;
window.changePage = changePage;
window.toggleCacheDrawer = toggleCacheDrawer;
window.refreshCacheList = refreshCacheList;
window.toggleCacheBatchMode = toggleCacheBatchMode;
window.exitCacheBatchMode = exitCacheBatchMode;
window.selectAllCache = selectAllCache;
window.deselectAllCache = deselectAllCache;
window.batchDeleteCache = batchDeleteCache;
window.toggleCacheSelection = toggleCacheSelection;
window.removeCacheItem = removeCacheItem;
window.clearServerCache = clearServerCache;
window.handleHotSearchClick = handleHotSearchClick;
window.showInitialSearchState = showInitialSearchState;
window.playSong = playSong;
window.resolveSongUrl = resolveSongUrl;
window.resolveDownloadSongUrl = resolveDownloadSongUrl;
window.togglePlay = togglePlay;
window.playNext = playNext;
window.changeProxyDownload = changeProxyDownload;
window.changeAutoProxy = changeAutoProxy;
window.changeHotSearchLimit = changeHotSearchLimit;
window.resetAllSettings = resetAllSettings;
window.clearCache = clearCache;
window.updateServerCacheSize = updateServerCacheSize;
window.clearServerCache = clearServerCache;
window.playPrev = playPrev;
window.seek = seek;
window.changeLyricFontSize = changeLyricFontSize;
window.loadLocalFonts = loadLocalFonts;
window.changeLyricFontFamily = changeLyricFontFamily;
// 音量控制
window.setVolume = setVolume;
window.toggleMute = toggleMute;
// 播放模式
window.setPlayMode = setPlayMode;
// --- Lyrics & Detail View Logic ---

let currentLyricLines = [];
let isLyricViewOpen = false;
let currentLyricIndex = -1;
let wordAnimationId = null; // 用于逐词歌词动画
let lyricPlayer = null; // LinePlayer instance for parsing and syncing
let isUserScrolling = false; // 用户是否正在手动滚动
let scrollLockTimeout = null; // 滚动锁定计时器
let isProgrammaticScroll = false; // 标记是否为程序自动滚动
const SCROLL_LOCK_DURATION = 5000; // 5秒后解除锁定
const lyricState = {
    get currentLyricLines() { return currentLyricLines; },
    set currentLyricLines(value) { currentLyricLines = value; },
    get isLyricViewOpen() { return isLyricViewOpen; },
    set isLyricViewOpen(value) { isLyricViewOpen = value; },
    get currentLyricIndex() { return currentLyricIndex; },
    set currentLyricIndex(value) { currentLyricIndex = value; },
    get wordAnimationId() { return wordAnimationId; },
    set wordAnimationId(value) { wordAnimationId = value; },
    get lyricPlayer() { return lyricPlayer; },
    set lyricPlayer(value) { lyricPlayer = value; },
    get isUserScrolling() { return isUserScrolling; },
    set isUserScrolling(value) { isUserScrolling = value; },
    get scrollLockTimeout() { return scrollLockTimeout; },
    set scrollLockTimeout(value) { scrollLockTimeout = value; },
    get isProgrammaticScroll() { return isProgrammaticScroll; },
    set isProgrammaticScroll(value) { isProgrammaticScroll = value; },
    get currentRawLrc() { return currentRawLrc; },
    set currentRawLrc(value) { currentRawLrc = value; },
    get currentRawTlrc() { return currentRawTlrc; },
    set currentRawTlrc(value) { currentRawTlrc = value; },
    get currentRawRlrc() { return currentRawRlrc; },
    set currentRawRlrc(value) { currentRawRlrc = value; },
    get currentRawKlrc() { return currentRawKlrc; },
    set currentRawKlrc(value) { currentRawKlrc = value; },
    get lastLyricSongId() { return lastLyricSongId; },
    set lastLyricSongId(value) { lastLyricSongId = value; },
};
const lyricFeature = initLyricFeature({
    state: lyricState,
    getSettings: () => settings,
    getAudio: () => audio as HTMLMediaElement,
    getCurrentPlayingSong: () => currentPlayingSong,
    getCurrentListData: () => currentListData,
    getCurrentQuality: () => currentQuality,
    getCurrentPlaybackRate: () => currentPlaybackRate,
    getUserAuthHeaders,
    getImgUrl,
    setImg,
    handleSearchPopState,
    updateStorageStatsUI,
    escapeHtmlText,
    formatTime,
    startToggleLyricsBtnTimer: () => startToggleLyricsBtnTimer(),
    scrollLockDuration: SCROLL_LOCK_DURATION,
});
const {
    toggleLyrics,
    updateDetailInfo: updateLyricDetailInfo,
    fetchLyric,
    applyLyricUpdate,
    initLyricPlayer,
    getLyricOffset,
    scrollToActiveLine,
    syncLyricByLineNum,
    findCurrentLyricLine,
    startWordProgressUpdate,
    handleLyricScroll,
    updateScrollIndicator,
    renderLyric,
} = lyricFeature;

// syncLyric removed - LinePlayer handles all syncing via syncLyricByLineNum callback
// Audio timeupdate listener removed - LinePlayer automatically syncs lyrics

// Playback feature updates lyric detail metadata through its context adapter.

window.toggleLyrics = toggleLyrics;

// Initial
console.log('App.js loaded successfully');

// Initialize Favorites as hidden (collapsed)
const favList = document.getElementById('favorites-children');
if (favList) {
    favList.style.height = '0px';
    // favList.classList.add('hidden'); // using height transition instead
}

function refreshFavoritesChildrenHeight() {
    const list = document.getElementById('favorites-children');
    if (!list || list.style.height === '0px' || list.style.height === '') return;

    list.style.height = 'auto';
}

function toggleFavorites() {
    const list = document.getElementById('favorites-children');
    const arrow = document.getElementById('favorites-arrow');
    const trigger = document.getElementById('tab-favorites');
    if (!list) return;

    // Toggle logic
    if (list.style.height === '0px' || list.style.height === '') {
        list.style.height = 'auto';
        const targetHeight = list.scrollHeight;
        list.style.height = '0px';
        requestAnimationFrame(() => {
            list.style.height = targetHeight + 'px';
            setTimeout(() => {
                if (list.style.height !== '0px') {
                    list.style.height = 'auto';
                }
            }, 320);
        });
        if (arrow) arrow.style.transform = 'rotate(0deg)'; // Arrow down
        trigger?.setAttribute('aria-expanded', 'true');
    } else {
        const currentH = list.scrollHeight;
        list.style.height = currentH + 'px';
        requestAnimationFrame(() => {
            list.style.height = '0px';
        });
        if (arrow) arrow.style.transform = 'rotate(-90deg)'; // Arrow right
        trigger?.setAttribute('aria-expanded', 'false');
    }
}

// Initial rotate for collapsed state
const favArrow = document.getElementById('favorites-arrow');
if (favArrow) favArrow.style.transform = 'rotate(-90deg)';
document.getElementById('tab-favorites')?.setAttribute('aria-expanded', 'false');

let currentListData = null;
function updateUserStatus(message: string, showLogout = true): void {
    const status = document.getElementById('user-session-status');
    if (!status) return;
    status.innerHTML = message;
    if (showLogout && userSessionActive) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ml-2 text-red-500';
        button.textContent = '退出登录';
        button.addEventListener('click', () => void handleUserLogout(false));
        status.append(' ', button);
    }
}

function syncUserSessionStatus(): void {
    if (userSessionActive && userName) {
        updateUserStatus(`<span class="text-emerald-600">已登录：${escapeHtmlText(userName)}</span>`);
    } else {
        updateUserStatus('未登录', false);
    }
}

async function handleLocalLogin(): Promise<void> {
    const usernameInput = document.getElementById('user-login-name') as HTMLInputElement | null;
    const passwordInput = document.getElementById('user-login-password') as HTMLInputElement | null;
    const username = usernameInput?.value.trim() || '';
    const password = passwordInput?.value || '';
    if (!username || !password) {
        showError('请输入用户名和密码');
        return;
    }
    try {
        const response = await fetch('/api/user/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username, password }),
        });
        if (!response.ok) throw new Error('用户名或密码错误');
        const sessionReady = await ensureUserSession({ force: true });
        if (!sessionReady) throw new Error('会话建立失败，请重试');
        localStorage.setItem('lx_user_name', userName || username);
        if (passwordInput) passwordInput.value = '';
        updateUserUI();
        updateAdminUI();
        syncSettingsUI();
        await reloadUserFavorites();
        syncUserSessionStatus();
        showSuccess('登录成功');
    } catch (error) {
        console.error('[Auth] 用户登录失败:', error);
        showError('用户名或密码错误');
    }
}

async function handleUserLogout(skipConfirm = false): Promise<void> {
    if (!skipConfirm && !(await showSelect('退出账号', '确定要退出当前账号吗？', { danger: true }))) return;
    try {
        await fetch('/api/user/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (error) {
        console.warn('[Auth] 注销请求失败:', error);
    }
    clearLibraryBatchContext();
    resetSharedBatchSelection();
    userName = null;
    userSessionActive = false;
    localStorage.removeItem('lx_user_name');
    currentListData = null;
    window.currentListData = null;
    if (window.ListStore?.remove) await window.ListStore.remove().catch(() => undefined);
    updateUserUI();
    updateAdminUI();
    syncUserSessionStatus();
    renderMyLists(null);
    showSuccess('已退出登录');
}

function reconcileBatchSelectionWithList(list: any[]) {
    if (!(window.selectedItems instanceof Set)) return;

    const validIds = new Set((Array.isArray(list) ? list : [])
        .map(song => String(song?.id ?? '').trim())
        .filter(id => id && id !== 'undefined'));

    for (const selectedId of window.selectedItems) {
        if (!validIds.has(String(selectedId))) window.selectedItems.delete(selectedId);
    }
    if (window.selectedSongObjects instanceof Map) {
        for (const selectedId of window.selectedSongObjects.keys()) {
            if (!validIds.has(String(selectedId))) window.selectedSongObjects.delete(selectedId);
        }
    }
}

async function handleRemoveList(listId, event) {
    event.stopPropagation();
    if (!(await showSelect('删除歌单', '确定要删除歌单吗？', { danger: true }))) return;

    // 公开歌单需要管理员权限
    if (!(await requireAdminForOpenWrite('删除公开歌单'))) return;

    if (currentListData) {
        const index = currentListData.userList.findIndex(l => l.id === listId);
        if (index >= 0) {
            currentListData.userList.splice(index, 1);
            try {
                await pushDataChange();
                renderMyLists(currentListData);
            } catch (e) {
        showError('删除收藏失败');
            }
        }
    }
}

function getFavoriteSidebarOrder() {
    return Array.isArray(settings.favoriteSidebarOrder) ? settings.favoriteSidebarOrder : [];
}

function getOrderedFavoriteSidebarItems(items) {
    const order = getFavoriteSidebarOrder();
    if (!order.length) return items;

    const itemMap = new Map(items.map(item => [item.id, item]));
    const orderedItems = [];
    order.forEach(id => {
        const item = itemMap.get(id);
        if (!item) return;
        orderedItems.push(item);
        itemMap.delete(id);
    });
    return [...orderedItems, ...itemMap.values()];
}

function persistFavoriteSidebarOrder(ids) {
    settings.favoriteSidebarOrder = ids;
    window.settings = settings;
    try {
        persistSettings();
    } catch (e) {
        console.error('[Settings] 保存收藏侧边栏排序失败:', e);
    }
    if (settings.saveAccountSettingsToFile) {
        pushSettingsToServer();
    }
}

async function persistUserListOrderFromSidebar(ids) {
    if (!currentListData || !Array.isArray(currentListData.userList)) return;

    const currentUserIds = currentListData.userList.map(list => list.id);
    const userOrder = ids.filter(id => currentUserIds.includes(id));
    if (userOrder.length !== currentUserIds.length) return;
    if (userOrder.every((id, index) => id === currentUserIds[index])) return;

    const listMap = new Map(currentListData.userList.map(list => [list.id, list]));
    currentListData.userList = userOrder.map(id => listMap.get(id)).filter(Boolean);
    try {
        await pushDataChange();
    } catch (e) {
        console.error('[Playlist] 保存歌单排序失败:', e);
        showError('保存歌单排序失败，请稍后重试');
    }
}

function initFavoriteSidebarSortable(container) {
    if (typeof Sortable === 'undefined' || !container) return;

    try {
        const oldSortable = Sortable.get(container);
        if (oldSortable) oldSortable.destroy();
    } catch (e) {
        console.warn('[Playlist] 重置侧边栏排序失败:', e);
    }

    Sortable.create(container, {
        animation: 150,
        handle: '.favorite-sidebar-drag-handle',
        ghostClass: 'opacity-50',
        chosenClass: 'bg-emerald-50',
        onEnd: () => {
            const ids = Array.from(container.querySelectorAll('[data-sidebar-sort-id]'))
                .map(el => el.getAttribute('data-sidebar-sort-id'))
                .filter(Boolean);
            persistFavoriteSidebarOrder(ids);
            persistUserListOrderFromSidebar(ids);
        }
    });
}

function getFavoriteListDisplayName(name) {
    const normalizedName = String(name ?? '').trim();
    return normalizedName || '未命名歌单';
}

let favoriteSidebarMenuSequence = 0;

function closeFavoriteSidebarMenus(restoreFocus = false) {
    const openMenus = Array.from(document.querySelectorAll('.favorite-sidebar-menu.is-open'));
    let focusTarget = null;

    openMenus.forEach(menu => {
        const triggerId = menu.getAttribute('data-favorite-menu-trigger');
        const trigger = triggerId ? document.getElementById(triggerId) : null;
        if (restoreFocus && !focusTarget && trigger instanceof HTMLElement && trigger.isConnected) {
            focusTarget = trigger;
            trigger.setAttribute('aria-expanded', 'true');
        }

        menu.classList.remove('is-open', 'open-up');
        menu.classList.add('hidden');
        menu.hidden = true;

        if (trigger !== focusTarget) trigger?.setAttribute('aria-expanded', 'false');
    });

    if (restoreFocus && focusTarget) {
        // Hiding the focused menu item can move focus to document.body in
        // some browsers. Restore focus on the next frame while the trigger
        // remains exposed, then let :focus-within keep it visible.
        focusTarget.focus();
        requestAnimationFrame(() => {
            if (!focusTarget?.isConnected) return;
            focusTarget.focus();
            focusTarget.setAttribute('aria-expanded', 'false');
        });
    } else if (focusTarget) {
        focusTarget.setAttribute('aria-expanded', 'false');
    }
}

(window as any).closeFavoriteSidebarMenus = closeFavoriteSidebarMenus;

function removeFavoriteSidebarMenus() {
    closeFavoriteSidebarMenus();
    document.querySelectorAll('.favorite-sidebar-menu').forEach(menu => menu.remove());
}

function positionFavoriteSidebarMenu(trigger, menu) {
    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 6;
    const availableWidth = Math.max(1, window.innerWidth - viewportPadding * 2);
    const menuWidth = Math.min(
        Math.max(menu.offsetWidth, 176),
        availableWidth,
    );
    const menuHeight = menu.offsetHeight;
    const left = Math.min(
        Math.max(viewportPadding, triggerRect.right - menuWidth),
        Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding),
    );
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const openUp = spaceBelow < menuHeight + gap && triggerRect.top > menuHeight + gap;
    const preferredTop = openUp ? triggerRect.top - menuHeight - gap : triggerRect.bottom + gap;
    const top = Math.min(
        Math.max(viewportPadding, preferredTop),
        Math.max(viewportPadding, window.innerHeight - menuHeight - viewportPadding),
    );

    menu.style.inlineSize = `${menuWidth}px`;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.classList.toggle('open-up', openUp);
}

function toggleFavoriteListMenu(event, trigger) {
    event?.preventDefault();
    event?.stopPropagation();
    if (!(trigger instanceof HTMLElement)) return;

    const menuId = trigger.getAttribute('aria-controls');
    const menu = menuId ? document.getElementById(menuId) : null;
    if (!(menu instanceof HTMLElement)) return;

    const isOpen = menu.classList.contains('is-open') && !menu.hidden;
    closeFavoriteSidebarMenus();
    if (isOpen) return;

    menu.hidden = false;
    menu.classList.remove('hidden');
    menu.classList.add('is-open');
    menu.setAttribute('data-favorite-menu-trigger', trigger.id);
    trigger.setAttribute('aria-expanded', 'true');
    positionFavoriteSidebarMenu(trigger, menu);

    // Enter/Space activation should move into the menu; mouse/touch keeps the
    // trigger focused so the user can continue interacting from the pointer.
    const keyboardActivation = event instanceof MouseEvent ? event.detail === 0 : event?.type !== 'click';
    if (keyboardActivation) {
        requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
    }
}

window.toggleFavoriteListMenu = toggleFavoriteListMenu;

document.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.favorite-sidebar-more-btn')) return;
    if (target.closest('.favorite-sidebar-menu')) {
        if (target.closest('[role="menuitem"]')) closeFavoriteSidebarMenus();
        return;
    }
    closeFavoriteSidebarMenus();
});

document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const hasOpenMenu = document.querySelector('.favorite-sidebar-menu.is-open');
    if (!hasOpenMenu) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeFavoriteSidebarMenus(true);
});

window.addEventListener('resize', () => closeFavoriteSidebarMenus());
window.addEventListener('scroll', () => closeFavoriteSidebarMenus(), true);

function renderMyLists(data) {
    const container = document.getElementById('my-lists-container');
    removeFavoriteSidebarMenus();
    container.innerHTML = '';

    if (!data) {
        container.innerHTML = '<div class="favorite-sidebar-empty">请先在设置中登录</div>';
        refreshFavoritesChildrenHeight();
        return;
    }

    const portalMenus = [];

    // Helper to create list item
    const createItem = (listObj, name, icon, count) => {
        const id = typeof listObj === 'string' ? listObj : listObj.id;
        const idValue = String(id ?? '');
        const idArg = safeInlineString(idValue);
        const displayName = getFavoriteListDisplayName(name);
        const menuSequence = ++favoriteSidebarMenuSequence;
        const menuId = `favorite-list-menu-${menuSequence}`;
        const triggerId = `favorite-list-more-${menuSequence}`;
        const div = document.createElement('div');
        div.className = "favorite-sidebar-item t-text-muted hover:t-bg-main cursor-pointer flex items-center group transition-colors overflow-hidden min-w-0";
        div.title = displayName;
        div.setAttribute('data-sidebar-list-id', idValue);
        div.setAttribute('data-sidebar-sort-id', idValue);
        const activateList = () => handleListClick(idValue);
        div.onclick = activateList;
        makeKeyboardActivatable(div, `打开歌单 ${displayName}`, activateList);

        // Keep the label in a flexible slot and let the marquee helper take over
        // only when the available width is actually insufficient.
        const nameHtml = `
            <div class="favorite-sidebar-name ml-2 flex-1 min-w-0 overflow-hidden">
                ${createMarqueeHtml(displayName, 'favorite-sidebar-name-content w-full')}
            </div>
        `;

        // Optional actions live in a portal menu. The row only keeps a compact
        // trigger, so hovering the name never puts buttons over the label.
        const showExternalOps = listObj && listObj.sourceListId && listObj.source;
        let updateBadgeHtml = '';
        let menuItemsHtml = '';
        if (showExternalOps) {
            updateBadgeHtml = window.networkListUpdateMap && window.networkListUpdateMap.has(id)
                ? `<span class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-500 text-white text-[10px] font-bold mr-2" title="歌单有更新">!</span>`
                : '';

            menuItemsHtml += `
                <button type="button" role="menuitem" class="favorite-sidebar-menu-item" title="更新歌单内容" aria-label="更新歌单内容"
                   data-event-click-action="handleRefreshList" data-event-click-args="[${idArg}, &quot;@event&quot;]" data-event-stop="true"><i class="fas fa-sync-alt" aria-hidden="true"></i><span>更新歌单内容</span></button>
                <button type="button" role="menuitem" class="favorite-sidebar-menu-item" title="打开原始歌单" aria-label="打开原始歌单"
                   data-event-click-action="handleJumpToOriginalList" data-event-click-args="[${idArg}, &quot;@event&quot;]" data-event-stop="true"><i class="fas fa-external-link-alt" aria-hidden="true"></i><span>打开原始歌单</span></button>
            `;
        }

        if (typeof listObj !== 'string') {
            menuItemsHtml += `<button type="button" role="menuitem" class="favorite-sidebar-menu-item" title="重命名歌单" aria-label="重命名歌单" data-event-click-action="handleRenameList" data-event-click-args="[${idArg}, &quot;@event&quot;]" data-event-stop="true"><i class="fas fa-pen" aria-hidden="true"></i><span>重命名歌单</span></button>`;
        }
        if (idValue !== 'default' && idValue !== 'love') {
            menuItemsHtml += `<button type="button" role="menuitem" class="favorite-sidebar-menu-item is-danger" title="删除歌单" aria-label="删除歌单" data-event-click-action="handleRemoveList" data-event-click-args="[${idArg}, &quot;@event&quot;]" data-event-stop="true"><i class="fas fa-trash" aria-hidden="true"></i><span>删除歌单</span></button>`;
        }

        let moreButtonHtml = '';
        if (menuItemsHtml) {
            moreButtonHtml = `<button id="${triggerId}" type="button" class="favorite-sidebar-more-btn" title="更多歌单操作" aria-label="更多歌单操作：${escapeHtmlText(displayName)}" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" data-event-click-action="toggleFavoriteListMenu" data-event-click-args="[&quot;@event&quot;, &quot;@this&quot;]" data-event-stop="true"><i class="fas fa-ellipsis-h" aria-hidden="true"></i></button>`;

            const menu = document.createElement('div');
            menu.id = menuId;
            menu.className = 'favorite-sidebar-menu hidden';
            menu.hidden = true;
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', `${displayName}操作`);
            menu.setAttribute('data-favorite-menu-trigger', triggerId);
            menu.innerHTML = menuItemsHtml;
            menu.addEventListener('click', event => {
                const target = event.target;
                if (target instanceof Element && target.closest('[role="menuitem"]')) {
                    closeFavoriteSidebarMenus();
                }
            });
            menu.addEventListener('keydown', event => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                closeFavoriteSidebarMenus(true);
            });
            portalMenus.push(menu);
        }

        div.innerHTML = `
            <span class="favorite-sidebar-drag-handle cursor-grab t-text-muted/60 hover:text-emerald-500 flex-shrink-0 touch-none" title="拖拽排序">
                <i class="fas fa-grip-vertical text-xs"></i>
            </span>
            <i class="fas ${icon} w-5 t-text-muted group-hover:text-emerald-500 transition-colors flex-shrink-0"></i>
            ${nameHtml}
            <div class="favorite-sidebar-meta flex items-center flex-shrink-0">
                ${updateBadgeHtml}
                <span class="favorite-sidebar-count text-xs text-gray-300 group-hover:t-text-muted flex-shrink-0">${count}</span>
                ${moreButtonHtml}
            </div>
        `;
        return div;
    };

    // ---- 常驻：收藏歌手 / 收藏专辑 ----
    const createLibItem = (id, name, icon, countId, clickFn) => {
        const div = document.createElement('div');
        div.className = "favorite-sidebar-item t-text-muted hover:t-bg-main cursor-pointer flex items-center group transition-colors overflow-hidden min-w-0";
        div.title = name;
        div.setAttribute('data-sidebar-list-id', id);
        div.setAttribute('data-sidebar-sort-id', id);
        div.onclick = clickFn;
        makeKeyboardActivatable(div, `打开${name}`, clickFn);
        div.innerHTML = `
            <span class="favorite-sidebar-drag-handle cursor-grab t-text-muted/60 hover:text-emerald-500 flex-shrink-0 touch-none" title="拖拽排序">
                <i class="fas fa-grip-vertical text-xs"></i>
            </span>
            <i class="fas ${icon} w-5 t-text-muted group-hover:text-emerald-500 transition-colors flex-shrink-0"></i>
             <span class="favorite-sidebar-name ml-2 flex-1 min-w-0 truncate">${escapeHtmlText(name)}</span>
             <span id="${countId}" class="favorite-sidebar-count text-xs text-gray-300 group-hover:t-text-muted flex-shrink-0">0</span>
        `;
        return div;
    };
    const sidebarItems = [];

    // [新增] 当开启了 enablePublicFavorites 且已登录账号时，在侧边栏第一行添加“公开收藏”
    const enablePublicFavorites = !!window.lx_config?.['user.enablePublicFavorites'];
    const isUserLoggedIn = typeof window.isUserLoggedIn === 'function' ? window.isUserLoggedIn() : false;

    if (enablePublicFavorites && isUserLoggedIn) {
        const isPublicActive = window.isViewingPublicFavorites === true;
        const publicFavItem = document.createElement('div');
        publicFavItem.className = `favorite-sidebar-item cursor-pointer flex items-center group transition-colors overflow-hidden min-w-0 ${isPublicActive ? 'active-sub-item' : 't-text-muted hover:t-bg-main'}`;
        publicFavItem.title = '公开收藏';
        publicFavItem.setAttribute('data-sidebar-list-id', '__public_favorites__');
        publicFavItem.setAttribute('data-sidebar-sort-id', '__public_favorites__');
        const activatePublicFavorites = () => handleTogglePublicFavorites();
        publicFavItem.onclick = activatePublicFavorites;
        makeKeyboardActivatable(publicFavItem, '切换公开收藏', activatePublicFavorites);
        publicFavItem.innerHTML = `
            <span class="favorite-sidebar-drag-handle cursor-grab t-text-muted/60 hover:text-emerald-500 flex-shrink-0 touch-none" title="拖拽排序">
                <i class="fas fa-grip-vertical text-xs"></i>
            </span>
            <i class="fas fa-globe w-5 ${isPublicActive ? 'text-emerald-500' : 't-text-muted group-hover:text-emerald-500'} transition-colors flex-shrink-0"></i>
            <span class="favorite-sidebar-name ml-2 flex-1 min-w-0 truncate">公开收藏</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded-full ${isPublicActive ? 'bg-emerald-500 text-white font-bold' : 'bg-gray-200 dark:bg-gray-700 text-gray-500'}">${isPublicActive ? '已开启' : '切换'}</span>
        `;
        sidebarItems.push({ id: '__public_favorites__', type: 'system', el: publicFavItem });
    }

    sidebarItems.push(
        { id: '__lib_artists__', type: 'lib', el: createLibItem('__lib_artists__', '收藏歌手', 'fa-user', 'lib-artist-count', handleArtistLibraryClick) },
        { id: '__lib_albums__', type: 'lib', el: createLibItem('__lib_albums__', '收藏专辑', 'fa-compact-disc', 'lib-album-count', handleAlbumLibraryClick) }
    );

    if (data.defaultList) {
        sidebarItems.push({ id: 'default', type: 'system', el: createItem('default', '默认列表', 'fa-list', data.defaultList.length) });
    }
    if (data.loveList) {
        sidebarItems.push({ id: 'love', type: 'system', el: createItem('love', '我的收藏', 'fa-heart', data.loveList.length) });
    }
    if (data.userList) {
        data.userList.forEach(l => {
            const listLen = l.list ? l.list.length : 0;
            sidebarItems.push({ id: l.id, type: 'user', el: createItem(l, l.name, 'fa-music', listLen) });
        });
    }

    getOrderedFavoriteSidebarItems(sidebarItems).forEach(item => container.appendChild(item.el));
    portalMenus.forEach(menu => document.body.appendChild(menu));
    applyMarqueeChecks(container);
    refreshLibrarySidebarCount();
    initFavoriteSidebarSortable(container);
    refreshFavoritesChildrenHeight();
}

function handleListClick(listId, skipAutoUpdate = false) {
    clearSearchNavigation();
    exitListSecondaryModes();

    if (!currentListData) return;

    if (!skipAutoUpdate) {
        // Selections belong to the previously rendered list. Keeping them here makes
        // the toolbar count include invisible songs after opening another favorite list.
        resetSharedBatchSelection();
    }

    // Mobile: Close sidebar when a list is selected
    if (window.innerWidth < 1025) {
        const sidebar = document.getElementById('main-sidebar');
        // If sidebar is open (class removed), close it
        if (sidebar && !sidebar.classList.contains('-translate-x-full')) {
            toggleSidebar();
        }
    }

    // Set current viewing list ID for batch operations
    window.currentViewingListId = listId;
    setCurrentSearchScope('local_list');

    let list = [];
    let title = '';

    if (listId === 'default') {
        list = Array.isArray(currentListData.defaultList) ? currentListData.defaultList : [];
        title = '默认列表';
    } else if (listId === 'love') {
        list = Array.isArray(currentListData.loveList) ? currentListData.loveList : [];
        title = '我的收藏';
    } else {
        const uList = (Array.isArray(currentListData.userList) ? currentListData.userList : [])
            .find(l => String(l.id) === String(listId));
        if (uList) {
            list = Array.isArray(uList.list) ? uList.list : [];
            title = getFavoriteListDisplayName(uList.name);
        }
    }

    // Background refreshes intentionally preserve the batch selection, but only
    // for songs that still exist in the refreshed list.
    if (skipAutoUpdate) {
        reconcileBatchSelectionWithList(list);
        if (typeof updateBatchToolbar === 'function') updateBatchToolbar();
        if (typeof (window as any).syncSelectionPresentation === 'function') (window as any).syncSelectionPresentation();
    }

    // Switch to Search View (as List View)
    // Manually handle tab switch to avoid 'network' reset
    document.querySelectorAll('[id^="view-"]').forEach(el => el.classList.add('hidden'));
    const activeView = document.getElementById('view-search');
    activeView.classList.remove('hidden');

    // [New] 为歌单搜索视图重新初始化 ListSearch
    initGlobalListSearch();

    setTimeout(() => {
        activeView.classList.remove('opacity-0');
        activeView.classList.add('opacity-100');
    }, 10);

    // UI Updates
    document.getElementById('page-title').innerText = title;
    document.getElementById('search-input').value = '';
    document.getElementById('search-input').placeholder = `在 ${title} 中搜索...`;

    // Set Scope
    setCurrentSearchScope('local_list');
    document.getElementById('search-source').classList.add('hidden'); // Hide selector
    document.getElementById('search-type').classList.add('hidden');

    // Reset all tabs to muted, then highlight Favorites as the parent
    document.querySelectorAll('[id^="tab-"]').forEach(el => {
        el.classList.remove('active-tab', 'text-emerald-600');
        el.classList.add('t-text-muted');
    });
    const favTab = document.getElementById('tab-favorites');
    if (favTab) {
        favTab.classList.add('active-tab');
        favTab.classList.remove('t-text-muted');
    }

    // Highlight Child List
    document.querySelectorAll('[data-sidebar-list-id]').forEach(el => {
        el.classList.remove('active-sub-item');
        el.classList.add('t-text-muted');
    });
    const subItem = document.querySelector(`[data-sidebar-list-id="${listId}"]`);
    if (subItem) {
        subItem.classList.add('active-sub-item');
        subItem.classList.remove('t-text-muted');
    }

    // Render
    setPlayerPage(1); // Reset both renderer and legacy pagination state
    renderResults(list);

    // [New] Auto Update Logic: If it's a network playlist (has sourceListId) and setting is ON, refresh background
    const uList = currentListData.userList ? currentListData.userList.find(l => String(l.id) === String(listId)) : null;
    if (!skipAutoUpdate && settings.autoUpdateNetworkList && uList && uList.sourceListId && uList.source) {
        console.log('[AutoUpdate] Triggering background refresh for list:', listId);
        handleRefreshList(listId, null, true); // true means silent/no-confirm
    }
}

function handleFavoritesClick() {
    exitListSecondaryModes();

    // Highlight Header
    document.querySelectorAll('[id^="tab-"]').forEach(el => {
        el.classList.remove('active-tab', 'text-emerald-600');
        el.classList.add('t-text-muted');
    });
    const favTab = document.getElementById('tab-favorites');
    if (favTab) {
        favTab.classList.add('active-tab');
        favTab.classList.remove('t-text-muted');
    }

    // 未登录时展示登录引导页，而不是静默无响应。
    if (!isUserLoggedIn()) {
        const favoritesView = document.getElementById('view-favorites');
        if (favoritesView) {
            transitionPlayerView(favoritesView, getPlayerViewDirection('favorites'));
            return;
        }
    }

    toggleFavorites();
}

async function handleCreateList() {
    // The add-to-playlist surface is a legacy fixed overlay. Hide it before
    // opening the native input dialog so its backdrop/focus boundary cannot
    // intercept clicks or keyboard input. It is restored after cancellation or
    // successful creation, preserving the original collection flow.
    const shouldRestorePlaylistModal = !document.getElementById('playlist-add-modal')?.classList.contains('hidden');
    if (shouldRestorePlaylistModal) closePlaylistAddModal(true);

    try {
        const name = await showInput("新建歌单", "请输入新歌单的名称：", {
            placeholder: "歌单名称"
        });

        if (name && currentListData) {
            const activeListData = (window.isViewingPublicFavorites && window.myPersonalListData) ? window.myPersonalListData : currentListData;

            // 公开列表新建歌单需要管理员权限
            if (activeListData.username === '_open') {
                if (!(await requireAdminForOpenWrite('公开列表中新建歌单'))) return;
            }
            const newList = {
                id: 'webplayer_' + Date.now(),
                name: name,
                source: 'webplayer',
                list: []
            };
            activeListData.userList.push(newList);
            // Sync
            try {
                await pushDataChange(activeListData);
                renderMyLists(currentListData);
                // Re-render the add modal grid if it is open (or just to keep it fresh)
                if (typeof renderPlaylistAddGrid === 'function') {
                    renderPlaylistAddGrid();
                }
                showSuccess('歌单创建成功');
            } catch (e) {
                console.error('Create list failed:', e);
                showError('创建失败，请重试');
            }
        }
    } finally {
        if (shouldRestorePlaylistModal) {
            await openPlaylistAddModal();
        }
    }
}

async function handleRenameList(listId, event) {
    if (event) event.stopPropagation();
    if (!currentListData?.userList) return;

    const list = currentListData.userList.find(item => item.id === listId);
    if (!list) {
        showError('未找到要重命名的歌单');
        return;
    }

    const input = await showInput('重命名歌单', '请输入新的歌单名称：', {
        placeholder: '歌单名称',
        defaultValue: list.name || ''
    });
    if (input === null || input === undefined) return;

    const nextName = String(input).trim();
    if (!nextName) {
        showError('歌单名称不能为空');
        return;
    }
    if (nextName === list.name) return;

    if (!(await requireAdminForOpenWrite('重命名公开歌单'))) return;

    list.name = nextName;
    try {
        await pushDataChange();
        renderMyLists(currentListData);

        if (typeof renderPlaylistAddGrid === 'function' && !document.getElementById('playlist-add-modal')?.classList.contains('hidden')) {
            renderPlaylistAddGrid();
        }
        if (isCurrentlyViewingLocalList(listId)) {
            handleListClick(listId, true);
        }
        showSuccess('歌单名称已更新');
    } catch (e) {
        console.error('Rename list failed:', e);
        showError('重命名失败，请重试');
    }
}

function formatSongToLxMusicStandard(item) {
    if (!item) return item;
    const s = JSON.parse(JSON.stringify(item));

    // 获取封面地址 (兼容各种 SDK 原始字段和 meta 字段)
    const picUrl = s.img || s.pic || s.picUrl ||
        (s.meta && (s.meta.picUrl || s.meta.img || s.meta.pic)) ||
        (s.album && (s.album.picUrl || s.album.img)) ||
        (s.al && s.al.picUrl) || null;

    // 如果已经包含合法的 meta 且有 songId，且 ID 符合规范，可能是已格式化的
    if (s.meta && s.meta.songId && s.id && String(s.id).includes('_')) {
        // 确保 picUrl 存在
        if (!s.meta.picUrl && picUrl) s.meta.picUrl = picUrl;
        return s;
    }

    const source = s.source || '';
    const songmid = s.songmid || s.id || '';

    // 1. 提取核心元数据
    const albumName = s.albumName ||
        (s.album && s.album.name) ||
        (s.al && s.al.name) ||
        (s.meta && s.meta.albumName) || '';

    const albumId = s.albumId ||
        (s.album && s.album.id) ||
        (s.al && s.al.id) ||
        (s.meta && s.meta.albumId) || null;

    // 2. 构造干净的 meta 对象（只保留标准字段）
    let meta = {
        songId: String(songmid),
        songmid: String(songmid),
        albumName: albumName,
        picUrl: picUrl,
        qualitys: s.qualitys || s.types || (s.meta && (s.meta.qualitys || s.meta.types)) || [],
        _qualitys: s._qualitys || s._types || (s.meta && (s.meta._qualitys || s.meta._types)) || {}
    };

    if (albumId) meta.albumId = String(albumId);

    // 3. 构造标准 root 对象
    const rootItem = {
        name: s.name || '',
        singer: s.singer || '',
        source: source,
        interval: s.interval || s.time || '',
        meta: meta
    };

    // 4. 针对各平台源的特殊 ID 处理
    switch (source) {
        case 'tx':
            if (s.strMediaMid || (s.meta && s.meta.strMediaMid))
                meta.strMediaMid = s.strMediaMid || s.meta.strMediaMid;
            if (s.albumMid || (s.meta && s.meta.albumMid))
                meta.albumMid = s.albumMid || s.meta.albumMid;
            if (s.songId || (s.meta && s.meta.songId))
                meta.songId = String(s.songId || s.meta.songId);
            rootItem.id = `tx_${songmid}`;
            break;
        case 'wy':
            rootItem.id = `wy_${songmid}`;
            break;
        default:
            rootItem.id = songmid;
            break;
    }

    return rootItem;
}

async function collectCurrentSongList() {
    const activeListData = isUserLoggedIn() ? (window.myPersonalListData || currentListData) : currentListData;
    if (!activeListData) return;

    // 详情页采用按页懒加载；收藏整张歌单前确保后续页面也已拉取，避免只收藏首屏。
    if (typeof songListManager.ensureAllLoaded === 'function') {
        const loaded = await songListManager.ensureAllLoaded();
        if (!loaded) {
            if (window.showToast) window.showToast('error', '歌单仍在加载中，请稍后重试');
            return;
        }
    }

    const detail = songListManager.getCurrentDetail();
    if (!detail || !detail.id || !detail.list || detail.list.length === 0) {
        if (window.showToast) window.showToast('error', '歌单数据不完整或为空');
        return;
    }

    if (!isUserLoggedIn() && activeListData.username === '_open') {
        requireAdminForOpenWrite('收藏歌单到公开列表').then(ok => {
            if (ok) _executeCollectSongList(activeListData, detail);
        });
        return;
    }

    _executeCollectSongList(activeListData, detail);
}

function _executeCollectSongList(activeListData, detail) {
    const existingIndex = activeListData.userList.findIndex(l => String(l.sourceListId) === String(detail.id) && l.source === detail.source);
    if (existingIndex >= 0) {
        if (window.showToast) window.showToast('info', '该歌单已在您的收藏中');
        return;
    }

    const randomHex = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
    const newId = `${detail.source}_${randomHex()}${randomHex()}${randomHex()}${randomHex()}`;

    const listWithSource = detail.list.map(s => {
        const item = formatSongToLxMusicStandard(s);
        if (!item.source) item.source = detail.source;
        return item;
    });

    const newList = {
        id: newId,
        name: getFavoriteListDisplayName(detail.info.name),
        source: detail.source,
        sourceListId: String(detail.id),
        Album: detail.info.img || detail.info.pic || null,
        locationUpdateTime: null,
        list: listWithSource
    };

    activeListData.userList.push(newList);

    pushDataChange(activeListData).then(() => {
        renderMyLists(currentListData);
        if (window.showToast) window.showToast('success', '歌单收藏成功！');
    }).catch(err => {
        console.error('收藏失败:', err);
        if (window.showToast) window.showToast('error', '收藏失败，请重试');
    });
}

async function toggleLove() {
    const activeListData = isUserLoggedIn() ? (window.myPersonalListData || currentListData) : currentListData;
    if (!activeListData || currentIndex < 0) return;

    if (!isUserLoggedIn() && activeListData.username === '_open') {
        if (!(await requireAdminForOpenWrite('收藏歌曲到公开列表'))) return;
    }

    const song = currentPlaylist[currentIndex];
    const formattedSong = formatSongToLxMusicStandard(song);
    let targetId = formattedSong.id || song.id;
    activeListData.loveList ||= [];

    const index = activeListData.loveList.findIndex(s => s.id === targetId || s.id === song.id);
    const previousSong = index >= 0 ? activeListData.loveList[index] : null;
    if (index >= 0) {
        activeListData.loveList.splice(index, 1);
    } else {
        activeListData.loveList.push(formattedSong);
    }

    updatePlayerInfo(song);
    try {
        await pushDataChange(activeListData);
        renderMyLists(activeListData);
    } catch (e) {
        if (index >= 0 && previousSong) {
            activeListData.loveList.splice(index, 0, previousSong);
        } else {
            const addedIndex = activeListData.loveList.findIndex(s => s.id === targetId);
            if (addedIndex >= 0) activeListData.loveList.splice(addedIndex, 1);
        }
        updatePlayerInfo(song);
        renderMyLists(activeListData);
        console.error('[Love] 收藏保存失败:', e);
        showError(toUserMessage(e, '收藏保存失败，请稍后重试'));
    }
}

async function handleRefreshList(listId, event, silent = false) {
    if (event) event.stopPropagation();
    if (!currentListData) return;

    const list = currentListData.userList.find(l => l.id === listId);
    if (!list || !list.sourceListId || !list.source) {
        if (!silent && window.showToast) window.showToast('info', '该歌单不支持在线刷新');
        return;
    }

    if (!silent) {
        const safeListName = escapeHtmlText(list.name || list.id || list.sourceListId || '');
        const confirmed = await showSelect('更新歌单', `是否更新当前歌单 "${safeListName}"？\n(确认后将重新从服务器拉取歌单并覆盖当前内容)`, {
            confirmText: '确定更新',
            confirmColor: 'bg-emerald-500'
        });

        if (!confirmed) return;
    }

    if (window.showToast) window.showToast('info', '正在同步最新歌单内容...');

    try {
        const url = `${API_BASE}/songList/detail?source=${encodeURIComponent(list.source)}&id=${encodeURIComponent(list.sourceListId)}&page=1`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data || !data.list) throw new Error('数据拉取失败');

        // 格式化新歌曲列表
        const newList = data.list.map(s => {
            const item = formatSongToLxMusicStandard(s);
            if (!item.source) item.source = list.source;
            return item;
        });

        // 更新列表模型
        list.list = newList;
        if (data.info) {
            if (data.info.name) list.name = data.info.name;
            if (data.info.img || data.info.pic) list.Album = data.info.img || data.info.pic;
        }

        // 清除该列表的更新标记
        if (window.networkListUpdateMap) {
            window.networkListUpdateMap.delete(listId);
        }

        // 推送同步并重绘 UI
        await pushDataChange();
        renderMyLists(currentListData);

        // 如果当前正处于该列表视图，刷新结果列表显示
        if (isCurrentlyViewingLocalList(listId)) {
            handleListClick(listId, true); // Skip auto-update to avoid loop
        }

        if (window.showToast) window.showToast('success', '歌单内容已同步至最新状态');
    } catch (e) {
        console.error('[Refresh] Failed:', e);
        if (window.showToast) window.showToast('error', '歌单保存失败: ' + e.message);
    }
}

async function handleJumpToOriginalList(listId, event) {
    if (event) event.stopPropagation();
    if (!currentListData) return;

    const list = currentListData.userList.find(l => l.id === listId);
    if (!list || !list.sourceListId || !list.source) {
        if (window.showToast) window.showToast('info', '该歌单不支持跳转到原始页');
        return;
    }

    // 1. Switch Tab to songlist
    switchTab('songlist');

    // 2. Adjust SongListManager source select if available
    const sourceSelect = document.getElementById('songlist-source');
    if (sourceSelect) {
        sourceSelect.value = list.source;
    }

    // 3. Open Detail view via SongListManager
    songListManager.openDetail(list.sourceListId, list.source);
}


// Auto-restore on page load
document.addEventListener('DOMContentLoaded', async () => {
    // 0. Load settings first
    loadSettings();

    // Checkbox State
    const pubToggle = document.getElementById('toggle-public-sources');
    if (pubToggle) {
        pubToggle.checked = settings.enablePublicSources !== false;
    }

    // Update UI to match settings
    const selectEl = document.getElementById('items-per-page-select');
    if (selectEl && settings.itemsPerPage) {
        selectEl.value = settings.itemsPerPage.toString();
    }

    // [新增] 恢复音量设置
    try {
        const savedVolume = localStorage.getItem('lx_volume');
        if (savedVolume) {
            currentVolume = parseFloat(savedVolume);
            audio.volume = currentVolume;
            updateVolumeUI();
            console.log('[Volume] 已恢复音量设置:', currentVolume);
        }
    } catch (e) {
        console.error('[Volume] 恢复音量设置失败:', e);
    }

    // [新增] 恢复播放模式设置
    try {
        const savedMode = localStorage.getItem('lx_play_mode');
        if (savedMode && ['list', 'single', 'random', 'order'].includes(savedMode)) {
            playMode = savedMode;
            updatePlayModeUI();
            console.log('[PlayMode] 已恢复播放模式:', playMode);
        } else {
            // 默认模式
            updatePlayModeUI();
        }
    } catch (e) {
        console.error('[PlayMode] 恢复播放模式失败:', e);
    }

    // 1. Restore cached list data (from IndexedDB) for logged in user only
    try {
        const cachedList = await window.ListStore.get();
        if (cachedList && isUserLoggedIn()) {
            currentListData = cachedList;
            window.currentListData = currentListData;
            if (userName && currentListData) {
                currentListData.username = userName;
            }
            window.myPersonalListData = currentListData;
            renderMyLists(currentListData);
            console.log('[Cache] 已恢复缓存的个人列表数据');
        }
    } catch (e) {
        console.error('[Cache] 恢复列表数据失败:', e);
    }

    // [New] Switch to the user's default entry tab on load
    const defaultTab = settings.defaultEntry || 'favorites';
    switchTab(defaultTab);

    // Cookie 会话由首屏认证检查恢复；密码不会被保存到浏览器。
    syncUserSessionStatus();
    document.getElementById('user-login-form')?.addEventListener('submit', event => {
        event.preventDefault();
        void handleLocalLogin();
    });
});

window.handleLocalLogin = handleLocalLogin;
window.handleUserLogout = handleUserLogout;
window.resetAllSettings = resetAllSettings;

// 读取服务端返回的可读错误信息，优先使用 JSON 中的 message 字段。
async function resolvePushErrorMessage(res) {
    try {
        const data = await res.json();
        const message = data?.message || data?.error;
        if (typeof message === 'string' && message.trim()) return message.trim();
    } catch (_) { }
    return '保存失败，请检查网络或重新登录';
}

// 保存列表变更到服务端
    // 保存失败必须抛出异常，调用方才能回滚界面并提示用户，避免“看似成功实则未写入”。
async function pushDataChange(customListData) {
    const listToSave = customListData || currentListData;
    if (!listToSave) return;

    // 1. 优先保存到客户端 IndexedDB 本地缓存
    await window.ListStore.set(listToSave).catch(e => console.error('[IDBStore] 保存失败:', e));

    const isPublicList = listToSave.username === '_open' || listToSave.username === 'default';

    // 2. 如果是公开/未登录用户且开启了公开收藏开关
    if (isPublicList && window.lx_config?.['user.enablePublicFavorites']) {
        const isAdmin = adminSessionActive;
        if (!isAdmin) {
            throw new Error('保存公开歌单需要管理员权限，请先登录管理员账号');
        }
        const res = await fetch('/api/user/list?user=_open', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...getUserAuthHeaders()
            },
            body: JSON.stringify(listToSave)
        });
        if (!res.ok) {
            const errorMsg = await resolvePushErrorMessage(res);
            console.error('[PublicList] 推送保存公共歌单失败:', errorMsg);
            throw new Error(errorMsg);
        }
        console.log('[PublicList] 公共歌单成功保存至服务器');
        return;
    }

    const res = await fetch('/api/user/list', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(listToSave)
    });
    if (!res.ok) throw new Error(await resolvePushErrorMessage(res));
}

async function refreshUserListData() {
    try {
        const response = await fetch('/api/user/list', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) return;
        const listData = await response.json();
        currentListData = listData;
        window.currentListData = listData;
        if (listData && listData.username !== '_open') {
            window.myPersonalListData = listData;
        }
        if (typeof renderMyLists === 'function') {
            renderMyLists(listData);
        }

        // If currently viewing a local list, refresh its contents in main view
        if (isCurrentlyViewingLocalList(window.currentViewingListId)) {
            console.log('[List] Refreshing current list view:', window.currentViewingListId);
            handleListClick(window.currentViewingListId, true); // true to skip background auto-update
        }

        // Save to cache
        await window.ListStore.set(listData).catch(e => console.error('[IDBStore] 保存失败:', e));
        console.log('[List] Data refreshed');
    } catch (e) {
        console.error('[List] Failed to refresh list data:', e);
    }
}

window.refreshUserListData = refreshUserListData;
window.handleCreateList = handleCreateList;
window.handleRenameList = handleRenameList;
window.handleRefreshList = handleRefreshList;
window.handleRemoveList = handleRemoveList;
window.toggleFavorites = toggleFavorites;
window.handleFavoritesClick = handleFavoritesClick;


// ========================================
// 导出函数到 window (ES Module 需要显式暴露)
// ========================================

// Custom Source functions
window.openCustomSourceModal = openCustomSourceModal;
window.closeCustomSourceModal = closeCustomSourceModal;
window.switchCustomSourceMode = switchCustomSourceMode;
window.handleFileUpload = handleFileUpload;
window.handleUrlImport = handleUrlImport;

// Playlist Modal functions
window.openPlaylistAddModal = openPlaylistAddModal;
window.closePlaylistAddModal = closePlaylistAddModal;
window.toggleSongInList = toggleSongInList;


// 新版函数名
window.toggleSource = toggleSource;
window.deleteSource = deleteSource;
window.reloadSource = reloadSource;

// 兼容旧版函数名 (Alias)
window.toggleCustomSource = toggleSource;
window.deleteCustomSource = deleteSource;
window.importFromUrl = handleUrlImport;

window.togglePublicSourcesSetting = togglePublicSourcesSetting;

// Core functions
window.switchTab = switchTab;
window.handleSearchKeyPress = handleSearchKeyPress;
window.doSearch = doSearch;
window.changePage = changePage;
window.handleHotSearchClick = handleHotSearchClick;
window.playSong = playSong;
window.togglePlay = togglePlay;
window.handleDownloadClick = handleDownloadClick;
window.playNext = playNext;
window.playPrev = playPrev;
window.seek = seek;
window.changeQualityPreference = changeQualityPreference;
window.toggleQualityModal = toggleQualityModal;

// Volume
window.setVolume = setVolume;
window.toggleMute = toggleMute;
window.setPlayMode = setPlayMode;
window.togglePlayModeMenu = togglePlayModeMenu;
window.setPlaybackRate = setPlaybackRate;
window.togglePlaybackRateMenu = togglePlaybackRateMenu;
window.showSelect = showSelect;
window.showSuccess = showSuccess;
window.showInfo = showInfo;
window.showError = showError;
window.showLoading = showLoading;
window.hideLoading = hideLoading;
window.getUserAuthHeaders = getUserAuthHeaders;
window.isUserLoggedIn = isUserLoggedIn;
window.ensureUserSession = ensureUserSession;
window.renderMyLists = renderMyLists;

// Lyrics
window.toggleLyrics = toggleLyrics;
window.handleLyricScroll = handleLyricScroll;

// Favorites & Lists
window.toggleFavorites = toggleFavorites;
window.handleFavoritesClick = handleFavoritesClick;
window.handleListClick = handleListClick;
window.handleCreateList = handleCreateList;
window.handleRefreshList = handleRefreshList;
window.handleJumpToOriginalList = handleJumpToOriginalList;
window.handleRemoveList = handleRemoveList;
window.toggleLove = toggleLove;
window.collectCurrentSongList = collectCurrentSongList;

// 认证与令牌管理
window.handleLogout = handleLogout;

window.handleLocalLogin = handleLocalLogin;
window.handleUserLogout = handleUserLogout;
window.resetAllSettings = resetAllSettings;

// Comment functions
window.toggleCommentModal = toggleCommentModal;
window.switchCommentType = switchCommentType;
window.refreshComments = refreshComments;
window.fetchComments = fetchComments;
window.checkServerCache = checkServerCache;


// [Redundant block removed]

// ========================================
// UI Helper Functions (Toast Notifications)
// ========================================

/**
 * 播放栏下载/缓存按钮点击处理
 */
async function handleDownloadClick(event) {
    if (event) event.stopPropagation();

    if (!currentPlayingSong) {
        showInfo('当前没有正在播放的歌曲');
        return;
    }

    if (typeof downloadSong === 'function') {
        await downloadSong(currentPlayingSong);
    } else {
        showError('下载功能未就绪');
    }
}

let qualityMenuCleanup = null;

function getPlayerQualityOptions() {
    const select = document.getElementById('quality-select') as HTMLSelectElement | null;
    if (select && select.options.length) {
        return Array.from(select.options).map(option => ({
            value: option.value,
            label: option.textContent?.trim() || option.value,
        }));
    }

    const fallback = ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master'];
    return fallback.map(value => ({
        value,
        label: window.QualityManager?.getQualityDisplayName?.(value) || value,
    }));
}

function getPlayerQualityBadgeLabel(quality) {
    return window.QualityManager?.getQualityBadgeLabel?.(quality) || String(quality || '').toUpperCase();
}

function closeQualityModal(restoreFocus = false) {
    const menu = document.getElementById('player-quality-menu');
    const trigger = document.getElementById('player-quality-tag');
    if (menu) {
        menu.hidden = true;
        menu.classList.remove('is-open');
    }
    trigger?.setAttribute('aria-expanded', 'false');
    qualityMenuCleanup?.();
    qualityMenuCleanup = null;
    if (restoreFocus) (trigger as HTMLButtonElement | null)?.focus();
}

function handleQualityMenuKeydown(event) {
    const menu = document.getElementById('player-quality-menu');
    if (!menu || menu.hidden) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        closeQualityModal(true);
        return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const options = Array.from(menu.querySelectorAll('[role="menuitemradio"]')) as HTMLButtonElement[];
    if (!options.length) return;
    event.preventDefault();
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    options[(currentIndex + offset + options.length) % options.length].focus();
}

function renderQualityMenu() {
    const menu = document.getElementById('player-quality-menu');
    if (!menu) return;

    const currentPreference = String(settings.preferredQuality || '');
    menu.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'px-3 py-2 text-[10px] font-bold t-text-muted uppercase tracking-wider';
    heading.textContent = '播放音质';
    menu.appendChild(heading);

    getPlayerQualityOptions().forEach(option => {
        const button = document.createElement('button');
        const selected = option.value === currentPreference;
        button.type = 'button';
        button.className = 'player-quality-option';
        button.setAttribute('role', 'menuitemradio');
        button.setAttribute('aria-checked', String(selected));
        button.dataset.quality = option.value;
        button.title = option.label;

        const badge = document.createElement('span');
        badge.className = 'player-quality-option-badge';
        badge.textContent = getPlayerQualityBadgeLabel(option.value);
        const name = document.createElement('span');
        name.className = 'player-quality-option-name';
        name.textContent = option.label;
        const check = document.createElement('i');
        check.className = 'fas fa-check player-quality-option-check';
        check.setAttribute('aria-hidden', 'true');

        button.append(badge, name, check);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            void selectPlayerQuality(option.value);
        });
        menu.appendChild(button);
    });
}

async function selectPlayerQuality(quality) {
    closeQualityModal();
    await updateSetting('preferredQuality', quality);
    if (String(settings.preferredQuality || '') !== String(quality)) return;
    if (currentPlayingSong) {
        try {
            await changePlaybackQuality(quality);
        } catch (error) {
            console.error('[Quality] 切换播放音质失败:', error);
            showError(error?.message || '切换播放音质失败');
        }
    }
}

function toggleQualityModal(event) {
    event?.stopPropagation();
    event?.preventDefault();

    const menu = document.getElementById('player-quality-menu');
    const trigger = document.getElementById('player-quality-tag');
    if (!menu || !trigger) return;

    if (!menu.hidden) {
        closeQualityModal();
        return;
    }

    renderQualityMenu();
    menu.hidden = false;
    menu.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');

    const handleOutsideClick = (outsideEvent) => {
        const control = document.getElementById('player-quality-control');
        if (control && !control.contains(outsideEvent.target)) closeQualityModal();
    };
    const handleEscape = (keyboardEvent) => {
        if (keyboardEvent.key === 'Escape') closeQualityModal(true);
    };
    const handleViewportChange = () => closeQualityModal();
    document.addEventListener('click', handleOutsideClick);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    menu.addEventListener('keydown', handleQualityMenuKeydown);
    qualityMenuCleanup = () => {
        document.removeEventListener('click', handleOutsideClick);
        window.removeEventListener('keydown', handleEscape);
        window.removeEventListener('resize', handleViewportChange);
        window.removeEventListener('scroll', handleViewportChange, true);
        menu.removeEventListener('keydown', handleQualityMenuKeydown);
    };

    const selected = Array.from(menu.querySelectorAll('[role="menuitemradio"]'))
        .find(option => (option as HTMLElement).dataset.quality === String(settings.preferredQuality || '')) as HTMLButtonElement | undefined;
    (selected || menu.querySelector('[role="menuitemradio"]') as HTMLButtonElement | null)?.focus();
}

// 监听窗口大小变化
window.addEventListener('resize', () => {
    const indicator = document.getElementById('lyric-scroll-indicator');
    if (indicator) {
        indicator.dataset.positioned = '';
    }
});

// ========== 页面初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
    console.log('[Init] 页面加载完成');

    // 预加载自定义源数据，确保设置界面和模态框打开时有数据
    loadCustomSources();

    // [优化] 此处不再立即调用 showInitialSearchState()，移至下方的 setTimeout 中

    // [Fix] Listen to scroll event for real-time highlighting
    const lyricContainer = document.getElementById('lyric-container');
    if (lyricContainer) {
        // Core user interaction detection
        // 只有当用户真的 "摸" 了或者是 "滑" 了，才认为是用户滚动
        // 纯 scroll 事件会被 scrollTo 触发，所以不能仅依赖 scroll 事件来 *启动* 手动模式
        const setUserInteracting = () => {
            // 强制清除程序滚动标记，因为用户干预了
            isProgrammaticScroll = false;
            if (window.programmaticScrollTimer) {
                clearTimeout(window.programmaticScrollTimer);
                window.programmaticScrollTimer = null;
            }
        };

        lyricContainer.addEventListener('mousedown', setUserInteracting, { passive: true });
        lyricContainer.addEventListener('touchstart', setUserInteracting, { passive: true });
        lyricContainer.addEventListener('touchmove', setUserInteracting, { passive: true });
        lyricContainer.addEventListener('wheel', setUserInteracting, { passive: true });
        lyricContainer.addEventListener('keydown', setUserInteracting, { passive: true }); // Keyboard arrow keys

        // 使用 passive: true 提高滚动性能
        lyricContainer.addEventListener('scroll', handleLyricScroll, { passive: true });
    }

    // 绑定音质选择
    const qualitySelect = document.getElementById('quality-select');
    if (qualitySelect && settings.preferredQuality) {
        qualitySelect.value = settings.preferredQuality;
    }

    const downloadTargetSelect = document.getElementById('setting-default-download-target');
    if (downloadTargetSelect) downloadTargetSelect.value = settings.defaultDownloadTarget;

    const downloadQualitySelect = document.getElementById('setting-default-download-quality');
    if (downloadQualitySelect) downloadQualitySelect.value = settings.defaultDownloadQuality;

    // [优化] 延迟执行非关键初始化逻辑（设置恢复、状态重置、自动登录等）
    // 允许浏览器先完成主要的渲染和 load 事件，释放 PWA 安装按钮并显示刷新图标
    setTimeout(async () => {
        // 等待 HttpOnly Cookie 校验完成，避免自动恢复逻辑先于认证结果执行。
        await userSessionReady;
        console.log('[Init] 启动后台初始化任务...');
        loadSettings();
        await restorePlaybackState();
        updateQueueBadge();

        // [新增] 延迟显示热搜，避免启动请求堆积
        if (typeof showInitialSearchState === 'function') {
            showInitialSearchState();
        }

        // 监听源切换，自动刷新热搜
        const searchSourceSelect = document.getElementById('search-source');
        if (searchSourceSelect) {
            searchSourceSelect.addEventListener('change', () => {
                const searchInput = document.getElementById('search-input');
                // 仅当搜索框为空（即处于显示热搜状态）时刷新
                if (!searchInput || !searchInput.value.trim()) {
                    showInitialSearchState();
                }
            });
        }

        if (userSessionActive && userName) await reloadUserFavorites();
    }, 100);

    // [New] 全局精简播放栏控制函数
    window.setCompactPlaybar = function (compact, showToastMsg = false) {
        const infoEl = document.getElementById('player-song-info');
        const collapseBtn = document.getElementById('btn-collapse-panel');
        if (!infoEl) return;

        if (compact) {
            infoEl.style.display = 'none';
            if (collapseBtn) collapseBtn.style.display = 'none';
            if (showToastMsg) showToast('info', '已开启精简播放控制栏', 1500);
        } else {
            infoEl.style.display = '';
            if (collapseBtn) collapseBtn.style.display = '';
            if (showToastMsg) showToast('info', '已恢复完整播放栏控制', 1500);
        }

        // 重新计算并应用底栏自适应布局高度 (解决手机端 Footer 高度重叠)
        if (window.musicVisualizer && window.musicVisualizer.applySettings) {
            setTimeout(() => window.musicVisualizer.applySettings(), 50);
        }
    };

    // [New] 长按播放键隐藏播放栏内容 (精简模式)
    const btnPlay = document.getElementById('btn-play');
    if (btnPlay) {
        let pressTimer;
        const infoEl = document.getElementById('player-song-info');

        const startPress = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return; // 仅限左键
            window.playBtnIsLongPress = false;
            pressTimer = setTimeout(() => {
                window.playBtnIsLongPress = true;
                if (navigator.vibrate) navigator.vibrate(50);

                if (infoEl) {
                    const isHidden = infoEl.style.display === 'none';
                    window.setCompactPlaybar(!isHidden, true);
                }
            }, 600); // 600ms = 长按
        };

        const cancelPress = () => {
            if (pressTimer) clearTimeout(pressTimer);
        };

        // 事件绑定
        btnPlay.addEventListener('mousedown', startPress);
        btnPlay.addEventListener('touchstart', startPress, { passive: true });
        btnPlay.addEventListener('mouseup', cancelPress);
        btnPlay.addEventListener('touchend', cancelPress);
        btnPlay.addEventListener('mouseleave', cancelPress);
        btnPlay.addEventListener('touchcancel', cancelPress);
    }
});

// ========================================
// Global Overrides
// ========================================

// Override batch_pagination.js helper to access local currentSearchScope
window.getCurrentActiveListId = function () {
    if (window.currentSearchScope === 'local_list') return window.currentViewingListId;
    if (window.currentSearchScope === 'local_all') return 'love';
    return null;
};



// ========================================
// Mobile Optimization Logic
// ========================================

// Mobile Sidebar Toggle
let sidebarCloseTimer: number | null = null;

function toggleSidebar(forceState?: boolean) {
    const sidebar = document.getElementById('main-sidebar');
    const backdrop = document.getElementById('mobile-sidebar-backdrop');
    const menuBtn = document.getElementById('mobile-menu-btn');
    if (!sidebar) return;

    const isCurrentlyClosed = sidebar.classList.contains('-translate-x-full');
    const shouldOpen = typeof forceState === 'boolean' ? forceState : isCurrentlyClosed;
    const motionDuration = prefersReducedPlayerMotion() ? 0 : 280;

    if (sidebarCloseTimer !== null) {
        window.clearTimeout(sidebarCloseTimer);
        sidebarCloseTimer = null;
    }

    if (shouldOpen) {
        // Open
        sidebar.classList.remove('-translate-x-full');
        sidebar.classList.add('translate-x-0');
        if (backdrop) {
            backdrop.classList.remove('hidden');
            backdrop.classList.remove('is-visible');
            requestAnimationFrame(() => {
                if (sidebar.classList.contains('translate-x-0')) backdrop.classList.add('is-visible');
            });
        }
        if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');
        document.body.classList.add('sidebar-open');
    } else {
        // Close
        sidebar.classList.remove('translate-x-0');
        sidebar.classList.add('-translate-x-full');
        if (backdrop) {
            backdrop.classList.remove('is-visible');
            if (motionDuration === 0) {
                backdrop.classList.add('hidden');
            } else {
                sidebarCloseTimer = window.setTimeout(() => {
                    sidebarCloseTimer = null;
                    if (sidebar.classList.contains('-translate-x-full')) backdrop.classList.add('hidden');
                }, motionDuration);
            }
        }
        if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('sidebar-open');
    }
}
(window as any).toggleSidebar = toggleSidebar;

// Auto-adjust layout on resize
window.addEventListener('resize', () => {
    const sidebar = document.getElementById('main-sidebar');
    const backdrop = document.getElementById('mobile-sidebar-backdrop');

    if (sidebar && window.innerWidth >= 1025) {
        // Reset styles for desktop
        if (sidebarCloseTimer !== null) {
            window.clearTimeout(sidebarCloseTimer);
            sidebarCloseTimer = null;
        }
        sidebar.classList.remove('-translate-x-full', 'translate-x-0');
        if (backdrop) {
            backdrop.classList.remove('is-visible');
            backdrop.classList.add('hidden');
        }
        document.body.classList.remove('sidebar-open');
    } else if (sidebar) {
        // Ensure default closed state for mobile if not explicitly open
        if (!sidebar.classList.contains('translate-x-0')) {
            sidebar.classList.add('-translate-x-full');
        }
    }
});

// 切换详情页封面显示（移动端优化）
// 切换详情页封面显示（已弃用大歌词模式，保留空实现以兼容历史调用与测试约定）
function toggleDetailCover() {}
(window as any).toggleDetailCover = toggleDetailCover;

// Initialize mobile gestures & touch interactions
function initMobileGestures() {
    // Keep the mobile backdrop in sync with the initial sidebar state. A stale
    // backdrop must not create an invisible click layer over the player footer.
    const initialSidebar = document.getElementById('main-sidebar');
    const initialBackdrop = document.getElementById('mobile-sidebar-backdrop');
    if (window.innerWidth < 1025 && initialSidebar?.classList.contains('-translate-x-full')) {
        initialBackdrop?.classList.add('hidden');
        document.body.classList.remove('sidebar-open');
    }

    // 1. Sidebar Touch Gestures (Swipe left to close)
    const sidebar = document.getElementById('main-sidebar');
    if (sidebar) {
        let touchStartX = 0;
        let touchStartY = 0;
        let isSwiping = false;

        sidebar.addEventListener('touchstart', (e: TouchEvent) => {
            if (e.touches.length !== 1) return;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: true });

        sidebar.addEventListener('touchmove', (e: TouchEvent) => {
            if (!isSwiping || e.touches.length !== 1) return;
            const currentX = e.touches[0].clientX;
            const currentY = e.touches[0].clientY;
            const diffX = currentX - touchStartX;
            const diffY = currentY - touchStartY;
            if (diffX < -45 && Math.abs(diffX) > Math.abs(diffY)) {
                isSwiping = false;
                toggleSidebar(false);
            }
        }, { passive: true });

        sidebar.addEventListener('touchend', () => {
            isSwiping = false;
        }, { passive: true });
    }

    // 2. Fullscreen Player Detail swipe-down-to-dismiss
    const detailView = document.getElementById('view-player-detail');
    if (detailView) {
        let detailTouchStartY = 0;
        let detailTouchStartX = 0;
        let canSwipeDown = false;

        detailView.addEventListener('touchstart', (e: TouchEvent) => {
            if (e.touches.length !== 1) return;
            detailTouchStartY = e.touches[0].clientY;
            detailTouchStartX = e.touches[0].clientX;
            const lyricContainer = document.getElementById('lyric-container');
            const isAtTop = !lyricContainer || lyricContainer.scrollTop <= 5;
            canSwipeDown = isAtTop || detailTouchStartY < 120;
        }, { passive: true });

        detailView.addEventListener('touchmove', (e: TouchEvent) => {
            if (!canSwipeDown || e.touches.length !== 1) return;
            const diffY = e.touches[0].clientY - detailTouchStartY;
            const diffX = e.touches[0].clientX - detailTouchStartX;
            if (diffY > 75 && Math.abs(diffY) > Math.abs(diffX) * 1.4) {
                canSwipeDown = false;
                toggleLyrics();
            }
        }, { passive: true });

        detailView.addEventListener('touchend', () => {
            canSwipeDown = false;
        }, { passive: true });
    }

    // 3. Mobile Player Bar: Tapping song info opens full-screen lyrics/player
    const playerSongInfo = document.getElementById('player-song-info');
    if (playerSongInfo) {
        playerSongInfo.addEventListener('click', (e: MouseEvent) => {
            if (window.innerWidth < 1025) {
                const target = e.target as HTMLElement | null;
                if (target && target.closest('button, a, input, select')) return;
                toggleLyrics();
            }
        });
    }

    // 4. Escape key closes mobile sidebar
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            const moreMenu = document.getElementById('player-more-menu');
            const moreButton = document.getElementById('player-more-btn');
            if (moreMenu && !moreMenu.classList.contains('hidden')) {
                moreMenu.classList.add('hidden');
                moreButton?.setAttribute('aria-expanded', 'false');
                moreButton?.focus();
                return;
            }

            const sidebar = document.getElementById('main-sidebar');
            if (sidebar && !sidebar.classList.contains('-translate-x-full') && window.innerWidth < 1025) {
                toggleSidebar(false);
            }
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileGestures);
} else {
    initMobileGestures();
}

// 启动展开按钮淡化计时器
function startExpandBtnTimer() {
    const expandBtn = document.getElementById('btn-expand-panel');
    if (!expandBtn) return;

    if (expandBtnTimeout) clearTimeout(expandBtnTimeout);
    expandBtn.classList.remove('faint');

    expandBtnTimeout = setTimeout(() => {
        // 只有当播放栏仍处于隐藏状态时才淡化
        const footer = document.getElementById('player-footer');
        if (footer && footer.classList.contains('translate-y-[110%]')) {
            expandBtn.classList.add('faint');
        }
    }, 3000);
}

// 启动歌词顶栏控制按钮淡化计时器
function startToggleLyricsBtnTimer() {
    const toggleBtn = document.getElementById('btn-toggle-lyrics');
    if (!toggleBtn) return;

    if (toggleLyricsBtnTimeout) clearTimeout(toggleLyricsBtnTimeout);
    toggleBtn.classList.remove('faint');

    toggleLyricsBtnTimeout = setTimeout(() => {
        // 只有当歌词页面处于显示状态时才淡化
        const view = document.getElementById('view-player-detail');
        if (view && !view.classList.contains('translate-y-[100%]')) {
            toggleBtn.classList.add('faint');
        }
    }, 3000);
}

// 切换底部播放栏显示/隐藏 (移动端)
function togglePlayerMoreMenu(event?: Event) {
    event?.stopPropagation();
    const menu = document.getElementById('player-more-menu');
    const button = document.getElementById('player-more-btn');
    if (!menu || !button) return;

    const isOpening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !isOpening);
    button.setAttribute('aria-expanded', String(isOpening));
}

window.togglePlayerMoreMenu = togglePlayerMoreMenu;

document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('#player-more-menu, #player-more-btn')) return;
    const menu = document.getElementById('player-more-menu');
    const button = document.getElementById('player-more-btn');
    if (!menu || menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    button?.setAttribute('aria-expanded', 'false');
});

function togglePlayerPanel() {
    const footer = document.getElementById('player-footer');
    const expandBtn = document.getElementById('btn-expand-panel');
    const container = document.getElementById('player-detail-container');

    if (!footer || !expandBtn) return;

    // 检查是否已经隐藏 (通过 transform 判断)
    // 注意: Tailwind 的 translate-y-full 等同于 transform: translateY(100%)
    const isHidden = footer.classList.contains('translate-y-[110%]');

    const views = ['view-search', 'view-settings', 'view-favorites', 'view-about', 'main-sidebar', 'view-songlist', 'songlist-detail-view'];
    const playerDetail = document.getElementById('view-player-detail');
    const lyricsWrapper = document.getElementById('lyrics-wrapper');

    if (isHidden) {
        // 显示播放栏
        footer.classList.remove('translate-y-[110%]');
        footer.style.opacity = '1';
        footer.style.pointerEvents = 'auto';
        document.getElementById('btn-collapse-panel')?.setAttribute('aria-expanded', 'true');
        expandBtn.setAttribute('aria-expanded', 'false');

        // 隐藏展开按钮
        expandBtn.classList.remove('translate-y-0', 'scale-100', 'opacity-100');
        expandBtn.classList.add('translate-y-20', 'scale-75', 'opacity-0');

        // 重置状态
        if (expandBtnTimeout) clearTimeout(expandBtnTimeout);
        expandBtn.classList.remove('faint');

        // 保留各页面模板定义的底部 Padding，播放栏与主体卡片之间仅保留微距。
        // 不再注入旧版的 pb-44/md:pb-32，避免播放栏展开后产生过大的空隙。
        views.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('pb-32', 'pb-44', 'md:pb-32');
        });

        // 歌词页: 增加底部 Padding (避开播放栏)
        if (playerDetail) {
            playerDetail.classList.add('pb-24');
            playerDetail.classList.remove('pb-0');
        }

        // 桌面端: 恢复 md:pt-0 (垂直居中, 无顶部Padding)
        if (container) {
            container.classList.remove('translate-y-12', 'opacity-80', 'scale-95');
            container.classList.remove('md:pt-24', 'md:pt-12');
            container.classList.add('md:pt-0');
        }
    } else {
        // 隐藏播放栏 (向下移出屏幕) 
        footer.classList.add('translate-y-[110%]');
        footer.style.opacity = '0';
        footer.style.pointerEvents = 'none';
        document.getElementById('btn-collapse-panel')?.setAttribute('aria-expanded', 'false');
        expandBtn.setAttribute('aria-expanded', 'true');

        // 停止动画并清除可视化画布，防止在偏移后仍有残留渲染
        if (window.musicVisualizer && window.musicVisualizer.clear) {
            window.musicVisualizer.clear('footer');
        }
        setTimeout(() => {
            expandBtn.classList.remove('translate-y-20', 'scale-75', 'opacity-0');
            expandBtn.classList.add('translate-y-0', 'scale-100', 'opacity-100');
        }, 300);

        // 开启 3s 自动淡化计时器
        startExpandBtnTimer();

        // 移除内容底部 Padding (内容延伸到底部)
        views.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('pb-32', 'pb-44', 'md:pb-32');
        });

        // 歌词页: 移除底部 Padding (利用底部空间)
        if (playerDetail) {
            playerDetail.classList.remove('pb-24');
            playerDetail.classList.add('pb-0');
        }

        // 桌面端: 移除 md:pt-0, 添加 md:pt-24 (避免遮挡顶部 NOW PLAYING)
        // 调整内容容器以填满全屏
        if (container) {
            container.classList.remove('md:pt-0');
            container.classList.add('md:pt-24');
            container.classList.add('translate-y-12', 'opacity-80', 'scale-95');
            // 稍后移除微调，保持丝滑
            setTimeout(() => {
                container.classList.remove('translate-y-12', 'opacity-80', 'scale-95');
            }, 600);
        }
    }

    // [New] 触发可视化模块更新布局 (Padding 处理)
    if (window.musicVisualizer) {
        window.musicVisualizer.applySettings();
    }

    // 重新校准歌词位置 (动画结束后执行)
    setTimeout(() => {
        scrollToActiveLine(true);
    }, 300);
}

// 导出函数
window.togglePlayerPanel = togglePlayerPanel;
window.updateSetting = updateSetting;

// Initialize Sound Effects on first play/click
function initAudioEngine() {
    const initializeAudioEngine = () => {
        if (!window.soundEffects || window._audioEngineInited) return;
        window.soundEffects.init();
        window._audioEngineInited = true;
        console.log('[AudioEngine] Sound effects initialized via AudioEngine');

        // Ensure Visualizer captures correct source
        const initializeVisualizer = () => {
            if (window.musicVisualizer?.init) window.musicVisualizer.init();
        };
        if (window.musicVisualizer) initializeVisualizer();
        else ensureVisualizerLoaded().then(initializeVisualizer).catch(() => {
            console.warn('[Visualizer] 可视化模块加载失败');
        });

        // iOS: 在用户手势上下文中立即启动 anchor audio，建立后台音频会话
        if (window.iOSBackgroundAudio) {
            window.iOSBackgroundAudio.ensureAnchorPlaying();
        }
    };

    if (window.soundEffects) {
        initializeAudioEngine();
    } else {
        ensureSoundEffectsLoaded().then(initializeAudioEngine).catch(() => {
            console.warn('[AudioEngine] 音效模块加载失败');
        });
    }
}

// Intercept play for audio engine init
const originalTogglePlay = window.togglePlay;
window.togglePlay = function () {
    initAudioEngine();
    if (originalTogglePlay) originalTogglePlay();
};

document.addEventListener('click', initAudioEngine, { once: true });


function initHeaderClock() {
    const timeEl = document.getElementById('header-clock-time');
    if (!timeEl) return;

    const updateClock = () => {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const timeStr = `${hours}:${minutes}`;

        if (timeEl.textContent !== timeStr) {
            timeEl.textContent = timeStr;
        }
    };

    updateClock();
    setInterval(updateClock, 1000);
}

// Ensure initSearchTips and initHeaderClock run on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initSearchTips();
        initHeaderClock();
    });
} else {
    initSearchTips();
    initHeaderClock();
}
// ── 全新自定义下拉框管理模块 ──
initCustomSelectManager(() => SETTINGS_UI_MAP, () => DEFAULT_SETTINGS);
