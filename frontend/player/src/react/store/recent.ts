import { create } from 'zustand'
import { readJson, writeJson } from '../../../../shared/src/storage'
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
  return normalizePlayHistory(readJson<unknown>(storage, 'play_history', []))
}

export function appendPlayHistory(song: Song, quality?: string): RecentSong[] {
  const next: RecentSong = { ...song, ...(quality ? { quality } : {}), playedAt: Date.now() }
  const history = normalizePlayHistory([next, ...readPlayHistory()])
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  writeJson(storage, 'play_history', history)
  return history
}

export type RecentState = { items: RecentSong[]; hydrate: () => void; record: (song: Song, quality?: string) => void }

export const useRecentStore = create<RecentState>(set => ({
  items: [],
  hydrate: () => set({ items: readPlayHistory() }),
  record: (song, quality) => set({ items: appendPlayHistory(song, quality) }),
}))
