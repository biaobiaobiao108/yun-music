// Single-song operations keep their legacy window exports for inline handlers.
// @ts-nocheck
import { getDownloadManager, isAdminSessionActive } from '../player_services';
const globalState = window as any;
function getSongQualitySize(song, quality) {
    const maps = [
        song?._types,
        song?._qualitys,
        song?.meta?._types,
        song?.meta?._qualitys
    ];
    for (const map of maps) {
        const size = map?.[quality]?.size;
        if (size && size !== '0 B') return size;
    }

    const lists = [
        song?.types,
        song?.qualitys,
        song?.meta?.types,
        song?.meta?.qualitys
    ];
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        const size = list.find(t => (t?.type || t) === quality)?.size;
        if (size && size !== '0 B') return size;
    }

    return null;
}

const remoteQualitySizeCache = new Map();

const QUALITY_SOURCE_LABELS = {
    tx: 'TX',
    wy: 'WY'
};

function getSongQualityCacheKey(song, quality) {
    const meta = song?.meta || {};
    const source = song?.source || meta.source || '';
    const id = song?.songmid || song?.songId || song?.id || meta.songId || meta.songmid || '';
    return `${source}:${id}:${quality}`;
}

function getSongQualityResolvedSource(song, quality) {
    return song?._resolvedQualitySources?.[quality] || null;
}

function applySongQualityProbe(song, quality, probe) {
    if (!song || !quality || !probe) return;

    const size = probe.size || null;
    const source = probe.source || null;

    // Older favorites only contain the qualities known when they were saved.
    // Always create a canonical entry so newly supported qualities can be read
    // back by getSongQualitySize after the remote probe succeeds.
    if (!song._types || typeof song._types !== 'object' || Array.isArray(song._types)) {
        song._types = {};
    }
    if (!song._types[quality] || typeof song._types[quality] !== 'object') {
        song._types[quality] = {};
    }
    if (size) song._types[quality].size = size;

    if (source) {
        if (!song._resolvedQualitySources || typeof song._resolvedQualitySources !== 'object') {
            song._resolvedQualitySources = {};
        }
        song._resolvedQualitySources[quality] = source;
    }

    const maps = [song._types, song._qualitys, song.meta?._types, song.meta?._qualitys];
    maps.forEach(map => {
        if (!map?.[quality]) return;
        if (size) map[quality].size = size;
        if (source) map[quality].resolvedSource = source;
    });

    const lists = [song.types, song.qualitys, song.meta?.types, song.meta?.qualitys];
    lists.forEach(list => {
        if (!Array.isArray(list)) return;
        const item = list.find(t => (t?.type || t) === quality);
        if (item && typeof item === 'object') {
            if (size) item.size = size;
            if (source) item.resolvedSource = source;
        }
    });
}

async function fetchRemoteQualitySize(song, quality) {
    const cacheKey = getSongQualityCacheKey(song, quality);
    if (remoteQualitySizeCache.has(cacheKey)) {
        const cachedProbe = remoteQualitySizeCache.get(cacheKey);
        applySongQualityProbe(song, quality, cachedProbe);
        return cachedProbe;
    }

    try {
        const authHeaders = typeof globalState.getUserAuthHeaders === 'function' ? globalState.getUserAuthHeaders() : {};
        const res = await fetch('/api/music/quality/size', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders
            },
            body: JSON.stringify({ songInfo: song, quality })
        });
        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        const probe = {
            size: data?.size || null,
            bytes: Number(data?.bytes) || 0,
            source: data?.source || null,
            resolvedQuality: data?.type || quality,
            sourceName: data?.sourceName || ''
        };
        applySongQualityProbe(song, quality, probe);
        remoteQualitySizeCache.set(cacheKey, probe);
        return probe;
    } catch (e) {
        console.warn(`[QualitySize] 获取 ${quality} 真实大小失败:`, e);
        // Do not make a transient source/network failure permanent for this tab.
        remoteQualitySizeCache.delete(cacheKey);
        return null;
    }
}

