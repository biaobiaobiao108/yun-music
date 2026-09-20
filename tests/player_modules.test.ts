import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { parseLyric } from '../frontend/player/src/react/api'
import { songKey } from '../frontend/player/src/react/types'
import { buildPlaybackUrl, normalizeCachePlaybackUrl } from '../frontend/player/src/react/media_url'
import { normalizePlayHistory } from '../frontend/player/src/react/store'

const root = path.join(import.meta.dir, '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

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
    const lines = parseLyric({ lyric: '[00:01.20]第一句\n[00:03.50]第二句', tlyric: '[00:01.20]translation' })
    expect(lines).toEqual([
      { time: 1.2, text: '第一句', translation: 'translation' },
      { time: 3.5, text: '第二句', translation: undefined },
    ])
    expect(parseLyric({ data: { lrc: { lyric: '[00:00.50]嵌套歌词' }, tlyric: { lyric: '[00:00.50]nested translation' } } })).toEqual([
      { time: 0.5, text: '嵌套歌词', translation: 'nested translation' },
    ])
    expect(parseLyric({ lyric: '[00:00.0]作词: Someone\n[00:01.0]真正的歌词' })).toEqual([
      { time: 1, text: '真正的歌词', translation: undefined },
    ])
  })

  it('keeps private cache links playable and relays third-party source URLs', () => {
    const song = { source: 'wy', songmid: 'song-1', name: '测试歌曲', singer: '测试歌手' }
    expect(normalizeCachePlaybackUrl('/api/music/cache/file/test.mp3?folder=cache', 'steelway108'))
      .toBe('/api/music/cache/file/steelway108/test.mp3?folder=cache')
    expect(normalizeCachePlaybackUrl('/api/music/cache/file/steelway108/test.mp3?folder=cache', 'steelway108'))
      .toBe('/api/music/cache/file/steelway108/test.mp3?folder=cache')
    expect(buildPlaybackUrl('https://media.example.test/song.mp3', song, {}, 'http://localhost:9527'))
      .toContain('/api/music/download?url=https%3A%2F%2Fmedia.example.test%2Fsong.mp3')
    expect(buildPlaybackUrl('http://localhost:9527/api/music/cache/file/_open/song.mp3', song, {}, 'http://localhost:9527'))
      .toBe('http://localhost:9527/api/music/cache/file/_open/song.mp3')
  })

  it('keeps audio lifecycle lightweight and cache APIs isolated behind services', () => {
    const shell = read('frontend/player/src/react/shell.tsx')
    const api = read('frontend/player/src/react/api.ts')
    expect(shell).toContain('preload="metadata"')
    expect(shell).toContain('removeAttribute(\'src\')')
    expect(shell).toContain('navigator.mediaSession')
    expect(api).toContain("'/api/music/url'")
    expect(api).toContain("'/api/music/cache/queue'")
    expect(api).toContain("'/api/music/lyric'")
  })

  it('keeps recent playback compatible with the legacy play_history contract', () => {
    const items = Array.from({ length: 55 }, (_, index) => ({ source: 'wy', songmid: String(index), name: `歌曲 ${index}`, playedAt: index }))
    const normalized = normalizePlayHistory([items[54], ...items, { source: 'wy', songmid: '54', name: '重复歌曲', playedAt: 0 }])
    expect(normalized).toHaveLength(50)
    expect(normalized[0]?.songmid).toBe('54')
    expect(normalized.at(-1)?.songmid).toBe('5')
    expect(new Set(normalized.map(item => songKey(item))).size).toBe(50)
  })

  it('publishes the reference navigation and shared theme contracts', () => {
    const shell = read('frontend/player/src/react/shell.tsx')
    const library = read('frontend/player/src/react/library_views.tsx')
    const store = read('frontend/player/src/react/store.ts')
    const admin = read('frontend/admin/src/react/index.tsx')
    const tokens = read('frontend/styles/design-tokens.css')
    for (const label of ['home', 'favorites', 'recent', 'albums', 'artists', 'genres', 'library', 'search', 'songlist', 'leaderboard']) expect(shell).toContain(`id: '${label}'`)
    expect(shell).toContain('listId: navigation.listId')
    expect(shell).toContain('react-global-search')
    expect(library).toContain('LibraryAlbumsView')
    expect(library).toContain('LibraryArtistsView')
    expect(store).toContain('libraryAlbums')
    expect(store).toContain('libraryArtists')
    expect(admin).toContain('updateThemePreferences')
    expect(tokens).toContain('--app-sidebar-width')
    expect(tokens).toContain('[data-theme="violet"]')
  })
})
