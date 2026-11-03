import { create } from 'zustand'
import { readJson, writeJson } from '../../../../shared/src/storage'
import { scopedStorageKey } from '../session'
import type { Song } from '../types'
import { songKey } from '../types'

export type RecentSong = Song & { playedAt?: number; quality?: string }

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
    .slice(0, 50)
}

export function readPlayHistory(): RecentSong[] {
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  return normalizePlayHistory(readJson<unknown>(storage, scopedStorageKey('play_history'), []))
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
  hydrate: () => void
  record: (song: Song, quality?: string) => void
  reset: () => void
}

export const useRecentStore = create<RecentState>((set, get) => ({
  items: [],
  hydrate: () => set({ items: readPlayHistory() }),
  record: (song, quality) => set({ items: recordRecentItem(get().items, song, quality) }),
  reset: () => set({ items: [] }),
}))