async function buildQualityOptionLabels(song, qualities) {
    const unresolvedQualities = qualities.filter(q => !getSongQualitySize(song, q) || !getSongQualityResolvedSource(song, q));
    if (unresolvedQualities.length > 0) {
        window.showLoading?.('正在读取音质大小...');
        try {
            await Promise.all(unresolvedQualities.map(q => fetchRemoteQualitySize(song, q)));
        } finally {
            window.hideLoading?.();
        }
    }

    return qualities.map(q => getQualityOptionLabel(song, q));
}

function getQualityOptionLabel(song, quality) {
    const name = window.QualityManager ? window.QualityManager.getQualityDisplayName(quality) : quality;
    const size = getSongQualitySize(song, quality) || '未知大小';
    const source = getSongQualityResolvedSource(song, quality);
    const sourceLabel = source ? (QUALITY_SOURCE_LABELS[source] || String(source).toUpperCase()) : '';
    return `${name} [${size}${sourceLabel ? ` · ${sourceLabel}` : ''}]`;
}

function getSelectableQualityOrder(song = null) {
    if (song && window.QualityManager?.getSelectableQualities) {
        return window.QualityManager.getSelectableQualities(song);
    }
    return window.QualityManager?.QUALITY_ORDER_LOW_TO_HIGH ||
        (window.QualityManager?.QUALITY_PRIORITY ? [...window.QualityManager.QUALITY_PRIORITY].reverse() : ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master']);
}

// Single song deletion
async function deleteSingleSong(songId) {
    if (!(await globalState.showSelect('删除歌曲', '确定要删除这首歌曲吗?', { danger: true }))) {
        return;
    }

    // 公开列表删除需要管理员权限
    if (typeof globalState.requireAdminForOpenWrite === 'function') {
        if (!(await globalState.requireAdminForOpenWrite('删除公开列表中的歌曲'))) return;
    }

    const listContext = typeof window.getEditableListContext === 'function'
        ? window.getEditableListContext()
        : null;
    const activeListId = listContext?.listId || globalState.getCurrentActiveListId();
    if (!activeListId || !globalState.currentListData || (listContext && !Array.isArray(listContext.list))) {
        globalState.showError('无法确定当前列表');
        return;
    }

    const normalizedSongId = String(songId);

    try {
        const res = await fetch('/api/music/user/list/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ listId: activeListId, songIds: [normalizedSongId] })
        });
        if (!res.ok) throw new Error((await res.text()) || '删除失败');
        await globalState.refreshUserListData?.();
        globalState.handleListClick(activeListId);
    } catch (e) {
        globalState.showError('删除失败: ' + e.message);
        console.error('[Single] 删除错误:', e);
    }
}

/**
 * 辅助函数：根据设置触发服务器端歌词缓存
 * @param {Object} song 歌曲信息
 * @param {String} quality 音质
 * @param {Boolean} force 是否强制同步（忽略设置开关，用于手动点击按钮）
 */
