export type PlayerEventAction = (
    event: Event,
    element: HTMLElement,
    args: unknown[],
) => unknown;

const customActions = new Map<string, PlayerEventAction>();
const delegatedEvents = [
    'click', 'change', 'input', 'keydown', 'keypress', 'paste', 'copy', 'cut',
    'error', 'load', 'focus', 'blur', 'wheel', 'keyup', 'mouseenter', 'mouseleave', 'play', 'ended', 'timeupdate', 'volumechange',
    'dragstart', 'dragover', 'drop', 'touchstart', 'touchmove', 'touchend',
] as const;

export function registerPlayerEventAction(name: string, action: PlayerEventAction): void {
    customActions.set(name, action);
}

function getEventAttribute(element: HTMLElement, event: Event, name: string): string | undefined {
    const suffix = event.type.charAt(0).toUpperCase() + event.type.slice(1);
    return element.dataset[`event${suffix}${name}`] || element.dataset[`event${name}`];
}

function findActionElement(event: Event): HTMLElement | null {
    for (const target of event.composedPath()) {
        if (target instanceof HTMLElement && getEventAttribute(target, event, 'Action')) return target;
    }
    return null;
}

function resolveGlobalAction(path: string): { owner: any; handler: (...args: any[]) => unknown } | null {
    const normalizedPath = path.startsWith('window.') ? path.slice('window.'.length) : path;
    const parts = normalizedPath.split('.').filter(Boolean);
    if (!parts.length) return null;

    let owner: any = window;
    for (let index = 0; index < parts.length - 1; index += 1) {
        owner = owner?.[parts[index]];
        if (!owner) return null;
    }

    const handler = owner?.[parts[parts.length - 1]];
    return typeof handler === 'function' ? { owner, handler } : null;
}

function resolveArgument(value: unknown, event: Event, element: HTMLElement): unknown {
    if (value !== '@event' && value !== '@this' && typeof value !== 'string') return value;
    switch (value) {
        case '@event': return event;
        case '@this': return element;
        case '@value': return (element as HTMLInputElement).value;
        case '@value-trim': return (element as HTMLInputElement).value.trim();
        case '@value-number': return Number((element as HTMLInputElement).value);
        case '@checked': return (element as HTMLInputElement).checked;
        case '@not-checked': return !(element as HTMLInputElement).checked;
        case '@files': return (element as HTMLInputElement).files;
        case '@event-target': return event.target;
        default: return value;
    }
}

function readArguments(element: HTMLElement, event: Event): unknown[] {
    const raw = getEventAttribute(element, event, 'Args');
    if (!raw) return [];
    try {
        const values = JSON.parse(raw);
        return Array.isArray(values) ? values.map(value => resolveArgument(value, event, element)) : [];
    } catch (error) {
        console.warn('[PlayerEvents] Invalid event arguments:', raw, error);
        return [];
    }
}

function matchesEventGuard(element: HTMLElement, event: Event): boolean {
    if (event instanceof KeyboardEvent && element.dataset.eventTargetSelf === 'true' && event.target !== element) {
        return false;
    }

    const allowedKeys = element.dataset.eventKeys
        ?.split(',')
        .map(key => key.trim())
        .filter(Boolean);
    if (allowedKeys?.length && event instanceof KeyboardEvent && !allowedKeys.includes(event.key)) {
        return false;
    }

    const expectedKey = element.dataset.eventKey;
    if (expectedKey && event instanceof KeyboardEvent && event.key !== expectedKey) return false;

    const maxWidth = Number(element.dataset.eventMediaMax);
    if (Number.isFinite(maxWidth) && window.innerWidth > maxWidth) return false;

    return true;
}

function dispatchPlayerEvent(event: Event): void {
    const element = findActionElement(event);
    if (!element || !matchesEventGuard(element, event)) return;

    if (element.dataset.eventPrevent === 'true') event.preventDefault();
    if (element.dataset.eventStop === 'true') event.stopPropagation();

    const actionName = getEventAttribute(element, event, 'Action');
    if (!actionName) return;
    const args = readArguments(element, event);
    const customAction = customActions.get(actionName);
    if (customAction) {
        customAction(event, element, args);
        return;
    }

    if (actionName === 'stop-propagation') {
        event.stopPropagation();
        return;
    }

    if (actionName === 'remove-readonly') {
        element.removeAttribute('readonly');
        return;
    }

    if (actionName === 'set-theme-hover-c500') {
        element.style.color = getComputedStyle(document.documentElement).getPropertyValue('--c-500');
        return;
    }

    if (actionName === 'clear-theme-hover-color') {
        element.style.color = '';
        return;
    }

    if (actionName === 'set-theme-hover-c500-border-c300') {
        const styles = getComputedStyle(document.documentElement);
        element.style.color = styles.getPropertyValue('--c-500');
        element.style.borderColor = styles.getPropertyValue('--c-300');
        return;
    }

    if (actionName === 'clear-theme-hover-color-border') {
        element.style.color = '';
        element.style.borderColor = '';
        return;
    }

    if (actionName === 'set-theme-hover-border-c200-color-c600') {
        const styles = getComputedStyle(document.documentElement);
        element.style.borderColor = styles.getPropertyValue('--c-200');
        element.style.color = styles.getPropertyValue('--c-600');
        return;
    }

    if (actionName === 'clear-theme-hover-border-color') {
        element.style.borderColor = '';
        element.style.color = '';
        return;
    }

    if (actionName.startsWith('this.')) {
        let owner: any = element;
        const parts = actionName.slice('this.'.length).split('.').filter(Boolean);
        const methodName = parts.pop();
        for (const part of parts) owner = owner?.[part];
        const handler = methodName ? owner?.[methodName] : null;
        if (typeof handler === 'function') handler.apply(owner, args);
        return;
    }

    if (actionName === 'fallback-image' && element instanceof HTMLImageElement) {
        if (element.dataset.fallbackImage === 'used') return;
        element.dataset.fallbackImage = 'used';
        element.src = '/music/assets/yun-yin.png';
        element.classList.add('is-placeholder');
        return;
    }

    if (actionName === 'fallback-comment-image' && element instanceof HTMLImageElement) {
        if (element.dataset.tried) return;
        element.dataset.tried = '1';
        element.src = '/music/assets/yun-yin.png';
        element.classList.add('dynamic-logo', 'is-placeholder', 'p-1.5', 'bg-emerald-50');
        element.style.filter = 'var(--logo-filter, none)';
        return;
    }

    if (actionName === 'hide-parent-button') {
        const button = element.closest('button');
        if (button) button.style.display = 'none';
        return;
    }

    const resolved = resolveGlobalAction(actionName);
    if (!resolved) {
        console.warn(`[PlayerEvents] Action not found: ${actionName}`);
        return;
    }

    resolved.handler.apply(resolved.owner, args);
}

export function bindPlayerEvents(): void {
    for (const eventName of delegatedEvents) {
        document.addEventListener(eventName, dispatchPlayerEvent, eventName === 'error'
            || eventName === 'load'
            || eventName === 'focus'
            || eventName === 'blur'
            || eventName === 'mouseenter'
            || eventName === 'mouseleave');
    }
}
