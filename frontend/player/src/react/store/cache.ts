import { create } from 'zustand'
import { playerApi, type CacheStats, type CacheTask } from '../api'
import type { Song } from '../types'
import { songKey } from '../types'
import { usePlayerUiStore } from './ui'

export type CacheTaskAction = 'pause' | 'resume' | 'remove'
export type CacheBatchAction = 'pause' | 'resume' | 'removeCompleted' | null
export type PlaybackCacheOptions = { cacheLyric?: boolean; embedLyric?: boolean }

export type CacheState = {
  tasks: CacheTask[]
  stats: CacheStats | null
  loading: boolean
  error: string
  loadedAt: number
  pendingTaskActions: Record<string, CacheTaskAction>
  pendingBatchAction: CacheBatchAction
  load: (options?: { force?: boolean }) => Promise<void>
  applyQueue: (tasks: CacheTask[]) => void
  enqueue: (song: Song, quality?: string, resolvedUrl?: string, options?: PlaybackCacheOptions) => Promise<void>
  enqueueDownloads: (songs: Song[], quality?: string) => Promise<number>
  pauseTask: (id: string) => Promise<boolean>
  resumeTask: (id: string) => Promise<boolean>
  pauseAll: () => Promise<boolean>
  resumeAll: () => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  removeCompleted: () => Promise<boolean>
  reset: () => void
}

let cacheLoadController: AbortController | null = null
let cacheRequestId = 0

export const useCacheStore = create<CacheState>((set, get) => ({
  tasks: [],
  stats: null,
  loading: false,
  error: '',
  loadedAt: 0,
  pendingTaskActions: {},
  pendingBatchAction: null,
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
  applyQueue: tasks => set({ tasks, loadedAt: Date.now(), error: '' }),
  enqueue: async (song, quality = 'flac', resolvedUrl, options = {}) => {
    const key = songKey(song)
    await playerApi.queueTasks([{
      id: key,
      songInfo: song,
      quality,
      background: true,
      cacheLyric: options.cacheLyric ?? true,
      embedLyric: options.embedLyric ?? true,
      ...(resolvedUrl ? { resolvedUrl } : {}),
    }])
    await get().load({ force: true })
  },
  enqueueDownloads: async (songs, quality = 'flac') => {
    const uniqueSongs: Song[] = []
    const seen = new Set<string>()
    for (const song of songs) {
      const key = songKey(song)
      if (!key || seen.has(key)) continue
      seen.add(key)
      uniqueSongs.push(song)
    }
    if (!uniqueSongs.length) return 0

    // The server accepts at most 100 tasks per request. Chunking keeps large
    // custom playlists supported while preserving one deduplicated queue.
    for (let offset = 0; offset < uniqueSongs.length; offset += 100) {
      const tasks = uniqueSongs.slice(offset, offset + 100).map(song => ({
        id: songKey(song),
        songInfo: song,
        quality,
        enableOnlyDownloadMode: true,
        cacheLyric: true,
        embedLyric: true,
      }))
      await playerApi.queueTasks(tasks)
    }
    await get().load({ force: true })
    return uniqueSongs.length
  },
  pauseTask: id => runTaskAction(get, set, id, 'pause', () => playerApi.stopQueue(id), '暂停下载失败'),
  resumeTask: id => runTaskAction(get, set, id, 'resume', () => playerApi.resumeQueue(id), '继续下载失败'),
  pauseAll: () => runBatchAction(get, set, 'pause', () => playerApi.stopQueue(undefined, true), '暂停全部下载失败'),
  resumeAll: () => runBatchAction(get, set, 'resume', () => playerApi.resumeQueue(undefined, true), '继续全部下载失败'),
  remove: id => runTaskAction(get, set, id, 'remove', () => playerApi.removeQueue(id), '移除下载任务失败'),
  removeCompleted: () => runBatchAction(get, set, 'removeCompleted', () => playerApi.removeQueue(undefined, false, true), '清理已完成任务失败'),
  reset: () => {
    cacheRequestId += 1
    cacheLoadController?.abort()
    cacheLoadController = null
    set({ tasks: [], stats: null, loading: false, error: '', loadedAt: 0, pendingTaskActions: {}, pendingBatchAction: null })
  },
}))

type CacheStoreGet = () => CacheState
type CacheStoreSet = (partial: Partial<CacheState> | ((state: CacheState) => Partial<CacheState>)) => void

async function runTaskAction(
  get: CacheStoreGet,
  set: CacheStoreSet,
  id: string,
  action: CacheTaskAction,
  request: () => Promise<unknown>,
  errorLabel: string,
): Promise<boolean> {
  if (!id || get().pendingTaskActions[id] || get().pendingBatchAction) return false
  set(state => ({ pendingTaskActions: { ...state.pendingTaskActions, [id]: action } }))
  try {
    await request()
    await get().load({ force: true })
    return true
  } catch (error) {
    usePlayerUiStore.getState().notifyPlayback(error instanceof Error ? error.message : errorLabel, 'error')
    return false
  } finally {
    set(state => {
      const pendingTaskActions = { ...state.pendingTaskActions }
      delete pendingTaskActions[id]
      return { pendingTaskActions }
    })
  }
}

async function runBatchAction(
  get: CacheStoreGet,
  set: CacheStoreSet,
  action: Exclude<CacheBatchAction, null>,
  request: () => Promise<unknown>,
  errorLabel: string,
): Promise<boolean> {
  if (get().pendingBatchAction || Object.keys(get().pendingTaskActions).length > 0) return false
  set({ pendingBatchAction: action })
  try {
    await request()
    await get().load({ force: true })
    return true
  } catch (error) {
    usePlayerUiStore.getState().notifyPlayback(error instanceof Error ? error.message : errorLabel, 'error')
    return false
  } finally {
    set({ pendingBatchAction: null })
  }
}
