import { getSongListManager } from './player_services';

type OverlayElement = HTMLElement & {
    inert?: boolean;
};

const OVERLAY_SELECTOR = '[data-a11y-overlay], [id$="-modal"], [id^="modal-"], [id$="-drawer"], #modal';

const controlLabels: Record<string, string> = {
    'search-input': '搜索歌曲、歌手',
    'search-type': '搜索类型',
    'search-source': '搜索来源',
    'gl-local-search-input': '搜索当前页结果',
    'jump-page-input': '跳转页码',
    'songlist-search-input': '搜索歌单',
    'songlist-source': '歌单来源',
    'sl-local-search-input': '搜索当前歌单',
    'sl-local-search-filter': '仅显示当前歌单匹配项',
    'lb-source-select': '排行榜来源',
    'lb-local-search-input': '搜索排行榜歌曲',
    'lb-local-search-filter': '仅显示排行榜匹配项',
    'lm-location-select': '本地音乐位置',
    'lm-folder-select': '本地音乐目录',
    'lm-sort-by': '本地音乐排序字段',
    'lm-sort-order': '本地音乐排序方向',
    'quality-select': '播放音质',
    'setting-default-entry': '默认入口',
    'setting-download-concurrency': '下载并发数',
    'external-list-input': '歌单链接或歌单 ID',
    'qq-input-field': 'QQ 号',
    'new-subfolder-input': '新文件夹名称',
    'custom-minutes': '自定义定时分钟数',
    'setting-default-download-target': '默认下载目标',
    'setting-default-download-quality': '默认下载音质',
    'custom-proxy-url-input': '自定义代理地址',
    'setting-network-list-auto-check-interval': '网络歌单自动检查间隔',
    'hot-search-limit-input': '热搜展示数量',
    'setting-visualizer-opacity': '可视化透明度',
    'lyric-font-size-slider': '歌词字体大小',
    'external-list-source': '外部歌单来源',
    'external-list-input': '外部歌单链接或 ID',
    'manual-index-search-input': '歌曲索引搜索',
    'manual-index-source-select': '歌曲索引来源',
};

const iconLabels: Array<[string, string]> = [
    ['fa-bars', '打开导航菜单'],
    ['fa-times', '关闭'],
    ['fa-step-backward', '上一首'],
    ['fa-step-forward', '下一首'],
    ['fa-play', '播放'],
    ['fa-pause', '暂停'],
    ['fa-volume', '音量控制'],
    ['fa-download', '下载'],
    ['fa-trash', '删除'],
    ['fa-search', '搜索'],
    ['fa-list', '播放列表'],
    ['fa-tasks', '多选操作'],
];

const overlayCloseActions: Record<string, () => void> = {
    'external-list-modal': () => (window as any).closeExternalListModal?.(),
    'qq-input-modal': () => getSongListManager()?.closeQQInputModal(),
    'user-playlist-modal': () => getSongListManager()?.closeUserPlaylistModal(),
    'playlist-add-modal': () => (window as any).closePlaylistAddModal?.(),
    'subpath-select-modal': () => (window as any).LocalMusicManager?.closeSubPathModal?.(),
    'sleep-timer-modal': () => (window as any).closeSleepTimerModal?.(),
    'comment-modal': () => (window as any).toggleCommentModal?.(),
    'sound-effects-modal': () => (window as any).soundEffects?.close?.(),
    'project-agreement-modal': () => (window as any).acceptProjectAgreement?.(),
};

let activeOverlay: OverlayElement | null = null;
let restoreFocusElement: HTMLElement | null = null;
let previousBodyOverflow = '';
let isBodyLocked = false;
let inertBackgroundElements: HTMLElement[] = [];

function setAttributeIfChanged(element: HTMLElement, name: string, value: string): void {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function getOverlays(): OverlayElement[] {
    return Array.from(document.querySelectorAll<OverlayElement>(OVERLAY_SELECTOR)).filter(element => {
        // IDs such as `modal-source-scope-info`
        // belong to controls inside a modal, not to independent overlay roots.
        // Only manage the outermost matching element to avoid keeping the app inert
        // after the actual modal has been closed.
        return !element.parentElement?.closest(OVERLAY_SELECTOR);
    });
}

function isDrawer(element: HTMLElement): boolean {
    return element.id.endsWith('-drawer') || element.dataset.a11yOverlay === 'drawer';
}

function isOpen(element: HTMLElement): boolean {
    if (element.hasAttribute('hidden') || element.classList.contains('hidden')) return false;
    if (getComputedStyle(element).display === 'none') return false;
    if (isDrawer(element)) return !element.classList.contains('translate-x-full');
    if (element.id === 'view-player-detail') return !element.classList.contains('translate-y-[100%]');
    return true;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && !element.closest('[hidden]');
    });
}