async function requestServerLyricCache(song, quality = null, force = false) {
    if (!force && (typeof globalState.settings === 'undefined' || globalState.settings.enableServerLyricCache === false)) return false;

    console.log(`[Lyric] 尝试同步下载歌词缓存: ${song.name} (${quality || 'auto'})`);
    try {
        const meta = song.meta || {};
        const source = song.source || meta.source || '';
        const songmid = song.songmid || song.songId || meta.songmid || meta.songId || song.id || '';
        const nameValue = song.name || meta.songName || '';
        const singerValue = song.singer || meta.singerName || '';
        const name = encodeURIComponent(nameValue);
        const singer = encodeURIComponent(singerValue);
        const hash = song.hash || meta.hash || '';
        const interval = song.interval || meta.interval || '';

        if (!source || !songmid) {
            console.warn('[Lyric] 歌曲缺少必要字段，跳过歌词缓存同步:', song);
            return false;
        }

        // 1. 先尝试获取歌词数据
        const lyricUrl = `/api/music/lyric?source=${source}&songmid=${songmid}&name=${name}&singer=${singer}&hash=${hash}&interval=${interval}`;
        const lRes = await fetch(lyricUrl);
        if (!lRes.ok) return false;
        const lyricInfo = await lRes.json();

        if (!lyricInfo || (!lyricInfo.lyric && !lyricInfo.lrc)) return false;

        // 2. 将歌词推送到服务器缓存接口
        const cacheUrl = `/api/music/cache/lyric`;
        const headers = {
            'Content-Type': 'application/json',
        ...globalState.getUserAuthHeaders()
        };

        // 构建包含音质信息的 songInfo
        const songInfoForCache = {
            ...song,
            source,
            songmid,
            songId: song.songId || meta.songId || songmid,
            name: nameValue,
            singer: singerValue,
            hash,
            interval
        };
        if (quality) songInfoForCache.quality = quality;

        const enableOnlyDownloadMode = window.settings?.enableOnlyDownloadMode || false;

        const cacheRes = await fetch(cacheUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                songInfo: songInfoForCache,
                lyricsObj: lyricInfo,
                enableOnlyDownloadMode
            })
        });
        if (!cacheRes.ok) throw new Error('Lyric cache request failed');
        console.log(`[Lyric] 歌曲下载触发的歌词缓存同步成功: ${song.name} (仅下载模式: ${enableOnlyDownloadMode})`);
        return true;
    } catch (e) {
        console.warn(`[Lyric] 自动同步歌词缓存失败: ${song.name}`, e);
        if (force) throw e;
        return false;
    }
}

function getDefaultDownloadTarget() {
    return window.settings?.defaultDownloadTarget === 'browser' ? 'browser' : 'server';
}

function getDefaultDownloadQuality() {
    return window.settings?.defaultDownloadQuality || window.settings?.preferredQuality || 'flac';
}

// Download single song
export async function downloadSong(songOrId, forceQuality = null, suppressAlerts = false, skipPromptTarget = null) {
    let song;
    if (typeof songOrId === 'object') {
        song = songOrId;
    } else {
        if (!currentPlaylist) return false;
        song = currentPlaylist.find(s => s.id === songOrId);
    }

    if (!song) {
        if (!suppressAlerts) globalState.showError('未找到歌曲信息');
        return false;
    }

    // 权限校验：公开受限模式下，如果管理员关闭了“缓存歌曲文件”功能，则下载/缓存歌曲需要验证管理员身份
    const isPublic = !globalState.isUserLoggedIn() || !window.currentListData?.username || window.currentListData?.username === 'default' || window.currentListData?.username === '_open';
    const enablePublicRestriction = window.lx_config?.['user.enablePublicRestriction'];
    const isAdmin = isAdminSessionActive();
    const isServerCacheAllowed = window.settings?.enableServerCache === true;

    if (isPublic && enablePublicRestriction && !isServerCacheAllowed && !isAdmin) {
        globalState.showError('权限限制：管理员已关闭缓存歌曲功能，下载歌曲需要验证管理员身份。');
        if (typeof window.handleAdminAuth === 'function') {
            const authorized = await window.handleAdminAuth('管理员已关闭缓存歌曲文件功能，下载歌曲需要验证管理员身份');
            if (!authorized) return false;
        } else {
            return false;
        }
    }

    const isOnlyDownload = window.settings?.enableOnlyDownloadMode === true;
    const actionLabel = isOnlyDownload ? '下载到服务器' : '缓存到服务器';

    let selected = skipPromptTarget;
    if (!selected) selected = getDefaultDownloadTarget() === 'browser' ? '浏览器下载' : actionLabel;
    if (!selected) return false;

    if (selected === '浏览器下载') {
        const downloadManager = getDownloadManager();
        if (downloadManager) {
            const targetQuality = forceQuality || getDefaultDownloadQuality();

            downloadManager.addTasks([{
                ...song,
                quality: targetQuality
            }]);

            // [新增] 如果开启了服务器歌词缓存，下载时自动同步
            // requestServerLyricCache(song, targetQuality); // [Removed] Delay until success

            if (!suppressAlerts) globalState.showInfo(`已添加任务，您可以在右侧下载管理面板查看进度`);
            return true;
        } else {
            globalState.showError('下载管理器未就绪');
            return false;
        }
    } else if (selected && (selected.startsWith('缓存到服务器') || selected.startsWith('下载到服务器'))) {
        const targetQuality = forceQuality || getDefaultDownloadQuality();
        const checkResult = await window.checkServerCache?.(song, targetQuality);
        const isCached = checkResult?.exists && !checkResult?.isCollision;

        if (!isOnlyDownload && isCached) {
            globalState.showInfo('该歌曲已在服务器缓存');
            return false;
        }
        if (isPublic && enablePublicRestriction && !isServerCacheAllowed && !isAdmin) {
            globalState.showError('权限限制：缓存到服务器需要验证管理员。');
            if (typeof window.handleAdminAuth === 'function') {
                const authorized = await window.handleAdminAuth('缓存到服务器需要验证管理员身份');
                if (!authorized) return false;
            } else {
                return false;
            }
        }

        try {
            // [Unified] 统一交给下载管理器调度
            const downloadManager = getDownloadManager();
            if (downloadManager) {
                downloadManager.addTasks([{
                    ...song,
                    taskId: 'server_' + (song.id || song.songmid),
                    isServer: true,
                    quality: targetQuality // Let DM handle best quality resolution
                }]);
                if (!suppressAlerts) globalState.showInfo(`已添加云端缓存任务`);
                return true;
            } else {
                globalState.showError('下载管理器未就绪');
                return false;
            }
        } catch (e) {
            if (!suppressAlerts) globalState.showError('操作失败: ' + e.message);
            return false;
        }
    }
    return false;
}

