export type PlayerHistoryMode = 'push' | 'replace' | 'restore' | 'none';

export type PlayerHistoryPage =
    | 'player'
    | 'tab'
    | 'search-detail'
    | 'songlist-detail'
    | 'player-detail';

export type PlayerHistoryPayload = {
    page: PlayerHistoryPage;
    tabId?: string;
    scope?: string;
    listId?: string;
    kind?: 'artist' | 'album' | 'playlist';
    id?: string;
    source?: string;
    order?: string;
    tab?: string;
};

export type PlayerHistoryDirection = 'forward' | 'backward';

export type PlayerHistoryState = PlayerHistoryPayload & {
    __yunMusicPlayerHistory: {
        version: 1;
        sessionId: string;
        index: number;
    };
};

export type PlayerHistoryPopState = {
    state: PlayerHistoryPayload;
    direction: PlayerHistoryDirection;
    delta: number;
};

const HISTORY_KEY = '__yunMusicPlayerHistory';
const HISTORY_FIELDS: Array<keyof PlayerHistoryPayload> = [
    'page', 'tabId', 'scope', 'listId', 'kind', 'id', 'source', 'order', 'tab',
];
const PLAYER_HISTORY_PAGES = new Set<PlayerHistoryPage>([
    'player',
    'tab',
    'search-detail',
    'songlist-detail',
    'player-detail',
]);

export type PlayerHistoryAdapter = Pick<History, 'state' | 'replaceState' | 'pushState' | 'go'>;
export type PlayerHistoryDocument = Pick<Document, 'getElementById'>;

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null;
}

function createSessionId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizePayload(payload: PlayerHistoryPayload): PlayerHistoryPayload {
    const normalized: PlayerHistoryPayload = { page: payload.page };
    for (const field of HISTORY_FIELDS) {
        if (field === 'page') continue;
        const value = payload[field];
        if (value !== undefined && value !== null && value !== '') {
            normalized[field] = value as never;
        }
    }
    return normalized;
}

function payloadFromState(state: unknown): PlayerHistoryPayload | null {
    if (!isRecord(state) || typeof state.page !== 'string') return null;
    const payload: Record<string, unknown> = { page: state.page };
    for (const field of HISTORY_FIELDS) {
        if (field === 'page') continue;
        if (state[field] !== undefined) payload[field] = state[field];
    }
    return payload as PlayerHistoryPayload;
}

function samePayload(left: PlayerHistoryPayload | null, right: PlayerHistoryPayload): boolean {
    if (!left) return false;
    return JSON.stringify(normalizePayload(left)) === JSON.stringify(normalizePayload(right));
}

function payloadUrl(payload: PlayerHistoryPayload): string | undefined {
    return payload.tabId ? `#${encodeURIComponent(payload.tabId)}` : undefined;
}

function isPlayerHistoryState(state: unknown): state is PlayerHistoryState {
    if (!isRecord(state) || !isRecord(state[HISTORY_KEY])) return false;
    const metadata = state[HISTORY_KEY];
    return metadata.version === 1
        && typeof metadata.sessionId === 'string'
        && Number.isInteger(metadata.index)
        && metadata.index >= 0
        && typeof state.page === 'string'
        && PLAYER_HISTORY_PAGES.has(state.page as PlayerHistoryPage)
        && payloadFromState(state) !== null;
}

