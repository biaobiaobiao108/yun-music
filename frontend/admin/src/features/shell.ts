import type { AdminFeatureContext } from '../types';
import { renderSafeMarkdown } from '../utils';

export function initShellFeature(context: AdminFeatureContext) {
    const app = context.app;

    function bindShellEvents() {
        document.getElementById('login-btn')?.addEventListener('click', () => app.login());
        const passwordInput = document.getElementById('access-password') as HTMLInputElement | null;
        const passwordToggle = document.getElementById('toggle-access-password') as HTMLButtonElement | null;
        passwordToggle?.addEventListener('click', () => {
            if (!passwordInput) return;
            const isVisible = passwordInput.type === 'text';
            passwordInput.type = isVisible ? 'password' : 'text';
            passwordToggle.setAttribute('aria-pressed', String(!isVisible));
            passwordToggle.setAttribute('aria-label', isVisible ? '显示密码' : '隐藏密码');
            passwordToggle.title = isVisible ? '显示密码' : '隐藏密码';
            const icon = passwordToggle.querySelector('i');
            if (icon) icon.className = isVisible ? 'fas fa-eye' : 'fas fa-eye-slash';
            passwordInput.focus({ preventScroll: true });
        });
        passwordInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') app.login();
        });
        document.getElementById('logout-btn')?.addEventListener('click', () => app.logout());

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (event) => {
                const view = item.dataset.view;
                if (view === 'music') return;
                event.preventDefault();
                app.switchView(view);
            });
        });

        document.querySelectorAll('.action-btn').forEach(button => {
            button.addEventListener('click', () => app.handleQuickAction(button.dataset.action));
        });

        document.addEventListener('click', event => {
            const target = event.target instanceof Element
                ? event.target.closest<HTMLElement>('[data-admin-action]')
                : null;
            if (!target) return;
            const action = target.dataset.adminAction;
            const index = Number(target.dataset.adminIndex);
            switch (action) {
                case 'switch-users':
                    app.switchView('users');
                    break;
                case 'switch-storage-cache':
                    app.switchView('storage');
                    app.switchStorageTab('cache');
                    break;
                case 'switch-storage-music':
                    app.switchView('storage');
                    app.switchStorageTab('music');
                    break;
                case 'toggle-user-dropdown':
                    app.toggleUserDropdown(target.dataset.adminDropdown);
                    break;
                case 'select-user':
                    app.selectUser(target.dataset.adminUserType, target.dataset.adminUserName);
                    break;
                case 'view-all-songs':
                    app.viewAllSongs();
                    break;
                case 'view-system-list':
                    app.viewSystemList(target.dataset.adminListType);
                    break;
                case 'render-playlists':
                    app.renderPlaylists();
                    break;
                case 'view-playlist':
                    app.viewPlaylistDetails(index);
                    break;
                case 'delete-playlist':
                    app.deletePlaylist(index);
                    break;
                case 'edit-playlist':
                    app.editPlaylistName(index);
                    break;
                case 'filter-songs':
                    app.filterSongs();
                    break;
                case 'sort-songs':
                    app.sortSongs();
                    break;
                case 'select-all-songs':
                    app.selectAllSongs();
                    break;
                case 'invert-selection':
                    app.invertSelection();
                    break;
                case 'clear-selection':
                    app.clearSelection();
                    break;
                case 'batch-delete-songs':
                    app.batchDeleteSongs();
                    break;
                case 'delete-song':
                    app.deleteSong(target.dataset.adminPlaylistType ?? index, Number(target.dataset.adminSongIndex));
                    break;
                case 'rename-user':
                    app.showRenameUserModal(index);
                    break;
                case 'toggle-password':
                    app.togglePasswordVisibility(index);
                    break;
                case 'edit-password':
                    app.showEditPasswordModal(index);
                    break;
                case 'delete-user':
                    app.deleteUser(index);
                    break;
                case 'close-modal':
                    app.closeModal();
                    break;
                case 'trigger-upload-snapshot':
                    app.triggerUploadSnapshot();
                    break;
                case 'load-snapshots':
                    app.loadSnapshots();
                    break;
                case 'download-local-backup':
                    void app.downloadLocalBackup();
                    break;
                case 'trigger-local-restore':
                    app.triggerLocalRestore();
                    break;
                case 'retry': {
                    const retry = app[target.dataset.adminMethod];
                    if (typeof retry === 'function') retry.call(app);
                    break;
                }
            }
        });

        document.addEventListener('input', event => {
            const target = event.target as HTMLElement;
            if (target.dataset.adminAction === 'filter-users') app.filterUsers();
            if (target.dataset.adminAction === 'filter-songs') app.filterSongs();
        });

        document.addEventListener('change', event => {
            const target = event.target as HTMLInputElement | HTMLSelectElement;
            switch (target.dataset.adminAction) {
                case 'sort-songs':
                    app.sortSongs();
                    break;
                case 'toggle-all-songs':
                    app.toggleAllSongs((target as HTMLInputElement).checked);
                    break;
                case 'update-batch-delete':
                    app.updateBatchDeleteBtn();
                    break;
                case 'update-user-batch':
                    app.updateUserBatchBtn();
                    break;
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target = event.target instanceof Element
                ? event.target.closest<HTMLElement>('[data-admin-action]')
                : null;
            if (!target || !['BUTTON', 'DIV'].includes(target.tagName)) return;
            event.preventDefault();
            target.click();
        });

        document.querySelectorAll('.modal-close').forEach(button => {
            button.addEventListener('click', () => {
                document.getElementById('edit-password-modal')?.classList.add('hidden');
                document.getElementById('rename-user-modal')?.classList.add('hidden');
                document.getElementById('modal')?.classList.add('hidden');
            });
        });

        document.querySelector('.modal-close')?.addEventListener('click', () => app.closeModal());
        document.getElementById('modal')?.addEventListener('click', (event) => {
            if (event.target.id === 'modal') app.closeModal();
        });

        app.deferredPrompt = null;
        window.addEventListener('beforeinstallprompt', (event) => {
            event.preventDefault();
            app.deferredPrompt = event;
            const installButton = document.getElementById('install-pwa-btn');
            if (installButton) {
                installButton.style.display = 'inline-flex';
                installButton.addEventListener('click', () => app.installPWA());
            }
        });

        document.addEventListener('click', (event) => {
            if (!event.target.closest('.custom-user-selector')) {
                document.querySelectorAll('.selector-dropdown').forEach(dropdown => dropdown.classList.add('hidden'));
                document.querySelectorAll('.custom-user-selector').forEach(selector => selector.classList.remove('open'));
            }
        });

        app.initMobileEvents();
        app.initPlayerLink();
    }

    function initMobileEvents() {
        const mobileMenuBtn = document.getElementById('mobile-menu-btn');
        const mobileSidebarOverlay = document.getElementById('mobile-sidebar-overlay');
        const sidebar = document.querySelector('.sidebar');

        const toggleSidebar = () => {
            sidebar.classList.toggle('active');
            mobileSidebarOverlay.classList.toggle('active');
            if (mobileSidebarOverlay.classList.contains('active')) {
                mobileSidebarOverlay.classList.remove('hidden');
            } else {
                // Wait for animation to finish before hiding
                setTimeout(() => {
                    if (!mobileSidebarOverlay.classList.contains('active')) {
                        mobileSidebarOverlay.classList.add('hidden');
                    }
                }, 300);
            }
        };

        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', toggleSidebar);
        }

        if (mobileSidebarOverlay) {
            mobileSidebarOverlay.addEventListener('click', toggleSidebar);
        }

        // Close on nav click (mobile only)
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                if (window.innerWidth <= 768 && sidebar && sidebar.classList.contains('active')) {
                    toggleSidebar();
                }
            });
        });
    }

    async function installPWA() {
        if (!app.deferredPrompt) return;
        app.deferredPrompt.prompt();
        const { outcome } = await app.deferredPrompt.userChoice;
        console.log(`User response to the install prompt: ${outcome}`);
        app.deferredPrompt = null;
        document.getElementById('install-pwa-btn').style.display = 'none';
    }

    async function login() {
        const password = document.getElementById('access-password').value;
        const errorEl = document.getElementById('login-error');

        if (!password) {
            errorEl.textContent = '请输入密码';
            return;
        }

        try {
            const res = await app.request('/api/login', {
                method: 'POST',
                body: JSON.stringify({ password })
            });

            if (res.success) {
                app.showApp();
                app.loadDashboard();
            } else {
                errorEl.textContent = res.message || '密码错误';
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : '';
            errorEl.textContent = /[\u4e00-\u9fff]/.test(message) ? message : '登录失败，请重试';
        }
    }

    function logout(notice?: string) {
        void fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
        // Survive the reload so the login overlay can explain why the user is back here.
        if (notice) sessionStorage.setItem('lx_auth_notice', notice);
        location.reload();
    }

    function showApp() {
        document.getElementById('login-overlay').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
    }

    async function switchView(viewName) {
        const updateDOM = () => {
            // 更新导航状态
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.toggle('active', item.dataset.view === viewName);
            });

            // 切换视图
            document.querySelectorAll('.view').forEach(view => {
                view.classList.toggle('active', view.id === `view-${viewName}`);
            });
        };

        const doc = document as any;
        const prefersReducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!prefersReducedMotion && typeof doc.startViewTransition === 'function') {
            try {
                doc.startViewTransition(updateDOM);
            } catch {
                updateDOM();
            }
        } else {
            updateDOM();
        }

        // 更新标题
        const titles = {
            dashboard: '仪表盘',
            users: '用户管理',
            storage: '数据管理',
            data: '数据查看',
            config: '系统配置',
            logs: '系统日志',
            snapshots: '快照管理',
            about: '关于'
        };
        document.getElementById('page-title').textContent = titles[viewName] || viewName;

        app.currentView = viewName;

        // 加载对应数据
        switch (viewName) {
            case 'dashboard':
                app.loadDashboard();
                break;
            case 'users':
                app.loadUsers();
                break;
            case 'storage':
                app.loadStorageData();
                break;
            case 'data':
                app.loadUserData();
                break;
            case 'config':
                app.loadConfig();
                break;
            case 'logs':
                app.loadLogs();
                break;
            case 'snapshots':
                app.loadSnapshots();
                break;
            case 'about':
                app.loadAbout();
                break;
            case 'music':
                window.location.href = (window.CONFIG && window.CONFIG['player.path']) || '/music';
                return;
        }
    }

    function handleQuickAction(action) {
        switch (action) {
            case 'add-user':
                app.switchView('users');
                setTimeout(() => app.showAddUserModal(), 100);
                break;
            case 'view-logs':
                app.switchView('logs');
                break;
            case 'edit-config':
                app.switchView('config');
                break;
        }
    }

    async function loadAbout() {
        const container = document.getElementById('about-content');
        if (!container) return;

        try {
            const response = await fetch('/about.md');
            if (!response.ok) throw new Error('Failed to load about.md');
            const text = await response.text();

            // Replace the build hash placeholder; application version is intentionally not shown in the UI.
            const buildHash = (window.CONFIG && window.CONFIG.buildHash) || 'unknown';
            const content = text.replace(/{{buildHash}}/g, buildHash);
            renderSafeMarkdown(container, content);
        } catch (e) {
            console.error('Failed to load about content:', e);
            container.innerHTML = '<p style="color: var(--accent-error); text-align: center;">加载关于页面失败</p>';
        }
    }

    function initPlayerLink() {
        // 初始化播放器链接
        const navPlayerLink = document.getElementById('nav-player-link');
        if (navPlayerLink && window.CONFIG && window.CONFIG['player.path']) {
            navPlayerLink.href = window.CONFIG['player.path'];
        }
    }

    function closeModal() {
        document.getElementById('modal').classList.add('hidden');
    }
    return {
        bindShellEvents,
        initMobileEvents,
        installPWA,
        login,
        logout,
        showApp,
        switchView,
        handleQuickAction,
        loadAbout,
        initPlayerLink,
        closeModal,
    };
}
