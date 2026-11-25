import * as fileCache from '../../fileCache'
import {
  captureUserQueueState,
  concurrencyByUser,
  controllers,
  deduplicateTasksInMemory,
  flushDownloadQueue,
  getPublicTask,
  notifyQueueListeners,
  pauseTasks,
  pendingCountByUser,
  rebuildTaskIndexes,
  restoreUserQueueState,
  saveNow,
  scheduleSave,
  taskIdentityIndex,
  tasks,
} from './store'
import {
  getTaskIdentity,
  normalizeQueueInput,
  resumableStatuses,
  sanitizeId,
  sanitizeSongInfo,
  taskMapKey,
  terminalStatuses,
} from './model'
import { isQueueWorkBlocked, processQueue } from './scheduler'
import {
  MAX_PENDING_TASKS_PER_USER,
  MAX_TOTAL_TASKS,
  type QueueInput,
  type ServerDownloadStatus,
  type ServerDownloadTask,
} from './types'

const targetFolderForInput = (input: QueueInput): fileCache.CacheFolder =>
  input.enableOnlyDownloadMode === true ? 'music' : 'cache'

const hasRequestedTarget = (username: string, input: QueueInput, quality: string): boolean => {
  const targetFolder = targetFolderForInput(input)
  try {
    const cached = fileCache.checkCache({ ...input.songInfo, quality, exactQuality: true }, username, false, {
      preferredFolder: targetFolder,
    })
    return (
      cached.exists === true &&
      cached.isCollision !== true &&
      cached.folder === targetFolder &&
      (targetFolder !== 'music' || cached.foundIn === username)
    )
  } catch {
    return false
  }
}

const markTaskAsExisting = (task: ServerDownloadTask, username: string, input: QueueInput, quality: string) => {
  const now = Date.now()
  task.songKey = fileCache.normalizeSongId(input.songInfo) + '_' + quality
  task.activeSongKey = undefined
  task.progressKey = undefined
  task.songInfo = sanitizeSongInfo(input.songInfo)
  task.quality = quality
  task.requestedQuality = quality
  task.status = 'exists'
  task.progress = 100
  task.total = 0
  task.received = 0
  task.speed = 0
  task.errorMsg = ''
  task.enableOnlyDownloadMode = !!input.enableOnlyDownloadMode
  task.cacheLyric = input.cacheLyric !== false
  task.embedLyric = input.embedLyric !== false
  task.background = input.background === true
  task.resolvedUrl = undefined
  task.resolvedUrlAt = undefined
  task.requestedSource = input.requestedSource
  task.downloadSource = input.downloadSource
  task.sourceName = input.sourceName
  task.username = username
  task.createdAt = now
  task.updatedAt = now
}

