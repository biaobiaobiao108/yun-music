import * as fileCache from '../../fileCache'
import { onMediaBudgetAvailable, tryAcquireDownloadSlot } from '../../resourceBudget'
import {
  activeSettled,
  activeTasks,
  concurrencyByUser,
  controllers,
  flushDownloadQueue,
  isQueueInitialized,
  loadTasks,
  markQueueInitialized,
  notifyQueueListeners,
  pauseTasks,
  saveNow,
  scheduleSave,
  tasks,
} from './store'
import {
  getTaskIdentity,
  getTaskProgressKey,
  isDownloadTaskRunnable,
  limitText,
  markDownloadTaskPausedIfAborted,
  normalizeConcurrency,
  sanitizeSongInfo,
  taskMapKey,
} from './model'
import {
  DEFAULT_CONCURRENT,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_QUALITY_LENGTH,
  RESOLVED_URL_TTL,
  type DownloadResolver,
  type ResolveResult,
  type ServerDownloadTask,
} from './types'

let resolver: DownloadResolver | null = null
let processing = false
const suspendedUsers = new Set<string>()
let allUsersSuspended = false
// Tasks paused by an instance-wide suspension are restored on release; tasks
// the user paused explicitly are not.
const suspendAllPausedKeys = new Set<string>()

export const getConcurrency = (username: string) => concurrencyByUser.get(username) || DEFAULT_CONCURRENT

const runTask = async (task: ServerDownloadTask) => {
  if (!resolver || task.status !== 'waiting') return
  const key = taskMapKey(task.username, task.id)
  // A resolver may fall back to another provider, but the resulting cache file
  // must remain addressable through the song the user originally requested.
  const requestedSongInfo = sanitizeSongInfo(task.songInfo)
  const targetOnlyDownloadMode = task.enableOnlyDownloadMode === true
  const controller = new AbortController()
  controllers.set(key, controller)
  activeTasks.set(key, task)
  let settle!: () => void
  activeSettled.set(
    key,
    new Promise<void>(resolve => {
      settle = resolve
    }),
  )
  task.progressKey = undefined
  task.status = 'downloading'
  task.progress = 0
  task.total = 0
  task.received = 0
  task.speed = 0
  task.errorMsg = ''
  task.updatedAt = Date.now()
  scheduleSave()
  notifyQueueListeners(task.username)

  try {
    const cached = fileCache.checkCache(
      { ...requestedSongInfo, quality: task.quality, exactQuality: true },
      task.username,
      false,
      { ignoreActiveProgress: true, preferredFolder: targetOnlyDownloadMode ? 'music' : 'cache' },
    )
    const hasReusableCache =
      cached.exists && !cached.isCollision && (cached.foundIn === task.username || targetOnlyDownloadMode)
    const suppliedUrl =
      task.resolvedUrl && task.resolvedUrlAt && Date.now() - task.resolvedUrlAt <= RESOLVED_URL_TTL
        ? task.resolvedUrl
        : undefined
    const suppliedUrlAt = task.resolvedUrlAt
    task.resolvedUrl = undefined
    task.resolvedUrlAt = undefined
    scheduleSave()
    let resolved = hasReusableCache
      ? { url: '', quality: task.quality, songInfo: task.songInfo }
      : suppliedUrl && suppliedUrlAt && Date.now() - suppliedUrlAt <= RESOLVED_URL_TTL
        ? {
            url: suppliedUrl,
            quality: task.quality,
            songInfo: task.songInfo,
            requestedSource: task.requestedSource,
            downloadSource: task.downloadSource,
            sourceName: task.sourceName,
          }
        : await resolver(task, controller.signal)
    if (markDownloadTaskPausedIfAborted(task, controller.signal.aborted)) return
    if (!resolved || (!resolved.url && !hasReusableCache)) throw new Error('无法解析下载地址')

    const applyResolvedTarget = (nextResolved: ResolveResult) => {
      task.songInfo = requestedSongInfo
      task.quality = limitText(nextResolved.quality || task.requestedQuality, MAX_QUALITY_LENGTH, 'quality', false)
      task.activeSongKey = fileCache.normalizeSongId(requestedSongInfo) + '_' + task.quality
      task.progressKey = getTaskProgressKey(task.username, task.id)
      task.updatedAt = Date.now()
      scheduleSave()
    }

    const downloadResolvedSong = async (nextResolved: ResolveResult) => {
      applyResolvedTarget(nextResolved)
      await fileCache.downloadAndCache(
        requestedSongInfo,
        nextResolved.url,
        task.quality,
        task.username,
        controller.signal,
        targetOnlyDownloadMode,
        task.cacheLyric,
        task.embedLyric,
        {
          requestedSource: nextResolved.requestedSource,
          downloadSource: nextResolved.downloadSource,
          sourceName: nextResolved.sourceName,
          progressKey: task.progressKey,
        },
      )
    }

    try {
      await downloadResolvedSong(resolved)
    } catch (firstError: any) {
      // A local cache can disappear before promotion, and a browser URL can
      // expire. Resolve once more before marking the task as failed.
      if ((!suppliedUrl && !hasReusableCache) || controller.signal.aborted) throw firstError
      console.warn(
        `[ServerDownloadQueue] Local cache or supplied URL failed for ${task.songKey}; refreshing source once`,
      )
      resolved = await resolver(task, controller.signal)
      if (markDownloadTaskPausedIfAborted(task, controller.signal.aborted)) return
      if (!resolved?.url) throw firstError
      await downloadResolvedSong(resolved)
    }

    if (markDownloadTaskPausedIfAborted(task, controller.signal.aborted)) return

    // If a new request changed the desired target while this download was in
    // flight, keep the same public task and run it once more for that target.
    if (task.enableOnlyDownloadMode !== targetOnlyDownloadMode) {
      task.status = 'waiting'
      task.quality = task.requestedQuality
      task.progress = 0
      task.total = 0
      task.received = 0
      task.speed = 0
      task.errorMsg = ''
      task.activeSongKey = undefined
      task.updatedAt = Date.now()
      return
    }

    const progress = task.activeSongKey
      ? fileCache.cacheProgress.get(task.progressKey || task.activeSongKey)
      : undefined
    task.status = progress?.status === 'exists' ? 'exists' : 'finished'
    task.progress = 100
    task.total = Number(progress?.total || progress?.received || task.total || 0)
    task.received = Number(progress?.received || task.total || 0)
    task.speed = 0
    task.errorMsg = ''
  } catch (err: any) {
    if (!markDownloadTaskPausedIfAborted(task, controller.signal.aborted || err?.message === 'Aborted')) {
      task.status = 'error'
      task.errorMsg = limitText(err?.message || '下载失败', MAX_ERROR_MESSAGE_LENGTH, 'errorMsg', false)
      console.error(`[ServerDownloadQueue] Task failed ${task.songKey}: ${task.errorMsg}`)
    }
    task.speed = 0
  } finally {
    controllers.delete(key)
    activeTasks.delete(key)
    activeSettled.delete(key)
    settle()
    task.progressKey = undefined
    task.updatedAt = Date.now()
    scheduleSave()
    notifyQueueListeners(task.username)
    void processQueue()
  }
}