function getHeading(element: HTMLElement): HTMLElement | null {
    return element.querySelector<HTMLElement>('h1, h2, h3, [data-overlay-title]');
}

function enhanceFormLabels(): void {
    document.querySelectorAll<HTMLElement>('input, select, textarea, [contenteditable="true"]').forEach(control => {
        if (control instanceof HTMLInputElement && control.type === 'hidden') return;
        if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || (control as HTMLInputElement).labels?.length) return;

        const idLabel = control.id ? controlLabels[control.id] : undefined;
        const nearbyLabel = control.parentElement?.querySelector('label')?.textContent?.trim();
        const placeholder = control.getAttribute('placeholder')?.trim();
        const fallback = control.id || control.getAttribute('name') || control.getAttribute('type');
        const label = idLabel || nearbyLabel || placeholder || fallback;
        if (label) control.setAttribute('aria-label', label.replace(/\s+/g, ' '));
    });
}

function enhanceButtonLabels(): void {
    document.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
        if (button.getAttribute('aria-label') || button.textContent?.trim() || button.title) return;
        const iconClasses = button.querySelector<HTMLElement>('i')?.className || '';
        const label = iconLabels.find(([className]) => iconClasses.includes(className))?.[1];
        if (label) button.setAttribute('aria-label', label);
    });
}

function enhanceOverlay(element: OverlayElement): void {
    if (!element.hasAttribute('role')) element.setAttribute('role', 'dialog');
    setAttributeIfChanged(element, 'aria-modal', String(!isDrawer(element)));
    if (!element.hasAttribute('tabindex')) element.setAttribute('tabindex', '-1');

    const heading = getHeading(element);
    if (heading) {
        if (!heading.id) heading.id = `${element.id || 'overlay'}-title`;
        setAttributeIfChanged(element, 'aria-labelledby', heading.id);
    } else if (!element.hasAttribute('aria-label')) {
        element.setAttribute('aria-label', element.id || '对话框');
    }

    element.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
        if (button.getAttribute('aria-label') || button.textContent?.trim() || button.title) return;
        const icon = button.querySelector<HTMLElement>('[class*="fa-times"], [class*="fa-close"]');
        if (icon) button.setAttribute('aria-label', '关闭');
    });
}

function lockBody(): void {
    if (isBodyLocked) return;
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.dataset.overlayOpen = 'true';
    isBodyLocked = true;
}

function unlockBody(): void {
    if (!isBodyLocked) return;
    document.body.style.overflow = previousBodyOverflow;
    delete document.body.dataset.overlayOpen;
    isBodyLocked = false;
}

function setBackgroundInert(overlay: OverlayElement): void {
    inertBackgroundElements = Array.from(document.body.children)
        .filter((child): child is HTMLElement => (
            child instanceof HTMLElement &&
            child !== overlay &&
            !child.classList.contains('skip-link') &&
            !(overlay.id === 'view-player-detail' && child.id === 'player-footer')
        ));
    inertBackgroundElements.forEach(element => {
        if (!element.inert) element.inert = true;
        if (!element.hasAttribute('inert')) element.setAttribute('inert', '');
    });
}

function clearBackgroundInert(): void {
    inertBackgroundElements.forEach(element => {
        element.inert = false;
        element.removeAttribute('inert');
    });
    inertBackgroundElements = [];
}

function openOverlay(element: OverlayElement): void {
    enhanceOverlay(element);
    if (element.hasAttribute('aria-hidden')) element.removeAttribute('aria-hidden');
    if (element.inert) element.inert = false;
    if (element.hasAttribute('inert')) element.removeAttribute('inert');
    if (!isDrawer(element)) {
        lockBody();
        setBackgroundInert(element);
    }

    if (activeOverlay === element) return;
    if (activeOverlay && activeOverlay !== element) {
        activeOverlay.setAttribute('aria-hidden', 'true');
        activeOverlay.inert = true;
        activeOverlay.setAttribute('inert', '');
    }

    activeOverlay = element;
    requestAnimationFrame(() => {
        const focusable = getFocusableElements(element);
        (focusable[0] || element).focus({ preventScroll: true });
    });
}

function closeOverlay(element: OverlayElement): void {
    if (element.getAttribute('aria-hidden') !== 'true') element.setAttribute('aria-hidden', 'true');
    if (!element.inert) element.inert = true;
    if (!element.hasAttribute('inert')) element.setAttribute('inert', '');

    if (activeOverlay !== element) return;
    activeOverlay = null;
    if (!isDrawer(element)) {
        clearBackgroundInert();
        unlockBody();
    }

    if (restoreFocusElement?.isConnected) {
        restoreFocusElement.focus({ preventScroll: true });
    }
    restoreFocusElement = null;
}

