import type { AdminFeatureContext } from '../types';

export function initConfigFeature(context: AdminFeatureContext) {
    const app = context.app;

    function bindConfigEvents() {
        document.getElementById('config-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            app.saveConfig();
        });
        document.getElementById('reload-config-btn')?.addEventListener('click', () => {
            app.loadConfig();
        });
        document.querySelector('input[name="user.enablePublicFavorites"]')?.addEventListener('change', () => {
            app.togglePublicNonAdminAccessVisibility();
        });
        document.querySelector('input[name="user.enablePublicRestriction"]')?.addEventListener('change', () => {
            app.togglePublicNonAdminLocalMusicVisibility();
        });
    }

    async function loadConfig() {
        try {
            const config = await app.request('/api/config');
            app.configLoaded = true;
            const loadErrorEl = document.getElementById('config-load-error');
            if (loadErrorEl) {
                loadErrorEl.hidden = true;
                loadErrorEl.innerHTML = '';
            }
            const form = document.getElementById('config-form');

            form.elements['serverName'].value = config.serverName || '';
            form.elements['maxSnapshotNum'].value = config.maxSnapshotNum || 10;
            form.elements['list.addMusicLocationType'].value = config['list.addMusicLocationType'] || 'top';
            form.elements['proxy.enabled'].checked = config['proxy.enabled'] || false;
            form.elements['proxy.header'].value = config['proxy.header'] || '';
            if (form.elements['proxy.all.enabled']) {
                form.elements['proxy.all.enabled'].checked = config['proxy.all.enabled'] || false;
            }
            if (form.elements['proxy.all.address']) {
                form.elements['proxy.all.address'].value = config['proxy.all.address'] || '';
            }
            if (form.elements['user.enablePath']) {
                form.elements['user.enablePath'].checked = config['user.enablePath'] !== false;
            }
            if (form.elements['user.enableRoot']) {
                form.elements['user.enableRoot'].checked = config['user.enableRoot'] === true;
            }
            if (form.elements['user.enablePublicRestriction']) {
                form.elements['user.enablePublicRestriction'].checked = config['user.enablePublicRestriction'] === true;
            }
            if (form.elements['user.enablePublicNonAdminLocalMusic']) {
                form.elements['user.enablePublicNonAdminLocalMusic'].checked = config['user.enablePublicNonAdminLocalMusic'] === true;
            }
            app.togglePublicNonAdminLocalMusicVisibility();
            if (form.elements['user.enablePublicFavorites']) {
                form.elements['user.enablePublicFavorites'].checked = config['user.enablePublicFavorites'] === true;
            }
            if (form.elements['user.enablePublicNonAdminAccess']) {
                form.elements['user.enablePublicNonAdminAccess'].checked = config['user.enablePublicNonAdminAccess'] === true;
            }
            app.togglePublicNonAdminAccessVisibility();
            if (form.elements['user.enableLoginCacheRestriction']) {
                form.elements['user.enableLoginCacheRestriction'].checked = config['user.enableLoginCacheRestriction'] === true;
            }
            if (form.elements['user.enableCacheSizeLimit']) {
                form.elements['user.enableCacheSizeLimit'].checked = config['user.enableCacheSizeLimit'] === true;
            }
            if (form.elements['user.cacheSizeLimit']) {
                form.elements['user.cacheSizeLimit'].value = config['user.cacheSizeLimit'] || 2000;
            }
            if (form.elements['singer.sourcePriority']) {
                form.elements['singer.sourcePriority'].value = config['singer.sourcePriority'] || 'tx,wy';
            }
            form.elements['frontend.password'].value = '';
            form.elements['frontend.password'].placeholder = config['frontend.passwordConfigured'] ? '已配置，留空保持不变' : '请设置管理密码';

            // Web播放器配置
            if (form.elements['player.enableAuth']) {
                form.elements['player.enableAuth'].checked = config['player.enableAuth'] === true;
            }
            if (form.elements['player.password']) {
                form.elements['player.password'].value = '';
                form.elements['player.password'].placeholder = config['player.passwordConfigured'] ? '已配置，留空保持不变' : '请设置播放器密码';
            }


            // URL路径配置
            if (form.elements['admin.path']) {
                form.elements['admin.path'].value = config['admin.path'] ?? '';
            }
            if (form.elements['player.path']) {
                const pPath = config['player.path'] ?? '/music';
                form.elements['player.path'].value = pPath === '' ? '/' : pPath;
            }

            // [新增] 同时更新侧边栏链接
            const navPlayerLink = document.getElementById('nav-player-link');
            if (navPlayerLink) navPlayerLink.href = (config['player.path'] === '' ? '/' : (config['player.path'] ?? '/music'));

        } catch (err) {
            console.error('Failed to load config:', err);
            app.renderViewError(
                document.getElementById('config-load-error'),
                '配置加载失败: ' + err.message,
                'app.loadConfig()'
            );
        }
    }

    function togglePublicNonAdminAccessVisibility() {
        const favCb = document.querySelector('input[name="user.enablePublicFavorites"]');
        const childWrapper = document.getElementById('public-non-admin-access-wrapper');
        if (favCb && childWrapper) {
            childWrapper.style.display = favCb.checked ? 'block' : 'none';
        }
    }

    function togglePublicNonAdminLocalMusicVisibility() {
        const resCb = document.querySelector('input[name="user.enablePublicRestriction"]');
        const childWrapper = document.getElementById('public-non-admin-local-music-wrapper');
        if (resCb && childWrapper) {
            childWrapper.style.display = resCb.checked ? 'block' : 'none';
        }
    }

    async function saveConfig(silent = false) {
        if (!app.configLoaded) {
            showError('配置尚未加载，无法保存。请先点击“重新加载”获取服务器配置后再试。');
            return;
        }
        const form = document.getElementById('config-form');
        const formData = new FormData(form);

        // 路径校验
        const adminPath = (formData.get('admin.path') || '').trim();
        const playerPath = (formData.get('player.path') || '').trim();
        const errEl = document.getElementById('path-conflict-error');
        let pathError = '';

        if (!playerPath) {
            pathError = '⚠️ 播放器路径不能为空';
        } else if (!playerPath.startsWith('/')) {
            pathError = '⚠️ 播放器路径必须以 / 开头';
        } else if (adminPath !== '' && !adminPath.startsWith('/')) {
            pathError = '⚠️ 后台路径必须以 / 开头（或留空表示根路径）';
        } else if ((adminPath || '/') === (playerPath === '/' ? '/' : playerPath.replace(/\/+$/, ''))) {
            pathError = '⚠️ 后台管理路径与播放器路径不能相同';
        } else if (adminPath.startsWith('/api') || playerPath.startsWith('/api')) {
            pathError = '⚠️ 路径不能以 /api 开头（与 API 路由冲突）';
        }

        if (errEl) {
            errEl.textContent = pathError;
            errEl.style.display = pathError ? 'block' : 'none';
        }
        if (pathError) return;

        const config = {
            serverName: formData.get('serverName'),
            maxSnapshotNum: parseInt(formData.get('maxSnapshotNum')),
            'list.addMusicLocationType': formData.get('list.addMusicLocationType'),
            'proxy.enabled': formData.get('proxy.enabled') === 'on',
            'proxy.header': formData.get('proxy.header'),
            'proxy.all.enabled': formData.get('proxy.all.enabled') === 'on',
            'proxy.all.address': formData.get('proxy.all.address'),
            'user.enablePath': formData.get('user.enablePath') === 'on',
            'user.enableRoot': formData.get('user.enableRoot') === 'on',
            'user.enablePublicRestriction': formData.get('user.enablePublicRestriction') === 'on',
            'user.enablePublicNonAdminLocalMusic': formData.get('user.enablePublicNonAdminLocalMusic') === 'on',
            'user.enablePublicFavorites': formData.get('user.enablePublicFavorites') === 'on',
            'user.enablePublicNonAdminAccess': formData.get('user.enablePublicNonAdminAccess') === 'on',
            'user.enableLoginCacheRestriction': formData.get('user.enableLoginCacheRestriction') === 'on',
            'user.enableCacheSizeLimit': formData.get('user.enableCacheSizeLimit') === 'on',
            'user.cacheSizeLimit': parseInt(formData.get('user.cacheSizeLimit')) || 2000,
            'frontend.password': formData.get('frontend.password'),
            'player.enableAuth': formData.get('player.enableAuth') === 'on',
            'player.password': formData.get('player.password'),
            'admin.path': adminPath,
            'player.path': playerPath,
            'singer.sourcePriority': formData.get('singer.sourcePriority'),
        };

        try {
            const res = await app.request('/api/config', {
                method: 'POST',
                body: JSON.stringify(config)
            });

            // 更新侧边栏播放器链接
            const navPlayerLink = document.getElementById('nav-player-link');
            if (navPlayerLink) navPlayerLink.href = playerPath === '' ? '/' : (playerPath ?? '/music');

            if (!silent) {
                if (res.warning) {
                    showInfo('配置保存成功！\n\n⚠️ 警告：' + res.warning);
                } else {
                    showSuccess('配置保存成功！');
                }
            }
        } catch (err) {
            if (!silent) showError('配置保存失败: ' + err.message);
            throw err;
        }
    }
    return {
        bindConfigEvents,
        loadConfig,
        togglePublicNonAdminAccessVisibility,
        togglePublicNonAdminLocalMusicVisibility,
        saveConfig,
    };
}
