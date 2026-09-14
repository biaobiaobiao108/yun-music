import { safeInlineString } from '../player_security';

export interface CustomSourcesFeatureContext {
    getUserAuthHeaders: () => Record<string, string>;
    getCurrentListData: () => any;
    getSettings: () => any;
    isUserLoggedIn: () => boolean;
    isAdminSessionActive: () => boolean;
    handleAdminAuth: (message: string) => Promise<boolean>;
    updateSetting: (key: string, value: any) => Promise<void>;
    createMarqueeHtml: (text: any, className?: string) => string;
    applyMarqueeChecks: () => void;
    escapeHtmlText: (value: any) => string;
    showInput: (...args: any[]) => Promise<string | null>;
    showSelect: (...args: any[]) => Promise<boolean>;
    showSuccess: (message: string) => void;
    showInfo: (message: string) => void;
    showError: (message: string) => void;
}

export function initCustomSourcesFeature(context: CustomSourcesFeatureContext) {
    const getUserAuthHeaders = context.getUserAuthHeaders;
    const isAdminSessionActive = context.isAdminSessionActive;
    const handleAdminAuth = context.handleAdminAuth;
    const updateSetting = context.updateSetting;
    const createMarqueeHtml = context.createMarqueeHtml;
    const applyMarqueeChecks = context.applyMarqueeChecks;
    const escapeHtmlText = context.escapeHtmlText;
    const showInput = context.showInput;
    const showSelect = context.showSelect;
    const showSuccess = context.showSuccess;
    const showInfo = context.showInfo;
    const showError = context.showError;
    const currentListData = new Proxy({} as any, {
        get: (_, property: string | symbol) => context.getCurrentListData()?.[property as any],
    });
    const settings = new Proxy({} as any, {
        get: (_, property: string | symbol) => context.getSettings()?.[property as any],
    });

let customSourceMode = 'file'; // 'file' or 'url'

// 切换上传方式
function switchCustomSourceMode(mode) {
    customSourceMode = mode;

    // 更新按钮样式
    document.getElementById('btn-source-file').className = mode === 'file'
        ? 'px-4 py-2 text-sm font-medium bg-emerald-100 text-emerald-700 rounded-lg'
        : 'px-4 py-2 text-sm font-medium bg-gray-100 t-text-muted rounded-lg hover:bg-gray-200';

    document.getElementById('btn-source-url').className = mode === 'url'
        ? 'px-4 py-2 text-sm font-medium bg-emerald-100 text-emerald-700 rounded-lg'
        : 'px-4 py-2 text-sm font-medium bg-gray-100 t-text-muted rounded-lg hover:bg-gray-200';

    // 切换显示
    document.getElementById('custom-source-file').classList.toggle('hidden', mode !== 'file');
    document.getElementById('custom-source-url').classList.toggle('hidden', mode !== 'url');
}

// 处理本地文件上传
async function handleFileUpload(input) {
    const file = input.files[0];
    if (!file) return;

    // 验证文件类型
    if (!file.name.endsWith('.js')) {
        showError('请选择 .js 文件');
        return;
    }

    // 更新文件名显示
    // document.getElementById('file-name-display').textContent = file.name;

    try {
        // 读取文件内容
        const content = await file.text();

        // 先验证脚本
        showInfo('正在验证脚本...');
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };

        let validationRes = await fetch('/api/custom-source/validate', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                script: content,
                username: currentListData?.username || 'default'
            })
        });

        if (validationRes.status === 403) {
            const errData = await validationRes.json();
            showError(errData.error || '权限限制：请先登录管理员。');
            const authorized = await handleAdminAuth('上传自定义源需要管理员权限');
            if (authorized) return handleFileUpload(input);
            input.value = '';
            return;
        }

        const validation = await validationRes.json();

        if (!validation.valid) {
            showError(`脚本无效: ${validation.error}`);
            input.value = '';
            // document.getElementById('file-name-display').textContent = '点击选择 .js 文件';
            return;
        }

        // 验证通过，上传
        showInfo(`验证通过，正在上传 "${validation.metadata.name || file.name}"...`);
        await uploadCustomSource(file.name, content, 'file');

        showSuccess(`已上传: ${validation.metadata.name || file.name} ${validation.metadata.version ? (/^v/i.test(validation.metadata.version) ? validation.metadata.version : 'v' + validation.metadata.version) : ''}`);

        // 重置输入
        input.value = '';
        // document.getElementById('file-name-display').textContent = '点击选择 .js 文件';

        // 刷新源列表
        loadCustomSources();
    } catch (error) {
        console.error('[CustomSource] 上传失败:', error);
        showError(`上传失败: ${error.message}`);
    }
}

