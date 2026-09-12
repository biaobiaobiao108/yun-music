import { safeInlineJson } from '../player_security';

export interface CacheFeatureContext {
    getUserAuthHeaders: () => Record<string, string>;
    isUserLoggedIn: () => boolean;
    isAdminSessionActive: () => boolean;
    getSettings: () => any;
    setSettings: (settings: any) => void;
    persistSettings: () => void;
    pushSettingsToServer: () => Promise<void>;
    setPlayerDrawerOpen: (drawerId: string, open: boolean) => void;
    showSelect: (...args: any[]) => Promise<boolean>;
    showSuccess: (message: string) => void;
    showInfo: (message: string) => void;
    showError: (message: string) => void;
    escapeHtmlText: (value: any) => string;
    defaultSettings: any;
    getDownloadStatusHtml: (icon: string, message: string, loading?: boolean) => string;
}

export function initCacheFeature(context: CacheFeatureContext) {
    const getUserAuthHeaders = context.getUserAuthHeaders;
    const isUserLoggedIn = context.isUserLoggedIn;
    const isAdminSessionActive = context.isAdminSessionActive;
    let settings = context.getSettings();
    const persistSettings = context.persistSettings;
    const pushSettingsToServer = context.pushSettingsToServer;
    const setPlayerDrawerOpen = context.setPlayerDrawerOpen;
    const showSelect = context.showSelect;
    const showSuccess = context.showSuccess;
    const showInfo = context.showInfo;
    const showError = context.showError;
    const escapeHtmlText = context.escapeHtmlText;
    const DEFAULT_SETTINGS = context.defaultSettings;
    const getDownloadStatusHtml = context.getDownloadStatusHtml;

async function calcStorageUsage() {
    try {
        // 1. 优先使用原生 API 获取包含 IndexedDB 的准确占用
        if (navigator.storage && navigator.storage.estimate) {
            const estimate = await navigator.storage.estimate();
            const total = estimate.usage || 0;
            if (total > 0) {
                if (total < 1024) return total + ' B';
                if (total < 1024 * 1024) return (total / 1024).toFixed(2) + ' KB';
                return (total / (1024 * 1024)).toFixed(2) + ' MB';
            }
        }
    } catch (e) {
        console.warn('[Storage] 无法使用 Storage Estimate API:', e);
    }

    // 2. 回退到手动计算 localStorage (兜底)
    let total = 0;
    for (let x in localStorage) {
        if (!localStorage.hasOwnProperty(x)) continue;
        const val = localStorage.getItem(x);
        if (val) total += (x.length + val.length) * 2;
    }
    if (total < 1024) return total + ' B';
    if (total < 1024 * 1024) return (total / 1024).toFixed(2) + ' KB';
    return (total / (1024 * 1024)).toFixed(2) + ' MB';
}

async function updateStorageStatsUI() {
    const el = document.getElementById('storage-usage-info');
    if (el) {
        el.innerText = await calcStorageUsage();
    }
}

async function resetAllSettings() {
    const ok = await showSelect('重置所有设置', '确定要重置吗？这不会删除您的歌单，但会恢复音质、列表显示、主题等设置到默认状态。 (Restore all settings to default?)', { danger: true });
    if (!ok) return;
    try {
        // Reset to default
        context.setSettings({ ...DEFAULT_SETTINGS });
        settings = context.getSettings();
        window.settings = settings;
        persistSettings();
        localStorage.removeItem('lx_playback_state'); // 同时重置播放进度记忆

        // If sync enabled, push to server
        if (settings.saveAccountSettingsToFile) {
            await pushSettingsToServer();
        }

        showSuccess('设置已重置，正在重新加载页面...');
        setTimeout(() => {
            window.location.reload();
        }, 1500);
    } catch (e) {
        showError('重置失败: ' + e.message);
    }
}

async function clearCache(type) {
    if (!(await showSelect('清除缓存', '确定要清除本地缓存吗？', { danger: true }))) return;

    let clearServerLyric = false;
    if (type === 'lyric') {
        clearServerLyric = await showSelect('清除缓存', '是否同时清除本地缓存文件夹内的歌词LRC文件？', { danger: true });

        if (clearServerLyric) {
            const isLogined = isUserLoggedIn();
            const isPublicUser = !window.currentListData || !window.currentListData.username || window.currentListData.username === 'default';
            if (isPublicUser && window.lx_config && window.lx_config['user.enablePublicRestriction'] && !isLogined) {
                const isAdminSession = isAdminSessionActive();
                const enableServerLyricCache = window.settings && window.settings.enableServerLyricCache === true;
                if (!enableServerLyricCache && !isAdminSession) {
                    if (typeof window.handleAdminAuth === 'function') {
                        const authorized = await window.handleAdminAuth('清除服务器歌词缓存需要管理员身份');
                        if (!authorized) {
                            // 验证失败或取消时，只取消服务端歌词清理，不影响浏览器层面的缓存清理
                            clearServerLyric = false;
                        }
                    } else {
                        showError('清除服务器歌词缓存受限，需要管理员身份');
                        clearServerLyric = false;
                    }
                }
            }
        }
    }

    let count = 0;
    const keysToRemove = [];

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        // [Fix] 统一使用 lx_lyric_ 和 lx_url_ 前缀进行清理
        if (type === 'lyric' && key.startsWith('lx_lyric_')) {
            keysToRemove.push(key);
        } else if (type === 'url' && key.startsWith('lx_url_')) {
            keysToRemove.push(key);
        }
    }

    keysToRemove.forEach(k => {
        localStorage.removeItem(k);
        count++;
    });

    updateStorageStatsUI();
    const mapFromName = { 'lyric': '歌词', 'url': '链接' };
    showSuccess(`已清除 ${count} 条${mapFromName[type] || ''}本地缓存`);

    if (clearServerLyric) {
        try {
            const username = (window.currentListData && window.currentListData.username) || '';
            const headers = {};
            Object.assign(headers, getUserAuthHeaders());

            const res = await fetch('/api/music/cache/lyric/clear', { method: 'POST', headers });
            const data = await res.json();
            if (data.success) {
                showSuccess(`已同时清除 ${data.data.deletedCount} 个本地LRC文件`);
                // 刷新缓存列表（如果在看列表的话）
                const drawer = document.getElementById('cache-drawer');
                if (drawer && !drawer.classList.contains('translate-x-full')) {
                    refreshCacheList();
                }
                updateServerCacheSize();
            } else {
                throw new Error(data.message || '清除失败');
            }
        } catch (e) {
            showError('清除本地LRC文件失败: ' + e.message);
        }
    }
}

