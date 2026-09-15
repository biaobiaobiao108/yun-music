import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { shouldPrefetchAfterPlayback } from '../frontend/player/src/features/playback';
import { initSongUrlFeature } from '../frontend/player/src/features/song_url';
import { normalizeStoredSettings } from '../frontend/player/src/player_settings';

const projectRoot = path.join(import.meta.dir, '..');

function read(relativePath: string): string {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function listFiles(relativePath: string, extension: string): string[] {
    const directory = path.join(projectRoot, relativePath);
    const files: string[] = [];
    const visit = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) visit(fullPath);
            else if (entry.name.endsWith(extension)) files.push(fullPath);
        }
    };
    visit(directory);
    return files;
}

describe('Player manager module boundaries', () => {
    it('does not expose song list or download managers through window', () => {
        const source = [
            read('frontend/player/src/legacy/songlist_manager.ts'),
            read('frontend/player/src/legacy/download_manager.ts'),
            read('frontend/player/src/index.ts'),
        ].join('\n');

        expect(source).not.toContain('window.SongListManager');
        expect(source).not.toContain('window.SystemDownloadManager');
    });

    it('uses delegated data actions instead of manager inline handlers', () => {
        const html = read('public/music/index.html');
        const songListSource = read('frontend/player/src/legacy/songlist_manager.ts');
        const downloadSource = read('frontend/player/src/legacy/download_manager.ts');

        expect(html).not.toContain('songlist_manager.js');
        expect(html).not.toContain('download_manager.js');
        expect(html).toContain('data-songlist-action="open-external"');
        expect(songListSource).toContain('data-songlist-action="open-detail"');
        expect(html).toContain('data-download-action="retry-all-failed"');
        expect(songListSource).toContain("closest('[data-songlist-action]')");
        expect(downloadSource).toContain("closest('[data-download-action]')");
        expect(songListSource).not.toContain('onclick="window.SongListManager');
        expect(downloadSource).not.toContain('onclick="window.SystemDownloadManager');
    });

    it('does not cache removed standalone manager bundles', () => {
        const serviceWorker = read('public/music/sw.js');
        expect(serviceWorker).not.toContain('./js/songlist_manager.js');
        expect(serviceWorker).not.toContain('./js/download_manager.js');
    });

    it('keeps silent prefetch lightweight and marks playback cache requests as background work', () => {
        const songUrlSource = read('frontend/player/src/features/song_url.ts');
        const playerSource = read('frontend/player/src/index.ts');
        const playbackSource = read('frontend/player/src/features/playback.ts');

        expect(songUrlSource).toContain("this.bufferer.preload = 'metadata'");
        expect(songUrlSource).not.toContain('triggerServerCache(song, rawUrl, quality)');
        expect(playbackSource).toContain('const requestBackgroundCache = () =>');
        expect(playbackSource).toContain('const cacheSong = state.currentRecoveryState?.originalSong || song;');
        expect(playbackSource).toContain('Promise.resolve(triggerServerCache(cacheSong, urlResult.cacheUrl');
        expect(playbackSource).not.toContain('requestBackgroundCache();\n\n        // [Sync]');
        expect(playbackSource).toContain('await audio.play();');
        expect(playbackSource).toContain('requestBackgroundCache();\n\n            // 只在真正开始播放后记录');
        expect(playerSource).toContain('const serverCacheRequests = new Set<string>();');
        expect(playerSource).toContain('background: true');
        expect(playerSource).toContain('const boundedTimeoutMs = Math.max(100, Math.min(Number(timeoutMs) || 2500, 2500));');
        expect(playerSource).toContain('externalSignal?.addEventListener');
        expect(playerSource).toContain('externalSignal?.removeEventListener');
        expect(songUrlSource).toContain('const FOREGROUND_CACHE_CHECK_TIMEOUT = 1500;');
        expect(songUrlSource).toContain('const CACHE_PROCESSING_WAIT_TIMEOUT = 30 * 1000;');
        expect(songUrlSource).toContain('const waitForServerCacheCheck = async');
        expect(songUrlSource).toContain('SERVER_CACHE_PROCESSING');
        expect(songUrlSource).toContain('settings.enableServerCache !== false');
        expect(songUrlSource).not.toContain('settings.enableProxyPlayback');
        expect(songUrlSource).toContain('在线音乐统一通过服务端中转播放');
        expect(songUrlSource).toContain('signal?: AbortSignal');
        expect(shouldPrefetchAfterPlayback('server_cache')).toBe(false);
        expect(shouldPrefetchAfterPlayback('normal')).toBe(true);
        expect(playbackSource).toContain('const PREFETCH_PROGRESS_THRESHOLD = 0.8;');
        expect(playbackSource).toContain('audio.addEventListener(\'timeupdate\', maybePrefetchNextSong);');
        expect(playbackSource).toContain('if (currentTime / duration < PREFETCH_PROGRESS_THRESHOLD) return;');
        expect(playbackSource).toContain('prefetchManager.cancelInflightExcept?.(song.id);');
        expect(playbackSource).toContain('const pendingPrefetch = prefetchManager.getPending?.(song.id, preferredQuality);');
        expect(playbackSource).toContain('await pendingPrefetch;');
        expect(playbackSource).not.toContain('if (shouldPrefetchAfterPlayback(state.currentSourceType)) prefetchNextSong();');
        expect(songUrlSource).toContain("if (isSilent) requestInit.priority = 'low';");
        expect(songUrlSource).toContain('abortController.signal');
        expect(songUrlSource).toContain('getPending(songId, requestedQuality)');
        expect(songUrlSource).toContain('if (e?.name === \'AbortError\') return;');
        expect(songUrlSource).toContain('if (result) return;');
    });

    it('reuses an unexpired prefetched URL without another remote Range probe', async () => {
        const runtime = globalThis as any;
        const previousAudio = runtime.Audio;
        const previousWindow = runtime.window;
        const previousLocalStorage = runtime.localStorage;
        const previousFetch = runtime.fetch;
        let fetchCalls = 0;

        class FakeAudio {
            muted = false;
            preload = '';
            src = '';
            currentSrc = '';
            load() { }
            pause() { }
            removeAttribute(name: string) {
                if (name === 'src') this.src = '';
            }
        }

        try {
            runtime.Audio = FakeAudio;
            runtime.window = {
                location: { host: 'localhost', origin: 'http://localhost', protocol: 'http:' },
                QualityManager: { getBestQuality: () => 'flac' },
            };
            runtime.localStorage = {
                getItem: () => null,
                setItem: () => { },
                removeItem: () => { },
            };
            runtime.fetch = async () => {
                fetchCalls++;
                return new Response('', { status: 206 });
            };

            const playlist = [
                { id: 'current', source: 'wy', name: 'Current' },
                { id: 'next', source: 'wy', name: 'Next' },
            ];
            const feature = initSongUrlFeature({
                getSettings: () => ({ enablePreloader: true, preferredQuality: 'flac' }),
                getPlaylist: () => playlist,
                getCurrentIndex: () => 0,
                getPlayMode: () => 'list',
                getPreSelectedNextIndex: () => null,
                setPreSelectedNextIndex: () => { },
                getUserAuthHeaders: () => ({}),
                fetchCustomSources: async () => [],
                cleanSongData: song => song,
                checkServerCache: async () => ({ exists: false }),
                updateStorageStatsUI: () => { },
                showInfo: () => { },
                showSuccess: () => { },
                showError: () => { },
            });
            feature.prefetchManager.set('next', {
                url: 'https://media.example/next.flac',
                quality: 'flac',
                requestedQuality: 'flac',
                sourceType: 'normal',
            });

            await feature.prefetchNextSong();

            expect(fetchCalls).toBe(0);
        } finally {
            runtime.Audio = previousAudio;
            runtime.window = previousWindow;
            runtime.localStorage = previousLocalStorage;
            runtime.fetch = previousFetch;
        }
    });

    it('always routes online playback through the server proxy and removes the legacy toggle', async () => {
        expect(read('frontend/player/index.html')).not.toContain('toggle-proxy-playback');
        expect(read('frontend/player/src/index.ts')).not.toContain('changeProxyPlayback');

        const runtime = globalThis as any;
        const previousAudio = runtime.Audio;
        const previousWindow = runtime.window;

        class FakeAudio {
            muted = false;
            preload = '';
            src = '';
            currentSrc = '';
            load() { }
            pause() { }
            removeAttribute(name: string) {
                if (name === 'src') this.src = '';
            }
        }

        try {
            runtime.Audio = FakeAudio;
            runtime.window = {
                location: { host: 'localhost', origin: 'http://localhost', protocol: 'http:' },
            };

            const feature = initSongUrlFeature({
                getSettings: () => ({ enableProxyPlayback: false, enableCustomProxy: false }),
                getPlaylist: () => [],
                getCurrentIndex: () => 0,
                getPlayMode: () => 'list',
                getPreSelectedNextIndex: () => null,
                setPreSelectedNextIndex: () => { },
                getUserAuthHeaders: () => ({}),
                fetchCustomSources: async () => [],
                cleanSongData: song => song,
                checkServerCache: async () => ({ exists: false }),
                updateStorageStatsUI: () => { },
                showInfo: () => { },
                showSuccess: () => { },
                showError: () => { },
            });

            const proxyUrl = await feature.applyAutoProxy(
                'https://media.example/song.flac?token=abc',
                { name: 'Song', singer: 'Singer' },
            );

            expect(proxyUrl).toStartWith('/api/music/download?');
            expect(new URL(`http://localhost${proxyUrl}`).searchParams.get('url'))
                .toBe('https://media.example/song.flac?token=abc');

            const legacySettings = { enableProxyPlayback: false };
            normalizeStoredSettings(legacySettings);
            expect(legacySettings).not.toHaveProperty('enableProxyPlayback');
        } finally {
            runtime.Audio = previousAudio;
            runtime.window = previousWindow;
        }
    });

    it('bounds browser media lifecycles and releases transient download resources', () => {
        const songUrlSource = read('frontend/player/src/features/song_url.ts');
        const playerSource = read('frontend/player/src/index.ts');
        const playerHtml = read('frontend/player/index.html');
        const playbackSource = read('frontend/player/src/features/playback.ts');
        const visualizerSource = read('frontend/player/src/legacy/visualizer.ts');
        const downloadSource = read('frontend/player/src/legacy/download_manager.ts');
        const singleSongSource = read('frontend/player/src/legacy/single_song_ops.ts');
        const searchSource = read('frontend/player/src/features/search.ts');

        expect(songUrlSource).toContain('const PREFETCH_CACHE_MAX = 5;');
        expect(songUrlSource).toContain('const PREFETCH_CACHE_TTL = 30 * 60 * 1000;');
        expect(songUrlSource).toContain('requestedQuality: data.requestedQuality || data.quality');
        expect(songUrlSource).toContain('this.stopBufferer();');
        expect(songUrlSource).toContain('const PREFETCH_FAILURE_TTL = 60 * 1000;');
        expect(songUrlSource).toContain('inflight: new Map()');
        expect(songUrlSource).toContain('await response.body?.cancel()');
        expect(songUrlSource).toContain('this.bufferer.removeAttribute(\'src\')');
        expect(playbackSource).toContain('audio.error || audio.readyState === 0 || audio.networkState === 3');
        expect(playbackSource).toContain('prefetchManager.delete(song.id);');
        expect(playbackSource).toContain('pendingRestoreCleanup?.();');
        expect(playbackSource).toContain('playbackErrorCleanup?.();');
        expect(playbackSource).toContain('const currentAudioUrls = [audio.currentSrc, audio.src].filter(Boolean);');
        expect(playbackSource).not.toContain('waitForBackgroundCacheAndRetry');
        expect(playbackSource).toContain('urlOverride = null');
        expect(playbackSource).toContain('retrying through the streaming proxy');
        expect(playbackSource).toContain('let backgroundCacheRequested = false;');
        expect(playbackSource).toContain('Cache is deliberately a post-play side effect.');
        expect(songUrlSource).toContain("console.warn(`[Resolve] ${msg}`);");
        expect(songUrlSource).not.toContain('else showError(msg);');
        expect(songUrlSource).toContain('buildPlaybackProxyUrl');
        expect(songUrlSource).toContain('playbackProxyUrl: buildPlaybackProxyUrl');
        expect(playbackSource).toContain('const retryMode = state.currentSourceType === \'server_cache\'');
        expect(playbackSource).toContain('_prefetchUnavailableUntil');
        expect(singleSongSource).toContain('const REMOTE_QUALITY_CACHE_MAX = 256;');
        expect(singleSongSource).toContain('const remoteQualitySizeInflight = new Map();');
        expect(playbackSource).toContain('void playSong(song, state.currentIndex, null, false, true, null, resumeTime);');
        expect(playerSource).toContain("playSong(state.song, currentIndex, null, true, 'restore');");
        expect(songUrlSource).toContain('const allowLinkCache = !isRetry && settings.enableSongUrlCache !== false;');
        expect(searchSource).toContain('const ARTIST_SONG_PAGE_CACHE_MAX = 24;');
        expect(searchSource).toContain('const ARTIST_ALBUM_PAGE_CACHE_MAX = 12;');
        expect(playbackSource).toContain('type PlaybackAttemptContext = {');
        expect(playbackSource).toContain('activePlaybackAttempt');
        expect(playbackSource).toContain('activePlaybackAttempt.abortController.abort();');
        expect(playbackSource).toContain('Duplicate playback target rejected');
        expect(playerHtml).toContain('id="player-playback-status"');
        expect(playerSource).toContain('showPlaybackStatus');

        expect(visualizerSource).toContain('prototype.stop = function ()');
        expect(visualizerSource).toContain('window.cancelAnimationFrame');
        expect(visualizerSource).toContain('waveFooter.stop();');
        expect(visualizerSource).toContain('waveFooter.start();');

        expect(downloadSource).toContain('activeReader.cancel()');
        expect(downloadSource).toContain('downloadChunks = null;');
        expect(downloadSource).toContain('URL.revokeObjectURL(blobUrl), 1000');
    });

    it('defers songlist loading and paginates detail requests', () => {
        const songListSource = read('frontend/player/src/legacy/songlist_manager.ts');
        const indexSource = read('frontend/player/src/index.ts');
        const navigationSource = read('frontend/player/src/features/navigation.ts');
        const detailRoute = read('src/server/routes/music.ts');
        const wySource = read('src/modules/utils/musicSdk/wy/songList.ts');
        const txSource = read('src/modules/utils/musicSdk/tx/songList.ts');

        expect(songListSource).toContain('async function load()');
        expect(songListSource).toContain('async function ensureAllLoaded()');
        expect(songListSource).toContain('page=${page}&limit=${detailState.limit}');
        expect(navigationSource).toContain('void context.songListManager.load().catch');
        expect(indexSource).toContain('songListManager,');
        expect(indexSource).toContain('await songListManager.ensureAllLoaded()');
        expect(detailRoute).toContain("const limit = boundedInt(ctx.query.get('limit'), 50, 1, 100)");
        expect(wySource).toContain('n: pageLimit');
        expect(txSource).toContain('allSongs.slice(rangeStart, rangeStart + pageLimit)');
    });

    it('does not contain inline HTML event attributes in player sources or templates', () => {
        const files = [
            ...listFiles('frontend/player/src', '.ts'),
            path.join(projectRoot, 'public/music/index.html'),
            path.join(projectRoot, 'public/music/login.html'),
        ];
        const inlineEventAttribute = /\bon[a-zA-Z]+\s*=\s*["']/;
        const violations = files.flatMap(file => {
            const source = fs.readFileSync(file, 'utf8');
            return inlineEventAttribute.test(source) ? [path.relative(projectRoot, file)] : [];
        });

        expect(violations).toEqual([]);
    });

    it('keeps retained cross-module dependencies explicit and removes retired sync modules', () => {
        const searchSource = read('frontend/player/src/features/search.ts');
        const paginationSource = read('frontend/player/src/legacy/batch_pagination.ts');
        const indexSource = read('frontend/player/src/index.ts');

        expect(searchSource).toContain("import { updatePaginationInfo } from '../legacy/batch_pagination';");
        expect(searchSource).not.toContain('window.updatePaginationInfo');
        expect(paginationSource).toContain('export function updatePaginationInfo');
        expect(fs.existsSync(path.join(projectRoot, 'frontend/player/src/features/sync.ts'))).toBe(false);
        expect(fs.existsSync(path.join(projectRoot, 'frontend/player/src/legacy/user_sync.ts'))).toBe(false);
        expect(indexSource).not.toContain('RemoteClient');
        expect(indexSource).not.toContain('SyncManager');
        expect(indexSource).toContain('Object.assign(window, { getImgUrl, createMarqueeHtml, applyMarqueeChecks });');
    });

    it('exposes lazy-loaded leaderboard actions to delegated events', () => {
        const leaderboardSource = read('frontend/player/src/legacy/leaderboard_manager.ts');

        for (const action of [
            'changeLeaderboardSource',
            'leaderboardChangePage',
            'playAllLeaderboard',
            'toggleLbBatchMode',
            'lbSelectAll',
            'lbToggleListSearch',
        ]) {
            expect(leaderboardSource).toContain(`${action},`);
        }
        expect(leaderboardSource).toContain('Object.assign(window, {');
    });

    it('exposes retained delegated actions from the player entrypoint', () => {
        const indexSource = read('frontend/player/src/index.ts');

        for (const action of [
            'showInitialSearchState',
            'loadLocalFonts',
            'changeLyricFontFamily',
            'handleLyricScroll',
            'collectCurrentSongList',
            'handleLogout',
            'handleLocalLogin',
            'handleUserLogout',
        ]) {
            expect(indexSource).toContain(`window.${action} = ${action};`);
        }
        expect(fs.existsSync(path.join(projectRoot, 'frontend/player/src/token_management.ts'))).toBe(false);
    });
});
