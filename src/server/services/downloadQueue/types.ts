export type ServerDownloadStatus = 'waiting' | 'downloading' | 'tagging' | 'paused' | 'finished' | 'exists' | 'error'

export interface ServerDownloadTask {
  id: string
  username: string
  songKey: string
  activeSongKey?: string
  /** Ephemeral per-user/task key for the process-global cache progress map. */
  progressKey?: string
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

export interface QueueInput {
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

export interface ResolveResult {
  url: string
  quality?: string
  songInfo?: any
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

export type DownloadResolver = (task: ServerDownloadTask, signal: AbortSignal) => Promise<ResolveResult>

export const DEFAULT_CONCURRENT = 3
export const MAX_CONCURRENT_PER_USER = 5
export const MAX_BACKGROUND_CONCURRENT = 1
export const RESOLVED_URL_TTL = 10 * 60 * 1000
export const MAX_PENDING_TASKS_PER_USER = 500
export const MAX_HISTORY_PER_USER = 200
export const MAX_TOTAL_TASKS = 3000
export const MAX_TASK_SNAPSHOT_BYTES = 8 * 1024
export const MAX_QUEUE_SNAPSHOT_BYTES = 32 * 1024 * 1024
export const MAX_TASK_INPUT_BYTES = MAX_TASK_SNAPSHOT_BYTES - 1024
export const MAX_SONG_INFO_BYTES = MAX_TASK_SNAPSHOT_BYTES - 1536
export const MAX_SONG_FIELD_LENGTH = 2048
export const MAX_SONG_COLLECTION_ITEMS = 32
export const MAX_SOURCE_FIELD_LENGTH = 256
export const MAX_QUALITY_LENGTH = 32
export const MAX_RESOLVED_URL_LENGTH = 4096
export const MAX_ERROR_MESSAGE_LENGTH = 1024