export const enqueue = (username: string, inputs: QueueInput[]) => {
  if (isQueueWorkBlocked(username)) throw new Error('用户数据正在迁移或删除')
  if (inputs.length > 100) throw new Error('Too many tasks in one request')
  const normalizedInputs = inputs.filter(input => input?.songInfo).map(normalizeQueueInput)
  deduplicateTasksInMemory()
  const pendingCount = pendingCountByUser.get(username) || 0
  const chargedTaskKeys = new Set<string>()
  const chargedIdentities = new Set<string>()
  let pendingAdds = 0
  for (const input of normalizedInputs) {
    const identity = getTaskIdentity({
      username,
      songInfo: input.songInfo,
      quality: input.quality || '320k',
      requestedQuality: input.quality || '320k',
      songKey: '',
      activeSongKey: undefined,
    })
    const id = sanitizeId(input.id)
    const existingKey = taskIdentityIndex.get(identity)
    const existing = tasks.get(taskMapKey(username, id)) || (existingKey ? tasks.get(existingKey) : undefined)
    if (existing && resumableStatuses.has(existing.status)) continue
    if (hasRequestedTarget(username, input, input.quality || '320k')) continue

    // A batch can create several transient records for one identity; saving
    // the queue deduplicates those records, so they reserve only one slot.
    if (chargedIdentities.has(identity)) continue
    const hasExplicitId = /^[A-Za-z0-9_-]{1,160}$/.test(String(input.id || ''))
    // Multiple inputs with the same explicit ID reuse one task record even
    // when their song identities differ.
    if (hasExplicitId) {
      const taskKey = taskMapKey(username, id)
      if (chargedTaskKeys.has(taskKey)) continue
      chargedTaskKeys.add(taskKey)
    }
    chargedIdentities.add(identity)
    pendingAdds++
  }
  if (pendingCount + pendingAdds > MAX_PENDING_TASKS_PER_USER) throw new Error('Too many pending download tasks')
  if (tasks.size + pendingAdds > MAX_TOTAL_TASKS) throw new Error('下载队列任务总数已达上限')
  const added: ServerDownloadTask[] = []
  for (const input of normalizedInputs) {
    let id = sanitizeId(input.id)
    const requestedKey = taskMapKey(username, id)
    if (controllers.has(requestedKey) && !tasks.has(requestedKey)) {
      // A removed task may still be unwinding an aborted resolver. Do not
      // reuse its controller key while that execution still owns a slot.
      do {
        id = sanitizeId(undefined)
      } while (controllers.has(taskMapKey(username, id)) || tasks.has(taskMapKey(username, id)))
    }
    const key = taskMapKey(username, id)
    const quality = input.quality || '320k'
    const identity = getTaskIdentity({
      username,
      songInfo: input.songInfo,
      quality,
      requestedQuality: quality,
      songKey: '',
      activeSongKey: undefined,
    })
    const existingKey = taskIdentityIndex.get(identity)
    const existing = tasks.get(key) || (existingKey ? tasks.get(existingKey) : undefined)
    const targetFolder = targetFolderForInput(input)
    const targetExists = hasRequestedTarget(username, input, quality)
    if (existing) {
      // Automatic playback caching must not alter an explicit library request,
      // including paused and completed downloads.
      if (existing.enableOnlyDownloadMode && input.background === true && !input.enableOnlyDownloadMode) continue
      if (['waiting', 'downloading', 'tagging'].includes(existing.status)) {
        // Keep one queue record per song/quality (and therefore one public ID),
        // but remember a newly requested /music target even when the current
        // download is already running. runTask will perform the second step
        // after the current target finishes.
        const targetOnlyDownloadMode = input.enableOnlyDownloadMode === true
        if (targetOnlyDownloadMode && !existing.enableOnlyDownloadMode) {
          existing.enableOnlyDownloadMode = true
          existing.updatedAt = Date.now()
          scheduleSave()
        }
        // An explicit download upgrades a background cache task's priority.
        existing.background = existing.background && input.background === true
        if (input.resolvedUrl && existing.status === 'waiting') {
          existing.resolvedUrl = input.resolvedUrl
          existing.resolvedUrlAt = Date.now()
        }
        continue
      }

      if (targetExists) {
        if (targetFolder === 'music') fileCache.removeDuplicateCacheForSong(input.songInfo, quality, username)
        if (
          terminalStatuses.has(existing.status) &&
          existing.enableOnlyDownloadMode === (input.enableOnlyDownloadMode === true) &&
          input.background === true
        ) {
          // A completed background cache request must stay terminal. Replaying
          // the same URL should not start another download just because the
          // player resolved it again from localStorage.
          continue
        }
        markTaskAsExisting(existing, username, input, quality)
        added.push(existing)
        continue
      }

      const now = Date.now()
      existing.songKey = fileCache.normalizeSongId(input.songInfo) + '_' + quality
      existing.activeSongKey = undefined
      existing.progressKey = undefined
      existing.songInfo = sanitizeSongInfo(input.songInfo)
      existing.quality = quality
      existing.requestedQuality = quality
      existing.status = 'waiting'
      existing.progress = 0
      existing.total = 0
      existing.received = 0
      existing.speed = 0
      existing.errorMsg = ''
      existing.enableOnlyDownloadMode = !!input.enableOnlyDownloadMode
      existing.cacheLyric = input.cacheLyric !== false
      existing.embedLyric = input.embedLyric !== false
      existing.background = input.background === true
      existing.resolvedUrl = input.resolvedUrl
      existing.resolvedUrlAt = input.resolvedUrl ? now : undefined
      existing.requestedSource = input.requestedSource
      existing.downloadSource = input.downloadSource
      existing.sourceName = input.sourceName
      existing.createdAt = now
      existing.updatedAt = now
      added.push(existing)
      continue
    }

    if (targetExists) {
      if (targetFolder === 'music') fileCache.removeDuplicateCacheForSong(input.songInfo, quality, username)
      const now = Date.now()
      const task: ServerDownloadTask = {
        id,
        username,
        songKey: fileCache.normalizeSongId(input.songInfo) + '_' + quality,
        songInfo: sanitizeSongInfo(input.songInfo),
        quality,
        requestedQuality: quality,
        status: 'exists',
        progress: 100,
        total: 0,
        received: 0,
        speed: 0,
        errorMsg: '',
        enableOnlyDownloadMode: !!input.enableOnlyDownloadMode,
        cacheLyric: input.cacheLyric !== false,
        embedLyric: input.embedLyric !== false,
        background: input.background === true,
        requestedSource: input.requestedSource,
        downloadSource: input.downloadSource,
        sourceName: input.sourceName,
        createdAt: now,
        updatedAt: now,
      }
      tasks.set(key, task)
      added.push(task)
      continue
    }

    const now = Date.now()
    const task: ServerDownloadTask = {
      id,
      username,
      songKey: fileCache.normalizeSongId(input.songInfo) + '_' + quality,
      songInfo: sanitizeSongInfo(input.songInfo),
      quality,
      requestedQuality: quality,
      status: 'waiting',
      progress: 0,
      total: 0,
      received: 0,
      speed: 0,
      errorMsg: '',
      enableOnlyDownloadMode: !!input.enableOnlyDownloadMode,
      cacheLyric: input.cacheLyric !== false,
      embedLyric: input.embedLyric !== false,
      background: input.background === true,
      resolvedUrl: input.resolvedUrl,
      resolvedUrlAt: input.resolvedUrl ? now : undefined,
      requestedSource: input.requestedSource,
      downloadSource: input.downloadSource,
      sourceName: input.sourceName,
      createdAt: now,
      updatedAt: now,
    }
    tasks.set(key, task)
    added.push(task)
  }
  rebuildTaskIndexes()
  saveNow()
  notifyQueueListeners(username)
  void processQueue()
  // saveNow() de-duplicates the batch; do not return tasks that were merged
  // away, or the client will hold ids that the queue no longer recognises.
  return added.filter(task => tasks.get(taskMapKey(task.username, task.id)) === task).map(task => getPublicTask(task))
}

