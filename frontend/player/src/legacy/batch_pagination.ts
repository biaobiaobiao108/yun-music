// Batch list operations retain their window API while using the TypeScript build.
// @ts-nocheck
const globalState = window as any;
// Batch Selection and Deletion Functions
import { getSongListManager } from '../player_services';
// Batch Selection and Deletion Functions
function ensureBatchSelectionState() {
    if (!(window.selectedItems instanceof Set)) window.selectedItems = new Set();
    if (!(window.selectedSongObjects instanceof Map)) window.selectedSongObjects = new Map();
}

function syncSelectionPresentation(root = document) {
    ensureBatchSelectionState();
    const rows = root.querySelectorAll('[role="button"][data-song-id]:not(.batch-checkbox)');

    rows.forEach(row => {
        if (!(row instanceof HTMLElement)) return;
        const id = String(row.dataset.songId || '');
        const isSelected = window.selectedItems.has(id);
        const isBatchMode = window.batchMode === true;
        const checkbox = row.querySelector('input.batch-checkbox');

        row.classList.toggle('row-selected', isSelected);
        row.classList.toggle('is-selected', isSelected);
        row.dataset.selected = String(isSelected);
        row.dataset.selectionState = isSelected ? 'selected' : 'unselected';

        if (isBatchMode && row.getAttribute('role') === 'button') {
            row.setAttribute('aria-pressed', String(isSelected));
        } else {
            row.removeAttribute('aria-pressed');
        }

        if (checkbox instanceof HTMLInputElement) {
            checkbox.checked = isSelected;
            checkbox.setAttribute('aria-checked', String(isSelected));
            if (isBatchMode && checkbox.getAttribute('aria-label')) {
                const songLabel = checkbox.getAttribute('aria-label').replace(/^(选择|取消选择)\s*/, '');
                const selectionLabel = `${isSelected ? '取消选择' : '选择'} ${songLabel}`;
                checkbox.setAttribute('aria-label', selectionLabel);
                row.setAttribute('aria-label', selectionLabel);
            }
        }
    });
}

export function handleBatchSelect(songId, isChecked) {
    ensureBatchSelectionState();
    const id = String(songId); // Force string ID
    if (isChecked) {
        window.selectedItems.add(id);
        // Cache song object if available in globalState.viewingPlaylist
        if (Array.isArray(window.viewingPlaylist)) {
            // Loose comparison just in case, though globalState.viewingPlaylist IDs should match render
            const song = window.viewingPlaylist.find(s => String(s.id) === id);
            if (song) window.selectedSongObjects.set(id, song);
        }
    } else {
        window.selectedItems.delete(id);
        window.selectedSongObjects.delete(id);
    }
    updateBatchToolbar();

    syncSelectionPresentation();
}

function refreshBatchUI() {
    // Check if song list detail is open
    const slDetail = document.getElementById('songlist-detail-view');
    const artistHeader = document.getElementById('artist-detail-header');
    if (slDetail && !slDetail.classList.contains('hidden')) {
        getSongListManager()?.renderDetail();
    } else if (artistHeader && !artistHeader.classList.contains('hidden')) {
        // Artist Detail Mode
        if (window.currentArtistSongsCache && typeof window.renderArtistSongsUI === 'function') {
            window.renderArtistSongsUI(window.currentArtistSongsCache);
        } else if (typeof window.loadArtistSongs === 'function' && window.currentArtistId) {
            window.loadArtistSongs(window.currentArtistId, window.currentArtistSource || 'wy', window.currentArtistOrder || 'hot');
        }
    } else {
        // Fallback to main renderResults (for search view)
        if (typeof window.renderResults === 'function' && window.viewingPlaylist) {
            window.renderResults(window.viewingPlaylist);
        }
    }
    syncSelectionPresentation();
}

function syncListHeaderBatchState() {
    const isPressed = window.batchMode === true;
    document.querySelectorAll('[data-list-action="batch"]').forEach(button => {
        button.setAttribute('aria-pressed', String(isPressed));
        button.classList.toggle('is-active', isPressed);
    });
}

function toggleBatchMode() {
    ensureBatchSelectionState();
    window.batchMode = !window.batchMode;
    window.selectedItems.clear();
    window.selectedSongObjects.clear();

    refreshBatchUI();

    updateBatchToolbar();

    const toolbar = document.getElementById('batch-toolbar');
    if (toolbar) {
        toolbar.classList.toggle('hidden', !window.batchMode);
    }

    const slToolbar = document.getElementById('sl-batch-toolbar');
    if (slToolbar) {
        slToolbar.classList.toggle('hidden', !window.batchMode);
    }

    syncListHeaderBatchState();
}

