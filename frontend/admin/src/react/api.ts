import { requestBlob, requestJson } from '../../../shared/src/http'
import type { RuntimeConfig } from '../../../shared/src/runtime'

export type AdminUser = { name: string; hasPassword?: boolean }
export type AdminSong = Record<string, unknown> & {
  id?: string
  songmid?: string | number
  songId?: string | number
  hash?: string | number
  name?: string
  singer?: string
  artist?: string
  album?: string
  albumName?: string
  img?: string
  picUrl?: string
  source?: string
  interval?: string | number
  meta?: Record<string, unknown>
}
export type AdminPlaylist = Record<string, unknown> & { id: string; name: string; list: AdminSong[] }
export type AdminData = { defaultList?: AdminSong[]; loveList?: AdminSong[]; userList?: AdminPlaylist[] }
export type AdminStatus = {
  users?: number
  publicAccess?: boolean
  uptime?: number
  memory?: number
  totalMemory?: number
  freeMemory?: number
  systemMemoryUsage?: string
  processMemoryUsage?: string
  cpuUsage?: string
  processCpuUsage?: string
  cacheStats?: Record<string, unknown>
  cacheLimit?: number
  [key: string]: unknown
}
export type AdminConfig = Record<string, unknown> & { serverName?: string; playerPath?: string }
export type StorageItem = Record<string, unknown> & { id?: string; filename?: string; rawUsername?: string; name?: string; singer?: string; size?: number; folder?: 'cache' | 'music'; mtime?: number }
export type Snapshot = Record<string, unknown> & { id?: string; time?: number; size?: number; name?: string }

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = typeof value === 'string' ? value.trim() : String(value)
    if (text) return text
  }
  return undefined
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  if (!record) return []
  for (const key of ['list', 'items', 'songs', 'data']) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

export function normalizeAdminSong(value: unknown): AdminSong {
  const record = asRecord(value) ?? {}
  const meta = asRecord(record.meta) ?? {}
  const id = firstText(record.id, record.songmid, record.songId, record.hash, meta.songId, meta.songmid, meta.id)
  const name = firstText(record.name, record.title, record.songName, meta.name, meta.title)
  const singer = firstText(record.singer, record.artist, record.artists, meta.singer, meta.artist, meta.artists)
  const album = firstText(record.album, record.albumName, meta.albumName, meta.album, meta.albumTitle)
  const img = firstText(record.img, record.picUrl, record.pic, record.cover, meta.picUrl, meta.img, meta.pic, meta.cover)
  const interval = firstText(record.interval, record.duration, meta.interval, meta.duration)
  return {
    ...record,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(singer ? { singer } : {}),
    ...(album ? { album } : {}),
    ...(img ? { img } : {}),
    ...(interval ? { interval } : {}),
    meta,
  } as AdminSong
}

export function adminSongId(song: AdminSong, fallback = ''): string {
  return firstText(song.id, song.songmid, song.songId, song.hash, song.meta?.songId, song.meta?.songmid, fallback) ?? fallback
}

export function normalizeAdminPlaylist(value: unknown, index = 0): AdminPlaylist {
  const record = asRecord(value) ?? {}
  const nested = asRecord(record.data)
  const id = firstText(record.id, record.listId, record.sourceListId, nested?.id) ?? `playlist-${index + 1}`
  const name = firstText(record.name, record.title, record.label, nested?.name) ?? `未命名歌单 ${index + 1}`
  const list = arrayValue(record.list ?? record.songs ?? record.items ?? nested?.list).map(normalizeAdminSong)
  return { ...record, id, name, list } as AdminPlaylist
}

export function normalizeAdminData(payload: unknown): AdminData {
  const payloadRecord = asRecord(payload)
  const unwrapped = payloadRecord && !('defaultList' in payloadRecord) && !('loveList' in payloadRecord) && !('userList' in payloadRecord)
    ? payloadRecord.data
    : payload
  const record = asRecord(unwrapped) ?? {}
  const defaultList = arrayValue(record.defaultList ?? record.default ?? record.trialList).map(normalizeAdminSong)
  const loveList = arrayValue(record.loveList ?? record.love ?? record.favorites ?? record.favoriteList).map(normalizeAdminSong)
  const userList = arrayValue(record.userList ?? record.userLists ?? record.playlists ?? record.lists).map((item, index) => normalizeAdminPlaylist(item, index))
  return { defaultList, loveList, userList }
}

export const adminRequest = <T,>(path: string, init?: RequestInit) => requestJson<T>(path, init)

export async function login(password: string): Promise<void> {
  await adminRequest('/api/login', { method: 'POST', body: JSON.stringify({ password }) })
}