export function createPlayerHistoryController(options: {
    history?: PlayerHistoryAdapter;
    documentRef?: PlayerHistoryDocument;
} = {}) {
    const historyAdapter = options.history ?? window.history;
    const documentRef = options.documentRef ?? document;
    const sessionId = createSessionId();
    let initialized = false;
    let currentIndex = 0;
    let maxIndex = 0;
    let currentState: PlayerHistoryState | null = null;
    let pendingDirection: PlayerHistoryDirection | null = null;
    let controlsBound = false;

    function buildState(payload: PlayerHistoryPayload, index: number): PlayerHistoryState {
        return {
            ...normalizePayload(payload),
            [HISTORY_KEY]: {
                version: 1,
                sessionId,
                index,
            },
        } as PlayerHistoryState;
    }

    function getCanGoBack(): boolean {
        return currentState !== null && currentIndex > 0;
    }

    function getCanGoForward(): boolean {
        return currentState !== null && currentIndex < maxIndex;
    }

    function setButtonState(button: HTMLButtonElement | null, available: boolean, label: string): void {
        if (!button) return;
        const disabled = !available || pendingDirection !== null;
        button.disabled = disabled;
        button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        button.dataset.historyAvailable = available ? 'true' : 'false';
        button.dataset.historyPending = pendingDirection !== null ? 'true' : 'false';
        button.title = disabled && pendingDirection === null ? label : button.dataset.historyLabel || button.title;
    }

    function syncControls(): void {
        const backButton = documentRef.getElementById('player-history-back') as HTMLButtonElement | null;
        const forwardButton = documentRef.getElementById('player-history-forward') as HTMLButtonElement | null;
        setButtonState(backButton, getCanGoBack(), '没有可返回的播放器页面');
        setButtonState(forwardButton, getCanGoForward(), '没有可前进的播放器页面');
    }

    function bindPressFeedback(): void {
        if (controlsBound) return;
        controlsBound = true;

        for (const id of ['player-history-back', 'player-history-forward']) {
            const button = documentRef.getElementById(id) as HTMLButtonElement | null;
            if (!button) continue;
            button.dataset.historyLabel = button.title;
            const clearPressing = () => button.removeAttribute('data-pressing');
            button.addEventListener('pointerdown', () => {
                if (!button.disabled) button.setAttribute('data-pressing', 'true');
            });
            button.addEventListener('pointerup', clearPressing);
            button.addEventListener('pointercancel', clearPressing);
            button.addEventListener('pointerleave', clearPressing);
            button.addEventListener('blur', clearPressing);
        }
    }

    function initialize(initialPayload: PlayerHistoryPayload): void {
        const existingState = isRecord(historyAdapter.state) ? { ...historyAdapter.state } : {};
        for (const field of HISTORY_FIELDS) delete existingState[field];

        const state = buildState(initialPayload, 0);
        historyAdapter.replaceState({ ...existingState, ...state }, '', payloadUrl(initialPayload));
        currentState = state;
        currentIndex = 0;
        maxIndex = 0;
        pendingDirection = null;
        initialized = true;
        bindPressFeedback();
        syncControls();
    }

    function write(payload: PlayerHistoryPayload, mode: Exclude<PlayerHistoryMode, 'restore' | 'none'>): boolean {
        if (!initialized) return false;
        const normalized = normalizePayload(payload);
        if (mode === 'push' && samePayload(currentState ? payloadFromState(currentState) : null, normalized)) {
            syncControls();
            return false;
        }

        const nextIndex = mode === 'push' ? currentIndex + 1 : currentIndex;
        const state = buildState(normalized, nextIndex);
        if (mode === 'push') {
            historyAdapter.pushState(state, '', payloadUrl(normalized));
            currentIndex = nextIndex;
            maxIndex = nextIndex;
        } else {
            historyAdapter.replaceState(state, '', payloadUrl(normalized));
        }
        currentState = state;
        pendingDirection = null;
        syncControls();
        return true;
    }

    function go(direction: PlayerHistoryDirection): boolean {
        const available = direction === 'backward' ? getCanGoBack() : getCanGoForward();
        if (!initialized || !available || pendingDirection !== null) return false;

        pendingDirection = direction;
        syncControls();
        try {
            historyAdapter.go(direction === 'backward' ? -1 : 1);
            return true;
        } catch {
            pendingDirection = null;
            syncControls();
            return false;
        }
    }

    function handlePopState(rawState: unknown): PlayerHistoryPopState | null {
        if (!isPlayerHistoryState(rawState) || rawState.__yunMusicPlayerHistory.sessionId !== sessionId) {
            currentState = null;
            pendingDirection = null;
            syncControls();
            return null;
        }

        const targetIndex = rawState.__yunMusicPlayerHistory.index;
        const delta = targetIndex - currentIndex;
        const direction: PlayerHistoryDirection = delta < 0 ? 'backward' : 'forward';
        currentIndex = targetIndex;
        maxIndex = Math.max(maxIndex, targetIndex);
        currentState = rawState;
        pendingDirection = null;
        syncControls();

        return {
            state: payloadFromState(rawState) as PlayerHistoryPayload,
            direction,
            delta,
        };
    }

    function getState(): PlayerHistoryPayload | null {
        return currentState ? payloadFromState(currentState) : null;
    }

    return {
        initialize,
        push: (payload: PlayerHistoryPayload) => write(payload, 'push'),
        replace: (payload: PlayerHistoryPayload) => write(payload, 'replace'),
        restore: (payload: PlayerHistoryPayload) => {
            if (!initialized || !samePayload(currentState ? payloadFromState(currentState) : null, payload)) return false;
            syncControls();
            return true;
        },
        back: () => go('backward'),
        forward: () => go('forward'),
        handlePopState,
        getState,
        canGoBack: getCanGoBack,
        canGoForward: getCanGoForward,
        syncControls,
    };
}

export type PlayerHistoryController = ReturnType<typeof createPlayerHistoryController>;