// Batch download function shared by list selection and album downloads.
async function batchDownloadSongs(songsToDownload, batchOptions = {}) {
    if (!Array.isArray(songsToDownload) || songsToDownload.length === 0) {
        globalState.showError(batchOptions.emptyMessage || '未找到要下载的歌曲');
        return false;
    }

    // 权限校验：公开受限模式下，如果管理员关闭了“缓存歌曲文件”功能，则批量下载/缓存歌曲需要验证管理员身份
    const isPublic = !globalState.isUserLoggedIn() || !window.currentListData?.username || window.currentListData?.username === 'default' || window.currentListData?.username === '_open';
    const enablePublicRestriction = window.lx_config?.['user.enablePublicRestriction'];
    const isAdmin = isAdminSessionActive();
    const isServerCacheAllowed = window.settings?.enableServerCache === true;

    if (isPublic && enablePublicRestriction && !isServerCacheAllowed && !isAdmin) {
        globalState.showError('权限限制：管理员已关闭缓存歌曲功能，批量下载需要验证管理员身份。');
        if (typeof window.handleAdminAuth === 'function') {
            const authorized = await window.handleAdminAuth('管理员已关闭缓存歌曲文件功能，批量下载需要验证管理员身份');
            if (!authorized) return false;
        } else {
            return false;
        }
    }

    const clearSelection = batchOptions.clearSelection !== false;
    const selectedTarget = batchOptions.target === 'browser' || batchOptions.target === 'server'
        ? batchOptions.target
        : getDefaultDownloadTarget();
    const targetQuality = batchOptions.quality || getDefaultDownloadQuality();

    if (selectedTarget === 'browser') {
        const downloadManager = getDownloadManager();
        if (downloadManager) {
            const tasks = songsToDownload.map(s => ({
                ...s,
                quality: targetQuality
            }));

            await downloadManager.addTasks(tasks);

            /* // [Removed] Delay until success
            if (typeof globalState.settings !== 'undefined' && globalState.settings.enableServerLyricCache !== false) {
                songsToDownload.forEach(s => {
                    const actualQuality = window.QualityManager ? window.QualityManager.getBestQuality(s, targetQuality) : targetQuality;
                    requestServerLyricCache(s, actualQuality);
                });
            }
            */

            globalState.showInfo(`已将 ${songsToDownload.length} 项任务添加到下载列表，您可以前往右侧下载管理面板查看进度`);
            if (clearSelection) {
                if (typeof exitBatchMode === 'function') exitBatchMode();
                else if (typeof deselectAll === 'function') deselectAll();
            }
            return true;
        } else {
            globalState.showError('下载管理器未就绪');
            return false;
        }
    } else if (selectedTarget === 'server') {
        if (isPublic && enablePublicRestriction && !isServerCacheAllowed && !isAdmin) {
            globalState.showError('权限限制：缓存到服务器需要验证管理员。');
            if (typeof window.handleAdminAuth === 'function') {
                const authorized = await window.handleAdminAuth('缓存到服务器需要验证管理员身份');
                if (!authorized) return false;
            } else {
                return false;
            }
        }

        const downloadManager = getDownloadManager();
        if (!downloadManager) {
            globalState.showError('下载管理器未就绪');
            return false;
        }

        // 1. 直接将歌曲注册到下载管理器，由其内部调度器控制并发
        const tasks = songsToDownload.map(s => {
            return {
                ...s,
                taskId: 'server_' + (s.id || s.songmid),
                isServer: true,
                quality: targetQuality // 调度器启动时会重新计算最佳音质
            };
        });
        await downloadManager.addTasks(tasks);

        if (clearSelection) {
            if (typeof exitBatchMode === 'function') exitBatchMode();
            else if (typeof deselectAll === 'function') deselectAll();
        }
        globalState.showInfo(`已将 ${songsToDownload.length} 首歌曲加入缓存队列`);
        return true;
    }

    return false;
}