export async function logout(): Promise<void> {
  await adminRequest('/api/logout', { method: 'POST' }).catch(() => undefined)
}

export async function verifySession(): Promise<AdminStatus> {
  return adminRequest<AdminStatus>('/api/status')
}

export const adminApi = {
  status: () => adminRequest<AdminStatus>('/api/status'),
  users: () => adminRequest<AdminUser[]>('/api/users'),
  userData: async (user: string) => normalizeAdminData(await adminRequest<unknown>(`/api/data?user=${encodeURIComponent(user)}`)),
  config: () => adminRequest<AdminConfig>('/api/config'),
  saveConfig: (config: Record<string, unknown>) => adminRequest<{ success: boolean; warning?: string }>('/api/config', { method: 'POST', body: JSON.stringify(config) }),
  logs: (type: string) => adminRequest<{ logs?: string[]; lines?: string[] }>(`/api/logs?type=${encodeURIComponent(type)}&lines=300`),
  snapshots: (user: string) => adminRequest<Snapshot[]>(`/api/data/snapshots?user=${encodeURIComponent(user)}`),
  snapshot: async (user: string, id: string) => normalizeAdminData(await adminRequest<unknown>(`/api/data/snapshot?id=${encodeURIComponent(id)}&user=${encodeURIComponent(user)}`)),
  restoreSnapshot: (user: string, id: string) => adminRequest(`/api/data/restore-snapshot?user=${encodeURIComponent(user)}`, { method: 'POST', body: JSON.stringify({ id }) }),
  deleteSnapshot: (user: string, id: string) => adminRequest(`/api/data/delete-snapshot?user=${encodeURIComponent(user)}`, { method: 'POST', body: JSON.stringify({ id }) }),
  uploadSnapshot: (user: string, file: File) => file.text().then(content => adminRequest(`/api/data/upload-snapshot?user=${encodeURIComponent(user)}&time=${file.lastModified || Date.now()}&filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: content, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })),
  cacheStats: () => adminRequest<{ success?: boolean; data?: Record<string, unknown> }>('/api/music/cache/stats'),
  cacheList: (user: string) => adminRequest<{ success?: boolean; data?: StorageItem[] }>(`/api/music/cache/list?user=${encodeURIComponent(user)}`),
  removeCache: (items: Array<{ filename: string; folder?: 'cache' | 'music'; user?: string }>) => adminRequest('/api/music/cache/remove', { method: 'POST', body: JSON.stringify({ items }) }),
  moveCache: (items: Array<{ filename: string; user?: string }>) => adminRequest('/api/music/cache/move', { method: 'POST', body: JSON.stringify({ items }) }),
  clearCache: (user: string) => adminRequest(`/api/music/cache/clear?user=${encodeURIComponent(user)}`, { method: 'POST' }),
  deletePlaylist: (username: string, playlistId: string) => adminRequest('/api/data/delete-playlist', { method: 'POST', body: JSON.stringify({ username, playlistId }) }),
  deleteSong: (username: string, playlistId: string, songId: string) => adminRequest('/api/data/delete-song', { method: 'POST', body: JSON.stringify({ username, playlistId, songId }) }),
  batchDeleteSongs: (username: string, playlistId: string, songIndices: number[]) => adminRequest('/api/data/batch-delete-songs', { method: 'POST', body: JSON.stringify({ username, playlistId, songIndices }) }),
  renamePlaylist: (username: string, playlistId: string, newName: string) => adminRequest('/api/data/rename-playlist', { method: 'POST', body: JSON.stringify({ username, playlistId, newName }) }),
  addUser: (name: string, password: string) => adminRequest('/api/users', { method: 'POST', body: JSON.stringify({ name, password }) }),
  updateUser: (name: string, payload: { newName?: string; password?: string }) => adminRequest('/api/users', { method: 'PUT', body: JSON.stringify({ name, ...payload }) }),
  deleteUsers: (names: string[], deleteData: boolean) => adminRequest('/api/users', { method: 'DELETE', body: JSON.stringify({ names, deleteData }) }),
  reload: () => adminRequest('/api/admin/reload', { method: 'POST' }),
  restart: () => adminRequest('/api/restart', { method: 'POST' }),
  databaseStats: () => adminRequest<{ success?: boolean; data?: Record<string, unknown> }>('/api/admin/database/stats'),
  vacuum: () => adminRequest('/api/admin/database/vacuum', { method: 'POST' }),
  backup: () => requestBlob('/api/backup/download'),
  restoreBackup: (file: File) => { const form = new FormData(); form.append('backup', file); return adminRequest('/api/backup/upload', { method: 'POST', body: form }) },
}

export function playerUrl(config: RuntimeConfig): string {
  return String(config['player.path'] || '/music')
}
