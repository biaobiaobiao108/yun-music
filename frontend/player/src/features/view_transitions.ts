/**
 * View Transitions & Motion Utilities for 云音播放器
 * Provides progressive enhancement for document.startViewTransition
 * with graceful fallback for browsers lacking full support or when reduced motion is preferred.
 */

export type ViewTransitionDirection = 'forward' | 'backward';

export type ExtendedViewTransitionDocument = Document & {
    startViewTransition?: (options: {
        update: () => void | Promise<void>;
        types?: string[];
    }) => {
        finished: Promise<void>;
        ready: Promise<void>;
        updateCallbackDone: Promise<void>;
        skipTransition?: () => void;
    };
};

/**
 * 检查用户是否开启了系统的减少动态效果偏好（无障碍标准）
 */
export function prefersReducedMotion(): boolean {
    return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 执行平滑 View Transition。
 * 如果浏览器不支持或用户开启了减少动效，则同帧直接执行 DOM 更新。
 */
export function runViewTransition(
    updateFn: () => void | Promise<void>,
    options: {
        types?: string[];
        fallback?: () => void;
    } = {}
): void {
    const doc = document as ExtendedViewTransitionDocument;
    if (!prefersReducedMotion() && typeof doc.startViewTransition === 'function') {
        try {
            doc.startViewTransition({
                update: updateFn,
                types: options.types,
            });
            return;
        } catch {
            // 某些旧版或非完全兼容浏览器可能在此抛错，优雅回退
        }
    }

    // 降级路径：直接执行状态更新
    const result = updateFn();
    if (result instanceof Promise) {
        result.catch(err => console.error('[ViewTransition] DOM update error:', err));
    }
    if (options.fallback) {
        options.fallback();
    }
}
