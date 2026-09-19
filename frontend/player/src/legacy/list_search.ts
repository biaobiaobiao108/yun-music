type ListSearchConfig = {
    renderCallback: (() => void) | null;
    paginationCallback: ((page: number, index: number) => void) | null;
    getList: (() => any[]) | null;
    getCurrentPage?: (() => number) | null;
    itemsPerPage: number;
};

const state = {
    id: '',
    active: false,
    query: '',
    matches: [] as number[],
    currentIndex: -1,
    onlyShowMatches: false,
};

const config: ListSearchConfig = {
    renderCallback: null,
    paginationCallback: null,
    getList: null,
    getCurrentPage: null,
    itemsPerPage: 20,
};

function prefix(): string {
    return state.id === 'songlist' ? 'sl-' : state.id === 'leaderboard' ? 'lb-' : 'gl-';
}

function resetState(): void {
    state.active = false;
    state.query = '';
    state.matches = [];
    state.currentIndex = -1;
    state.onlyShowMatches = false;
    document.getElementById(`${prefix()}local-search-bar`)?.classList.add('hidden');
    const input = document.getElementById(`${prefix()}local-search-input`) as HTMLInputElement | null;
    if (input) input.value = '';
    const filter = document.getElementById(`${prefix()}local-search-filter`) as HTMLInputElement | null;
    if (filter) filter.checked = false;
    document.getElementById(`${prefix()}local-search-nav`)?.classList.add('opacity-0', 'pointer-events-none');
}

function toggleBar(force?: boolean): void {
    const bar = document.getElementById(`${prefix()}local-search-bar`);
    const input = document.getElementById(`${prefix()}local-search-input`) as HTMLInputElement | null;
    if (!bar || !input) return;
    const show = typeof force === 'boolean' ? force : bar.classList.contains('hidden');
    if (show) {
        bar.classList.remove('hidden');
        input.focus();
        state.active = true;
    } else {
        resetState();
        config.renderCallback?.();
    }
}

function handleSearch(): void {
    const input = document.getElementById(`${prefix()}local-search-input`) as HTMLInputElement | null;
    if (!input) return;
    const query = input.value.trim().toLowerCase();
    const nav = document.getElementById(`${prefix()}local-search-nav`);
    const count = document.getElementById(`${prefix()}local-search-count`);
    state.query = query;
    state.active = !!query;
    if (!query) {
        state.matches = [];
        state.currentIndex = -1;
        nav?.classList.add('opacity-0', 'pointer-events-none');
        config.renderCallback?.();
        return;
    }
    const list = config.getList?.() || [];
    state.matches = list.flatMap((item, index) => {
        const name = String(item?.name || '').toLowerCase();
        const singer = String(item?.singer || '').toLowerCase();
        return name.includes(query) || singer.includes(query) ? [index] : [];
    });
    state.currentIndex = state.matches.length ? 0 : -1;
    nav?.classList.toggle('opacity-0', !state.matches.length);
    nav?.classList.toggle('pointer-events-none', !state.matches.length);
    if (count) count.textContent = state.matches.length ? `1/${state.matches.length}` : '0/0';
    config.renderCallback?.();
}

function scrollToMatch(index: number): void {
    const row = document.getElementById(`${prefix()}row-${index}`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('search-current', 'shadow-lg');
    setTimeout(() => row.classList.remove('shadow-lg'), 2500);
}

function navigate(direction: number): void {
    if (!state.matches.length) return;
    const nextIndex = (state.currentIndex + direction + state.matches.length) % state.matches.length;
    state.currentIndex = nextIndex;
    const targetIndex = state.matches[nextIndex];
    const count = document.getElementById(`${prefix()}local-search-count`);
    if (count) count.textContent = `${nextIndex + 1}/${state.matches.length}`;
    // Every player list is append-only now. Local search navigates within the
    // loaded list instead of restoring the old page replacement flow.
    config.renderCallback?.();
    scrollToMatch(targetIndex);
}

function toggleFilter(): void {
    const filter = document.getElementById(`${prefix()}local-search-filter`) as HTMLInputElement | null;
    state.onlyShowMatches = !!filter?.checked;
    if (state.active && state.currentIndex !== -1) {
        // Filtering also keeps the current append-only list in place.
        config.renderCallback?.();
        if (state.currentIndex !== -1) setTimeout(() => scrollToMatch(state.matches[state.currentIndex]), 50);
        return;
    }
    config.renderCallback?.();
    if (state.currentIndex !== -1) setTimeout(() => scrollToMatch(state.matches[state.currentIndex]), 50);
}

const listSearch = {
    state,
    config,
    init(id: string, nextConfig: Partial<ListSearchConfig>) {
        state.id = id;
        Object.assign(config, {
            renderCallback: null,
            paginationCallback: null,
            getList: null,
            getCurrentPage: null,
            itemsPerPage: 20,
        }, nextConfig);
        resetState();
    },
    resetState,
    toggleBar,
    handleSearch,
    navigate,
    handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            navigate(1);
        }
    },
    toggleFilter,
    scrollToMatch,
    getDisplayList(originalList: any[]) {
        if (!state.active || !state.onlyShowMatches) return originalList.map((item, originalIndex) => ({ item, originalIndex }));
        return originalList.map((item, originalIndex) => ({ item, originalIndex }))
            .filter(({ originalIndex }) => state.matches.includes(originalIndex));
    },
    isMatched: (index: number) => state.active && state.matches.includes(index),
    isCurrentMatch: (index: number) => state.active && state.matches[state.currentIndex] === index,
};

(window as any).ListSearch = listSearch;
export { listSearch };
