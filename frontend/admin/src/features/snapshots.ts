import type { AdminFeatureContext } from '../types';
import { readApiErrorMessage } from '../api';

export function initSnapshotsFeature(context: AdminFeatureContext) {
    const app = context.app;

    function bindSnapshotsEvents() {
        document.getElementById('restart-server-btn')?.addEventListener('click', () => app.restartServer());
        document.getElementById('snapshot-upload-input')?.addEventListener('change', event => app.handleSnapshotUpload(event));
        document.getElementById('local-backup-upload-input')?.addEventListener('change', event => app.handleLocalRestore(event));
        document.getElementById('snapshots-list')?.addEventListener('click', event => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-snapshot-action]');
            if (!button) return;
            const id = button.dataset.snapshotId || '';
            const time = button.dataset.snapshotTime;
            if (button.dataset.snapshotAction === 'download') void app.downloadSnapshot(id);
            if (button.dataset.snapshotAction === 'restore') void app.restoreSnapshot(id, time);
            if (button.dataset.snapshotAction === 'delete') void app.deleteSnapshot(id, time);
        });
    }

    async function loadSnapshots() {
        const username = document.getElementById('snapshot-user-select')?.value;
        const container = document.getElementById('snapshots-list');

        if (!username) {
            app.renderUserSelectionGrid('snapshot');
            return;
        }

        // 添加加载状态
        container.classList.add('content-loading');

        try {
            // 添加 user 参数
            const list = await app.request(`/api/data/snapshots?user=${encodeURIComponent(username)}`);

            if (!list.length) {
                container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">暂无快照</div>';
                container.classList.remove('content-loading');
                return;
            }

            container.innerHTML = list.map(item => {
                const snapshotId = String(item.id || '');
                const snapshotIdHtml = app.escapeHtml(snapshotId);
                const snapshotTime = new Date(item.time).toLocaleString();
                return `
            <div class="snapshot-row">
                <div class="col-time">${snapshotTime}</div>
                <div class="col-id" title="${snapshotIdHtml}">snapshot_${snapshotIdHtml}</div>
                <div class="col-size">${app.formatFileSize(item.size)}</div>
                <div class="col-actions snapshot-actions">
                    <button type="button" class="btn-download" data-snapshot-action="download" data-snapshot-id="${snapshotIdHtml}">
                        <!-- 下载图标 -->
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        下载备份
                    </button>
                    <button type="button" class="btn-restore" data-snapshot-action="restore" data-snapshot-id="${snapshotIdHtml}" data-snapshot-time="${app.escapeHtml(snapshotTime)}">
                        <!-- 恢复图标 -->
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="1 4 1 10 7 10"></polyline>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                        </svg>
                        回滚
                    </button>
                    <!-- [新增] 删除按钮 -->
                    <button type="button" class="btn-delete" data-snapshot-action="delete" data-snapshot-id="${snapshotIdHtml}" data-snapshot-time="${app.escapeHtml(snapshotTime)}">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                        删除
                    </button>
                </div>
            </div>
        `;
            }).join('');

            // 移除加载状态并添加淡入动画
            container.classList.remove('content-loading');
            container.classList.add('fade-in');

            // 动画完成后移除类
            setTimeout(() => {
                container.classList.remove('fade-in');
            }, 400);

        } catch (err) {
            console.error(err);
            showError('加载快照列表失败: ' + err.message);
            container.classList.remove('content-loading');
        }
    }

    function triggerUploadSnapshot() {
        const username = document.getElementById('snapshot-user-select')?.value;
        if (!username) {
            showInfo('请先选择用户');
            return;
        }
        document.getElementById('snapshot-upload-input').click();
    }

    // [新增] 处理快照上传

    async function handleSnapshotUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const username = document.getElementById('snapshot-user-select')?.value;
        if (!username) return;

        // 重置 input，允许重复上传同名文件
        event.target.value = '';

        try {
            const content = await file.text();
            // 使用文件最后修改时间
            const time = file.lastModified;
            const filename = file.name;

            const response = await fetch(`/api/data/upload-snapshot?user=${encodeURIComponent(username)}&time=${time}&filename=${encodeURIComponent(filename)}`, {
                method: 'POST',
                credentials: 'same-origin',
                body: content
            });

            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response));
            }

            showSuccess('上传成功');
            app.loadSnapshots();
        } catch (err) {
            console.error(err);
            showError('上传失败: ' + err.message);
        }
    }

    // [新增] 删除快照

    async function deleteSnapshot(id, time?: string) {
        const label = time ? `快照 snapshot_${id}（创建于 ${time}）` : `快照 snapshot_${id}`;
        if (!(await showSelect('删除快照', `确定要删除${label}吗？\n此操作不可恢复。`, { danger: true }))) return;

        const username = document.getElementById('snapshot-user-select')?.value;
        if (!username) return;

        try {
            const response = await fetch(`/api/data/delete-snapshot?user=${encodeURIComponent(username)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'same-origin',
                body: JSON.stringify({ id })
            });

            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response));
            }

            app.loadSnapshots();
            showSuccess('删除成功');
        } catch (err) {
            console.error(err);
            showError('删除失败: ' + err.message);
        }
    }

    async function downloadSnapshot(id) {
        const username = document.getElementById('snapshot-user-select')?.value;
        if (!username) {
            showInfo('请先选择用户');
            return;
        }

        try {
            // 添加 user 参数
            const data = await app.request(`/api/data/snapshot?id=${encodeURIComponent(id)}&user=${encodeURIComponent(username)}`);

            // 转换为兼容播放器的备份格式
            const defaultList = { id: 'default', name: 'list__name_default' };
            const loveList = { id: 'love', name: 'list__name_love' };

            const backupData = {
                type: 'playList_v2',
                data: [
                    { ...defaultList, list: data.defaultList || [] },
                    { ...loveList, list: data.loveList || [] },
                    ...(data.userList || []),
                ],
            };

            const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lx_backup_${username}_${id.substring(0, 8)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error(err);
            showError('导出快照失败: ' + err.message);
        }
    }

    // [新增] 本地备份下载

    async function downloadLocalBackup() {
        if (!(await showSelect('本地备份', '确定要创建并下载本地全量 ZIP 备份吗？\n\n这可能需要一些时间，取决于数据量。'))) return;

        try {
            const response = await fetch('/api/backup/download', {
                credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(await readApiErrorMessage(response));
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // 获取当前日期作为文件名建议
            const dateStr = new Date().toISOString().split('T')[0];
            a.download = `yun-yin-backup-${dateStr}.zip`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            showError('下载本地备份失败: ' + err.message);
        }
    }

    // [新增] 本地备份还原处理

    async function handleLocalRestore(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!(await showSelect('还原数据', '确定要从上传的 ZIP 文件还原数据吗？\n\n⚠️ 警告：这将覆盖当前的服务器所有数据！\n强烈建议在还原前先手动下载一个本地备份。操作不可撤销。', { danger: true }))) {
            event.target.value = '';
            return;
        }

        const formData = new FormData();
        formData.append('backup', file);

        // 创建临时加载提示
        const loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'overlay';
        loadingOverlay.style.background = 'rgba(0,0,0,0.8)';
        loadingOverlay.innerHTML = `
            <div class="login-box glass" style="padding: 3rem;">
                <div class="status-dot" style="margin: 0 auto 1.5rem; width: 12px; height: 12px;"></div>
                <h2>正在还原数据...</h2>
                <p style="color: var(--text-secondary); margin-top: 1rem;">正在解压并恢复文件，请勿关闭或刷新页面。</p>
            </div>
        `;
        document.body.appendChild(loadingOverlay);

        try {
            const response = await fetch('/api/backup/upload', {
                method: 'POST',
                credentials: 'same-origin',
                body: formData
            });

            if (!response.ok) {
                throw new Error(await readApiErrorMessage(response));
            }

            const result = await response.json();
            showSuccess('🎉 还原成功！数据已更新，页面将立即刷新以加载最新配置。');
            setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
            console.error(err);
            showError('本地还原失败: ' + err.message);
            loadingOverlay.remove();
        } finally {
            event.target.value = '';
        }
    }

    function triggerLocalRestore() {
        document.getElementById('local-backup-upload-input')?.click();
    }

    async function restoreSnapshot(id, time?: string) {
        const username = document.getElementById('snapshot-user-select')?.value;
        if (!username) {
            showInfo('请先选择用户');
            return;
        }

        const label = time ? `快照 snapshot_${id}（创建于 ${time}）` : `快照 snapshot_${id}`;
        if (!(await showSelect('回滚快照', `警告：此操作将把服务器数据回滚到${label}！\n\n当前未保存的更改将丢失，操作不可撤销。\n\n确定要继续吗？`, { danger: true }))) {
            return;
        }

        try {
            // 添加 user 参数
            await app.request(`/api/data/restore-snapshot?user=${encodeURIComponent(username)}`, {
                method: 'POST',
                body: JSON.stringify({ id })
            });
            showSuccess('回滚成功！');
            app.loadDashboard(); // 刷新数据概览
        } catch (err) {
            showError('回滚失败: ' + err.message);
        }
    }

    async function restartServer() {
        if (!(await showSelect('重启服务器', '确定要重启服务器吗？\n\n重启后正在处理的请求将断开，大约需要几秒钟时间。', { danger: true }))) {
            return;
        }

        try {
            const result = await app.request('/api/restart', { method: 'POST' })
            if (result.success) {
                showSuccess('服务器正在重启，请稍候...\n\n页面将在 5 秒后自动刷新。');
                // 5秒后刷新页面
                setTimeout(() => {
                    window.location.reload()
                }, 5000)
            } else {
                showError('重启失败: ' + (result.message || '未知错误'))
            }
        } catch (err) {
            showError('重启请求失败: ' + err.message)
        }
    }

    return {
        bindSnapshotsEvents,
        loadSnapshots,
        triggerUploadSnapshot,
        handleSnapshotUpload,
        deleteSnapshot,
        downloadSnapshot,
        downloadLocalBackup,
        triggerLocalRestore,
        handleLocalRestore,
        restoreSnapshot,
        restartServer,
    };
}
