import { escapeHtmlText } from './player_security';

/**
 * 将捕获到的异常转换为面向用户的中文提示，避免把英文技术错误直接暴露给用户。
 * 网络/超时/服务端 5xx 统一转成可读中文；已经是中文的原始信息保持不变。
 */
export function toUserMessage(error: any, fallback = '操作失败，请稍后重试'): string {
    let message = '';
    if (error instanceof Error) {
        message = error.message || '';
    } else if (typeof error === 'string') {
        message = error;
    } else if (error && typeof error === 'object' && typeof error.message === 'string') {
        message = error.message;
    } else if (error !== undefined && error !== null) {
        try {
            message = JSON.stringify(error);
        } catch (_) {
            message = String(error);
        }
    }
    message = String(message || '').trim();
    if (!message) return fallback;

    if (/timeout|timed out|超时/i.test(message)) return '请求超时，请稍后重试';
    if (/failed to fetch|networkerror|network error|load failed|net::|err_connection|err_internet/i.test(message)) {
        return '网络连接失败，请检查网络后重试';
    }
    const statusMatch = message.match(/(?:http\s*|status\s*|api\s*error[:：]?\s*)(\d{3})/i);
    if (statusMatch && Number(statusMatch[1]) >= 500) return '服务器出错，请稍后重试';
    if (/[\u4e00-\u9fa5]/.test(message)) return message;
    return fallback;
}

/**
 * 初始化播放器内的 Toast 和全局加载提示。
 * 跑马灯逻辑由入口文件提供，避免通知模块反向依赖播放器渲染实现。
 */
