import {
    escapeHtmlText,
    safeImageUrl,
    safeInlineJson,
    safeInlineString,
} from '../player_security';
import { toUserMessage } from '../player_notifications';

export type PlaybackState = {
    currentLoadingSongId: any;
    loadingRequestCounter: number;
    currentLoadingRequestId: number;
    currentQuality: any;
    currentSourceType: string;
    currentRecoveryState: any;
    currentPlaylist: any[];
    currentIndex: number;
    preSelectedNextIndex: number | null;
    currentPlayingScope: string;
    currentPlayingSong: any;
    playMode: string;
    currentRawLrc: string;
    currentRawTlrc: string;
    currentRawRlrc: string;
    currentRawKlrc: string;
    isUserScrolling: boolean;
    scrollLockTimeout: any;
    lyricPlayer: any;
    currentVolume: number;
    isMuted?: boolean;
    [key: string]: any;
};

export type PlaybackFeatureContext = {
    audio: HTMLAudioElement;
    state: PlaybackState;
    getSettings: () => Record<string, any>;
    getViewingPlaylist: () => any[];
    getCurrentSearchScope: () => string;
    getCurrentListData: () => any;
    getUserAuthHeaders: () => Record<string, string>;
    resolveSongUrl: (...args: any[]) => any;
    triggerServerCache?: (...args: any[]) => any;
    getSourceTypeText: (...args: any[]) => any;
    getSourceName: (...args: any[]) => any;
    findOtherSourceMatch: (...args: any[]) => any;
    getNextIndex: (...args: any[]) => any;
    prefetchNextSong: (...args: any[]) => any;
    prefetchManager: any;
    fetchLyric: (...args: any[]) => any;
    updateMediaSessionMetadata: (...args: any[]) => any;
    updateLyricDetailInfo?: (...args: any[]) => any;
    renderQueue: (...args: any[]) => any;
    updateQueueBadge?: () => void;
    cleanSongData: (...args: any[]) => any;
    getImgUrl: (...args: any[]) => any;
    getQualityTags: (...args: any[]) => any;
    getSourceTag: (...args: any[]) => any;
    applyMarqueeChecks: (...args: any[]) => any;
    performSearch: (...args: any[]) => any;
    showOptions: (...args: any[]) => any;
    openPlaylistAddModal: (...args: any[]) => any;
    toggleCurrentLike: (...args: any[]) => any;
    isUserLoggedIn: (...args: any[]) => boolean;
    toggleDetailCover: (...args: any[]) => any;
    showInfo: (...args: any[]) => any;
    showSuccess: (...args: any[]) => any;
    showError: (...args: any[]) => any;
    showPlaybackStatus?: (...args: any[]) => any;
    pushDataChange: (...args: any[]) => any;
    renderMyLists: (...args: any[]) => any;
};

type PlaybackAttemptContext = {
    rootSongId: string;
    requestId: number;
    abortController: AbortController;
    stage: 'resolving' | 'loading' | 'playing' | 'recovering';
    triedTargets: Set<string>;
};

export const shouldPrefetchAfterPlayback = (sourceType: string) => sourceType !== 'server_cache';
const PREFETCH_PROGRESS_THRESHOLD = 0.8;

