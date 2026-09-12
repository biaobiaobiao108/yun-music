import { normalizeStoredSettings } from '../player_settings';

export interface SettingsFeatureContext {
    getSettings: () => Record<string, any>;
    setSettings: (settings: Record<string, any>) => void;
    persistSettings: () => void;
    syncSettingsUI: () => void;
    setupNetworkListAutoCheck: () => void;
    pushSoundEffects: () => void;
    fetchSoundEffects: () => void;
    getUserName: () => string | null;
    showSuccess: (message: string) => void;
    showError: (message: string) => void;
}

export function initSettingsFeature(context: SettingsFeatureContext) {
    async function pushSettingsToServer(force = false): Promise<void> {
        const settings = context.getSettings();
        if (!force && !settings.saveAccountSettingsToFile) return;
        const hasUser = Boolean(context.getUserName());
        const isPublicMode = !hasUser && Boolean(window.lx_config?.['user.enablePublicRestriction']);
        if (!hasUser && !isPublicMode) return;

        try {
            const response = await fetch('/api/user/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(settings),
            });
            if (!response.ok && force) throw new Error('settings request failed');
            context.pushSoundEffects();
        } catch (error) {
            console.error('[Settings] 保存到服务器失败:', error);
            if (force) throw error;
        }
    }

    async function manualSaveSettings(button: HTMLButtonElement): Promise<void> {
        const originalText = button.innerHTML;
        try {
            button.disabled = true;
            button.textContent = '正在保存…';
            context.persistSettings();
            await pushSettingsToServer(true);
            button.textContent = '保存成功';
            context.showSuccess('配置已成功保存');
            setTimeout(() => {
                button.innerHTML = originalText;
                button.disabled = false;
            }, 2000);
        } catch (error) {
            console.error('[Settings] 手动保存失败:', error);
            button.innerHTML = originalText;
            button.disabled = false;
            context.showError('保存失败，请检查登录状态');
        }
    }

    async function fetchSettingsFromServer(): Promise<void> {
        const settings = context.getSettings();
        if (!settings.saveAccountSettingsToFile) return;
        const hasUser = Boolean(context.getUserName());
        const isPublicMode = !hasUser && Boolean(window.lx_config?.['user.enablePublicRestriction']);
        if (!hasUser && !isPublicMode) return;

        try {
            const response = await fetch('/api/user/settings', { credentials: 'same-origin', cache: 'no-store' });
            if (!response.ok) return;
            const serverSettings = await response.json() as Record<string, any>;
            context.setSettings(normalizeStoredSettings({ ...settings, ...serverSettings }));
            context.persistSettings();
            context.syncSettingsUI();
            context.setupNetworkListAutoCheck();
            context.fetchSoundEffects();
        } catch (error) {
            console.error('[Settings] 从服务器加载设置失败:', error);
        }
    }

    return { pushSettingsToServer, manualSaveSettings, fetchSettingsFromServer };
}
