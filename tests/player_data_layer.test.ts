import { describe, expect, it, spyOn } from 'bun:test'
import { playerApi } from '../frontend/player/src/react/api'
import {
  ApiRequestError,
  clearRequestCache,
  invalidateRequestCache,
  requestCacheKeys,
  requestJson,
} from '../frontend/player/src/react/data/request'
import { parsePlayerHash, serializePlayerHash } from '../frontend/player/src/react/route_state'
import { scopedStorageKey, setSessionScope } from '../frontend/player/src/react/session'
import { usePlaybackStore } from '../frontend/player/src/react/store/playback'
import { useSettingsStore } from '../frontend/player/src/react/store/settings'
import { useAuthStore } from '../frontend/player/src/react/store/auth'
import { selectLoveList, selectUserLists, useLibraryStore } from '../frontend/player/src/react/store/library'
import { useSearchStore } from '../frontend/player/src/react/store/search'
import { useMediaLibraryStore } from '../frontend/player/src/react/store/media_library'
import type { Song } from '../frontend/player/src/react/types'

const mockFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
  Object.assign(handler, { preconnect: () => Promise.resolve() })

describe('React player data request lifecycle', () => {
  it('deduplicates concurrent reads and serves a short-lived cache', async () => {
    clearRequestCache()
    let calls = 0
    const fetcher: typeof fetch = mockFetch(async () => {
      calls += 1
      return new Response(JSON.stringify({ value: calls }), { status: 200 })
    })
    const [first, second] = await Promise.all([
      requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher }),
      requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher }),
    ])
    expect(calls).toBe(1)
    expect(first).toEqual({ value: 1 })
    expect(
      await requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher }),
    ).toEqual({ value: 1 })
    expect(calls).toBe(1)
    invalidateRequestCache('test:dedupe')
    expect(
      await requestJson<{ value: number }>('/api/test', { cacheKey: 'test:dedupe', cacheTtlMs: 10_000, fetcher }),
    ).toEqual({ value: 2 })
    expect(second).toEqual({ value: 1 })
  })

  it('bounds cached search results and evicts expired entries from unrelated keys', async () => {
    clearRequestCache()
    const originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    const fetcher: typeof fetch = mockFetch(async input => new Response(JSON.stringify({ input: String(input) })))
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
    const staleFetcher: typeof fetch = mockFetch(
      () =>
        new Promise<Response>(resolve => {
          resolveOld = resolve
        }),
    )
    const oldRequest = requestJson('/search', { cacheKey: 'stale:search', cacheTtlMs: 1000, fetcher: staleFetcher })
    invalidateRequestCache('stale:')
    await requestJson<{ version: string }>('/search', {
      cacheKey: 'stale:search',
      cacheTtlMs: 1000,
      fetcher: mockFetch(async () => new Response('{"version":"fresh"}')),
    })
    resolveOld?.(new Response('{"version":"stale"}'))
    await oldRequest
    expect(
      await requestJson<{ version: string }>('/search', {
        cacheKey: 'stale:search',
        cacheTtlMs: 1000,
        fetcher: staleFetcher,
      }),
    ).toEqual({ version: 'fresh' })
    clearRequestCache()
  })

  it('keeps a forced refresh when an older read completes later', async () => {
    clearRequestCache()
    let resolveOld: ((response: Response) => void) | undefined
    const staleFetcher: typeof fetch = mockFetch(
      () =>
        new Promise<Response>(resolve => {
          resolveOld = resolve
        }),
    )
    const oldRequest = requestJson('/search', { cacheKey: 'forced:search', cacheTtlMs: 1000, fetcher: staleFetcher })
    await requestJson<{ version: string }>('/search', {
      cacheKey: 'forced:search',
      cacheTtlMs: 1000,
      force: true,
      fetcher: mockFetch(async () => new Response('{"version":"fresh"}')),
    })
    resolveOld?.(new Response('{"version":"stale"}'))
    await oldRequest
    expect(
      await requestJson<{ version: string }>('/search', {
        cacheKey: 'forced:search',
        cacheTtlMs: 1000,
        fetcher: staleFetcher,
      }),
    ).toEqual({ version: 'fresh' })
    clearRequestCache()
  })

  it('rejects only the cancelled caller and exposes typed API errors', async () => {
    clearRequestCache()
    let resolveResponse: ((response: Response) => void) | undefined
    const fetcher: typeof fetch = mockFetch(
      () =>
        new Promise<Response>(resolve => {
          resolveResponse = resolve
        }),
    )
    const controller = new AbortController()
    const pending = requestJson('/api/abort', { signal: controller.signal, fetcher })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resolveResponse?.(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const errorFetcher: typeof fetch = mockFetch(async () => new Response('需要登录', { status: 401 }))
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
    const fetcher: typeof fetch = mockFetch((_input, init) => {
      calls += 1
      if (calls === 1) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true },
          )
        })
      }
      return Promise.resolve(new Response(JSON.stringify({ fresh: true }), { status: 200 }))
    })
    const first = requestJson('/api/private-library', { cacheKey: 'auth:library', cacheTtlMs: 10_000, fetcher })
    const second = requestJson('/api/private-library', { cacheKey: 'auth:library', cacheTtlMs: 10_000, fetcher })
    invalidateRequestCache('auth:')
    const results = await Promise.allSettled([first, second])
    expect(
      results.every(
        result => result.status === 'rejected' && (result.reason as { name?: string }).name === 'AbortError',
      ),
    ).toBe(true)
    expect(
      await requestJson<{ fresh: boolean }>('/api/private-library', {
        cacheKey: 'auth:library',
        cacheTtlMs: 10_000,
        fetcher,
      }),
    ).toEqual({ fresh: true })
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