function clearModalStateIfUnused(openOverlays: OverlayElement[]): void {
    // A drawer can remain open while a confirmation modal above it is closed.
    // In that transition closeOverlay(modal) is intentionally not the active
    // close operation, so its old body lock would otherwise survive until the
    // drawer closes and leave the whole page inert.
    if (openOverlays.some(element => !isDrawer(element))) return;
    clearBackgroundInert();
    unlockBody();
}

function dismissTransientPortals(): void {
    if (document.querySelector('.favorite-sidebar-menu.is-open')) {
        (window as any).closeFavoriteSidebarMenus?.();
    }

    if (document.querySelector('.cs-dropdown.portal-active')) {
        (window as any).CustomSelectManager?.closeAll?.();
    }
}

function getOverlayStackingOrder(element: OverlayElement): number {
    // Native modal dialogs are promoted to the browser's top layer by
    // showModal(). Their CSS z-index is not comparable with fixed legacy
    // overlays, so always let an open <dialog> own the active focus boundary.
    if (element.tagName === 'DIALOG' && (element as HTMLDialogElement).open) {
        return Number.MAX_SAFE_INTEGER;
    }
    const zIndex = Number.parseInt(getComputedStyle(element).zIndex, 10);
    return Number.isFinite(zIndex) ? zIndex : 0;
}

function getTopmostOpenOverlay(openOverlays: OverlayElement[]): OverlayElement | null {
    // Overlay roots are not ordered consistently in the document: player
    // drawers are declared after regular modals, while the player detail view
    // is declared before them. Use the rendered stacking order and keep DOM
    // order as the tie-breaker for overlays sharing the same z-index.
    let topmost: OverlayElement | null = null;
    for (const overlay of openOverlays) {
        if (!topmost || getOverlayStackingOrder(overlay) >= getOverlayStackingOrder(topmost)) {
            topmost = overlay;
        }
    }
    return topmost;
}

function syncOverlays(): void {
    const overlays = getOverlays();
    const openOverlays = overlays.filter(isOpen);
    const nextOverlay = getTopmostOpenOverlay(openOverlays);

    // Portaled menus and custom-select dropdowns intentionally use a higher
    // z-index than regular content. Dismiss stale instances before a modal
    // takes over, otherwise an old portal can remain visually above it.
    if (nextOverlay && !isDrawer(nextOverlay) && activeOverlay !== nextOverlay) {
        dismissTransientPortals();
    }

    overlays.forEach(enhanceOverlay);
    enhanceFormLabels();
    enhanceButtonLabels();
    overlays.forEach(element => {
        if (element === nextOverlay) {
            if (activeOverlay !== element && document.activeElement instanceof HTMLElement) {
                restoreFocusElement = document.activeElement;
            }
            openOverlay(element);
        } else if (!isOpen(element)) {
            closeOverlay(element);
        }
    });

    if (!nextOverlay && activeOverlay) closeOverlay(activeOverlay);
    clearModalStateIfUnused(openOverlays);
}

function findCloseButton(element: HTMLElement): HTMLElement | null {
    const buttons = getFocusableElements(element);
    return buttons.find(button =>
        button.matches('[data-overlay-close], .modal-close') ||
        button.title === '关闭' ||
        button.getAttribute('aria-label') === '关闭' ||
        Boolean(button.querySelector('[class*="fa-times"], [class*="fa-close"]'))
    ) || null;
}

function closeActiveOverlay(): void {
    if (!activeOverlay) return;
    const closeAction = overlayCloseActions[activeOverlay.id];
    if (closeAction) {
        closeAction();
        return;
    }

    const closeButton = findCloseButton(activeOverlay);
    if (closeButton) {
        closeButton.click();
        return;
    }

    const backdrop = Array.from(activeOverlay.children).find(child =>
        child instanceof HTMLElement && child.classList.contains('absolute') && child.classList.contains('inset-0')
    );
    if (backdrop instanceof HTMLElement) backdrop.click();
}

function onKeydown(event: KeyboardEvent): void {
    if (!activeOverlay) return;

    if (event.key === 'Escape') {
        event.preventDefault();
        closeActiveOverlay();
        return;
    }

    if (event.key !== 'Tab' || isDrawer(activeOverlay)) return;
    const focusable = getFocusableElements(activeOverlay);
    if (!focusable.length) {
        event.preventDefault();
        activeOverlay.focus();
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

export function initAccessibleOverlays(): void {
    if (!document.body) return;

    document.addEventListener('keydown', onKeydown, true);
    const observer = new MutationObserver(syncOverlays);
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style', 'aria-hidden', 'inert'],
        childList: true,
        subtree: true,
    });

    syncOverlays();
}
