// @ts-nocheck
// This legacy-compatible module is compiled as an isolated browser bundle.
import { escapeHtmlText, safeImageUrl, safeInlineJson, safeInlineString } from '../player_security';
import { toUserMessage } from '../player_notifications';
/**
 * Leaderboard Manager for 云音
 * 排行榜功能模块 — 风格与 SongListManager 保持一致
 */

window.LeaderboardManager = (function () {
    const API_BASE = '/api/music/leaderboard';

    let state = {
        source: 'wy',
        boards: [],          // 当前来源的榜单列表
        currentBangid: null, // 当前选中榜单 bangid
        currentBoardName: '',
        songs: [],           // 当前榜单歌曲列表
        page: 1,             // 后端页码
        localPage: 1,        // 前端渲染页码
        total: 0,
        limit: 100,          // 后端一页加载数量限制
        loading: false,
        pageTransitioning: false,
    };

    let initialized = false;
    let boardsRequestController = null;
    let songsRequestController = null;
    let boardsRequestSerial = 0;
    let songsRequestSerial = 0;

    function clearSongBatchSelection() {
        if (typeof window.resetSharedBatchSelection === 'function') {
            window.resetSharedBatchSelection();
            return;
        }
        window.selectedItems?.clear();
        window.selectedSongObjects?.clear();
        const count = document.getElementById('lb-batch-selected-count');
        if (count) count.textContent = '0';
    }

    // ==================== 初始化 ====================

    function init() {
        if (initialized) return;
        initialized = true;

        // 优先从缓存读取
        const cachedSource = localStorage.getItem('lb-source-select');
        state.source = cachedSource || 'wy';

        // 同步 source select 的值
        const sel = document.getElementById('lb-source-select');
        if (sel) sel.value = state.source;
        loadBoards(state.source);
    }

    // ==================== 数据加载 ====================

    async function loadBoards(source) {
        boardsRequestController?.abort();
        songsRequestController?.abort();
        const requestSerial = ++boardsRequestSerial;
        boardsRequestController = new AbortController();
        state.source = source;
        state.boards = [];
        state.currentBangid = null;
        state.songs = [];
        state.localPage = 1;
        renderBoards([]);
        renderSongs([]);
        showBoardsLoading(true);

        try {
            const res = await fetch(`${API_BASE}/boards?source=${encodeURIComponent(source)}`, { signal: boardsRequestController.signal });
            const data = await res.json();
            if (requestSerial !== boardsRequestSerial || state.source !== source) return;
            if (data.error) throw new Error(data.error);
            state.boards = data.list || [];
            renderBoards(state.boards);
            // 自动选中第一个榜单
            if (state.boards.length > 0) {
                selectBoard(state.boards[0].bangid, state.boards[0].name);
            }
        } catch (e) {
            if (e?.name === 'AbortError' || requestSerial !== boardsRequestSerial) return;
            console.error('[Leaderboard] loadBoards failed:', e);
            document.getElementById('lb-boards-list').innerHTML =
                `<div class="p-4 text-red-500 text-sm">加载失败: ${escapeHtmlText(toUserMessage(e))}</div>`;
        } finally {
            if (requestSerial === boardsRequestSerial) showBoardsLoading(false);
        }
    }

    async function loadSongs(bangid, source, page = 1) {
        songsRequestController?.abort();
        const requestSerial = ++songsRequestSerial;
        songsRequestController = new AbortController();
        state.loading = true;
        state.page = page;

        if (requestSerial !== songsRequestSerial || state.currentBangid !== bangid || state.source !== source) return;

        const container = document.getElementById('lb-songs-list');
        if (page === 1) {
            state.localPage = 1;
            container.innerHTML = `
                <div class="flex items-center justify-center py-20">
                    <i class="fas fa-spinner fa-spin text-4xl text-emerald-500"></i>
                </div>`;
        }

        try {
            const url = `${API_BASE}/list?source=${encodeURIComponent(source)}&bangid=${encodeURIComponent(bangid)}&page=${page}`;
            const res = await fetch(url, { signal: songsRequestController.signal });
            const data = await res.json();
            if (requestSerial !== songsRequestSerial || state.currentBangid !== bangid || state.source !== source) return;
            if (data.error) throw new Error(data.error);

            if (page === 1) {
                state.songs = (data.list || []).map((song, idx) => {
                    if (!song.id || song.id === 'undefined') {
                        song.id = song.songmid || song.songId || song.hash || song.copyrightId || song.mid || `lb_${bangid}_${idx}`;
                    }
                    return song;
                });
            } else {
                const newSongs = (data.list || []).map((song, idx) => {
                    if (!song.id || song.id === 'undefined') {
                        song.id = song.songmid || song.songId || song.hash || song.copyrightId || song.mid || `lb_${bangid}_${state.songs.length + idx}`;
                    }
                    return song;
                });
                state.songs = [...state.songs, ...newSongs];
            }

            state.total = data.total || state.songs.length;
            state.limit = data.limit || 100;

            // 同步 viewingPlaylist 供批量操作全局函数使用
            window.viewingPlaylist = state.songs;

            // 初始化/复位搜索
            if (page === 1 && window.ListSearch) {
                window.ListSearch.init('leaderboard', {
                    renderCallback: () => {
                        renderSongs(state.songs);
                        renderPagination();
                    },
                    getCurrentPage: () => state.localPage,
                    paginationCallback: (targetPage, targetSongIndex) => {
                        state.localPage = targetPage;
                        renderSongs(state.songs);
                        renderPagination();
                        setTimeout(() => {
                            if (window.ListSearch) window.ListSearch.scrollToMatch(targetSongIndex);
                        }, 50);
                    },
                    getList: () => state.songs
                });
            }

            renderSongs(state.songs);
            renderPagination();
        } catch (e) {
            if (e?.name === 'AbortError' || requestSerial !== songsRequestSerial) return;
            console.error('[Leaderboard] loadSongs failed:', e);
            container.innerHTML = `<div class="text-center text-red-500 p-10">加载失败: ${escapeHtmlText(toUserMessage(e))}</div>`;
        } finally {
            if (requestSerial === songsRequestSerial) state.loading = false;
        }
    }

    // ==================== 渲染 ====================

    function renderBoards(boards) {
        const container = document.getElementById('lb-boards-list');
        if (!container) return;
        if (!boards || boards.length === 0) {
            container.innerHTML = '<div class="p-4 text-center t-text-muted text-sm">暂无榜单</div>';
            return;
        }

        container.innerHTML = boards.map((board, i) => {
            const boardId = escapeHtmlText(String(board.bangid ?? ''));
            const boardName = escapeHtmlText(board.name || '未命名榜单');
            return `
            <div id="lb-board-${boardId}"
                data-event-click-action="window.LeaderboardManager.selectBoard" data-event-click-args="[${safeInlineString(board.bangid)}, ${safeInlineString(board.name)}]"
                class="lb-board-item player-motion-item flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 group ${state.currentBangid == board.bangid ? 'active-option' : 'hover:t-bg-panel t-text-muted'}" style="--player-motion-index: ${Math.min(i, 7)};">
                <span class="text-xs font-mono w-5 text-center flex-shrink-0 ${i < 3 ? 'text-emerald-600 dark:text-emerald-500 font-bold' : 't-text-muted'}">${i + 1}</span>
                <span class="text-sm font-medium truncate flex-1 ${state.currentBangid == board.bangid ? '' : 't-text-main group-hover:t-text-main'}">${boardName}</span>
                <i class="fas fa-chevron-right text-[10px] t-text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"></i>
            </div>
        `;
        }).join('');
    }

    function renderSongs(songs, direction = '') {
        const container = document.getElementById('lb-songs-list');
        if (!container) return;
        if (direction) {
            container.dataset.pageDirection = direction > 0 ? 'next' : 'prev';
            container.classList.remove('leaderboard-page-changing');
            void container.offsetWidth;
            container.classList.add('leaderboard-page-changing');
            window.setTimeout(() => container.classList.remove('leaderboard-page-changing'), 360);
            document.querySelectorAll('#lb-btn-prev, #lb-btn-next').forEach(button => {
                button.classList.add('is-page-changing');
                window.setTimeout(() => button.classList.remove('is-page-changing'), 220);
            });
        }

        if (!songs || songs.length === 0) {
            container.innerHTML = state.currentBangid
                ? '<div class="flex items-center justify-center py-20 t-text-muted"><i class="fas fa-music text-4xl mb-3 opacity-30"></i><p class="mt-3">暂无歌曲</p></div>'
                : '<div class="flex items-center justify-center py-20 t-text-muted"><i class="fas fa-chart-bar text-4xl mb-3 opacity-30"></i><p class="mt-3">请从左侧选择一个榜单</p></div>';
            return;
        }

        const displayList = window.ListSearch && window.ListSearch.state && window.ListSearch.state.active && window.ListSearch.state.id === 'leaderboard'
            ? window.ListSearch.getDisplayList(songs)
            : songs.map((item, idx) => ({ item, originalIndex: idx }));

        const itemsPerPage = typeof settings !== 'undefined' ? (settings.itemsPerPage === 'all' ? displayList.length : parseInt(settings.itemsPerPage)) : 20;
        const totalItems = displayList.length;
        const totalPages = Math.ceil(totalItems / (itemsPerPage || 20)) || 1;

        if (state.localPage > totalPages) state.localPage = totalPages || 1;
        if (state.localPage < 1) state.localPage = 1;

        const startIndex = (state.localPage - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
        const pageList = displayList.slice(startIndex, endIndex);

        container.innerHTML = pageList.map(({ item: song, originalIndex: index }, pageIndex) => {
            const isSelected = window.selectedItems && window.selectedItems.has(String(song.id));
            const isMatched = window.ListSearch && window.ListSearch.isMatched(index);
            const isCurrentMatch = window.ListSearch && window.ListSearch.isCurrentMatch(index);

            let rowClass = 'player-track-grid player-track-grid--network player-motion-item p-3 rounded-xl hover:t-bg-panel group transition-colors cursor-pointer ';
            if (isCurrentMatch) rowClass += 'search-current ';
            else if (isMatched) rowClass += 'search-match ';
            if (isSelected) rowClass += 'row-selected ring-1 ring-emerald-500/30 ';
            if (pageIndex > 12) rowClass += 'deferred-list-item ';

            const selectionLabel = isSelected ? '取消选择' : '选择';
            const selectionAttributes = window.batchMode
                ? `aria-pressed="${isSelected}"`
                : '';

            const rank = index + 1;
            const rankClass = rank <= 3 ? 'text-emerald-600 dark:text-emerald-500 font-black text-base' : 'text-gray-400 font-mono text-xs';

            const songName = String(song.name || '未命名歌曲');
            const singerName = String(song.singer || '--');
            const albumName = String(song.albumName || '--');
            const interval = String(song.interval || '--:--');
            const safeSongName = escapeHtmlText(songName);
            const safeSingerName = escapeHtmlText(singerName);
            const safeAlbumName = escapeHtmlText(albumName);
            const safeInterval = escapeHtmlText(interval);
            const safeSongId = escapeHtmlText(String(song.id ?? ''));
            const safeAriaLabel = escapeHtmlText(window.batchMode
                ? `${selectionLabel} ${songName}`
                : `播放 ${songName}`);
            const imgUrl = escapeHtmlText(safeImageUrl(window.getImgUrl ? window.getImgUrl(song) : (song.img || song.albumImg)));

            return `
            <div id="lb-row-${index}" role="button" tabindex="0" aria-label="${safeAriaLabel}" ${selectionAttributes}
                 data-selection-state="${isSelected ? 'selected' : 'unselected'}" class="${rowClass}" style="--player-motion-index: ${Math.min(pageIndex, 7)};" data-song-id="${safeSongId}"
                 data-event-click-action="window.LeaderboardManager.handleRowClick" data-event-click-args="[${index}]"
                 data-event-keydown-action="window.LeaderboardManager.handleRowClick" data-event-keydown-args="[${index}]" data-event-keys="Enter, " data-event-target-self="true" data-event-prevent="true">
                <!-- 序号 -->
                <div class="player-track-index text-center flex items-center justify-center">
                    <span class="${rankClass}">${rank}</span>
                </div>
                <!-- 封面 + 歌名 -->
                <div class="player-track-title flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 md:w-12 md:h-12 flex-shrink-0 relative rounded-lg overflow-hidden shadow-sm border t-border-main group-hover:shadow-md transition-all group-hover:scale-105 duration-300">
                        <img data-src="${imgUrl}" src="/music/assets/yun-yin.png" alt="${safeSongName || '歌曲'}专辑封面" width="48" height="48" loading="lazy" decoding="async"
                             class="lazy-image w-full h-full object-cover dynamic-logo is-placeholder"
                             data-event-error-action="fallback-image">
                        <div class="absolute inset-0 bg-black/20 hidden group-hover:flex items-center justify-center transition-all">
                            <i class="fas fa-play text-white text-xs"></i>
                        </div>
                    </div>
                    <div class="min-w-0 flex-1 flex flex-col justify-center overflow-hidden">
                        <div class="font-bold text-sm t-text-main group-hover:text-emerald-500 transition-colors">
                            ${window.createMarqueeHtml ? window.createMarqueeHtml(songName) : `<span class="truncate">${safeSongName}</span>`}
                        </div>
                        <div class="flex items-center gap-1 mt-0.5 overflow-hidden">
                            ${window.getSourceTag ? window.getSourceTag(song.source || state.source) : ''}
                            ${window.getQualityTags ? window.getQualityTags(song) : ''}
                            <div class="player-track-compact-meta flex-1 min-w-0">
                                ${window.createMarqueeHtml ? window.createMarqueeHtml(singerName, 'text-[10px] t-text-muted') : `<span class="text-[10px] t-text-muted truncate">${safeSingerName}</span>`}
                            </div>
                        </div>
                    </div>
                </div>
                <!-- 歌手 -->
                <div class="player-track-artist items-center text-xs t-text-muted overflow-hidden">
                    ${window.createMarqueeHtml ? window.createMarqueeHtml(singerName) : `<span class="truncate">${safeSingerName}</span>`}
                </div>
                <!-- 专辑 -->
                <div class="player-track-album items-center text-xs t-text-muted truncate">
                    ${safeAlbumName}
                </div>
                <!-- 时长 -->
                <div class="player-track-duration items-center justify-end text-xs font-mono t-text-muted">
                    ${safeInterval}
                </div>
                <!-- 操作 -->
                <div class="player-track-actions flex items-center justify-end gap-1 opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                    <button class="p-1.5 hover:bg-emerald-50 rounded-lg text-emerald-600 transition-colors"
                            title="播放"
                            data-event-click-action="window.LeaderboardManager.playSong" data-event-click-args="[${index}]" data-event-stop="true">
                        <i class="fas fa-play w-3.5 h-3.5"></i>
                    </button>
                    <button class="p-1.5 hover:bg-blue-50 rounded-lg text-blue-600 transition-colors"
                            title="下载"
                            data-event-click-action="downloadSong" data-event-click-args="[${safeInlineJson(song)}]" data-event-stop="true">
                        <i class="fas fa-download w-3.5 h-3.5"></i>
                    </button>
                </div>
            </div>
            `;
        }).join('');

        if (typeof window.lazyLoadImages === 'function') window.lazyLoadImages();
        if (typeof window.applyMarqueeChecks === 'function') window.applyMarqueeChecks();
    }

    function renderPagination() {
        const prevBtn = document.getElementById('lb-btn-prev');
        const nextBtn = document.getElementById('lb-btn-next');
        const info = document.getElementById('lb-page-info');

        const displayList = window.ListSearch && window.ListSearch.state && window.ListSearch.state.active && window.ListSearch.state.id === 'leaderboard'
            ? window.ListSearch.getDisplayList(state.songs)
            : state.songs.map((item, idx) => ({ item, originalIndex: idx }));

        const itemsPerPage = typeof settings !== 'undefined' ? (settings.itemsPerPage === 'all' ? displayList.length : parseInt(settings.itemsPerPage)) : 20;
        const totalItems = displayList.length;
        const totalPages = Math.ceil(totalItems / (itemsPerPage || 20)) || 1;

        if (prevBtn) prevBtn.disabled = state.localPage <= 1;
        if (nextBtn) {
            // 当本地页数超出，且已经无法再次从后端拿到新数据时，才禁用“下一页”
            const canLoadMore = state.songs.length >= state.limit * state.page;
            nextBtn.disabled = state.localPage >= totalPages && !canLoadMore;
        }
        if (info) info.innerText = `第 ${state.localPage} 页 / 共 ${totalPages} 页`;
    }

    function showBoardsLoading(show) {
        const el = document.getElementById('lb-boards-loading');
        if (el) el.classList.toggle('hidden', !show);
    }

    function updateBoardActiveState(bangid) {
        document.querySelectorAll('.lb-board-item').forEach(el => {
            el.classList.remove('active-option');
            el.classList.add('hover:t-bg-panel', 't-text-muted');
        });
        const target = document.getElementById(`lb-board-${bangid}`);
        if (target) {
            target.classList.add('active-option');
            target.classList.remove('hover:t-bg-panel', 't-text-muted');
        }
    }

    function updateBoardTitle(name) {
        const el = document.getElementById('lb-board-title');
        if (el) el.innerText = name || '';
        const countEl = document.getElementById('lb-song-count');
        if (countEl) countEl.innerText = '';
    }

    function updateSongCountAfterLoad() {
        const countEl = document.getElementById('lb-song-count');
        if (countEl) countEl.innerText = `· ${state.songs.length} 首`;
    }

    // ==================== 提取的核心方法 ====================

    function selectBoard(bangid, name) {
        clearSongBatchSelection();
        state.currentBangid = bangid;
        state.currentBoardName = name;
        state.page = 1;
        state.localPage = 1;
        state.songs = [];
        updateBoardActiveState(bangid);
        updateBoardTitle(name);
        if (window.ListSearch) window.ListSearch.resetState();
        loadSongs(bangid, state.source, 1).then(() => updateSongCountAfterLoad());
    }

    function playSong(index) {
        const displayList = window.ListSearch && window.ListSearch.state && window.ListSearch.state.active && window.ListSearch.state.id === 'leaderboard'
            ? window.ListSearch.getDisplayList(state.songs).map(item => item.item)
            : state.songs;

        const displayIndex = window.ListSearch && window.ListSearch.state && window.ListSearch.state.active && window.ListSearch.state.id === 'leaderboard'
            ? window.ListSearch.getDisplayList(state.songs).findIndex(item => item.originalIndex === index)
            : index;
        if (displayIndex < 0) return;
        const song = displayList[displayIndex];
        if (!song) return;

        if (typeof window.updatePlaylist === 'function') {
            const listWithSource = displayList.map(s => ({ ...s, source: s.source || state.source }));
            window.updatePlaylist(listWithSource, displayIndex, 'leaderboard', true);
        }
    }

    function playAll() {
        if (state.songs.length === 0) return;
        if (typeof window.updatePlaylist === 'function') {
            const listWithSource = state.songs.map(s => ({ ...s, source: s.source || state.source }));
            window.updatePlaylist(listWithSource, 0, 'leaderboard', false);
        }
    }

    function changePage(delta) {
        if (state.loading || state.pageTransitioning || !delta) return;

        const displayList = window.ListSearch && window.ListSearch.state && window.ListSearch.state.active && window.ListSearch.state.id === 'leaderboard'
            ? window.ListSearch.getDisplayList(state.songs)
            : state.songs.map((item, idx) => ({ item, originalIndex: idx }));

        const itemsPerPage = typeof settings !== 'undefined' ? (settings.itemsPerPage === 'all' ? displayList.length : parseInt(settings.itemsPerPage)) : 20;
        const totalItems = displayList.length;
        const totalPages = Math.ceil(totalItems / (itemsPerPage || 20)) || 1;

        const nextLocal = state.localPage + delta;

        const canChangeLocal = nextLocal >= 1 && nextLocal <= totalPages;
        const canLoadMore = delta > 0 && nextLocal > totalPages && state.songs.length >= state.limit * state.page;
        if (!canChangeLocal && !canLoadMore) return;
        state.pageTransitioning = true;

        if (delta > 0 && nextLocal > totalPages) {
            // 需要向后端加载更多
            if (canLoadMore) {
                loadSongs(state.currentBangid, state.source, state.page + 1).then(() => {
                    state.localPage++; // 加载完后，本地页码加1
                    renderSongs(state.songs, delta); // 刷新视图
                    renderPagination();       // 刷新底部页码标示
                    updateSongCountAfterLoad();
                    document.getElementById('lb-songs-container') && document.getElementById('lb-songs-container').scrollTo({ top: 0, behavior: 'smooth' });
                }).finally(() => window.setTimeout(() => { state.pageTransitioning = false; }, 360));
            }
        } else if (nextLocal >= 1 && nextLocal <= totalPages) {
            // 本地直接翻页面
            state.localPage = nextLocal;
            renderSongs(state.songs, delta);
            renderPagination();
            document.getElementById('lb-songs-container') && document.getElementById('lb-songs-container').scrollTo({ top: 0, behavior: 'smooth' });
            window.setTimeout(() => { state.pageTransitioning = false; }, 360);
        }
    }

    function changeSource() {
        const sel = document.getElementById('lb-source-select');
        if (!sel) return;
        clearSongBatchSelection();
        state.source = sel.value;

        // 保存到缓存
        localStorage.setItem('lb-source-select', state.source);

        state.currentBangid = null;
        state.currentBoardName = '';
        state.songs = [];
        state.page = 1;
        updateBoardTitle('');
        loadBoards(state.source);
    }

    function handleRowClick(index) {
        if (window.batchMode) {
            const song = state.songs[index];
            if (!song) return;
            const id = String(song.id);
            const isChecked = !window.selectedItems.has(id);
            window.handleBatchSelect(id, isChecked);
        } else {
            playSong(index);
        }
    }


    // ==================== 公共方法 ====================

    return {
        get initialized() { return initialized; },

        init,
        changeSource,
        selectBoard,
        playSong,
        playAll,
        changePage,
        handleRowClick,

        renderSongs: function () {
            renderSongs(state.songs);
            renderPagination();
        },

        resetLocalPage: function () {
            state.localPage = 1;
        },

        getCurrentList: function () {
            return state.songs;
        },

        getCurrentSource: function () {
            return state.source;
        },
    };
})();

// ==================== 全局代理 ====================
function changeLeaderboardSource() { window.LeaderboardManager.changeSource(); }
function leaderboardChangePage(delta) { window.LeaderboardManager.changePage(delta); }
function playAllLeaderboard() { window.LeaderboardManager.playAll(); }

// ==================== 排行榜批量操作与搜索 ====================
function toggleLbBatchMode() {
    window.batchMode = !window.batchMode;
    // A leaderboard is a new song-list context. Never carry stale songs or
    // cached song objects from search/favorites into its batch actions.
    if (typeof window.resetSharedBatchSelection === 'function') {
        window.resetSharedBatchSelection();
    } else {
        window.selectedItems.clear();
        window.selectedSongObjects?.clear();
    }
    const toolbar = document.getElementById('lb-batch-toolbar');

    // 隐藏其他干扰元素
    const prevNextBtn = document.getElementById('lb-pagination');

    if (window.batchMode) {
        toolbar.classList.remove('hidden');
        if (prevNextBtn) prevNextBtn.classList.add('hidden');
    } else {
        toolbar.classList.add('hidden');
        if (prevNextBtn) prevNextBtn.classList.remove('hidden');
        document.getElementById('lb-batch-selected-count').innerText = '0';
    }
    window.LeaderboardManager.renderSongs();
}

function lbSelectAll() {
    if (!window.batchMode || !window.LeaderboardManager) return;

    const allSongs = window.LeaderboardManager.getCurrentList();
    if (!allSongs || allSongs.length === 0) return;

    // --- 逻辑对齐：当开启“仅显示匹配项”过滤时，全选应仅针对匹配项 ---
    let songsToOperate = allSongs;
    if (window.ListSearch && window.ListSearch.state.active &&
        window.ListSearch.state.id === 'leaderboard' && window.ListSearch.state.onlyShowMatches) {
        songsToOperate = window.ListSearch.getDisplayList(allSongs).map(obj => obj.item);
    }

    let isAllSelected = true;
    for (const song of songsToOperate) {
        if (!window.selectedItems.has(String(song.id))) {
            isAllSelected = false;
            break;
        }
    }

    if (isAllSelected) {
        songsToOperate.forEach(song => window.handleBatchSelect(String(song.id), false));
    } else {
        songsToOperate.forEach(song => window.handleBatchSelect(String(song.id), true));
    }
}

function lbToggleListSearch() {
    if (window.ListSearch) {
        window.ListSearch.toggleBar();
    }
}

// ==================== 暴露给 HTML 事件代理 ====================
Object.assign(window, {
    changeLeaderboardSource,
    leaderboardChangePage,
    playAllLeaderboard,
    toggleLbBatchMode,
    lbSelectAll,
    lbToggleListSearch,
});

// ==================== 手机端侧边栏切换 ====================
function toggleLbSidebar(force) {
    const sidebar = document.getElementById('lb-sidebar');
    const overlay = document.getElementById('lb-sidebar-overlay');
    if (!sidebar || !overlay) return;

    const isHidden = sidebar.classList.contains('-translate-x-full');
    const show = force !== undefined ? force : isHidden;

    if (show) {
        sidebar.classList.remove('-translate-x-full');
        overlay.classList.remove('hidden');
        setTimeout(() => {
            overlay.classList.add('opacity-100');
        }, 10);
    } else {
        sidebar.classList.add('-translate-x-full');
        overlay.classList.remove('opacity-100');
        setTimeout(() => {
            overlay.classList.add('hidden');
        }, 300);
    }
}
window.toggleLbSidebar = toggleLbSidebar;