export const processQueue = async () => {
  if (processing || !resolver) return
  processing = true
  try {
    while (true) {
      const activeByUser = new Map<string, number>()
      const activeIdentities = new Set<string>()
      let activeBackground = 0
      for (const [key, activeTask] of activeTasks) {
        const username = activeTask?.username
        if (!activeTask || !username) continue
        activeByUser.set(username, (activeByUser.get(username) || 0) + 1)
        activeIdentities.add(getTaskIdentity(activeTask))
        if (activeTask.background) activeBackground++
      }
      let next: ServerDownloadTask | undefined
      for (const task of tasks.values()) {
        if (allUsersSuspended || suspendedUsers.has(task.username)) continue
        if (
          !isDownloadTaskRunnable(
            task,
            activeByUser.get(task.username) || 0,
            activeBackground,
            activeIdentities,
            getConcurrency(task.username),
          )
        )
          continue
        if (
          !next ||
          Number(task.background) < Number(next.background) ||
          (task.background === next.background && task.createdAt < next.createdAt)
        ) {
          next = task
        }
      }
      if (!next) break
      const release = tryAcquireDownloadSlot()
      if (!release) break
      void runTask(next).finally(release)
    }
  } finally {
    processing = false
  }
}

export const setConcurrency = (username: string, value: unknown) => {
  const concurrency = normalizeConcurrency(value)
  concurrencyByUser.set(username, concurrency)
  saveNow()
  void processQueue()
  return concurrency
}

export const initialize = (downloadResolver: DownloadResolver) => {
  resolver = downloadResolver
  if (!isQueueInitialized()) {
    markQueueInitialized()
    onMediaBudgetAvailable(() => {
      void processQueue()
    })
    loadTasks()
    saveNow()
  }
  void processQueue()
}

/** Block new work and drain all workers before changing a user's files or identity. */
export const suspendUser = async (username: string) => {
  suspendedUsers.add(username)
  if (Array.from(tasks.values()).some(task => task.username === username)) pauseTasks(username)
  for (const [key, task] of activeTasks) {
    if (task.username === username) controllers.get(key)?.abort()
  }
  await Promise.all(
    Array.from(activeTasks.entries())
      .filter(([, task]) => task.username === username)
      .map(([key]) => activeSettled.get(key)),
  )
}

export const releaseUser = (username: string) => {
  suspendedUsers.delete(username)
  void processQueue()
}

/** Block new work and drain all workers across all users (for instance-wide backups/restores). */
export const suspendAll = async () => {
  allUsersSuspended = true
  const users = new Set<string>()
  for (const task of tasks.values()) users.add(task.username)
  for (const task of activeTasks.values()) users.add(task.username)
  users.add('_open')
  for (const [key, task] of tasks) {
    if (['waiting', 'downloading', 'tagging'].includes(task.status)) suspendAllPausedKeys.add(key)
  }
  await Promise.all(Array.from(users).map(username => suspendUser(username)))
}

const resumeSuspendedTasks = () => {
  const resumedUsers = new Set<string>()
  for (const key of suspendAllPausedKeys) {
    const task = tasks.get(key)
    if (!task || task.status !== 'paused') continue
    task.status = 'waiting'
    task.errorMsg = ''
    task.updatedAt = Date.now()
    resumedUsers.add(task.username)
  }
  suspendAllPausedKeys.clear()
  for (const username of resumedUsers) notifyQueueListeners(username)
  return resumedUsers
}

export const releaseAll = () => {
  allUsersSuspended = false
  suspendedUsers.clear()
  const resumedUsers = resumeSuspendedTasks()
  if (resumedUsers.size > 0) void saveNow()
  void processQueue()
}

export const shutdownDownloadQueue = async (): Promise<void> => {
  await suspendAll()
  resumeSuspendedTasks()
  await flushDownloadQueue()
}

export const getActiveTaskCount = (): number => activeTasks.size

export const isQueueWorkBlocked = (username: string) => allUsersSuspended || suspendedUsers.has(username)
