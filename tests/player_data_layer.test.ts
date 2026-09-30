import { describe, expect, it } from 'bun:test'
import { ApiRequestError, clearRequestCache, invalidateRequestCache, requestCacheKeys, requestJson } from '../frontend/player/src/react/data/request'
import { parsePlayerHash, serializePlayerHash } from '../frontend/player/src/react/route_state'
import { scopedStorageKey, setSessionScope } from '../frontend/player/src/react/session'
import { usePlaybackStore } from '../frontend/player/src/react/store/playback'
import { useSettingsStore } from '../frontend/player/src/react/store/settings'
import { useAuthStore } from '../frontend/player/src/react/store/auth'
import { selectLoveList, selectUserLists, useLibraryStore } from '../frontend/player/src/react/store/library'
import { useMediaLibraryStore } from '../frontend/player/src/react/store/media_library'

describe('React player data request lifecycle', () => {
  it('deduplicates concurrent reads and serves a short-lived cache', async () => {
    clearRequestCache()
    let calls = 0
    const fetcher: typeof fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({ value: calls }), { status: 200 })
    }
    const [first, second] = await Promise.all([
      requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher }),
      requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher }),
    ])
    expect(calls).toBe(1)
    expect(first).toEqual({ value: 1 })
    expect(await requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher })).toEqual({ value: 1 })
    expect(calls).toBe(1)
    invalidateRequestCache('test:dedupe')
    expect(await requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher })).toEqual({ value: 2 })
    expect(second).toEqual({ value: 1 })
  })

  it('bounds cached search results and evicts expired entries from unrelated keys', async () => {
    clearRequestCache()
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    const fetcher: typeof fetch = async input => new Response(JSON.stringify({ input: String(input) }))
    try {
      for (let index = 0; index < 128; index += 1) {
        await requestJson(`/search/${index}`, { cacheKey: `bounded:${index}`, cacheTtlMs: 1000, fetcher })
      }
      await requestJson('/search/0', { cacheKey: 'bounded:0', cacheTtlMs: 1000, fetcher })
      await requestJson('/search/new', { cacheKey: 'bounded:new', cacheTtlMs: 1000, fetcher })
      const keys = requestCacheKeys()
      expect(keys).toHaveLength(128)
      expect(keys.some(key => key.startsWith('bounded:0@'))).toBe(true)
      expect(keys.some(key => key.startsWith('bounded:1@'))).toBe(false)
      now += 1001
      await requestJson('/search/fresh', { cacheKey: 'bounded:fresh', cacheTtlMs: 1000, fetcher })
      expect(requestCacheKeys()).toHaveLength(1)
      expect(requestCacheKeys()[0]).toStartWith('bounded:fresh@')
    } finally {
      Date.now = originalNow
      clearRequestCache()
    }
  })

  it('does not cache an invalidated response when its fetcher ignores abort', async () => {
    clearRequestCache()
    let resolveOld: ((response: Response) => void) | undefined
    const staleFetcher: typeof fetch = () => new Promise(resolve => { resolveOld = resolve })
    const oldRequest = requestJson('/search', { cacheKey: 'stale:search', cacheTtlMs: 1000, fetcher: staleFetcher })
    invalidateRequestCache('stale:')
    await requestJson('/search', { cacheKey: 'stale:search', cacheTtlMs: 1000, fetcher: async () => new Response('{"version":"fresh"}') })
    resolveOld?.(new Response('{"version":"stale"}'))
    await oldRequest
    expect(await requestJson('/search', { cacheKey: 'stale:search', cacheTtlMs: 1000, fetcher: staleFetcher })).toEqual({ version: 'fresh' })
    clearRequestCache()
  })

  it('keeps a forced refresh when an older read completes later', async () => {
    clearRequestCache()
    let resolveOld: ((response: Response) => void) | undefined
    const staleFetcher: typeof fetch = () => new Promise(resolve => { resolveOld = resolve })
    const oldRequest = requestJson('/search', { cacheKey: 'forced:search', cacheTtlMs: 1000, fetcher: staleFetcher })
    await requestJson('/search', { cacheKey: 'forced:search', cacheTtlMs: 1000, force: true, fetcher: async () => new Response('{"version":"fresh"}') })
    resolveOld?.(new Response('{"version":"stale"}'))
    await oldRequest
    expect(await requestJson('/search', { cacheKey: 'forced:search', cacheTtlMs: 1000, fetcher: staleFetcher })).toEqual({ version: 'fresh' })
    clearRequestCache()
  })

  it('rejects only the cancelled caller and exposes typed API errors', async () => {
    clearRequestCache()
    let resolveResponse: ((response: Response) => void) | undefined
    const fetcher: typeof fetch = () => new Promise(resolve => { resolveResponse = resolve })
    const controller = new AbortController()
    const pending = requestJson('/api/abort', { signal: controller.signal, fetcher })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resolveResponse?.(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const errorFetcher: typeof fetch = async () => new Response('需要登录', { status: 401 })
    await expect(requestJson('/api/private', { fetcher: errorFetcher })).rejects.toBeInstanceOf(ApiRequestError)
    try {
      await requestJson('/api/private', { fetcher: errorFetcher })
    } catch (error) {
      expect(error).toMatchObject({ status: 401, endpoint: '/api/private' })
    }
  })

  it('cancels invalidated in-flight reads before they can repopulate the cache', async () => {
    clearRequestCache()
    let calls = 0
    const fetcher: typeof fetch = (_input, init) => {
      calls += 1
      if (calls === 1) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
        })
      }
      return Promise.resolve(new Response(JSON.stringify({ fresh: true }), { status: 200 }))
    }
    const first = requestJson('/api/private-library', { cacheKey: 'auth:library', cacheTtlMs: 10_000, fetcher })
    const second = requestJson('/api/private-library', { cacheKey: 'auth:library', cacheTtlMs: 10_000, fetcher })
    invalidateRequestCache('auth:')
    const results = await Promise.allSettled([first, second])
    expect(results.every(result => result.status === 'rejected' && (result.reason as { name?: string }).name === 'AbortError')).toBe(true)
    expect(await requestJson<{ fresh: boolean }>('/api/private-library', { cacheKey: 'auth:library', cacheTtlMs: 10_000, fetcher })).toEqual({ fresh: true })
    expect(calls).toBe(2)
  })
})

