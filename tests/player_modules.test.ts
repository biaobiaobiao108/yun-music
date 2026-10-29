import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { parseLyric } from '../frontend/player/src/react/api'
import { buildSongMatchSet, sameSong, songKey, songListId, songMatchSetHas } from '../frontend/player/src/react/types'
import { buildPlaybackUrl, normalizeCachePlaybackUrl } from '../frontend/player/src/react/media_url'
import { connectAudioCommands, normalizePlayHistory, usePlaybackStore } from '../frontend/player/src/react/store'
import { getSessionScope, scopedStorageKey, setSessionScope } from '../frontend/player/src/react/session'
import { songEntityDetail, songEntityId, songEntityName } from '../frontend/player/src/react/song_details'
import type { Song } from '../frontend/player/src/react/types'

const root = path.join(import.meta.dir, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n')

describe('React player module boundaries', () => {
  it('publishes separate React player and login entries', () => {
    const playerHtml = read('public/music/index.html')
    const loginHtml = read('public/music/login.html')
    expect(playerHtml).toContain('<div id="root"></div>')
    expect(playerHtml).toContain('type="module" src="app-')
    expect(loginHtml).toContain('type="module" src="login-')
    expect(playerHtml).not.toContain('songlist_manager.js')
    expect(playerHtml).not.toContain('download_manager.js')
    expect(playerHtml).not.toContain('data-event-click-action')
    expect(loginHtml).not.toContain('onsubmit=')
  })

  it('does not expose UI actions through window and preserves runtime-only access', () => {
    const files = [
      'frontend/player/src/react/index.tsx',
      'frontend/player/src/react/login.tsx',
      'frontend/player/src/react/shell.tsx',
      'frontend/player/src/react/views.tsx',
      'frontend/player/src/react/store.ts',
      'frontend/player/src/react/store/playback.ts',
      'frontend/player/src/react/store/library.ts',
      'frontend/player/src/react/store/ui.ts',
      'frontend/player/src/react/api.ts',
    ]
    const source = files.map(read).join('\n')
    expect(source).toContain("from 'zustand'")
    expect(source).toContain('lx_settings')
    expect(source).toContain('lx_playback_state')
    expect(source).toContain('lx_volume')
    expect(source).toContain('lx_play_mode')
    expect(source).not.toMatch(/window\.(?:toggle|play|pause|set|current|selected|app)\w*\s*=/)
    expect(source).not.toContain('data-event-click-action')
  })

  it('keeps URL/lyric parsing and source identity type-safe', () => {
    const song = { source: 'wy', songmid: 12345, name: '测试' }
    expect(songKey(song)).toBe('wy:12345')
    expect(songListId({ id: 'wy_12345', songmid: 12345 })).toBe('wy_12345')
    expect(songListId({ songmid: 12345 })).toBe('12345')
    expect(sameSong({ source: 'wy', id: 12345 }, { source: 'wy', songmid: '12345' })).toBe(true)
    expect(sameSong({ source: 'wy', id: 12345 }, { source: 'tx', songmid: '12345' })).toBe(false)
    const matchSet = buildSongMatchSet([
      { source: 'wy', id: 12345 },
      { source: '', id: 'legacy_only' },
    ])
    expect(songMatchSetHas(matchSet, { source: 'wy', songmid: '12345' })).toBe(true)
    expect(songMatchSetHas(matchSet, { source: 'tx', songmid: '12345' })).toBe(false)
    expect(songMatchSetHas(matchSet, { source: 'wy', id: 'legacy_only' })).toBe(true)
    expect(songMatchSetHas(matchSet, { source: 'other', id: 'not_found' })).toBe(false)
    const lines = parseLyric({ lyric: '[00:01.20]第一句\n[00:03.50]第二句', tlyric: '[00:01.20]translation' })
    expect(lines).toEqual([
      { time: 1.2, text: '第一句', translation: 'translation' },
      { time: 3.5, text: '第二句', translation: undefined },
    ])
    expect(
      parseLyric({ data: { lrc: { lyric: '[00:00.50]嵌套歌词' }, tlyric: { lyric: '[00:00.50]nested translation' } } }),
    ).toEqual([{ time: 0.5, text: '嵌套歌词', translation: 'nested translation' }])
    expect(parseLyric({ lyric: '[00:00.0]作词: Someone\n[00:01.0]真正的歌词' })).toEqual([
      { time: 1, text: '真正的歌词', translation: undefined },
    ])
    expect(
      parseLyric({
        lyric: '[00:01.00]hello world',
        lxlyric: '[00:01.00]<0,500,0>hello <500,750>world',
      }),
    ).toEqual([
      {
        time: 1,
        text: 'hello world',
        translation: undefined,
        words: '<0,500,0>hello <500,750>world',
        timedWords: [
          { text: 'hello ', time: 1, duration: 0.5 },
          { text: 'world', time: 1.5, duration: 0.75 },
        ],
      },
    ])
    expect(
      parseLyric({
        yrc: '[1000,1600](1000,600,0)你好(1600,1000,0)世界',
      }),
    ).toEqual([
      {
        time: 1,
        text: '你好世界',
        translation: undefined,
        words: '(1000,600,0)你好(1600,1000,0)世界',
        timedWords: [
          { text: '你好', time: 1, duration: 0.6 },
          { text: '世界', time: 1.6, duration: 1 },
        ],
      },
    ])
    expect(parseLyric({ lyric: '[00:02.0]普通歌词', lxlyric: '[00:01.0]<bad>broken' })).toEqual([
      { time: 2, text: '普通歌词', translation: undefined },
    ])
    expect(
      parseLyric({
        lyric: '[00:01.00]第一行\n[00:01.20]第二行',
        klyric: '[00:01.00]没有逐字时间',
        lxlyric: '[00:01.05]<0,400>第一行\n[00:01.16]<0,400>第二行',
      }),
    ).toMatchObject([
      { text: '第一行', timedWords: [{ text: '第一行', time: 1.05, duration: 0.4 }] },
      { text: '第二行', timedWords: [{ text: '第二行', time: 1.16, duration: 0.4 }] },
    ])
    expect(
      parseLyric({
        lyric: '[00:01.00]第一句\n[00:03.00]第二句',
        lxlyric: '[00:01.30]<0,400>错开的歌词',
      }),
    ).toEqual([
      { time: 1, text: '第一句', translation: undefined },
      { time: 3, text: '第二句', translation: undefined },
    ])
    expect(
      parseLyric({
        lyric: '[00:10.00]第一行\n[00:10.50]第二行',
        lxlyric: '[00:10.08]<0,300>第一行\n[00:10.54]<0,300>第二行',
        tlyric: '[00:10.12]第一行翻译\n[00:10.62]第二行翻译',
        rlyric: '[00:10.14]first\n[00:10.64]second',
      }),
    ).toMatchObject([
      { text: '第一行', translation: '第一行翻译', roma: 'first' },
      { text: '第二行', translation: '第二行翻译', roma: 'second' },
    ])
    expect(
      parseLyric({
        lyric: '[00:20.00]准确行\n[00:20.20]近邻行',
        tlyric: '[00:19.90]偏移翻译\n[00:20.20]精确翻译',
      }),
    ).toMatchObject([
      { text: '准确行', translation: '偏移翻译' },
      { text: '近邻行', translation: '精确翻译' },
    ])
    expect(
      parseLyric({
        lyric: '[00:30.00]近译行\n[00:30.60]远译行',
        tlyric: '[00:30.20]唯一翻译',
      }),
    ).toMatchObject([
      { text: '近译行', translation: '唯一翻译' },
      { text: '远译行', translation: undefined },
    ])
    expect(
      parseLyric({
        lyric: '[00:40.00]超容差',
        tlyric: '[00:41.51]不要匹配',
      }),
    ).toMatchObject([{ text: '超容差', translation: undefined }])
    expect(
      parseLyric({
        lyric: '[00:10.00]Hello world\n[00:11.00]Next song',
        lxlyric: '[00:10.30]<0,300>Hello, world!\n[00:11.25]<0,300>next song',
        tlyric: '[00:10.00]第一句翻译\n[00:11.00]第二句翻译',
      }),
    ).toMatchObject([
      {
        time: 10.3,
        text: 'Hello world',
        translation: '第一句翻译',
        timedWords: [{ text: 'Hello, world!', time: 10.3 }],
      },
      { time: 11.25, text: 'Next song', translation: '第二句翻译', timedWords: [{ text: 'next song', time: 11.25 }] },
    ])
    const nearbyLines = parseLyric({
      lyric: '[00:30.00]相同歌词\n[00:30.80]相同歌词\n[00:31.60]相邻歌词',
      lxlyric: '[00:30.70]<0,500>相同 歌词\n[00:31.55]<0,500>相邻歌词',
    })
    expect(nearbyLines).toMatchObject([
      { time: 30, text: '相同歌词' },
      { time: 30.7, text: '相同歌词', timedWords: [{ text: '相同 歌词', time: 30.7 }] },
      { time: 31.55, text: '相邻歌词', timedWords: [{ text: '相邻歌词', time: 31.55 }] },
    ])
    expect(nearbyLines[0].timedWords).toBeUndefined()
  })

  it('resolves song action entities by their own ids and supports search fallback metadata', () => {
    const identified = {
      source: 'wy',
      songmid: 'song-1',
      singer: 'Aimer',
      artistId: 123,
      albumName: 'I beg you',
      albumId: 'album-9',
      name: '花の唄',
    }
    expect(songEntityId(identified, 'artist')).toBe('123')
    expect(songEntityId(identified, 'album')).toBe('album-9')
    expect(songEntityDetail(identified, 'artist')).toMatchObject({
      kind: 'artist',
      id: '123',
      source: 'wy',
      name: 'Aimer',
    })
    expect(songEntityDetail(identified, 'album')).toMatchObject({
      kind: 'album',
      id: 'album-9',
      source: 'wy',
      name: 'I beg you',
    })

    // External source records may carry nested artist and album entities even
    // though the normalized player Song shape uses a string singer.
    const sourceShaped = {
      source: 'tx',
      singer: [{ mid: 'artist-mid', name: '歌手' }],
      album: { mid: 'album-mid', name: '专辑' },
      name: '歌曲',
    } as unknown as Song
    expect(songEntityId(sourceShaped, 'artist')).toBe('artist-mid')
    expect(songEntityId(sourceShaped, 'album')).toBe('album-mid')

    const withoutIds = {
      source: 'tx',
      songmid: 'song-2',
      singer: '没有 ID 的歌手',
      albumName: '没有 ID 的专辑',
      name: '测试歌曲',
    }
    expect(songEntityDetail(withoutIds, 'artist')).toBeNull()
    expect(songEntityDetail(withoutIds, 'album')).toBeNull()
    expect(songEntityName(withoutIds, 'artist')).toBe('没有 ID 的歌手')
    expect(songEntityName(withoutIds, 'album')).toBe('没有 ID 的专辑')

    const libraryArtist = { id: 321, name: '媒体库歌手', img: '/artist.jpg' }
    expect(songEntityDetail(libraryArtist, 'artist', { allowGenericId: true, allowGenericName: true })).toMatchObject({
      kind: 'artist',
      id: '321',
      name: '媒体库歌手',
    })
    expect(songEntityDetail(libraryArtist, 'album')).toBeNull()
  })

  it('keeps private cache links playable and relays third-party source URLs', () => {
    const song = { source: 'wy', songmid: 'song-1', name: '测试歌曲', singer: '测试歌手' }
    expect(normalizeCachePlaybackUrl('/api/music/cache/file/test.mp3?folder=cache', 'steelway108')).toBe(
      '/api/music/cache/file/steelway108/test.mp3?folder=cache',
    )
    expect(normalizeCachePlaybackUrl('/api/music/cache/file/steelway108/test.mp3?folder=cache', 'steelway108')).toBe(
      '/api/music/cache/file/steelway108/test.mp3?folder=cache',
    )
    expect(buildPlaybackUrl('https://media.example.test/song.mp3', song, {}, 'http://localhost:9527')).toContain(
      '/api/music/download?url=https%3A%2F%2Fmedia.example.test%2Fsong.mp3',
    )
    expect(
      buildPlaybackUrl('http://localhost:9527/api/music/cache/file/_open/song.mp3', song, {}, 'http://localhost:9527'),
    ).toBe('http://localhost:9527/api/music/cache/file/_open/song.mp3')
  })

  it('keeps audio lifecycle lightweight and cache APIs isolated behind services', () => {
    const shell = read('frontend/player/src/react/shell.tsx')
    const audioRuntime = read('frontend/player/src/react/audio_runtime.tsx')
    const api = read('frontend/player/src/react/api.ts')
    expect(shell).toContain("import { AudioRuntime } from './audio_runtime'")
    expect(shell).toContain('<AudioRuntime />')
    expect(audioRuntime).toContain('preload="metadata"')
    expect(audioRuntime).toContain("removeAttribute('src')")
    expect(audioRuntime).toContain('navigator.mediaSession')
    expect(api).toContain("'/api/music/url'")
    expect(api).toContain("'/api/music/cache/queue'")
    expect(api).toContain("'/api/music/lyric'")
  })

  it('keeps recent playback compatible with the legacy play_history contract', () => {
    const items = Array.from({ length: 55 }, (_, index) => ({
      source: 'wy',
      songmid: String(index),
      name: `歌曲 ${index}`,
      playedAt: index,
    }))
    const normalized = normalizePlayHistory([
      items[54],
      ...items,
      { source: 'wy', songmid: '54', name: '重复歌曲', playedAt: 0 },
    ])
    expect(normalized).toHaveLength(50)
    expect(normalized[0]?.songmid).toBe('54')
    expect(normalized.at(-1)?.songmid).toBe('5')
    expect(new Set(normalized.map(item => songKey(item))).size).toBe(50)
  })

  it('scopes browser state keys to the active user session', () => {
    setSessionScope('alice')
    const aliceHistoryKey = scopedStorageKey('play_history')
    setSessionScope('bob')
    const bobHistoryKey = scopedStorageKey('play_history')

    expect(getSessionScope()).toBe('user:bob')
    expect(bobHistoryKey).not.toBe(aliceHistoryKey)
    expect(bobHistoryKey).toContain('bob')

    setSessionScope(null)
    expect(getSessionScope()).toBe('guest')
  })

  it('keeps queue state and audio transition synchronized when removing songs', () => {
    let pauseCalls = 0
    connectAudioCommands({
      play: () => undefined,
      pause: () => {
        pauseCalls += 1
      },
      seek: () => undefined,
      volume: () => undefined,
    })
    const first = { source: 'wy', songmid: 'queue-1', name: '第一首' }
    const second = { source: 'wy', songmid: 'queue-2', name: '第二首' }
    usePlaybackStore.setState({
      queue: [first, second],
      currentIndex: 0,
      currentSong: first,
      isPlaying: true,
      currentTime: 12,
      duration: 180,
    })
    usePlaybackStore.getState().removeFromQueue(0)
    expect(usePlaybackStore.getState()).toMatchObject({
      queue: [second],
      currentIndex: 0,
      currentSong: second,
      isPlaying: true,
    })
    usePlaybackStore.getState().removeFromQueue(0)
    expect(usePlaybackStore.getState()).toMatchObject({
      queue: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
    expect(pauseCalls).toBe(1)
  })

  it('clears playback queue and progress while preserving mode and quality', () => {
    let pauseCalls = 0
    connectAudioCommands({
      play: () => undefined,
      pause: () => {
        pauseCalls += 1
      },
      seek: () => undefined,
      volume: () => undefined,
    })
    const song = { source: 'wy', songmid: 'queue-clear', name: '清空测试' }
    usePlaybackStore.setState({
      queue: [song],
      currentIndex: 0,
      currentSong: song,
      priorityNextSongKey: songKey(song),
      isPlaying: true,
      currentTime: 42,
      duration: 180,
      mode: 'random',
      quality: '320k',
      resolvedUrl: 'https://example.invalid/audio',
      resolving: false,
      error: '',
    })

    usePlaybackStore.getState().clearQueue()

    expect(usePlaybackStore.getState()).toMatchObject({
      queue: [],
      currentIndex: -1,
      currentSong: null,
      priorityNextSongKey: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      resolvedUrl: null,
      resolving: false,
      mode: 'random',
      quality: '320k',
    })
    expect(pauseCalls).toBe(1)
  })

  it('reorders queue entries without interrupting the current song and persists the one-shot next choice', () => {
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
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
    setSessionScope('queue-persistence-test')
    const first = { source: 'wy', songmid: 'move-1', name: '第一首' }
    const second = { source: 'wy', songmid: 'move-2', name: '第二首' }
    const third = { source: 'wy', songmid: 'move-3', name: '第三首' }
    try {
      usePlaybackStore.setState({
        queue: [first, second, third],
        currentIndex: 0,
        currentSong: first,
        isPlaying: true,
        currentTime: 19,
        mode: 'random',
        quality: '320k',
      })
      usePlaybackStore.getState().moveQueueItem(0, 2)
      expect(usePlaybackStore.getState()).toMatchObject({
        queue: [second, third, first],
        currentIndex: 2,
        currentSong: first,
        isPlaying: true,
        currentTime: 19,
      })

      usePlaybackStore.getState().playNext(second)
      expect(usePlaybackStore.getState()).toMatchObject({
        queue: [third, first, second],
        currentIndex: 1,
        currentSong: first,
        isPlaying: true,
        priorityNextSongKey: songKey(second),
      })

      usePlaybackStore.getState().reset()
      usePlaybackStore.getState().hydrate()
      expect(usePlaybackStore.getState()).toMatchObject({
        queue: [third, first, second],
        currentIndex: 1,
        currentSong: first,
        priorityNextSongKey: songKey(second),
        mode: 'random',
        quality: '320k',
        hasHydrated: true,
      })
    } finally {
      usePlaybackStore.getState().reset()
      setSessionScope(null)
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('keeps the restored current track and index aligned with the persisted queue', () => {
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
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage })
    setSessionScope('queue-hydration-test')
    const savedSong = { source: 'wy', songmid: 'stale-current', name: '残留歌曲' }
    values.set(
      scopedStorageKey('lx_playback_state'),
      JSON.stringify({ song: savedSong, index: 1, time: 92, playlist: [] }),
    )
    try {
      usePlaybackStore.getState().reset()
      usePlaybackStore.getState().hydrate()
      expect(usePlaybackStore.getState()).toMatchObject({
        queue: [],
        currentSong: null,
        currentIndex: -1,
        currentTime: 0,
        hasHydrated: true,
      })
    } finally {
      usePlaybackStore.getState().reset()
      setSessionScope(null)
      if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('prioritizes a designated next song once in every playback mode', () => {
    const originalRandom = Math.random
    Math.random = () => 0
    const first = { source: 'wy', songmid: 'priority-1', name: '第一首' }
    const second = { source: 'wy', songmid: 'priority-2', name: '第二首' }
    const third = { source: 'wy', songmid: 'priority-3', name: '第三首' }
    try {
      for (const mode of ['list', 'random', 'single'] as const) {
        usePlaybackStore.setState({
          queue: [first, second, third],
          currentIndex: 0,
          currentSong: first,
          isPlaying: true,
          mode,
          priorityNextSongKey: songKey(third),
        })
        usePlaybackStore.getState().next()
        expect(usePlaybackStore.getState()).toMatchObject({
          currentSong: third,
          currentIndex: 2,
          priorityNextSongKey: null,
        })
        usePlaybackStore.getState().next()
        expect(usePlaybackStore.getState().currentSong).toEqual(first)
      }
    } finally {
      Math.random = originalRandom
      usePlaybackStore.getState().reset()
    }
  })

  it('starts a designated next song immediately when playback has no current track and clears removed next choices', () => {
    const first = { source: 'wy', songmid: 'priority-empty-1', name: '空队列开始' }
    const second = { source: 'wy', songmid: 'priority-empty-2', name: '待移除下一首' }
    const current = { source: 'wy', songmid: 'priority-empty-3', name: '当前歌曲' }
    usePlaybackStore.setState({
      queue: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      priorityNextSongKey: null,
    })
    usePlaybackStore.getState().playNext(first)
    expect(usePlaybackStore.getState()).toMatchObject({
      queue: [first],
      currentIndex: 0,
      currentSong: first,
      isPlaying: true,
    })

    usePlaybackStore.setState({
      queue: [current, second],
      currentIndex: 0,
      currentSong: current,
      isPlaying: true,
      priorityNextSongKey: songKey(second),
    })
    usePlaybackStore.getState().removeFromQueue(1)
    expect(usePlaybackStore.getState()).toMatchObject({
      queue: [current],
      currentSong: current,
      priorityNextSongKey: null,
    })
    usePlaybackStore.getState().reset()
  })

  it('publishes the reference navigation and shared theme contracts', () => {
    const shell = read('frontend/player/src/react/shell.tsx')
    const audioRuntime = read('frontend/player/src/react/audio_runtime.tsx')
    const playerCss = read('frontend/styles/player.css')
    const library = read('frontend/player/src/react/library_views.tsx')
    const store = read('frontend/player/src/react/store.ts')
    const mediaLibrary = read('frontend/player/src/react/store/media_library.ts')
    const admin = read('frontend/admin/src/react/index.tsx')
    const adminCss = read('frontend/styles/admin.css')
    const tokens = read('frontend/styles/design-tokens.css')
    const sharedTheme = read('frontend/shared/src/theme.ts')
    for (const label of [
      'home',
      'favorites',
      'recent',
      'albums',
      'artists',
      'library',
      'search',
      'songlist',
      'leaderboard',
    ])
      expect(shell).toContain(`id: '${label}'`)
    expect(shell).not.toContain("{ id: 'genres', label: '风格'")
    expect(shell).not.toContain("{ id: 'genres', label: '分类'")
    expect(shell).toMatch(/case 'genres':\s*return <SongListView/)
    expect(shell).not.toContain('GenresView')
    expect(library).not.toContain('GenresView')
    expect(shell).toContain('listId: navigation.listId')
    expect(shell).not.toContain('react-global-search')
    expect(shell).toContain('aria-label="播放队列"')
    expect(shell).not.toContain('startQueueDrag')
    expect(shell).not.toContain('QueueDragSession')
    expect(shell).not.toContain('queuePointerMove')
    expect(shell).not.toContain('onPointerDown={event => startQueueDrag(event, key)}')
    expect(shell).not.toContain('react-queue-drag-preview')
    expect(shell).toContain('className="react-queue-song"')
    expect(shell).not.toContain('className="react-queue-reorder"')
    expect(shell).toContain('使用上下方向键调整歌曲顺序。')
    expect(shell).not.toContain('react-queue-state-chip')
    expect(shell).not.toContain('react-queue-next-chip')
    expect(playerCss).not.toContain('.react-queue-drag-preview')
    expect(playerCss).not.toContain('.react-queue-list li.is-dragging')
    expect(playerCss).not.toMatch(/\.react-queue[^{}]*\{[^{}]*touch-action:\s*none/)
    expect(playerCss).toContain('min-width: var(--react-queue-cover-size)')
    expect(playerCss).toContain('aspect-ratio: 1 / 1')
    expect(playerCss).toContain('object-fit: cover')
    expect(playerCss).not.toContain('.react-queue-state-chip')
    expect(playerCss).not.toContain('.react-queue-next-chip')
    expect(shell).toContain('prefers-reduced-motion: reduce')
    expect(shell).toContain("event.key !== 'ArrowUp' && event.key !== 'ArrowDown'")
    expect(audioRuntime).toContain('priorityNextSongKey')
    expect(shell).toContain('正在恢复播放列表…')
    expect(shell).toContain('播放列表为空')
    expect(shell).toContain('下载任务加载失败')
    expect(shell).toContain('暂无下载任务')
    expect(shell).toContain('无法刷新任务：{error}')
    expect(shell).toContain('清理已完成')
    expect(shell).toContain('task.songInfo')
    const cacheStore = read('frontend/player/src/react/store/cache.ts')
    const cacheApi = read('frontend/player/src/react/api.ts')
    expect(cacheStore).toContain('pauseTask: (id: string) => Promise<boolean>')
    expect(cacheStore).toContain('resumeTask: (id: string) => Promise<boolean>')
    expect(cacheStore).toContain('pauseAll: () => Promise<boolean>')
    expect(cacheStore).toContain('resumeAll: () => Promise<boolean>')
    expect(cacheStore).toContain("notifyPlayback(error instanceof Error ? error.message : errorLabel, 'error')")
    expect(cacheApi).toContain("'/api/music/cache/stop'")
    expect(cacheApi).toContain("'/api/music/cache/queue/resume'")
    expect(library).toContain('LibraryAlbumsView')
    expect(library).toContain('LibraryArtistsView')
    expect(library).not.toContain('react-home-shortcuts')
    expect(library).not.toContain('react-home-shortcut')
    expect(library).not.toContain('react-home-feature')
    expect(mediaLibrary).toContain('libraryAlbums')
    expect(mediaLibrary).toContain('libraryArtists')
    expect(adminCss).toContain('.admin-react-shell .admin-react-topbar {')
    expect(adminCss).toContain('backdrop-filter: none;')
    expect(admin).toContain('applyThemePreferences(readThemePreferences())')
    expect(admin).not.toContain('切换主题')
    expect(tokens).toContain('--app-sidebar-width')
    expect(tokens).toContain('--app-accent: #fa243c')
    expect(tokens).not.toContain('[data-theme="violet"]')
    expect(sharedTheme).toContain("element.dataset.theme = 'netease'")
    expect(sharedTheme).toContain('element.dataset.appearance = appearance')
  })

  it('keeps the React-only build free of retired player bridges and jumpy artwork motion', () => {
    const buildScript = read('scripts/build-frontend.ts')
    const assetCheck = read('scripts/check-frontend-assets.ts')
    const serviceWorker = read('public/music/sw.js')
    const css = read('frontend/styles/player.css')
    const adminCss = read('frontend/styles/admin.css')

    expect(buildScript).not.toContain('vendor_bridge.ts')
    expect(buildScript).not.toContain('phase_vocoder.ts')
    expect(assetCheck).toContain("'vendor-bridge.js'")
    expect(assetCheck).toContain("'phase-vocoder.js'")
    expect(serviceWorker).not.toContain('vendor-bridge.js')
    expect(serviceWorker).not.toContain('phase-vocoder.js')
    expect(css).toContain('transform: scale(1.01)')
    expect(css).not.toContain('transform: translateY(-3px)')
    expect(css).not.toMatch(/transition:\s*all/)
    expect(adminCss).not.toMatch(/transition:\s*all/)
    expect(css).not.toMatch(/outline:\s*none/)
    expect(adminCss).not.toMatch(/outline:\s*none/)
  })
})