// 更新服务器缓存大小统计
async function updateServerCacheSize() {
    const cacheEl = document.getElementById('server-cache-info');
    const musicEl = document.getElementById('server-music-info');
    if (!cacheEl && !musicEl) return;

    const formatSize = (size) => {
        if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB';
        if (size >= 1024) return (size / 1024).toFixed(2) + ' KB';
        return size + ' B';
    };

    try {
        if (cacheEl) cacheEl.textContent = '计算中...';
        if (musicEl) musicEl.textContent = '计算中...';

        const headers = getUserAuthHeaders();
        const response = await fetch('/api/music/cache/stats', { headers });
        if (!response.ok) throw new Error('获取缓存统计失败');

        const data = await response.json();
        if (data.success && data.data) {
            const stats = data.data;

            if (musicEl && stats.music) {
                musicEl.textContent = `音乐: ${formatSize(stats.music.totalSize)} (${stats.music.fileCount} 首)`;
            }
            if (cacheEl && stats.cache) {
                cacheEl.textContent = `缓存: ${formatSize(stats.cache.totalSize)} (${stats.cache.fileCount} 首)`;
            }
        } else {
            throw new Error(data.message || '获取失败');
        }
    } catch (e) {
        console.warn('[Cache] 更新服务端统计失败:', e);
        if (cacheEl) cacheEl.textContent = '获取失败';
        if (musicEl) musicEl.textContent = '获取失败';
    }
}

// --- 服务器缓存管理 (Server Cache Management) ---
let currentCacheList = [];
let selectedCacheFiles = new Set();
let cacheBatchMode = false;

function getCacheItemKey(item) {
    return `${item.folder}\u0000${item.filename}`;
}

function getSelectedCacheItems() {
    return currentCacheList.filter(item => selectedCacheFiles.has(getCacheItemKey(item)));
}

