const THEMES = ['netease', 'emerald', 'blue', 'amber', 'violet', 'rose'];

export function setTheme(themeName: string, save = true): void {
    if (!THEMES.includes(themeName)) return;
    document.documentElement.setAttribute('data-theme', themeName);
    if (save) localStorage.setItem('lx_theme', themeName);
    (window as any).musicVisualizer?.applySettings?.();
    document.querySelectorAll<HTMLElement>('.theme-option').forEach(button => {
        button.setAttribute('data-active', String(button.dataset.theme === themeName));
    });
}

export function setAppearance(mode: string, save = true): void {
    if (!['light', 'dark', 'system'].includes(mode)) return;
    if (mode === 'system') {
        document.documentElement.removeAttribute('data-appearance');
        document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches);
    } else {
        document.documentElement.setAttribute('data-appearance', mode);
        document.documentElement.classList.toggle('dark', mode === 'dark');
    }
    if (save) localStorage.setItem('lx_appearance', mode);
    updateAppearanceUI(mode);
}

function updateAppearanceUI(activeMode: string): void {
    document.querySelectorAll<HTMLElement>('.appearance-option').forEach(button => {
        const active = button.dataset.appearance === activeMode;
        button.classList.toggle('appearance-option-active', active);
        button.classList.toggle('t-border-main', !active);
        button.classList.toggle('t-text-muted', !active);
    });
}

export function switchSettingsTab(tabName: string): void {
    for (const name of ['system', 'display', 'logic', 'logs']) {
        document.getElementById(`settings-panel-${name}`)?.classList.toggle('hidden', name !== tabName);
        const tab = document.getElementById(`settings-tab-${name}`);
        tab?.classList.toggle('settings-tab-active', name === tabName);
        tab?.classList.toggle('settings-tab', name !== tabName);
    }
    if (tabName === 'logs') (window as any).renderSystemLogs?.();
    document.getElementById(`settings-tab-${tabName}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

export function initTheme(): void {
    setTheme(localStorage.getItem('lx_theme') || 'emerald', false);
    setAppearance(localStorage.getItem('lx_appearance') || 'system', false);
}

export function goToAdmin(): void {
    location.href = (window as any).CONFIG?.['admin.path'] || '/';
}

Object.assign(window, { initTheme, setTheme, setAppearance, switchSettingsTab, goToAdmin });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
    if ((localStorage.getItem('lx_appearance') || 'system') === 'system') {
        document.documentElement.classList.toggle('dark', event.matches);
    }
});

document.addEventListener('DOMContentLoaded', initTheme);
