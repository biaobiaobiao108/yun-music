import { requestJson } from '../../../shared/src/http'
import { readJson, writeJson } from '../../../shared/src/storage'
import type { RuntimeConfig } from '../../../shared/src/runtime'
import type { LyricLine, Song } from './types'

export type PlayerConfig = RuntimeConfig & {
  'player.enableAuth'?: boolean
  'user.enablePublicRestriction'?: boolean
  'user.enablePublicFavorites'?: boolean
}
export type SearchType = 'song' | 'singer' | 'album' | 'playlist'
export type UserListData = { defaultList?: Song[]; loveList?: Song[]; userList?: { id: string | number; name: string; list?: Song[] }[] }
export type CacheTask = Record<string, unknown> & { id?: string; songKey?: string; status?: string; progress?: number; name?: string }
export type CacheStats = Record<string, unknown> & { cacheSize?: number; musicSize?: number; cacheCount?: number; musicCount?: number }
export type CacheItem = Record<string, unknown> & {
  id: string
  songmid?: string | number
  name: string
  singer: string
  album?: string
  img?: string
  source?: string
  quality?: string
  filename: string
  folder: 'cache' | 'music' | string
  rawUsername?: string
  username?: string
  size?: number
  mtime?: number
  hasLyric?: boolean
  songInfo?: Song
}
export type CommentItem = Record<string, unknown> & { userName?: string; text?: string; time?: number | string; timeStr?: string; likedCount?: number; location?: string; avatar?: string; reply?: CommentItem[] }
export type CustomSource = Record<string, unknown> & { id: string; name?: string; version?: string; enabled?: boolean; owner?: string; isPublic?: boolean; status?: string; error?: string }