/**
 * Return the live cache task for a song/quality without exposing its resolved
 * URL. The player uses this to distinguish "not cached" from "cache is still
 * being downloaded" and must not start another paid source request while the
 * latter is true.
 */
export const getActiveTaskProgress = (username: string, songInfo: any, quality?: string) => {
  const requestedQuality = String(quality || 'unknown')
  const songKeys = new Set(fileCache.getSongIdCandidates(songInfo).map(songId => `${songId}_${requestedQuality}`))
  const activeStatuses = new Set<ServerDownloadStatus>(['waiting', 'downloading', 'tagging'])
  const task = Array.from(tasks.values()).find(
    candidate =>
      candidate.username === username &&
      activeStatuses.has(candidate.status) &&
      (songKeys.has(candidate.songKey) || songKeys.has(candidate.activeSongKey || '')),
  )
  if (!task) return null
  return {
    status: task.status,
    progress: task.progress,
    total: task.total,
    received: task.received,
    speed: task.speed,
    updatedAt: task.updatedAt,
  }
}

/**
 * Return progress entries only for tasks owned by the requested user. The
 * underlying cache map is process-global, so callers must not read it by key
 * without first checking task ownership.
 */
export const getProgressForUser = (username: string, ids: string[]) => {
  const progress: Record<string, any> = {}
  for (const id of ids) {
    const task = Array.from(tasks.values()).find(
      candidate => candidate.username === username && (candidate.songKey === id || candidate.activeSongKey === id),
    )
    if (!task) continue
    const value = task.progressKey ? fileCache.cacheProgress.get(task.progressKey) : undefined
    if (value) progress[id] = value
  }
  return progress
}

export const pause = (username: string, id?: string) => {
  pauseTasks(username, id)
}

