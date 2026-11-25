import * as fileCache from '../../fileCache'
import {
  DEFAULT_CONCURRENT,
  MAX_BACKGROUND_CONCURRENT,
  MAX_CONCURRENT_PER_USER,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_HISTORY_PER_USER,
  MAX_QUALITY_LENGTH,
  MAX_RESOLVED_URL_LENGTH,
  MAX_SOURCE_FIELD_LENGTH,
  MAX_SONG_COLLECTION_ITEMS,
  MAX_SONG_FIELD_LENGTH,
  MAX_SONG_INFO_BYTES,
  MAX_TASK_INPUT_BYTES,
  type QueueInput,
  type ServerDownloadStatus,
  type ServerDownloadTask,
} from './types'

export const validStatuses = new Set<ServerDownloadStatus>([
  'waiting',
  'downloading',
  'tagging',
  'paused',
  'finished',
  'exists',
  'error',
])
export const resumableStatuses = new Set<ServerDownloadStatus>(['waiting', 'downloading', 'tagging', 'paused'])
export const terminalStatuses = new Set<ServerDownloadStatus>(['finished', 'exists'])

export const taskMapKey = (username: string, id: string) => `${username}:${id}`
export const getTaskProgressKey = (username: string, id: string) =>
  `queue:${encodeURIComponent(username)}:${encodeURIComponent(id)}`

export const markDownloadTaskPausedIfAborted = (task: ServerDownloadTask, aborted: boolean) => {
  if (!aborted) return false
  // resume() can request another run before the aborted worker has unwound.
  // Keep that request intact; the execution slot is released in finally.
  if (task.status === 'waiting') return true
  task.status = 'paused'
  task.speed = 0
  task.errorMsg = '已暂停'
  task.updatedAt = Date.now()
  return true
}

const SONG_INFO_FIELDS = [
  'id',
  'songmid',
  'songId',
  'source',
  'name',
  'singer',
  'albumName',
  'albumId',
  'interval',
  'img',
  'pic',
  'types',
  '_types',
  'hash',
  'strMediaMid',
  'albumMid',
  'copyrightId',
  'lrcUrl',
  'mrcUrl',
  'trcUrl',
  'quality',
  'requestedSource',
  'downloadSource',
  'sourceName',
] as const

const SONG_META_FIELDS = [
  'source',
  'songId',
  'name',
  'songName',
  'singer',
  'singerName',
  'albumName',
  'albumId',
  'picUrl',
  'img',
  'interval',
  'qualitys',
  '_qualitys',
  'types',
  '_types',
  'strMediaMid',
  'albumMid',
  'lrcUrl',
  'mrcUrl',
  'trcUrl',
] as const

export const limitText = (value: unknown, maxLength: number, label: string, strict: boolean): string => {
  const text = String(value)
  if (text.length <= maxLength) return text
  if (strict) throw new Error(`${label}长度不能超过 ${maxLength} 个字符`)
  return text.slice(0, maxLength)
}

const copySongScalar = (value: unknown, key: string, strict: boolean) => {
  if (typeof value === 'string') return limitText(value, MAX_SONG_FIELD_LENGTH, `songInfo.${key}`, strict)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return undefined
}

const copySongField = (source: any, target: Record<string, any>, key: string, strict: boolean) => {
  const value = source?.[key]
  if (value === undefined || value === null) return
  const scalar = copySongScalar(value, key, strict)
  if (scalar !== undefined) {
    target[key] = scalar
    return
  }
  if (key === 'types' || key === '_types' || key === 'qualitys') {
    if (Array.isArray(value)) {
      target[key] = value
        .slice(0, MAX_SONG_COLLECTION_ITEMS)
        .map((item, index) => copySongScalar(item, `${key}[${index}]`, strict))
        .filter(item => item !== undefined)
    } else if (typeof value === 'object') {
      target[key] = Object.fromEntries(
        Object.entries(value)
          .slice(0, MAX_SONG_COLLECTION_ITEMS)
          .map(([entryKey, entryValue], index) => [
            limitText(entryKey, 64, `songInfo.${key} key`, strict),
            copySongScalar(entryValue, `${key}.${entryKey}`, strict),
          ])
          .filter(([, entryValue]) => entryValue !== undefined),
      )
    }
  }
}

export const sanitizeSongInfo = (songInfo: any, strict = false) => {
  if (!songInfo || typeof songInfo !== 'object') return {}
  const safeSongInfo: Record<string, any> = {}
  for (const key of SONG_INFO_FIELDS) copySongField(songInfo, safeSongInfo, key, strict)

  if (songInfo.meta && typeof songInfo.meta === 'object') {
    const safeMeta: Record<string, any> = {}
    for (const key of SONG_META_FIELDS) copySongField(songInfo.meta, safeMeta, key, strict)
    // Preserve the lightweight meta container for callers that read
    // `songInfo.meta`, while still dropping URL and raw payload fields.
    safeSongInfo.meta = safeMeta
  }

  while (Buffer.byteLength(JSON.stringify(safeSongInfo)) > MAX_SONG_INFO_BYTES) {
    if (strict) throw new Error('songInfo 数据过大')
    const optionalKeys = Object.keys(safeSongInfo).filter(key => key !== 'source' && key !== 'songmid' && key !== 'id')
    const removable = optionalKeys.pop()
    if (removable) delete safeSongInfo[removable]
    else break
  }
  return safeSongInfo
}

