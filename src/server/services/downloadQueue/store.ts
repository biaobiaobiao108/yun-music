import fs from 'node:fs'
import path from 'node:path'
import * as fileCache from '../../fileCache'
import {
  deduplicateDownloadTasks,
  filterPersistedTasksForUsers,
  getTaskIdentity,
  limitText,
  normalizeConcurrency,
  pruneDownloadHistory,
  resumableStatuses,
  sanitizeId,
  sanitizeSongInfo,
  serializeDownloadTask,
  shouldReplaceTask,
  taskMapKey,
  terminalStatuses,
  validStatuses,
} from './model'
import {
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_QUALITY_LENGTH,
  MAX_QUEUE_SNAPSHOT_BYTES,
  MAX_SOURCE_FIELD_LENGTH,
  MAX_SONG_FIELD_LENGTH,
  MAX_TASK_SNAPSHOT_BYTES,
  MAX_TOTAL_TASKS,
  type ServerDownloadStatus,
  type ServerDownloadTask,
} from './types'

export const tasks = new Map<string, ServerDownloadTask>()
export const controllers = new Map<string, AbortController>()
// Removed tasks keep their execution slot until their resolver/download settles.
export const activeTasks = new Map<string, ServerDownloadTask>()
export const activeSettled = new Map<string, Promise<void>>()
export const concurrencyByUser = new Map<string, number>()
export const taskIdentityIndex = new Map<string, string>()
export const pendingCountByUser = new Map<string, number>()

let initialized = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()
let saveInProgress = false
let pendingSave: { file: string; payload: string } | null = null

const getQueueFile = () => path.join(global.lx.dataPath, 'server-download-queue.json')

export const isQueueInitialized = () => initialized
export const markQueueInitialized = () => {
  initialized = true
}

/** Rebuild the small lookup indexes after a batch of queue mutations. */
export const rebuildTaskIndexes = (): void => {
  taskIdentityIndex.clear()
  pendingCountByUser.clear()
  for (const task of tasks.values()) {
    if (resumableStatuses.has(task.status)) {
      pendingCountByUser.set(task.username, (pendingCountByUser.get(task.username) || 0) + 1)
    }
    const identity = getTaskIdentity(task)
    const currentKey = taskIdentityIndex.get(identity)
    const current = currentKey ? tasks.get(currentKey) : undefined
    if (!current || shouldReplaceTask(current, task)) {
      taskIdentityIndex.set(identity, taskMapKey(task.username, task.id))
    }
  }
}

export const deduplicateTasksInMemory = () => {
  const currentTasks = Array.from(tasks.values())
  const retainedTasks = deduplicateDownloadTasks(currentTasks)
  if (retainedTasks.length === currentTasks.length) {
    rebuildTaskIndexes()
    return false
  }

  const retainedKeys = new Set(retainedTasks.map(task => taskMapKey(task.username, task.id)))
  for (const task of currentTasks) {
    const key = taskMapKey(task.username, task.id)
    if (!retainedKeys.has(key)) controllers.get(key)?.abort()
  }

  tasks.clear()
  retainedTasks.forEach(task => tasks.set(taskMapKey(task.username, task.id), task))
  rebuildTaskIndexes()
  return true
}

const pruneHistory = () => {
  const retained = pruneDownloadHistory(Array.from(tasks.values()))
  const removed = tasks.size - retained.length
  if (removed > 0) {
    tasks.clear()
    retained.forEach(task => tasks.set(taskMapKey(task.username, task.id), task))
  }
  rebuildTaskIndexes()
  return removed
}

const pruneGlobalTaskLimit = () => {
  if (tasks.size <= MAX_TOTAL_TASKS) return 0
  const candidates = Array.from(tasks.entries()).sort(([, left], [, right]) => {
    const terminalDifference = Number(terminalStatuses.has(right.status)) - Number(terminalStatuses.has(left.status))
    return terminalDifference || left.updatedAt - right.updatedAt
  })
  let removed = 0
  for (const [key] of candidates) {
    if (tasks.size <= MAX_TOTAL_TASKS) break
    tasks.delete(key)
    removed++
  }
  if (removed > 0) rebuildTaskIndexes()
  return removed
}

const buildQueuePayload = () =>
  JSON.stringify(
    {
      version: 2,
      concurrencyByUser: Object.fromEntries(concurrencyByUser),
      tasks: Array.from(tasks.values()).map(serializeDownloadTask),
    },
    null,
    2,
  )