export const pauseBySongKey = (username: string, songKey: string) => {
  const normalizedSongKey = String(songKey || '')
  for (const task of tasks.values()) {
    if (task.username !== username) continue
    if (task.songKey !== normalizedSongKey && task.activeSongKey !== normalizedSongKey) continue
    if (!['waiting', 'downloading', 'tagging'].includes(task.status)) continue
    task.status = 'paused'
    task.speed = 0
    task.errorMsg = '已暂停'
    task.updatedAt = Date.now()
    controllers.get(taskMapKey(username, task.id))?.abort()
  }
  saveNow()
  notifyQueueListeners(username)
}

export const resume = (username: string, id?: string) => {
  for (const task of tasks.values()) {
    if (task.username !== username || (id && task.id !== id)) continue
    if (task.status !== 'paused' && task.status !== 'error') continue
    task.status = 'waiting'
    task.progress = 0
    task.total = 0
    task.received = 0
    task.speed = 0
    task.errorMsg = ''
    task.activeSongKey = undefined
    task.quality = task.requestedQuality
    task.updatedAt = Date.now()
  }
  saveNow()
  notifyQueueListeners(username)
  void processQueue()
}

export const remove = (username: string, options: { id?: string; all?: boolean; completed?: boolean }) => {
  for (const [key, task] of tasks) {
    if (task.username !== username) continue
    const shouldRemove =
      options.all ||
      (options.id && task.id === options.id) ||
      (options.completed && ['finished', 'exists'].includes(task.status))
    if (!shouldRemove) continue
    controllers.get(key)?.abort()
    tasks.delete(key)
  }
  rebuildTaskIndexes()
  saveNow()
  notifyQueueListeners(username)
  void processQueue()
}

/** The archive does not contain queue state. Keep tasks only for surviving account names. */
export const reconcileRestoredQueue = async (usernames: readonly string[]): Promise<void> => {
  const active = new Set(['_open', ...usernames])
  const removedUsers = [
    ...new Set([...[...tasks.values()].map(task => task.username), ...concurrencyByUser.keys()]),
  ].filter(username => !active.has(username))
  if (!removedUsers.length) return
  const previous = captureUserQueueState(removedUsers)
  const removed = new Set(removedUsers)
  for (const [key, task] of tasks) if (removed.has(task.username)) tasks.delete(key)
  for (const username of removedUsers) concurrencyByUser.delete(username)
  rebuildTaskIndexes()
  try {
    await flushDownloadQueue()
  } catch (error) {
    restoreUserQueueState(removedUsers, previous)
    throw error
  }
  for (const username of removedUsers) notifyQueueListeners(username)
}

/** Only called after workers settle; pending work remains paused for explicit resume. */
export const renameUser = async (username: string, newName: string) => {
  if (!Array.from(tasks.values()).some(task => task.username === username) && !concurrencyByUser.has(username)) return
  const usernames = [username, newName]
  const previousState = captureUserQueueState(usernames)
  try {
    for (const [key, task] of tasks) {
      if (task.username !== username) continue
      tasks.delete(key)
      task.username = newName
      task.resolvedUrl = undefined
      task.resolvedUrlAt = undefined
      tasks.set(taskMapKey(newName, task.id), task)
    }
    const concurrency = concurrencyByUser.get(username)
    concurrencyByUser.delete(username)
    if (concurrency !== undefined) concurrencyByUser.set(newName, concurrency)
    rebuildTaskIndexes()
    await saveNow(true)
  } catch (error) {
    restoreUserQueueState(usernames, previousState)
    notifyQueueListeners(username)
    notifyQueueListeners(newName)
    throw error
  }
  notifyQueueListeners(username)
  notifyQueueListeners(newName)
}

export const removeUser = async (username: string) => {
  if (!Array.from(tasks.values()).some(task => task.username === username) && !concurrencyByUser.has(username)) return
  const previousState = captureUserQueueState([username])
  for (const [key, task] of tasks) {
    if (task.username !== username) continue
    controllers.get(key)?.abort()
    tasks.delete(key)
  }
  concurrencyByUser.delete(username)
  rebuildTaskIndexes()
  try {
    await saveNow(true)
  } catch (error) {
    restoreUserQueueState([username], previousState)
    notifyQueueListeners(username)
    void processQueue()
    throw error
  }
  notifyQueueListeners(username)
  void processQueue()
}
