export interface AuthFeatureContext {
    getUserName: () => string | null;
    setUserName: (username: string | null) => void;
    isUserSessionActive: () => boolean;
    setUserSessionActive: (active: boolean) => void;
    showSelect: (...args: any[]) => Promise<boolean>;
    handleLogout: (skipConfirm?: boolean) => Promise<void>;
    onSessionChanged?: (active: boolean) => void | Promise<void>;
}

/**
 * Web-only authentication feature.
 * Credentials never enter localStorage/sessionStorage and every API request
 * relies on the HttpOnly same-origin session cookie.
 */
export function initAuthFeature(context: AuthFeatureContext) {
    let verifyPromise: Promise<boolean> | null = null;

    function getUserAuthHeaders(): Record<string, string> {
        return {};
    }

    function isUserLoggedIn(): boolean {
        return Boolean(context.getUserName() && context.isUserSessionActive());
    }

    function isPublicLibraryContext(): boolean {
        return !isUserLoggedIn();
    }

    async function ensureUserSession(options: { force?: boolean } = {}): Promise<boolean> {
        if (verifyPromise && !options.force) return verifyPromise;
        verifyPromise = (async () => {
            try {
                const response = await fetch('/api/user/auth/verify', { credentials: 'same-origin', cache: 'no-store' });
                const result = await response.json() as { valid?: boolean; username?: string | null };
                const active = response.ok && result.valid === true && Boolean(result.username);
                context.setUserSessionActive(active);
                context.setUserName(active ? result.username! : null);
                updateUserUI();
                void context.onSessionChanged?.(active);
                return active;
            } catch {
                context.setUserSessionActive(false);
                updateUserUI();
                void context.onSessionChanged?.(false);
                return false;
            } finally {
                verifyPromise = null;
            }
        })();
        return verifyPromise;
    }

    function updateUserUI(): void {
        const loginBtn = document.getElementById('header-login-btn');
        const userDisplay = document.getElementById('header-user-display');
        const usernameEl = document.getElementById('header-username');
        if (!loginBtn || !userDisplay || !usernameEl) return;

        const username = context.getUserName();
        if (username && context.isUserSessionActive()) {
            loginBtn.classList.add('hidden');
            loginBtn.classList.remove('flex');
            userDisplay.classList.add('flex');
            userDisplay.classList.remove('hidden');
            usernameEl.textContent = username;
        } else {
            loginBtn.classList.add('flex');
            loginBtn.classList.remove('hidden');
            userDisplay.classList.add('hidden');
            userDisplay.classList.remove('flex');
        }
    }

    async function handleHeaderLogout(event?: Event): Promise<void> {
        event?.stopPropagation();
        await context.handleLogout(false);
    }

    return {
        getUserAuthHeaders,
        isUserLoggedIn,
        isPublicLibraryContext,
        ensureUserSession,
        updateUserUI,
        handleHeaderLogout,
    };
}
