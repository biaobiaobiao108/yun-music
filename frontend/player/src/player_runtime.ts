const lazyScriptPromises = new Map<string, Promise<void>>();
const lazyModulePromises = new Map<string, Promise<void>>();
let markedPromise: Promise<void> | undefined;

function loadLazyScript(src: string, globalName?: string): Promise<void> {
    if (globalName && (window as any)[globalName]) return Promise.resolve();
    if (lazyScriptPromises.has(src)) return lazyScriptPromises.get(src)!;

    const promise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`加载模块失败: ${src}`));
        document.head.appendChild(script);
    });
    lazyScriptPromises.set(src, promise);
    return promise;
}

function loadLazyModule(
    key: string,
    loader: () => Promise<unknown>,
    globalName: string,
): Promise<void> {
    if ((window as any)[globalName]) return Promise.resolve();
    if (lazyModulePromises.has(key)) return lazyModulePromises.get(key)!;

    const promise = loader().then(() => {
        if (!(window as any)[globalName]) {
            throw new Error(`懒加载模块未注册全局接口: ${globalName}`);
        }
    });
    lazyModulePromises.set(key, promise);
    return promise;
}

export function ensureMarkedLoaded() {
    if ((window as any).marked) return Promise.resolve();
    if (!markedPromise) {
        markedPromise = import('marked').then(({ marked }) => {
            (window as any).marked = marked;
        });
    }
    return markedPromise;
}

export function ensureVisualizerLoaded() {
    return loadLazyScript('js/wave.js', 'Wave')
        .then(() => loadLazyModule(
            'visualizer',
            () => import('./legacy/visualizer'),
            'musicVisualizer',
        ));
}

export function ensureLeaderboardLoaded() {
    return loadLazyModule(
        'leaderboard',
        () => import('./legacy/leaderboard_manager'),
        'LeaderboardManager',
    );
}

export function ensureLocalMusicLoaded() {
    return loadLazyModule(
        'local-music',
        () => import('./legacy/local_music'),
        'LocalMusicManager',
    );
}

export function ensureSoundEffectsLoaded() {
    return loadLazyModule(
        'sound-effects',
        () => import('./legacy/sound_effects'),
        'soundEffects',
    );
}

function showError(message: string) {
    const handler = (window as any).showError;
    if (typeof handler === 'function') handler(message);
    else console.error(message);
}

export function toggleSoundEffects() {
    const soundEffects = (window as any).soundEffects;
    if (soundEffects) {
        soundEffects.toggle();
        return;
    }
    ensureSoundEffectsLoaded()
        .then(() => (window as any).soundEffects?.toggle())
        .catch(() => showError('音效模块加载失败，请稍后重试'));
}
