/**
 * Global Keyboard Shortcuts Manager for 云音播放器
 */

export type ShortcutsFeatureContext = {
    getSettings: () => { enableKeyboardShortcuts?: boolean; showFooterVisualizer?: boolean; showDetailVisualizer?: boolean };
    togglePlay: () => void | Promise<void>;
    changeVolume: (delta: number) => void;
    handleSeekKey: (direction: 'forward' | 'backward', state: 'down' | 'up') => void;
    playPrev: () => void;
    playNext: () => void;
    toggleLyrics: () => void;
    switchTab: (tabId: string) => void;
    updateSetting: (key: string, value: any) => void | Promise<void>;
    toggleCacheDrawer?: () => void;
    getDownloadManager?: () => { toggleDrawer: () => void } | undefined;
};

export function initShortcutsFeature(context: ShortcutsFeatureContext) {
    const onKeyDown = (e: KeyboardEvent) => {
        const settings = context.getSettings();
        if (!settings.enableKeyboardShortcuts) return;

        // 如果焦点在可输入控件中，忽略全局播放控制快捷键
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                void context.togglePlay();
                break;
            case 'ArrowUp':
                e.preventDefault();
                context.changeVolume(0.05);
                break;
            case 'ArrowDown':
                e.preventDefault();
                context.changeVolume(-0.05);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                context.handleSeekKey('backward', 'down');
                break;
            case 'ArrowRight':
                e.preventDefault();
                context.handleSeekKey('forward', 'down');
                break;
            case 'BracketLeft': // '['
                context.playPrev();
                break;
            case 'BracketRight': // ']'
                context.playNext();
                break;
            case 'KeyL':
                context.toggleLyrics();
                break;
            case 'Digit1':
                if (e.altKey) context.switchTab('search');
                break;
            case 'Digit2':
                if (e.altKey) context.switchTab('songlist');
                break;
            case 'Digit3':
                if (e.altKey) context.switchTab('leaderboard');
                break;
            case 'Digit4':
                if (e.altKey) context.switchTab('favorites');
                break;
            case 'Digit5':
                if (e.altKey) context.switchTab('settings');
                break;
            case 'KeyF':
                context.updateSetting('showFooterVisualizer', !settings.showFooterVisualizer);
                break;
            case 'KeyG':
                context.updateSetting('showDetailVisualizer', !settings.showDetailVisualizer);
                break;
            case 'KeyH':
                context.toggleCacheDrawer?.();
                break;
            case 'KeyJ':
                context.getDownloadManager?.()?.toggleDrawer();
                break;
        }
    };

    const onKeyUp = (e: KeyboardEvent) => {
        const settings = context.getSettings();
        if (!settings.enableKeyboardShortcuts) return;
        if (e.code === 'ArrowLeft') context.handleSeekKey('backward', 'up');
        if (e.code === 'ArrowRight') context.handleSeekKey('forward', 'up');
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    return {
        destroy() {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('keyup', onKeyUp);
        }
    };
}