describe('React player search state', () => {
  it('clears stale results and page state when the query changes during a search', async () => {
    const initial = useSearchStore.getState()
    const staleSong = { id: 'old', name: '旧结果', source: 'wy' }
    let resolveSearch: ((songs: Song[]) => void) | undefined
    const search = spyOn(playerApi, 'search').mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSearch = resolve
        }),
    )
    useSearchStore.setState({
      query: '旧关键词',
      page: 3,
      results: [staleSong],
      loading: false,
      refreshing: false,
      error: '',
      loadedAt: Date.now(),
    })
    try {
      const pending = useSearchStore.getState().search('旧关键词', 3)
      useSearchStore.getState().setQuery('新关键词')
      expect(useSearchStore.getState()).toMatchObject({
        query: '新关键词',
        page: 1,
        results: [],
        loading: false,
        refreshing: false,
        error: '',
      })

      expect(resolveSearch).toBeDefined()
      resolveSearch?.([{ id: 'stale', name: '迟到的旧结果', source: 'wy' }])
      await pending
      expect(useSearchStore.getState()).toMatchObject({ query: '新关键词', page: 1, results: [], loading: false })
    } finally {
      search.mockRestore()
      useSearchStore.getState().invalidate()
      useSearchStore.setState(initial)
    }
  })
})