export function initPlayerNotifications(getMarqueeHelpers) {
    let playbackStatusTimer: ReturnType<typeof setTimeout> | null = null;
    let playbackStatusHideTimer: ReturnType<typeof setTimeout> | null = null;
    let playbackStatusVersion = 0;

    // 通用 Toast 显示函数 (支持宽屏、滚动文字、点击关闭、动态堆叠)
    // duration <= 0 表示常驻提示，需要用户手动关闭。
    function showToast(type, message, duration, options: any = {}) {
        const config = {
            success: { bg: 'bg-emerald-500', icon: 'fa-check-circle' },
            info: { bg: 'bg-blue-500', icon: 'fa-info-circle' },
            error: { bg: 'bg-red-500', icon: 'fa-exclamation-circle' }
        };
        const conf = config[type] || config.info;
        // 错误提示默认留出更长的阅读时间。
        const effectiveDuration = (duration === undefined || duration === null)
            ? (type === 'error' ? 6000 : 3000)
            : duration;
        const persisted = !effectiveDuration || effectiveDuration <= 0;
        const actionLabel = options?.actionLabel ? String(options.actionLabel) : '';
        const onAction = typeof options?.onAction === 'function' ? options.onAction : null;

        const toast = document.createElement('div');
        // 添加 toast-item 类用于后续高度计算
        const errorToastClasses = type === 'error'
            ? 'bg-red-500/95 px-3 py-2.5 w-72 md:w-80'
            : `${conf.bg} px-4 py-3 w-80 md:w-96`;
        const iconClasses = type === 'error' ? 'text-lg' : 'text-xl';
        toast.className = `toast-item fixed right-4 ${errorToastClasses} text-white rounded-lg shadow-lg z-[1000] animate-slide-in flex items-center gap-3 max-w-[calc(100vw-1.5rem)] cursor-pointer transition-all duration-300`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
        toast.setAttribute('aria-atomic', 'true');

        const { createMarqueeHtml, applyMarqueeChecks } = getMarqueeHelpers();
        // 使用通用跑马灯逻辑，自动检测文字是否超出容器宽度
        const contentHtml = createMarqueeHtml(message, 'flex-1 font-medium');
        // 关闭按钮保证触屏设备也有可见的关闭入口 (悬停暂停在触屏上无效)。
        const closeButtonHtml = '<button type="button" data-toast-close aria-label="关闭提示" class="ml-1 -mr-1 p-1 shrink-0 rounded hover:bg-white/20 transition-colors"><i class="fas fa-times text-xs"></i></button>';
        const actionButtonHtml = actionLabel
            ? `<button type="button" data-toast-action class="ml-1 px-2.5 py-1 shrink-0 rounded bg-white/20 hover:bg-white/30 text-xs font-bold whitespace-nowrap transition-colors">${escapeHtmlText(actionLabel)}</button>`
            : '';

        toast.innerHTML = `
            <i class="fas ${conf.icon} ${iconClasses} shrink-0"></i>
            ${contentHtml}
            ${actionButtonHtml}
            ${closeButtonHtml}
        `;

        // Keep notifications above the real player height and the device safe area.
        const footer = document.getElementById('player-footer');
        const footerOffset = footer && !footer.classList.contains('translate-y-[110%]')
            ? Math.ceil(footer.getBoundingClientRect().height)
            : 0;
        const bottomBase = footerOffset + 12;
        const gap = 12;

        toast.style.visibility = 'hidden';
        document.body.appendChild(toast);

        // 触发动态滚动检测
        applyMarqueeChecks();

        const toastHeight = toast.offsetHeight || 60;
        const shiftAmt = toastHeight + gap;

        document.querySelectorAll('.toast-item').forEach(el => {
            if (el === toast) return;
            const oldB = parseFloat(el.dataset.offset || String(bottomBase));
            const newB = oldB + shiftAmt;
            el.style.bottom = `calc(${newB}px + env(safe-area-inset-bottom, 0px))`;
            el.dataset.offset = newB;
        });

        toast.style.bottom = `calc(${bottomBase}px + env(safe-area-inset-bottom, 0px))`;
        toast.dataset.offset = bottomBase;
        toast.style.visibility = 'visible';

        let hideTimer = null;
        let dismissed = false;

        const removeToast = () => {
            if (dismissed) return;
            dismissed = true;
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            const removedOffset = parseFloat(toast.dataset.offset || '0');
            toast.classList.add('opacity-0', 'translate-y-4');
            setTimeout(() => {
                const h = toast.offsetHeight + gap;
                toast.remove();
                document.querySelectorAll('.toast-item').forEach(el => {
                    const elB = parseFloat(el.dataset.offset || '0');
                    if (elB > removedOffset) {
                        const newB = elB - h;
                        el.style.bottom = `calc(${newB}px + env(safe-area-inset-bottom, 0px))`;
                        el.dataset.offset = newB;
                    }
                });
            }, 300);
        };

        const startTimer = () => {
            if (persisted || dismissed) return;
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(removeToast, effectiveDuration);
        };

        startTimer();

        // 点击/触摸关闭: 触屏设备没有悬停，必须能通过点按关闭提示。
        toast.addEventListener('click', (event) => {
            const target = event.target as Element | null;
            if (target?.closest('[data-toast-action]') && onAction) onAction();
            removeToast();
        });

        // 鼠标悬停暂停计时 (优化体验)
        toast.addEventListener('mouseenter', () => {
            if (hideTimer) clearTimeout(hideTimer);
        });

        toast.addEventListener('mouseleave', () => {
            startTimer();
        });
    }

    // 封装旧 API
    function showSuccess(message) { showToast('success', message, 2000); }
    function showInfo(message) { showToast('info', message, 2000); }
    // 错误信息需要留出足够阅读时间，并支持常驻 (options.duration = 0)。
    function showError(message, options: any = {}) { showToast('error', message, options?.duration ?? 6000, options); }

    /**
     * 播放专用状态提示：只复用播放器底栏附近的一个轻量节点，避免解析/换源
     * 过程创建多个大 Toast。通用业务提示仍然继续使用 showInfo/showSuccess/showError。
     */
    function showPlaybackStatus(message: string, options: any = {}) {
        const status = document.getElementById('player-playback-status');
        if (!status) return;

        playbackStatusVersion += 1;
        const currentVersion = playbackStatusVersion;
        if (playbackStatusTimer) clearTimeout(playbackStatusTimer);
        if (playbackStatusHideTimer) clearTimeout(playbackStatusHideTimer);
        playbackStatusTimer = null;
        playbackStatusHideTimer = null;

        const text = status.querySelector<HTMLElement>('[data-playback-status-text]');
        const icon = status.querySelector<HTMLElement>('[data-playback-status-icon]');
        const normalizedMessage = String(message || '').trim();
        if (!normalizedMessage) {
            status.classList.add('opacity-0', 'translate-y-1');
            status.classList.remove('opacity-100', 'translate-y-0');
            playbackStatusHideTimer = setTimeout(() => {
                if (currentVersion !== playbackStatusVersion) return;
                status.classList.add('hidden');
            }, 220);
            return;
        }

        const type = options?.type || 'info';
        const isLoading = options?.loading === true;
        const iconClass = isLoading
            ? 'fa-circle-notch fa-spin'
            : type === 'success'
                ? 'fa-check-circle'
                : type === 'error'
                    ? 'fa-exclamation-circle'
                    : 'fa-info-circle';

        if (text) text.textContent = normalizedMessage;
        if (icon) {
            icon.className = `fas ${iconClass} text-[10px] shrink-0`;
        }
        status.dataset.state = type;
        status.setAttribute('aria-label', normalizedMessage);
        status.classList.remove('hidden', 'opacity-0', 'translate-y-1');
        status.classList.add('opacity-100', 'translate-y-0');

        if (options?.duration > 0) {
            playbackStatusTimer = setTimeout(() => {
                if (currentVersion !== playbackStatusVersion) return;
                showPlaybackStatus('');
            }, Number(options.duration));
        }
    }

    /**
     * 全局加载提示 (showLoading)
     */
    function showLoading(message = '正在处理...') {
        if (document.getElementById('global-loading-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'global-loading-overlay';
        overlay.className = "fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in";
        overlay.innerHTML = `
            <div class="absolute inset-0 bg-black/40 backdrop-blur-[2px] transition-opacity duration-300"></div>
            <div class="t-bg-panel rounded-2xl shadow-2xl p-8 flex flex-col items-center gap-4 relative z-[210] border t-border-main animate-slide-up">
                <div class="relative">
                    <div class="w-12 h-12 rounded-full border-4 border-emerald-100 border-t-emerald-500 animate-spin"></div>
                    <i class="fas fa-music text-emerald-500 absolute inset-0 flex items-center justify-center text-xs"></i>
                </div>
                <p class="text-sm font-bold t-text-main animate-pulse">${escapeHtmlText(message)}</p>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    function hideLoading() {
        const overlay = document.getElementById('global-loading-overlay');
        if (overlay) {
            overlay.classList.add('opacity-0');
            const content = overlay.querySelector('.t-bg-panel');
            if (content) content.classList.add('scale-95');
            setTimeout(() => overlay.remove(), 300);
        }
    }

    // 清除所有当前显示的 Toast
    function dismissAllToasts() {
        const toasts = document.querySelectorAll('.toast-item');
        toasts.forEach(toast => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.remove(), 300);
        });
    }

    Object.assign(window, {
        showToast,
        showSuccess,
        showInfo,
        showError,
        showPlaybackStatus,
        showLoading,
        hideLoading,
        dismissAllToasts,
    });

    return {
        showToast,
        showSuccess,
        showInfo,
        showError,
        showPlaybackStatus,
        showLoading,
        hideLoading,
        dismissAllToasts,
    };
}