// 处理远程链接导入
async function handleUrlImport() {
    const input = await showInput("导入远程音源", "请输入自定义源脚本的 URL 地址:", {
        placeholder: "https://example.com/script.js",
        confirmText: "开始导入"
    });

    if (input === null) return; // 用户取消

    const url = input.trim();
    if (!url) {
        showError('请输入链接地址');
        return;
    }
    const filename = url.split('/').pop()?.split('?')[0] || '';

    try {
        showInfo('正在获取并验证远程脚本...');

        const username = currentListData?.username || 'default';
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };

        // 从服务器代理下载
        const response = await fetch(`/api/custom-source/import`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                url,
                filename,
                username: username
            })
        });

        if (response.status === 403) {
            const data = await response.json();
            showError(data.error || '权限限制：请先登录管理员。');
            const authorized = await handleAdminAuth('导入自定义源需要管理员权限');
            if (authorized) return handleUrlImport();
            return;
        }

        const result = await response.json();

        if (!response.ok || result.success === false) {
            throw new Error(result.error || `HTTP ${response.status}`);
        }

        showSuccess(`已导入: ${result.filename}`);

        // 刷新源列表
        loadCustomSources();
    } catch (error) {
        console.error('[CustomSource] 导入失败:', error);
        showError(`导入失败: ${error.message}`);
    }
}

// 上传自定义源到服务器
async function uploadCustomSource(filename, content, type) {
    const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };

    const response = await fetch('/api/custom-source/upload', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
            filename,
            content,
            type,
            username: currentListData?.username || 'default', // 使用当前登录用户
        })
    });

    if (response.status === 403) {
        const result = await response.json();
        showError(result.error || '权限不足：请先登录管理员。');
        const authorized = await handleAdminAuth('上传自定义源需要管理员权限');
        if (authorized) return uploadCustomSource(filename, content, type);
        return;
    }

    if (!response.ok) {
        const errorText = await response.text();
        let errMsg = errorText;
        try {
            const errJson = JSON.parse(errorText);
            if (errJson.error) errMsg = errJson.error;
        } catch (e) { }
        throw new Error(errMsg || `HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.success === false) {
        throw new Error(result.error || '上传失败');
    }
    return result;
}

// 加载自定义源列表 (随时可以调用以刷新界面)
async function loadCustomSources() {
    await renderCustomSources();
}

// ========== 自定义源管理逻辑 ==========

async function fetchCustomSources() {
    try {
        const username = currentListData?.username || 'default';
        const headers = getUserAuthHeaders();

        const res = await fetch(`/api/custom-source/list?username=${encodeURIComponent(username)}`, {
            headers: headers
        });

        if (res.status === 403) {
            // 被后端拒绝访问，说明开启了公开限制且未登录成功
            console.warn('[CustomSource] List access denied (403)');
            return null; // 返回 null 表示由于权限原因被拦截
        }

        if (!res.ok) throw new Error('Failed to fetch sources');
        return await res.json();
    } catch (err) {
        console.error('Fetch sources failed:', err);
        return [];
    }
}


function updateSourceScopeUI() {
    const username = currentListData?.username || 'default';
    const isPublic = username === 'default';
    const showPublic = settings.enablePublicSources !== false; // Default true

    const settingsTag = document.getElementById('settings-source-scope-tag');
    const modalTag = document.getElementById('modal-source-scope-info');

    // Tag Content Logic
    let tagHtml = '';
    if (isPublic) {
        tagHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-500 whitespace-nowrap inline-block">公开</span>`;
    } else {
        // User logged in
        let userTag = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-600 whitespace-nowrap inline-block">${escapeHtmlText(username)}</span>`;
        if (showPublic) {
            userTag += `<span class="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-500 whitespace-nowrap inline-block">公开</span>`
        }
        tagHtml = userTag;
    }

    if (settingsTag) settingsTag.innerHTML = tagHtml;

    if (modalTag) {
        modalTag.innerHTML = isPublic
            ? `<div class="flex items-center gap-2 text-xs text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-100 w-fit mb-2"><i class="fas fa-globe"></i> 上传到: 公开</div>`
            : `<div class="flex items-center gap-2 text-xs text-purple-600 bg-purple-50 px-3 py-1.5 rounded-lg border border-purple-100 w-fit mb-2"><i class="fas fa-user-circle"></i> 上传到: ${escapeHtmlText(username)}</div>`;
    }
}

