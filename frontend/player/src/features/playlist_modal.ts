export interface PlaylistModalFeatureContext {
    getCurrentPlayingSong: () => any | null;
    getCurrentListData: () => any;
    isUserLoggedIn: () => boolean;
    requireAdminForOpenWrite: (action: string) => Promise<boolean>;
    renderMyLists: (data: any) => void;
    isCurrentlyViewingLocalList: (listId?: string) => boolean;
    handleListClick: (listId: string, skipAutoUpdate?: boolean) => void;
    pushDataChange: (data: any) => Promise<void>;
    refreshUserListData: () => Promise<void>;
    exitBatchMode?: () => void;
    deselectAll?: () => void;
    getUserAuthHeaders: () => Record<string, string>;
    showError: (message: string) => void;
    showInfo: (message: string) => void;
    showSuccess: (message: string) => void;
    handleCreateList: () => void;
    updatePlayerInfo: (song: any, quality?: any) => void;
}

export function initPlaylistModalFeature(context: PlaylistModalFeatureContext) {
    const isUserLoggedIn = context.isUserLoggedIn;
    const requireAdminForOpenWrite = context.requireAdminForOpenWrite;
    const renderMyLists = context.renderMyLists;
    const isCurrentlyViewingLocalList = context.isCurrentlyViewingLocalList;
    const handleListClick = context.handleListClick;
    const pushDataChange = context.pushDataChange;
    const refreshUserListData = context.refreshUserListData;
    const exitBatchMode = context.exitBatchMode;
    const deselectAll = context.deselectAll;
    const getUserAuthHeaders = context.getUserAuthHeaders;
    const showError = context.showError;
    const showInfo = context.showInfo;
    const showSuccess = context.showSuccess;
    const handleCreateList = context.handleCreateList;
    const updatePlayerInfo = context.updatePlayerInfo;

// Helper to render the grid (can be called from anywhere)
function renderPlaylistAddGrid() {
    const isBatch = !!window.batchCollectSongs;
    const songs = isBatch ? window.batchCollectSongs : [context.getCurrentPlayingSong()];
    const firstSong = songs[0];
    if (!firstSong) return;

    const listContainer = document.getElementById('playlist-add-list');
    if (!listContainer) return;

    // Single song mode: calculate inclusion status
    let targetId = null;
    if (!isBatch) {
        const cleanedSong = cleanSongData(firstSong);
        targetId = cleanedSong.id;
    }

    listContainer.innerHTML = '';

    // Helper to create grid item
    const createGridItem = (listId, listName, count, isIncluded) => {
        const btn = document.createElement('button');
        // Base styles
        let className = "relative h-14 rounded-lg text-sm font-bold transition-all duration-200 flex items-center justify-center gap-1 shadow-sm overflow-hidden ";

        // Active/Inactive styles (Highlight only in single-song mode)
        if (!isBatch && isIncluded) {
            className += "bg-emerald-500 text-white shadow-md scale-[1.02] ring-2 ring-emerald-200";
        } else {
            className += "bg-emerald-50 text-emerald-500 hover:bg-emerald-100 hover:shadow";
        }

        btn.className = className;
        btn.onclick = () => handleTogglePlaylist(listId, btn); // Use handler wrapper

        btn.innerHTML = `
            <span class="truncate max-w-[80%]">${listName}</span>
            ${(!isBatch && isIncluded) ? '<i class="fas fa-check text-xs ml-1 opacity-80"></i>' : ''}
        `;
        return btn;
    };

    const activeListData = isUserLoggedIn() ? (window.myPersonalListData || context.getCurrentListData()) : context.getCurrentListData();

    // 1. My Love
    const loveList = activeListData.loveList || [];
    const isLoved = !isBatch && targetId && loveList.some(s => s.id === targetId);
    listContainer.appendChild(createGridItem('love', '我的收藏', loveList.length, isLoved));

    // 2. User Lists
    if (activeListData.userList) {
        activeListData.userList.forEach(list => {
            const isIncluded = !isBatch && targetId && list.list.some(s => s.id === targetId);
            listContainer.appendChild(createGridItem(list.id, list.name, list.list.length, isIncluded));
        });
    }

    // 3. Create New List Dash Box
    const createNewBtn = document.createElement('button');
    createNewBtn.className = "h-14 rounded-lg text-xs font-bold border-2 border-dashed border-gray-300 dark:border-gray-600 text-gray-500 hover:text-emerald-500 hover:border-emerald-400 transition-all flex items-center justify-center gap-2 t-bg-main/20 hover:t-bg-main/50 shadow-sm";
    createNewBtn.innerHTML = `
        <i class="fas fa-plus"></i> 新建歌单
    `;
    createNewBtn.onclick = () => {
        handleCreateList();
    };
    listContainer.appendChild(createNewBtn);
}

async function openPlaylistAddModal(batchSongs = null) {
    if (!context.getCurrentListData()) {
        showError('请先登录后使用收藏功能');
        return;
    }

    // 本地歌曲必须先关联真实平台 ID，避免把文件名回退 ID 同步到其他客户端。
    const isUnboundLocalSong = (song) => {
        if (!song?.isLocal && !song?._localLibraryItem) return false;
        return !window.LocalMusicManager?.isPlaylistCollectable(song);
    };

    if (Array.isArray(batchSongs)) {
        const collectableSongs = batchSongs.filter(song => !isUnboundLocalSong(song));
        const unavailableCount = batchSongs.length - collectableSongs.length;
        if (collectableSongs.length === 0) {
            showError('歌曲不在曲库中，无法收藏到歌单。请先使用“手动关联”绑定平台歌曲 ID。');
            window.batchCollectSongs = null;
            return;
        }
        if (unavailableCount > 0) {
            showInfo(`已跳过 ${unavailableCount} 首未绑定平台 ID 的歌曲；歌曲不在曲库中，无法收藏到歌单。`);
        }
        window.batchCollectSongs = collectableSongs;
    } else {
        window.batchCollectSongs = null;
        if (isUnboundLocalSong(context.getCurrentPlayingSong())) {
            showError('歌曲不在曲库中，无法收藏到歌单。请先使用“手动关联”绑定平台歌曲 ID。');
            return;
        }
    }

    const isBatch = !!window.batchCollectSongs;
    const song = isBatch ? window.batchCollectSongs[0] : context.getCurrentPlayingSong();

    if (!song) {
        showError(isBatch ? '无可收藏的歌曲' : '当前没有正在播放的歌曲');
        return;
    }

    const modal = document.getElementById('playlist-add-modal');
    const content = document.getElementById('playlist-add-modal-content');
    const nameLabel = document.getElementById('playlist-add-song-name');

    if (!modal) return;

    // Set Info
    nameLabel.innerText = isBatch ? `已选择 ${window.batchCollectSongs.length} 首歌曲` : song.name;

    // Render List Items
    renderPlaylistAddGrid();

    // Show Modal
    modal.classList.remove('hidden');
    setTimeout(() => {
        content.classList.remove('scale-95', 'opacity-0');
        content.classList.add('scale-100', 'opacity-100');
    }, 10);
}

function closePlaylistAddModal(immediate = false) {
    const modal = document.getElementById('playlist-add-modal');
    const content = document.getElementById('playlist-add-modal-content');

    if (content) {
        content.classList.remove('scale-100', 'opacity-100');
        content.classList.add('scale-95', 'opacity-0');
    }

    const hide = () => {
        if (modal) modal.classList.add('hidden');
        // Update Player Info to refresh heart icon state
        if (context.getCurrentPlayingSong()) {
            updatePlayerInfo(context.getCurrentPlayingSong());
        }
    };

    if (immediate) hide();
    else setTimeout(hide, 300);
}

// 绑定模态框背景点击
const playlistAddModal = document.getElementById('playlist-add-modal');
if (playlistAddModal) {
    playlistAddModal.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closePlaylistAddModal();
        }
    });
}