async function batchDownloadFromList() {
    if (selectedItems.size === 0) {
        globalState.showError('请先选择要下载的歌曲');
        return false;
    }

    // Convert IDs to Songs
    const songsToDownload = [];
    const findSong = (list, id) => list.find(s => String(s.id) === String(id));

    selectedItems.forEach(id => {
        let song = null;
        if (selectedSongObjects && selectedSongObjects.has(id)) song = selectedSongObjects.get(id);
        if (!song && typeof globalState.viewingPlaylist !== 'undefined' && globalState.viewingPlaylist) song = findSong(globalState.viewingPlaylist, id);
        if (!song && currentPlaylist) song = findSong(currentPlaylist, id);
        if (!song && globalState.currentListData) {
            if (globalState.currentListData.defaultList) song = findSong(globalState.currentListData.defaultList, id);
            if (!song && globalState.currentListData.loveList) song = findSong(globalState.currentListData.loveList, id);
            if (!song && globalState.currentListData.userList) {
                for (const uList of globalState.currentListData.userList) {
                    song = findSong(uList.list, id);
                    if (song) break;
                }
            }
        }
        if (song) songsToDownload.push(song);
    });

    if (songsToDownload.length === 0) {
        globalState.showError('未找到选中歌曲的详细信息');
        return false;
    }

    return batchDownloadSongs(songsToDownload);
}

// Re-use helper functions from batch_pagination.js
function getListById(listId) {
    if (!globalState.currentListData) return null;
    if (listId === 'default') return globalState.currentListData.defaultList;
    if (listId === 'love') return globalState.currentListData.loveList;
    const userList = globalState.currentListData.userList.find(l => l.id === listId);
    return userList ? userList.list : null;
}

function setListById(listId, newList) {
    if (!globalState.currentListData) return;
    if (listId === 'default') globalState.currentListData.defaultList = newList;
    else if (listId === 'love') globalState.currentListData.loveList = newList;
    else {
        const userList = globalState.currentListData.userList.find(l => l.id === listId);
        if (userList) userList.list = newList;
    }
}

// Export functions
window.deleteSingleSong = deleteSingleSong;
window.downloadSong = downloadSong;
window.batchDownloadSongs = batchDownloadSongs;
window.batchDownloadFromList = batchDownloadFromList;
window.requestServerLyricCache = requestServerLyricCache;