export const playerApi = {
  config: () => requestJson<PlayerConfig>('/api/music/config'),
  verify: () => requestJson<{ valid: boolean }>('/api/music/auth/verify'),
  login: (password: string) => requestJson<{ success: boolean }>('/api/music/auth', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => requestJson('/api/music/auth/logout', { method: 'POST' }),
  userVerify: () => requestJson<{ valid: boolean; username?: string }>('/api/user/auth/verify'),
  userLogin: (username: string, password: string) => requestJson<{ success: boolean; username: string }>('/api/user/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  userLogout: () => requestJson('/api/user/logout', { method: 'POST' }),
  search: (query: string, source: string, type: SearchType, page: number, signal?: AbortSignal) => requestJson<Song[]>(`/api/music/search?name=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}&type=${type}&page=${page}&limit=40`, { signal }),
  tips: (query: string, source: string, signal?: AbortSignal) => requestJson<string[]>(`/api/music/tipSearch?name=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}`, { signal }),
  artistDetail: (source: string, id: string, signal?: AbortSignal) => requestJson<unknown>(`/api/music/artistDetail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`, { signal }),
  artistSongs: (source: string, id: string, order = 'hot', page = 1, limit = 40, signal?: AbortSignal) => requestJson<unknown>(`/api/music/artistSongs?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&order=${encodeURIComponent(order)}&page=${page}&limit=${limit}`, { signal }),
  artistAlbums: (source: string, id: string, page = 1, limit = 40, signal?: AbortSignal) => requestJson<unknown>(`/api/music/artistAlbums?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&page=${page}&limit=${limit}`, { signal }),
  albumSongs: (source: string, id: string, signal?: AbortSignal) => requestJson<unknown>(`/api/music/albumSongs?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`, { signal }),
  hotSearch: async (source: string) => {
    const payload = await requestJson<unknown>(`/api/music/hotSearch?source=${encodeURIComponent(source)}`)
    if (Array.isArray(payload)) return payload
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      for (const key of ['list', 'data', 'result', 'hotSearch']) if (Array.isArray(record[key])) return record[key] as unknown[]
    }
    return []
  },
  songUrl: (songInfo: Song, quality: string, signal?: AbortSignal, enableAutoSwitchApiSource = true) => requestJson<{ url: string; quality?: string; type?: string; sourceName?: string; fromCache?: boolean }>('/api/music/url', { method: 'POST', body: JSON.stringify({ songInfo, quality, enableAutoSwitchApiSource }), signal }),
  lyric: (songInfo: Song, signal?: AbortSignal) => requestJson<Record<string, unknown>>('/api/music/lyric', { method: 'POST', body: JSON.stringify({ songInfo }), signal }),
  listData: (user?: string) => requestJson<UserListData>(user ? `/api/user/list?user=${encodeURIComponent(user)}` : '/api/user/list'),
  saveListData: (data: UserListData) => requestJson('/api/user/list', { method: 'POST', body: JSON.stringify(data) }),
  addToList: (listId: string, musicInfos: Song[], location = 'bottom') => requestJson('/api/music/user/list/add', { method: 'POST', body: JSON.stringify({ listId, musicInfos, location }) }),
  removeFromList: (listId: string, songIds: string[]) => requestJson('/api/music/user/list/remove', { method: 'POST', body: JSON.stringify({ listId, songIds }) }),
  settings: () => requestJson<Record<string, unknown>>('/api/user/settings'),
  saveSettings: (settings: Record<string, unknown>) => requestJson('/api/user/settings', { method: 'POST', body: JSON.stringify(settings) }),
  libraryArtists: () => requestJson<Song[]>('/api/user/library/artists'),
  libraryAlbums: () => requestJson<Song[]>('/api/user/library/albums'),
  saveLibraryArtists: (items: Song[]) => requestJson('/api/user/library/artists', { method: 'POST', body: JSON.stringify(items) }),
  saveLibraryAlbums: (items: Song[]) => requestJson('/api/user/library/albums', { method: 'POST', body: JSON.stringify(items) }),
  songListTags: (source: string) => requestJson<unknown>(`/api/music/songList/tags?source=${encodeURIComponent(source)}`),
  songList: (source: string, tagId = '', sortId = 'hot', page = 1, signal?: AbortSignal) => requestJson<unknown>(`/api/music/songList/list?source=${encodeURIComponent(source)}&tagId=${encodeURIComponent(tagId)}&sortId=${encodeURIComponent(sortId)}&page=${page}`, { signal }),
  songListDetail: (source: string, id: string, signal?: AbortSignal) => requestJson<unknown>(`/api/music/songList/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`, { signal }),
  leaderboardBoards: async (source: string) => {
    const payload = await requestJson<unknown>(`/api/music/leaderboard/boards?source=${encodeURIComponent(source)}`)
    if (Array.isArray(payload)) return payload
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      for (const key of ['list', 'boards', 'data', 'result']) if (Array.isArray(record[key])) return record[key] as unknown[]
    }
    return []
  },
  leaderboard: (source: string, boardId: string, page = 1, signal?: AbortSignal) => requestJson<unknown>(`/api/music/leaderboard/list?source=${encodeURIComponent(source)}&bangid=${encodeURIComponent(boardId)}&page=${page}`, { signal }),
  comments: (songInfo: Song, type: 'hot' | 'new', page = 1, limit = 20, signal?: AbortSignal) => requestJson<unknown>('/api/music/comment', { method: 'POST', body: JSON.stringify({ songInfo, type, page, limit }), signal }),
  customSources: (username?: string) => requestJson<CustomSource[]>(`/api/custom-source/list${username ? `?username=${encodeURIComponent(username)}` : ''}`),
  toggleCustomSource: (id: string, enabled: boolean, username?: string) => requestJson('/api/custom-source/toggle', { method: 'POST', body: JSON.stringify({ id, enabled, username }) }),
  deleteCustomSource: (id: string, owner?: string) => requestJson('/api/custom-source/delete', { method: 'POST', body: JSON.stringify({ id, sourceOwner: owner }) }),
  importCustomSource: (url: string, filename?: string, username?: string) => requestJson('/api/custom-source/import', { method: 'POST', body: JSON.stringify({ url, filename, username }) }),
  uploadCustomSource: (filename: string, content: string, type: string, username?: string) => requestJson('/api/custom-source/upload', { method: 'POST', body: JSON.stringify({ filename, content, type, username }) }),
  cacheQueue: () => requestJson<{ success?: boolean; data?: CacheTask[] }>('/api/music/cache/queue'),
  cacheStats: () => requestJson<{ success?: boolean; data?: CacheStats }>('/api/music/cache/stats'),
  cacheList: (user?: string, signal?: AbortSignal) => requestJson<{ success?: boolean; data?: CacheItem[] }>(`/api/music/cache/list${user ? `?user=${encodeURIComponent(user)}` : ''}`, { signal }),
  cacheSync: (user?: string) => requestJson(`/api/music/cache/sync${user ? `?user=${encodeURIComponent(user)}` : ''}`, { method: 'POST' }),
  cacheRemove: (items: Array<{ filename: string; folder?: string; user?: string }>, user?: string) => requestJson(`/api/music/cache/remove${user ? `?user=${encodeURIComponent(user)}` : ''}`, { method: 'POST', body: JSON.stringify({ items }) }),
  cacheClear: (user?: string) => requestJson(`/api/music/cache/clear${user ? `?user=${encodeURIComponent(user)}` : ''}`, { method: 'POST' }),
  cachePlayback: (item: { filename: string; folder?: string; location?: string; user?: string }) => requestJson('/api/music/cache/playback', { method: 'POST', body: JSON.stringify(item) }),
  queueTasks: (tasks: unknown[], concurrency?: number) => requestJson('/api/music/cache/queue', { method: 'POST', body: JSON.stringify({ tasks, concurrency }) }),
  removeQueue: (id?: string, all?: boolean) => requestJson('/api/music/cache/queue/remove', { method: 'POST', body: JSON.stringify({ id, all }) }),
  download: (songInfo: Song, url: string, quality: string) => requestJson('/api/music/cache/download', { method: 'POST', body: JSON.stringify({ songInfo, url, quality, enableOnlyDownloadMode: true, cacheLyric: true, embedLyric: true }) }),
}