function togglePublicSourcesSetting() {
    updateSetting('enablePublicSources', !settings.enablePublicSources);
}

async function renderCustomSources() {
    let list = await fetchCustomSources();

    // 判断当前状态：是否由于权限被拦截
    // list === null 表示后端返回了 403
    // 或者前端认为应该拦截：开启了公开限制 && 非登录用户 && 非管理员
    const isAdmin = isAdminSessionActive();
    const isUser = !!context.isUserLoggedIn();
    const isPublicRestrictionEnabled = !!window.lx_config?.['user.enablePublicRestriction'];
    const isPublicRestrictionActive = isPublicRestrictionEnabled && !isUser && !isAdmin;

    // 如果 list 为 null（后端拦截）或者前端计算出受限，则启用锁定展示
    const shouldShowHidden = (list === null) || isPublicRestrictionActive;

    // Filter based on setting (if list is successfully fetched)
    if (list && settings.enablePublicSources === false) {
        list = list.filter(item => item.owner !== 'open');
    }

    updateSourceScopeUI();

    // 控制模态框头部的工具栏显示/隐藏
    const toolbar = document.getElementById('custom-source-toolbar');
    if (toolbar) {
        // 权限判定：如果是公开访问受限模式，且当前非管理员且非登录用户，则隐藏上传/导入工具栏
        const canManageGlobal = isAdmin || isUser || !isPublicRestrictionEnabled;
        toolbar.classList.toggle('hidden', shouldShowHidden || !canManageGlobal);
    }

    // 渲染目标容器 ID 列表：模态框内 & 设置界面内
    const targetIds = ['custom-sources-list', 'settings-custom-sources-list'];

    targetIds.forEach(containerId => {
        const container = document.getElementById(containerId);
        if (!container) return;

        // 如果开启了公开限制且未通过验证，则显示锁定提示
        if (shouldShowHidden) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center p-8 t-text-muted">
                    <div class="w-16 h-16 bg-emerald-50 rounded-2xl flex items-center justify-center mb-4">
                        <i class="fas fa-lock text-3xl text-emerald-500/50"></i>
                    </div>
                    <p class="text-base font-bold t-text-main mb-2">列表内容已隐藏</p>
                    <p class="text-xs text-center max-w-[240px] leading-relaxed">当前系统已开启公开访问限制，请登录管理员账号后再管理或查看自定义源列表。</p>
                    <button data-event-click-action="handleAdminLogin" class="mt-6 px-6 py-2.5 bg-emerald-500 text-white rounded-xl text-sm font-bold shadow-lg shadow-emerald-100 hover:bg-emerald-600 transition-all active:scale-95">前往登录</button>
                </div>
            `;
            return;
        }

        // 空状态
        if (!list || list.length === 0) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center p-6 t-text-muted">
                    <i class="fas fa-box-open text-3xl mb-3 opacity-30"></i>
                    <p class="text-sm">暂无自定义源</p>
                    ${containerId === 'custom-sources-list' ?
                    `<button data-event-click-action="open-script-file" class="mt-3 text-emerald-600 hover:text-emerald-700 text-sm font-medium">即刻上传</button>`
                    : ''}
                </div>
            `;
            return;
        }

        container.innerHTML = '';

        list.forEach((source, index) => {
            const div = document.createElement('div');
            // 设置界面使用稍紧凑的样式，模态框使用标准样式 (这里为了统一先用一样的，微调边距)
            div.className = `t-bg-panel p-4 rounded-xl border t-border-main shadow-sm hover:shadow-md transition-all mb-3 relative group flex items-start source-item`;
            div.dataset.id = source.id;
            div.dataset.enabled = source.enabled;
            div.dataset.index = index;

            // 格式化支持的源
            let supportedBadges = '';
            if (source.supportedSources && source.supportedSources.length > 0) {
                const sourceMap = {
                    'tx': { name: 'QQ', color: 't-badge-green' },
                    'wy': { name: '网易', color: 't-badge-red' }
                };

                supportedBadges = `<div class="flex flex-wrap gap-1.5 mt-2">
                ${source.supportedSources.map(s => {
                    const info = sourceMap[s] || { name: s, color: 't-badge-gray' };
                    const badgeName = escapeHtmlText(info.name);
                    return `<span class="px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors border border-transparent ${info.color}">${badgeName}</span>`;
                }).join('')}
            </div>`;
            } else {
                supportedBadges = `<div class="mt-2 text-[10px] t-text-muted italic">未知支持源</div>`;
            }

            const size = source.size && !isNaN(source.size) ? (source.size / 1024).toFixed(1) + ' KB' : '未知大小';
            let date = '未知日期';
            try {
                if (source.uploadTime) date = new Date(source.uploadTime).toLocaleDateString();
            } catch (e) { }

            /* Status Badge Logic */
            let statusBadge = '';
            let errorMsg = '';

            if (source.enabled) {
                if (source.status === 'success') {
                    statusBadge = `<span class="text-[10px] bg-emerald-50 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 dark:border-emerald-500/30 px-1.5 py-0.5 rounded-full border border-emerald-100 flex items-center gap-1 transition-colors"><i class="fas fa-check-circle"></i>正常</span>`;
                } else if (source.status === 'failed') {
                    const sourceError = escapeHtmlText(source.error || '加载失败');
                    statusBadge = `<span class="text-[10px] bg-red-50 text-red-600 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30 px-1.5 py-0.5 rounded-full border border-red-100 flex items-center gap-1 cursor-help transition-colors" title="${sourceError}"><i class="fas fa-times-circle"></i>失败</span>`;
                    errorMsg = `<div class="text-[10px] text-red-500 dark:text-red-400 mt-1 flex items-start gap-1 p-1.5 bg-red-50 dark:bg-red-900/20 rounded transition-colors"><i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i><span class="break-all">${sourceError}</span></div>`;
                } else {
                    statusBadge = `<span class="text-[10px] bg-blue-50 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30 px-1.5 py-0.5 rounded-full border border-blue-100 flex items-center gap-1 transition-colors"><i class="fas fa-circle-notch fa-spin"></i>加载...</span>`;
                }
            }

            const ownerTag = (source.owner && source.owner !== 'open') ?
                `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-purple-50 text-purple-600">${escapeHtmlText(source.owner)}</span>` :
                `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-50 text-blue-500">公开</span>`;

            // 权限判断：管理员有所有权限；登录用户对公开源只有查看使用（Toggle）权限，无法刷新或删除
            const isPublic = source.owner === 'open';
            const canManageSource = isAdmin || (!isPublic && isUser);

            div.innerHTML = `
            <div class="flex items-center self-stretch cursor-grab custom-source-handle t-text-muted hover:text-emerald-500 pr-4 -ml-2 transition-all active:scale-110 touch-none" title="拖拽排序">
                <i class="fas fa-grip-vertical text-lg"></i>
            </div>
            <div class="flex justify-between items-start flex-1 min-w-0">
                <div class="flex-1 pr-4 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <i class="fas fa-file-code text-emerald-500 flex-shrink-0"></i>
                         ${createMarqueeHtml(source.name, "font-bold t-text-main text-sm")}
                        ${ownerTag}
                    </div>
                    ${errorMsg}
                    <div class="flex flex-wrap items-center text-[10px] t-text-muted gap-x-3 gap-y-1 mt-1.5">
                        <span class="flex items-center"><i class="fas fa-user mr-1 opacity-70"></i>${escapeHtmlText(source.author || '未知')}</span>
                        <span class="flex items-center"><i class="far fa-hdd mr-1 opacity-70"></i>${size}</span>
                        <span class="t-bg-main t-text-muted px-1.5 py-0.5 rounded-lg shrink-0 transition-colors font-mono pointer-events-none border t-border-main">${escapeHtmlText(source.version ? (/^v/i.test(source.version) ? source.version : 'v' + source.version) : '未知')}</span>
                        ${statusBadge}
                    </div>
                    ${supportedBadges}
                </div>
                
                <div class="flex flex-col items-end gap-2 shrink-0">
                    <button data-event-click-action="toggleSource" data-event-click-args="[${safeInlineString(source.id)}, ${source.enabled}]"
                            class="px-3 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap w-20 flex justify-center items-center ${source.enabled
                    ? (source.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-500/30' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 hover:bg-emerald-200 dark:hover:bg-emerald-500/30')
                    : 't-bg-track t-text-muted hover:t-bg-item-hover'}">
                        ${source.enabled ? '已启用' : '已禁用'}
                    </button>
                    
                    <div class="flex items-center gap-1">
                        ${source.enabled && source.status === 'failed' && canManageSource ? `
                        <button data-event-click-action="reloadSource" data-event-click-args="[${safeInlineString(source.id)}]"
                                class="p-1.5 text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/40 rounded-lg transition-colors"
                                title="尝试重新加载">
                            <i class="fas fa-sync-alt text-sm"></i>
                        </button>` : ''}
                        
                        ${canManageSource ? `
                        <button data-event-click-action="deleteSource" data-event-click-args="[${safeInlineString(source.id)}]"
                                class="p-1.5 t-text-muted hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/40 rounded-lg transition-colors"
                                title="删除">
                            <i class="fas fa-trash-alt text-sm"></i>
                        </button>` : ''}
                    </div>
                </div>
            </div>
        `;
            container.appendChild(div);
        });

        // Add Sortable for both the modal list and the settings panel list
        const isSortableContainer = (containerId === 'custom-sources-list' || containerId === 'settings-custom-sources-list') && typeof Sortable !== 'undefined';
        if (isSortableContainer) {
            try {
                const oldSortable = Sortable.get(container);
                if (oldSortable) oldSortable.destroy();
            } catch (e) { }

            Sortable.create(container, {
                animation: 200,
                handle: '.custom-source-handle',
                ghostClass: 'sortable-ghost-solid',
                chosenClass: 'sortable-chosen-item',
                dragClass: 'sortable-drag-item',
                forceFallback: true,
                delay: 200,
                delayOnTouchOnly: true,
                onEnd: async function (evt) {
                    // 防止两个容器同时触发 onEnd 导致重复请求
                    if (window._reorderLock) return;
                    window._reorderLock = true;
                    setTimeout(() => { window._reorderLock = false; }, 500);

                    // DOM 已由 SortableJS 更新，直接读取新顺序
                    const items = Array.from(container.querySelectorAll('.source-item'));
                    const finalOrderIds = items.map(el => el.dataset.id);

                    // 同步另一个容器的 DOM 顺序（保持两者一致）
                    const otherId = containerId === 'custom-sources-list' ? 'settings-custom-sources-list' : 'custom-sources-list';
                    const otherContainer = document.getElementById(otherId);
                    if (otherContainer) {
                        finalOrderIds.forEach(id => {
                            const el = otherContainer.querySelector(`.source-item[data-id="${id}"]`);
                            if (el) otherContainer.appendChild(el);
                        });
                    }

                    try {
                        const username = currentListData?.username || 'default';
                        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };

                        const response = await fetch('/api/custom-source/reorder', {
                            method: 'POST',
                            headers: headers,
                            body: JSON.stringify({ username, sourceIds: finalOrderIds })
                        });

                        if (response.status === 403) {
                            showError('权限限制：保存排序需要管理员身份。');
                            const authorized = await handleAdminAuth('保存排序需要管理员身份');
                            if (authorized) renderCustomSources();
                            else renderCustomSources();
                            return;
                        }
                        if (!response.ok) throw new Error('Reorder failed');
                        // 成功：DOM 已是正确顺序，无需重新拉取
                        showInfo('排序已保存');
                    } catch (error) {
                        console.error('Reorder error:', error);
                        showError('保存排序失败，已还原');
                        renderCustomSources();
                    }
                }
            });
        }
    });

    if (typeof applyMarqueeChecks === 'function') {
        applyMarqueeChecks();
    }
}

