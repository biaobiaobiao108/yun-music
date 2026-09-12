export interface LyricState {
    currentLyricLines: any[];
    isLyricViewOpen: boolean;
    currentLyricIndex: number;
    wordAnimationId: number | null;
    lyricPlayer: any;
    isUserScrolling: boolean;
    scrollLockTimeout: ReturnType<typeof setTimeout> | null;
    isProgrammaticScroll: boolean;
    currentRawLrc: string;
    currentRawTlrc: string;
    currentRawRlrc: string;
    currentRawKlrc: string;
    lastLyricSongId: string | null;
}

export interface LyricFeatureContext {
    state: LyricState;
    getSettings: () => Record<string, any>;
    getAudio: () => HTMLMediaElement;
    getCurrentPlayingSong: () => any;
    getCurrentListData: () => any;
    getCurrentQuality: () => any;
    getCurrentPlaybackRate: () => number;
    getUserAuthHeaders: () => Record<string, string>;
    getImgUrl: (song: any) => string;
    setImg: (id: string, src: string) => void;
    handleSearchPopState?: (state: any) => boolean;
    updateStorageStatsUI: (...args: any[]) => any;
    escapeHtmlText: (text: any) => string;
    formatTime: (seconds: number) => string;
    startToggleLyricsBtnTimer: () => void;
    scrollLockDuration: number;
}