function toggleCacheDrawer() {
    const drawer = document.getElementById('cache-drawer');
    if (drawer) {
        const isHidden = drawer.classList.contains('translate-x-full');
        if (isHidden) {
            setPlayerDrawerOpen('cache-drawer', true);
            refreshCacheList();
        } else {
            setPlayerDrawerOpen('cache-drawer', false);
            exitCacheBatchMode(); // 关闭时重置状态
        }
    }
}

async function refreshCacheList() {
    const container = document.getElementById('cache-list-container');
    container.innerHTML = getDownloadStatusHtml('fa-spinner', '正在重新扫描文件并刷新列表...', true);

    try {
        const username = (window.currentListData && window.currentListData.username) || '';
        const headers = getUserAuthHeaders();

        // 刷新前先强制触发服务器端的磁盘同步/索引重建
        await fetch('/api/music/cache/sync', { method: 'POST', headers });

        const res = await fetch('/api/music/cache/list', { headers });
        const data = await res.json();

        if (data.success) {
            currentCacheList = data.data;
            renderCacheList();
            updateCacheHeaderStats();
        } else {
            throw new Error(data.message || '加载列表失败');
        }
    } catch (e) {
        container.innerHTML = `<div class="p-10 text-center t-text-muted text-sm">${escapeHtmlText(e.message)}</div>`;
    }
}

function updateCacheHeaderStats() {
    const countEl = document.getElementById('cache-list-count');
    const sizeEl = document.getElementById('cache-total-size');
    if (countEl) countEl.textContent = `${currentCacheList.length} CACHED FILES`;

    const totalSize = currentCacheList.reduce((acc, curr) => acc + (curr.size || 0), 0);
    if (sizeEl) sizeEl.textContent = (totalSize / (1024 * 1024)).toFixed(2) + ' MB';

    // 更新设置页面的简易统计（如果有）
    updateServerCacheSize();
}

