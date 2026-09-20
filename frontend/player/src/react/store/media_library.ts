import { create } from 'zustand'
import { playerApi } from '../api'
import { invalidateRequestCache, isAbortError } from '../data/request'
import type { Song } from '../types'

let mediaController: AbortController | null = null
let mediaRequestId = 0

function normalizeLibraryItems(payload: unknown): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['list', 'items', 'data', 'result', 'albums', 'artists']) {
    if (Array.isArray(record[key])) return record[key] as Song[]
  }
  return []
}

export type MediaLibraryState = {
  albums: Song[]
  artists: Song[]
  loading: boolean
  refreshing: boolean
  error: string
  loadedAt: number
  hydrate: (options?: { force?: boolean }) => Promise<void>
  invalidate: () => void
}

export const useMediaLibraryStore = create<MediaLibraryState>((set, get) => ({
  albums: [],
  artists: [],
  loading: false,
  refreshing: false,
  error: '',
  loadedAt: 0,
  hydrate: async (options = {}) => {
    const hadController = Boolean(mediaController)
    mediaController?.abort()
    const controller = new AbortController()
    mediaController = controller
    const requestId = ++mediaRequestId
    const force = options.force ?? hadController
    set({ loading: true, refreshing: get().albums.length > 0 || get().artists.length > 0, error: '' })
    try {
      const [albums, artists] = await Promise.all([
        playerApi.libraryAlbums(controller.signal, { cacheKey: 'media-library:albums', cacheTtlMs: 60_000, force }),
        playerApi.libraryArtists(controller.signal, { cacheKey: 'media-library:artists', cacheTtlMs: 60_000, force }),
      ])
      if (!controller.signal.aborted && requestId === mediaRequestId) set({ albums: normalizeLibraryItems(albums), artists: normalizeLibraryItems(artists), loadedAt: Date.now() })
    } catch (error) {
      if (!controller.signal.aborted && requestId === mediaRequestId && !isAbortError(error)) set({ error: error instanceof Error ? error.message : '媒体库加载失败' })
    } finally {
      if (mediaController === controller) {
        mediaController = null
        set({ loading: false, refreshing: false })
      }
    }
  },
  invalidate: () => {
    mediaRequestId += 1
    mediaController?.abort()
    invalidateRequestCache('media-library:')
    set({ loadedAt: 0 })
  },
}))

export function normalizeMediaLibraryItems(payload: unknown): Song[] {
  return normalizeLibraryItems(payload)
}