export function initLyricFeature(context: LyricFeatureContext) {
    const state = context.state;
    const API_BASE = '/api/music';
    const audio = context.getAudio();
    const settings = new Proxy<Record<string, any>>({}, {
        get: (_target, property: string) => context.getSettings()[property],
        set: (_target, property: string, value: any) => {
            context.getSettings()[property] = value;
            return true;
        },
    });
    const getUserAuthHeaders = context.getUserAuthHeaders;
    const getImgUrl = context.getImgUrl;
    const setImg = context.setImg;
    const handleSearchPopState = context.handleSearchPopState || (() => false);
    const updateStorageStatsUI = context.updateStorageStatsUI;
    const escapeHtmlText = context.escapeHtmlText;
    const formatTime = context.formatTime;
    const startToggleLyricsBtnTimer = context.startToggleLyricsBtnTimer;
    const SCROLL_LOCK_DURATION = context.scrollLockDuration;
let lyricHistoryClosePending = false;
let lyricRequestController: AbortController | null = null;
let lyricRequestSerial = 0;

function toggleLyrics(fromPopState = false) {
    if (!fromPopState && state.isLyricViewOpen) {
        if (window.history.state && window.history.state.page === 'player-detail') {
            lyricHistoryClosePending = true;
            window.history.back();
        }
    }
    if (!fromPopState && !state.isLyricViewOpen) {
        window.history.pushState({ page: 'player-detail' }, '');
    }

    state.isLyricViewOpen = !state.isLyricViewOpen;
    const view = document.getElementById('view-player-detail');

    if (state.isLyricViewOpen) {
        view.classList.remove('hidden');
        // Trigger reflow
        void view.offsetWidth;
        view.classList.remove('translate-y-[100%]', 'opacity-0');

        // 开始歌词按钮淡化倒计时
        startToggleLyricsBtnTimer();

        // Update UI
        if (context.getCurrentPlayingSong()) {
            updateDetailInfo(context.getCurrentPlayingSong());
            // If no lyrics yet, try fetch
            if (state.currentLyricLines.length === 0) {
                fetchLyric(context.getCurrentPlayingSong());
            }
            // 仅在音频正在播放时才启动歌词滚动，防止暂停时打开详情页歌词自走
            if (state.lyricPlayer && !audio.paused) {
                state.lyricPlayer.play(audio.currentTime * 1000);
            }
            setTimeout(() => scrollToActiveLine(true), 100);
        }

        // Notify visualizer to switch canvas
        setTimeout(() => {
            if (window.musicVisualizer) window.musicVisualizer.applySettings();
        }, 300);

        // 开启歌词详情页沉浸极简底栏模式并确保底栏交互正常可用
        const footerEl = document.getElementById('player-footer');
        if (footerEl) {
            footerEl.classList.add('player-footer-immersive');
            if (footerEl.inert) footerEl.inert = false;
            if (footerEl.hasAttribute('inert')) footerEl.removeAttribute('inert');
        }

        // 如果开启了自动精简，且在手机端进入详情页，则自动精简
        if (settings.autoCompactPlaybar !== false && window.innerWidth < 1025) {
            window.setCompactPlaybar(true);
        }
    } else {
        view.classList.add('translate-y-[100%]', 'opacity-0');
        // 退出歌词详情页，平滑恢复完整底栏模式并确保底栏交互正常
        const footerEl = document.getElementById('player-footer');
        if (footerEl) {
            footerEl.classList.remove('player-footer-immersive');
            if (footerEl.inert) footerEl.inert = false;
            if (footerEl.hasAttribute('inert')) footerEl.removeAttribute('inert');
        }

        setTimeout(() => {
            view.classList.add('hidden');
            // Notify visualizer to switch back to footer
            if (window.musicVisualizer) window.musicVisualizer.applySettings();
        }, 600); // match transition duration

        // 关闭详情页自动展开控制栏
        if (settings.autoCompactPlaybar !== false && window.innerWidth < 1025) {
            window.setCompactPlaybar(false);
        }
    }
}

// 监听浏览器返回，用于在移动端通过物理返回键/手势关闭歌词详情页
window.addEventListener('popstate', (e) => {
    // 1. 优先处理歌词页
    if (state.isLyricViewOpen) {
        // 前进回到 player-detail 时页面本来就是打开状态，不要把它再次关闭。
        if (e.state?.page === 'player-detail') return;
        toggleLyrics(true);
        return;
    }

    // 关闭歌词详情时会主动回退一个 player-detail 历史项；该 popstate 不是搜索详情返回。
    if (lyricHistoryClosePending) {
        lyricHistoryClosePending = false;
        return;
    }

    // 歌词详情关闭后点击浏览器前进，应恢复歌词详情，而不是把事件交给搜索模块。
    if (e.state?.page === 'player-detail') {
        toggleLyrics(true);
        return;
    }

    // 2. 前进/后退搜索详情 (歌手/专辑)，由搜索模块根据完整路由状态恢复。
    handleSearchPopState(e.state);
});

function updateDetailInfo(song) {
    document.getElementById('detail-title').innerText = song.name;
    document.getElementById('detail-artist').innerText = song.singer;
    const imgUrl = getImgUrl(song);
    // Use high res image if possible or same URL
    setImg('detail-cover', imgUrl);
    setImg('detail-bg-cover', imgUrl);
}

async function fetchLyric(song, quality = null) {
    if (!song) {
        return;
    }

    // 支持两种数据结构:
    // 1. 搜索结果: song.songmid, song.source 在顶层
    // 2. 收藏列表: song.songmid, song.source 可能在 meta 中
    // 3. 不同平台字段名差异: songmid vs songId
    let songmid = song.songmid || song.songId;
    let source = song.source;

    // 如果顶层没有,尝试从 meta 中获取
    if (!songmid && song.meta) {
        songmid = song.meta.songmid || song.meta.songId;
    }
    if (!source && song.meta) {
        source = song.meta.source;
    }

    // 如果还是没有必要的数据,退出
    if (!songmid || !source) {
        console.warn('[Lyric] 歌曲缺少必要的字段 songmid/songId 或 source:', song);
        return;
    }

    // [Optimize] 如果歌曲未变化且已有歌词，跳过完整加载流程逻辑
    const currentLyricKey = `${source}_${songmid}`;
    if (state.lastLyricSongId === currentLyricKey && state.currentLyricLines.length > 0) {
        console.log(`[Lyric] 歌词已就绪(${currentLyricKey})，同步播放状态`);
        if (state.lyricPlayer) {
            applyLyricUpdate();
        }
        return;
    }
    lyricRequestController?.abort();
    const requestController = new AbortController();
    lyricRequestController = requestController;
    const requestSerial = ++lyricRequestSerial;
    const isCurrentRequest = () => requestSerial === lyricRequestSerial && !requestController.signal.aborted;

    state.lastLyricSongId = currentLyricKey;

    document.getElementById('lyric-content').innerHTML = '<p class="t-text-muted text-lg animate-pulse">正在加载歌词...</p>';
    state.currentLyricLines = [];

    // ===== 1. 尝试读取浏览器本地缓存 (最高优先级) =====
    const cacheKey = `lx_lyric_${source}_${songmid}`;
    if (settings.enableLyricCache !== false) {
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const data = JSON.parse(cached);
                state.currentRawLrc = data.lrc || '';
                state.currentRawTlrc = data.tlyric || '';
                state.currentRawRlrc = data.rlyric || '';
                state.currentRawKlrc = data.klyric || data.lxlyric || '';

                console.log(`[Lyric] 使用浏览器本地缓存歌词: ${songmid}`);
                initLyricPlayer();
                applyLyricUpdate();
                return; // 命中缓存，直接返回
            }
        } catch (e) {
            console.warn('[Lyric] 读取浏览器本地缓存失败:', e);
            localStorage.removeItem(cacheKey);
        }
    }

    // ===== 2. 尝试读取服务器端缓存歌词 =====
    const username = context.getCurrentListData()?.username || '';
    const headers = {};
    Object.assign(headers, getUserAuthHeaders());

    if (settings.enableServerLyricCache !== false) {
        try {
            const serverCacheUrl = `${API_BASE}/cache/lyric?source=${source}&songmid=${songmid}&songId=${encodeURIComponent(song.id || '')}&name=${encodeURIComponent(song.name || '')}&singer=${encodeURIComponent(song.singer || '')}`;
            const scRes = await fetch(serverCacheUrl, { headers, signal: requestController.signal });
            if (!isCurrentRequest()) return;
            if (scRes.ok) {
                const scData = await scRes.json();
                if (!isCurrentRequest()) return;
                if (scData.success && scData.data) {
                    state.currentRawLrc = scData.data.lyric || scData.data.lrc || '';
                    state.currentRawTlrc = scData.data.tlyric || '';
                    state.currentRawRlrc = scData.data.rlyric || '';
                    state.currentRawKlrc = scData.data.klyric || scData.data.lxlyric || '';

                    console.log(`[Lyric] 使用服务器端缓存歌词: ${source}_${songmid}`);

                    // 同步到浏览器本地缓存
                    if (settings.enableLyricCache !== false && state.currentRawLrc) {
                        localStorage.setItem(cacheKey, JSON.stringify({
                            lrc: state.currentRawLrc, tlyric: state.currentRawTlrc, rlyric: state.currentRawRlrc, klyric: state.currentRawKlrc
                        }));
                    }

                    initLyricPlayer();
                    applyLyricUpdate();
                    return;
                }
            }
        } catch (e) {
            if (e?.name !== 'AbortError' && isCurrentRequest()) {
                console.warn('[Lyric] 读取服务器端缓存失败:', e);
            }
        }
    }

    // ===== 3. 从网络抓取最新歌词 =====
    try {
        const params = new URLSearchParams({
            source,
            songmid,
            name: song.name || song.songname || '',
            singer: song.singer || song.singername || '',
            hash: song.hash || '',
            interval: song.interval || song.duration || '',
            copyrightId: song.copyrightId || '',
            albumId: song.albumId || '',
            lrcUrl: song.lrcUrl || '',
            mrcUrl: song.mrcUrl || '',
            trcUrl: song.trcUrl || ''
        });

        const url = `${API_BASE}/lyric?${params.toString()}`;
        // [优化] 使用低优先级 fetch 获取歌词，避免阻塞主进程加载和 PWA 安装按钮出现
        const res = await fetch(url, { headers, priority: 'low', signal: requestController.signal });

        if (!res.ok) {
            throw new Error(`Fetch lyric failed: ${res.status}`);
        }

        const data = await res.json();
        if (!isCurrentRequest()) return;
        state.currentRawLrc = data.lyric || data.lrc || '';
        state.currentRawTlrc = data.tlyric || '';
        state.currentRawRlrc = data.rlyric || '';
        state.currentRawKlrc = data.klyric || data.lxlyric || '';

        const isFromLocal = !!data._fromLocalCache;
        console.log(`[Lyric] ${isFromLocal ? '使用服务器本地缓存歌词' : '获取到网络歌词'}:`, { source, songmid });

        // ===== 4. 写入缓存 (浏览器本地 + 服务器端) =====
        if (state.currentRawLrc) {
            const cacheData = {
                lrc: state.currentRawLrc,
                tlyric: state.currentRawTlrc,
                rlyric: state.currentRawRlrc,
                klyric: state.currentRawKlrc
            };

            // 写入浏览器本地
            if (settings.enableLyricCache !== false) {
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(cacheData));
                    updateStorageStatsUI();
                } catch (e) {
                    console.warn('[Lyric] 写入本地缓存失败:', e);
                }
            }

            // 写入服务器端 (如果不是已经来自服务器缓存，且启用了服务端缓存)
            // [Fix] 只有在音质已知且不为 unknown/null 时才向服务端写歌词缓存，
            // 避免在播放起步且音质未定前过早写入 - unknown - 歌词冗余文件。
            // 确切音质的歌词会在播放器确定音质后由 playback.ts 同步写入服务端。
            const resolvedLyricQuality = (typeof quality !== 'undefined' && quality !== null)
                ? quality
                : (typeof context.getCurrentQuality() !== 'undefined' ? context.getCurrentQuality() : null);

            if (settings.enableServerLyricCache !== false && !isFromLocal && resolvedLyricQuality && resolvedLyricQuality !== 'unknown') {
                try {
                    fetch(`${API_BASE}/cache/lyric`, {
                        method: 'POST',
                        signal: requestController.signal,
                        headers: {
                            ...headers,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            songInfo: { ...song, quality: resolvedLyricQuality },
                            lyricsObj: {
                                lyric: state.currentRawLrc,
                                tlyric: state.currentRawTlrc,
                                rlyric: state.currentRawRlrc,
                                lxlyric: state.currentRawKlrc
                            }
                        })
                    }).catch(e => {
                        if (e?.name !== 'AbortError' && isCurrentRequest()) {
                            console.warn('[Lyric] 上传服务端缓存失败:', e);
                        }
                    });
                } catch (e) { }
            }
        }

        if (!state.currentRawLrc) {
            renderLyric([]);
            return;
        }

        // Initialize LinePlayer
        initLyricPlayer();
        applyLyricUpdate();

    } catch (e) {
        if (e?.name === 'AbortError' || !isCurrentRequest()) return;
        console.error(`[Lyric] Failed (${source}_${songmid}):`, e);
        renderLyric([], `暂无歌词 (${source}: ${songmid})`);
    }
}

