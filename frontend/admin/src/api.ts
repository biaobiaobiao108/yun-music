const API_BASE = '';
const LOGIN_ENDPOINT = '/api/login';
const GENERIC_ERROR_MESSAGE = '请求失败，请稍后重试';
const SESSION_EXPIRED_MESSAGE = '登录状态已过期，请重新登录';

// Server error bodies are expected to carry a Chinese `message`/`error` field.
// Anything else (raw JSON, English-only text, HTML error pages) is replaced by a
// safe generic Chinese message so it never reaches a user-facing toast verbatim.
function hasChinese(text: string): boolean {
    return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}

function resolveErrorMessage(status: number, rawBody: string): string {
    const body = (rawBody || '').trim();
    if (body) {
        let candidate: unknown = body;
        if (body.startsWith('{') || body.startsWith('[')) {
            try {
                const parsed = JSON.parse(body);
                candidate = parsed && (parsed.message ?? parsed.error);
            } catch {
                candidate = null;
            }
        }
        if (typeof candidate === 'string' && hasChinese(candidate)) {
            const message = candidate.trim();
            if (message) return message;
        }
    }
    if (status === 429) return '请求过于频繁，请稍后重试';
    if (status === 401) return SESSION_EXPIRED_MESSAGE;
    if (status === 403) return '没有权限执行此操作';
    return GENERIC_ERROR_MESSAGE;
}

export async function readApiErrorMessage(response: Response): Promise<string> {
    const rawBody = await response.text().catch(() => '');
    return resolveErrorMessage(response.status, rawBody);
}

export function createAdminRequest(onUnauthorized: (message?: string) => void) {
    return async function request(url: string, options: RequestInit = {}): Promise<any> {
        const defaultOptions: RequestInit = {
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
        };

        const response = await fetch(API_BASE + url, {
            ...defaultOptions,
            ...options,
            credentials: options.credentials ?? 'same-origin',
            headers: {
                ...defaultOptions.headers,
                ...(options.headers || {}),
            },
        });

        if (!response.ok) {
            const message = await readApiErrorMessage(response);
            // A 401 from the login endpoint means the submitted password was wrong,
            // not that an existing session expired, so it must not trigger logout.
            if (response.status === 401 && url.split('?')[0] !== LOGIN_ENDPOINT) {
                onUnauthorized(message);
            }
            throw new Error(message);
        }

        return response.json();
    };
}
