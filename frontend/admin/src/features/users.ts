import type { AdminFeatureContext } from '../types';
import { stringToColor } from '../utils';

export function initUsersFeature(context: AdminFeatureContext) {
    const app = context.app;

    function bindUsersEvents() {
        document.getElementById('add-user-btn')?.addEventListener('click', () => app.showAddUserModal());
        document.getElementById('refresh-users-btn')?.addEventListener('click', async () => {
            try {
                await app.request('/api/admin/reload', { method: 'POST' });
                app.loadUsers();
                app.loadDashboard();
                showSuccess('重载数据成功');
            } catch (err) {
                showError('重载数据失败: ' + err.message);
            }
        });
        document.getElementById('batch-delete-users-btn')?.addEventListener('click', () => app.batchDeleteUsers());
        document.getElementById('select-all-users')?.addEventListener('change', (event) => app.toggleAllUsers(event.target.checked));
        document.getElementById('save-password-btn')?.addEventListener('click', () => app.saveNewPassword());
        document.getElementById('save-rename-user-btn')?.addEventListener('click', () => app.saveRenameUser());
    }

    function renderAllUserSelectors() {
        app.renderUserDropdown('data');
        app.renderUserDropdown('snapshot');

        // 如果当前没有选择用户，在内容区展示选择网格
        if (!document.getElementById('data-user-select').value) {
            app.renderUserSelectionGrid('data');
        }
        if (!document.getElementById('snapshot-user-select').value) {
            app.renderUserSelectionGrid('snapshot');
        }
    }

    function toggleUserDropdown(type) {
        const selector = document.getElementById(`${type}-user-selector`);
        const dropdown = document.getElementById(`${type}-user-dropdown`);
        const trigger = selector?.querySelector('.selector-trigger');
        const isOpen = !dropdown.classList.contains('hidden');

        // 关闭所有其他的
        document.querySelectorAll('.selector-dropdown').forEach(d => d.classList.add('hidden'));
        document.querySelectorAll('.custom-user-selector').forEach(s => {
            s.classList.remove('open');
            s.querySelector('.selector-trigger')?.setAttribute('aria-expanded', 'false');
        });

        if (!isOpen) {
            dropdown.classList.remove('hidden');
            selector.classList.add('open');
            trigger?.setAttribute('aria-expanded', 'true');
        }
    }

    function renderUserDropdown(type) {
        const dropdown = document.getElementById(`${type}-user-dropdown`);
        if (!dropdown || !app.allUsers) return;

        const currentSelected = document.getElementById(`${type}-user-select`).value;

        dropdown.innerHTML = app.allUsers.map(user => {
            const isPublic = user.name === '_open';
            const displayName = isPublic ? '公开用户 (_open)' : app.escapeHtml(user.name);
            const avatarChar = isPublic ? '🌐' : app.escapeHtml(user.name.charAt(0).toUpperCase());
            const avatarStyle = isPublic ? 'background: linear-gradient(135deg, #10b981, #059669); font-size:12px;' : '';
            return `
            <div class="dropdown-item ${user.name === currentSelected ? 'active' : ''}" 
                 data-admin-action="select-user" data-admin-user-type="${app.escapeHtml(type)}" data-admin-user-name="${app.escapeHtml(user.name)}">
                <div class="dropdown-avatar" style="${avatarStyle}">${avatarChar}</div>
                <span>${displayName}</span>
                ${user.name === currentSelected ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="width:14px;height:14px;margin-left:auto;"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
            </div>
        `}).join('');
    }

    function renderUserSelectionGrid(type) {
        const container = type === 'data' ? document.getElementById('data-content') : document.getElementById('snapshots-list');
        if (!container || !app.allUsers) return;

        // 特殊处理：如果是数据查看视图，且没有选择用户，stats 区域也需要清空
        if (type === 'data') {
            document.getElementById('data-stats').innerHTML = '';
        }

        container.innerHTML = `
            <div class="user-selection-grid user-selection-grid--${type} fade-in">
                ${app.allUsers.map(user => {
                    const isPublic = user.name === '_open';
                    const displayName = isPublic ? '公开用户 (_open)' : app.escapeHtml(user.name);
                    const roleText = isPublic ? '公共数据与歌单' : '用户数据';
                    const avatarStyle = isPublic ? 'background: linear-gradient(135deg, #10b981, #059669); font-size: 1.5rem;' : '';
                    const avatarHtml = isPublic ? '🌐' : app.escapeHtml(user.name.charAt(0).toUpperCase());
                    return `
                    <div class="user-select-card" role="button" tabindex="0" aria-label="选择用户 ${displayName}" data-admin-action="select-user" data-admin-user-type="${app.escapeHtml(type)}" data-admin-user-name="${app.escapeHtml(user.name)}">
                        <div class="avatar" style="${avatarStyle}">${avatarHtml}</div>
                        <div class="name">${displayName}</div>
                        <div class="role">${roleText}</div>
                    </div>
                `}).join('')}
            </div>
        `;
    }

    function selectUser(type, username) {
        const input = document.getElementById(`${type}-user-select`);
        const title = document.querySelector(`#${type}-user-selector .selected-username`);

        input.value = username;
        title.textContent = username === '_open' ? '公开用户 (_open)' : username;

        // 关闭下拉
        document.getElementById(`${type}-user-dropdown`).classList.add('hidden');
        document.getElementById(`${type}-user-selector`).classList.remove('open');

        // 刷新下拉列表显示状态
        app.renderUserDropdown(type);

        // 加载数据
        if (type === 'data') {
            app.loadUserData();
        } else {
            app.loadSnapshots();
        }
    }

    async function loadUsers() {
        try {
            const users = await app.request('/api/users');
            app.users = users.filter(u => u.name !== '_open');
            app.renderUsers();
        } catch (err) {
            console.error('Failed to load users:', err);
            app.renderViewError(
                document.getElementById('users-list'),
                '用户列表加载失败: ' + err.message,
                'app.loadUsers()'
            );
        }
    }

    async function batchDeleteUsers() {
        const checked = document.querySelectorAll('.user-checkbox:checked');
        // 使用 data-index 获取对应的用户对象
        const names = Array.from(checked).map(cb => {
            const index = parseInt(cb.dataset.index);
            return app.users[index]?.name;
        }).filter(name => name); // 过滤掉无效的 name

        if (!names.length) return;

        // 显示自定义确认对话框
        const deleteData = await app.showBatchDeleteUserDialog(names.length);
        if (deleteData === null) return; // 用户取消

        try {
            await app.request('/api/users', {
                method: 'DELETE',
                body: JSON.stringify({ names, deleteData })
            });
            app.loadUsers();
            showSuccess('批量删除成功');
        } catch (err) {
            showError('删除失败: ' + err.message);
        }
    }

    // 显示批量删除用户确认对话框

    async function showBatchDeleteUserDialog(count) {
        return new Promise((resolve) => {
            const modal = document.getElementById('modal');
            const modalTitle = document.getElementById('modal-title');
            const modalBody = document.getElementById('modal-body');

            modalTitle.textContent = '批量删除用户确认';
            modalBody.innerHTML = `
                <div style="padding: 1rem 0;">
                    <p style="margin-bottom: 1rem; font-size: 1rem;">确定要删除选中的 <strong>${count}</strong> 个用户吗？</p>
                    <div class="form-group" style="margin-top: 1.5rem;">
                        <label class="checkbox-label" style="display: flex; align-items: center; cursor: pointer;">
                            <input type="checkbox" id="batch-delete-user-data-checkbox" style="margin-right: 0.5rem;">
                            <span>同时删除用户数据文件夹</span>
                        </label>
                        <small style="color: var(--text-secondary); display: block; margin-top: 0.5rem; margin-left: 1.5rem;">
                            ⚠️ 勾选后将永久删除所有选中用户的数据（歌单、收藏等），不可恢复！
                        </small>
                    </div>
                </div>
                <div class="form-actions" style="margin-top: 1.5rem;">
                    <button type="button" class="btn-primary" id="confirm-batch-delete-users">确认删除</button>
                    <button type="button" class="btn-secondary" id="cancel-batch-delete-users">取消</button>
                </div>
            `;

            modal.classList.remove('hidden');

            document.getElementById('confirm-batch-delete-users').addEventListener('click', () => {
                const deleteData = document.getElementById('batch-delete-user-data-checkbox').checked;
                modal.classList.add('hidden');
                resolve(deleteData);
            });

            document.getElementById('cancel-batch-delete-users').addEventListener('click', () => {
                modal.classList.add('hidden');
                resolve(null);
            });
        });
    }
    // 全选/取消全选用户

    function toggleAllUsers(checked) {
        const checkboxes = document.querySelectorAll('.user-checkbox');
        checkboxes.forEach(cb => {
            cb.checked = checked;
        });
        app.updateUserBatchBtn();
    }

    // 更新批量删除按钮状态

    function updateUserBatchBtn() {
        const checked = document.querySelectorAll('.user-checkbox:checked');
        const btn = document.getElementById('batch-delete-users-btn');
        const countSpan = document.getElementById('user-selected-count');

        if (btn && countSpan) {
            if (checked.length > 0) {
                btn.style.display = 'inline-flex';
                countSpan.textContent = checked.length;
            } else {
                btn.style.display = 'none';
            }
        }

        // 更新全选框状态（如果手动取消了某个子项，全选框也应取消）
        const selectAll = document.getElementById('select-all-users');
        if (selectAll) {
            const allCheckboxes = document.querySelectorAll('.user-checkbox');
            if (allCheckboxes.length > 0) {
                selectAll.checked = checked.length === allCheckboxes.length;
            } else {
                selectAll.checked = false;
            }
        }
    }

    function renderUsers() {
        const container = document.getElementById('users-list');
        if (!app.users.length) {
            container.innerHTML = `
                <div class="glass" style="padding: 3rem; text-align: center; width: 100%;">
                    <p style="color: var(--text-secondary);">暂无用户，点击上方按钮添加用户</p>
                </div>
            `;
            return;
        }

        container.innerHTML = app.users.map((user, index) => `
            <div class="user-row glass">
                <div class="col-checkbox">
                    <input type="checkbox" class="user-checkbox" data-index="${index}" data-admin-action="update-user-batch">
                </div>
                <div class="col-name">
                    <div class="user-avatar" style="background-color: ${stringToColor(user.name)}">
                        <span>${app.escapeHtml(user.name.charAt(0).toUpperCase())}</span>
                    </div>
                    <span class="user-name-text">${app.escapeHtml(user.name)}</span>
                    <button class="btn-icon" data-admin-action="rename-user" data-admin-index="${index}" title="重命名用户" style="margin-left: 8px;">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                </div>
                <div class="col-password">
                    <span class="password-text" id="pwd-text-${index}">******</span>
                    <button class="btn-icon" data-admin-action="toggle-password" data-admin-index="${index}" title="密码不回显">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                            <circle cx="12" cy="12" r="3"/>
                        </svg>
                    </button>
                    <button class="btn-icon" data-admin-action="edit-password" data-admin-index="${index}" title="修改密码">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                </div>
                <div class="col-status">
                    <span class="status-badge active">活跃</span>
                </div>
                <div class="col-actions">
                    <button class="btn-delete" data-admin-action="delete-user" data-admin-index="${index}" title="删除用户">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `).join('');

        // 重置全选状态
        const selectAll = document.getElementById('select-all-users');
        if (selectAll) selectAll.checked = false;
        app.updateUserBatchBtn();
    }

    function filterUsers() {
        const query = document.getElementById('user-search-input').value.toLowerCase().trim();
        const rows = document.querySelectorAll('#users-list .user-row');

        rows.forEach(row => {
            const userName = row.querySelector('.col-name').textContent.toLowerCase();
            if (userName.includes(query)) {
                row.style.display = '';
            } else {
                row.style.display = 'none';
            }
        });
    }

    function showAddUserModal() {
        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');

        modalTitle.textContent = '添加用户';
        modalBody.innerHTML = `
            <form id="add-user-form">
                <div class="form-group">
                    <label>用户名</label>
                    <input type="text" name="name" class="form-input" required />
                </div>
                <div class="form-group">
                    <label>密码</label>
                    <input type="password" name="password" class="form-input" required />
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn-primary">添加</button>
                    <button type="button" class="btn-secondary" data-admin-action="close-modal">取消</button>
                </div>
            </form>
        `;

        modal.classList.remove('hidden');

        document.getElementById('add-user-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const data = Object.fromEntries(formData);

            try {
                await app.request('/api/users', {
                    method: 'POST',
                    body: JSON.stringify(data)
                });
                app.closeModal();
                app.loadUsers();
                app.loadDashboard();
            } catch (err) {
                showError('添加用户失败: ' + err.message);
            }
        });
    }

    // 切换密码显示/隐藏

    function togglePasswordVisibility(index) {
        const el = document.getElementById(`pwd-text-${index}`);
        if (el) el.textContent = '密码不回显';
    }

    // 显示修改密码模态框

    function showEditPasswordModal(index) {
        const user = app.users[index];
        if (!user) return;

        app.editingUser = user.name; // 保存当前正在编辑的用户名
        document.getElementById('edit-password-input').value = '';
        document.getElementById('edit-password-modal').classList.remove('hidden');
    }

    // 保存新密码

    async function saveNewPassword() {
        const newPassword = document.getElementById('edit-password-input').value;
        if (!newPassword) {
            showInfo('请填写新密码');
            return;
        }

        try {
            await app.request('/api/users', {
                method: 'PUT',
                body: JSON.stringify({
                    name: app.editingUser,
                    password: newPassword
                })
            });

            document.getElementById('edit-password-modal').classList.add('hidden');
            app.loadUsers();
            showSuccess('密码修改成功');
        } catch (err) {
            showError('修改失败: ' + err.message);
        }
    }

    async function deleteUser(index) {
        const user = app.users[index];
        if (!user) return;
        const username = user.name;

        // 显示自定义确认对话框
        const deleteData = await app.showDeleteUserDialog(username);
        if (deleteData === null) return; // 用户取消

        try {
            await app.request('/api/users', {
                method: 'DELETE',
                body: JSON.stringify({ name: username, deleteData })
            });
            app.loadUsers();
            app.loadDashboard();
        } catch (err) {
            showError('删除用户失败: ' + err.message);
        }
    }

    // 显示删除用户确认对话框

    async function showDeleteUserDialog(username) {
        return new Promise((resolve) => {
            const modal = document.getElementById('modal');
            const modalTitle = document.getElementById('modal-title');
            const modalBody = document.getElementById('modal-body');

            modalTitle.textContent = '删除用户确认';
            modalBody.innerHTML = `
                <div style="padding: 1rem 0;">
                    <p style="margin-bottom: 1rem; font-size: 1rem;">确定要删除用户 <strong>"${app.escapeHtml(username)}"</strong> 吗？</p>
                    <div class="form-group" style="margin-top: 1.5rem;">
                        <label class="checkbox-label" style="display: flex; align-items: center; cursor: pointer;">
                            <input type="checkbox" id="delete-user-data-checkbox" style="margin-right: 0.5rem;">
                            <span>同时删除用户数据文件夹</span>
                        </label>
                        <small style="color: var(--text-secondary); display: block; margin-top: 0.5rem; margin-left: 1.5rem;">
                            ⚠️ 勾选后将永久删除该用户的所有数据（歌单、收藏等），不可恢复！
                        </small>
                    </div>
                </div>
                <div class="form-actions" style="margin-top: 1.5rem;">
                    <button type="button" class="btn-primary" id="confirm-delete-user">确认删除</button>
                    <button type="button" class="btn-secondary" id="cancel-delete-user">取消</button>
                </div>
            `;

            modal.classList.remove('hidden');

            document.getElementById('confirm-delete-user').addEventListener('click', () => {
                const deleteData = document.getElementById('delete-user-data-checkbox').checked;
                modal.classList.add('hidden');
                resolve(deleteData);
            });

            document.getElementById('cancel-delete-user').addEventListener('click', () => {
                modal.classList.add('hidden');
                resolve(null);
            });
        });
    }

    // 显示修改用户名模态框

    function showRenameUserModal(index) {
        const user = app.users[index];
        if (!user) return;

        app.editingUser = user.name;
        document.getElementById('rename-user-input').value = user.name;
        document.getElementById('rename-user-modal').classList.remove('hidden');
    }

    // 保存新用户名

    async function saveRenameUser() {
        const newName = document.getElementById('rename-user-input').value.trim();
        if (!newName) {
            showInfo('请填写新用户名');
            return;
        }
        if (newName === app.editingUser) {
            document.getElementById('rename-user-modal').classList.add('hidden');
            return;
        }

        try {
            await app.request('/api/users', {
                method: 'PUT',
                body: JSON.stringify({
                    name: app.editingUser,
                    newName: newName
                })
            });

            document.getElementById('rename-user-modal').classList.add('hidden');
            app.loadUsers();
            app.loadDashboard();
            showSuccess('用户名修改成功, 请重新在客户端连接');
        } catch (err) {
            showError('修改失败: ' + err.message);
        }
    }

    return {
        bindUsersEvents,
        renderAllUserSelectors,
        toggleUserDropdown,
        renderUserDropdown,
        renderUserSelectionGrid,
        selectUser,
        loadUsers,
        batchDeleteUsers,
        showBatchDeleteUserDialog,
        toggleAllUsers,
        updateUserBatchBtn,
        renderUsers,
        filterUsers,
        showAddUserModal,
        togglePasswordVisibility,
        showEditPasswordModal,
        saveNewPassword,
        deleteUser,
        showDeleteUserDialog,
        showRenameUserModal,
        saveRenameUser,
    };
}