// 辅助函数：根据当前设置应用歌词更新
function applyLyricUpdate() {
    if (!state.lyricPlayer || !state.currentRawLrc) return;

    const extendedLyrics = [];
    const showTrans = settings.showLyricTranslation !== false;
    const showRoma = settings.showLyricRoma === true;
    const isSwap = settings.swapLyricTransRoma === true;

    if (showTrans && state.currentRawTlrc && showRoma && state.currentRawRlrc) {
        if (isSwap) {
            extendedLyrics.push(state.currentRawRlrc);
            extendedLyrics.push(state.currentRawTlrc);
        } else {
            extendedLyrics.push(state.currentRawTlrc);
            extendedLyrics.push(state.currentRawRlrc);
        }
    } else if (showTrans && state.currentRawTlrc) {
        extendedLyrics.push(state.currentRawTlrc);
    } else if (showRoma && state.currentRawRlrc) {
        extendedLyrics.push(state.currentRawRlrc);
    }

    // 优先使用逐字歌词 (klyric/lxlyric)，如果不存在则使用普通歌词
    const mainLyric = state.currentRawKlrc || state.currentRawLrc;
    state.lyricPlayer.setLyric(mainLyric, extendedLyrics);

    // [Fix] 仅在音频真正播放时才启动歌词滚动
    if (!audio.paused) {
        state.lyricPlayer.play(audio.currentTime * 1000);
    } else {
        state.lyricPlayer.pause(); // 确保强制同步到暂停状态
    }
}

