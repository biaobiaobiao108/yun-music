export function escapeHtmlText(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    })[ch]);
}

export function safeImageUrl(value, fallback = '/music/assets/yun-yin.png') {
    if (value && typeof value === 'object') {
        value = value.url || value.src || value.picUrl || value.img || value.cover || value.picture;
    }
    if (!value || typeof value === 'object') return fallback;
    try {
        const parsed = new URL(String(value), window.location.origin);
        // Music APIs still return legacy HTTP cover URLs. Upgrade remote
        // images so they satisfy the app CSP and avoid mixed-content blocks.
        if (parsed.protocol === 'http:' && parsed.origin !== window.location.origin) {
            parsed.protocol = 'https:';
        }
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch (e) { }
    return fallback;
}

export function safeInlineString(value) {
    return escapeHtmlText(JSON.stringify(String(value ?? '')));
}

export function safeInlineJson(value) {
    const json = JSON.stringify(value ?? null) || 'null';
    return escapeHtmlText(json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'));
}

export function renderSafeMarkdown(container, markdown) {
    const marked = (window as any).marked;
    if (!marked) {
        container.textContent = markdown;
        return;
    }

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
