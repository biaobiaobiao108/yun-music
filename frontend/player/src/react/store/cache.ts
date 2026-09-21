import { create } from 'zustand'
import { playerApi, type CacheStats, type CacheTask } from '../api'
import type { Song } from '../types'
import { songKey } from '../types'

export type CacheState = {
  tasks: CacheTask[]
  stats: CacheStats | null
  loading: boolean
  error: string
  loadedAt: number
  load: (options?: { force?: boolean }) => Promise<void>
  enqueue: (song: Song, quality?: string, resolvedUrl?: string) => Promise<void>
  remove: (id: string) => Promise<void>
  removeCompleted: () => Promise<void>
}

let cacheLoadController: AbortController | null = null
let cacheRequestId = 0

export const useCacheStore = create<CacheState>((set, get) => ({
  tasks: [],
  stats: null,
  loading: false,
  error: '',
  loadedAt: 0,
  load: async (options = {}) => {
    const hadController = Boolean(cacheLoadController)
    cacheLoadController?.abort()
    const controller = new AbortController()
    cacheLoadController = controller
    const requestId = ++cacheRequestId
    set({ loading: true, error: '' })
    try {
      const [queue, stats] = await Promise.all([
        playerApi.cacheQueue(controller.signal, { cacheKey: 'cache:queue', cacheTtlMs: 5_000, force: options.force ?? hadController }),
        playerApi.cacheStats(controller.signal, { cacheKey: 'cache:stats', cacheTtlMs: 5_000, force: options.force ?? hadController }),
      ])
      if (!controller.signal.aborted && requestId === cacheRequestId) set({ tasks: queue.data ?? [], stats: stats.data ?? null, loadedAt: Date.now() })
    } catch (error) {
      if (!controller.signal.aborted && requestId === cacheRequestId) set({ error: error instanceof Error ? error.message : '缓存加载失败' })
    } finally {
      if (cacheLoadController === controller) {
        cacheLoadController = null
        set({ loading: false })
      }
    }
  },
  enqueue: async (song, quality = 'flac', resolvedUrl) => {
    const key = songKey(song)
    await playerApi.queueTasks([{ id: key, songInfo: song, quality, ...(resolvedUrl ? { resolvedUrl } : {}) }])
    await get().load({ force: true })
  },
  remove: async id => {
    await playerApi.removeQueue(id)
    await get().load({ force: true })
  },
  removeCompleted: async () => {
    await playerApi.removeQueue(undefined, false, true)
    await get().load({ force: true })
  },
}))