// 辅助函数：初始化歌词播放器
function initLyricPlayer() {
    if (!window.LinePlayer) {
        console.error('[Lyric] LinePlayer not loaded');
        return;
    }

    if (!state.lyricPlayer) {
        state.lyricPlayer = new window.LinePlayer({
            offset: 0,
            rate: context.getCurrentPlaybackRate() || 1,
            onPlay: (lineNum, text, curTime) => {
                syncLyricByLineNum(lineNum);
            },
            onSetLyric: (lines, offset) => {
                state.currentLyricLines = lines;
                window.currentLyricLines = lines; // expose for lyric-card.js
                renderLyric(lines);
            }
        });
    }
}

// Helper function to calculate lyric offset (Center Line)
function getLyricOffset() {
    const containerBox = document.getElementById('lyric-container');
    if (!containerBox) return 0;

    // 无论桌面还是移动端，显示还是隐藏封面，统一使用固定比例参考线
    // 这样可以保证指示器(indicator)高度在切换模式时保持绝对稳定
    const footer = document.getElementById('player-footer');
    const isFooterHidden = footer && footer.classList.contains('translate-y-[110%]');

    // 使用 0.35 作为黄金分割参考线位置 [lyric-scroll-indicator]
    const ratio = isFooterHidden ? 0.25 : 0.25;
    return containerBox.clientHeight * ratio;
}

// Helper to scroll to active line
function scrollToActiveLine(force = false) {
    if (state.isUserScrolling && !force) return;

    const containerBox = document.getElementById('lyric-container');
    const lyricContent = document.getElementById('lyric-content');
    if (!containerBox || !lyricContent) return;

    const lines = lyricContent.children;
    if (lines.length === 0) return;

    // Use state.currentLyricIndex, default to 0 if invalid
    let targetIndex = state.currentLyricIndex;
    if (targetIndex < 0 || targetIndex >= lines.length) targetIndex = 0;

    const currentLine = lines[targetIndex];
    if (!currentLine) return;

    const lineTop = currentLine.offsetTop;

    // 计算目标参考线位置
    const offsetInContainer = getLyricOffset();

    const targetScroll = lineTop - offsetInContainer;

    // 标记为程序滚动
    state.isProgrammaticScroll = true;

    // Clear any existing forced cleanup timer
    if (window.programmaticScrollTimer) clearTimeout(window.programmaticScrollTimer);

    containerBox.scrollTo({
        top: targetScroll,
        behavior: 'smooth'
    });

    // 1500ms 后清除标记 (给予平滑滚动足够的时间)
    window.programmaticScrollTimer = setTimeout(() => {
        state.isProgrammaticScroll = false;
        window.programmaticScrollTimer = null;
    }, 1500);
}

