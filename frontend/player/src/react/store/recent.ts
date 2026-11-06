import { create } from 'zustand'
import { readJson, writeJson } from '../../../../shared/src/storage'
import { getSessionScope, scopedStorageKey } from '../session'
import { playerApi } from '../api'
import type { Song } from '../types'
import { songKey } from '../types'
import { usePlayerUiStore } from './ui'

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

// The server list is already ordered; client clocks must not reorder it.
function orderedPlayHistory(value: unknown): RecentSong[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .filter((song): song is RecentSong => {
      if (!song || typeof song !== 'object') return false
      const key = songKey(song)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_RECENT_SONGS)
}

export function readPlayHistory(): RecentSong[] {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  return orderedPlayHistory(readJson<unknown>(storage, historyStorageKey(), []))
}

function writePlayHistory(items: RecentSong[]): void {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  writeJson(storage, historyStorageKey(), items)
}

type PendingEvent = { id: string; song: RecentSong }
const pendingMemory = new Map<string, PendingEvent>()
let listenersInstalled = false
let historyRevision = 0
let latestServerRevision = 0
let storageWarningShown = false

function eventPrefix(): string {
  return `${scopedStorageKey('play_history_event')}:`
}

function newEventId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  )
}

function savePendingEvent(event: PendingEvent): boolean {
  const key = eventPrefix() + event.id
  try {
    localStorage.setItem(key, JSON.stringify(event))
    return true
  } catch (error) {
    pendingMemory.set(key, event)
    console.warn('[Recent] 无法持久保存待同步记录：', error)
    if (!storageWarningShown && typeof window !== 'undefined') {
      storageWarningShown = true
      usePlayerUiStore.getState().notifyPlayback('无法保存离线播放记录，关闭页面后可能丢失', 'warning')
    }
    return false
  }
}

function readPendingEvents(): PendingEvent[] {
  const prefix = eventPrefix()
  const events = new Map<string, PendingEvent>()
  for (const [key, event] of pendingMemory) if (key.startsWith(prefix)) events.set(key, event)
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      const event = readJson<PendingEvent | null>(localStorage, key, null)
      if (event && typeof event.id === 'string' && event.song && typeof event.song === 'object') events.set(key, event)
    }
  } catch (error) {
    console.warn('[Recent] 无法读取待同步记录：', error)
  }
  return [...events.values()].sort((a, b) => Number(a.song.playedAt || 0) - Number(b.song.playedAt || 0))
}

function migratePendingHistory(): void {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  if (!storage) return
  const marks = readJson<unknown>(storage, pendingHistoryStorageKey(), [])
  if (!Array.isArray(marks) || !marks.length) return
  const songs = new Map(readPlayHistory().map(song => [songKey(song), song]))
  let migrated = true
  for (const mark of marks) {
    if (
      !mark ||
      typeof mark !== 'object' ||
      typeof mark.key !== 'string' ||
      typeof mark.playedAt !== 'number' ||
      !Number.isFinite(mark.playedAt)
    )
      continue
    const song = songs.get(mark.key)
    if (song && Number(song.playedAt || 0) >= Number(mark.playedAt || 0)) {
      // Stable across tabs so concurrent migration cannot submit the same old mark twice.
      const input = `${mark.key}:${String(mark.playedAt)}`
      let a = 2166136261
      let b = 0x9e3779b9
      for (let i = 0; i < input.length; i++) {
        a = Math.imul(a ^ input.charCodeAt(i), 16777619)
        b = Math.imul(b ^ input.charCodeAt(i), 2246822519)
      }
      const id = `legacy-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${String(mark.playedAt).replace(/[^0-9]/g, '')}`
      if (!savePendingEvent({ id, song })) migrated = false
    }
  }
  if (!migrated) return
  try {
    storage.removeItem(pendingHistoryStorageKey())
  } catch (error) {
    console.warn('[Recent] 迁移待同步记录失败：', error)
  }
}

function isAccountSession(): boolean {
  return getSessionScope().startsWith('user:')
}

function scheduleHistorySync(): void {
  if (!isAccountSession() || readPendingEvents().length === 0) return
  if (historySyncTimer) clearTimeout(historySyncTimer)
  historySyncTimer = setTimeout(() => {
    historySyncTimer = null
    void flushPendingPlayHistory()
  }, HISTORY_SYNC_DELAY_MS)
}

function snapshotKey(): string {
  return scopedStorageKey('play_history_snapshot')
}

function applyRemoteHistory(items: RecentSong[], revision: number, broadcast = true, force = false): boolean {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  const snapshot = readJson<{ revision: number; items: RecentSong[] } | null>(storage, snapshotKey(), null)
  const knownRevision = Math.max(latestServerRevision, snapshot?.revision ?? 0)
  if (!force && revision < knownRevision) return false
  latestServerRevision = revision
  const pending = readPendingEvents()
    .map(event => event.song)
    .reverse()
  const merged = orderedPlayHistory([...pending, ...items])
  writePlayHistory(merged)
  useRecentStore.setState({ items: merged })
  if (broadcast) writeJson(storage, snapshotKey(), { revision, items })
  return true
}

