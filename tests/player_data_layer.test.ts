import { describe, expect, it } from 'bun:test'
import { ApiRequestError, clearRequestCache, invalidateRequestCache, requestJson } from '../frontend/player/src/react/data/request'
import { parsePlayerHash, serializePlayerHash } from '../frontend/player/src/react/route_state'
import { setSessionScope } from '../frontend/player/src/react/session'
import { useAuthStore } from '../frontend/player/src/react/store/auth'
import { useLibraryStore } from '../frontend/player/src/react/store/library'
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

  it('hydrates before a full playlist save can overwrite existing lists', async () => {
    clearRequestCache()
    const originalFetch = globalThis.fetch
    const existing = {
      defaultList: [],
      loveList: [{ id: 'song-1', name: '已收藏歌曲', singer: '歌手', source: 'wy' }],
      userList: [{ id: 'old-list', name: '旧歌单', list: [] }],
    }
    let getCount = 0
    let saved: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      if (String(init?.method || 'GET').toUpperCase() === 'POST') {
        saved = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      getCount += 1
      const payload = getCount > 1 && saved ? saved : existing
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as typeof fetch

    useLibraryStore.setState({
      data: { defaultList: [], loveList: [], userList: [] },
      loading: true,
      refreshing: false,
      error: '',
      loadedAt: 0,
    })
    try {
      await useLibraryStore.getState().createList('新歌单', 'cloud-rain')
      expect(saved).toMatchObject({
        loveList: existing.loveList,
        userList: [existing.userList[0], { name: '新歌单', icon: 'cloud-rain', list: [] }],
      })
      expect(getCount).toBe(2)
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