// Sync lyric by line number (called by LinePlayer)
function syncLyricByLineNum(lineNum) {
    // Always update the highlight classes regardless of scroll
    const container = document.getElementById('lyric-content');
    if (!container) return;

    const lines = container.children;

    // Check if index actually changed to update classes
    if (lineNum !== state.currentLyricIndex) {
        state.currentLyricIndex = lineNum;
        window.currentLyricIndex = lineNum;   // expose for lyric-card.js
        window.currentLyricLines = state.currentLyricLines; // expose for lyric-card.js

        // Remove active class from previous line
        const prev = container.querySelector('.active');
        if (prev) prev.classList.remove('active');

        // Add active class to current line
        if (lineNum >= 0 && lineNum < lines.length) {
            lines[lineNum].classList.add('active');
        }

        // SMTC 歌词显示：将当前歌词行写入 MediaSession metadata.title，artist 显示「歌曲名 - 歌手名」
        if ('mediaSession' in navigator && navigator.mediaSession.metadata && settings.enableSmtcLyric) {
            try {
                const lyricText = (lineNum >= 0 && state.currentLyricLines && state.currentLyricLines[lineNum])
                    ? state.currentLyricLines[lineNum].text
                    : '';
                const song = context.getCurrentPlayingSong();
                const songTitle = song ? song.name : '';
                navigator.mediaSession.metadata.title = lyricText || songTitle;
                // artist 字段保留「歌曲名 - 歌手名」，让用户知道当前播放的歌曲
                if (song) {
                    navigator.mediaSession.metadata.artist = `${song.name} - ${song.singer}`;
                }
            } catch (e) {
                // ignore
            }
        }
    }

    // 仅在正在播放且有逐字歌词时，才启动动画循环
    if (state.wordAnimationId) cancelAnimationFrame(state.wordAnimationId);
    if (!audio.paused && lineNum >= 0 && lineNum < lines.length) {
        const lineData = state.currentLyricLines[lineNum];
        if (lineData && lineData.words && lineData.words.length > 0) {
            startWordProgressUpdate(lineNum, lines[lineNum], lineData);
        }
    }

    // Perform scroll (scrollToActiveLine handles state.isUserScrolling check)
    scrollToActiveLine();
}

function findCurrentLyricLine(time: number): number {
    const lines = state.currentLyricLines || [];
    if (time <= 0 || lines.length === 0) return 0;

    for (let index = 0; index < lines.length; index++) {
        if (time < Number(lines[index]?.time)) return index === 0 ? 0 : index - 1;
    }
    return lines.length - 1;
}

/**
 * 启动逐字动画更新循环 (仅针对有逐字数据的行)
 * 极致性能重构：预提取/缓存节点数据，脏值比对避免无谓 DOM/CSS 变量写，消除微卡顿
 */