// 重新加载源 (强制重新启用)
async function reloadSource(sourceId) {
    try {
        const username = currentListData?.username || 'default';
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };

        const response = await fetch('/api/custom-source/toggle', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ username, sourceId, enabled: true }) // Force enable triggers reload
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        showInfo('正在重新加载...');
        // Wait a bit for server to process
        setTimeout(() => {
            renderCustomSources();
        }, 1000);

    } catch (error) {
        console.error('Reload failed:', error);
        showError(`重载请求失败: ${error.message}`);
    }
}

// 切换状态
async function toggleSource(sourceId, currentEnabled) {
    try {
        const username = currentListData?.username || 'default';
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };

        const response = await fetch('/api/custom-source/toggle', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ username, sourceId, enabled: !currentEnabled }) // Send new state
        });

        if (response.status === 403) {
            const data = await response.json();
            showError(data.error || '权限限制：需要管理员身份。');
            const authorized = await handleAdminAuth('修改自定义源状态需要管理员权限');
            if (authorized) return await toggleSource(sourceId, currentEnabled);
            return;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();
        if (result.success === false) throw new Error(result.error || '操作失败');

        // 刷新列表
        await renderCustomSources();
        showSuccess(currentEnabled ? '已禁用' : '已启用');
    } catch (error) {
        console.error('[CustomSource] 切换状态失败:', error);
        showError(`操作失败: ${error.message}`);
    }
}