// Helper: Clean song data to match LX.Music.MusicInfoOnline interface
function cleanSongData(song) {
    if (!song) return null;

    // Ensure meta exists, defaulting to empty object if missing
    const sourceMeta = song.meta || {};

    // 1. Resolve Song ID (songId or songmid or id)
    // Different sources/APIs place the ID in different spots
    let songId = sourceMeta.songId || song.songId || song.songmid || song.id;

    // [Fix] 针对 QQ 音乐 (tx)，强制使用 songmid 作为主 ID，避免使用数字 ID
    if (song.source === 'tx' && song.songmid) {
        songId = song.songmid;
    }

    // 2. Resolve Album Name
    let albumName = sourceMeta.albumName || song.albumName || song.album?.name || '';

    // 3. Resolve Pic URL
    let picUrl = sourceMeta.picUrl || song.picUrl || song.img || song.album?.cover;

    // Common Meta
    const meta = {
        songId: songId,
        albumName: albumName,
        picUrl: picUrl,
        qualitys: sourceMeta.qualitys || song.qualitys || song.types,
        _qualitys: sourceMeta._qualitys || song._qualitys || song._types,
        albumId: sourceMeta.albumId || song.albumId
    };

    // Source Reference: src/types/music.d.ts
    // 补全特定源的字段
    if (song.source === 'tx') {
        meta.strMediaMid = sourceMeta.strMediaMid || song.strMediaMid || song.mediaMid;
        meta.id = sourceMeta.id || song.songId || song.id; // tx often uses numerical ID here
        meta.albumMid = sourceMeta.albumMid || song.albumMid;
    }

    // Common Base
    // 确保 ID 格式为 source_songId (如 kw_123456)
    // 如果 song.id 已经是 source_id 格式则保留，否则拼接
    const fullId = (song.source && songId && !String(songId).startsWith(song.source + '_'))
        ? `${song.source}_${songId}`
        : (song.id || `${song.source || 'temp'}_${songId}`);

    const cleanSong = {
        id: fullId, // Standardized ID
        name: song.name,
        singer: song.singer,
        source: song.source,
        interval: song.interval,
        meta: meta
    };

    if (song.isLocal) cleanSong.isLocal = song.isLocal;
    if (song.url) cleanSong.url = song.url;
    if (song.folder) cleanSong.folder = song.folder;
    if (song.filename) cleanSong.filename = song.filename;

    // Remove undefined keys
    const removeUndefined = (obj) => {
        Object.keys(obj).forEach(key => {
            if (obj[key] === undefined) delete obj[key];
            else if (typeof obj[key] === 'object' && obj[key] !== null) removeUndefined(obj[key]);
        });
        return obj;
    };

    return removeUndefined(cleanSong);
}