function renderCacheList() {
    const container = document.getElementById('cache-list-container');
    if (currentCacheList.length === 0) {
        container.innerHTML = getDownloadStatusHtml('fa-cloud-download-alt', '暂无服务器缓存歌曲');
        return;
    }

    container.innerHTML = currentCacheList.map((item, idx) => {
        const isSelected = selectedCacheFiles.has(getCacheItemKey(item));

        // 样式同步：使用主列表的来源标签生成函数
        const sourceTagHtml = window.getSourceTag ? window.getSourceTag(item.source) : `<span class="px-1 py-0 rounded text-[10px] font-bold border t-badge-red mr-1">${escapeHtmlText(String(item.source || '').toUpperCase())}</span>`;

        // 样式同步：匹配 getQualityTags 的逻辑
        let qTagHtml = '';
        const q = (item.quality || '').toLowerCase();
        const qName = escapeHtmlText(window.QualityManager?.getQualityDisplayName(q) || q.toUpperCase());

        if (q === 'master') {
            qTagHtml = `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-purple border border-purple-200 dark:border-purple-500/30 transition-colors">${qName}</span>`;
        } else if (q === 'atmos' || q === 'atmos_plus') {
            qTagHtml = `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-blue border border-cyan-200 dark:border-cyan-500/30 transition-colors">${qName}</span>`;
        } else if (q === 'flac24bit' || q === 'hires' || q === 'hr') {
            qTagHtml = `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-yellow border border-yellow-200 dark:border-yellow-500/30 transition-colors">${qName}</span>`;
        } else if (q === 'flac' || q === 'sq' || q === 'ape') {
            qTagHtml = `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-green border border-emerald-200 dark:border-emerald-500/30 transition-colors">${qName}</span>`;
        } else if (q === '320k' || q === 'hq') {
            qTagHtml = `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-blue border border-blue-200 dark:border-blue-500/30 transition-colors">${qName}</span>`;
        } else if (q === '128k' || q === 'mq' || q === 'standard') {
            qTagHtml = `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-gray border t-border-main transition-colors">${qName}</span>`;
        } else {
            qTagHtml = `<span class="flex-shrink-0 px-1 py-0 rounded text-[10px] t-badge-red border border-red-200 dark:border-red-500/30 transition-colors">${qName}</span>`;
        }

        const username = (window.currentListData && window.currentListData.username) || '';
        const coverUrl = item.hasCover
            ? `/api/music/cache/cover?filename=${encodeURIComponent(item.filename)}&user=${encodeURIComponent(username)}`
            : '/music/assets/yun-yin.png';
        const itemName = escapeHtmlText(item.name || '未命名歌曲');
        const itemSinger = escapeHtmlText(item.singer || '未知歌手');
        const itemAlbum = escapeHtmlText(item.album || '');
        const itemJson = safeInlineJson(item);

        return `
            <div class="group flex items-center p-2.5 rounded-2xl hover:t-bg-panel-light transition-all duration-300 gap-3 border border-transparent 
                ${isSelected ? 't-bg-panel-light border-blue-500/30 ring-1 ring-blue-500/10' : ''}"
                ${cacheBatchMode ? `data-event-click-action="toggleCacheSelection" data-event-click-args="[${idx}]"` : ''}>
                
                ${cacheBatchMode ? `
                <div class="flex-shrink-0 w-5 flex items-center justify-center">
                    <div class="w-4 h-4 rounded border-2 transition-all flex items-center justify-center
                        ${isSelected ? 'bg-blue-500 border-blue-500 shadow-sm' : 'border-gray-300 dark:border-gray-600'}">
                        ${isSelected ? '<i class="fas fa-check text-[8px] text-white"></i>' : ''}
                    </div>
                </div>
                ` : ''}

                <div class="relative w-12 h-12 flex-shrink-0 group-hover:scale-105 transition-transform duration-500">
                    <img class="w-full h-full object-cover rounded-xl shadow-md bg-gray-100" alt="${escapeHtmlText(item.filename || '缓存歌曲')}封面" width="48" height="48" loading="lazy" decoding="async"
                         src="${escapeHtmlText(coverUrl)}"
                         data-event-error-action="fallback-image">
                    <div class="absolute inset-0 bg-black/5 rounded-xl"></div>
                </div>

                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-black t-text-main truncate tracking-tight">${itemName}</span>
                    </div>
                    <div class="flex items-center flex-wrap gap-1 mt-0.5">
                        ${sourceTagHtml}
                        ${qTagHtml}
                        <span class="text-[10px] font-bold t-text-muted truncate opacity-60">${itemSinger}</span>
                        ${item.album ? `<span class="text-[10px] t-text-muted opacity-40 ml-1 truncate">· ${itemAlbum}</span>` : ''}
                    </div>
                    ${item.hasLyric === true ? `
                        <div class="mt-1">
                            <span class="text-[9px] bg-emerald-500 text-white px-1.5 py-0.5 rounded font-black shadow-sm inline-flex items-center" title="歌词已同步">LRC</span>
                        </div>
                    ` : `
                        <div class="mt-1">
                            <button data-event-click-action="retryCacheLyric" data-event-click-args="[&quot;@this&quot;, ${itemJson}]" data-event-stop="true"
                                    class="text-[9px] bg-red-400 hover:bg-red-500 text-white px-1.5 py-0.5 rounded font-black shadow-sm inline-flex items-center gap-1 transition-colors" title="歌词缺失，点击尝试补全">
                                <span>LRC+</span>
                                <i class="fas fa-redo-alt text-[7px]"></i>
                            </button>
                        </div>
                    `}
                </div>

                <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    ${!cacheBatchMode ? `
                        <button data-event-click-action="removeCacheItem" data-event-click-args="[${idx}]" data-event-stop="true"
                                class="p-2 t-text-muted hover:text-red-500 transition-colors" title="删除">
                            <i class="fas fa-trash-alt text-xs"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

/**
 * 缓存列表专用的歌词重试逻辑
 */
async function retryCacheLyric(btn, item) {
    if (!window.requestServerLyricCache) return;

    // 改变按钮状态
    const originalContent = btn.innerHTML;
    const originalBg = btn.className;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin text-[8px]"></i>';
    btn.disabled = true;

    try {
        // 构造 song 格式以适配 requestServerLyricCache
        const songData = {
            id: item.id,
            songmid: item.id, // 兼容性
            name: item.name,
            singer: item.singer,
            source: item.source,
            albumName: item.album || ''
        };

        const synced = await window.requestServerLyricCache(songData, item.quality, true); // 强制补齐
        if (!synced) throw new Error('No lyric data available');

        showSuccess(`已成功补齐歌词: ${item.name}`);
        // 成功后给予反馈并刷新列表
        btn.innerHTML = 'OK';
        btn.className = btn.className.replace('bg-red-400', 'bg-emerald-500');
        setTimeout(() => refreshCacheList(), 1500);
    } catch (e) {
        btn.innerHTML = originalContent;
        btn.disabled = false;
        console.error('[Cache] Retry lyric failed:', e);
    }
}

/**
 * 缓存管理界面：一键补全所有缺失的歌词
 */
async function downloadAllCacheLyrics() {
    if (!currentCacheList || currentCacheList.length === 0) return;

    const missingItems = currentCacheList.filter(item => !item.hasLyric);
    if (missingItems.length === 0) {
        showInfo('没有缺失歌词的缓存文件');
        return;
    }

    showInfo(`正在尝试补全 ${missingItems.length} 个缓存文件的歌词...`);

    // 我们不需要 UI 上的按钮引用，直接调用逻辑
    for (const item of missingItems) {
        try {
            const songData = {
                id: item.id,
                songmid: item.id,
                name: item.name,
                singer: item.singer,
                source: item.source,
                albumName: item.album || ''
            };
            if (window.requestServerLyricCache) {
                const synced = await window.requestServerLyricCache(songData, item.quality, true); // 强制补全
                if (!synced) throw new Error('No lyric data available');
            }
            // 每首之间稍作停顿
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {
            console.warn('[Cache] Batch lyric sync error:', e);
        }
    }

    showSuccess('补全流程执行完毕');
    refreshCacheList();
}


function toggleCacheBatchMode() {
    cacheBatchMode = true;
    selectedCacheFiles.clear();
    document.getElementById('cache-batch-toolbar').classList.remove('hidden');
    document.getElementById('cache-manage-btn').classList.add('hidden');
    document.getElementById('cache-exit-batch-btn').classList.remove('hidden');
    renderCacheList();
    updateCacheBatchCount();
}

function exitCacheBatchMode() {
    cacheBatchMode = false;
    selectedCacheFiles.clear();
    document.getElementById('cache-batch-toolbar').classList.add('hidden');
    document.getElementById('cache-manage-btn').classList.remove('hidden');
    document.getElementById('cache-exit-batch-btn').classList.add('hidden');
    renderCacheList();
}

function toggleCacheSelection(index) {
    const item = currentCacheList[index];
    if (!item) return;
    const key = getCacheItemKey(item);
    if (selectedCacheFiles.has(key)) {
        selectedCacheFiles.delete(key);
    } else {
        selectedCacheFiles.add(key);
    }
    renderCacheList();
    updateCacheBatchCount();
}

function selectAllCache() {
    currentCacheList.forEach(item => selectedCacheFiles.add(getCacheItemKey(item)));
    renderCacheList();
    updateCacheBatchCount();
}

function deselectAllCache() {
    selectedCacheFiles.clear();
    renderCacheList();
    updateCacheBatchCount();
}

function updateCacheBatchCount() {
    const el = document.getElementById('cache-selected-count');
    if (el) el.textContent = selectedCacheFiles.size;
}

async function removeCacheItem(index) {
    const item = currentCacheList[index];
    if (!item) {
        showError('文件信息已失效，请刷新后重试');
        return;
    }
            const isLogined = isUserLoggedIn();
    const isPublicUser = !window.currentListData || !window.currentListData.username || window.currentListData.username === 'default';
    if (isPublicUser && window.lx_config && window.lx_config['user.enablePublicRestriction'] && !isLogined) {
        const isAdminSession = isAdminSessionActive();
        const enableServerCache = window.settings && window.settings.enableServerCache === true;
        if (!enableServerCache && !isAdminSession) {
            if (typeof window.handleAdminAuth === 'function') {
                const authorized = await window.handleAdminAuth('删除服务器缓存文件需要需要管理员身份');
                if (!authorized) return;
            } else {
                showError('删除服务器缓存文件受限，需要管理员身份');
                return;
            }
        }
    }

    if (!(await showSelect('确定删除', '确认从服务器永久删除此缓存文件吗？', { danger: true }))) return;

    try {
        const username = (window.currentListData && window.currentListData.username) || '';
        const headers = { 'Content-Type': 'application/json' };
        Object.assign(headers, getUserAuthHeaders());

        const res = await fetch('/api/music/cache/remove', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ items: [{ filename: item.filename, folder: item.folder }] })
        });

        const result = await res.json();
        if (res.ok && result.success) {
            showSuccess('已删除');
            refreshCacheList();
        } else {
            throw new Error(result.message || '删除失败');
        }
    } catch (e) {
        showError(e.message);
    }
}

async function batchDeleteCache() {
    const deleteItems = getSelectedCacheItems();
    if (deleteItems.length === 0) {
        showError('请先选择文件');
        return;
    }

    if ((!window.currentListData || !window.currentListData.username || window.currentListData.username === 'default') && window.lx_config && window.lx_config['user.enablePublicRestriction']) {
        const isAdminSession = isAdminSessionActive();
        const enableServerCache = window.settings && window.settings.enableServerCache === true;
        if (!enableServerCache && !isAdminSession) {
            if (typeof window.handleAdminAuth === 'function') {
                const authorized = await window.handleAdminAuth('批量删除服务器缓存需要需要管理员身份');
                if (!authorized) return;
            } else {
                showError('批量删除服务器缓存受限，需要管理员身份');
                return;
            }
        }
    }

    if (!(await showSelect('批量删除', `确定要删除这 ${deleteItems.length} 个缓存文件吗？`, { danger: true }))) return;

    try {
        const username = (window.currentListData && window.currentListData.username) || '';
        const headers = { 'Content-Type': 'application/json' };
        Object.assign(headers, getUserAuthHeaders());

        const res = await fetch('/api/music/cache/remove', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                items: deleteItems.map(item => ({ filename: item.filename, folder: item.folder }))
            })
        });

        const result = await res.json();
        if (result.deletedCount > 0) {
            exitCacheBatchMode();
            await refreshCacheList();
        }
        if (!res.ok || !result.success) throw new Error(result.message || '删除失败');
        showSuccess(`成功删除 ${result.deletedCount} 个文件`);
    } catch (e) {
        showError(e.message);
    }
}

