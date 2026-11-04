import { create } from 'zustand'
import { parseLyric, playerApi } from '../api'
import { isAbortError } from '../data/request'
import { songKey, type LyricLine, type Song } from '../types'

let lyricController: AbortController | null = null
let currentLoadedSongKey = ''
let inFlightSongKey = ''
let inFlightPromise: Promise<void> | null = null
const lyricCache = new Map<string, LyricLine[]>()
const MAX_CACHED_LYRICS = 64

export type LyricState = {
  lines: LyricLine[]
  loading: boolean
  error: string
  activeIndex: number
  load: (song: Song | null) => Promise<void>
  reset: () => void
}

export const useLyricStore = create<LyricState>(set => ({
  lines: [],
  loading: false,
  error: '',
  activeIndex: -1,
  load: async song => {
    if (!song) {
      lyricController?.abort()
      lyricController = null
      currentLoadedSongKey = ''
      inFlightSongKey = ''
      inFlightPromise = null
      set({ lines: [], loading: false, activeIndex: -1, error: '' })
      return
    }
    const key = songKey(song)
    const cached = lyricCache.get(key)
    if (cached) {
      lyricController?.abort()
      lyricController = null
      currentLoadedSongKey = key
      inFlightSongKey = ''
      inFlightPromise = null
      set({ lines: cached, loading: false, error: '', activeIndex: -1 })
      return
    }
    if (currentLoadedSongKey === key && useLyricStore.getState().lines.length > 0) {
      return
    }
    if (inFlightSongKey === key && inFlightPromise) {
      return inFlightPromise
    }
    lyricController?.abort()
    const controller = new AbortController()
    lyricController = controller
    inFlightSongKey = key
    set({ lines: [], activeIndex: -1, loading: true, error: '' })
    const promise = (async () => {
      try {
        const payload = await playerApi.lyric(song, controller.signal)
        if (!controller.signal.aborted) {
          const lines = parseLyric(payload)
          if (lines.length > 0) {
            lyricCache.set(key, lines)
            while (lyricCache.size > MAX_CACHED_LYRICS) {
              const oldest = lyricCache.keys().next().value
              if (oldest !== undefined) lyricCache.delete(oldest)
            }
          }
          currentLoadedSongKey = key
          set({ lines, activeIndex: -1, error: '' })
        }
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          set({ error: error instanceof Error ? error.message : '歌词加载失败' })
        }
      } finally {
        if (lyricController === controller) {
          lyricController = null
          inFlightSongKey = ''
          inFlightPromise = null
          set({ loading: false })
        }
      }
    })()
    inFlightPromise = promise
    return promise
  },
  reset: () => {
    lyricController?.abort()
    lyricController = null
    currentLoadedSongKey = ''
    inFlightSongKey = ''
    inFlightPromise = null
    lyricCache.clear()
    set({ lines: [], loading: false, error: '', activeIndex: -1 })
  },
}))
