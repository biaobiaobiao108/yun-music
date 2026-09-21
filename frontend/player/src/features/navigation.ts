/**
 * Navigation & Tab Switcher Module for 云音播放器
 */

import {
    runViewTransition,
    prefersReducedMotion,
    type ViewTransitionDirection,
} from './view_transitions';
import type { PlayerHistoryMode, PlayerHistoryPayload } from './player_history';

export const PLAYER_VIEW_ORDER = ['search', 'songlist', 'leaderboard', 'localmusic', 'favorites', 'settings', 'about'];
export const PLAYER_MAIN_VIEW_SELECTOR = '#view-search, #view-songlist, #view-leaderboard, #view-localmusic, #view-favorites, #view-settings, #view-about';
export const PLAYER_VIEW_MOTION_DURATION = 320;

export type NavigationOptions = {
    preserveSearchNavigation?: boolean;
    historyMode?: PlayerHistoryMode;
    direction?: ViewTransitionDirection;
};

export function prefersReducedPlayerMotion(): boolean {
    return prefersReducedMotion();
}

export function getPlayerViewDirection(tabId: string): ViewTransitionDirection {
    const currentView = Array.from(document.querySelectorAll<HTMLElement>(PLAYER_MAIN_VIEW_SELECTOR))
        .find(view => !view.classList.contains('hidden'));
    const currentTabId = currentView?.id.replace(/^view-/, '');
    const currentIndex = currentTabId ? PLAYER_VIEW_ORDER.indexOf(currentTabId) : -1;
    const targetIndex = PLAYER_VIEW_ORDER.indexOf(tabId);

    return targetIndex >= currentIndex ? 'forward' : 'backward';
}

export function updatePlayerViewVisibility(
    activeView: HTMLElement,
    direction: ViewTransitionDirection,
    fallbackMotion: boolean
): void {
    document.querySelectorAll<HTMLElement>(PLAYER_MAIN_VIEW_SELECTOR).forEach(view => {
        view.classList.remove('player-view-entering');
        if (view !== activeView) {
            view.classList.add('hidden', 'opacity-0');
            view.classList.remove('opacity-100');
        }
    });

    activeView.dataset.playerViewDirection = direction;
    activeView.classList.remove('hidden', 'opacity-0');
    activeView.classList.add('opacity-100');

    if (fallbackMotion && !prefersReducedPlayerMotion()) {
        activeView.classList.add('player-view-entering');
        window.setTimeout(() => {
            if (activeView.isConnected) activeView.classList.remove('player-view-entering');
        }, PLAYER_VIEW_MOTION_DURATION);
    }
}

export function transitionPlayerView(activeView: HTMLElement, direction: ViewTransitionDirection): void {
    runViewTransition(
        () => updatePlayerViewVisibility(activeView, direction, false),
        {
            types: [direction],
            fallback: () => updatePlayerViewVisibility(activeView, direction, true),
        }
    );
}

export type NavigationContext = {
    handleFavoritesClick: (historyMode?: PlayerHistoryMode, direction?: ViewTransitionDirection) => void;
    clearSearchNavigation: () => void;
    updateHistory?: (payload: PlayerHistoryPayload, mode: PlayerHistoryMode) => void;
    updateUserUI?: () => void;
    syncSettingsUI?: () => void;
    updateAdminUI?: () => void;
    setCurrentSearchScope: (scope: string) => void;
    exitListSecondaryModes: () => void;
    toggleSidebar: (forceState?: boolean) => void;
    initGlobalListSearch: () => void;
    showInitialSearchState: () => void;
    ensureSearchContent?: () => void;
    songListManager: { load: () => Promise<void> };
    ensureLeaderboardLoaded: () => Promise<void>;
    ensureLocalMusicLoaded: () => Promise<void>;
    showError: (msg: string) => void;
    loadAboutContent: () => void;
    toggleBatchMode?: () => void;
    clearPendingTimeouts?: () => void;
};