function startWordProgressUpdate(lineIndex, lineEl, lineData) {
    const rawWordSpans = lineEl.querySelectorAll('.word-item');
    if (!rawWordSpans.length) return;

    const lineStartTime = lineData.time;

    // 获取该行最后一个字结束的真实时长作为整行时长
    let lineDuration = 5000;
    const lastWord = lineData.words[lineData.words.length - 1];
    if (lastWord) {
        lineDuration = lastWord.startTime + lastWord.duration;
    }
    if (lineDuration <= 0) lineDuration = 5000;

    // 预提取所有 word 节点的时长与起止时间，避免每一帧读取 dataset
    let totalWordsDuration = 0;
    const wordsMeta = new Array(rawWordSpans.length);
    for (let i = 0; i < rawWordSpans.length; i++) {
        const span = rawWordSpans[i] as HTMLElement;
        const start = parseInt(span.dataset.start || '0', 10) || 0;
        const duration = parseInt(span.dataset.duration || '0', 10) || 0;
        totalWordsDuration += duration;
        wordsMeta[i] = {
            el: span,
            start,
            duration,
            lastProgress: -1,
            lastState: '' // 'none', 'playing', 'passed'
        };
    }

    // 预提取所有 extended (翻译/罗马音) 节点，避免每一帧 querySelector
    const extSpans = lineEl.querySelectorAll('.extended');
    const extMeta: Array<{
        el: HTMLElement;
        items: Array<{
            el: HTMLElement;
            itemStart: number;
            itemEnd: number;
            perItemWeight: number;
            lastProgress: number;
            lastState: string;
        }>;
    }> = [];

    for (let i = 0; i < extSpans.length; i++) {
        const ext = extSpans[i] as HTMLElement;
        const items = ext.querySelectorAll('.ext-item');
        const itemCount = items.length;
        if (itemCount > 0) {
            const perItemWeight = 100 / itemCount;
            const itemsArr = new Array(itemCount);
            for (let j = 0; j < itemCount; j++) {
                itemsArr[j] = {
                    el: items[j] as HTMLElement,
                    itemStart: j * perItemWeight,
                    itemEnd: (j + 1) * perItemWeight,
                    perItemWeight,
                    lastProgress: -1,
                    lastState: ''
                };
            }
            extMeta.push({ el: ext, items: itemsArr });
        }
    }

    let lastLineProgress = -1;

    function update() {
        // 如果当前播放行已改变，或音频暂停，停止动画
        if (state.currentLyricIndex !== lineIndex || audio.paused) {
            return;
        }

        const curTimeMs = audio.currentTime * 1000;
        const relativeTime = curTimeMs - lineStartTime;

        let sungDuration = 0;

        // 1. 更新逐字进度 (脏检查)
        for (let i = 0; i < wordsMeta.length; i++) {
            const meta = wordsMeta[i];
            const start = meta.start;
            const duration = meta.duration;

            if (relativeTime >= start + duration) {
                // 已播放完
                sungDuration += duration;
                if (meta.lastState !== 'passed') {
                    meta.lastState = 'passed';
                    meta.lastProgress = 100;
                    meta.el.style.setProperty('--word-progress', '100%');
                    meta.el.classList.add('passed');
                    meta.el.classList.remove('playing');
                }
            } else if (relativeTime >= start) {
                // 正在播放中
                const elapsed = relativeTime - start;
                sungDuration += elapsed;
                const rawProgress = duration > 0 ? (elapsed / duration) * 100 : 100;
                const progress = Math.min(100, Math.max(0, rawProgress));

                // 脏检查：进度变动超过 0.5% 或从其他状态切入时才写入 DOM
                if (meta.lastState !== 'playing' || Math.abs(progress - meta.lastProgress) >= 0.5) {
                    meta.lastProgress = progress;
                    meta.el.style.setProperty('--word-progress', `${progress.toFixed(1)}%`);
                    if (meta.lastState !== 'playing') {
                        meta.lastState = 'playing';
                        meta.el.classList.add('playing');
                        meta.el.classList.remove('passed');
                    }
                }
            } else {
                // 尚未播放
                if (meta.lastState !== 'none') {
                    meta.lastState = 'none';
                    meta.lastProgress = 0;
                    meta.el.style.setProperty('--word-progress', '0%');
                    meta.el.classList.remove('passed', 'playing');
                }
            }
        }

        // 2. 更新整行进度 (用于带有逐字数据的翻译/罗马音平滑扫过)
        const lineProgress = totalWordsDuration > 0
            ? (sungDuration / totalWordsDuration) * 100
            : Math.min(100, Math.max(0, (relativeTime / lineDuration) * 100));

        if (Math.abs(lineProgress - lastLineProgress) >= 0.5) {
            lastLineProgress = lineProgress;
            lineEl.style.setProperty('--line-progress', `${lineProgress.toFixed(1)}%`);
        }

        // 3. 更新扩展歌词逐字类 (翻译/罗马音) - 同步平滑染色
        for (let e = 0; e < extMeta.length; e++) {
            const ext = extMeta[e];
            for (let j = 0; j < ext.items.length; j++) {
                const item = ext.items[j];
                if (lineProgress >= item.itemEnd) {
                    if (item.lastState !== 'passed') {
                        item.lastState = 'passed';
                        item.lastProgress = 100;
                        item.el.style.setProperty('--word-progress', '100%');
                        item.el.classList.add('passed');
                        item.el.classList.remove('playing');
                    }
                } else if (lineProgress >= item.itemStart) {
                    const rawP = ((lineProgress - item.itemStart) / item.perItemWeight) * 100;
                    const p = Math.min(100, Math.max(0, rawP));
                    if (item.lastState !== 'playing' || Math.abs(p - item.lastProgress) >= 0.5) {
                        item.lastProgress = p;
                        item.el.style.setProperty('--word-progress', `${p.toFixed(1)}%`);
                        if (item.lastState !== 'playing') {
                            item.lastState = 'playing';
                            item.el.classList.add('playing');
                            item.el.classList.remove('passed');
                        }
                    }
                } else {
                    if (item.lastState !== 'none') {
                        item.lastState = 'none';
                        item.lastProgress = 0;
                        item.el.style.setProperty('--word-progress', '0%');
                        item.el.classList.remove('passed', 'playing');
                    }
                }
            }
        }

        state.wordAnimationId = requestAnimationFrame(update);
    }

    state.wordAnimationId = requestAnimationFrame(update);
}

// 节流函数
let scrollThrottleTimer = null;

