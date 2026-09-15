// @ts-nocheck
// This legacy-compatible module is compiled as an isolated browser bundle.
/**
 * Music Visualizer Integration using Wave.js
 * Manages independent footer and detail view canvases and syncs with theme color.
 */

const musicVisualizer = (function () {
    let audioContext, audioSource, audioAnalyser;
    let waveFooter, waveDetail;
    let isInitialized = false;
    let waveLifecycleInstalled = false;

    const audio = document.getElementById('audio-player');
    const footerCanvas = document.getElementById('footer-visualizer');
    const detailCanvas = document.getElementById('detail-visualizer');
    const playerFooter = document.getElementById('player-footer');

    /**
     * The vendored Wave runtime starts a RAF loop from its constructor and
     * historically had no way to cancel it. Patch the integration boundary
     * once so hidden/reduced-motion visualizers can release their frame loop
     * without rebuilding the third-party bundle.
     */
    function installWaveLifecycle() {
        const WaveConstructor = window.Wave;
        if (!WaveConstructor || waveLifecycleInstalled) return;

        const prototype = WaveConstructor.prototype;
        if (prototype.__lxLifecycleInstalled) {
            waveLifecycleInstalled = true;
            return;
        }

        prototype._play = function () {
            const instance = this;
            if (instance.__lxWaveRafId !== null && instance.__lxWaveRafId !== undefined) return;

            if (instance._audioSource && !instance.__lxWaveConnected) {
                instance._audioSource.connect(instance._audioAnalyser);
                if (!instance._muteAudio) instance._audioSource.connect(instance._audioContext.destination);
                instance.__lxWaveConnected = true;
            }

            instance._audioAnalyser.smoothingTimeConstant = 0.85;
            instance._audioAnalyser.fftSize = 1024;
            instance.__lxWaveData ||= new Uint8Array(instance._audioAnalyser.frequencyBinCount);
            instance.__lxWaveStopped = false;

            const draw = () => {
                instance.__lxWaveRafId = null;
                if (instance.__lxWaveStopped) return;
                instance._audioAnalyser.getByteFrequencyData(instance.__lxWaveData);
                instance._canvasContext.clearRect(0, 0, instance._canvasContext.canvas.width, instance._canvasContext.canvas.height);
                instance._activeAnimations.forEach(animation => animation.draw(instance.__lxWaveData, instance._canvasContext));
                instance.__lxWaveRafId = window.requestAnimationFrame(draw);
            };

            instance.__lxWaveDraw = draw;
            draw();
        };

        prototype.start = function () {
            this.__lxWaveStopped = false;
            if (this.__lxWaveRafId === null || this.__lxWaveRafId === undefined) this._play();
        };

        prototype.stop = function () {
            this.__lxWaveStopped = true;
            if (this.__lxWaveRafId !== null && this.__lxWaveRafId !== undefined) {
                window.cancelAnimationFrame(this.__lxWaveRafId);
                this.__lxWaveRafId = null;
            }
        };

        prototype.__lxLifecycleInstalled = true;
        waveLifecycleInstalled = true;
    }

    /**
     * Initialize AudioContext and AnalyserNode.
     */
    function init() {
        if (isInitialized || !window.Wave || !audio) return;

        try {
            console.log('[Visualizer] Initializing AudioContext...');
            installWaveLifecycle();
            audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // 如果音效管理器已存在，使用它的分析器
            if (window.soundEffects && window.soundEffects.getAnalyser()) {
                audioAnalyser = window.soundEffects.getAnalyser();
                console.log('[Visualizer] Using analyser from SoundEffectsManager');
            } else {
                audioSource = audioContext.createMediaElementSource(audio);
                audioAnalyser = audioContext.createAnalyser();
                audioSource.connect(audioAnalyser);
                audioAnalyser.connect(audioContext.destination);
            }

            audioAnalyser.smoothingTimeConstant = 0.8;
            audioAnalyser.fftSize = 512;

            waveFooter = new Wave(audioAnalyser, footerCanvas);
            waveDetail = new Wave(audioAnalyser, detailCanvas);

            isInitialized = true;
            console.log('[Visualizer] Initialized successfully');

            syncSize();
            applySettings();
        } catch (e) {
            console.error('[Visualizer] Initialization failed:', e);
        }
    }

    /**
     * Sync canvas resolutions.
     */
    function syncSize() {
        [footerCanvas, detailCanvas].forEach(canvas => {
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0) return;
            const dpr = window.devicePixelRatio || 1;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
        });
    }

    /**
     * Apply independent settings for Footer and Detail.
     */
    function applySettings() {
        if (!isInitialized) return;

        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (document.hidden || reducedMotion) {
            waveFooter?.clearAnimations();
            waveDetail?.clearAnimations();
            waveFooter?.stop();
            waveDetail?.stop();
            if (footerCanvas) footerCanvas.style.opacity = '0';
            if (detailCanvas) detailCanvas.style.opacity = '0';
            return;
        }

        // 每次应用设置前同步一次尺寸，确保全宽对齐
        syncSize();

        const s = window.settings || {};
        const themeColor = getComputedStyle(document.documentElement).getPropertyValue('--c-500').trim() || '#10b981';
        const opacity = s.visualizerOpacity !== undefined ? s.visualizerOpacity : 0.5;
        const globalStyle = s.visualizerGlobalStyle || 'blocks';
        const globalGap = globalStyle === 'blocks' ? 2 : 0;

        // --- Handle Footer Visualizer ---
        waveFooter.clearAnimations();
        const visualizerContainer = document.getElementById('visualizer-container');

        if (s.showFooterVisualizer && footerCanvas && visualizerContainer) {
            const style = s.footerVisualizerStyle || 'bars';
            // 获取容器实际宽度而不是 Canvas 宽度
            const containerRect = visualizerContainer.getBoundingClientRect();
            const containerWidth = containerRect.width;

            let count, gap, lineWidth, cubeHeight;

            if (globalStyle === 'blocks') {
                gap = 1; // 极小间距，更细腻
                lineWidth = 0;
                cubeHeight = 4; // 稍微降低高度，配合宽度
                const targetPitch = 5; // Pitch reduced (Width ~4px)

                // 计算填满宽度所需的数量 (近似值)
                const maxCount = Math.floor(containerWidth / targetPitch);
                count = Math.min(maxCount, 1024);

                // 不再强制设置像素宽度，而是让它填满容器
                //这能兼容各种屏幕尺寸和浏览器缩放，避免“前端对齐”或右侧留白问题
                footerCanvas.style.width = '100%';
                footerCanvas.style.height = '100%';
            } else {
                // 连体样式
                gap = 0;
                lineWidth = 2;
                cubeHeight = undefined;
                const targetPitch = 6;
                const maxCount = Math.floor(containerWidth / targetPitch);
                count = Math.min(maxCount, 1024);

                footerCanvas.style.width = '100%';
                footerCanvas.style.height = '100%';
            }

            // 同步物理分辨率
            syncSize();

            const options = {
                fillColor: themeColor,
                lineColor: themeColor,
                lineWidth: lineWidth,
                count: count,
                rounded: true, // 方块样式下 rounded 对 Cubes 无效或产生圆角，可保留
                bottom: true,
                gap: gap
            };

            if (cubeHeight !== undefined) {
                options.cubeHeight = cubeHeight;
            }

            let AnimationClass = waveFooter.animations.Cubes; // Default
            if (style === 'wave') {
                AnimationClass = waveFooter.animations.Wave;
            }

            waveFooter.addAnimation(new AnimationClass(options));
            waveFooter.start();
            footerCanvas.style.opacity = opacity;

            // 调整内容区域高度
            const footerIsHidden = playerFooter && playerFooter.classList.contains('translate-y-[110%]');

            // 增加容器高度和 Footer 高度
            const isShortWindow = window.innerHeight <= 845;
            visualizerContainer.style.height = isShortWindow ? '32px' : '48px';
            visualizerContainer.style.zIndex = '1';
            visualizerContainer.style.display = 'flex'; // 确保可见
            if (playerFooter) {
                playerFooter.style.transition = 'height 0.3s ease';
                if (window.innerWidth >= 768) {
                    // 保持播放栏紧凑，并让实际高度继续由 ResizeObserver 同步给抽屉布局
                    playerFooter.style.height = isShortWindow ? '76px' : '80px';
                    playerFooter.style.justifyContent = 'center'; // [Fix] 增加高度后内容保持垂直居中
                } else {
                    // 手机端保持自适应高度，避免 flex-center 导致内容溢出屏幕外
                    playerFooter.style.height = '';
                    playerFooter.style.justifyContent = '';
                }
            }

            // [Important] 如果音频正在播放但 Context 挂起了（常见于浏览器策略），立即恢复
            if (audioContext && audioContext.state === 'suspended' && audio && !audio.paused) {
                audioContext.resume();
            }

            // 调整内容区域的间距以防被遮挡
            const mainViews = document.querySelectorAll('#view-search, #view-favorites, #view-settings, #view-about, #view-player-detail, #view-songlist, #songlist-detail-view, #view-leaderboard');
            const isMobile = window.innerWidth < 768;
            const measuredFooterHeight = playerFooter && !footerIsHidden
                ? Math.ceil(playerFooter.getBoundingClientRect().height)
                : 0;
            // Footer 使用 fixed 覆盖在内容上方，主体卡片只需避让实际高度并保留 8px 微距。
            const contentGap = 8;
            let targetPb = footerIsHidden ? '' : `${measuredFooterHeight + contentGap}px`;

            mainViews.forEach(view => {
                view.style.transition = 'padding-bottom 0.3s ease, padding-top 0.3s ease';
                let pb = targetPb;

                if (view.id === 'view-player-detail') {
                    // [Fix] 详情页特殊处理：使用容器 Margin 而不是视图 Padding，防止背景图层因 Padding 出现视觉断层（黑线）
                    const container = view.querySelector('#player-detail-container');
                    if (container) {
                        const needsTopPadding = !footerIsHidden && window.innerWidth >= 768;
                        container.style.marginTop = needsTopPadding ? '60px' : '';

                        // [Important] 详情页父容器 view-player-detail 已有 pb-24 (96px)，
                        // 此处的 margin-bottom 应扣除这部分，否则会导致歌词区域被过度压缩
                        const extraPb = pb === '' ? '' : Math.max(0, parseInt(pb) - 96) + 'px';
                        container.style.marginBottom = extraPb;
                        container.style.transition = 'margin 0.3s ease';
                    }
                    view.style.paddingBottom = ''; // 确保详情页视图本身没有 Padding
                    view.style.paddingTop = '';
                } else {
                    // 其他列表页继续使用 Padding
                    view.style.paddingBottom = pb;
                }
            });

            // 调整侧边栏底部 Padding
            const sidebar = document.querySelector('aside');
            if (sidebar) {
                sidebar.style.transition = 'padding-bottom 0.3s ease';
                sidebar.style.paddingBottom = targetPb;
            }
        } else if (footerCanvas && visualizerContainer) {
            waveFooter.stop();
            footerCanvas.style.opacity = '0';
            visualizerContainer.style.height = ''; // 复原 (h-12 / 48px)
            footerCanvas.style.width = '100%'; // 复原宽度
            if (playerFooter) {
                playerFooter.style.height = '';
                playerFooter.style.justifyContent = ''; // 复原
            }
            // 复原 Padding
            const mainViews = document.querySelectorAll('#view-search, #view-favorites, #view-settings, #view-about, #view-player-detail, #view-songlist, #songlist-detail-view, #view-leaderboard');
            mainViews.forEach(view => {
                view.style.paddingBottom = '';
                const container = view.querySelector('#player-detail-container');
                if (container) {
                    container.style.marginTop = '';
                    container.style.marginBottom = '';
                }
                view.style.paddingTop = '';
            });
            const sidebar = document.querySelector('aside');
            if (sidebar) {
                sidebar.style.paddingBottom = '';
            }
        }

        // --- Handle Detail Visualizer ---
        waveDetail.clearAnimations();
        if (s.showDetailVisualizer && detailCanvas) {
            const style = s.detailVisualizerStyle || 'pulse';
            const discEl = document.getElementById('vinyl-disc');
            const discRect = discEl ? discEl.getBoundingClientRect() : null;
            const dpr = window.devicePixelRatio || 1;
            const discWidthPx = (discRect && discRect.width > 0) ? discRect.width * dpr : (detailCanvas.width * 0.76);
            const baseDiameter = Math.max(100, Math.round(discWidthPx - 4 * dpr));

            const options = {
                fillColor: themeColor,
                lineColor: themeColor,
                lineWidth: Math.max(1, Math.round(1.5 * dpr)),
                count: 64,
                rounded: true,
                diameter: baseDiameter,
                gap: globalGap // 为 Pulse 等样式应用全局风格间距
            };

            let AnimationClass = waveDetail.animations.Turntable; // Default for 'pulse'

            if (style === 'dots') {
                AnimationClass = waveDetail.animations.Glob;
                options.diameter = Math.max(100, Math.round(discWidthPx - 6 * dpr));
                options.count = 80;
            } else if (style === 'flower') {
                AnimationClass = waveDetail.animations.Flower;
                options.diameter = Math.max(100, Math.round(discWidthPx - 4 * dpr));
                options.count = 32;
            } else {
                // Pulse (Turntable)
                options.cubeHeight = Math.max(4, Math.round(5 * dpr));
            }

            waveDetail.addAnimation(new AnimationClass(options));
            waveDetail.start();
            // 淡化详情页波形显示效果，使其柔和不抢眼
            const detailOpacity = Math.max(0.08, opacity * 0.65);
            detailCanvas.style.opacity = String(detailOpacity);
        } else if (detailCanvas) {
            waveDetail.stop();
            detailCanvas.style.opacity = '0';
        }
    }

    /**
     * 手动清除可视化内容
     * @param {string} type 'footer' | 'detail'
     */
    function clear(type) {
        if (type === 'footer' && waveFooter) {
            waveFooter.clearAnimations();
            waveFooter.stop();
            if (footerCanvas) {
                const ctx = footerCanvas.getContext('2d');
                ctx.clearRect(0, 0, footerCanvas.width, footerCanvas.height);
            }
        } else if (type === 'detail' && waveDetail) {
            waveDetail.clearAnimations();
            waveDetail.stop();
            if (detailCanvas) {
                const ctx = detailCanvas.getContext('2d');
                ctx.clearRect(0, 0, detailCanvas.width, detailCanvas.height);
            }
        }
    }

    if (audio) {
        audio.addEventListener('play', () => {
            if (!isInitialized) {
                init();
            } else if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
        });
    }

    window.addEventListener('resize', () => {
        syncSize();
        if (isInitialized) applySettings();
    });

    document.addEventListener('visibilitychange', () => {
        if (isInitialized) applySettings();
    });

    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', () => {
        if (isInitialized) applySettings();
    });

    return { init, applySettings, syncSize, clear };
})();

window.musicVisualizer = musicVisualizer;