function lyricText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['lyric', 'lrc', 'text', 'content', 'value']) {
    const text = lyricText(record[key])
    if (text) return text
  }
  return ''
}

function lyricRoots(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, unknown>
  const roots: Record<string, unknown>[] = [root]
  for (const value of [root.data, root.result, root.body]) {
    if (value && typeof value === 'object' && !Array.isArray(value)) roots.push(value as Record<string, unknown>)
  }
  return roots
}

function pickLyricText(roots: Record<string, unknown>[], keys: string[]): string {
  for (const root of roots) {
    for (const key of keys) {
      const text = lyricText(root[key])
      if (text) return text
    }
  }
  return ''
}

export function parseLyric(payload: Record<string, unknown>): LyricLine[] {
  const roots = lyricRoots(payload)
  const source = pickLyricText(roots, ['lyric', 'lrc', 'content', 'text'])
  const translation = pickLyricText(roots, ['tlyric', 'translation', 'translatedLyric', 'tLrc'])
  const roma = pickLyricText(roots, ['rlyric', 'romalrc', 'roma', 'romanizedLyric'])
  const wordLyric = pickLyricText(roots, ['klyric', 'lxlyric', 'wordLyric', 'yrc'])
  const translated = new Map<number, string>()
  const romanized = new Map<number, string>()
  const wordLines = new Map<number, string>()
  const parse = (text: string, target = new Map<number, string>()) => {
    for (const line of text.split(/\r?\n/)) {
      const matches = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
      if (!matches.length) continue
      const textContent = line
        .replace(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, '')
        .trim()
      if (!textContent || /^(作词|作曲|编曲|制作人|监制|出品|发行|混音|母带|录音|音频|电吉他|低音吉他|吉他|贝斯|鼓|和声|主人声|伴唱|键盘)\s*[:：]/i.test(textContent)) continue
      for (const match of matches) {
        const fractionText = match[3] || ''
        const fraction = fractionText ? Number(fractionText) / 10 ** fractionText.length : 0
        const time = Number(match[1]) * 60 + Number(match[2]) + fraction
        target.set(Math.round(time * 1000), textContent)
      }
    }
    return target
  }
  parse(translation, translated)
  parse(roma, romanized)
  parse(wordLyric, wordLines)
  return [...parse(source)].map(([time, text]) => {
    const line: LyricLine = { time: time / 1000, text, translation: translated.get(time) }
    const translatedText = translated.get(time)
    const romanizedText = romanized.get(time)
    const wordText = wordLines.get(time)
    if (translatedText) line.translation = translatedText
    if (romanizedText) line.roma = romanizedText
    if (wordText) line.words = wordText
    return line
  }).filter(line => line.text).sort((a, b) => a.time - b.time)
}

export function readLegacySettings<T extends object>(defaults: T): T {
  const stored = readJson<Record<string, unknown>>(localStorage, 'lx_settings', {})
  return { ...defaults, ...stored } as T
}

export function persistLegacySettings(settings: object): void {
  writeJson(localStorage, 'lx_settings', settings)
}
