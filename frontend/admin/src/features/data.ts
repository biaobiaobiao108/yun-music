import type { AdminFeatureContext } from '../types';

export function initDataFeature(context: AdminFeatureContext) {
    const app = context.app;

    function bindDataEvents() {
        document.getElementById('refresh-data-btn')?.addEventListener('click', () => app.loadUserData());
        document.getElementById('data-user-select')?.addEventListener('change', () => app.loadUserData());
    }

    async function loadUserData() {
        const username = document.getElementById('data-user-select')?.value;
        const statsContainer = document.getElementById('data-stats');
        const contentContainer = document.getElementById('data-content');

        if (!username) {
            app.renderUserSelectionGrid('data');
            return;
        }

        // 添加加载状态
        statsContainer.classList.add('content-loading');
        contentContainer.classList.add('content-loading');

        try {
            const data = await app.request(`/api/data?user=${encodeURIComponent(username)}`);
            app.currentUserData = { username, data };

            // 统计数据
            let totalSongs = 0;
            const defaultCount = data.defaultList?.length || 0;
            const loveCount = data.loveList?.length || 0;
            const userListCount = data.userList?.length || 0;

            data.userList?.forEach(list => {
                totalSongs += list.list?.length || 0;
            });
            totalSongs += defaultCount + loveCount;

            document.getElementById('data-stats').innerHTML = `
                <div class="data-stat-card clickable" role="button" tabindex="0" aria-label="查看总歌曲数" data-admin-action="view-all-songs">
                    <h4>总歌曲数</h4>
                    <div class="value">${totalSongs}</div>
                </div>
                <div class="data-stat-card clickable" role="button" tabindex="0" aria-label="查看试听列表" data-admin-action="view-system-list" data-admin-list-type="default">
                    <h4>试听列表</h4>
                    <div class="value">${defaultCount}</div>
                </div>
                <div class="data-stat-card clickable" role="button" tabindex="0" aria-label="查看我的收藏" data-admin-action="view-system-list" data-admin-list-type="love">
                    <h4>我的收藏</h4>
                    <div class="value">${loveCount}</div>
                </div>
                <div class="data-stat-card clickable" role="button" tabindex="0" aria-label="查看自定义列表" data-admin-action="render-playlists">
                    <h4>自定义列表</h4>
                    <div class="value">${userListCount}</div>
                </div>
            `;

            app.renderPlaylists();

            // 移除加载状态并添加淡入动画
            statsContainer.classList.remove('content-loading');
            contentContainer.classList.remove('content-loading');
            statsContainer.classList.add('fade-in');
            contentContainer.classList.add('fade-in');

            // 动画完成后移除类，以便下次触发
            setTimeout(() => {
                statsContainer.classList.remove('fade-in');
                contentContainer.classList.remove('fade-in');
            }, 400);

        } catch (err) {
            contentContainer.innerHTML = '<p style="color: var(--accent-error); padding: 2rem; text-align: center;">加载数据失败</p>';
        } finally {
            applyMarqueeChecks();
        }
    }

    function renderPlaylists() {
        const data = app.currentUserData?.data;
        if (!data) return;

        let content = '<div class="playlists-header"><h3>播放列表</h3></div>';

        if (data.userList && data.userList.length) {
            content += '<div class="playlists-grid">';
            data.userList.forEach((list, index) => {
                const songCount = list.list?.length || 0;
                content += `
                    <div class="playlist-card glass">
                        <div class="playlist-card-header">
                            <div class="playlist-info">
                                <div class="playlist-name">${app.escapeHtml(list.name)}</div>
                                <div class="playlist-meta">
                                    <span class="playlist-id">ID: ${list.id}</span>
                                    <span class="playlist-count">${songCount} 首</span>
                                </div>
                            </div>
                        </div>
                        <div class="playlist-card-actions">
                            <button class="btn-view" data-admin-action="view-playlist" data-admin-index="${index}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                    <circle cx="12" cy="12" r="3"/>
                                </svg>
                                查看详情
                            </button>
                            <button class="btn-delete-playlist" data-admin-action="delete-playlist" data-admin-index="${index}">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                                删除歌单
                            </button>
                        </div>
                    </div>
                `;
            });
            content += '</div>';
        } else {
            content += '<p style="color: var(--text-secondary); padding: 1rem;">暂无自定义列表</p>';
        }

        document.getElementById('data-content').innerHTML = content;
    }

    function viewPlaylistDetails(index) {
        const playlist = app.currentUserData?.data?.userList?.[index];
        if (!playlist) return;

        app.currentPlaylistView = index;

        let content = `
            <div class="playlist-detail-header">
                <button data-admin-action="render-playlists" class="btn-back">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
                    </svg>
                    返回列表
                </button>
                <div class="playlist-title-row">
                    <h3 id="playlist-name-${index}">${app.escapeHtml(playlist.name)}</h3>
                    <button data-admin-action="edit-playlist" data-admin-index="${index}" class="btn-edit-name" title="编辑名称">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                </div>
                <div class="playlist-detail-meta">
                    <span>ID: ${playlist.id}</span>
                    <span>${playlist.list?.length || 0} 首歌曲</span>
                </div>
            </div>
        `;

        if (playlist.list && playlist.list.length) {
            content += `
                <div class="search-sort-bar">
                    <div class="search-box">
                        <input type="text" id="song-search" placeholder="搜索歌曲、歌手..." data-admin-action="filter-songs">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                        </svg>
                    </div>
                    <select id="song-sort" data-admin-action="sort-songs" class="sort-select">
                        <option value="">默认排序</option>
                        <option value="name-asc">歌曲名 ↑</option>
                        <option value="name-desc">歌曲名 ↓</option>
                        <option value="artist-asc">歌手 ↑</option>
                        <option value="artist-desc">歌手 ↓</option>
                    </select>
                </div>
                <div class="batch-actions">
                    <div class="batch-select-btns">
                        <button data-admin-action="select-all-songs" class="btn-batch">全选</button>
                        <button data-admin-action="invert-selection" class="btn-batch">反选</button>
                        <button data-admin-action="clear-selection" class="btn-batch">清空</button>
                    </div>
                    <button data-admin-action="batch-delete-songs" class="btn-batch-delete" id="batch-delete-btn" disabled>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                        批量删除 (<span id="selected-count">0</span>)
                    </button>
                </div>
            `;
            content += '<div class="songs-table">';
            content += `
                <div class="songs-table-header with-checkbox">
                    <div class="song-col-checkbox">
                        <input type="checkbox" id="select-all-checkbox" data-admin-action="toggle-all-songs">
                    </div>
                    <div class="song-col-index">#</div>
                    <div class="song-col-name">歌曲</div>
                    <div class="song-col-artist">歌手</div>
                    <div class="song-col-actions">操作</div>
                </div>
            `;

            playlist.list.forEach((song, songIndex) => {
                content += `
                    <div class="song-row with-checkbox">
                        <div class="song-col-checkbox">
                        <input type="checkbox" class="song-checkbox" data-index="${songIndex}" data-admin-action="update-batch-delete">
                        </div>
                        <div class="song-col-index">${songIndex + 1}</div>
                        ${app.renderSongNameCell(song)}
                        <div class="song-col-artist">${app.escapeHtml(song.singer || '未知歌手')}</div>
                        <div class="song-col-actions">
                            <button class="btn-delete-song" data-admin-action="delete-song" data-admin-playlist-index="${index}" data-admin-song-index="${songIndex}" title="删除歌曲">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                `;
            });

            content += '</div>';
        } else {
            content += '<p style="color: var(--text-secondary); padding: 2rem; text-align: center;">此歌单暂无歌曲</p>';
        }

        document.getElementById('data-content').innerHTML = content;
    }

    async function deletePlaylist(index) {
        const playlist = app.currentUserData?.data?.userList?.[index];
        if (!playlist) return;

        if (!(await showSelect('删除歌单', `确定要删除歌单 "${playlist.name}" 吗？\n此操作将删除歌单及其中的所有歌曲！`, { danger: true }))) return;

        try {
            await app.request('/api/data/delete-playlist', {
                method: 'POST',
                body: JSON.stringify({
                    username: app.currentUserData.username,
                    playlistId: playlist.id
                })
            });

            showSuccess('删除成功！');
            app.loadUserData();
        } catch (err) {
            showError('删除失败: ' + err.message);
        }
    }

    async function deleteSong(playlistIndexOrType, songIndex) {
        let playlist, song, playlistId, isSystemList = false;

        // 检查是否是系统列表
        if (typeof playlistIndexOrType === 'string') {
            isSystemList = true;
            const listType = playlistIndexOrType;
            const listMap = {
                'default': { list: app.currentUserData?.data?.defaultList, name: '试听列表', id: 'default' },
                'love': { list: app.currentUserData?.data?.loveList, name: '我的收藏', id: 'love' }
            };
            playlist = listMap[listType];
            song = playlist?.list?.[songIndex];
            playlistId = playlist?.id;
        } else {
            playlist = app.currentUserData?.data?.userList?.[playlistIndexOrType];
            song = playlist?.list?.[songIndex];
            playlistId = playlist?.id;
        }

        if (!song) return;

        if (!(await showSelect('删除歌曲', `确定要从 "${playlist.name}" 中删除歌曲 "${song.name}" 吗？`, { danger: true }))) return;

        try {
            await app.request('/api/data/delete-song', {
                method: 'POST',
                body: JSON.stringify({
                    username: app.currentUserData.username,
                    playlistId: playlistId,
                    songIndex: songIndex
                })
            });

            showSuccess('删除成功！');
            // 重新加载并显示当前列表
            await app.loadUserData();
            if (isSystemList) {
                app.viewSystemList(playlistIndexOrType);
            } else {
                app.viewPlaylistDetails(playlistIndexOrType);
            }
        } catch (err) {
            showError('删除失败: ' + err.message);
        }
    }

    function viewSystemList(listType) {
        const data = app.currentUserData?.data;
        if (!data) return;

        const listMap = {
            'default': { list: data.defaultList, name: '试听列表', id: 'default' },
            'love': { list: data.loveList, name: '我的收藏', id: 'love' }
        };

        const systemList = listMap[listType];
        if (!systemList) return;

        app.currentPlaylistView = listType; // 存储当前查看的系统列表类型

        let content = `
            <div class="playlist-detail-header">
                <button data-admin-action="render-playlists" class="btn-back">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
                    </svg>
                    返回列表
                </button>
                <h3>${systemList.name}</h3>
                <div class="playlist-detail-meta">
                    <span>系统列表</span>
                    <span>${systemList.list?.length || 0} 首歌曲</span>
                </div>
            </div>
        `;

        if (systemList.list && systemList.list.length) {
            content += '<div class="songs-table">';
            content += `
                <div class="songs-table-header">
                    <div class="song-col-index">#</div>
                    <div class="song-col-name">歌曲</div>
                    <div class="song-col-artist">歌手</div>
                    <div class="song-col-source">来源</div>
                    <div class="song-col-actions">操作</div>
                </div>
            `;

            systemList.list.forEach((song, songIndex) => {
                content += `
                    <div class="song-row">
                        <div class="song-col-index">${songIndex + 1}</div>
                        ${app.renderSongNameCell(song)}
                        <div class="song-col-artist">${app.escapeHtml(song.singer || '未知歌手')}</div>
                        <div class="song-col-actions">
                            <button class="btn-delete-song" data-admin-action="delete-song" data-admin-playlist-type="${app.escapeHtml(listType)}" data-admin-song-index="${songIndex}" title="删除歌曲">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                `;
            });

            content += '</div>';
        } else {
            content += '<p style="color: var(--text-secondary); padding: 2rem; text-align: center;">此列表暂无歌曲</p>';
        }

        document.getElementById('data-content').innerHTML = content;
    }

    async function editPlaylistName(index) {
        const playlist = app.currentUserData?.data?.userList?.[index];
        if (!playlist) return;

        const newName = await showInput('编辑歌单名称', '请输入新的歌单名称:', { defaultValue: playlist.name });
        if (!newName || newName === playlist.name) return;

        try {
            await app.request('/api/data/rename-playlist', {
                method: 'POST',
                body: JSON.stringify({
                    username: app.currentUserData.username,
                    playlistId: playlist.id,
                    newName: newName
                })
            });

            showSuccess('重命名成功！');
            await app.loadUserData();
            app.viewPlaylistDetails(index);
        } catch (err) {
            showError('重命名失败: ' + err.message);
        }
    }

    // 更新批量删除按钮状态

    function updateBatchDeleteBtn() {
        const checkboxes = document.querySelectorAll('.song-checkbox:checked');
        const count = checkboxes.length;
        const btn = document.getElementById('batch-delete-btn');
        const countSpan = document.getElementById('selected-count');

        if (countSpan) countSpan.textContent = count;
        if (btn) btn.disabled = count === 0;

        // 更新全选复选框状态
        const allCheckboxes = document.querySelectorAll('.song-checkbox');
        const selectAllCheckbox = document.getElementById('select-all-checkbox');
        if (selectAllCheckbox && allCheckboxes.length > 0) {
            selectAllCheckbox.checked = count === allCheckboxes.length;
            selectAllCheckbox.indeterminate = count > 0 && count < allCheckboxes.length;
        }
    }

    // 全选/取消全选

    function toggleAllSongs(checked) {
        document.querySelectorAll('.song-checkbox').forEach(cb => {
            cb.checked = checked;
        });
        app.updateBatchDeleteBtn();
    }

    // 全选

    function selectAllSongs() {
        document.querySelectorAll('.song-checkbox').forEach(cb => {
            cb.checked = true;
        });
        app.updateBatchDeleteBtn();
    }

    // 反选

    function invertSelection() {
        document.querySelectorAll('.song-checkbox').forEach(cb => {
            cb.checked = !cb.checked;
        });
        app.updateBatchDeleteBtn();
    }

    // 清空选择

    function clearSelection() {
        document.querySelectorAll('.song-checkbox').forEach(cb => {
            cb.checked = false;
        });
        app.updateBatchDeleteBtn();
    }

    // 批量删除歌曲

    async function batchDeleteSongs() {
        const checkboxes = document.querySelectorAll('.song-checkbox:checked');
        if (checkboxes.length === 0) return;

        const playlistIndex = app.currentPlaylistView;
        const playlist = app.currentUserData?.data?.userList?.[playlistIndex];
        if (!playlist) return;

        if (!(await showSelect('批量删除', `确定要删除选中的 ${checkboxes.length} 首歌曲吗？`, { danger: true }))) return;

        try {
            // 获取选中歌曲的索引（需要从大到小排序，避免删除时索引变化）
            const songIndices = Array.from(checkboxes)
                .map(cb => parseInt(cb.dataset.index))
                .sort((a, b) => b - a);

            await app.request('/api/data/batch-delete-songs', {
                method: 'POST',
                body: JSON.stringify({
                    username: app.currentUserData.username,
                    playlistId: playlist.id,
                    songIndices: songIndices
                })
            });

            showSuccess('批量删除成功！');
            await app.loadUserData();
            app.viewPlaylistDetails(playlistIndex);
        } catch (err) {
            showError('批量删除失败: ' + err.message);
        }
    }

    // 筛选歌曲

    function filterSongs() {
        const searchText = document.getElementById('song-search')?.value.toLowerCase() || '';
        const rows = document.querySelectorAll('.song-row');

        rows.forEach(row => {
            const nameEl = row.querySelector('.song-col-name');
            const artistEl = row.querySelector('.song-col-artist');
            const name = nameEl?.textContent.toLowerCase() || '';
            const artist = artistEl?.textContent.toLowerCase() || '';

            if (name.includes(searchText) || artist.includes(searchText)) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
    }

    // 排序歌曲

    function sortSongs() {
        const sortValue = document.getElementById('song-sort')?.value;
        if (!sortValue) {
            // 恢复默认顺序 - 重新渲染
            if (typeof app.currentPlaylistView === 'number') {
                app.viewPlaylistDetails(app.currentPlaylistView);
            } else if (typeof app.currentPlaylistView === 'string') {
                app.viewSystemList(app.currentPlaylistView);
            }
            return;
        }

        const [field, order] = sortValue.split('-');
        const tbody = document.querySelector('.songs-table');
        const rows = Array.from(document.querySelectorAll('.song-row'));

        rows.sort((a, b) => {
            let aValue, bValue;

            if (field === 'name') {
                aValue = a.querySelector('.song-col-name')?.textContent || '';
                bValue = b.querySelector('.song-col-name')?.textContent || '';
            } else if (field === 'artist') {
                aValue = a.querySelector('.song-col-artist')?.textContent || '';
                bValue = b.querySelector('.song-col-artist')?.textContent || '';
            }

            const comparison = aValue.localeCompare(bValue, 'zh-CN');
            return order === 'asc' ? comparison : -comparison;
        });

        // 重新插入排序后的行
        const header = tbody.querySelector('.songs-table-header');
        rows.forEach(row => tbody.appendChild(row));
    }

    // 查看所有歌曲

    function viewAllSongs() {
        const data = app.currentUserData?.data;
        if (!data) return;

        app.currentPlaylistView = 'all';

        // 收集所有歌曲
        let allSongs = [];

        // 添加试听列表
        if (data.defaultList && data.defaultList.length) {
            data.defaultList.forEach(song => {
                allSongs.push({ ...song, _source: '试听列表' });
            });
        }

        // 添加我的收藏
        if (data.loveList && data.loveList.length) {
            data.loveList.forEach(song => {
                allSongs.push({ ...song, _source: '我的收藏' });
            });
        }

        // 添加自定义列表中的歌曲
        if (data.userList && data.userList.length) {
            data.userList.forEach(list => {
                if (list.list && list.list.length) {
                    list.list.forEach(song => {
                        allSongs.push({ ...song, _source: list.name });
                    });
                }
            });
        }

        let content = `
            <div class="playlist-detail-header">
                <button data-admin-action="render-playlists" class="btn-back">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
                    </svg>
                    返回列表
                </button>
                <h3>所有歌曲</h3>
                <div class="playlist-detail-meta">
                    <span>总计 ${allSongs.length} 首歌曲</span>
                </div>
            </div>
        `;

        if (allSongs.length) {
            content += `
                <div class="search-sort-bar">
                    <div class="search-box">
                        <input type="text" id="song-search" placeholder="搜索歌曲、歌手..." data-admin-action="filter-songs">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                        </svg>
                    </div>
                    <select id="song-sort" data-admin-action="sort-songs" class="sort-select">
                        <option value="">默认排序</option>
                        <option value="name-asc">歌曲名 ↑</option>
                        <option value="name-desc">歌曲名 ↓</option>
                        <option value="artist-asc">歌手 ↑</option>
                        <option value="artist-desc">歌手 ↓</option>
                        <option value="source-asc">所属列表 ↑</option>
                        <option value="source-desc">所属列表 ↓</option>
                    </select>
                </div>
            `;
            content += '<div class="songs-table">';
            content += `
                <div class="songs-table-header">
                    <div class="song-col-index">#</div>
                    <div class="song-col-name">歌曲</div>
                    <div class="song-col-artist">歌手</div>
                    <div class="song-col-playlist">所属列表</div>
                </div>
            `;

            allSongs.forEach((song, songIndex) => {
                content += `
                    <div class="song-row">
                        <div class="song-col-index">${songIndex + 1}</div>
                        ${app.renderSongNameCell(song)}
                        <div class="song-col-artist" title="${app.escapeHtml(song.singer || '未知歌手')}">${app.escapeHtml(song.singer || '未知歌手')}</div>
                        <div class="song-col-playlist">${app.escapeHtml(song._source)}</div>
                    </div>
                `;
            });

            content += '</div>';
        } else {
            content += '<p style="color: var(--text-secondary); padding: 2rem; text-align: center;">暂无歌曲</p>';
        }

        document.getElementById('data-content').innerHTML = content;
    }
    return {
        bindDataEvents,
        loadUserData,
        renderPlaylists,
        viewPlaylistDetails,
        deletePlaylist,
        deleteSong,
        viewSystemList,
        editPlaylistName,
        updateBatchDeleteBtn,
        toggleAllSongs,
        selectAllSongs,
        invertSelection,
        clearSelection,
        batchDeleteSongs,
        filterSongs,
        sortSongs,
        viewAllSongs,
    };
}