// 用户手动滚动歌词
function handleLyricScroll() {
    // 忽略程序自动滚动
    if (state.isProgrammaticScroll) {
        return;
    }

    // 标记用户正在滚动
    state.isUserScrolling = true;

    // 显示指示器
    const indicator = document.getElementById('lyric-scroll-indicator');
    const container = document.getElementById('lyric-container');
    if (indicator && container) {
        // [Fix] 每次显示时动态更新高度，确保与自动滚动对齐点一致
        // indicator 是绝对定位在 lyrics-wrapper 内 (父容器)
        // offset 是相对于 lyric-container 顶部的距离 (子容器)
        // lyric-container 顶部可能有 Title 占据空间，因此需要加上 container.offsetTop
        const offset = getLyricOffset();
        indicator.style.top = `${container.offsetTop + offset}px`;

        indicator.classList.remove('hidden');
        indicator.style.display = 'flex';
    }

    // 清除之前的计时器
    if (state.scrollLockTimeout) {
        clearTimeout(state.scrollLockTimeout);
    }

    // 优化：如果有正在等待的帧，直接返回，不重复计算 (Leading throttle behavior)
    if (scrollThrottleTimer) {
        return;
    }

    // 使用 requestAnimationFrame 实时更新（约16ms一次，流畅无延迟）
    scrollThrottleTimer = requestAnimationFrame(() => {
        updateScrollIndicator();
        scrollThrottleTimer = null;
    });

    // 5秒后恢复自动滚动并隐藏指示器
    state.scrollLockTimeout = setTimeout(() => {
        state.isUserScrolling = false;
        state.scrollLockTimeout = null;

        // 隐藏指示器
        if (indicator) {
            indicator.classList.add('hidden');
            indicator.style.display = 'none';
        }

        // 清除滚动目标高亮
        const lyricContent = document.getElementById('lyric-content');
        if (lyricContent) {
            const lines = lyricContent.children;
            for (let i = 0; i < lines.length; i++) {
                lines[i].classList.remove('scroll-target');
            }
        }

        // 恢复后立即同步到当前播放位置
        if (state.lyricPlayer && !audio.paused) {
            // 确保内部状态同步
            state.lyricPlayer.play(audio.currentTime * 1000);
        }

        // [Fix] 立即滚动回当前歌词，不等待下一句更新
        scrollToActiveLine(true);

    }, SCROLL_LOCK_DURATION);
}

// 更新滚动指示器（显示当前对准的歌词时间）
function updateScrollIndicator() {
    const container = document.getElementById('lyric-container');
    const indicator = document.getElementById('lyric-scroll-indicator');
    const lyricContent = document.getElementById('lyric-content');

    // 如果不在滚动状态，清除所有高亮并返回
    if (!container || !indicator || !lyricContent || !state.isUserScrolling) {
        if (lyricContent) {
            const lines = lyricContent.children;
            for (let i = 0; i < lines.length; i++) {
                lines[i].classList.remove('scroll-target');
            }
        }
        return;
    }


    // [Refactor] 虚线位置已在 handleLyricScroll 中动态设置，这里不再需要一次性初始化
    // 且现在完全依赖 getLyricOffset() 保证位置统一

    // 直接获取虚线的实际屏幕位置
    const indicatorRect = indicator.getBoundingClientRect();
    const referenceY = indicatorRect.top + indicatorRect.height / 2;

    const lines = lyricContent.children;
    let overlapIndex = -1;
    let closestIndex = -1;
    let minDist = Infinity;

    // 遍历查找重叠或最近的歌词行
    // 改为纯几何碰撞检测，比 elementFromPoint 更可靠
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const rect = line.getBoundingClientRect();

        // 1. 检查是否重叠 (Green line inside the rect)
        if (referenceY >= rect.top && referenceY <= rect.bottom) {
            overlapIndex = i;
        }

        // 2. 检查距离 (Fallback)
        const center = rect.top + rect.height / 2;
        const dist = Math.abs(center - referenceY);
        if (dist < minDist) {
            minDist = dist;
            closestIndex = i;
        }
    }

    // 优先使用重叠的行，其次使用距离最近的行
    const targetIndex = overlapIndex !== -1 ? overlapIndex : closestIndex;

    let targetTime = 0;
    if (targetIndex !== -1 && lines[targetIndex]) {
        targetTime = parseFloat(lines[targetIndex].dataset.time) / 1000;
    }

    // 高亮对应的歌词行
    for (let i = 0; i < lines.length; i++) {
        if (i === targetIndex) {
            lines[i].classList.add('scroll-target');
        } else {
            lines[i].classList.remove('scroll-target');
        }
    }

    // 更新时间显示
    const timeDisplay = indicator.querySelector('.time-display');
    if (timeDisplay && targetTime > 0) {
        const minutes = Math.floor(targetTime / 60);
        const seconds = Math.floor(targetTime % 60);
        timeDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
}

