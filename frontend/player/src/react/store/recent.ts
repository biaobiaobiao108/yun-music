import { create } from 'zustand'
import { readJson, readString, writeJson, writeString } from '../../../../shared/src/storage'
import { getSessionScope, scopedStorageKey } from '../session'
import { playerApi } from '../api'
import type { Song } from '../types'
import { songKey } from '../types'

export type RecentSong = Song & { playedAt?: number; quality?: string }
const MAX_RECENT_SONGS = 50
const HISTORY_SYNC_DELAY_MS = 800

let historyRequestId = 0
let historyController: AbortController | null = null
let historySyncController: AbortController | null = null
let historySyncTimer: ReturnType<typeof setTimeout> | null = null
let historySyncPromise: Promise<void> | null = null

function historyStorageKey(): string {
  return scopedStorageKey('play_history')
}

function pendingHistoryStorageKey(): string {
  return scopedStorageKey('play_history_pending')
}

function cloudHistoryMigrationKey(): string {
  return scopedStorageKey('play_history_cloud_migrated:v1')
}

export function normalizePlayHistory(value: unknown): RecentSong[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .filter(item => Boolean(item && typeof item === 'object'))
    .map(item => item as RecentSong)
    .sort((a, b) => Number(b.playedAt || 0) - Number(a.playedAt || 0))
    .filter(song => {
      const key = songKey(song)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_RECENT_SONGS)
}

export function mergePlayHistory(...histories: unknown[]): RecentSong[] {
  const bySong = new Map<string, RecentSong>()
  for (const history of histories) {
    for (const song of normalizePlayHistory(history)) {
      const key = songKey(song)
      const previous = bySong.get(key)
      if (!previous || Number(song.playedAt || 0) >= Number(previous.playedAt || 0)) bySong.set(key, song)
    }
  }
  return normalizePlayHistory([...bySong.values()])
}

function findUnuploadedHistory(local: RecentSong[], remote: RecentSong[]): RecentSong[] {
  const remoteTimes = new Map(remote.map(song => [songKey(song), Number(song.playedAt || 0)]))
  return local.filter(song => {
    const remoteTime = remoteTimes.get(songKey(song))
    return remoteTime === undefined || Number(song.playedAt || 0) > remoteTime
  })
}

export function readPlayHistory(): RecentSong[] {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  return normalizePlayHistory(readJson<unknown>(storage, historyStorageKey(), []))
}

function writePlayHistory(items: RecentSong[]): void {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  writeJson(storage, historyStorageKey(), items)
}

function readPendingPlayHistory(): RecentSong[] {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  const value = readJson<unknown>(storage, pendingHistoryStorageKey(), [])
  if (!Array.isArray(value)) return []
  const itemsByKey = new Map(readPlayHistory().map(song => [songKey(song), song]))
  return value.flatMap(mark => {
    if (!mark || typeof mark !== 'object' || Array.isArray(mark)) return []
    const record = mark as Record<string, unknown>
    if (typeof record.key !== 'string' || typeof record.playedAt !== 'number') return []
    const song = itemsByKey.get(record.key)
    return song && Number(song.playedAt || 0) >= record.playedAt ? [song] : []
  })
}

function writePendingPlayHistory(items: RecentSong[]): void {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  const marks = normalizePlayHistory(items).map(song => ({ key: songKey(song), playedAt: Number(song.playedAt || 0) }))
  writeJson(storage, pendingHistoryStorageKey(), marks)
}

function historyEntryVersion(song: RecentSong): string {
  return `${songKey(song)}\u0000${Number(song.playedAt || 0)}`
}

function removeSyncedPendingItems(items: RecentSong[]): void {
  const synced = new Set(items.map(historyEntryVersion))
  writePendingPlayHistory(readPendingPlayHistory().filter(song => !synced.has(historyEntryVersion(song))))
}

function isAccountSession(): boolean {
  return getSessionScope().startsWith('user:')
}

function scheduleHistorySync(): void {
  if (!isAccountSession() || readPendingPlayHistory().length === 0) return
  if (historySyncTimer) clearTimeout(historySyncTimer)
  historySyncTimer = setTimeout(() => {
    historySyncTimer = null
    void flushPendingPlayHistory()
  }, HISTORY_SYNC_DELAY_MS)
}

function flushPendingPlayHistory(): Promise<void> {
  if (historySyncPromise) return historySyncPromise
  const scope = getSessionScope()
  if (!scope.startsWith('user:')) return Promise.resolve()
  const pending = readPendingPlayHistory()
  if (pending.length === 0) return Promise.resolve()

  const controller = new AbortController()
  historySyncController = controller
  let succeeded = false
  let promise!: Promise<void>
  promise = playerApi
    .savePlayHistory(pending, controller.signal)
    .then(result => {
      if (controller.signal.aborted || getSessionScope() !== scope) return
      succeeded = true
      removeSyncedPendingItems(pending)
      const remaining = readPendingPlayHistory()
      writePlayHistory(mergePlayHistory(result.items, remaining))
    })
    .catch(error => {
      if (!controller.signal.aborted && getSessionScope() === scope)
        console.warn('[Recent] 云端播放历史同步失败，已保留本地记录：', error)
    })
    .finally(() => {
      if (historySyncPromise === promise) {
        historySyncPromise = null
        historySyncController = null
        if (succeeded && readPendingPlayHistory().length > 0) scheduleHistorySync()
      }
    })
  historySyncPromise = promise
  return promise
}

async function hydratePlayHistory(setItems: (items: RecentSong[]) => void): Promise<void> {
  const localItems = readPlayHistory()
  setItems(localItems)
  const scope = getSessionScope()
  historyController?.abort()
  const requestId = ++historyRequestId
  if (!scope.startsWith('user:')) return

  const controller = new AbortController()
  historyController = controller
  try {
    const remote = await playerApi.playHistory(controller.signal)
    if (controller.signal.aborted || requestId !== historyRequestId || getSessionScope() !== scope) return

    let pending = readPendingPlayHistory()
    const storage = typeof localStorage === 'undefined' ? null : localStorage
    const needsMigration = readString(storage, cloudHistoryMigrationKey()) !== '1'
    if (!remote.exists || needsMigration) {
      // Merge this account's pre-cloud browser history once, without uploading
      // copies already present on the server.
      pending = mergePlayHistory(pending, findUnuploadedHistory(localItems, remote.items))
      writePendingPlayHistory(pending)
    }
    writeString(storage, cloudHistoryMigrationKey(), '1')
    const merged = mergePlayHistory(remote.items, pending)
    writePlayHistory(merged)
    setItems(merged)
    if (pending.length > 0) scheduleHistorySync()
  } catch (error) {
    if (controller.signal.aborted || requestId !== historyRequestId || getSessionScope() !== scope) return
    // Keep local playback usable offline and retry the unsynced history after
    // the next successful play or the next session hydration.
    writePendingPlayHistory(mergePlayHistory(readPendingPlayHistory(), localItems))
    console.warn('[Recent] 云端播放历史读取失败，已保留本地记录：', error)
  } finally {
    if (historyController === controller) historyController = null
  }
}

export function appendPlayHistory(song: Song, quality?: string): RecentSong[] {
  const next: RecentSong = { ...song, ...(quality ? { quality } : {}), playedAt: Date.now() }
  const history = normalizePlayHistory([next, ...readPlayHistory()])
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  writeJson(storage, scopedStorageKey('play_history'), history)
  return history
}

export function recordRecentItem(currentItems: RecentSong[], song: Song, quality?: string): RecentSong[] {
  const nextItem: RecentSong = { ...song, ...(quality ? { quality } : {}), playedAt: Date.now() }
  appendPlayHistory(song, quality)

  const key = songKey(song)
  const existingIndex = currentItems.findIndex(item => songKey(item) === key)

  if (existingIndex >= 0) {
    // 歌曲已经在当前列表中：在原位更新元数据，不原地改变排序打乱用户视觉和产生跳跃闪烁
    const updated = [...currentItems]
    updated[existingIndex] = { ...updated[existingIndex]!, ...nextItem }
    return updated
  }

  // 首次播放的新歌：在头部追加，上限50首
  return [nextItem, ...currentItems].slice(0, 50)
}

export type RecentState = {
  items: RecentSong[]
  hydrate: () => Promise<void>
  record: (song: Song, quality?: string) => void
  reset: () => void
}

export const useRecentStore = create<RecentState>((set, get) => ({
  items: [],
  hydrate: () => hydratePlayHistory(items => set({ items })),
  record: (song, quality) => {
    const items = recordRecentItem(get().items, song, quality)
    set({ items })
    if (!isAccountSession()) return
    const latest = items.find(item => songKey(item) === songKey(song))
    if (latest) writePendingPlayHistory(mergePlayHistory(readPendingPlayHistory(), [latest]))
    scheduleHistorySync()
  },
  reset: () => {
    historyRequestId += 1
    historyController?.abort()
    historyController = null
    historySyncController?.abort()
    historySyncController = null
    historySyncPromise = null
    if (historySyncTimer) clearTimeout(historySyncTimer)
    historySyncTimer = null
    set({ items: [] })
  },
}))