// Modified handler for Grid Buttons
async function handleTogglePlaylist(listId, btnElement) {
    if (!context.getCurrentListData()) return;
    const activeListData = isUserLoggedIn() ? (window.myPersonalListData || context.getCurrentListData()) : context.getCurrentListData();

    // 未登录账号且正在对 _open 公开列表进行修改时，需要管理员权限
    if (!isUserLoggedIn() && activeListData.username === '_open') {
        if (!(await requireAdminForOpenWrite('修改公开收藏'))) return;
    }
    const isBatch = !!window.batchCollectSongs;
    const songs = isBatch ? window.batchCollectSongs : [context.getCurrentPlayingSong()];
    if (songs.length === 0 || !songs[0]) return;

    // --- Batch Mode Logic ---
    if (isBatch) {
        btnElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中...';
        btnElement.disabled = true;

        // 1. Find target list in memory (Optimistic Update)
        let targetListArray = null;
        if (listId === 'love') targetListArray = activeListData.loveList;
        else targetListArray = activeListData.userList.find(l => l.id === listId)?.list;

        if (!targetListArray) {
            showError('未找到目标歌单');
            return;
        }

        // 2. Local State Modification
        const addedSongs = [];
        songs.forEach(s => {
            const cleaned = cleanSongData(s);
            if (!targetListArray.some(existing => existing.id === cleaned.id)) {
                targetListArray.unshift(cleaned);
                addedSongs.push(cleaned);
            }
        });

        if (addedSongs.length === 0) {
            showInfo('所选歌曲已在歌单中');
            closePlaylistAddModal();
            return;
        }

        // 3. Immediate UI Refresh
        renderMyLists(context.getCurrentListData());
        if (isCurrentlyViewingLocalList(window.currentViewingListId)) {
            handleListClick(window.currentViewingListId, true);
        }

        // 4. Close Modal Immediately
        closePlaylistAddModal();

        // 5. Persist through the same-origin Web API; the HttpOnly session is
        // attached by the browser and never exposed to JavaScript.
        try {
            const res = await fetch('/api/music/user/list/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getUserAuthHeaders() },
                credentials: 'same-origin',
                body: JSON.stringify({ listId, musicInfos: addedSongs })
            });
            if (!res.ok) throw new Error(await res.text());
            showSuccess(`批量收藏 ${addedSongs.length} 首歌曲成功`);

            // Cleanup selection
            if (typeof exitBatchMode === 'function') exitBatchMode();
            else if (typeof deselectAll === 'function') deselectAll();

        } catch (e) {
            console.error('[BatchCollect] Sync failed, reverting or refreshing:', e);
            showError('同步失败: ' + e.message);
            // Full refresh as fallback to ensure consistency
            refreshUserListData();
        } finally {
            window.batchCollectSongs = null;
        }
        return;
    }

    // --- Single Song Mode Logic (Existing) ---
    const song = songs[0];
    let targetListArray;
    if (listId === 'love') {
        targetListArray = activeListData.loveList;
    } else {
        const uList = activeListData.userList.find(l => l.id === listId);
        if (uList) targetListArray = uList.list;
    }

    if (!targetListArray) return;

    const cleanedSong = cleanSongData(song); // 获取标准化的歌曲数据
    const targetId = cleanedSong.id;

    // Check against the standardized ID to ensure correct matching
    const isCurrentlyIncluded = targetListArray.some(s => s.id === targetId);
    const willAdd = !isCurrentlyIncluded;

    // Optimistic UI Update
    updateGridItemVisuals(btnElement, willAdd);

    try {
        if (willAdd) {
            targetListArray.unshift(cleanedSong);
        } else {
            const idx = targetListArray.findIndex(s => s.id === targetId);
            if (idx >= 0) targetListArray.splice(idx, 1);
        }

        await pushDataChange(activeListData);
        renderMyLists(context.getCurrentListData());
    } catch (e) {
        showError('同步失败: ' + e.message);
        updateGridItemVisuals(btnElement, !willAdd); // Revert UI
    }
}