describe('React player URL state boundary', () => {
  it('keeps hash parsing and serialization independent from UI state', () => {
    expect(parsePlayerHash('#favorites')).toEqual({ tab: 'favorites', listId: 'love' })
    expect(parsePlayerHash('#favorites?listId=playlist%201')).toEqual({ tab: 'favorites', listId: 'playlist 1' })
    expect(parsePlayerHash('#%E0%A4%A')).toEqual({ tab: 'home', listId: 'love' })
    expect(serializePlayerHash({ tab: 'favorites', listId: 'playlist 1' })).toBe('#favorites?listId=playlist%201')
    expect(serializePlayerHash({ tab: 'favorites', listId: 'love' })).toBe('#favorites')
  })
})

describe('React player library persistence guard', () => {
  it('shows local favorites and playlists newest first while preserving source playlist order', () => {
    const loveList = [{ id: 'love-old' }, { id: 'love-new' }]
    const userList = [
      { id: 'local-list', name: '本地歌单', list: [{ id: 'local-old' }, { id: 'local-new' }] },
      { id: 'online-list', name: '在线歌单', source: 'wy', sourceListId: '123', list: [{ id: 'online-first' }, { id: 'online-second' }] },
    ]
    const state = { ...useLibraryStore.getState(), data: { defaultList: [], loveList, userList } }

    const visibleLoveList = selectLoveList(state)
    const visibleUserLists = selectUserLists(state)
    expect(visibleLoveList.map(song => song.id)).toEqual(['love-new', 'love-old'])
    expect(visibleUserLists[0]?.list?.map(song => song.id)).toEqual(['local-new', 'local-old'])
    expect(visibleUserLists[1]?.list?.map(song => song.id)).toEqual(['online-first', 'online-second'])
    expect(selectLoveList(state)).toBe(visibleLoveList)
    expect(selectUserLists(state)).toBe(visibleUserLists)
    expect(loveList.map(song => song.id)).toEqual(['love-old', 'love-new'])
    expect(userList[0]?.list?.map(song => song.id)).toEqual(['local-old', 'local-new'])
  })

  it('keeps existing playlist data active during a background refresh', async () => {
    clearRequestCache()
    const originalFetch = globalThis.fetch
    const existing = {
      defaultList: [],
      loveList: [{ id: 'song-1', name: '已收藏歌曲', singer: '歌手', source: 'wy' }],
      userList: [{ id: 'old-list', name: '旧歌单', list: [] }],
    }
    let resolveResponse: ((response: Response) => void) | undefined
    globalThis.fetch = ((_input, init) => new Promise<Response>((resolve, reject) => {
      resolveResponse = resolve
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
    })) as typeof fetch

    useLibraryStore.setState({ data: existing, loading: false, refreshing: false, error: '', loadedAt: Date.now() })
    try {
      const refreshing = useLibraryStore.getState().hydrate({ force: true })
      expect(useLibraryStore.getState()).toMatchObject({ data: existing, loading: false, refreshing: true })
      resolveResponse?.(new Response(JSON.stringify(existing), { status: 200 }))
      await refreshing
      expect(useLibraryStore.getState()).toMatchObject({ loading: false, refreshing: false, error: '' })
    } finally {
      globalThis.fetch = originalFetch
      clearRequestCache()
      useLibraryStore.getState().reset()
    }
  })

  it('creates playlists incrementally without sending stale favorites or unrelated lists', async () => {
    clearRequestCache()
    const originalFetch = globalThis.fetch
    const existing = { defaultList: [], loveList: [{ id: 'song-1' }], userList: [{ id: 'old-list', name: '旧歌单', list: [] }] }
    const mutations: any[] = []
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'POST') {
        const mutation = JSON.parse(String(init.body))
        mutations.push(mutation)
        existing.userList.push(mutation.playlist)
        return Response.json({ success: true, added: true })
      }
      return Response.json(existing)
    }) as typeof fetch
    useLibraryStore.setState({ data: { defaultList: [], loveList: [], userList: [] }, loading: false, loadedAt: 0 })
    try {
      await Promise.all([
        useLibraryStore.getState().createList('first', 'cloud-rain'),
        useLibraryStore.getState().createList('second'),
      ])
      expect(mutations).toHaveLength(2)
      expect(mutations[0]).toMatchObject({ action: 'create', playlist: { name: 'first', icon: 'cloud-rain' } })
      expect(mutations.every(mutation => !('loveList' in mutation) && !('userList' in mutation))).toBe(true)
      expect(existing.userList.map(list => list.name)).toEqual(['旧歌单', 'first', 'second'])
      expect(existing.loveList).toEqual([{ id: 'song-1' }])
    } finally {
      globalThis.fetch = originalFetch
      clearRequestCache()
      useLibraryStore.getState().reset()
    }
  })

})