// renderLyric function - generates DOM elements for each lyric line
function renderLyric(lines, emptyMsg = '暂无歌词') {
    const container = document.getElementById('lyric-content');
    container.innerHTML = '';

    if (lines.length === 0) {
        container.innerHTML = `<p class="t-text-muted text-lg font-medium">${escapeHtmlText(emptyMsg)}</p>`;
        return;
    }

    // 根据设置决定是否开启荧光效果
    if (settings.enableLyricGlow !== false) {
        container.classList.add('enable-lyric-glow');
    } else {
        container.classList.remove('enable-lyric-glow');
    }

    // Create fragment for better performance
    const frag = document.createDocumentFragment();

    lines.forEach((line, idx) => {
         const div = document.createElement('div');
        div.className = `lyric-line relative py-2 px-1 text-center md:text-left transition-all duration-300`;
        div.dataset.time = line.time;
        div.dataset.index = idx;
        div.setAttribute('role', 'button');
        div.tabIndex = 0;
        div.setAttribute('aria-label', `跳转到 ${formatTime(line.time / 1000)} 歌词`);

        // Click to seek
        const seekToLine = () => {
            // line.time 是毫秒，audio.currentTime 需要秒
            audio.currentTime = line.time / 1000;

            // 立即更新 UI 高亮和位置，提供即时反馈
            syncLyricByLineNum(idx);
            scrollToActiveLine(true);

            // 解除滚动锁定
            state.isUserScrolling = false;
            if (state.scrollLockTimeout) {
                clearTimeout(state.scrollLockTimeout);
                state.scrollLockTimeout = null;
            }

            // 隐藏指示器
            const indicator = document.getElementById('lyric-scroll-indicator');
            if (indicator) {
                indicator.classList.add('hidden');
                indicator.style.display = 'none';
            }

            // [Fix] 清除所有的高亮样式 (scroll-target)
            const allLines = document.querySelectorAll('.lyric-line');
            allLines.forEach(l => l.classList.remove('scroll-target'));

        };
        div.onclick = seekToLine;
        div.onkeydown = (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            seekToLine();
        };

        // Inner content wrapper
        const contentDiv = document.createElement('div');
        contentDiv.className = 'line-content';

        // Main lyric text
        const span = document.createElement('span');
        span.className = 'font-lrc text-gray-500 transition-all block w-fit mx-auto md:ml-0';

        if (line.words && line.words.length > 0) {
            div.classList.add('has-words');
            line.words.forEach(word => {
                const wordSpan = document.createElement('span');
                wordSpan.className = 'word-item';
                wordSpan.textContent = word.text;
                wordSpan.dataset.start = word.startTime;
                wordSpan.dataset.duration = word.duration;
                span.appendChild(wordSpan);
            });
        } else {
            span.textContent = line.text;
            span.classList.add('plain-lyric');
        }

        contentDiv.appendChild(span);

        // Extended Lyrics (Translation, Romanization, etc.)
        if (line.extendedLyrics && line.extendedLyrics.length > 0) {
            line.extendedLyrics.forEach(extText => {
                if (!extText) return;
                const extSpan = document.createElement('span');
                extSpan.className = 'extended t-text-muted block w-fit mx-auto md:ml-0';

                // 逐字/逐字符拆分：中日韩按字符，其他按空格
                const hasCJK = /[\u4e00-\u9fa5]|[\u3040-\u309f]|[\u30a0-\u30ff]/.test(extText);
                const segments = hasCJK ? extText.split('') : extText.split(/(\s+)/).filter(s => s.length > 0);

                segments.forEach(seg => {
                    const s = document.createElement('span');
                    s.className = 'ext-item';
                    s.textContent = seg;
                    extSpan.appendChild(s);
                });

                contentDiv.appendChild(extSpan);
            });
        }

        div.appendChild(contentDiv);
        frag.appendChild(div);
    });

    container.appendChild(frag);

    // [Fix] Ensure we are in auto-scroll mode and centered on load
    state.isUserScrolling = false;

    // If audio is already playing, sync the player immediately to highlight the right line
    if (state.lyricPlayer && !audio.paused) {
        state.lyricPlayer.play(audio.currentTime * 1000);
    }

    // Force a scroll update after a short delay to ensure layout is ready
    setTimeout(() => {
        scrollToActiveLine(true);
    }, 100);
}



    return {
        toggleLyrics,
        updateDetailInfo,
        fetchLyric,
        applyLyricUpdate,
        initLyricPlayer,
        getLyricOffset,
        scrollToActiveLine,
        syncLyricByLineNum,
        findCurrentLyricLine,
        startWordProgressUpdate,
        handleLyricScroll,
        updateScrollIndicator,
        renderLyric,
    };
}