async function clearServerCache() {
    if ((!window.currentListData || !window.currentListData.username || window.currentListData.username === 'default') && window.lx_config && window.lx_config['user.enablePublicRestriction']) {
        const isAdminSession = isAdminSessionActive();
        const enableServerCache = window.settings && window.settings.enableServerCache === true;
        if (!enableServerCache && !isAdminSession) {
            if (typeof window.handleAdminAuth === 'function') {
                const authorized = await window.handleAdminAuth('完全清理服务器缓存需要需要管理员身份');
                if (!authorized) return;
            } else {
                showError('完全清理服务器缓存受限，需要管理员身份');
                return;
            }
        }
    }

    if (!(await showSelect('完全清理', '确定要清除所有服务器缓存吗？', { danger: true }))) return;

    try {
        const username = (window.currentListData && window.currentListData.username) || '';
        const headers = {};
        Object.assign(headers, getUserAuthHeaders());

        const res = await fetch('/api/music/cache/clear', { method: 'POST', headers });
        if (res.ok) {
            const data = await res.json();
            showSuccess(`清理完成，释放 ${(data.data.freedSize / (1024 * 1024)).toFixed(2)} MB`);
            refreshCacheList();
            if (cacheBatchMode) exitCacheBatchMode();
        }
    } catch (e) { showError(e.message); }
}

    const feature = {
        calcStorageUsage,
        updateStorageStatsUI,
        resetAllSettings,
        clearCache,
        updateServerCacheSize,
        toggleCacheDrawer,
        refreshCacheList,
        updateCacheHeaderStats,
        renderCacheList,
        retryCacheLyric,
        downloadAllCacheLyrics,
        toggleCacheBatchMode,
        exitCacheBatchMode,
        toggleCacheSelection,
        selectAllCache,
        deselectAllCache,
        updateCacheBatchCount,
        removeCacheItem,
        batchDeleteCache,
        clearServerCache,
    };

    Object.assign(window, feature);
    return feature;
}