// 删除源
async function deleteSource(sourceId) {
    if (!(await showSelect('删除自定义源', '确定要删除这个自定义源吗？', { danger: true }))) return;

    try {
        const username = currentListData?.username || 'default';
        const headers = { 'Content-Type': 'application/json', ...getUserAuthHeaders() };

        const response = await fetch('/api/custom-source/delete', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ username, sourceId })
        });

        if (response.status === 403) {
            const data = await response.json();
            showError(data.error || '权限限制：需要管理员身份。');
            const authorized = await handleAdminAuth('删除自定义源需要管理员权限');
            if (authorized) return await deleteSource(sourceId);
            return;
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        showSuccess('已删除');
        await renderCustomSources();
    } catch (error) {
        console.error('[CustomSource] 删除失败:', error);
        showError(`删除失败: ${error.message}`);
    }
}

// 模态框控制
function openCustomSourceModal() {
    const modal = document.getElementById('custom-source-modal');
    const content = document.getElementById('custom-source-modal-content');
    if (modal) modal.classList.remove('hidden');

    // 渲染列表
    renderCustomSources();

    setTimeout(() => {
        if (content) {
            content.classList.remove('scale-95', 'opacity-0');
            content.classList.add('scale-100', 'opacity-100');
        }
    }, 10);
}

function closeCustomSourceModal() {
    const modal = document.getElementById('custom-source-modal');
    const content = document.getElementById('custom-source-modal-content');

    if (content) {
        content.classList.remove('scale-100', 'opacity-100');
        content.classList.add('scale-95', 'opacity-0');
    }

    setTimeout(() => {
        if (modal) modal.classList.add('hidden');
    }, 300);
}

    const feature = {
        switchCustomSourceMode,
        handleFileUpload,
        handleUrlImport,
        uploadCustomSource,
        loadCustomSources,
        fetchCustomSources,
        renderCustomSources,
        reloadSource,
        toggleSource,
        deleteSource,
        openCustomSourceModal,
        closeCustomSourceModal,
        togglePublicSourcesSetting,
    };

    Object.assign(window, feature);
    return feature;
}
