import { marked } from 'marked';

export function stringToColor(str: string): string {
    if (!str) return 'var(--accent-primary)';
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 70%, 45%)`;
}

export function safeResourceUrl(value: unknown, fallback = ''): string {
    if (!value) return fallback;
    try {
        const url = new URL(String(value), window.location.origin);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : fallback;
    } catch {
        return fallback;
    }
}

export function safeInlineString(value: unknown): string {
    return JSON.stringify(String(value ?? ''))
        .replace(/&/g, '&amp;')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function renderSafeMarkdown(container: HTMLElement, markdown: string): void {
    const template = document.createElement('template');
    template.innerHTML = marked.parse(String(markdown ?? ''));
    template.content.querySelectorAll('script, iframe, object, embed, frame, frameset, form, link, meta, base, style').forEach(element => element.remove());
    template.content.querySelectorAll('*').forEach(element => {
        Array.from(element.attributes).forEach(attribute => {
            const name = attribute.name.toLowerCase();
            if (name.startsWith('on') || name === 'style') {
                element.removeAttribute(attribute.name);
                return;
            }
            if (name !== 'href' && name !== 'src' && name !== 'xlink:href' && name !== 'action' && name !== 'formaction') return;
            try {
                const url = new URL(attribute.value, window.location.origin);
                if (url.protocol !== 'http:' && url.protocol !== 'https:') element.removeAttribute(attribute.name);
            } catch {
                element.removeAttribute(attribute.name);
            }
        });
    });
    container.replaceChildren(template.content);
}

export function escapeHtml(text: unknown): string {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
}

export function formatTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diff < minute) return '刚刚';
    if (diff < hour) return Math.floor(diff / minute) + '分钟前';
    if (diff < day) return Math.floor(diff / hour) + '小时前';

    return new Date(timestamp).toLocaleString('zh-CN');
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function formatMemory(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (parts.length === 0) parts.push('0m');

    return parts.join(' ');
}

export function renderViewError(container: HTMLElement | null, message: string, retryAction?: string): void {
    if (!container) return;
    const retryMethod = retryAction?.match(/^app\.([A-Za-z0-9_]+)\(\)$/)?.[1];
    const retryButton = retryMethod
        ? `<div style="margin-top: 0.75rem;"><button type="button" class="btn-secondary" style="padding: 0.4rem 1rem; font-size: 0.85rem;" data-admin-action="retry" data-admin-method="${escapeHtml(retryMethod)}">重试</button></div>`
        : '';
    container.innerHTML = `
        <div role="alert" style="color: var(--accent-error); text-align: center; padding: 1.5rem;">
            <p style="margin: 0;">${escapeHtml(message)}</p>
            ${retryButton}
        </div>
    `;
    container.hidden = false;
}
