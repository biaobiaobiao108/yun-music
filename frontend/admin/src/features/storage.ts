import type { AdminFeatureContext, StorageItem } from '../types';

declare const showSelect: (title: string, message: string, options?: { danger?: boolean; okOnly?: boolean }) => Promise<boolean>;
declare const showSuccess: (message: string) => void;
declare const showError: (message: string) => void;

export function initStorageFeature(context: AdminFeatureContext) {
    const app = context.app;
    let currentTab: 'cache' | 'music' = 'cache';
    let allLoadedItems: StorageItem[] = [];
    let displayedItems: StorageItem[] = [];
    let audioPlayer: HTMLAudioElement | null = null;
    let playingKey: string | null = null;

    function getAudioPlayer(): HTMLAudioElement {
        if (!audioPlayer) {
            audioPlayer = new Audio();
            audioPlayer.addEventListener('ended', () => {
                playingKey = null;
                updateAudioRowStates();
            });
            audioPlayer.addEventListener('error', () => {
                playingKey = null;
                updateAudioRowStates();
            });
            audioPlayer.addEventListener('pause', () => {
                if (audioPlayer?.ended) {
                    playingKey = null;
                    updateAudioRowStates();
                }
            });
        }
        return audioPlayer;
    }

    function updateAudioRowStates() {
        document.querySelectorAll('.storage-row').forEach(row => {
            const rowEl = row as HTMLElement;
            const key = rowEl.dataset.itemKey;
            const btn = rowEl.querySelector('.btn-play-preview');
            const isPlaying = key && key === playingKey && audioPlayer && !audioPlayer.paused;
            rowEl.classList.toggle('playing', !!isPlaying);
            if (btn) {
                btn.classList.toggle('active', !!isPlaying);
                btn.innerHTML = isPlaying
                    ? `<div class="equalizer-icon"><span></span><span></span><span></span></div>`
                    : `<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
            }
        });
    }

    function renderSongTags(song: any): string {
        let html = '<div class="song-meta-tags">';
        const source = String(song?.source || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (source) html += `<span class="tag tag-source ${source}">${app.escapeHtml(song.source)}</span>`;

        const quality = song?.quality || song?.type;
        if (quality === 'flac24bit') html += '<span class="tag tag-quality hr">Hi-Res</span>';
        else if (quality === 'flac') html += '<span class="tag tag-quality lossless">SQ</span>';
        else if (quality === '320k') html += '<span class="tag tag-quality high">HQ</span>';

        if (song?.interval) html += `<span class="tag tag-interval">${app.escapeHtml(song.interval)}</span>`;
        return `${html}</div>`;
    }

    function renderStorageSongCell(item: StorageItem): string {
        const coverUser = item.rawUsername || '_open';
        const picUrl = `/api/music/cache/cover?filename=${encodeURIComponent(item.filename)}&folder=${item.folder}&user=${encodeURIComponent(coverUser)}`;
        const songName = app.escapeHtml(item.name || item.filename || '未知歌曲');
        const coverHtml = `<img src="${app.escapeHtml(picUrl)}" class="song-cover" width="44" height="44" loading="lazy" decoding="async" alt="${songName}封面" onerror="this.outerHTML='<div class=\\'song-cover\\' style=\\'background: rgba(255,255,255,0.08); display: flex; align-items: center; justify-content: center; font-size: 1.2rem;\\'>🎵</div>'">`;
        const singerHtml = item.singer
            ? `<span class="song-singer-mobile">${app.escapeHtml(item.singer)}</span>`
            : '';

        return `
            <div class="song-col-name" style="display:flex; align-items:center; gap:0.75rem; min-width:0;">
                ${coverHtml}
                <div class="song-info-wrapper min-w-0" style="display:flex; flex-direction:column; gap:2px; min-width:0;">
                    <span class="song-title-text truncate" title="${songName}" style="font-weight:500;">${songName}</span>
                    ${singerHtml}
                    ${renderSongTags(item)}
                </div>
            </div>
        `;
    }

    function bindStorageEvents() {
        // 子标签切换
        document.querySelectorAll('[data-storage-tab]').forEach(tabBtn => {
            tabBtn.addEventListener('click', (e) => {
                const target = (e.currentTarget as HTMLElement).dataset.storageTab;
                if (target === 'cache' || target === 'music') {
                    switchStorageTab(target);
                }
            });
        });

        // 刷新按钮
        document.getElementById('refresh-storage-btn')?.addEventListener('click', () => loadStorageData());

        // 清空缓存按钮
        document.getElementById('clear-cache-btn')?.addEventListener('click', () => clearStorageCache());

        // 筛选与排序
        document.getElementById('storage-search-input')?.addEventListener('input', () => filterStorageSongs());
        document.getElementById('storage-sort-select')?.addEventListener('change', () => sortStorageSongs());

        // 批量选择
        document.querySelector('[data-admin-action="storage-select-all"]')?.addEventListener('click', () => selectAllStorageSongs());
        document.querySelector('[data-admin-action="storage-invert-selection"]')?.addEventListener('click', () => invertStorageSelection());
        document.querySelector('[data-admin-action="storage-clear-selection"]')?.addEventListener('click', () => clearStorageSelection());

        // 批量操作
        document.getElementById('storage-batch-delete-btn')?.addEventListener('click', () => batchDeleteStorageItems());
        document.getElementById('storage-batch-move-btn')?.addEventListener('click', () => batchMoveStorageItems());

        // 表格事件委托 (播放、删除、流转)
        const container = document.getElementById('storage-content');
        container?.addEventListener('click', (e) => {
            const target = (e.target as Element).closest<HTMLElement>('[data-storage-action]');
            if (!target) return;
            const action = target.dataset.storageAction;
            const index = Number(target.dataset.storageIndex);
            if (action === 'play') toggleStorageAudio(index);
            else if (action === 'delete') void deleteStorageItem(index);
            else if (action === 'move') void moveStorageItem(index);
        });

        container?.addEventListener('change', (e) => {
            const target = e.target as HTMLElement;
            if (target.classList.contains('storage-checkbox')) {
                updateStorageBatchBtns();
            } else if (target.id === 'select-all-storage-checkbox') {
                toggleAllStorageSongs((target as HTMLInputElement).checked);
            }
        });
    }

    function switchStorageTab(tab: 'cache' | 'music') {
        currentTab = tab;
        app.currentStorageTab = tab;

        // 更新 tabs 样式
        document.querySelectorAll('[data-storage-tab]').forEach(btn => {
            const isMatch = (btn as HTMLElement).dataset.storageTab === tab;
            btn.classList.toggle('active', isMatch);
        });

        // 切换批量移动按钮文案
        const moveBtnText = document.getElementById('storage-batch-move-text');
        if (moveBtnText) {
            moveBtnText.textContent = tab === 'cache' ? '转为下载' : '转为缓存';
        }

        // 切换“清空缓存”按钮显示（仅在缓存标签页展示）
        const clearBtn = document.getElementById('clear-cache-btn');
        if (clearBtn) {
            clearBtn.style.display = tab === 'cache' ? 'inline-flex' : 'none';
        }

        renderStorageList();
    }

    async function loadStorageData(targetTab?: 'cache' | 'music') {
        if (targetTab) {
            currentTab = targetTab;
            app.currentStorageTab = targetTab;
        }

        const userSelectEl = document.getElementById('storage-user-select') as HTMLInputElement | null;
        const selectedUser = userSelectEl?.value || 'all';

        const contentEl = document.getElementById('storage-content');
        if (contentEl) {
            contentEl.innerHTML = '<div style="padding: 3rem; text-align: center; color: var(--text-secondary);"><div class="spinner" style="margin: 0 auto 1rem;"></div>加载中...</div>';
        }

        try {
            const res = await app.request(`/api/music/cache/list?user=${encodeURIComponent(selectedUser)}`);
            if (res.success && Array.isArray(res.data)) {
                allLoadedItems = res.data;
                app.storageItems = allLoadedItems;

                // 统计数量并更新徽章
                const cacheItems = allLoadedItems.filter(i => i.folder === 'cache');
                const musicItems = allLoadedItems.filter(i => i.folder === 'music');

                const cacheBadge = document.getElementById('storage-cache-badge');
                const musicBadge = document.getElementById('storage-music-badge');
                if (cacheBadge) cacheBadge.textContent = String(cacheItems.length);
                if (musicBadge) musicBadge.textContent = String(musicItems.length);

                switchStorageTab(currentTab);
            } else {
                if (contentEl) {
                    contentEl.innerHTML = `<div style="padding: 3rem; text-align: center; color: var(--accent-error);">${app.escapeHtml(res.message || '加载列表失败')}</div>`;
                }
            }
        } catch (err: any) {
            if (contentEl) {
                contentEl.innerHTML = `<div style="padding: 3rem; text-align: center; color: var(--accent-error);">加载数据失败: ${app.escapeHtml(err.message || '网络异常')}</div>`;
            }
        }
    }

    function renderStorageList() {
        const contentEl = document.getElementById('storage-content');
        if (!contentEl) return;

        // 根据当前标签页筛选
        let list = allLoadedItems.filter(item => item.folder === currentTab);

        // 搜索过滤
        const searchInput = document.getElementById('storage-search-input') as HTMLInputElement | null;
        const query = searchInput?.value.trim().toLowerCase() || '';
        if (query) {
            list = list.filter(item => {
                const name = (item.name || '').toLowerCase();
                const singer = (item.singer || '').toLowerCase();
                const filename = (item.filename || '').toLowerCase();
                return name.includes(query) || singer.includes(query) || filename.includes(query);
            });
        }

        // 排序
        const sortSelect = document.getElementById('storage-sort-select') as HTMLSelectElement | null;
        const sortVal = sortSelect?.value || '';
        if (sortVal) {
            const [field, order] = sortVal.split('-');
            list.sort((a, b) => {
                let res = 0;
                if (field === 'size') {
                    res = (a.size || 0) - (b.size || 0);
                } else if (field === 'mtime') {
                    res = (a.mtime || 0) - (b.mtime || 0);
                } else if (field === 'name') {
                    const nameA = a.name || a.filename || '';
                    const nameB = b.name || b.filename || '';
                    res = nameA.localeCompare(nameB, 'zh-CN');
                }
                return order === 'desc' ? -res : res;
            });
        }

        displayedItems = list;

        // 统计概览条
        const totalSize = list.reduce((acc, cur) => acc + (cur.size || 0), 0);
        const summaryEl = document.getElementById('storage-stats-summary');
        if (summaryEl) {
            const tabName = currentTab === 'cache' ? '缓存音乐' : '下载音乐';
            summaryEl.innerHTML = `
                <div class="storage-stat-pill">分类: <strong>${tabName}</strong></div>
                <div class="storage-stat-pill">当前显示: <strong>${list.length} 首</strong></div>
                <div class="storage-stat-pill">占用空间: <strong>${app.formatFileSize(totalSize)}</strong></div>
            `;
        }

        if (list.length === 0) {
            contentEl.innerHTML = `
                <div style="padding: 4rem 2rem; text-align: center; color: var(--text-secondary);">
                    <div style="font-size: 2.5rem; margin-bottom: 0.5rem; opacity: 0.6;">📦</div>
                    <p>暂无${currentTab === 'cache' ? '缓存音乐' : '下载音乐'}数据</p>
                </div>
            `;
            updateStorageBatchBtns();
            return;
        }

        const userSelectEl = document.getElementById('storage-user-select') as HTMLInputElement | null;
        const showUserCol = (userSelectEl?.value || 'all') === 'all';

        let html = `
            <div class="storage-table">
                <div class="storage-table-header">
                    <div class="col-storage-select">
                        <input type="checkbox" id="select-all-storage-checkbox" title="全选/反选">
                    </div>
                    <div class="col-storage-index">#</div>
                    <div class="col-storage-song">歌曲</div>
                    <div class="col-storage-artist">歌手</div>
                    <div class="col-storage-size">大小</div>
                    ${showUserCol ? '<div class="col-storage-user">所属用户</div>' : ''}
                    <div class="col-storage-time">时间</div>
                    <div class="col-storage-actions">操作</div>
                </div>
        `;

        list.forEach((item, index) => {
            const itemKey = `${item.rawUsername || '_open'}_${item.folder}_${item.filename}`;
            const isPlaying = playingKey === itemKey && audioPlayer && !audioPlayer.paused;
            const rowClass = `storage-row ${isPlaying ? 'playing' : ''}`;
            const userDisplay = item.username || item.rawUsername || '公共曲库';
            const isPublicUser = item.rawUsername === '_open' || !item.rawUsername;
            const timeStr = item.mtime ? app.formatTime(item.mtime) : '-';
            const moveActionTitle = item.folder === 'cache' ? '转为下载音乐' : '转为缓存音乐';

            html += `
                <div class="${rowClass}" data-item-key="${app.escapeHtml(itemKey)}">
                    <div class="col-storage-select">
                        <input type="checkbox" class="storage-checkbox" data-index="${index}" data-filename="${app.escapeHtml(item.filename)}" data-folder="${item.folder}" data-user="${app.escapeHtml(item.rawUsername || '_open')}">
                    </div>
                    <div class="col-storage-index">${index + 1}</div>
                    <div class="col-storage-song">
                        ${renderStorageSongCell(item)}
                    </div>
                    <div class="col-storage-artist" title="${app.escapeHtml(item.singer || '未知歌手')}">${app.escapeHtml(item.singer || '未知歌手')}</div>
                    <div class="col-storage-size">${app.formatFileSize(item.size || 0)}</div>
                    ${showUserCol ? `<div class="col-storage-user"><span class="user-tag ${isPublicUser ? 'public-tag' : ''}">${app.escapeHtml(userDisplay)}</span></div>` : ''}
                    <div class="col-storage-time" title="${app.escapeHtml(timeStr)}">${app.escapeHtml(timeStr)}</div>
                    <div class="col-storage-actions">
                        <button type="button" class="btn-play-preview ${isPlaying ? 'active' : ''}" data-storage-action="play" data-storage-index="${index}" title="${isPlaying ? '暂停试听' : '试听预览'}">
                            ${isPlaying ? '<div class="equalizer-icon"><span></span><span></span><span></span></div>' : '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><polygon points="5 3 19 12 5 21 5 3"/></svg>'}
                        </button>
                        <button type="button" class="btn-icon" data-storage-action="move" data-storage-index="${index}" title="${moveActionTitle}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
                                <polyline points="17 1 21 5 17 9"/>
                                <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                                <polyline points="7 23 3 19 7 15"/>
                                <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                            </svg>
                        </button>
                        <button type="button" class="btn-icon" data-storage-action="delete" data-storage-index="${index}" title="删除文件" style="color: var(--accent-error);">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `;
        });

        html += `</div>`;
        contentEl.innerHTML = html;
        updateStorageBatchBtns();
    }

    function toggleStorageAudio(index: number) {
        const item = displayedItems[index];
        if (!item) return;

        const player = getAudioPlayer();
        const key = `${item.rawUsername || '_open'}_${item.folder}_${item.filename}`;

        if (playingKey === key && !player.paused) {
            player.pause();
            playingKey = null;
            updateAudioRowStates();
            return;
        }

        const user = item.rawUsername || '_open';
        player.src = `/api/music/cache/file/${encodeURIComponent(user)}/${encodeURIComponent(item.filename)}?folder=${item.folder}`;
        player.play().then(() => {
            playingKey = key;
            updateAudioRowStates();
        }).catch(err => {
            console.error('Playback error:', err);
            showError('试听播放失败: ' + err.message);
            playingKey = null;
            updateAudioRowStates();
        });
    }

    async function deleteStorageItem(index: number) {
        const item = displayedItems[index];
        if (!item) return;

        const folderName = item.folder === 'music' ? '下载' : '缓存';
        const confirmed = await showSelect('删除确认', `确定要删除此${folderName}音乐 "${item.name || item.filename}" 吗？\n文件删除后将不可恢复！`, { danger: true });
        if (!confirmed) return;

        try {
            const res = await app.request('/api/music/cache/remove', {
                method: 'POST',
                body: JSON.stringify({
                    items: [{
                        filename: item.filename,
                        folder: item.folder,
                        user: item.rawUsername || '_open'
                    }]
                })
            });

            if (res.success) {
                showSuccess('删除成功！');
                if (playingKey === `${item.rawUsername || '_open'}_${item.folder}_${item.filename}`) {
                    audioPlayer?.pause();
                    playingKey = null;
                }
                await loadStorageData();
                void app.loadDashboard();
            } else {
                showError('删除失败: ' + (res.message || '未知错误'));
            }
        } catch (err: any) {
            showError('删除失败: ' + err.message);
        }
    }

    async function batchDeleteStorageItems() {
        const checkboxes = document.querySelectorAll('.storage-checkbox:checked') as NodeListOf<HTMLInputElement>;
        if (checkboxes.length === 0) return;

        const itemsToDelete: Array<{ filename: string; folder: 'cache' | 'music'; user: string }> = [];
        checkboxes.forEach(cb => {
            const filename = cb.dataset.filename;
            const folder = cb.dataset.folder as 'cache' | 'music';
            const user = cb.dataset.user || '_open';
            if (filename && folder) {
                itemsToDelete.push({ filename, folder, user });
            }
        });

        const confirmed = await showSelect('批量删除', `确定要永久删除选中的 ${itemsToDelete.length} 首音乐吗？`, { danger: true });
        if (!confirmed) return;

        try {
            const res = await app.request('/api/music/cache/remove', {
                method: 'POST',
                body: JSON.stringify({ items: itemsToDelete })
            });

            if (res.success) {
                showSuccess(`成功删除 ${res.deletedCount || itemsToDelete.length} 首音乐！`);
                audioPlayer?.pause();
                playingKey = null;
                await loadStorageData();
                void app.loadDashboard();
            } else {
                showError('批量删除部分失败: ' + (res.message || '部分文件未能删除'));
                await loadStorageData();
            }
        } catch (err: any) {
            showError('批量删除失败: ' + err.message);
        }
    }

    async function moveStorageItem(index: number) {
        const item = displayedItems[index];
        if (!item) return;

        const targetFolder = item.folder === 'cache' ? '下载音乐' : '缓存音乐';
        const confirmed = await showSelect('流转转换', `确定要将歌曲 "${item.name || item.filename}" 移动至「${targetFolder}」吗？`);
        if (!confirmed) return;

        try {
            const res = await app.request('/api/music/cache/move', {
                method: 'POST',
                body: JSON.stringify({
                    items: [{
                        filename: item.filename,
                        user: item.rawUsername || '_open'
                    }]
                })
            });

            if (res.success) {
                showSuccess(`已成功转入「${targetFolder}」！`);
                await loadStorageData();
                void app.loadDashboard();
            } else {
                showError('移动失败: ' + (res.message || '未知错误'));
            }
        } catch (err: any) {
            showError('移动失败: ' + err.message);
        }
    }

    async function batchMoveStorageItems() {
        const checkboxes = document.querySelectorAll('.storage-checkbox:checked') as NodeListOf<HTMLInputElement>;
        if (checkboxes.length === 0) return;

        const targetFolder = currentTab === 'cache' ? '下载音乐' : '缓存音乐';
        const itemsToMove: Array<{ filename: string; user: string }> = [];
        checkboxes.forEach(cb => {
            const filename = cb.dataset.filename;
            const user = cb.dataset.user || '_open';
            if (filename) itemsToMove.push({ filename, user });
        });

        const confirmed = await showSelect('批量移动', `确定要将选中的 ${itemsToMove.length} 首音乐转移至「${targetFolder}」吗？`);
        if (!confirmed) return;

        try {
            const res = await app.request('/api/music/cache/move', {
                method: 'POST',
                body: JSON.stringify({ items: itemsToMove })
            });

            if (res.success) {
                showSuccess(`成功转移 ${res.successCount || itemsToMove.length} 首音乐至「${targetFolder}」！`);
                await loadStorageData();
                void app.loadDashboard();
            } else {
                showError('批量移动部分失败: ' + (res.message || ''));
                await loadStorageData();
            }
        } catch (err: any) {
            showError('批量移动失败: ' + err.message);
        }
    }

    async function clearStorageCache() {
        const userSelectEl = document.getElementById('storage-user-select') as HTMLInputElement | null;
        const selectedUser = userSelectEl?.value || 'all';
        const userScopeDesc = selectedUser === 'all' ? '所有用户的全部缓存' : `用户 [${selectedUser}] 的全部缓存`;

        const confirmed = await showSelect('危险操作：清空缓存', `确定要清空 ${userScopeDesc} 吗？\n\n注意：此操作不可撤销！已下载的音乐文件不会受到影响。`, { danger: true });
        if (!confirmed) return;

        try {
            const res = await app.request(`/api/music/cache/clear?user=${encodeURIComponent(selectedUser)}`, {
                method: 'POST'
            });

            if (res.success) {
                showSuccess(`清空完成，释放了 ${app.formatFileSize(res.data?.freedSize || 0)} 空间！`);
                audioPlayer?.pause();
                playingKey = null;
                await loadStorageData();
                void app.loadDashboard();
            } else {
                showError('清空缓存失败: ' + (res.message || ''));
            }
        } catch (err: any) {
            showError('清空缓存失败: ' + err.message);
        }
    }

    function filterStorageSongs() {
        renderStorageList();
    }

    function sortStorageSongs() {
        renderStorageList();
    }

    function toggleAllStorageSongs(checked: boolean) {
        document.querySelectorAll('.storage-checkbox').forEach(cb => {
            (cb as HTMLInputElement).checked = checked;
        });
        updateStorageBatchBtns();
    }

    function selectAllStorageSongs() {
        document.querySelectorAll('.storage-checkbox').forEach(cb => {
            (cb as HTMLInputElement).checked = true;
        });
        updateStorageBatchBtns();
    }

    function invertStorageSelection() {
        document.querySelectorAll('.storage-checkbox').forEach(cb => {
            const input = cb as HTMLInputElement;
            input.checked = !input.checked;
        });
        updateStorageBatchBtns();
    }

    function clearStorageSelection() {
        document.querySelectorAll('.storage-checkbox').forEach(cb => {
            (cb as HTMLInputElement).checked = false;
        });
        updateStorageBatchBtns();
    }

    function updateStorageBatchBtns() {
        const checked = document.querySelectorAll('.storage-checkbox:checked');
        const count = checked.length;
        const total = document.querySelectorAll('.storage-checkbox').length;

        const countEl = document.getElementById('storage-selected-count');
        const moveCountEl = document.getElementById('storage-move-count');
        const deleteBtn = document.getElementById('storage-batch-delete-btn') as HTMLButtonElement | null;
        const moveBtn = document.getElementById('storage-batch-move-btn') as HTMLButtonElement | null;
        const selectAllCb = document.getElementById('select-all-storage-checkbox') as HTMLInputElement | null;

        if (countEl) countEl.textContent = String(count);
        if (moveCountEl) moveCountEl.textContent = String(count);
        if (deleteBtn) deleteBtn.disabled = count === 0;
        if (moveBtn) moveBtn.disabled = count === 0;

        if (selectAllCb && total > 0) {
            selectAllCb.checked = count === total;
            selectAllCb.indeterminate = count > 0 && count < total;
        }
    }

    return {
        currentStorageTab: currentTab,
        storageItems: allLoadedItems,
        bindStorageEvents,
        loadStorageData,
        renderStorageList,
        switchStorageTab,
        toggleStorageAudio,
        deleteStorageItem,
        batchDeleteStorageItems,
        moveStorageItem,
        batchMoveStorageItems,
        clearStorageCache,
        filterStorageSongs,
        sortStorageSongs,
        toggleAllStorageSongs,
        selectAllStorageSongs,
        invertStorageSelection,
        clearStorageSelection,
        updateStorageBatchBtns,
    };
}