describe('React player media library refresh', () => {
  it('keeps existing albums and artists available during a background refresh', async () => {
    clearRequestCache()
    const originalFetch = globalThis.fetch
    const existingAlbums = [{ id: 'album-1', name: '专辑', source: 'wy' }]
    const existingArtists = [{ id: 'artist-1', name: '歌手', source: 'wy' }]
    const resolvers: Array<(response: Response) => void> = []
    globalThis.fetch = ((_input, init) => new Promise<Response>((resolve, reject) => {
      resolvers.push(resolve)
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
    })) as typeof fetch

    useMediaLibraryStore.setState({ albums: existingAlbums, artists: existingArtists, loading: false, refreshing: false, error: '', loadedAt: Date.now() })
    try {
      const refreshing = useMediaLibraryStore.getState().hydrate({ force: true })
      expect(useMediaLibraryStore.getState()).toMatchObject({ albums: existingAlbums, artists: existingArtists, loading: false, refreshing: true })
      for (const resolve of resolvers) resolve(new Response(JSON.stringify([]), { status: 200 }))
      await refreshing
      expect(useMediaLibraryStore.getState()).toMatchObject({ albums: [], artists: [], loading: false, refreshing: false, error: '' })
    } finally {
      globalThis.fetch = originalFetch
      clearRequestCache()
      useMediaLibraryStore.getState().reset()
    }
  })
})

describe('React player authentication lifecycle', () => {
  it('does not run the initial session reset twice under StrictMode', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async input => {
      const endpoint = String(input)
      calls.push(endpoint)
      await Promise.resolve()
      if (endpoint === '/api/music/config') {
        return new Response(JSON.stringify({ 'player.enableAuth': false }), { status: 200 })
      }
      if (endpoint === '/api/music/auth/verify') return new Response(JSON.stringify({ valid: true }), { status: 200 })
      if (endpoint === '/api/user/auth/verify') {
        return new Response(JSON.stringify({ valid: true, username: 'test-user' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    try {
      useAuthStore.setState({ checking: true, error: '', userName: null, userAuthenticated: false })
      const first = useAuthStore.getState().hydrate()
      const second = useAuthStore.getState().hydrate()
      expect(second).toBe(first)
      await Promise.all([first, second])
      expect(calls).toEqual(['/api/music/config', '/api/music/auth/verify', '/api/user/auth/verify'])
      expect(useAuthStore.getState().userName).toBe('test-user')
    } finally {
      globalThis.fetch = originalFetch
      setSessionScope(null)
      useAuthStore.setState({ checking: true, error: '', userName: null, userAuthenticated: false })
    }
  })
})


describe('React player settings reset', () => {
  it('preserves an account playback snapshot until hydration restores its song, queue and progress', () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map<string, string>()
    const storage = {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key) },
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
    } as Storage
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    setSessionScope('settings-reset-test')
    const song = { source: 'wy', songmid: 'restored-song', name: '恢复歌曲' }
    const saved = JSON.stringify({ song, index: 0, time: 42, playlist: [song], quality: '320k' })
    const key = scopedStorageKey('lx_playback_state')
    values.set(key, saved)
    try {
      usePlaybackStore.getState().reset()
      useSettingsStore.getState().reset()
      expect(values.get(key)).toBe(saved)
      usePlaybackStore.getState().hydrate()
      expect(usePlaybackStore.getState()).toMatchObject({ currentSong: song, currentIndex: 0, currentTime: 42, queue: [song], quality: '320k' })
    } finally {
      usePlaybackStore.getState().reset()
      setSessionScope(null)
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
})