export function createTabSwitcher(context: NavigationContext) {
    return function switchTab(tabId: string, optionsOrPreserve: NavigationOptions | boolean = {}) {
        const options: NavigationOptions = typeof optionsOrPreserve === 'boolean'
            ? {
                preserveSearchNavigation: optionsOrPreserve,
                historyMode: optionsOrPreserve ? 'restore' : 'push',
            }
            : optionsOrPreserve;
        const preserveSearchNavigation = options.preserveSearchNavigation === true;
        const historyMode = options.historyMode ?? 'push';

        // Favorites is a sidebar group toggle, not a main content view.
        if (tabId === 'favorites') {
            context.handleFavoritesClick(historyMode, options.direction);
            return;
        }

        // 主页面切换时关闭搜索详情，避免隐藏页面继续持有 History 详情状态。
        // 路由恢复时保留当前 History 项，否则会把正在恢复的详情替换掉。
        if (!preserveSearchNavigation) context.clearSearchNavigation();

        const activeView = document.getElementById(`view-${tabId}`);
        if (!activeView) return;

        if (historyMode !== 'none' && historyMode !== 'restore') {
            context.updateHistory?.({ page: 'tab', tabId }, historyMode);
        }

        transitionPlayerView(activeView, options.direction ?? getPlayerViewDirection(tabId));
        if (!prefersReducedPlayerMotion()) {
            window.setTimeout(() => {
                if (!activeView.isConnected) return;
                if (typeof context.updateUserUI === 'function') context.updateUserUI();
            }, 10);
        } else {
            if (typeof context.updateUserUI === 'function') context.updateUserUI();
        }

        // 切换到设置页面时刷新一次管理员状态和设置项 UI
        if (tabId === 'settings') {
            if (typeof context.syncSettingsUI === 'function') context.syncSettingsUI();
            else if (typeof context.updateAdminUI === 'function') context.updateAdminUI();
        }

        // Reset Sidebar Highlight
        document.querySelectorAll('[id^="tab-"]').forEach(el => {
            el.classList.remove('active-tab', 'text-emerald-600');
            el.classList.add('t-text-muted');
        });
        // Reset Sidebar Sub-items Highlight (e.g. Favorite lists)
        document.querySelectorAll('[data-sidebar-list-id]').forEach(el => {
            el.classList.remove('active-sub-item');
            el.classList.add('t-text-muted');
        });
        const activeTab = document.getElementById(`tab-${tabId}`);
        if (activeTab) {
            activeTab.classList.add('active-tab');
            activeTab.classList.remove('t-text-muted');
        }

        // If leaving search/local-list view, update search scope away from local_list
        if (tabId !== 'search' && (window as any).currentSearchScope === 'local_list') {
            context.setCurrentSearchScope(tabId);
        }

        // Clear any pending timeouts
        if (typeof context.clearPendingTimeouts === 'function') {
            context.clearPendingTimeouts();
        }

        // Auto-exit secondary modes (search/batch) when switching tabs
        context.exitListSecondaryModes();

        // Mobile: Close sidebar when switching tabs except for favorites
        if (window.innerWidth <= 1024 && tabId !== 'favorites') {
            const sidebar = document.getElementById('main-sidebar');
            if (sidebar && !sidebar.classList.contains('-translate-x-full')) {
                context.toggleSidebar();
            }
        }

        // Always clear sub-item highlight when switching top-level tabs
        document.querySelectorAll('[data-sidebar-list-id]').forEach(el => {
            el.classList.remove('active-sub-item');
            el.classList.add('t-text-muted');
        });

        // Reset Search Scope if switching to search explicitly
        if (tabId === 'search') {
            context.initGlobalListSearch();
            context.setCurrentSearchScope('network');
            document.getElementById('search-source')?.classList.remove('hidden');
            document.getElementById('search-type')?.classList.remove('hidden');
            const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
            if (searchInput) {
                searchInput.placeholder = "搜索歌曲、歌手...";
                if (!searchInput.value.trim()) {
                    context.showInitialSearchState();
                } else if (!preserveSearchNavigation) {
                    context.ensureSearchContent?.();
                }
            }
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.innerText = "搜索音乐";
        }

        if (tabId === 'songlist') {
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.innerText = "歌单";
            void context.songListManager.load().catch(err => {
                console.error('[SongList] 初始加载失败:', err);
            });
        }

        if (tabId === 'leaderboard') {
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.innerText = "排行榜";
            const lm = (window as any).LeaderboardManager;
            if (lm && !lm.initialized) {
                lm.init();
            } else if (!lm) {
                context.ensureLeaderboardLoaded().then(() => {
                    const loadedLm = (window as any).LeaderboardManager;
                    if (loadedLm && !loadedLm.initialized) loadedLm.init();
                }).catch(() => context.showError('排行榜模块加载失败，请稍后重试'));
            }
        }

        if (tabId === 'localmusic') {
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.innerText = "本地音乐";
            const lmm = (window as any).LocalMusicManager;
            if (lmm) {
                lmm.init();
            } else {
                context.ensureLocalMusicLoaded().then(() => (window as any).LocalMusicManager?.init()).catch(() => {
                    context.showError('本地音乐模块加载失败，请稍后重试');
                });
            }
        }

        // Collapse Favorites if leaving
        if (tabId !== 'favorites') {
            const favList = document.getElementById('favorites-children');
            const arrow = document.getElementById('favorites-arrow');
            if (favList && favList.style.height !== '0px') {
                favList.style.height = '0px';
                if (arrow) arrow.style.transform = 'rotate(-90deg)';
            }
        }

        if (tabId === 'settings') {
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.innerText = '设置';
        }

        if (tabId === 'about') {
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.innerText = '关于';
            context.loadAboutContent();
        }

        if ((window as any).batchMode && typeof context.toggleBatchMode === 'function') {
            context.toggleBatchMode();
        }
    };
}