export function initPlaybackFeature(context: PlaybackFeatureContext) {
    const API_BASE = '/api/music';
    const state = context.state;
    const audio = context.audio;
    const settings = new Proxy<Record<string, any>>({}, {
        get: (_target, property) => context.getSettings()?.[property],
        set: (_target, property, value) => {
            const current = context.getSettings();
            if (current) current[property] = value;
            return true;
        },
    });
    const getUserAuthHeaders = context.getUserAuthHeaders;
    const resolveSongUrl = context.resolveSongUrl;
    const triggerServerCache = context.triggerServerCache;
    const getSourceTypeText = context.getSourceTypeText;
    const getSourceName = context.getSourceName;
    const findOtherSourceMatch = context.findOtherSourceMatch;
    const getNextIndex = context.getNextIndex;
    const prefetchNextSong = context.prefetchNextSong;
    const prefetchManager = context.prefetchManager;
    const fetchLyric = context.fetchLyric;
    const updateMediaSessionMetadata = context.updateMediaSessionMetadata;
    const renderQueue = context.renderQueue;
    const updateQueueBadge = context.updateQueueBadge || (() => (window as any).updateQueueBadge?.());
    const cleanSongData = context.cleanSongData;
    const getImgUrl = context.getImgUrl;
    const getQualityTags = context.getQualityTags;
    const getSourceTag = context.getSourceTag;
    const applyMarqueeChecks = context.applyMarqueeChecks;
    const performSearch = context.performSearch;
    const showOptions = context.showOptions;
    const openPlaylistAddModal = context.openPlaylistAddModal;
    const toggleCurrentLike = context.toggleCurrentLike;
    const isUserLoggedIn = context.isUserLoggedIn;
    const toggleDetailCover = context.toggleDetailCover;
    const showInfo = context.showInfo;
    const showSuccess = context.showSuccess;
    const showError = context.showError;
    const showPlaybackStatus = context.showPlaybackStatus || (() => { });
    const pushDataChange = context.pushDataChange;
    const renderMyLists = context.renderMyLists;
    const PLAYBACK_QUEUE_LIMIT = 99;
    let hintTimeout: ReturnType<typeof setTimeout> | null = null;
    // A restored source may still be resolving while the user presses play.
    // Keep the intent until that source has been installed instead of calling
    // play() against the previous (or empty) media source.
    let playAfterSourceReady = false;
    let manualPlaybackRecoveryCleanup: (() => void) | null = null;
    let playbackErrorCleanup: (() => void) | null = null;
    let pendingRestoreCleanup: (() => void) | null = null;
    // 连续播放失败计数：限制自动跳过次数，避免整张歌单不可播时无限循环。
    let consecutivePlaybackFailures = 0;
    let noSourceHintShown = false;
    const MAX_CONSECUTIVE_PLAYBACK_FAILURES = 3;
    const LIKE_LONG_PRESS_MS = 550;
    let likeLongPressTimer: ReturnType<typeof setTimeout> | null = null;
    let likeSuppressNextClick = false;
    let likeSuppressResetTimer: ReturnType<typeof setTimeout> | null = null;
    let likePointerId: number | null = null;
    let likePointerStartX = 0;
    let likePointerStartY = 0;
    let likeLongPressTriggered = false;
    let playbackHistoryStack: number[] = [];
    let isNavigatingHistory = false;
    let activePlaybackAttempt: PlaybackAttemptContext | null = null;
    let prefetchTriggeredForPlayback = false;
    const BUFFERING_RECOVERY_DELAY = 6 * 1000;
    let bufferingRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let bufferingRecoverySong: any = null;
    let bufferingRecoveryAttempted = false;

    const maybePrefetchNextSong = () => {
        if (prefetchTriggeredForPlayback || settings.enablePreloader === false) return;
        if (audio.paused || audio.ended) return;
        if (state.currentLoadingRequestId !== 0 || !shouldPrefetchAfterPlayback(state.currentSourceType)) return;

        const duration = Number(audio.duration);
        const currentTime = Number(audio.currentTime);
        if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return;
        if (currentTime / duration < PREFETCH_PROGRESS_THRESHOLD) return;

        prefetchTriggeredForPlayback = true;
        void prefetchNextSong();
    };

    audio.addEventListener('timeupdate', maybePrefetchNextSong);

    function getPlaybackTargetKey(song, sourceType, quality, url) {
        return [
            String(song?.id || song?.songmid || song?.songId || ''),
            String(sourceType || ''),
            String(quality || ''),
            String(url || ''),
        ].join('|');
    }

    function beginPlaybackAttempt(song, requestId, isRetry) {
        const rootSong = state.currentRecoveryState?.originalSong || song;
        const rootSongId = String(rootSong?.id || rootSong?.songmid || rootSong?.songId || '');
        if (!isRetry || !activePlaybackAttempt || activePlaybackAttempt.rootSongId !== rootSongId) {
            activePlaybackAttempt = {
                rootSongId,
                requestId,
                abortController: new AbortController(),
                stage: 'resolving',
                triedTargets: new Set(),
            };
        } else {
            activePlaybackAttempt.requestId = requestId;
            activePlaybackAttempt.abortController = new AbortController();
            activePlaybackAttempt.stage = 'resolving';
        }
        return activePlaybackAttempt;
    }

    function markPlaybackTarget(attempt: PlaybackAttemptContext, song, sourceType, quality, url) {
        const key = getPlaybackTargetKey(song, sourceType, quality, url);
        if (attempt.triedTargets.has(key)) return false;
        attempt.triedTargets.add(key);
        // A single recovery chain should never retain unbounded URL history.
        if (attempt.triedTargets.size > 12) {
            const oldest = attempt.triedTargets.values().next().value;
            if (oldest) attempt.triedTargets.delete(oldest);
        }
        return true;
    }

    function reportServerCachePlayback(cacheFile: { username?: string; filename?: string; folder?: string; location?: string } | null | undefined) {
        if (!cacheFile?.filename || (cacheFile.folder !== 'cache' && cacheFile.folder !== 'music')) return;

        const query = cacheFile.username ? `?user=${encodeURIComponent(cacheFile.username)}` : '';
        const headers = { 'Content-Type': 'application/json' };
        Object.assign(headers, getUserAuthHeaders());
        fetch(`${API_BASE}/cache/playback${query}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ filename: cacheFile.filename, folder: cacheFile.folder, location: cacheFile.location }),
        }).catch(() => {
            // 播放已经成功，播放时间记录失败不应打断当前歌曲。
        });
    }

    function clearLikeLongPressTimer() {
        if (likeLongPressTimer) clearTimeout(likeLongPressTimer);
        likeLongPressTimer = null;
    }

    function suppressLikeClick() {
        likeSuppressNextClick = true;
        if (likeSuppressResetTimer) clearTimeout(likeSuppressResetTimer);
        likeSuppressResetTimer = setTimeout(() => {
            likeSuppressNextClick = false;
            likeSuppressResetTimer = null;
        }, LIKE_LONG_PRESS_MS * 2);
    }

    function bindLikeButtonGesture() {
        const btnLike = document.getElementById('player-like-btn');
        if (!btnLike || btnLike.dataset.likeGestureBound === 'true') return;

        btnLike.dataset.likeGestureBound = 'true';
        btnLike.classList.add('select-none');
        btnLike.style.touchAction = 'manipulation';

        const finishPointer = (event: PointerEvent) => {
            if (likePointerId !== event.pointerId) return;

            clearLikeLongPressTimer();
            if (likeLongPressTriggered) {
                // Touch and pen browsers may synthesize a click after pointerup.
                // Keep the long-press action from also toggling the collection.
                suppressLikeClick();
                event.preventDefault();
            }
            likeLongPressTriggered = false;
            likePointerId = null;
            btnLike.classList.remove('scale-110', 'ring-2', 'ring-red-200');
        };

        btnLike.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || likePointerId !== null) return;

            likePointerId = event.pointerId;
            likePointerStartX = event.clientX;
            likePointerStartY = event.clientY;
            likeLongPressTriggered = false;
            btnLike.setPointerCapture?.(event.pointerId);
            likeLongPressTimer = setTimeout(() => {
                likeLongPressTimer = null;
                likeLongPressTriggered = true;
                suppressLikeClick();
                btnLike.classList.add('scale-110', 'ring-2', 'ring-red-200');
                void openPlaylistAddModal();
            }, LIKE_LONG_PRESS_MS);
        });

        btnLike.addEventListener('pointermove', (event) => {
            if (likePointerId !== event.pointerId || likeLongPressTriggered) return;
            const distance = Math.hypot(
                event.clientX - likePointerStartX,
                event.clientY - likePointerStartY,
            );
            if (distance > 12) {
                clearLikeLongPressTimer();
                likePointerId = null;
            }
        });

        btnLike.addEventListener('pointerup', finishPointer);
        btnLike.addEventListener('pointercancel', finishPointer);
        btnLike.addEventListener('lostpointercapture', finishPointer);
        btnLike.addEventListener('contextmenu', (event) => {
            if (likeLongPressTriggered || likeSuppressNextClick) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);

        // This capture listener runs before the button's onclick handler and the
        // document-level delegated click handlers.
        btnLike.addEventListener('click', (event) => {
            if (!likeSuppressNextClick) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            likeSuppressNextClick = false;
            if (likeSuppressResetTimer) clearTimeout(likeSuppressResetTimer);
            likeSuppressResetTimer = null;
        }, true);
    }

    bindLikeButtonGesture();

    function clearManualPlaybackRecovery() {
        manualPlaybackRecoveryCleanup?.();
        manualPlaybackRecoveryCleanup = null;
    }

    function retryCurrentSongPlayback(forceWhileLoading = false) {
        const song = state.currentPlayingSong;
        if (!song || (!forceWhileLoading && state.currentLoadingRequestId !== 0)) return false;

        const resumeTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        clearManualPlaybackRecovery();
        clearBufferingRecoveryTimer();
        if (forceWhileLoading && state.currentLoadingRequestId !== 0) {
            activePlaybackAttempt?.abortController.abort();
        }
        // Bypass both browser/server URL caches after a source has already failed.
        // Keep the existing recovery state so quality/source fallback still works.
        state.currentLoadingSongId = null;
        // 在线链接或浏览器缓存链接失败时，允许重新检查服务端缓存：
        // 页面恢复期间后台缓存可能刚好完成，此时继续绕过服务端缓存会
        // 一直重试已经失效的远端 URL。已确认失效的服务端缓存则继续使用
        // local_retry，避免再次命中同一个坏文件。
        const retryMode = state.currentSourceType === 'server_cache' && !song.isLocal
            ? 'local_retry'
            : true;
        if (retryMode === 'local_retry') {
            void playSong(song, state.currentIndex, null, false, 'local_retry', null, resumeTime);
        } else {
            void playSong(song, state.currentIndex, null, false, true, null, resumeTime);
        }
        return true;
    }

    function clearBufferingRecoveryTimer() {
        if (bufferingRecoveryTimer) clearTimeout(bufferingRecoveryTimer);
        bufferingRecoveryTimer = null;
    }

    function resetBufferingRecovery() {
        clearBufferingRecoveryTimer();
        bufferingRecoverySong = null;
        bufferingRecoveryAttempted = false;
    }

    function armBufferingRecovery() {
        const song = state.currentPlayingSong;
        if (!song || audio.paused || audio.ended || bufferingRecoveryAttempted) return;
        if (bufferingRecoverySong !== song) {
            clearBufferingRecoveryTimer();
            bufferingRecoverySong = song;
            bufferingRecoveryAttempted = false;
        }
        if (bufferingRecoveryTimer) return;

        bufferingRecoveryTimer = setTimeout(() => {
            bufferingRecoveryTimer = null;
            if (song !== state.currentPlayingSong || audio.paused || audio.ended) return;
            if (audio.readyState >= 3) return;

            const isSourceLoading = activePlaybackAttempt?.stage === 'loading';
            if (state.currentLoadingRequestId !== 0 && !isSourceLoading) return;

            bufferingRecoveryAttempted = true;
            showPlaybackStatus('正在恢复播放', { type: 'info', loading: true });
            if (!retryCurrentSongPlayback(isSourceLoading)) bufferingRecoveryAttempted = false;
        }, BUFFERING_RECOVERY_DELAY);
    }

    audio.addEventListener('waiting', armBufferingRecovery);
    audio.addEventListener('stalled', armBufferingRecovery);
    audio.addEventListener('playing', clearBufferingRecoveryTimer);
    audio.addEventListener('pause', clearBufferingRecoveryTimer);

    function armManualPlaybackRecovery() {
        clearManualPlaybackRecovery();

        const song = state.currentPlayingSong;
        if (!song || !audio.src) return;

        let recoveryStarted = false;
        const cleanup = () => {
            audio.removeEventListener('error', retryHandler);
            if (manualPlaybackRecoveryCleanup === cleanup) manualPlaybackRecoveryCleanup = null;
        };
        const retryHandler = () => {
            // Ignore an error belonging to a newer song/request. The normal
            // playSong path owns recovery while its request is still in flight.
            if (recoveryStarted || state.currentPlayingSong !== song || state.currentLoadingRequestId !== 0) return;
            recoveryStarted = true;
            cleanup();
            retryCurrentSongPlayback();
        };

        audio.addEventListener('error', retryHandler, { once: true });
        manualPlaybackRecoveryCleanup = cleanup;
    }

    function playFromView(index) {
        if (!context.getViewingPlaylist() || !context.getViewingPlaylist()[index]) return;
        // Update playlist and scope when user explicitly clicks a song to play
        updatePlaylist(context.getViewingPlaylist(), index, context.getCurrentSearchScope());
    }
window.playFromView = playFromView;

async function runRecoveryFlow(error) {
    if (!state.currentRecoveryState) return;

    const { steps, currentStepIndex } = state.currentRecoveryState;
    if (currentStepIndex >= steps.length) {
        // All recovery steps exhausted
        setPlayerStatus('播放失败');
        showError(`播放失败: ${toUserMessage(error, '未知错误')}`);
        updatePlayButton(false);
        return;
    }

    const currentStep = steps[currentStepIndex];
    console.log(`[Recovery] Executing recovery step: ${currentStep} (${currentStepIndex + 1}/${steps.length})`);

    if (currentStep === 'degrade') {
        const nextQuality = window.QualityManager.getNextLowerQuality(state.currentRecoveryState.currentQuality, state.currentRecoveryState.currentSong);
        if (nextQuality && !state.currentRecoveryState.triedQualities.includes(nextQuality)) {
            state.currentRecoveryState.currentQuality = nextQuality;
            state.currentRecoveryState.triedQualities.push(nextQuality);
            
            const fromName = window.QualityManager.getQualityDisplayName(state.currentRecoveryState.triedQualities[state.currentRecoveryState.triedQualities.length - 2]);
            const toName = window.QualityManager.getQualityDisplayName(nextQuality);
            showPlaybackStatus(`切换音质 · ${toName}`, { type: 'info', loading: true });
            
            // Re-invoke playSong with isRetry = true so we don't reset recovery state
            playSong(state.currentRecoveryState.currentSong, state.currentRecoveryState.currentIndex, nextQuality, false, true);
        } else {
            // Quality degradation failed/exhausted, move to next recovery step
            state.currentRecoveryState.currentStepIndex++;
            await runRecoveryFlow(error);
        }
    } else if (currentStep === 'switch_platform') {
        if (state.currentRecoveryState.currentSong === state.currentRecoveryState.originalSong) {
            showPlaybackStatus('正在切换音源', { type: 'info', loading: true });
            const matchedSong = await findOtherSourceMatch(state.currentRecoveryState.originalSong);
            if (matchedSong) {
                state.currentRecoveryState.currentSong = matchedSong;
                state.currentRecoveryState.triedPlatforms.push(matchedSong.source);
                const bestNextQuality = window.QualityManager.getBestQuality(matchedSong, settings.preferredQuality || 'flac');
                state.currentRecoveryState.currentQuality = bestNextQuality;
                state.currentRecoveryState.triedQualities = [bestNextQuality];
                
                showPlaybackStatus(`切换至 ${getSourceName(matchedSong.source)}`, { type: 'info', loading: true });
                // Re-invoke playSong with isRetry = true
                playSong(matchedSong, state.currentRecoveryState.currentIndex, bestNextQuality, false, true);
            } else {
                // No match found, move to next recovery step
                state.currentRecoveryState.currentStepIndex++;
                await runRecoveryFlow(error);
            }
        } else {
            // Already switched once, move to next recovery step
            state.currentRecoveryState.currentStepIndex++;
            await runRecoveryFlow(error);
        }
    } else if (currentStep === 'skip_next') {
        const isPlatformNotSupported = error && error.message && (
            error.message.includes('未找到支持') ||
            error.message.includes('not supported')
        );

        consecutivePlaybackFailures++;

        // 音源缺失属于配置问题而非单曲问题：给出常驻引导而不是一闪而过的提示。
        if (isPlatformNotSupported && !noSourceHintShown) {
            noSourceHintShown = true;
            showError('未找到可用的自定义音源，无法解析该平台的歌曲。请在设置中添加或启用对应平台的音源。', {
                actionLabel: '去设置音源',
                onAction: () => (window as any).openCustomSourceModal?.(),
                duration: 0,
            });
        }

        // 硬性兜底：连续失败过多说明当前歌单整体不可播，停止自动跳过。
        if (consecutivePlaybackFailures >= MAX_CONSECUTIVE_PLAYBACK_FAILURES) {
            setPlayerStatus('播放失败', false);
            if (window._autoSkipTimer) {
                clearTimeout(window._autoSkipTimer);
                window._autoSkipTimer = null;
            }
            updatePlayButton(false);
            showError(`连续 ${MAX_CONSECUTIVE_PLAYBACK_FAILURES} 首歌曲播放失败，已停止自动跳过。请检查音源设置或稍后重试。`);
            return;
        }

        setPlayerStatus('播放失败，即将跳过', null, true);
        if (window._autoSkipTimer) clearTimeout(window._autoSkipTimer);
        window._autoSkipTimer = setTimeout(() => playNext(0, false), isPlatformNotSupported ? 2000 : 3000);
    }
}

function restoreAudioPosition(position) {
    pendingRestoreCleanup?.();
    pendingRestoreCleanup = null;

    const requestedPosition = Number(position);
    if (!Number.isFinite(requestedPosition) || requestedPosition <= 0) return;

    const applyPosition = () => {
        const duration = Number(audio.duration);
        audio.currentTime = Number.isFinite(duration) && duration > 0
            ? Math.min(requestedPosition, duration)
            : requestedPosition;
    };

    if (audio.readyState >= 1) {
        applyPosition();
        return;
    }

    let active = true;
    const onLoadedMetadata = () => {
        if (!active) return;
        active = false;
        audio.removeEventListener('loadedmetadata', onLoadedMetadata);
        if (pendingRestoreCleanup === cleanup) pendingRestoreCleanup = null;
        applyPosition();
    };
    const cleanup = () => {
        if (!active) return;
        active = false;
        audio.removeEventListener('loadedmetadata', onLoadedMetadata);
        if (pendingRestoreCleanup === cleanup) pendingRestoreCleanup = null;
    };
    pendingRestoreCleanup = cleanup;
    audio.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
}

function setAudioSource(url) {
    const targetUrl = String(url || '');
    if (!targetUrl) return;

    // Assigning the same URL again is a no-op in some browsers. If the previous
    // request ended, explicitly rewind it so a cached link can be replayed.
    let currentUrl = audio.currentSrc || audio.src;
    try {
        currentUrl = currentUrl ? new URL(currentUrl, document.baseURI).href : '';
        const normalizedTargetUrl = new URL(targetUrl, document.baseURI).href;
        if (currentUrl && currentUrl === normalizedTargetUrl) {
            if (audio.ended) {
                audio.currentTime = 0;
            } else if (audio.error || audio.readyState === 0 || audio.networkState === 3) {
                // A failed request may keep the same src without exposing a
                // MediaError. HAVE_NOTHING/NETWORK_NO_SOURCE is also a stale
                // media state, so reload it before retrying the same URL.
                audio.load();
            }
            return;
        }
    } catch (_) {
        // Fall back to a normal src assignment for malformed or unusual URLs.
    }

    audio.src = targetUrl;
}

async function playSong(song, index, forceQuality = null, noPlay = false, isRetry = false, shouldAddToDefault = null, resumeTime = null, urlOverride = null) {
    // 1. Debounce / Lock: If already loading this song, ignore click
    // [Fix] Allow retry to bypass this check
    if (state.currentLoadingSongId === song.id && !isRetry) {
        console.log(`[Player] Already loading ${song.name}, ignoring request.`);
        return;
    }

    if (!isRetry && activePlaybackAttempt && state.currentLoadingRequestId !== 0) {
        activePlaybackAttempt.abortController.abort();
        activePlaybackAttempt.stage = 'recovering';
    }

    if (!noPlay) {
        playAfterSourceReady = false;
        clearManualPlaybackRecovery();
    }
    if (!isRetry || state.currentPlayingSong !== song) {
        resetBufferingRecovery();
    } else {
        clearBufferingRecoveryTimer();
    }
    if (!isRetry) {
        prefetchTriggeredForPlayback = false;
        // A user jump makes unrelated in-flight prefetch work obsolete.
        // Keep a request for the song being entered so an almost-ready
        // prefetch can still be reused instead of resolved twice.
        prefetchManager.cancelInflightExcept?.(song.id);
    }
    playbackErrorCleanup?.();
    playbackErrorCleanup = null;
    pendingRestoreCleanup?.();
    pendingRestoreCleanup = null;
    delete song._prefetchUnavailableUntil;

    // 2. New Song Request: Update target
    const thisRequestSongId = song.id;
    // Clear any pending auto-skip timer
    if (window._autoSkipTimer) {
        clearTimeout(window._autoSkipTimer);
        window._autoSkipTimer = null;
    }

    const thisRequestId = ++state.loadingRequestCounter;
    state.currentLoadingSongId = thisRequestSongId;
    state.currentLoadingRequestId = thisRequestId;
    const playbackAttempt = beginPlaybackAttempt(song, thisRequestId, isRetry);

    if (!isRetry) {
        const order = (settings.playbackErrorPriority || 'platform,quality,next').split(',');
        const steps = [];
        for (const key of order) {
            if (key === 'quality' && settings.enableAutoDegradeQuality !== false) {
                steps.push('degrade');
            } else if (key === 'platform' && settings.enableAutoSwitchSource !== false) {
                steps.push('switch_platform');
            } else if (key === 'next' && settings.enableAutoSkipOnError !== false) {
                steps.push('skip_next');
            }
        }

        const startQuality = forceQuality || window.QualityManager.getBestQuality(song, settings.preferredQuality || 'flac');

        state.currentRecoveryState = {
            originalSong: song,
            currentIndex: index,
            currentSong: song,
            originalQuality: startQuality,
            currentQuality: startQuality,
            triedQualities: [startQuality],
            triedPlatforms: [song.source],
            steps: steps,
            currentStepIndex: 0,
            thisRequestId: thisRequestId
        };
    } else {
        if (state.currentRecoveryState) {
            state.currentRecoveryState.thisRequestId = thisRequestId;
        }
    }

    state.currentIndex = index;
    // [Random Prefetch Fix] 一旦开始正式播放一首歌曲，清除之前的预选索引，以便下一轮重新生成
    state.preSelectedNextIndex = null;

    state.currentPlayingSong = song;
    window.currentPlayingSong = song;
    // The advertised quality is not necessarily the quality that will be played.
    // Clear the previous song's quality until URL resolution confirms the actual one.
    updatePlayerInfo(song, null);
    updateMediaSessionMetadata(song);
    // 异步触发歌词抓取，初步尝试（此时音质可能尚未最终确定，但在 playSong 后续逻辑中会再次同步）
    fetchLyric(song);

    // Refresh queue UI if drawer is open to update active indicator, always refresh badge
    const queueDrawer = document.getElementById('queue-drawer');
    if (queueDrawer && !queueDrawer.classList.contains('translate-x-full')) {
        renderQueue();
    } else {
        updateQueueBadge();
    }

    // [Fix] 切换歌曲前强制重置手动滚动状态
    state.isUserScrolling = false;
    if (state.scrollLockTimeout) {
        clearTimeout(state.scrollLockTimeout);
        state.scrollLockTimeout = null;
    }
    const indicator = document.getElementById('lyric-scroll-indicator');
    if (indicator) {
        indicator.classList.add('hidden');
        indicator.style.display = 'none';
    }

    // Show one compact playback status instead of stacking loading toasts.
    if (!isRetry) {
        showPlaybackStatus('正在连接', { type: 'info', loading: true });
    } else if (isRetry === true) {
        showPlaybackStatus('正在重新连接', { type: 'info', loading: true });
    }

    // 处理切换提示的显示与隐藏
    const hint = document.getElementById('toggle-hint');
    if (hint) {
        // 重置为可见：清理内联样式，恢复 CSS 类定义的默认状态 (opacity-80, max-h-8, mt-2)
        hint.style.opacity = '';
        hint.style.maxHeight = '';
        hint.style.marginTop = '';
        hint.classList.remove('opacity-0');

        if (hintTimeout) clearTimeout(hintTimeout);
        hintTimeout = setTimeout(() => {
            // 强制使用内联样式隐藏并收起占位
            hint.style.opacity = '0';
            hint.style.maxHeight = '0px';
            hint.style.marginTop = '0px';
        }, 5000);
    }

    // 显示加载状态
    setPlayerStatus('正在连接', null, true);

    let targetQuality = forceQuality;
    let isPrefetchFound = false;
    let urlResult = null;

    // 提前检查预读缓存，以便淡出逻辑使用
    if (!targetQuality && !isRetry) {
        const preferredQuality = window.QualityManager.getBestQuality(song, settings.preferredQuality || 'flac');
        const pendingPrefetch = prefetchManager.getPending?.(song.id, preferredQuality);
        if (pendingPrefetch) {
            try {
                // If the user enters a song that is already being prefetched,
                // wait for and reuse that request instead of resolving it twice.
                await pendingPrefetch;
            } catch (pendingError) {
                if (pendingError?.name === 'AbortError' || playbackAttempt.abortController.signal.aborted) return;
            }
            if (state.currentLoadingRequestId !== thisRequestId) return;
        }
        urlResult = prefetchManager.get(song.id, preferredQuality);
        if (urlResult) {
            urlResult.isPrefetch = true;
            isPrefetchFound = true;

            // [Optimize] 既然主播放器即将接管该 URL，立即清空缓冲器 src 以停止其后台加载
            // 同时移除条目，避免播放失败后下一次点击再次复用同一个失效地址。
            if (typeof prefetchManager.delete === 'function') {
                prefetchManager.delete(song.id);
            } else if (typeof prefetchManager.stopBufferer === 'function') {
                prefetchManager.stopBufferer();
            } else {
                prefetchManager.bufferer.src = '';
            }
        }
    }

    if (!isRetry && !isNavigatingHistory && typeof state.currentIndex === 'number' && state.currentIndex >= 0 && state.currentIndex !== index) {
        playbackHistoryStack.push(state.currentIndex);
        if (playbackHistoryStack.length > 50) playbackHistoryStack.shift();
    }

    // [Crossfade] 如果开启了淡入淡出，则先执行淡出
    if (settings.enableCrossfade && !noPlay && audio && !audio.paused && !audio.ended && audio.src) {
        await fadeVolume(0, 200);
    }

    if (!noPlay) {
        try { audio.pause(); } catch (e) { }
    }
    updatePlayButton(false);

    try {
        // 1. 智能音质选择与 URL 解析
        if (urlOverride) {
            urlResult = {
                url: urlOverride,
                sourceType: 'normal',
                sourceName: '服务器流式中继',
                quality: forceQuality || targetQuality,
                cacheUrl: urlOverride,
                isProxyRetry: true,
            };
        } else if (!urlResult) {
            if (!targetQuality) {
                targetQuality = window.QualityManager.getBestQuality(song, settings.preferredQuality || 'flac');
            }
            setPlayerStatus('正在获取链接', null, true);
            urlResult = await resolveSongUrl(
                song,
                targetQuality,
                false,
                isRetry,
                !noPlay,
                playbackAttempt.abortController.signal,
            );
        }

        // 2. Stale Check
        if (state.currentLoadingRequestId !== thisRequestId) return;

        // [Fix] 移除 dismissAllToasts()，允许成功/失败/尝试信息的 Toast 共存堆叠

        // Display attempts / success message
        const sourceText = getSourceTypeText(urlResult.sourceType);
        const sourceName = urlResult.sourceName || '';
        const shouldConfirmCacheAfterPlay = !urlResult.isPrefetch && urlResult.sourceType !== 'normal';

        if (urlResult.isPrefetch) {
            // 预读是后台行为，不再打断用户当前播放；真正接管播放时统一提示。
            console.log(`[Prefetch] Playback handoff ready: ${song.name} (${sourceName || sourceText})`);
        }
        // 普通播放的缓存提示延迟到 play() 成功后，避免失效链接先显示“命中”再静默失败。
        // 在线解析 (sourceType === 'normal') 的成功提示已由 fetchSongUrl 中的进度监听处理，此处不再重复显示

        // The Web player keeps progress local and updates the fixed player bar directly.

        if (urlResult.errorMsg) {
            showError(urlResult.errorMsg);
        }

        let finalUrl = urlResult.url;
        state.currentQuality = urlResult.quality;
        state.currentSourceType = urlResult.sourceType;
        const playbackSong = (urlResult.switchedSource && urlResult.songInfo) ? urlResult.songInfo : song;
        if (playbackSong !== song) {
            state.currentPlayingSong = playbackSong;
            window.currentPlayingSong = playbackSong;
            if (state.currentRecoveryState) state.currentRecoveryState.currentSong = playbackSong;
            updateMediaSessionMetadata(playbackSong);
            fetchLyric(playbackSong, state.currentQuality);
        }
        // Always refresh the bottom-player badge, including cache hits that keep the same song object.
        updatePlayerInfo(playbackSong, state.currentQuality);
        playbackAttempt.stage = 'loading';
        const targetWasAlreadyTried = !noPlay && isRetry && !markPlaybackTarget(
            playbackAttempt,
            playbackSong,
            urlResult.sourceType,
            state.currentQuality || targetQuality,
            finalUrl,
        );
        if (!targetWasAlreadyTried && !noPlay) {
            markPlaybackTarget(
                playbackAttempt,
                playbackSong,
                urlResult.sourceType,
                state.currentQuality || targetQuality,
                finalUrl,
            );
        }
        if (targetWasAlreadyTried) {
            console.warn(`[Player] Duplicate playback target rejected: ${playbackSong.name}`);
            playbackAttempt.stage = 'recovering';
            if (state.currentRecoveryState?.thisRequestId === thisRequestId) {
                await runRecoveryFlow(new Error('播放地址重复'));
            }
            return;
        }

        let backgroundCacheRequested = false;
        const requestBackgroundCache = () => {
            // Start caching only after audio.play() succeeds. It is deliberately
            // a post-play side effect and never participates in first-frame or
            // error-recovery decisions.
            if (backgroundCacheRequested || noPlay || urlResult.isProxyRetry ||
                typeof triggerServerCache !== 'function' ||
                !urlResult.cacheUrl || playbackSong.isLocal || settings.enableServerCache === false ||
                String(urlResult.cacheUrl).includes('/api/music/cache/file/')) {
                return;
            }
            backgroundCacheRequested = true;
            // When auto-switching sources, the playable URL belongs to the
            // matched provider but the user's song identity belongs to the
            // original playlist item. Persist the cache under that original
            // identity so the next click can hit it without another paid
            // resolver request.
            const cacheSong = state.currentRecoveryState?.originalSong || song;
            void Promise.resolve(triggerServerCache(cacheSong, urlResult.cacheUrl, state.currentQuality || targetQuality))
                .then((accepted) => {
                    // A rejected/unauthorized cache request must not make the
                    // player wait for a cache that will never be produced.
                    if (accepted === false) backgroundCacheRequested = false;
                })
                .catch(() => {
                    backgroundCacheRequested = false;
                });
        };

        // [Sync] 在线播放确定最终音质后，直接以正确音质重写服务器端歌词缓存文件名。
        // 已命中服务器音频缓存时，歌词本身也已经属于本地缓存；再次 POST 会重复
        // 写入歌词文件（并可能产生一个新的质量/命名组合），因此不能走这条补写路径。
        // 注意：不能再调用 fetchLyric(song)，因为歌词已就绪时 fetchLyric 会提前返回，
        // 永远不会走到写入服务器缓存的逻辑，导致文件名停留在音质未确定时的错误值。
        const shouldSyncServerLyric = settings.enableServerLyricCache !== false &&
            !!state.currentRawLrc &&
            urlResult.sourceType !== 'server_cache' &&
            !playbackSong.isLocal;
        if (shouldSyncServerLyric) {
            try {
                const _lyricHeaders = { 'Content-Type': 'application/json' };
                Object.assign(_lyricHeaders, getUserAuthHeaders());
                // 会话 Cookie 由浏览器自动携带，播放模块不接触认证凭据。
                fetch(`${API_BASE}/cache/lyric`, {
                    method: 'POST',
                    headers: _lyricHeaders,
                    body: JSON.stringify({
                        songInfo: { ...playbackSong, quality: state.currentQuality },
                        lyricsObj: { lyric: state.currentRawLrc, tlyric: state.currentRawTlrc, rlyric: state.currentRawRlrc, lxlyric: state.currentRawKlrc }
                    })
                }).catch(e => console.warn('[Lyric] 音质确定后重写服务端缓存失败:', e));
            } catch (e) { }
        }

        // [Removed] 这里的代理逻辑已统一移动至 fetchSongUrl 阶段处理，确保预加载地址一致性

        // Pre-handle error for invalid cache links. A media element can report a
        // failed source through either the error event or a rejected play() promise.
        let retryResolvedUrl: (() => boolean) | null = null;
        if (!noPlay && finalUrl) {
            const resolvedSourceType = state.currentSourceType;
            const resolvedQuality = state.currentQuality || targetQuality;
            let retryStarted = false;
            retryResolvedUrl = () => {
                // The media error event and the rejected play() promise can
                // report the same failure. Treat the second notification as
                // already handled so it does not surface a false playback
                // error after the recovery path has started.
                if (retryStarted) return true;
                if (state.currentLoadingRequestId !== 0 && state.currentLoadingRequestId !== thisRequestId) return false;
                const currentAudioUrls = [audio.currentSrc, audio.src].filter(Boolean);
                const isSameSource = currentAudioUrls.some((currentAudioUrl) => {
                    try {
                        return new URL(currentAudioUrl, document.baseURI).href === new URL(finalUrl, document.baseURI).href;
                    } catch (_) {
                        return currentAudioUrl === finalUrl;
                    }
                });
                if (state.currentPlayingSong !== playbackSong || !isSameSource) return false;
                // A failed retry has already exhausted this source resolution.
                // Only a broken server cache may still fall back once to a fresh
                // online source; ordinary online failures must stop here instead
                // of recursively calling playSong forever.
                if (isRetry === 'proxy_retry' && resolvedSourceType !== 'server_cache') {
                    cleanup();
                    return false;
                }
                retryStarted = true;
                cleanup();
                // Both browser-link and freshly-resolved remote URLs can expire.
                // Remove either one before recovery so a later click cannot
                // silently reuse the same broken signed URL.
                if (!playbackSong.isLocal && resolvedSourceType !== 'server_cache') {
                    try {
                        localStorage.removeItem(`lx_url_${cleanSongData(playbackSong).id}_${resolvedQuality}`);
                    } catch (_) { }
                }
                const playbackProxyUrl = urlResult.playbackProxyUrl;
                let hasDifferentPlaybackProxy = Boolean(playbackProxyUrl);
                if (hasDifferentPlaybackProxy) {
                    try {
                        hasDifferentPlaybackProxy = new URL(playbackProxyUrl, document.baseURI).href !== new URL(finalUrl, document.baseURI).href;
                    } catch (_) {
                        hasDifferentPlaybackProxy = playbackProxyUrl !== finalUrl;
                    }
                }
                const proxyTargetKey = hasDifferentPlaybackProxy
                    ? getPlaybackTargetKey(playbackSong, resolvedSourceType, resolvedQuality, playbackProxyUrl)
                    : '';
                const hasUnusedPlaybackProxy = hasDifferentPlaybackProxy && !activePlaybackAttempt?.triedTargets.has(proxyTargetKey);
                if (isRetry !== 'proxy_retry' && resolvedSourceType !== 'server_cache' && !playbackSong.isLocal && hasUnusedPlaybackProxy) {
                    console.warn(`[Player] ${resolvedSourceType} link failed, retrying through the streaming proxy...`);
                    void playSong(
                        playbackSong,
                        index,
                        resolvedQuality,
                        noPlay,
                        'proxy_retry',
                        shouldAddToDefault,
                        resumeTime,
                        playbackProxyUrl,
                    );
                    return true;
                }
                console.warn(`[Player] ${resolvedSourceType} link failed, retrying online...`);
                const retryMode = resolvedSourceType === 'server_cache' && !playbackSong.isLocal
                    ? 'local_retry'
                    : true;
                void playSong(
                    playbackSong,
                    index,
                    targetQuality,
                    noPlay,
                    retryMode,
                    shouldAddToDefault,
                    resumeTime,
                );
                return true;
            };
            const retryHandler = () => {
                cleanup();
                retryResolvedUrl?.();
            };
            audio.addEventListener('error', retryHandler, { once: true });
            const cleanup = () => {
                audio.removeEventListener('error', retryHandler);
                audio.removeEventListener('pause', cleanup);
                if (playbackErrorCleanup === cleanup) playbackErrorCleanup = null;
            };
            playbackErrorCleanup = cleanup;
            audio.addEventListener('pause', cleanup, { once: true });
        }

        setAudioSource(finalUrl);
        restoreAudioPosition(resumeTime);

        if (noPlay) {
            setPlayerStatus('', false);
            updatePlayButton(false);
            if (window._resumeInfo && window._resumeInfo.time > 0) {
                restoreAudioPosition(window._resumeInfo.time);
                delete window._resumeInfo;
            }

            if (playAfterSourceReady && state.currentLoadingRequestId === thisRequestId) {
                playAfterSourceReady = false;
                queueMicrotask(() => {
                    if (state.currentPlayingSong === playbackSong && state.currentLoadingRequestId === 0) {
                        void togglePlay();
                    }
                });
            }
            return;
        }

        try {
            const isMuted = Boolean(state.isMuted);
            const targetVol = typeof state.currentVolume !== 'undefined' ? state.currentVolume : 1;
            const effectiveVol = isMuted ? 0 : targetVol;

            if (settings.enableCrossfade && !isMuted && effectiveVol > 0) {
                audio.volume = 0;
            } else {
                audio.volume = effectiveVol;
            }
            audio.muted = isMuted;

            await audio.play();
            playbackAttempt.stage = 'playing';
            consecutivePlaybackFailures = 0;
            noSourceHintShown = false;

            // Cache is deliberately a post-play side effect. It must never
            // compete with URL resolution or make the first audible frame
            // depend on the background download request.
            requestBackgroundCache();

            // 只在真正开始播放后记录，避免预读或切换页面时把缓存误标为最近使用。
            reportServerCachePlayback(urlResult.cacheFile);

            if (shouldConfirmCacheAfterPlay) {
                // 非在线解析（如命中本地/服务器缓存），只有真正启动播放后才提示命中。
                const qualityLabel = state.currentQuality
                    ? window.QualityManager.getQualityDisplayName(state.currentQuality)
                    : '';
                const playbackLabel = sourceName || (urlResult.sourceType === 'normal' ? sourceText : `已命中${sourceText}`);
                showPlaybackStatus(
                    qualityLabel ? `${playbackLabel} · ${qualityLabel}` : playbackLabel,
                    { type: 'success', duration: 1600 },
                );
            }

            if (settings.enableCrossfade && !isMuted && effectiveVol > 0) {
                fadeVolume(effectiveVol, 300);
            } else {
                audio.volume = effectiveVol;
                audio.muted = isMuted;
            }

            setPlayerStatus('', true);
            updatePlayButton(true);

            // Save history and handle list logic
            savePlayHistory(playbackSong, state.currentQuality);
            const finalAdd = shouldAddToDefault !== null ? shouldAddToDefault : (state.currentPlayingScope === 'network' || state.currentPlayingScope === 'songlist' || state.currentPlayingScope === 'leaderboard');
            if (finalAdd) {
                addToDefaultList(playbackSong);
                // 切换逻辑说明：
                // - 搜索结果(network)：updatePlaylist 把队列设为搜索结果，开启设置才把队列切换到 defaultList
                // - 歌单/排行榜(songlist/leaderboard)：updatePlaylist 已把队列设为歌单/排行榜，
                //   开启设置=保持歌单/排行榜队列(do nothing)，关闭设置=退回 defaultList
                const isSongListOrLeaderboard = state.currentPlayingScope === 'songlist' || state.currentPlayingScope === 'leaderboard';
                if (isSongListOrLeaderboard) {
                    // 歌单/排行榜：关闭"切换歌单"时，才退回 defaultList
                    const shouldFallback = settings.switchPlaylistOnSongListPlay === false;
                    if (shouldFallback && typeof context.getCurrentListData() !== 'undefined' && context.getCurrentListData().defaultList) {
                        state.currentPlaylist = context.getCurrentListData().defaultList;
                        state.currentIndex = 0;
                        state.currentPlayingScope = 'local_list';
                        updateQueueBadge();
                    }
                } else {
                    // 搜索结果：关闭"切换歌单"时，才退回 defaultList
                    const shouldSearchFallback = settings.switchPlaylistOnSearchPlay === false;
                    if (shouldSearchFallback && typeof context.getCurrentListData() !== 'undefined' && context.getCurrentListData().defaultList) {
                        state.currentPlaylist = context.getCurrentListData().defaultList;
                        state.currentIndex = 0;
                        state.currentPlayingScope = 'local_list';
                        updateQueueBadge();
                    }
                }
            }
        } catch (playError) {
            playbackAttempt.stage = 'recovering';
            // [Fix] 仅在请求仍有效且非 AbortError 时显示“请点击”提示，防止切歌太快导致旧请求的错误覆盖新请求的新状态
            if (state.currentLoadingRequestId !== thisRequestId) return;
            const isAbort = playError && (playError.name === 'AbortError' || playError.code === 20);
            if (isAbort) return;

            // 用户点击触发的播放权限错误不能通过重新解析链接解决；其他缓存
            // 播放失败则清除失效缓存并自动走一次在线解析。
            const isPlaybackPermissionError = playError && (
                playError.name === 'NotAllowedError' || playError.name === 'SecurityError'
            );
            if (!isPlaybackPermissionError && retryResolvedUrl?.()) return;

            if (!isPlaybackPermissionError && isRetry && state.currentRecoveryState?.currentSong === playbackSong && !noPlay) {
                await runRecoveryFlow(playError);
                return;
            }

            console.error('[Player] Playback blocked:', playError);
            setPlayerStatus('请点击播放按钮');
        }

    } catch (error) {
        if (state.currentLoadingRequestId !== thisRequestId) return;
        playbackAttempt.stage = 'recovering';
        console.error('[Player] Error:', error);

        if (error?.code === 'SERVER_CACHE_PROCESSING' || error?.code === 'SERVER_CACHE_UNAVAILABLE') {
            setPlayerStatus(error.message || '本地缓存暂不可用');
            showPlaybackStatus(error.message || '本地缓存暂不可用', { type: 'error', duration: 3200 });
            updatePlayButton(false);
            return;
        }

        if (state.currentRecoveryState && state.currentRecoveryState.thisRequestId === thisRequestId && !noPlay) {
            await runRecoveryFlow(error);
        } else {
            setPlayerStatus('播放失败');
            showError(`播放失败: ${toUserMessage(error, '未知错误')}`);
            updatePlayButton(false);
        }
    } finally {
        if (state.currentLoadingRequestId === thisRequestId) {
            state.currentLoadingRequestId = 0;
            state.currentLoadingSongId = null;
        }
    }
}

async function changePlaybackQuality(quality) {
    if (!quality || !state.currentPlayingSong) return false;

    const song = state.currentPlayingSong;
    const wasPlaying = !audio.paused && !audio.ended;
    const resumeTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;

    // Start a fresh recovery chain for the explicit user choice and bypass the
    // same-song loading guard when the previous request has not fully settled.
    state.currentLoadingSongId = null;
    state.currentRecoveryState = null;

    await playSong(song, state.currentIndex, quality, !wasPlaying, false, null, resumeTime);
    return true;
}

// 设置播放器状态文本
/**
 * 设置播放器状态文本
 * @param {string} status 状态文本
 * @param {boolean|null} isPlaying 播放状态
 * @param {boolean} isLoading 是否显示加载/缓冲动画
 */
function setPlayerStatus(status, isPlaying = null, isLoading = false) {
    const normalizedStatus = String(status || '').trim();
    if (!normalizedStatus) {
        const statusNode = document.getElementById('player-playback-status');
        const shouldHide = isPlaying === false || (isPlaying === true && statusNode?.dataset.state !== 'success');
        if (shouldHide) showPlaybackStatus('');
        return;
    }

    const isError = /失败|错误|请点击/.test(normalizedStatus);
    showPlaybackStatus(normalizedStatus, {
        type: isError ? 'error' : 'info',
        loading: isLoading,
    });
}


// 保存播放历史
function savePlayHistory(song, quality) {
    try {
        const history = JSON.parse(localStorage.getItem('play_history') || '[]');
        history.unshift({
            ...song,
            quality,
            playedAt: Date.now()
        });
        // 只保留最近 50 条
        localStorage.setItem('play_history', JSON.stringify(history.slice(0, 50)));
    } catch (e) {
        console.error('[Player] 保存播放历史失败:', e);
    }
}

// 添加到默认列表 (试听列表)
async function addToDefaultList(song) {
    if (!context.getCurrentListData() || !context.getCurrentListData().defaultList) return;

    try {
        const cleanedData = cleanSongData(song);
        const targetId = cleanedData.id;
        const list = context.getCurrentListData().defaultList;

        // Check if exists
        const idx = list.findIndex(s => s.id === targetId);

        if (idx !== -1) {
            // Already exists, move to top
            list.splice(idx, 1);
        }

        // Add to top
        list.unshift(cleanedData);

        // Limit size to avoid bloat (e.g., 200 songs)
        if (list.length > 200) {
            list.length = 200;
        }

        // Sync
        await pushDataChange();

        // Refresh sidebar to update count
        renderMyLists(context.getCurrentListData());
    } catch (e) {
        console.error('[DefaultList] 添加失败:', e);
        showError('保存播放列表失败，请稍后重试');
    }
}

/**
 * 更新当前播放列表并开始播放指定歌曲
 * @param {Array} list 歌曲列表
 * @param {number} startIndex 开始播放的索引 (默认 0)
 * @param {string} scope 搜索范围/来源 (用于播放逻辑识别)
 * @param {boolean} shouldAddToDefault 是否加入默认(试听)列表
 */
function updatePlaylist(list, startIndex = 0, scope = 'local_list', shouldAddToDefault = null) {
    if (!list || list.length === 0) {
        showError('播放列表为空');
        return;
    }

    // [New] Deduplicate by quality if setting enabled
    if (settings.deduplicatePlaylistByQuality && window.QualityManager) {
        const targetSong = list[startIndex];
        const targetId = targetSong ? (targetSong.songmid || targetSong.id) : null;

        const deduplicated = [];
        const seenIds = new Map(); // id -> index in deduplicated

        list.forEach((song) => {
            const id = song.songmid || song.id;
            if (!id) {
                deduplicated.push(song);
                return;
            }

            const qualityAttr = song.quality || song.type || '128k';

            if (seenIds.has(id)) {
                const existingIdx = seenIds.get(id);
                const existingSong = deduplicated[existingIdx];
                const existingQuality = existingSong.quality || existingSong.type || '128k';

                const p1 = window.QualityManager.QUALITY_PRIORITY.indexOf(existingQuality);
                const p2 = window.QualityManager.QUALITY_PRIORITY.indexOf(qualityAttr);

                // Priority index: smaller means better quality.
                // Lower index is higher quality
                if (p2 !== -1 && (p1 === -1 || p2 < p1)) {
                    deduplicated[existingIdx] = song;
                }
            } else {
                seenIds.set(id, deduplicated.length);
                deduplicated.push(song);
            }
        });

        // Find new startIndex based on targetId (identity matching)
        if (targetId) {
            const newIndex = deduplicated.findIndex(s => (s.songmid || s.id) === targetId);
            if (newIndex !== -1) startIndex = newIndex;
        }

        list = deduplicated;
    }

    // 所有列表入口统一使用最多 99 首，且尽量保留当前点击的歌曲。
    // 这样搜索页、歌单、榜单和本地音乐不会因为分页方式不同而出现
    // “只加入当前 20 首”或一次加入过多歌曲的差异。
    const normalizedStartIndex = Math.min(
        Math.max(Number(startIndex) || 0, 0),
        Math.max(list.length - 1, 0),
    );
    const queueOffset = Math.min(
        normalizedStartIndex,
        Math.max(list.length - PLAYBACK_QUEUE_LIMIT, 0),
    );
    list = list.slice(queueOffset, queueOffset + PLAYBACK_QUEUE_LIMIT);
    startIndex = normalizedStartIndex - queueOffset;

    // [New] Use a shallow copy to prevent mutations from affecting the source list
    state.currentPlaylist = [...list];
    state.currentPlayingScope = scope;
    updateQueueBadge();

    // 如果是从网络搜索或歌单来源，确保 playSong 能识别并更新 UI/历史
    playSong(state.currentPlaylist[startIndex], startIndex, null, false, false, shouldAddToDefault);

    console.log(`[Queue] 播放列表已更新 (${state.currentPlaylist.length} 首), 来源: ${scope}, 加入默认列表: ${shouldAddToDefault}`);

    // Refresh queue UI if it's open
    if (!document.getElementById('queue-drawer').classList.contains('translate-x-full')) {
        renderQueue();
    }
}
window.updatePlaylist = updatePlaylist;

// 显示错误提示（现代化 Toast）
// 移除旧版 showError，由后文统一的 showToast 驱动
// 占位图片变色

// 全局图片设置助手，处理占位图逻辑与无缝平滑过渡
window.setImg = (id, src) => {
    const el = document.getElementById(id) as HTMLImageElement | null;
    if (!el) return;

    const resolvedSrc = src ? safeImageUrl(src) : '';
    if (!resolvedSrc) {
        delete el.dataset.pendingSrc;
        el.src = '/music/assets/yun-yin.png';
        el.classList.add('is-placeholder');
        return;
    }

    // 绝对路径规范化比对，防止同一 URL 重复赋值触发浏览器无谓重绘与闪烁
    let targetUrl = resolvedSrc;
    try {
        targetUrl = new URL(resolvedSrc, window.location.href).href;
    } catch (_) { }

    const isCurrentUrl = el.src === targetUrl;
    const isPlaceholder = targetUrl.includes('yun-yin.png');

    // 已经显示了目标图片，且无待决请求时直接跳过，避免二次赋值触发渲染管线重置
    if (isCurrentUrl && !el.dataset.pendingSrc) {
        if (isPlaceholder) el.classList.add('is-placeholder');
        else el.classList.remove('is-placeholder');
        return;
    }

    if (isPlaceholder) {
        delete el.dataset.pendingSrc;
        el.src = targetUrl;
        el.classList.add('is-placeholder');
        return;
    }

    // 针对真实封面：在后台预加载完成并解码就绪后再进行无缝置换（Zero-Flicker Transition）
    // 在新封面加载期间保留当前画面，杜绝瞬时灰底空白或滤镜突变带来的闪烁感
    el.dataset.pendingSrc = targetUrl;
    const loader = new Image();
    loader.src = targetUrl;

    const applyReadyImage = () => {
        if (el.dataset.pendingSrc !== targetUrl) return; // 已经被更新的切歌操作覆盖
        delete el.dataset.pendingSrc;
        el.src = targetUrl;
        el.classList.remove('is-placeholder');
    };

    if (typeof loader.decode === 'function') {
        loader.decode().then(applyReadyImage).catch(() => {
            if (el.dataset.pendingSrc === targetUrl) {
                applyReadyImage();
            }
        });
    } else {
        loader.onload = applyReadyImage;
        loader.onerror = () => {
            if (el.dataset.pendingSrc !== targetUrl) return;
            delete el.dataset.pendingSrc;
            el.src = '/music/assets/yun-yin.png';
            el.classList.add('is-placeholder');
        };
    }

    el.onerror = () => {
        if (!el.src.includes('yun-yin.png')) {
            el.src = '/music/assets/yun-yin.png';
            el.classList.add('is-placeholder');
        }
    };
};

function updatePlayerQualityBadge(quality) {
    const badge = document.getElementById('player-quality-tag');
    if (!badge) return;

    const normalizedQuality = quality ? String(quality).toLowerCase() : '';
    const label = normalizedQuality
        ? (window.QualityManager?.getQualityBadgeLabel?.(normalizedQuality) || normalizedQuality.toUpperCase())
        : '—';
    const fullName = normalizedQuality
        ? (window.QualityManager?.getQualityDisplayName?.(normalizedQuality) || label)
        : '正在获取实际音质';
    const badgeClass = normalizedQuality
        ? (window.QualityManager?.getQualityBadgeClass?.(normalizedQuality) || 'badge-quality-runtime')
        : 'badge-quality-runtime';

    const labelEl = badge.querySelector('#player-quality-label');
    if (labelEl) labelEl.textContent = label;
    else badge.textContent = label;

    badge.classList.remove('badge-quality-sq', 'badge-quality-hires', 'badge-quality-runtime');
    badge.classList.add(badgeClass);
    badge.title = normalizedQuality ? `当前音质：${fullName}，点击选择播放音质` : fullName;
    badge.setAttribute('aria-label', normalizedQuality ? `当前音质：${fullName}，选择播放音质` : fullName);
    badge.setAttribute('data-quality', normalizedQuality);
}

function updatePlayerInfo(song, actualQuality) {
    const titleEl = document.getElementById('player-title');
    const sourceEl = document.getElementById('player-source');
    const artistEl = document.getElementById('player-artist');
    const albumEl = document.getElementById('player-album');
    const albumSeparator = document.getElementById('player-meta-separator');

    if (!song) {
        const btnLike = document.getElementById('player-like-btn');
        if (btnLike) {
            btnLike.onclick = null;
            btnLike.classList.remove('text-red-500', 'scale-110', 'ring-2', 'ring-red-200');
            btnLike.classList.add('text-gray-300');
            btnLike.setAttribute('aria-pressed', 'false');
            btnLike.setAttribute('aria-label', '收藏当前歌曲');
            btnLike.title = '请选择歌曲后收藏';
        }
        if (titleEl) {
            titleEl.innerText = '暂无播放';
            titleEl.setAttribute('data-text', '暂无播放');
            titleEl.onclick = null;
            titleEl.classList.remove('hover:text-emerald-500', 'cursor-pointer');
            titleEl.classList.add('truncate');
        }
        updatePlayerQualityBadge(null);
        if (sourceEl) {
            sourceEl.innerHTML = '';
            sourceEl.classList.add('hidden');
        }
        if (artistEl) {
            artistEl.innerText = '选择一首歌曲播放';
            artistEl.setAttribute('data-text', '选择一首歌曲播放');
            artistEl.removeAttribute('title');
            artistEl.onclick = null;
            artistEl.classList.remove('hover:text-emerald-500', 'cursor-pointer');
            artistEl.classList.add('truncate');
        }
        if (albumEl) {
            albumEl.innerText = '';
            albumEl.removeAttribute('data-text');
            albumEl.removeAttribute('aria-label');
            albumEl.removeAttribute('title');
            albumEl.classList.add('hidden');
            albumEl.onclick = null;
        }
        if (albumSeparator) {
            albumSeparator.classList.add('hidden');
        }
        const defaultLogo = '/music/assets/yun-yin.png';
        setImg('player-cover', defaultLogo);
        setImg('sidebar-cover', defaultLogo);
        setImg('detail-cover', defaultLogo);
        const sidebarSongInfo = document.getElementById('sidebar-song-info');
        if (sidebarSongInfo) sidebarSongInfo.classList.add('hidden');
        setPlayerStatus('', false);
        return;
    }

    // Bottom Player - 更新标题
    if (titleEl) {
        titleEl.innerText = song.name;
        titleEl.setAttribute('data-text', song.name);
        titleEl.classList.add('truncate');
        titleEl.classList.remove('overflow-hidden');

        // 点击搜索此歌曲
        titleEl.onclick = (e) => {
            e.stopPropagation();
            performSearch(song.name, song.source);
        };
        titleEl.classList.add('hover:text-emerald-500', 'cursor-pointer', 'transition-colors');
    }

    const resolvedQuality = actualQuality === undefined
        ? (song === state.currentPlayingSong ? state.currentQuality : null)
        : actualQuality;
    updatePlayerQualityBadge(resolvedQuality);

    // Bottom Player - 更新来源标签
    if (sourceEl) {
        if (song.source) {
            // Without an explicitly resolved quality, only show the source.
            // This prevents the player's badge from claiming a higher advertised quality.
            const qualityTags = resolvedQuality ? getQualityTags({ quality: resolvedQuality }) : '';
            sourceEl.innerHTML = getSourceTag(song.source) + qualityTags;
            sourceEl.classList.remove('hidden');
        } else {
            sourceEl.innerHTML = '';
            sourceEl.classList.add('hidden');
        }
    }

    // Bottom Player - 更新艺术家
    if (artistEl) {
        artistEl.innerText = song.singer;
        artistEl.setAttribute('data-text', song.singer);
        artistEl.title = song.singer;
        artistEl.classList.add('truncate');
        artistEl.classList.remove('overflow-hidden');

        // 点击搜索此歌手
        artistEl.onclick = async (e) => {
            e.stopPropagation();
            const singers = song.singer.split(/[、&,，]| \/ /).map(s => s.trim()).filter(s => s);
            if (singers.length > 1) {
                const selected = await showOptions('搜索歌手', '识别到多个歌手，请选择要搜索的对象：', singers);
                if (selected) performSearch(selected, song.source, 'singer');
            } else {
                performSearch(song.singer, song.source, 'singer');
            }
        };
        artistEl.classList.add('hover:text-emerald-500', 'cursor-pointer', 'transition-colors');
    }

    // Bottom Player - 更新专辑并支持专辑类型搜索
    const albumName = String(song.albumName || song.album || song.meta?.albumName || song.meta?.album || '').trim();
    if (albumEl) {
        if (albumName) {
            albumEl.innerText = albumName;
            albumEl.setAttribute('data-text', albumName);
            albumEl.setAttribute('aria-label', `搜索专辑 ${albumName}`);
            albumEl.title = albumName;
            albumEl.classList.remove('hidden');
            albumEl.onclick = (e) => {
                e.stopPropagation();
                performSearch(albumName, song.source, 'album');
            };
            albumEl.classList.add('hover:text-emerald-500', 'cursor-pointer', 'transition-colors');
            albumSeparator?.classList.remove('hidden');
        } else {
            albumEl.innerText = '';
            albumEl.removeAttribute('data-text');
            albumEl.removeAttribute('aria-label');
            albumEl.removeAttribute('title');
            albumEl.classList.add('hidden');
            albumEl.onclick = null;
            albumSeparator?.classList.add('hidden');
        }
    }

    // 触发滚动检测
    applyMarqueeChecks();

    const imgUrl = safeImageUrl(getImgUrl(song));

    setImg('player-cover', imgUrl);
    setImg('sidebar-cover', imgUrl);
    setImg('detail-cover', imgUrl);

    // Sidebar Mini Info
    document.getElementById('sidebar-song-info').classList.remove('hidden');
    const sideSongName = document.getElementById('sidebar-song-name');
    if (sideSongName) {
        sideSongName.innerText = song.name;
        sideSongName.onclick = (e) => {
            e.stopPropagation();
            performSearch(song.name, song.source);
        };
        sideSongName.classList.add('hover:text-emerald-500', 'cursor-pointer', 'transition-colors');
    }
    const sideSinger = document.getElementById('sidebar-singer');
    if (sideSinger) {
        sideSinger.innerText = song.singer;
        sideSinger.onclick = (e) => {
            e.stopPropagation();
            performSearch(song.singer, song.source, 'singer');
        };
        sideSinger.classList.add('hover:text-emerald-500', 'cursor-pointer', 'transition-colors');
    }

    // Detail View Info (Lyrics Page)
    const detailTitle = document.getElementById('detail-title');
    const detailContainer = document.getElementById('detail-title-container');

    if (detailTitle && detailContainer) {
        // 直接设置文本，由 CSS 处理双行换行和省略号
        detailTitle.innerText = song.name;
        detailTitle.classList.remove('animate-marquee');
        detailTitle.onclick = (e) => {
            e.stopPropagation();
            performSearch(song.name, song.source);
        };
        detailTitle.classList.add('hover:text-emerald-500', 'cursor-pointer', 'transition-colors');
    }

    const detailArtist = document.getElementById('detail-artist');
    if (detailArtist) {
        detailArtist.innerText = song.singer;
        detailArtist.onclick = async (e) => {
            e.stopPropagation();
            // 处理多个歌手的情况
            const singers = song.singer.split(/[、&,，]| \/ /).map(s => s.trim()).filter(s => s);
            if (singers.length > 1) {
                const selected = await showOptions('搜索歌手', '识别到多个歌手，请选择要搜索的对象：', singers);
                if (selected) performSearch(selected, song.source, 'singer');
            } else {
                performSearch(song.singer, song.source, 'singer');
            }
        };
        detailArtist.classList.add('hover:text-emerald-500', 'cursor-pointer', 'transition-colors');
    }


    // Update Like Button State (Collection Status)
    const btnLike = document.getElementById('player-like-btn');
    if (!btnLike) {
        context.updateLyricDetailInfo?.(song);
        return;
    }

    let isCollected = false;
    const activeListData = isUserLoggedIn() ? (window.myPersonalListData || context.getCurrentListData()) : context.getCurrentListData();
    if (activeListData && song) {
        // 使用与添加时一致的标准化 ID 进行检查
        const cleanedSong = cleanSongData(song);
        if (cleanedSong) {
            const targetId = cleanedSong.id;
            if (activeListData.loveList && activeListData.loveList.some(s => s.id === targetId)) isCollected = true;
        }
    }

    // 单击直接切换“我的收藏”，长按由 bindLikeButtonGesture 打开歌单选择器。
    btnLike.onclick = (e) => {
        e.stopPropagation();
        void toggleCurrentLike();
    };

    if (isCollected) {
        btnLike.classList.add('text-red-500');
        btnLike.classList.remove('text-gray-300');
    } else {
        btnLike.classList.remove('text-red-500');
        btnLike.classList.add('text-gray-300');
    }
    btnLike.setAttribute('aria-pressed', String(isCollected));
    btnLike.title = isCollected
        ? '单击取消“我的收藏”，长按选择歌单'
        : '单击收藏到“我的收藏”，长按选择歌单';
    btnLike.setAttribute('aria-label', isCollected
        ? '取消我的收藏，长按选择歌单'
        : '收藏到我的收藏，长按选择歌单');
    context.updateLyricDetailInfo?.(song);
}

async function togglePlay() {
    // 忽略因为长按触发的 click 事件
    if (window.playBtnIsLongPress) {
        window.playBtnIsLongPress = false;
        return;
    }

    if (audio.paused) {
        if (!state.currentPlayingSong && (!state.currentPlaylist || state.currentPlaylist.length === 0)) {
            showInfo('播放列表为空');
            return;
        }

        if (state.currentLoadingRequestId !== 0) {
            playAfterSourceReady = true;
            setPlayerStatus('正在准备播放', null, true);
            return;
        }

        playAfterSourceReady = false;
        armManualPlaybackRecovery();

        try {
            const isMuted = Boolean(state.isMuted);
            const targetVol = typeof state.currentVolume !== 'undefined' ? state.currentVolume : 1;
            const effectiveVol = isMuted ? 0 : targetVol;

            // [Crossfade] 如果开启了淡入淡出，先将音量置为 0，播放后再淡入
            if (settings.enableCrossfade && !isMuted && effectiveVol > 0) {
                audio.volume = 0;
            } else {
                audio.volume = effectiveVol;
            }
            audio.muted = isMuted;

            await audio.play();
            updatePlayButton(true);
            consecutivePlaybackFailures = 0;

            if (settings.enableCrossfade && !isMuted && effectiveVol > 0) {
                fadeVolume(effectiveVol, 600);
            } else {
                audio.volume = effectiveVol;
                audio.muted = isMuted;
            }
        } catch (e) {
            clearManualPlaybackRecovery();
            if (state.currentLoadingRequestId !== 0) return;

            const isAbort = e && (e.name === 'AbortError' || e.code === 20);
            if (isAbort) return;

            const isPlaybackPermissionError = e && (
                e.name === 'NotAllowedError' || e.name === 'SecurityError'
            );
            if (!isPlaybackPermissionError && retryCurrentSongPlayback()) return;
            console.error("[Player] Play blocked:", e);
            if (isPlaybackPermissionError) setPlayerStatus('请点击播放按钮');
        }
    } else {
        playAfterSourceReady = false;
        clearManualPlaybackRecovery();
        // [Crossfade] 如果开启了淡入淡出，先淡出再暂停
        if (settings.enableCrossfade && !state.isMuted && audio.volume > 0) {
            await fadeVolume(0, 600);
        }
        audio.pause();
        if (window._autoSkipTimer) {
            clearTimeout(window._autoSkipTimer);
            window._autoSkipTimer = null;
        }
        updatePlayButton(false);
    }
}

function updatePlayButton(isPlaying: boolean) {
    const btn = document.getElementById('btn-play');
    if (btn) {
        btn.innerHTML = isPlaying ? '<i class="fas fa-pause text-sm md:text-base"></i>' : '<i class="fas fa-play ml-0.5 text-sm md:text-base"></i>';
    }
    const tonearm = document.getElementById('vinyl-tonearm');
    if (tonearm) {
        if (isPlaying) tonearm.classList.add('is-playing');
        else tonearm.classList.remove('is-playing');
    }
    const disc = document.getElementById('vinyl-disc');
    if (disc) {
        if (isPlaying) disc.classList.add('is-playing');
        else disc.classList.remove('is-playing');
    }
}

/**
 * 播放下一首。具备自动跳过被预读器标记为“不可解析”的歌曲的能力。
 * @param {Number} depth 递归尝试深度，防止死循环
 * @param {Boolean} isManual 是否为用户主动触发（主动触发时单曲循环模式仍顺次切换下一首）
 */
function playNext(depth = 0, isManual = true) {
    if (depth > 10) {
        console.warn('[Queue] Too many unplayable songs skipped, stopping.');
        return;
    }

    const nextIndex = getNextIndex(isManual);
    if (nextIndex !== -1 && state.currentPlaylist[nextIndex]) {
        const nextSong = state.currentPlaylist[nextIndex];

        // A prefetch failure is only a short-lived hint; users can still retry
        // the song after the network/source has had time to recover.
        if (Number(nextSong._prefetchUnavailableUntil || 0) > Date.now() && nextIndex !== state.currentIndex) {
            console.log(`[Queue] Auto-skipping unplayable song [${nextIndex}]: ${nextSong.name}`);
            state.currentIndex = nextIndex; // 更新当前索引以便 getNextIndex() 能找到下一首
            return playNext(depth + 1, isManual);
        }

        playSong(nextSong, nextIndex);
    } else {
        console.log('[Queue] No next song or reached end of order playlist');
    }
}

function playPrev(isManual = true) {
    if (state.currentPlaylist.length === 0) return;

    let prevIndex;

    const currentMode = state.playMode || 'list';
    switch (currentMode) {
        case 'single':
            // 单曲循环：如果是手动触发上一首，则切换到上一首；否则重播当前歌曲
            if (isManual) {
                prevIndex = state.currentIndex - 1;
                if (prevIndex < 0) prevIndex = state.currentPlaylist.length - 1;
            } else {
                prevIndex = state.currentIndex;
            }
            break;

        case 'random':
            // 随机播放：优先从历史栈倒回刚才听过的歌曲
            if (state.currentPlaylist.length <= 1) {
                prevIndex = 0;
            } else if (playbackHistoryStack.length > 0) {
                const candidateIndex = playbackHistoryStack.pop()!;
                if (candidateIndex >= 0 && candidateIndex < state.currentPlaylist.length) {
                    prevIndex = candidateIndex;
                } else {
                    prevIndex = (state.currentIndex - 1 + state.currentPlaylist.length) % state.currentPlaylist.length;
                }
            } else {
                do {
                    prevIndex = Math.floor(Math.random() * state.currentPlaylist.length);
                } while (prevIndex === state.currentIndex);
            }
            break;

        case 'order':
        case 'list':
        default:
            // 列表循环 & 顺序播放：播放上一首
            prevIndex = state.currentIndex - 1;
            if (prevIndex < 0) prevIndex = state.currentPlaylist.length - 1;
            break;
    }

    isNavigatingHistory = true;
    try {
        playSong(state.currentPlaylist[prevIndex], prevIndex);
    } finally {
        isNavigatingHistory = false;
    }
}

// 音量淡入淡出辅助函数
let volumeFadeInterval = null;
function fadeVolume(targetVolume, duration = 800) {
    if (volumeFadeInterval) clearInterval(volumeFadeInterval);

    // 如果处于静音状态或目标音量为 0，直接置为 0，不执行渐变提升
    if (state.isMuted || targetVolume <= 0) {
        audio.volume = 0;
        audio.muted = Boolean(state.isMuted);
        return Promise.resolve();
    }

    const startVolume = audio.volume;
    const steps = 20;
    const increment = (targetVolume - startVolume) / steps;
    const stepTime = duration / steps;
    let currentStep = 0;

    return new Promise((resolve) => {
        volumeFadeInterval = setInterval(() => {
            if (state.isMuted) {
                clearInterval(volumeFadeInterval);
                audio.volume = 0;
                audio.muted = true;
                resolve();
                return;
            }

            currentStep++;
            let nextVolume = startVolume + (increment * currentStep);

            // 边界检查
            if (nextVolume < 0) nextVolume = 0;
            if (nextVolume > 1) nextVolume = 1;

            audio.volume = nextVolume;

            if (currentStep >= steps) {
                clearInterval(volumeFadeInterval);
                audio.volume = targetVolume;
                resolve();
            }
        }, stepTime);
    });
}



    return {
        playFromView,
        runRecoveryFlow,
        playSong,
        setPlayerStatus,
        savePlayHistory,
        addToDefaultList,
        updatePlaylist,
        setImg,
        updatePlayerInfo,
        changePlaybackQuality,
        togglePlay,
        updatePlayButton,
        playNext,
        playPrev,
        fadeVolume,
    };
}