const buildBoundedQueuePayload = () => {
  let payload = buildQueuePayload()
  let overflow = Buffer.byteLength(payload) - MAX_QUEUE_SNAPSHOT_BYTES
  if (overflow <= 0) return payload

  const terminalTasks = Array.from(tasks.entries())
    .filter(([, task]) => !resumableStatuses.has(task.status))
    .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
  let removed = 0
  while (overflow > 0 && terminalTasks.length > 0) {
    const removeCount = Math.max(1, Math.ceil(overflow / MAX_TASK_SNAPSHOT_BYTES))
    for (const [key] of terminalTasks.splice(0, removeCount)) {
      if (!tasks.delete(key)) continue
      removed++
    }
    payload = buildQueuePayload()
    overflow = Buffer.byteLength(payload) - MAX_QUEUE_SNAPSHOT_BYTES
  }

  if (removed > 0) {
    rebuildTaskIndexes()
    console.log(`[ServerDownloadQueue] Removed ${removed} old history task(s) to bound queue storage`)
  }
  if (overflow > 0) throw new Error('下载队列快照超过大小上限')
  return payload
}

export const saveNow = (throwOnError = false): Promise<void> => {
  if (!initialized) return Promise.resolve()
  deduplicateTasksInMemory()
  const removed = pruneHistory()
  if (removed > 0) {
    console.log(`[ServerDownloadQueue] Pruned ${removed} old history task(s)`)
  }
  const globallyRemoved = pruneGlobalTaskLimit()
  if (globallyRemoved > 0) {
    console.log(`[ServerDownloadQueue] Removed ${globallyRemoved} task(s) to enforce the global queue limit`)
  }
  const file = getQueueFile()
  const payload = buildBoundedQueuePayload()
  // Keep at most the active write plus the newest pending snapshot. Slow disks
  // must not accumulate a promise closure (and full JSON payload) per update.
  pendingSave = { file, payload }
  if (!saveInProgress) {
    saveInProgress = true
    saveChain = (async () => {
      let lastError: unknown
      try {
        while (pendingSave) {
          const current = pendingSave
          pendingSave = null
          const tempFile = `${current.file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
          try {
            await fs.promises.mkdir(path.dirname(current.file), { recursive: true })
            await Bun.write(tempFile, current.payload)
            await fs.promises.rename(tempFile, current.file)
            lastError = undefined
          } catch (err) {
            lastError = err
            console.warn('[ServerDownloadQueue] Failed to save queue:', err)
            try {
              await fs.promises.unlink(tempFile)
            } catch {}
          }
        }
        if (lastError) throw lastError
      } finally {
        saveInProgress = false
      }
    })()
    // Background state changes are best-effort; explicit identity changes
    // await this same promise and receive any persistence error.
    void saveChain.catch(() => {})
  }
  return throwOnError ? saveChain : saveChain.catch(() => {})
}

export const scheduleSave = () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 150)
}

export const flushDownloadQueue = (): Promise<void> => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  return saveNow(true)
}

export const captureUserQueueState = (usernames: string[]) => {
  const selected = new Set(usernames)
  return {
    tasks: Array.from(tasks.entries())
      .filter(([, task]) => selected.has(task.username))
      .map(([key, task]) => ({ key, task, values: { ...task } })),
    concurrency: usernames.map(username => [username, concurrencyByUser.get(username)] as const),
  }
}

export const restoreUserQueueState = (usernames: string[], state: ReturnType<typeof captureUserQueueState>) => {
  const selected = new Set(usernames)
  for (const [key, task] of tasks) {
    if (selected.has(task.username)) tasks.delete(key)
  }
  for (const { key, task, values } of state.tasks) {
    Object.assign(task, values)
    tasks.set(key, task)
  }
  for (const username of usernames) concurrencyByUser.delete(username)
  for (const [username, concurrency] of state.concurrency) {
    if (concurrency !== undefined) concurrencyByUser.set(username, concurrency)
  }
  rebuildTaskIndexes()
}

/**
 * Remove temp files left behind by an atomic write that never completed
 * (SIGKILL / OOM kill / power loss). The write path only unlinks its own temp
 * file on a caught error, so nothing else would ever collect them.
 */
const cleanupOrphanTempFiles = (file: string): void => {
  const directory = path.dirname(file)
  const prefix = `${path.basename(file)}.`
  let entries: string[]
  try {
    entries = fs.readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue
    try {
      fs.unlinkSync(path.join(directory, entry))
    } catch {
      // A live writer may still own it; leave it for the next start.
    }
  }
}

export const loadTasks = () => {
  const file = getQueueFile()
  cleanupOrphanTempFiles(file)
  if (!fs.existsSync(file)) return
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const savedTasks = Array.isArray(data) ? data : data?.tasks
    if (!Array.isArray(savedTasks)) return
    const activeUsernames = new Set<string>(
      (global.lx?.config?.users || []).map((user: any) => String(user?.name || '')).filter(Boolean),
    )
    const activeQueueUsernames = new Set(activeUsernames)
    activeQueueUsernames.add('_open')
    if (!Array.isArray(data) && data?.concurrencyByUser && typeof data.concurrencyByUser === 'object') {
      for (const [username, value] of Object.entries(data.concurrencyByUser)) {
        if (!activeQueueUsernames.has(username)) continue
        concurrencyByUser.set(username, normalizeConcurrency(value))
      }
    }
    const restoredTasks: ServerDownloadTask[] = []
    const retainedSavedTasks = filterPersistedTasksForUsers(savedTasks, activeUsernames)
    for (const raw of retainedSavedTasks) {
      if (!raw || !raw.username || !raw.songInfo) continue
      const id = sanitizeId(raw.id)
      const savedStatus = validStatuses.has(raw.status) ? (raw.status as ServerDownloadStatus) : 'waiting'
      const status: ServerDownloadStatus =
        savedStatus === 'downloading' || savedStatus === 'tagging' ? 'waiting' : savedStatus
      const quality = limitText(raw.quality || raw.requestedQuality || '320k', MAX_QUALITY_LENGTH, 'quality', false)
      const requestedQuality = limitText(raw.requestedQuality || quality, MAX_QUALITY_LENGTH, 'requestedQuality', false)
      const now = Date.now()
      const createdAt = Number(raw.createdAt || now)
      const task: ServerDownloadTask = {
        id,
        username: String(raw.username),
        songKey: limitText(
          raw.songKey || `${fileCache.normalizeSongId(raw.songInfo)}_${requestedQuality}`,
          MAX_SONG_FIELD_LENGTH + MAX_QUALITY_LENGTH + 1,
          'songKey',
          false,
        ),
        activeSongKey:
          status === 'waiting'
            ? undefined
            : raw.activeSongKey
              ? limitText(raw.activeSongKey, MAX_SONG_FIELD_LENGTH + MAX_QUALITY_LENGTH + 1, 'activeSongKey', false)
              : undefined,
        songInfo: sanitizeSongInfo(raw.songInfo),
        quality: status === 'waiting' ? requestedQuality : quality,
        requestedQuality,
        status,
        progress: status === 'waiting' ? 0 : Number(raw.progress || 0),
        total: status === 'waiting' ? 0 : Number(raw.total || 0),
        received: status === 'waiting' ? 0 : Number(raw.received || 0),
        speed: 0,
        errorMsg:
          status === 'waiting' ? '' : limitText(raw.errorMsg || '', MAX_ERROR_MESSAGE_LENGTH, 'errorMsg', false),
        enableOnlyDownloadMode: !!raw.enableOnlyDownloadMode,
        cacheLyric: raw.cacheLyric !== false,
        embedLyric: raw.embedLyric !== false,
        background: raw.background === true,
        requestedSource: raw.requestedSource
          ? limitText(raw.requestedSource, MAX_SOURCE_FIELD_LENGTH, 'requestedSource', false)
          : undefined,
        downloadSource: raw.downloadSource
          ? limitText(raw.downloadSource, MAX_SOURCE_FIELD_LENGTH, 'downloadSource', false)
          : undefined,
        sourceName: raw.sourceName
          ? limitText(raw.sourceName, MAX_SOURCE_FIELD_LENGTH, 'sourceName', false)
          : undefined,
        createdAt,
        updatedAt: Number(raw.updatedAt || createdAt),
      }
      restoredTasks.push(task)
    }
    deduplicateDownloadTasks(restoredTasks).forEach(task => tasks.set(taskMapKey(task.username, task.id), task))
    pruneHistory()
    rebuildTaskIndexes()
    const discardedCount = savedTasks.length - retainedSavedTasks.length
    console.log(
      `[ServerDownloadQueue] Restored ${tasks.size} persisted tasks${discardedCount ? `; discarded ${discardedCount} task(s) for inactive users` : ''}`,
    )
  } catch (err) {
    console.warn('[ServerDownloadQueue] Failed to restore queue:', err)
  }
}

export const getPublicTask = (task: ServerDownloadTask) => {
  const live =
    task.status === 'downloading' && task.activeSongKey && controllers.has(taskMapKey(task.username, task.id))
      ? fileCache.cacheProgress.get(task.progressKey || task.activeSongKey)
      : undefined
  // A transient cache progress entry must never downgrade a terminal queue
  // state. In particular, lyric/tagging cleanup can outlive the audio task.
  const liveStatus = ['downloading', 'tagging', 'finished', 'exists'].includes(String(live?.status))
    ? (live?.status as ServerDownloadStatus)
    : undefined
  return {
    id: task.id,
    songKey: task.activeSongKey || task.songKey,
    songInfo: task.songInfo,
    quality: task.quality,
    requestedQuality: task.requestedQuality,
    enableOnlyDownloadMode: task.enableOnlyDownloadMode,
    status: liveStatus || task.status,
    progress: Number(live?.progress ?? task.progress ?? 0),
    total: Number(live?.total ?? task.total ?? 0),
    received: Number(live?.received ?? task.received ?? 0),
    speed: Number(live?.speed ?? task.speed ?? 0),
    background: task.background,
    errorMsg: limitText(live?.errorMsg || task.errorMsg || '', MAX_ERROR_MESSAGE_LENGTH, 'errorMsg', false),
    createdAt: task.createdAt,
    updatedAt: Number(live?.updatedAt || task.updatedAt),
  }
}

export type PublicDownloadTask = ReturnType<typeof getPublicTask>
export type QueueListener = (tasks: PublicDownloadTask[]) => void
const queueListeners = new Map<string, Set<QueueListener>>()
const queueSnapshots = new Map<string, string>()
let queueBroadcastTimer: ReturnType<typeof setTimeout> | null = null
const QUEUE_BROADCAST_INTERVAL = 250

export const list = (username: string) => {
  return Array.from(tasks.values())
    .filter(task => task.username === username)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(task => getPublicTask(task))
}

export const notifyQueueListeners = (username: string): void => {
  const listeners = queueListeners.get(username)
  if (!listeners?.size) return
  scheduleQueueBroadcast()

  const snapshot = list(username)
  const serialized = JSON.stringify(snapshot)
  if (queueSnapshots.get(username) === serialized) return
  queueSnapshots.set(username, serialized)
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch {
      /* one disconnected client must not stop the others */
    }
  }
}

const getActiveQueueUsernames = (): Set<string> => new Set(Array.from(activeTasks.values(), task => task.username))

const broadcastQueueSnapshots = (): void => {
  queueBroadcastTimer = null
  if (activeTasks.size === 0) return
  for (const username of getActiveQueueUsernames()) notifyQueueListeners(username)
  scheduleQueueBroadcast()
}

const scheduleQueueBroadcast = (): void => {
  if (queueBroadcastTimer || activeTasks.size === 0) return
  if (![...getActiveQueueUsernames()].some(username => queueListeners.get(username)?.size)) return
  queueBroadcastTimer = setTimeout(broadcastQueueSnapshots, QUEUE_BROADCAST_INTERVAL)
  ;(queueBroadcastTimer as any)?.unref?.()
}

/** Subscribe to live queue snapshots for one authenticated user. */
export const subscribe = (username: string, listener: QueueListener): (() => void) => {
  const listeners = queueListeners.get(username) || new Set<QueueListener>()
  listeners.add(listener)
  queueListeners.set(username, listeners)

  const snapshot = list(username)
  queueSnapshots.set(username, JSON.stringify(snapshot))
  try {
    listener(snapshot)
  } catch {
    /* the stream may have closed during setup */
  }
  scheduleQueueBroadcast()

  return () => {
    const current = queueListeners.get(username)
    if (!current) return
    current.delete(listener)
    if (current.size > 0) return
    queueListeners.delete(username)
    queueSnapshots.delete(username)
    if (queueListeners.size === 0 && queueBroadcastTimer) {
      clearTimeout(queueBroadcastTimer)
      queueBroadcastTimer = null
    }
  }
}

export const pauseTasks = (username: string, id?: string) => {
  for (const task of tasks.values()) {
    if (task.username !== username || (id && task.id !== id)) continue
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
