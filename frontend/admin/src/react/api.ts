import { requestBlob, requestJson } from '../../../shared/src/http'
import { parseByteSize } from '../../../shared/src/runtime'
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
  albumName?: string
  img?: string
  picUrl?: string
  source?: string
  interval?: string | number
  duration?: string | number
  size?: number | string
  fileSize?: number | string
  sizeBytes?: number | string
  format?: string
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
export type StorageItem = Record<string, unknown> & { id?: string; filename?: string; rawUsername?: string; name?: string; singer?: string; albumName?: string; size?: number; folder?: 'cache' | 'music'; mtime?: number }
export type Snapshot = Record<string, unknown> & { id?: string; time?: number; size?: number; name?: string }
export type CustomSourceOwner = 'open' | string
export type AdminCustomSource = {
  id: string
  name?: string
  version?: string
  author?: string
  description?: string
  homepage?: string
  size?: number
  supportedSources?: string[]
  enabled: boolean
  owner: CustomSourceOwner
  isPublic: boolean
  uploadTime?: string
  sourceUrl?: string
  status?: string
  error?: string
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
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

function normalizeCustomSource(value: unknown): AdminCustomSource | null {
  const record = asRecord(value)
  if (!record) return null
  const id = firstText(record.id)
  if (!id) return null
  const owner = firstText(record.owner) || 'open'
  const supportedSources = Array.isArray(record.supportedSources)
    ? record.supportedSources.map(item => String(item)).filter(Boolean)
    : []
  return {
    id,
    ...(firstText(record.name) ? { name: firstText(record.name) } : {}),
    ...(firstText(record.version) ? { version: firstText(record.version) } : {}),
    ...(firstText(record.author) ? { author: firstText(record.author) } : {}),
    ...(firstText(record.description) ? { description: firstText(record.description) } : {}),
    ...(firstText(record.homepage) ? { homepage: firstText(record.homepage) } : {}),
    ...(record.size !== undefined ? { size: Number(record.size) || 0 } : {}),
    supportedSources,
    enabled: Boolean(record.enabled),
    owner,
    isPublic: Boolean(record.isPublic) || owner === 'open',
    ...(firstText(record.uploadTime) ? { uploadTime: firstText(record.uploadTime) } : {}),
    ...(firstText(record.sourceUrl) ? { sourceUrl: firstText(record.sourceUrl) } : {}),
    ...(firstText(record.status) ? { status: firstText(record.status) } : {}),
    ...(firstText(record.error) ? { error: firstText(record.error) } : {}),
  }
}

export function normalizeAdminCustomSources(payload: unknown): AdminCustomSource[] {
  const values = Array.isArray(payload)
    ? payload
    : arrayValue(asRecord(payload)?.data ?? payload)
  return values.map(normalizeCustomSource).filter((value): value is AdminCustomSource => Boolean(value))
}

function qualitySize(record: UnknownRecord, preferredQuality: unknown): unknown {
  const preferred = String(preferredQuality ?? '').trim()
  for (const candidate of [record.qualitys, record._qualitys, record.qualities, record.quality]) {
    if (Array.isArray(candidate)) {
      const entries = candidate.filter(item => item && typeof item === 'object') as UnknownRecord[]
      const entry = entries.find(item => String(item.type ?? item.quality ?? item.name ?? '').trim() === preferred) ?? entries[0]
      const size = entry?.size ?? entry?.fileSize ?? entry?.sizeBytes ?? entry?.bytes
      if (size !== undefined && size !== null && size !== '') return size
    } else if (candidate && typeof candidate === 'object') {
      const table = candidate as UnknownRecord
      const preferredEntry = preferred && table[preferred] && typeof table[preferred] === 'object' ? table[preferred] as UnknownRecord : null
      const directSize = preferredEntry?.size ?? preferredEntry?.fileSize ?? preferredEntry?.sizeBytes ?? preferredEntry?.bytes
      if (directSize !== undefined && directSize !== null && directSize !== '') return directSize
      for (const value of Object.values(table)) {
        if (!value || typeof value !== 'object') continue
        const entry = value as UnknownRecord
        const size = entry.size ?? entry.fileSize ?? entry.sizeBytes ?? entry.bytes
        if (size !== undefined && size !== null && size !== '') return size
      }
    }
  }
  return undefined
}

export function normalizeAdminSong(value: unknown): AdminSong {
  const record = asRecord(value) ?? {}
  const { album: legacyAlbum, ...canonicalRecord } = record
  const meta = asRecord(record.meta) ?? {}
  const albumRecord = asRecord(legacyAlbum)
  const nestedMetaAlbum = asRecord(meta.album)
  const songInfo = asRecord(record.songInfo) ?? {}
  const info = asRecord(record.info) ?? {}
  const data = asRecord(record.data) ?? {}
  const metadata = asRecord(record.metadata) ?? {}
  const songInfoMeta = asRecord(songInfo.meta) ?? {}
  const infoMeta = asRecord(info.meta) ?? {}
  const dataMeta = asRecord(data.meta) ?? {}
  const id = firstText(record.id, record.songmid, record.songId, record.hash, meta.songId, meta.songmid, meta.id)
  const name = firstText(record.name, record.title, record.songName, meta.name, meta.title, songInfo.name, songInfo.title, info.name, info.title, data.name, data.title)
  const artistValues = [record.artists, meta.artists, songInfo.artists, info.artists, data.artists].flatMap(value => Array.isArray(value) ? value.map(item => firstText(asRecord(item)?.name, asRecord(item)?.artist, asRecord(item)?.singer)) : []).filter(Boolean)
  const singer = firstText(record.singer, record.artist, record.artistName, meta.singer, meta.singerName, meta.artist, songInfo.singer, songInfo.artist, info.singer, info.artist, data.singer, data.artist, artistValues.join(' / '))
  const albumName = firstText(
    record.albumName,
    typeof legacyAlbum === 'string' ? legacyAlbum : undefined,
    record.albumname,
    record.albumTitle,
    albumRecord?.name,
    albumRecord?.title,
    albumRecord?.albumName,
    meta.albumName,
    nestedMetaAlbum?.name,
    nestedMetaAlbum?.title,
    songInfo.albumName,
    songInfo.albumTitle,
    asRecord(songInfo.album)?.name,
    asRecord(songInfo.album)?.title,
    info.albumName,
    asRecord(info.album)?.name,
    asRecord(info.album)?.title,
    data.albumName,
    asRecord(data.album)?.name,
    asRecord(data.album)?.title,
    metadata.albumName,
    asRecord(metadata.album)?.name,
    asRecord(metadata.album)?.title,
    songInfoMeta.albumName,
    infoMeta.albumName,
    dataMeta.albumName,
  )
  const img = firstText(record.img, record.picUrl, record.pic, record.cover, meta.picUrl, meta.img, meta.pic, meta.cover, songInfo.img, songInfo.picUrl, info.img, info.picUrl, data.img, data.picUrl, metadata.img, metadata.picUrl)
  const interval = firstText(record.interval, record.duration, record.durationMs, meta.interval, meta.duration, meta.durationMs, songInfo.interval, songInfo.duration, info.interval, info.duration, data.interval, data.duration)
  const size = record.size ?? record.fileSize ?? record.sizeBytes ?? record.bytes ?? meta.size ?? meta.fileSize ?? meta.sizeBytes ?? meta.bytes ?? songInfo.size ?? songInfo.fileSize ?? songInfo.sizeBytes ?? songInfo.bytes ?? info.size ?? info.fileSize ?? info.sizeBytes ?? info.bytes ?? data.size ?? data.fileSize ?? data.sizeBytes ?? data.bytes ?? metadata.size ?? metadata.fileSize ?? metadata.sizeBytes ?? metadata.bytes ?? qualitySize(record, record.quality ?? meta.quality ?? songInfo.quality ?? info.quality ?? data.quality) ?? qualitySize(meta, record.quality ?? meta.quality)
  const format = firstText(record.format, record.type, record.ext, record.quality, meta.format, meta.type, meta.ext, meta.quality, songInfo.format, songInfo.type, songInfo.ext, songInfo.quality, info.format, info.type, info.ext, info.quality, data.format, data.type, data.ext, data.quality)
  return {
    ...canonicalRecord,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(singer ? { singer } : {}),
    ...(albumName ? { albumName } : {}),
    ...(img ? { img } : {}),
    ...(interval ? { interval } : {}),
    ...(size !== undefined && size !== null && size !== '' ? { size } : {}),
    ...(format ? { format } : {}),
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
  users: (signal?: AbortSignal) => adminRequest<AdminUser[]>('/api/users', { signal }),
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
  customSources: async (owner: CustomSourceOwner = 'open', signal?: AbortSignal) => normalizeAdminCustomSources(await adminRequest<unknown>(`/api/custom-source/list?username=${encodeURIComponent(owner)}`, { signal })),
  uploadCustomSource: (filename: string, content: string, type: string, owner: CustomSourceOwner) => adminRequest('/api/custom-source/upload', { method: 'POST', body: JSON.stringify({ filename, content, type, username: owner }) }),
  importCustomSource: (url: string, filename: string | undefined, owner: CustomSourceOwner) => adminRequest('/api/custom-source/import', { method: 'POST', body: JSON.stringify({ url, filename, username: owner }) }),
  toggleCustomSource: (id: string, enabled: boolean, owner: CustomSourceOwner) => adminRequest('/api/custom-source/toggle', { method: 'POST', body: JSON.stringify({ id, enabled, username: owner }) }),
  deleteCustomSource: (id: string, owner: CustomSourceOwner) => adminRequest('/api/custom-source/delete', { method: 'POST', body: JSON.stringify({ id, sourceOwner: owner }) }),
  reorderCustomSources: (owner: CustomSourceOwner, sourceIds: string[]) => adminRequest('/api/custom-source/reorder', { method: 'POST', body: JSON.stringify({ username: owner, sourceIds }) }),
  assignCustomSource: (id: string, fromOwner: CustomSourceOwner, toOwner: CustomSourceOwner) => adminRequest('/api/custom-source/assign', { method: 'POST', body: JSON.stringify({ id, fromOwner, toOwner }) }),
}

export function playerUrl(config: RuntimeConfig): string {
  return String(config['player.path'] || '/music')
}
