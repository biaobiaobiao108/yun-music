import fs from 'node:fs'
import path from 'node:path'
import * as fileCache from './fileCache'

export type ServerDownloadStatus = 'waiting' | 'downloading' | 'tagging' | 'paused' | 'finished' | 'exists' | 'error'

export interface ServerDownloadTask {
  id: string
  username: string
  songKey: string
  activeSongKey?: string
  songInfo: any
  quality: string
  requestedQuality: string
  status: ServerDownloadStatus
  progress: number
  total: number
  received: number
  speed: number
  errorMsg: string
  enableOnlyDownloadMode: boolean
  cacheLyric: boolean
  embedLyric: boolean
  background: boolean
  /** Short-lived URL from the legacy trigger endpoint; never persisted. */
  resolvedUrl?: string
  resolvedUrlAt?: number
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
  createdAt: number
  updatedAt: number
}

interface QueueInput {
  id?: string
  songInfo: any
  quality?: string
  enableOnlyDownloadMode?: boolean
  cacheLyric?: boolean
  embedLyric?: boolean
  background?: boolean
  resolvedUrl?: string
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

interface ResolveResult {
  url: string
  quality?: string
  songInfo?: any
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

type DownloadResolver = (task: ServerDownloadTask) => Promise<ResolveResult>

const DEFAULT_CONCURRENT = 3
const MAX_CONCURRENT_PER_USER = 5
export const MAX_BACKGROUND_CONCURRENT = 1
const RESOLVED_URL_TTL = 10 * 60 * 1000
export const MAX_PENDING_TASKS_PER_USER = 500
export const MAX_HISTORY_PER_USER = 200
const tasks = new Map<string, ServerDownloadTask>()
const controllers = new Map<string, AbortController>()
const concurrencyByUser = new Map<string, number>()
let resolver: DownloadResolver | null = null
let initialized = false
let processing = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

const taskMapKey = (username: string, id: string) => `${username}:${id}`
const getQueueFile = () => path.join(global.lx.dataPath, 'server-download-queue.json')
const validStatuses = new Set<ServerDownloadStatus>(['waiting', 'downloading', 'tagging', 'paused', 'finished', 'exists', 'error'])
const resumableStatuses = new Set<ServerDownloadStatus>(['waiting', 'downloading', 'tagging', 'paused'])
const terminalStatuses = new Set<ServerDownloadStatus>(['finished', 'exists'])

export const markDownloadTaskPausedIfAborted = (task: ServerDownloadTask, aborted: boolean) => {
  if (!aborted) return false
  task.status = 'paused'
  task.speed = 0
  task.errorMsg = '已暂停'
  task.updatedAt = Date.now()
  return true
}

const SONG_INFO_FIELDS = [
  'id', 'songmid', 'songId', 'source', 'name', 'singer', 'albumName', 'albumId', 'album',
  'interval', 'img', 'pic', 'types', '_types', 'hash', 'strMediaMid', 'albumMid',
  'copyrightId', 'lrcUrl', 'mrcUrl', 'trcUrl', 'quality', 'requestedSource',
  'downloadSource', 'sourceName',
] as const

const SONG_META_FIELDS = [
  'source', 'songId', 'name', 'songName', 'singer', 'singerName', 'albumName', 'albumId',
  'picUrl', 'img', 'interval', 'qualitys', '_qualitys', 'types', '_types', 'strMediaMid', 'albumMid',
  'lrcUrl', 'mrcUrl', 'trcUrl',
] as const

const copySongField = (source: any, target: Record<string, any>, key: string) => {
  const value = source?.[key]
  if (value === undefined || value === null) return
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    target[key] = value
    return
  }
  if (key === 'types' || key === '_types' || key === 'qualitys') {
    if (Array.isArray(value)) {
      target[key] = value.slice(0, 32)
    } else if (typeof value === 'object') {
      target[key] = Object.fromEntries(Object.entries(value).slice(0, 32))
    }
  }
}

const sanitizeSongInfo = (songInfo: any) => {
  if (!songInfo || typeof songInfo !== 'object') return {}
  const safeSongInfo: Record<string, any> = {}
  for (const key of SONG_INFO_FIELDS) copySongField(songInfo, safeSongInfo, key)

  if (songInfo.meta && typeof songInfo.meta === 'object') {
    const safeMeta: Record<string, any> = {}
    for (const key of SONG_META_FIELDS) copySongField(songInfo.meta, safeMeta, key)
    // Preserve the lightweight meta container for callers that read
    // `songInfo.meta`, while still dropping URL and raw payload fields.
    safeSongInfo.meta = safeMeta
  }
  return safeSongInfo
}

export const serializeDownloadTask = (task: ServerDownloadTask) => {
  const {
    resolvedUrl: _resolvedUrl,
    resolvedUrlAt: _resolvedUrlAt,
    ...persistedTask
  } = task
  return {
    ...persistedTask,
    songInfo: sanitizeSongInfo(persistedTask.songInfo),
  }
}

const getTaskIdentity = (task: Pick<ServerDownloadTask, 'username' | 'songInfo' | 'quality' | 'requestedQuality' | 'songKey' | 'activeSongKey'>) => {
  const songInfo = task.songInfo || {}
  const normalizedSongId = fileCache.normalizeSongId(songInfo)
  const requestedQuality = String(task.requestedQuality || task.quality || 'unknown')
  if (normalizedSongId) return `${task.username}:${normalizedSongId}:${requestedQuality}`

  const source = String(songInfo.source || songInfo.meta?.source || 'unknown')
  const name = String(songInfo.name || songInfo.meta?.songName || '')
  const singer = String(songInfo.singer || songInfo.meta?.singerName || '')
  const album = String(songInfo.albumName || songInfo.meta?.albumName || '')
  const fallbackKey = String(task.songKey || task.activeSongKey || `${source}:${name}:${singer}:${album}`)
  return `${task.username}:${fallbackKey}:${requestedQuality}`
}

const taskStatusPriority = (status: ServerDownloadStatus) => {
  if (terminalStatuses.has(status)) return 3
  if (status === 'downloading' || status === 'tagging') return 2
  if (status === 'waiting') return 1
  return 0
}

const shouldReplaceTask = (current: ServerDownloadTask, candidate: ServerDownloadTask) => {
  // /music is the stricter target: a file there also satisfies cache lookups,
  // while a file in /cache does not satisfy an only-download request.
  const currentTargetsMusic = current.enableOnlyDownloadMode === true
  const candidateTargetsMusic = candidate.enableOnlyDownloadMode === true
  if (candidateTargetsMusic !== currentTargetsMusic) return candidateTargetsMusic

  const currentPriority = taskStatusPriority(current.status)
  const candidatePriority = taskStatusPriority(candidate.status)
  if (candidatePriority !== currentPriority) return candidatePriority > currentPriority
  if (candidate.background !== current.background) return candidate.background === false
  return (candidate.updatedAt || candidate.createdAt) > (current.updatedAt || current.createdAt)
}

/** Keep one persisted task for each user/song/requested-quality combination. */
export const deduplicateDownloadTasks = (taskList: ServerDownloadTask[]) => {
  const retained = new Map<string, ServerDownloadTask>()
  for (const task of taskList) {
    const identity = getTaskIdentity(task)
    const current = retained.get(identity)
    if (!current || shouldReplaceTask(current, task)) retained.set(identity, task)
  }
  return Array.from(retained.values())
}

export const isDownloadTaskRunnable = (
  task: ServerDownloadTask,
  activeCountForUser: number,
  activeBackgroundCount: number,
  activeIdentities: Set<string>,
  concurrency: number,
) => task.status === 'waiting' &&
  activeCountForUser < concurrency &&
  !activeIdentities.has(getTaskIdentity(task)) &&
  (!task.background || activeBackgroundCount < MAX_BACKGROUND_CONCURRENT)

const deduplicateTasksInMemory = () => {
  const currentTasks = Array.from(tasks.values())
  const retainedTasks = deduplicateDownloadTasks(currentTasks)
  if (retainedTasks.length === currentTasks.length) return false

  const retainedKeys = new Set(retainedTasks.map(task => taskMapKey(task.username, task.id)))
  for (const task of currentTasks) {
    const key = taskMapKey(task.username, task.id)
    if (!retainedKeys.has(key)) controllers.get(key)?.abort()
  }

  tasks.clear()
  retainedTasks.forEach(task => tasks.set(taskMapKey(task.username, task.id), task))
  return true
}

const normalizeConcurrency = (value: unknown) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENT
  return Math.min(MAX_CONCURRENT_PER_USER, Math.max(1, parsed))
}

