import { create } from 'zustand'
import { parseLyric, playerApi } from '../api'
import { isAbortError } from '../data/request'
import type { LyricLine, Song } from '../types'

let lyricController: AbortController | null = null

export type LyricState = { lines: LyricLine[]; loading: boolean; error: string; activeIndex: number; load: (song: Song | null) => Promise<void> }

export const useLyricStore = create<LyricState>(set => ({
  lines: [],
  loading: false,
  error: '',
  activeIndex: -1,
  load: async song => {
    if (!song) {
      set({ lines: [], activeIndex: -1, error: '' })
      return
    }
    lyricController?.abort()
    const controller = new AbortController()
    lyricController = controller
    set({ loading: true, error: '' })
    try {
      const payload = await playerApi.lyric(song, controller.signal)
      if (!controller.signal.aborted) set({ lines: parseLyric(payload), activeIndex: -1 })
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) set({ error: error instanceof Error ? error.message : '歌词加载失败' })
    } finally {
      if (lyricController === controller) {
        lyricController = null
        set({ loading: false })
      }
    }
  },
}))