function selectAllVisible() {
    ensureBatchSelectionState();
    let listToSelect = [];
    if (window.ListSearch && window.ListSearch.state.active && window.ListSearch.state.onlyShowMatches) {
        listToSelect = window.ListSearch.getDisplayList(window.viewingPlaylist).map(obj => obj.item);
    } else {
        listToSelect = window.viewingPlaylist;
    }

    (Array.isArray(listToSelect) ? listToSelect : []).forEach(item => {
        const id = String(item?.id ?? '').trim();
        if (!id || id === 'undefined') return;
        window.selectedItems.add(id);
        window.selectedSongObjects.set(id, item);
    });

    refreshBatchUI();
    updateBatchToolbar();
}

function clearSelection() {
    ensureBatchSelectionState();
    window.selectedItems.clear();
    window.selectedSongObjects.clear();

    // updateBatchToolbar() 会被调用，这里也主动清零防遗漏
    const countEl = document.getElementById('batch-selected-count');
    const slCountEl = document.getElementById('sl-batch-selected-count');
    const lbCountEl = document.getElementById('lb-batch-selected-count');
    if (countEl) countEl.textContent = '0';
    if (slCountEl) slCountEl.textContent = '0';
    if (lbCountEl) lbCountEl.textContent = '0';

    // 重新渲染UI
    refreshBatchUI();
    if (window.LeaderboardManager && document.getElementById('view-leaderboard') && !document.getElementById('view-leaderboard').classList.contains('hidden')) {
        window.LeaderboardManager.renderSongs();
    }
    updateBatchToolbar();
    syncSelectionPresentation();
}

function exitBatchMode() {
    window.batchMode = false;
    clearSelection();

    const batchToolbar = document.getElementById('batch-toolbar');
    const slToolbar = document.getElementById('sl-batch-toolbar');
    const lbBatchToolbar = document.getElementById('lb-batch-toolbar');

    if (batchToolbar) batchToolbar.classList.add('hidden');
    if (slToolbar) slToolbar.classList.add('hidden');
    if (lbBatchToolbar) lbBatchToolbar.classList.add('hidden');

    // 恢复被隐藏的分页控件 (在排行榜中)
    const lbPagination = document.getElementById('lb-pagination');
    if (lbPagination) lbPagination.classList.remove('hidden');

    syncListHeaderBatchState();
}

function deselectAll() {
    clearSelection();
}

function updateBatchToolbar() {
    ensureBatchSelectionState();
    const size = window.selectedItems.size;

    // 搜索页计数
    const countEl = document.getElementById('batch-selected-count');
    if (countEl) countEl.textContent = size;

    // 歌单详情页计数
    const slCountEl = document.getElementById('sl-batch-selected-count');
    if (slCountEl) slCountEl.textContent = size;

    // 排行榜计数
    const lbCountEl = document.getElementById('lb-batch-selected-count');
    if (lbCountEl) lbCountEl.textContent = size;

    [countEl, slCountEl, lbCountEl].forEach(count => {
        const status = count?.closest('[data-batch-selection-status]');
        if (status) status.setAttribute('aria-label', `已选择 ${size} 首歌曲`);
    });

    const deleteBtn = document.getElementById('batch-delete-btn');
    if (deleteBtn) {
        // Hide delete button in network search mode
        if (window.currentSearchScope === 'network') {
            deleteBtn.classList.add('hidden');
        } else {
            deleteBtn.classList.remove('hidden');
        }
    }
}

async function batchDeleteFromList() {
    if (window.selectedItems.size === 0) {
        globalState.showError('请先选择要删除的歌曲');
        return;
    }

    if (!(await globalState.showSelect('批量删除', `确定要删除选中的 ${window.selectedItems.size} 首歌曲吗?`, { danger: true }))) {
        return;
    }

    // 公开列表删除需要管理员权限
    if (typeof globalState.requireAdminForOpenWrite === 'function') {
        if (!(await globalState.requireAdminForOpenWrite('删除公开列表中的歌曲'))) return;
    }

    // Get current list context
    const activeListId = getCurrentActiveListId();
    if (!activeListId || !globalState.currentListData) {
        globalState.showError('无法确定当前列表');
        return;
    }

    const idsToDelete = Array.from(window.selectedItems);
    let deleted = false;

    try {
        const res = await fetch('/api/music/user/list/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ listId: activeListId, songIds: idsToDelete })
        });
        if (!res.ok) throw new Error((await res.text()) || '删除失败');
        await globalState.refreshUserListData?.();
        globalState.handleListClick(activeListId);
        deleted = true;
    } catch (e) {
        globalState.showError('批量删除失败: ' + e.message);
        console.error('[Batch] 删除错误:', e);
    }

    // Clear selection only after the list was actually updated.
    if (deleted) exitBatchMode();
}