describe('React player library persistence guard', () => {
  it('discards queued mutations and late completions after switching accounts', async () => {
    let release: (() => void) | undefined
    const add = spyOn(playerApi, 'addToList').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )
    const hydrate = spyOn(playerApi, 'listData').mockResolvedValue({ loveList: [] })
    setSessionScope('library-alice')
    useLibraryStore.getState().reset()
    try {
      const first = useLibraryStore.getState().addSong('love', { id: 'alice-first', source: 'wy' })
      const queued = useLibraryStore.getState().addSong('love', { id: 'alice-queued', source: 'wy' })
      const queuedResult = queued.catch(error => error)
      await Promise.resolve()
      expect(add).toHaveBeenCalledTimes(1)
      setSessionScope('library-bob')
      useLibraryStore.getState().reset()
      const bobData = { loveList: [{ id: 'bob-song', source: 'wy' }] }
      useLibraryStore.setState({ data: bobData })
      release?.()
      await first
      expect(await queuedResult).toBeInstanceOf(Error)
      expect(add).toHaveBeenCalledTimes(1)
      expect(hydrate).not.toHaveBeenCalled()
      expect(useLibraryStore.getState().data).toBe(bobData)
    } finally {
      add.mockRestore()
      hydrate.mockRestore()
      useLibraryStore.getState().reset()
      setSessionScope(null)
    }
  })

  it('shows local favorites and playlists newest first while preserving source playlist order', () => {
    const loveList = [{ id: 'love-old' }, { id: 'love-new' }]
    const userList = [
      { id: 'local-list', name: '本地歌单', list: [{ id: 'local-old' }, { id: 'local-new' }] },
      {
        id: 'online-list',
        name: '在线歌单',
        source: 'wy',
        sourceListId: '123',
        list: [{ id: 'online-first' }, { id: 'online-second' }],
      },
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
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((resolve, reject) => {
        resolveResponse = resolve
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        )
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
    const existing = {
      defaultList: [],
      loveList: [{ id: 'song-1' }],
      userList: [{ id: 'old-list', name: '旧歌单', list: [] }],
    }
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

  it('serializes same-list mutations and rolls back only the failed mutation', async () => {
    const initial = useLibraryStore.getState()
    const existingSong = { id: 'keep', songmid: 'keep', name: '保留歌曲', singer: '歌手', source: 'wy' }
    const addedSong = { id: 'add', songmid: 'add', name: '待添加歌曲', singer: '歌手', source: 'wy' }
    let rejectAdd: ((error: Error) => void) | undefined
    let rejectRemove: ((error: Error) => void) | undefined
    let notifyRemoveStarted: (() => void) | undefined
    const removeStarted = new Promise<void>(resolve => {
      notifyRemoveStarted = resolve
    })
    const add = spyOn(playerApi, 'addToList').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdd = reject
        }),
    )
    const remove = spyOn(playerApi, 'removeFromList').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRemove = reject
          notifyRemoveStarted?.()
        }),
    )
    useLibraryStore.setState({
      data: { defaultList: [], loveList: [existingSong], userList: [] },
      loading: false,
      refreshing: false,
      error: '',
      loadedAt: Date.now(),
    })
    try {
      const adding = useLibraryStore.getState().addSong('love', addedSong)
      const removing = useLibraryStore.getState().removeSong('love', existingSong)
      const addingResult = adding.then(
        () => null,
        error => (error instanceof Error ? error.message : String(error)),
      )
      const removingResult = removing.then(
        () => null,
        error => (error instanceof Error ? error.message : String(error)),
      )
      await Promise.resolve()
      expect(add).toHaveBeenCalledTimes(1)
      expect(remove).not.toHaveBeenCalled()
      rejectAdd?.(new Error('添加失败'))
      await removeStarted
      rejectRemove?.(new Error('移除失败'))
      expect(await addingResult).toBe('添加失败')
      expect(await removingResult).toBe('移除失败')
      expect(useLibraryStore.getState().data.loveList).toEqual([existingSong])
    } finally {
      add.mockRestore()
      remove.mockRestore()
      useLibraryStore.getState().reset()
      useLibraryStore.setState(initial)
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
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((resolve, reject) => {
        resolvers.push(resolve)
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        )
      })) as typeof fetch

    useMediaLibraryStore.setState({
      albums: existingAlbums,
      artists: existingArtists,
      loading: false,
      refreshing: false,
      error: '',
      loadedAt: Date.now(),
    })
    try {
      const refreshing = useMediaLibraryStore.getState().hydrate({ force: true })
      expect(useMediaLibraryStore.getState()).toMatchObject({
        albums: existingAlbums,
        artists: existingArtists,
        loading: false,
        refreshing: true,
      })
      for (const resolve of resolvers) resolve(new Response(JSON.stringify([]), { status: 200 }))
      await refreshing
      expect(useMediaLibraryStore.getState()).toMatchObject({
        albums: [],
        artists: [],
        loading: false,
        refreshing: false,
        error: '',
      })
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
  it('applies a changed preferred quality to subsequent playback immediately', async () => {
    const save = spyOn(playerApi, 'saveSettings').mockResolvedValue(undefined)
    const previousSettings = useSettingsStore.getState().settings
    const previousPlayback = usePlaybackStore.getState()
    try {
      usePlaybackStore.setState({ quality: 'flac' })
      useSettingsStore.getState().setSetting('preferredQuality', '128k')
      usePlaybackStore.getState().playSong({ id: 'quality-test', source: 'wy' })
      expect(usePlaybackStore.getState().quality).toBe('128k')
      expect(useSettingsStore.getState().settings.preferredQuality).toBe('128k')
      expect(save).toHaveBeenCalledWith({ preferredQuality: '128k' })
    } finally {
      save.mockRestore()
      useSettingsStore.setState({ settings: previousSettings })
      usePlaybackStore.setState(previousPlayback)
    }
  })

  it('preserves an account playback snapshot until hydration restores its song, queue and progress', () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map<string, string>()
    const storage = {
      get length() {
        return values.size
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => {
        values.delete(key)
      },
      setItem: (key: string, value: string) => {
        values.set(key, String(value))
      },
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
      expect(usePlaybackStore.getState()).toMatchObject({
        currentSong: song,
        currentIndex: 0,
        currentTime: 42,
        queue: [song],
        quality: '320k',
      })
    } finally {
      usePlaybackStore.getState().reset()
      setSessionScope(null)
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('keeps the current song and relative index in the persisted window for long queues', async () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousPlayback = usePlaybackStore.getState()
    const values = new Map<string, string>()
    const storage = {
      get length() {
        return values.size
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => {
        values.delete(key)
      },
      setItem: (key: string, value: string) => {
        values.set(key, String(value))
      },
    } as Storage
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        requestIdleCallback: (callback: () => void) => {
          queueMicrotask(callback)
          return 1
        },
        cancelIdleCallback: () => undefined,
      },
    })
    setSessionScope('long-queue-persistence-test')
    let now = Date.now() + 100_000
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const storageKey = scopedStorageKey('lx_playback_state')
    const cases = [
      { queueLength: 301, currentIndex: 300, expectedIndex: 299 },
      { queueLength: 1000, currentIndex: 850, expectedIndex: 150 },
    ]
    try {
      for (const { queueLength, currentIndex, expectedIndex } of cases) {
        now += 6000
        const queue = Array.from({ length: queueLength }, (_, index) => ({
          source: 'wy',
          songmid: `queue-${index}`,
          name: `歌曲 ${index}`,
        }))
        const currentSong = queue[currentIndex]!
        usePlaybackStore.setState({ queue, currentIndex, currentSong, currentTime: 0 })
        usePlaybackStore.getState().setProgress(42, 120)
        await Promise.resolve()

        const saved = JSON.parse(values.get(storageKey)!) as {
          song: Song
          index: number
          playlist: Song[]
        }
        expect(saved.playlist).toHaveLength(300)
        expect(saved.index).toBe(expectedIndex)
        expect(saved.playlist[saved.index]?.songmid).toBe(currentSong.songmid)
        expect(saved.song.songmid).toBe(currentSong.songmid)

        usePlaybackStore.getState().reset()
        usePlaybackStore.getState().hydrate()
        const restored = usePlaybackStore.getState()
        expect(restored.queue).toHaveLength(300)
        expect(restored.currentIndex).toBe(expectedIndex)
        expect(restored.currentSong?.songmid).toBe(currentSong.songmid)
        expect(restored.queue[restored.currentIndex]?.songmid).toBe(restored.currentSong?.songmid)
        expect(restored.currentTime).toBe(42)
      }
    } finally {
      clock.mockRestore()
      usePlaybackStore.setState(previousPlayback)
      setSessionScope(null)
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
})