export const getConcurrency = (username: string) => concurrencyByUser.get(username) || DEFAULT_CONCURRENT

const sanitizeId = (value: unknown) => {
  const id = String(value || '')
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : `server_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export const pruneDownloadHistory = (
  taskList: ServerDownloadTask[],
  maxHistoryPerUser = MAX_HISTORY_PER_USER,
) => {
  const historicalByUser = new Map<string, ServerDownloadTask[]>()
  for (const task of taskList) {
    if (resumableStatuses.has(task.status)) continue
    const history = historicalByUser.get(task.username) || []
    history.push(task)
    historicalByUser.set(task.username, history)
  }

  const removedKeys = new Set<string>()
  for (const history of historicalByUser.values()) {
    history
      .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt))
      .slice(maxHistoryPerUser)
      .forEach(task => removedKeys.add(taskMapKey(task.username, task.id)))
  }
  return taskList.filter(task => !removedKeys.has(taskMapKey(task.username, task.id)))
}

const pruneHistory = () => {
  const retained = pruneDownloadHistory(Array.from(tasks.values()))
  const removed = tasks.size - retained.length
  if (removed > 0) {
    tasks.clear()
    retained.forEach(task => tasks.set(taskMapKey(task.username, task.id), task))
  }
  return removed
}

const saveNow = () => {
  if (!initialized) return
  deduplicateTasksInMemory()
  const removed = pruneHistory()
  if (removed > 0) {
    console.log(`[ServerDownloadQueue] Pruned ${removed} old history task(s)`)
  }
  const file = getQueueFile()
  const tempFile = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tempFile, JSON.stringify({
      version: 2,
      concurrencyByUser: Object.fromEntries(concurrencyByUser),
      tasks: Array.from(tasks.values()).map(serializeDownloadTask),
    }, null, 2), 'utf8')
    fs.renameSync(tempFile, file)
  } catch (err) {
    console.warn('[ServerDownloadQueue] Failed to save queue:', err)
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile) } catch (e) { }
  }
}

const scheduleSave = () => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveNow()
  }, 150)
}

const loadTasks = () => {
  const file = getQueueFile()
  if (!fs.existsSync(file)) return
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const savedTasks = Array.isArray(data) ? data : data?.tasks
    if (!Array.isArray(savedTasks)) return
    if (!Array.isArray(data) && data?.concurrencyByUser && typeof data.concurrencyByUser === 'object') {
      for (const [username, value] of Object.entries(data.concurrencyByUser)) {
        concurrencyByUser.set(username, normalizeConcurrency(value))
      }
    }
    const restoredTasks: ServerDownloadTask[] = []
    for (const raw of savedTasks) {
      if (!raw || !raw.username || !raw.songInfo) continue
      const id = sanitizeId(raw.id)
      const savedStatus = validStatuses.has(raw.status) ? raw.status as ServerDownloadStatus : 'waiting'
      const status: ServerDownloadStatus = savedStatus === 'downloading' || savedStatus === 'tagging' ? 'waiting' : savedStatus
      const quality = String(raw.quality || raw.requestedQuality || '320k')
      const requestedQuality = String(raw.requestedQuality || quality)
      const now = Date.now()
      const createdAt = Number(raw.createdAt || now)
      const task: ServerDownloadTask = {
        id,
        username: String(raw.username),
        songKey: String(raw.songKey || `${fileCache.normalizeSongId(raw.songInfo)}_${requestedQuality}`),
        activeSongKey: status === 'waiting' ? undefined : raw.activeSongKey ? String(raw.activeSongKey) : undefined,
        songInfo: sanitizeSongInfo(raw.songInfo),
        quality: status === 'waiting' ? requestedQuality : quality,
        requestedQuality,
        status,
        progress: status === 'waiting' ? 0 : Number(raw.progress || 0),
        total: status === 'waiting' ? 0 : Number(raw.total || 0),
        received: status === 'waiting' ? 0 : Number(raw.received || 0),
        speed: 0,
        errorMsg: status === 'waiting' ? '' : String(raw.errorMsg || ''),
        enableOnlyDownloadMode: !!raw.enableOnlyDownloadMode,
        cacheLyric: raw.cacheLyric !== false,
        embedLyric: raw.embedLyric !== false,
        background: raw.background === true,
        requestedSource: raw.requestedSource ? String(raw.requestedSource) : undefined,
        downloadSource: raw.downloadSource ? String(raw.downloadSource) : undefined,
        sourceName: raw.sourceName ? String(raw.sourceName) : undefined,
        createdAt,
        updatedAt: Number(raw.updatedAt || createdAt),
      }
      restoredTasks.push(task)
    }
    deduplicateDownloadTasks(restoredTasks)
      .forEach(task => tasks.set(taskMapKey(task.username, task.id), task))
    pruneHistory()
    console.log(`[ServerDownloadQueue] Restored ${tasks.size} persisted tasks`)
  } catch (err) {
    console.warn('[ServerDownloadQueue] Failed to restore queue:', err)
  }
}

const getPublicTask = (task: ServerDownloadTask) => {
  const live = task.status === 'downloading' && task.activeSongKey && controllers.has(taskMapKey(task.username, task.id))
    ? fileCache.cacheProgress.get(task.activeSongKey)
    : undefined
  // A transient cache progress entry must never downgrade a terminal queue
  // state. In particular, lyric/tagging cleanup can outlive the audio task.
  const liveStatus = ['downloading', 'tagging', 'finished', 'exists'].includes(String(live?.status))
    ? live?.status as ServerDownloadStatus
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
    errorMsg: String(live?.errorMsg || task.errorMsg || ''),
    createdAt: task.createdAt,
    updatedAt: Number(live?.updatedAt || task.updatedAt),
  }
}

const runTask = async (task: ServerDownloadTask) => {
  if (!resolver || task.status !== 'waiting') return
  const key = taskMapKey(task.username, task.id)
  // A resolver may fall back to another provider, but the resulting cache file
  // must remain addressable through the song the user originally requested.
  const requestedSongInfo = sanitizeSongInfo(task.songInfo)
  const targetOnlyDownloadMode = task.enableOnlyDownloadMode === true
  const controller = new AbortController()
  controllers.set(key, controller)
  task.status = 'downloading'
  task.progress = 0
  task.total = 0
  task.received = 0
  task.speed = 0
  task.errorMsg = ''
  task.updatedAt = Date.now()
  scheduleSave()

  try {
    const suppliedUrl = task.resolvedUrl && task.resolvedUrlAt && Date.now() - task.resolvedUrlAt <= RESOLVED_URL_TTL
      ? task.resolvedUrl
      : undefined
    const suppliedUrlAt = task.resolvedUrlAt
    task.resolvedUrl = undefined
    task.resolvedUrlAt = undefined
    scheduleSave()
    let resolved = suppliedUrl && suppliedUrlAt && Date.now() - suppliedUrlAt <= RESOLVED_URL_TTL
      ? {
        url: suppliedUrl,
        quality: task.quality,
        songInfo: task.songInfo,
        requestedSource: task.requestedSource,
        downloadSource: task.downloadSource,
        sourceName: task.sourceName,
      }
      : await resolver(task)
    if (markDownloadTaskPausedIfAborted(task, controller.signal.aborted)) return
    if (!resolved?.url) throw new Error('无法解析下载地址')

    const applyResolvedTarget = (nextResolved: ResolveResult) => {
      task.songInfo = requestedSongInfo
      task.quality = nextResolved.quality || task.requestedQuality
      task.activeSongKey = fileCache.normalizeSongId(requestedSongInfo) + '_' + task.quality
      task.updatedAt = Date.now()
      scheduleSave()
    }

    const downloadResolvedSong = async (nextResolved: ResolveResult) => {
      applyResolvedTarget(nextResolved)
      await fileCache.downloadAndCache(requestedSongInfo, nextResolved.url, task.quality, task.username, controller.signal,
        targetOnlyDownloadMode, task.cacheLyric, task.embedLyric, {
          requestedSource: nextResolved.requestedSource,
          downloadSource: nextResolved.downloadSource,
          sourceName: nextResolved.sourceName,
        })
    }

    try {
      await downloadResolvedSong(resolved)
    } catch (firstError: any) {
      // The URL supplied by the browser can expire or be reachable only with
      // browser-specific request context. A successful foreground playback
      // must still produce a server cache, so refresh the source once before
      // marking the background task as failed. This is intentionally limited
      // to one retry to avoid duplicate paid-source requests and retry loops.
      if (!suppliedUrl || controller.signal.aborted) throw firstError
      console.warn(`[ServerDownloadQueue] Supplied cache URL failed for ${task.songKey}; refreshing source once`)
      resolved = await resolver(task)
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
      ? fileCache.cacheProgress.get(task.activeSongKey)
      : undefined
    task.status = progress?.status === 'exists' ? 'exists' : 'finished'
    task.progress = 100
    task.total = Number(progress?.total || progress?.received || task.total || 0)
    task.received = Number(progress?.received || task.total || 0)
    task.speed = 0
    task.errorMsg = ''
  } catch (err: any) {
    if (markDownloadTaskPausedIfAborted(task, controller.signal.aborted) || err?.message === 'Aborted') {
      task.status = 'paused'
      task.errorMsg = '已暂停'
    } else {
      task.status = 'error'
      task.errorMsg = err?.message || '下载失败'
      console.error(`[ServerDownloadQueue] Task failed ${task.songKey}: ${task.errorMsg}`)
    }
    task.speed = 0
  } finally {
    controllers.delete(key)
    task.updatedAt = Date.now()
    scheduleSave()
    void processQueue()
  }
}

const processQueue = async () => {
  if (processing || !resolver) return
  processing = true
  try {
    while (true) {
      const activeByUser = new Map<string, number>()
      const activeIdentities = new Set<string>()
      let activeBackground = 0
      for (const key of controllers.keys()) {
        const activeTask = tasks.get(key)
        const username = activeTask?.username
        if (!activeTask || !username) continue
        activeByUser.set(username, (activeByUser.get(username) || 0) + 1)
        activeIdentities.add(getTaskIdentity(activeTask))
        if (activeTask.background) activeBackground++
      }
      const candidates = Array.from(tasks.values())
        .filter(task => task.status === 'waiting')
        .sort((a, b) => Number(a.background) - Number(b.background) || a.createdAt - b.createdAt)
      const next = candidates.find(task => isDownloadTaskRunnable(
        task,
        activeByUser.get(task.username) || 0,
        activeBackground,
        activeIdentities,
        getConcurrency(task.username),
      ))
      if (!next) break
      void runTask(next)
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
  if (!initialized) {
    initialized = true
    loadTasks()
    saveNow()
  }
  void processQueue()
}

export const enqueue = (username: string, inputs: QueueInput[]) => {
  if (inputs.length > 100) throw new Error('Too many tasks in one request')
  deduplicateTasksInMemory()
  const pendingCount = Array.from(tasks.values()).filter(task => task.username === username && resumableStatuses.has(task.status)).length
  if (pendingCount + inputs.length > MAX_PENDING_TASKS_PER_USER) throw new Error('Too many pending download tasks')
  const added: ServerDownloadTask[] = []
  for (const input of inputs) {
    if (!input?.songInfo) continue
    const id = sanitizeId(input.id)
    const key = taskMapKey(username, id)
    const quality = String(input.quality || '320k')
    const existing = tasks.get(key) || Array.from(tasks.values()).find(task => (
      task.username === username && getTaskIdentity(task) === getTaskIdentity({
        username,
        songInfo: input.songInfo,
        quality,
        requestedQuality: quality,
        songKey: '',
        activeSongKey: undefined,
      })
    ))
    if (existing) {
      const targetFolder = input.enableOnlyDownloadMode === true ? 'music' : 'cache'
      const hasTerminalTarget = terminalStatuses.has(existing.status) && (() => {
        try {
          const cached = fileCache.checkCache({ ...input.songInfo, quality, exactQuality: true }, username, false)
          return cached.exists && !cached.isCollision && cached.folder === targetFolder
        } catch {
          return false
        }
      })()
      if (terminalStatuses.has(existing.status) &&
        existing.enableOnlyDownloadMode === (input.enableOnlyDownloadMode === true) &&
        input.background === true &&
        hasTerminalTarget) {
        // A completed background cache request must stay terminal. Replaying
        // the same URL should not start another download just because the
        // player resolved it again from localStorage.
        continue
      }
      if (['waiting', 'downloading', 'tagging'].includes(existing.status)) {
        // Keep one queue record per song/quality (and therefore one public ID),
        // but remember a newly requested /music target even when the current
        // download is already running. runTask will perform the second step
        // after the current target finishes.
        const targetOnlyDownloadMode = input.enableOnlyDownloadMode === true
        if (existing.enableOnlyDownloadMode !== targetOnlyDownloadMode) {
          existing.enableOnlyDownloadMode = targetOnlyDownloadMode
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

      const now = Date.now()
      existing.songKey = fileCache.normalizeSongId(input.songInfo) + '_' + quality
      existing.activeSongKey = undefined
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
    const now = Date.now()
    const task: ServerDownloadTask = {
      id, username,
      songKey: fileCache.normalizeSongId(input.songInfo) + '_' + quality,
      songInfo: sanitizeSongInfo(input.songInfo),
      quality,
      requestedQuality: quality,
      status: 'waiting', progress: 0, total: 0, received: 0, speed: 0, errorMsg: '',
      enableOnlyDownloadMode: !!input.enableOnlyDownloadMode,
      cacheLyric: input.cacheLyric !== false,
      embedLyric: input.embedLyric !== false,
      background: input.background === true,
      resolvedUrl: input.resolvedUrl,
      resolvedUrlAt: input.resolvedUrl ? now : undefined,
      requestedSource: input.requestedSource,
      downloadSource: input.downloadSource,
      sourceName: input.sourceName,
      createdAt: now, updatedAt: now,
    }
    tasks.set(key, task)
    added.push(task)
  }
  saveNow()
  void processQueue()
  return added.map(task => getPublicTask(task))
}

export const list = (username: string) => {
  if (deduplicateTasksInMemory()) saveNow()
  return Array.from(tasks.values())
    .filter(task => task.username === username)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(task => getPublicTask(task))
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
  const task = Array.from(tasks.values()).find(candidate => (
    candidate.username === username &&
    activeStatuses.has(candidate.status) &&
    (songKeys.has(candidate.songKey) || songKeys.has(candidate.activeSongKey || ''))
  ))
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
  const allowedKeys = new Set<string>()
  for (const task of tasks.values()) {
    if (task.username !== username) continue
    if (task.songKey) allowedKeys.add(task.songKey)
    if (task.activeSongKey) allowedKeys.add(task.activeSongKey)
  }

  const progress: Record<string, any> = {}
  for (const id of ids) {
    if (!allowedKeys.has(id)) continue
    const value = fileCache.cacheProgress.get(id)
    if (value) progress[id] = value
  }
  return progress
}

export const pause = (username: string, id?: string) => {
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
  void processQueue()
}

export const remove = (username: string, options: { id?: string; all?: boolean; completed?: boolean }) => {
  for (const [key, task] of tasks) {
    if (task.username !== username) continue
    const shouldRemove = options.all || (options.id && task.id === options.id) || (options.completed && ['finished', 'exists'].includes(task.status))
    if (!shouldRemove) continue
    controllers.get(key)?.abort()
    tasks.delete(key)
  }
  saveNow()
  void processQueue()
}