// Helper: Get current active list ID
function getCurrentActiveListId() {
    // From UI context or currentSearchScope
    if (window.currentSearchScope === 'local_list') {
        // Should track which list is being viewed
        return window.currentViewingListId || null;
    }
    return null;
}

function getEditableListContext() {
    const listId = getCurrentActiveListId();
    if (!listId || !globalState.currentListData) return null;
    const list = getListById(listId);
    if (!Array.isArray(list)) return null;
    return { listId, list };
}

// Helper: Get list by ID
function getListById(listId) {
    if (!globalState.currentListData) return null;
    if (listId === 'default') return globalState.currentListData.defaultList;
    if (listId === 'love') return globalState.currentListData.loveList;
    const userList = (globalState.currentListData.userList || []).find(l => String(l.id) === String(listId));
    return userList ? userList.list : null;
}

// Helper: Set list by ID
function setListById(listId, newList) {
    if (!globalState.currentListData) return;
    if (listId === 'default') globalState.currentListData.defaultList = newList;
    else if (listId === 'love') globalState.currentListData.loveList = newList;
    else {
        const userList = (globalState.currentListData.userList || []).find(l => String(l.id) === String(listId));
        if (userList) userList.list = newList;
    }
}

// Pagination Functions
function scrollToSearchResultsTop() {
    const container = document.getElementById('search-results');
    if (container) {
        container.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

// The search renderer owns the page state. Keep the legacy pagination actions
// on the same state bridge so local lists cannot render with a stale page.
function getCurrentPage() {
    const page = Number(globalState.currentPage);
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function setCurrentPage(page) {
    const nextPage = Number(page);
    const normalizedPage = Number.isFinite(nextPage) && nextPage > 0 ? Math.floor(nextPage) : 1;
    if (typeof globalState.setPlayerPage === 'function') {
        globalState.setPlayerPage(normalizedPage);
    } else {
        globalState.currentPage = normalizedPage;
    }
    return normalizedPage;
}

export function updatePaginationInfo(start, end, total, current, totalPages) {
    const currentPage = current || 1;
    const pageCount = totalPages || 1;
    const infoEl = document.getElementById('pagination-info');
    if (infoEl) {
        if (total === 0) {
            infoEl.textContent = '无结果';
        } else {
            // 显示 第 X / 共 Y 页 (Z 条)
            infoEl.textContent = `第 ${currentPage} / ${pageCount} 页 (${total} 条)`;
        }
    }

    // 更新跳转输入框的状态
    const jumpInput = document.getElementById('jump-page-input');
    if (jumpInput) {
        jumpInput.max = pageCount;
        // 只有当输入框未获得焦点时才强制更新值，避免干扰用户输入
        if (document.activeElement !== jumpInput) {
            jumpInput.value = currentPage;
        }
    }

    const prevButton = document.querySelector('#search-pagination-bar [data-event-click-action="prevPage"]');
    const nextButton = document.querySelector('#search-pagination-bar [data-event-click-action="nextPage"]');
    if (prevButton) {
        prevButton.disabled = currentPage <= 1;
        prevButton.setAttribute('aria-label', '上一页');
    }
    if (nextButton) {
        const hasLocalNextPage = currentPage < pageCount;
        const hasRemoteNextPage = window.currentSearchScope === 'network' && window.searchHasMore !== false;
        nextButton.disabled = !(hasLocalNextPage || hasRemoteNextPage);
        nextButton.setAttribute('aria-label', '下一页');
    }
}

function goToPage(page) {
    setCurrentPage(page);
    globalState.renderResults(window.viewingPlaylist);
    scrollToSearchResultsTop();
}

async function nextPage() {
    const totalItems = window.viewingPlaylist ? window.viewingPlaylist.length : 0;
    const itemsPerPage = globalState.settings.itemsPerPage === 'all' ? totalItems : parseInt(globalState.settings.itemsPerPage);
    const totalPages = Math.ceil((totalItems || 1) / (itemsPerPage || 1));
    const currentPage = getCurrentPage();

    if (currentPage < totalPages) {
        setCurrentPage(currentPage + 1);
        globalState.renderResults(window.viewingPlaylist);
        scrollToSearchResultsTop();
    } else if (window.currentSearchScope === 'network' && window.searchHasMore !== false) {
        const btn = document.querySelector('button[data-event-click-action="nextPage"]');
        const oldHtml = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
            btn.disabled = true;
        }

        try {
            // 翻页时也让列表回到顶端，虽然是追加模式，但因为是用户主动点击下一页，体感上是进入新内容
            scrollToSearchResultsTop();

            //翻页步长
            const FETCH_PAGES_STEP = 1;
            const nextNetPage = (window.currentNetworkPage || 1) + FETCH_PAGES_STEP;
            await window.doSearch(nextNetPage, true);
        } finally {
            if (btn) {
                btn.innerHTML = oldHtml;
            }
            const totalAfterLoad = window.viewingPlaylist ? window.viewingPlaylist.length : 0;
            const itemsPerPageAfterLoad = globalState.settings.itemsPerPage === 'all'
                ? totalAfterLoad
                : parseInt(globalState.settings.itemsPerPage);
            const totalPagesAfterLoad = Math.max(1, Math.ceil((totalAfterLoad || 1) / (itemsPerPageAfterLoad || 1)));
            updatePaginationInfo(0, 0, totalAfterLoad, getCurrentPage(), totalPagesAfterLoad);
        }
    }
}

function prevPage() {
    const currentPage = getCurrentPage();
    if (currentPage > 1) {
        setCurrentPage(currentPage - 1);
        globalState.renderResults(globalState.viewingPlaylist);
        scrollToSearchResultsTop();
    }
}

function jumpToPage() {
    const input = document.getElementById('jump-page-input');
    if (!input) return;
    let page = parseInt(input.value);

    const totalItems = window.viewingPlaylist ? window.viewingPlaylist.length : 0;
    const itemsPerPage = globalState.settings.itemsPerPage === 'all' ? totalItems : parseInt(globalState.settings.itemsPerPage);
    const totalPages = Math.ceil((totalItems || 1) / (itemsPerPage || 1));

    if (isNaN(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const currentPage = getCurrentPage();
    if (page !== currentPage) {
        setCurrentPage(page);
        globalState.renderResults(window.viewingPlaylist);
        scrollToSearchResultsTop();
    }
    input.value = page;
}

// Settings: Items Per Page
function changeItemsPerPage(value) {
    const val = value === 'all' ? 'all' : parseInt(value);
    if (typeof window.updateSetting === 'function') {
        window.updateSetting('itemsPerPage', val);
    } else {
        globalState.settings.itemsPerPage = val;
        localStorage.setItem('lx_settings', JSON.stringify(globalState.settings));
    }
    setCurrentPage(1); // Reset to first page
    if (window.ListSearch) {
        window.ListSearch.config.itemsPerPage = val === 'all' ? 999999 : val;
    }

    const activeView = (function () {
        if (document.getElementById('songlist-detail-view') && !document.getElementById('songlist-detail-view').classList.contains('hidden')) return 'collection';
        if (document.getElementById('view-leaderboard') && !document.getElementById('view-leaderboard').classList.contains('hidden')) return 'leaderboard';
        return 'search';
    })();

    if (activeView === 'leaderboard' && window.LeaderboardManager) {
        window.LeaderboardManager.resetLocalPage();
        window.LeaderboardManager.renderSongs();
    } else if (activeView === 'collection' && getSongListManager()) {
        getSongListManager()?.renderDetail();
    } else {
        globalState.renderResults(window.viewingPlaylist || globalState.viewingPlaylist);
    }
}

// Load globalState.settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('lx_settings');
    if (saved) {
        try {
            globalState.settings = JSON.parse(saved);
        } catch (e) {
            console.error('Failed to load globalState.settings:', e);
        }
    }
}


async function handleBatchCollect() {
    const selectedCount = window.selectedItems.size;
    if (selectedCount === 0) {
        if (typeof globalState.showInfo === 'function') globalState.showInfo('请先选择歌曲');
        else alert('请先选择歌曲');
        return;
    }

    const musicInfos = Array.from(window.selectedSongObjects.values());

    // 复用 app.js 中的歌单选择弹窗
    if (typeof globalState.openPlaylistAddModal === 'function') {
        globalState.openPlaylistAddModal(musicInfos);
    } else {
        globalState.showError('收藏组件未就绪');
    }
}

// Export functions to window
window.handleBatchSelect = handleBatchSelect;
window.toggleBatchMode = toggleBatchMode;
window.selectAllVisible = selectAllVisible;
window.clearSelection = clearSelection;
window.exitBatchMode = exitBatchMode;
window.deselectAll = deselectAll;
window.batchDeleteFromList = batchDeleteFromList;
window.getEditableListContext = getEditableListContext;
window.syncSelectionPresentation = syncSelectionPresentation;
window.handleBatchCollect = handleBatchCollect;
window.goToPage = goToPage;
window.nextPage = nextPage;
window.prevPage = prevPage;
window.jumpToPage = jumpToPage;
window.changeItemsPerPage = changeItemsPerPage;


globalState.getCurrentActiveListId = getCurrentActiveListId;
globalState.getListById = getListById;
globalState.setListById = setListById;
