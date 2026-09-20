import { requestBlob, requestJson } from '../../../shared/src/http'
import type { RuntimeConfig } from '../../../shared/src/runtime'

export type AdminUser = { name: string; hasPassword?: boolean }
export type AdminSong = Record<string, unknown> & { id?: string; name?: string; singer?: string; album?: string; img?: string }
export type AdminPlaylist = { id: string; name: string; list?: AdminSong[] }
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
  userData: (user: string) => adminRequest<AdminData>(`/api/data?user=${encodeURIComponent(user)}`),
  config: () => adminRequest<AdminConfig>('/api/config'),
  saveConfig: (config: Record<string, unknown>) => adminRequest<{ success: boolean; warning?: string }>('/api/config', { method: 'POST', body: JSON.stringify(config) }),
  logs: (type: string) => adminRequest<{ logs?: string[]; lines?: string[] }>(`/api/logs?type=${encodeURIComponent(type)}&lines=300`),
  snapshots: (user: string) => adminRequest<Snapshot[]>(`/api/data/snapshots?user=${encodeURIComponent(user)}`),
  snapshot: (user: string, id: string) => adminRequest<AdminData>(`/api/data/snapshot?id=${encodeURIComponent(id)}&user=${encodeURIComponent(user)}`),
  restoreSnapshot: (user: string, id: string) => adminRequest(`/api/data/restore-snapshot?user=${encodeURIComponent(user)}`, { method: 'POST', body: JSON.stringify({ id }) }),
  deleteSnapshot: (user: string, id: string) => adminRequest(`/api/data/delete-snapshot?user=${encodeURIComponent(user)}`, { method: 'POST', body: JSON.stringify({ id }) }),
  uploadSnapshot: (user: string, file: File) => file.text().then(content => adminRequest(`/api/data/upload-snapshot?user=${encodeURIComponent(user)}&time=${file.lastModified || Date.now()}&filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: content, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })),
  cacheStats: () => adminRequest<{ success?: boolean; data?: Record<string, unknown> }>('/api/music/cache/stats'),
  cacheList: (user: string) => adminRequest<{ success?: boolean; data?: StorageItem[] }>(`/api/music/cache/list?user=${encodeURIComponent(user)}`),
  removeCache: (items: Array<{ filename: string; folder?: 'cache' | 'music'; user?: string }>) => adminRequest('/api/music/cache/remove', { method: 'POST', body: JSON.stringify({ items }) }),
  clearCache: (user: string) => adminRequest(`/api/music/cache/clear?user=${encodeURIComponent(user)}`, { method: 'POST' }),
  deletePlaylist: (username: string, playlistId: string) => adminRequest('/api/data/delete-playlist', { method: 'POST', body: JSON.stringify({ username, playlistId }) }),
  deleteSong: (username: string, playlistId: string, songId: string) => adminRequest('/api/data/delete-song', { method: 'POST', body: JSON.stringify({ username, playlistId, songId }) }),
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