export const serializeDownloadTask = (task: ServerDownloadTask) => {
  const { resolvedUrl: _resolvedUrl, resolvedUrlAt: _resolvedUrlAt, progressKey: _progressKey, ...persistedTask } = task
  return {
    ...persistedTask,
    quality: limitText(persistedTask.quality, MAX_QUALITY_LENGTH, 'quality', false),
    requestedQuality: limitText(persistedTask.requestedQuality, MAX_QUALITY_LENGTH, 'requestedQuality', false),
    errorMsg: limitText(persistedTask.errorMsg, MAX_ERROR_MESSAGE_LENGTH, 'errorMsg', false),
    requestedSource:
      persistedTask.requestedSource === undefined
        ? undefined
        : limitText(persistedTask.requestedSource, MAX_SOURCE_FIELD_LENGTH, 'requestedSource', false),
    downloadSource:
      persistedTask.downloadSource === undefined
        ? undefined
        : limitText(persistedTask.downloadSource, MAX_SOURCE_FIELD_LENGTH, 'downloadSource', false),
    sourceName:
      persistedTask.sourceName === undefined
        ? undefined
        : limitText(persistedTask.sourceName, MAX_SOURCE_FIELD_LENGTH, 'sourceName', false),
    songInfo: sanitizeSongInfo(persistedTask.songInfo),
  }
}

export const normalizeQueueInput = (input: QueueInput): QueueInput => {
  const songInfo = sanitizeSongInfo(input.songInfo, true)
  const quality = limitText(input.quality || '320k', MAX_QUALITY_LENGTH, 'quality', true)
  const normalized: QueueInput = {
    id: input.id,
    songInfo,
    quality,
    enableOnlyDownloadMode: input.enableOnlyDownloadMode,
    cacheLyric: input.cacheLyric,
    embedLyric: input.embedLyric,
    background: input.background,
    requestedSource:
      input.requestedSource === undefined
        ? undefined
        : limitText(input.requestedSource, MAX_SOURCE_FIELD_LENGTH, 'requestedSource', true),
    downloadSource:
      input.downloadSource === undefined
        ? undefined
        : limitText(input.downloadSource, MAX_SOURCE_FIELD_LENGTH, 'downloadSource', true),
    sourceName:
      input.sourceName === undefined
        ? undefined
        : limitText(input.sourceName, MAX_SOURCE_FIELD_LENGTH, 'sourceName', true),
  }
  if (input.resolvedUrl !== undefined) {
    normalized.resolvedUrl = limitText(input.resolvedUrl, MAX_RESOLVED_URL_LENGTH, 'resolvedUrl', true)
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_TASK_INPUT_BYTES) {
    throw new Error('单个下载任务数据过大')
  }
  return normalized
}

export const getTaskIdentity = (
  task: Pick<
    ServerDownloadTask,
    'username' | 'songInfo' | 'quality' | 'requestedQuality' | 'songKey' | 'activeSongKey'
  >,
) => {
  const songInfo = task.songInfo || {}
  const source = String(songInfo.source || songInfo.meta?.source || 'unknown').trim() || 'unknown'
  const normalizedSongId = fileCache.normalizeSongId(songInfo)
  const requestedQuality = String(task.requestedQuality || task.quality || 'unknown')
  if (normalizedSongId) return `${task.username}:${source}:${normalizedSongId}:${requestedQuality}`

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

export const shouldReplaceTask = (current: ServerDownloadTask, candidate: ServerDownloadTask) => {
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

/** Drop persisted work for accounts that no longer exist, while retaining the shared public queue. */
export const filterPersistedTasksForUsers = <T extends { username?: unknown }>(
  taskList: T[],
  activeUsernames: ReadonlySet<string>,
): T[] =>
  taskList.filter(task => {
    if (!task || typeof task.username !== 'string') return false
    return task.username === '_open' || activeUsernames.has(task.username)
  })

export const isDownloadTaskRunnable = (
  task: ServerDownloadTask,
  activeCountForUser: number,
  activeBackgroundCount: number,
  activeIdentities: Set<string>,
  concurrency: number,
) =>
  task.status === 'waiting' &&
  activeCountForUser < concurrency &&
  !activeIdentities.has(getTaskIdentity(task)) &&
  (!task.background || activeBackgroundCount < MAX_BACKGROUND_CONCURRENT)

export const normalizeConcurrency = (value: unknown) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENT
  return Math.min(MAX_CONCURRENT_PER_USER, Math.max(1, parsed))
}

export const sanitizeId = (value: unknown) => {
  const id = String(value || '')
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? id : `server_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export const pruneDownloadHistory = (taskList: ServerDownloadTask[], maxHistoryPerUser = MAX_HISTORY_PER_USER) => {
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
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
      .slice(maxHistoryPerUser)
      .forEach(task => removedKeys.add(taskMapKey(task.username, task.id)))
  }
  return taskList.filter(task => !removedKeys.has(taskMapKey(task.username, task.id)))
}