function updateGridItemVisuals(btn, isIncluded) {
    if (isIncluded) {
        btn.className = "relative h-14 rounded-lg text-sm font-bold transition-all duration-200 flex items-center justify-center gap-1 shadow-sm overflow-hidden bg-red-500 text-white shadow-md scale-[1.02] ring-2 ring-red-200";
        // Update icon if needed, though innerHTML replacement is easiest
        const textSpan = btn.querySelector('span'); // Assuming first span is text
        const text = textSpan ? textSpan.innerText : btn.innerText;
        btn.innerHTML = `
            <span class="truncate max-w-[80%]">${text}</span>
            <i class="fas fa-check text-xs ml-1 opacity-80"></i>
        `;
    } else {
        btn.className = "relative h-14 rounded-lg text-sm font-bold transition-all duration-200 flex items-center justify-center gap-1 shadow-sm overflow-hidden bg-red-50 text-red-500 hover:bg-red-100 hover:shadow";
        const textSpan = btn.querySelector('span');
        const text = textSpan ? textSpan.innerText : btn.innerText;
        btn.innerHTML = `<span class="truncate max-w-[80%]">${text}</span>`;
    }
}

    const feature = {
        renderPlaylistAddGrid,
        openPlaylistAddModal,
        closePlaylistAddModal,
        cleanSongData,
        handleTogglePlaylist,
        updateGridItemVisuals,
    };

    Object.assign(window, feature);
    return feature;
}
