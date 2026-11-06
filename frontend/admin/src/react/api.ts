import { requestBlob, requestJson } from '../../../shared/src/http'
import { parseByteSize } from '../../../shared/src/runtime'
import type { RuntimeConfig } from '../../../shared/src/runtime'

export type AdminUser = { name: string; hasPassword?: boolean }
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
export type StorageItem = Record<string, unknown> & {
  id?: string
  filename?: string
  rawUsername?: string
  name?: string
  singer?: string
  albumName?: string
  size?: number
  folder?: 'cache' | 'music'
  location?: 'data' | 'root' | string
  mtime?: number
}
export type DatabaseStorageStats = {
  pageSize: number
  pageCount: number
  freelistCount: number
  logicalBytes: number
  freeBytes: number
  fileBytes: number
  walBytes: number
  shmBytes: number
  totalBytes: number
}
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
  status?: string
  error?: string
  canUpdate?: boolean
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
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
    ...(firstText(record.status) ? { status: firstText(record.status) } : {}),
    ...(firstText(record.error) ? { error: firstText(record.error) } : {}),
    ...(record.canUpdate === true ? { canUpdate: true } : {}),
  }
}

export function normalizeAdminCustomSources(payload: unknown): AdminCustomSource[] {
  const values = Array.isArray(payload) ? payload : arrayValue(asRecord(payload)?.data ?? payload)
  return values.map(normalizeCustomSource).filter((value): value is AdminCustomSource => Boolean(value))
}

export const adminRequest = <T>(path: string, init?: RequestInit) => requestJson<T>(path, init)

export async function login(password: string): Promise<void> {
  await adminRequest('/api/login', { method: 'POST', body: JSON.stringify({ password }) })
}

export async function logout(): Promise<void> {
  await adminRequest('/api/logout', { method: 'POST' })
}

export async function verifySession(): Promise<AdminStatus> {
  return adminRequest<AdminStatus>('/api/status')
}

export const adminApi = {
  status: (signal?: AbortSignal) => adminRequest<AdminStatus>('/api/status', { signal }),
  users: (signal?: AbortSignal) => adminRequest<AdminUser[]>('/api/users', { signal }),
  config: (signal?: AbortSignal) => adminRequest<AdminConfig>('/api/config', { signal }),
  saveConfig: (config: Record<string, unknown>) =>
    adminRequest<{ success: boolean; warning?: string }>('/api/config', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  logs: (type: string, signal?: AbortSignal) =>
    adminRequest<{ logs?: string[]; lines?: string[] }>(`/api/logs?type=${encodeURIComponent(type)}&lines=300`, {
      signal,
    }),
  cacheStats: () => adminRequest<{ success?: boolean; data?: Record<string, unknown> }>('/api/music/cache/stats'),
  cacheList: (user: string, signal?: AbortSignal) =>
    adminRequest<{ success?: boolean; data?: StorageItem[] }>(
      `/api/music/cache/list?user=${encodeURIComponent(user)}`,
      { signal },
    ),
  removeCache: (items: Array<{ filename: string; folder?: 'cache' | 'music'; location?: string; user?: string }>) =>
    adminRequest('/api/music/cache/remove', { method: 'POST', body: JSON.stringify({ items }) }),
  moveCache: (items: Array<{ filename: string; location?: string; user?: string }>) =>
    adminRequest('/api/music/cache/move', { method: 'POST', body: JSON.stringify({ items }) }),
  clearCache: (user: string) =>
    adminRequest(`/api/music/cache/clear?user=${encodeURIComponent(user)}`, { method: 'POST' }),
  addUser: (name: string, password: string) =>
    adminRequest('/api/users', { method: 'POST', body: JSON.stringify({ name, password }) }),
  updateUser: (name: string, payload: { newName?: string; password?: string }) =>
    adminRequest('/api/users', { method: 'PUT', body: JSON.stringify({ name, ...payload }) }),
  deleteUsers: (names: string[], deleteData: boolean) =>
    adminRequest('/api/users', { method: 'DELETE', body: JSON.stringify({ names, deleteData }) }),
  reload: () => adminRequest('/api/admin/reload', { method: 'POST' }),
  restart: () => adminRequest('/api/restart', { method: 'POST' }),
  databaseStats: () => adminRequest<{ success?: boolean; data?: DatabaseStorageStats }>('/api/admin/database/stats'),
  vacuum: () =>
    adminRequest<{
      success?: boolean
      data?: { before: DatabaseStorageStats; after: DatabaseStorageStats; reclaimedBytes: number }
    }>('/api/admin/database/vacuum', { method: 'POST' }),
  backup: () => requestBlob('/api/backup/download'),
  // Raw body upload: the server streams it straight to a temp file, so a
  // 100 MB backup never has to be copied through memory three times.
  restoreBackup: (file: File) =>
    adminRequest('/api/backup/upload', { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } }),
  customSources: async (owner: CustomSourceOwner = 'open', signal?: AbortSignal) =>
    normalizeAdminCustomSources(
      await adminRequest<unknown>(`/api/custom-source/list?username=${encodeURIComponent(owner)}`, { signal }),
    ),
  uploadCustomSource: (filename: string, content: string, type: string, owner: CustomSourceOwner) =>
    adminRequest('/api/custom-source/upload', {
      method: 'POST',
      body: JSON.stringify({ filename, content, type, username: owner }),
    }),
  importCustomSource: (url: string, filename: string | undefined, owner: CustomSourceOwner) =>
    adminRequest('/api/custom-source/import', {
      method: 'POST',
      body: JSON.stringify({ url, filename, username: owner }),
    }),
  updateCustomSource: (id: string, owner: CustomSourceOwner, url?: string) =>
    adminRequest('/api/custom-source/update', {
      method: 'POST',
      body: JSON.stringify({ id, sourceOwner: owner, ...(url ? { url } : {}) }),
    }),
  toggleCustomSource: (id: string, enabled: boolean, owner: CustomSourceOwner) =>
    adminRequest('/api/custom-source/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, enabled, username: owner }),
    }),
  deleteCustomSource: (id: string, owner: CustomSourceOwner) =>
    adminRequest('/api/custom-source/delete', { method: 'POST', body: JSON.stringify({ id, sourceOwner: owner }) }),
  reorderCustomSources: (owner: CustomSourceOwner, sourceIds: string[]) =>
    adminRequest('/api/custom-source/reorder', {
      method: 'POST',
      body: JSON.stringify({ username: owner, sourceIds }),
    }),
  assignCustomSource: (id: string, fromOwner: CustomSourceOwner, toOwner: CustomSourceOwner) =>
    adminRequest('/api/custom-source/assign', { method: 'POST', body: JSON.stringify({ id, fromOwner, toOwner }) }),
}

export function playerUrl(config: RuntimeConfig): string {
  return String(config['player.path'] || '/music')
}