function flushPendingPlayHistory(): Promise<void> {
  if (historySyncPromise) return historySyncPromise
  const scope = getSessionScope()
  if (!scope.startsWith('user:')) return Promise.resolve()
  const pending = readPendingEvents().slice(0, 50)
  if (!pending.length) return Promise.resolve()
  const prefix = eventPrefix()
  const controller = new AbortController()
  historySyncController = controller
  let succeeded = false
  let promise!: Promise<void>
  promise = playerApi
    .savePlayHistoryEvents(pending, controller.signal)
    .then(result => {
      if (controller.signal.aborted || getSessionScope() !== scope) return
      succeeded = true
      historyRevision++
      for (const event of pending) {
        const key = prefix + event.id
        pendingMemory.delete(key)
        try {
          localStorage.removeItem(key)
        } catch (error) {
          console.warn('[Recent] 清除待同步记录失败：', error)
        }
      }
      if (!applyRemoteHistory(result.items, result.revision)) void useRecentStore.getState().hydrate()
    })
    .catch(error => {
      if (!controller.signal.aborted && getSessionScope() === scope)
        console.warn('[Recent] 云端播放历史同步失败，已保留本地记录：', error)
    })
    .finally(() => {
      if (historySyncPromise === promise) {
        historySyncPromise = null
        historySyncController = null
        if (succeeded && readPendingEvents().length > 0) scheduleHistorySync()
      }
    })
  historySyncPromise = promise
  return promise
}

async function hydratePlayHistory(setItems: (items: RecentSong[]) => void): Promise<void> {
  if (useRecentStore.getState().items.length === 0) setItems(readPlayHistory())
  const scope = getSessionScope()
  historyController?.abort()
  const requestId = ++historyRequestId
  if (!scope.startsWith('user:')) return
  migratePendingHistory()
  scheduleHistorySync()
  const controller = new AbortController()
  historyController = controller
  const revision = historyRevision
  try {
    const remote = await playerApi.playHistory(controller.signal, latestServerRevision || undefined)
    if (
      controller.signal.aborted ||
      requestId !== historyRequestId ||
      getSessionScope() !== scope ||
      revision !== historyRevision
    )
      return
    if (remote.unchanged) return
    if (!applyRemoteHistory(remote.items, remote.revision)) {
      // A restored backup can legitimately move the server revision backwards.
      // Confirm with a fresh read before accepting a lower revision.
      const storage = typeof localStorage === 'undefined' ? null : localStorage
      const before = readJson<{ revision: number; items: RecentSong[] } | null>(storage, snapshotKey(), null)
      const confirmed = await playerApi.playHistory(controller.signal)
      if (
        controller.signal.aborted ||
        requestId !== historyRequestId ||
        getSessionScope() !== scope ||
        revision !== historyRevision
      )
        return
      const after = readJson<{ revision: number; items: RecentSong[] } | null>(storage, snapshotKey(), null)
      if (after && after.revision > (before?.revision ?? 0) && after.revision > confirmed.revision) {
        applyRemoteHistory(after.items, after.revision, false)
      } else {
        applyRemoteHistory(confirmed.items, confirmed.revision, true, true)
      }
    }
  } catch (error) {
    if (!controller.signal.aborted && requestId === historyRequestId && getSessionScope() === scope)
      console.warn('[Recent] 云端播放历史读取失败，已保留本地记录：', error)
  } finally {
    if (historyController === controller) historyController = null
  }
}

function installHistoryListeners(): void {
  if (listenersInstalled || typeof window === 'undefined') return
  listenersInstalled = true
  const refresh = () => {
    if (!isAccountSession() || document.visibilityState === 'hidden') return
    void useRecentStore.getState().hydrate()
  }
  window.addEventListener('online', refresh)
  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('storage', event => {
    if (!isAccountSession()) return
    if (event.key?.startsWith(eventPrefix())) scheduleHistorySync()
    if (event.key === snapshotKey() && event.newValue) {
      try {
        const snapshot = JSON.parse(event.newValue) as { revision: number; items: RecentSong[] }
        if (Array.isArray(snapshot.items) && typeof snapshot.revision === 'number')
          applyRemoteHistory(snapshot.items, snapshot.revision, false)
      } catch (error) {
        console.warn('[Recent] 同步其他标签页失败：', error)
      }
    }
  })
  window.setInterval(refresh, 30000)
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
  hydrate: () => {
    installHistoryListeners()
    return hydratePlayHistory(items => set({ items }))
  },
  record: (song, quality) => {
    const items = recordRecentItem(get().items, song, quality)
    set({ items })
    if (!isAccountSession()) return
    const latest = items.find(item => songKey(item) === songKey(song))
    if (latest) savePendingEvent({ id: newEventId(), song: latest })
    scheduleHistorySync()
  },
  reset: () => {
    latestServerRevision = 0
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
