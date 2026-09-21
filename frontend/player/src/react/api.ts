import { requestJson, type RequestPolicy } from './data/request'
import { readJson, writeJson } from '../../../shared/src/storage'
import type { RuntimeConfig } from '../../../shared/src/runtime'
import type { LyricLine, Song } from './types'

export type PlayerConfig = RuntimeConfig & {
  'player.enableAuth'?: boolean
  'user.enablePublicRestriction'?: boolean
  'user.enablePublicFavorites'?: boolean
}
export type SearchType = 'song' | 'singer' | 'album' | 'playlist'
export type UserPlaylist = Record<string, unknown> & {
  id: string | number
  name: string
  list?: Song[]
  source?: string
  sourceListId?: string | number
  img?: string
  pic?: string
  picUrl?: string
  image?: string
}
export type UserListData = { defaultList?: Song[]; loveList?: Song[]; userList?: UserPlaylist[] }
export type CacheTask = Record<string, unknown> & { id?: string; songKey?: string; status?: string; progress?: number; name?: string; songInfo?: Song; quality?: string; requestedQuality?: string; total?: number; received?: number; errorMsg?: string }
export type CacheStats = Record<string, unknown> & {
  cache?: { totalSize?: number; fileCount?: number }
  music?: { totalSize?: number; fileCount?: number }
  cacheSize?: number
  musicSize?: number
  cacheCount?: number
  musicCount?: number
}
export type CacheItem = Record<string, unknown> & {
  id: string
  songmid?: string | number
  name: string
  singer: string
  albumName?: string
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

export const playerApi = {
  config: () => requestJson<PlayerConfig>('/api/music/config'),
  verify: () => requestJson<{ valid: boolean }>('/api/music/auth/verify'),
  login: (password: string) => requestJson<{ success: boolean }>('/api/music/auth', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => requestJson('/api/music/auth/logout', { method: 'POST' }),
  userVerify: () => requestJson<{ valid: boolean; username?: string }>('/api/user/auth/verify'),
  userLogin: (username: string, password: string) => requestJson<{ success: boolean; username: string }>('/api/user/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  userLogout: () => requestJson('/api/user/logout', { method: 'POST' }),
  search: (query: string, source: string, type: SearchType, page: number, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<Song[]>(`/api/music/search?name=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}&type=${type}&page=${page}&limit=40`, { signal, ...policy }),
  tips: (query: string, source: string, signal?: AbortSignal) => requestJson<string[]>(`/api/music/tipSearch?name=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}`, { signal }),
  artistDetail: (source: string, id: string, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/artistDetail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`, { signal, ...policy }),
  artistSongs: (source: string, id: string, order = 'hot', page = 1, limit = 40, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/artistSongs?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&order=${encodeURIComponent(order)}&page=${page}&limit=${limit}`, { signal, ...policy }),
  artistAlbums: (source: string, id: string, page = 1, limit = 40, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/artistAlbums?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&page=${page}&limit=${limit}`, { signal, ...policy }),
  albumSongs: (source: string, id: string, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/albumSongs?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`, { signal, ...policy }),
  hotSearch: async (source: string, signal?: AbortSignal, policy?: RequestPolicy) => {
    const payload = await requestJson<unknown>(`/api/music/hotSearch?source=${encodeURIComponent(source)}`, { signal, ...policy })
    if (Array.isArray(payload)) return payload
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      for (const key of ['list', 'data', 'result', 'hotSearch']) if (Array.isArray(record[key])) return record[key] as unknown[]
    }
    return []
  },
  songUrl: (songInfo: Song, quality: string, signal?: AbortSignal, enableAutoSwitchApiSource = true) => requestJson<{ url: string; quality?: string; type?: string; sourceName?: string; fromCache?: boolean }>('/api/music/url', { method: 'POST', body: JSON.stringify({ songInfo, quality, enableAutoSwitchApiSource }), signal }),
  lyric: (songInfo: Song, signal?: AbortSignal) => requestJson<Record<string, unknown>>('/api/music/lyric', { method: 'POST', body: JSON.stringify({ songInfo }), signal }),
  listData: (user?: string, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<UserListData>(user ? `/api/user/list?user=${encodeURIComponent(user)}` : '/api/user/list', { signal, ...policy }),
  saveListData: (data: UserListData) => requestJson('/api/user/list', { method: 'POST', body: JSON.stringify(data) }),
  addToList: (listId: string, musicInfos: Song[], location = 'bottom') => requestJson('/api/music/user/list/add', { method: 'POST', body: JSON.stringify({ listId, musicInfos, location }) }),
  removeFromList: (listId: string, songIds: string[]) => requestJson('/api/music/user/list/remove', { method: 'POST', body: JSON.stringify({ listId, songIds }) }),
  settings: () => requestJson<Record<string, unknown>>('/api/user/settings'),
  saveSettings: (settings: Record<string, unknown>) => requestJson('/api/user/settings', { method: 'POST', body: JSON.stringify(settings) }),
  libraryArtists: (signal?: AbortSignal, policy?: RequestPolicy) => requestJson<Song[]>('/api/user/library/artists', { signal, ...policy }),
  libraryAlbums: (signal?: AbortSignal, policy?: RequestPolicy) => requestJson<Song[]>('/api/user/library/albums', { signal, ...policy }),
  saveLibraryArtists: (items: Song[]) => requestJson('/api/user/library/artists', { method: 'POST', body: JSON.stringify(items) }),
  saveLibraryAlbums: (items: Song[]) => requestJson('/api/user/library/albums', { method: 'POST', body: JSON.stringify(items) }),
  songListTags: (source: string, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/songList/tags?source=${encodeURIComponent(source)}`, { signal, ...policy }),
  songList: (source: string, tagId = '', sortId = 'hot', page = 1, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/songList/list?source=${encodeURIComponent(source)}&tagId=${encodeURIComponent(tagId)}&sortId=${encodeURIComponent(sortId)}&page=${page}`, { signal, ...policy }),
  songListDetail: (source: string, id: string, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/songList/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`, { signal, ...policy }),
  leaderboardBoards: async (source: string, signal?: AbortSignal, policy?: RequestPolicy) => {
    const payload = await requestJson<unknown>(`/api/music/leaderboard/boards?source=${encodeURIComponent(source)}`, { signal, ...policy })
    if (Array.isArray(payload)) return payload
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      for (const key of ['list', 'boards', 'data', 'result']) if (Array.isArray(record[key])) return record[key] as unknown[]
    }
    return []
  },
  leaderboard: (source: string, boardId: string, page = 1, signal?: AbortSignal, policy?: RequestPolicy) => requestJson<unknown>(`/api/music/leaderboard/list?source=${encodeURIComponent(source)}&bangid=${encodeURIComponent(boardId)}&page=${page}`, { signal, ...policy }),
  comments: (songInfo: Song, type: 'hot' | 'new', page = 1, limit = 20, signal?: AbortSignal) => requestJson<unknown>('/api/music/comment', { method: 'POST', body: JSON.stringify({ songInfo, type, page, limit }), signal }),
  cacheQueue: (signal?: AbortSignal, policy?: RequestPolicy) => requestJson<{ success?: boolean; data?: CacheTask[] }>('/api/music/cache/queue', { signal, ...policy }),
  cacheStats: (signal?: AbortSignal, policy?: RequestPolicy) => requestJson<{ success?: boolean; data?: CacheStats }>('/api/music/cache/stats', { signal, ...policy }),
  cacheList: (user?: string, signal?: AbortSignal) => requestJson<{ success?: boolean; data?: CacheItem[] }>(`/api/music/cache/list${user ? `?user=${encodeURIComponent(user)}` : ''}`, { signal }),
  cacheSync: (user?: string, signal?: AbortSignal) => requestJson(`/api/music/cache/sync${user ? `?user=${encodeURIComponent(user)}` : ''}`, { method: 'POST', signal }),
  cacheRemove: (items: Array<{ filename: string; folder?: string; user?: string }>, user?: string) => requestJson(`/api/music/cache/remove${user ? `?user=${encodeURIComponent(user)}` : ''}`, { method: 'POST', body: JSON.stringify({ items }) }),
  cacheClear: (user?: string) => requestJson(`/api/music/cache/clear${user ? `?user=${encodeURIComponent(user)}` : ''}`, { method: 'POST' }),
  cachePlayback: (item: { filename: string; folder?: string; location?: string; user?: string }) => requestJson('/api/music/cache/playback', { method: 'POST', body: JSON.stringify(item) }),
  cacheMove: (items: Array<{ filename: string; folder?: string; user?: string; rawUsername?: string; sourceUser?: string }>, targetFolder: 'cache' | 'music' = 'music') => requestJson<{ success?: boolean; successCount?: number; failCount?: number; moved?: unknown[] }>('/api/music/cache/move', { method: 'POST', body: JSON.stringify({ items, targetFolder }) }),
  queueTasks: (tasks: unknown[], concurrency?: number) => requestJson('/api/music/cache/queue', { method: 'POST', body: JSON.stringify({ tasks, concurrency }) }),
  removeQueue: (id?: string, all?: boolean, completed?: boolean) => requestJson('/api/music/cache/queue/remove', { method: 'POST', body: JSON.stringify({ id, all, completed }) }),
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
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  const stored = readJson<Record<string, unknown>>(storage, 'lx_settings', {})
  return { ...defaults, ...stored } as T
}

export function persistLegacySettings(settings: object): void {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  writeJson(storage, 'lx_settings', settings)
}
