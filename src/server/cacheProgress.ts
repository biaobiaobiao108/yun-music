import { normalizeCacheUsername } from './cachePaths'

export const cacheProgress: Map<
  string,
  {
    progress: number
    status: string
    total?: number
    received?: number
    speed?: number
    updatedAt?: number
    errorMsg?: string
  }
> = new Map()
const CACHE_PROGRESS_TTL = 30 * 1000
const CACHE_PROGRESS_ACTIVE_TTL = 10 * 60 * 1000
const CACHE_PROGRESS_MAX_ENTRIES = 4096
let cacheProgressCleanupTimer: ReturnType<typeof setTimeout> | null = null

const ACTIVE_CACHE_PROGRESS_STATUSES = new Set(['downloading', 'tagging'])

const getCacheProgressKey = (songId: string, quality?: string) => `${songId}_${quality || 'unknown'}`
const scopedCacheProgress = new Map<string, string>()
const scopedProgressKey = (username: string | undefined, songId: string, quality?: string) =>
  JSON.stringify([normalizeCacheUsername(username), songId, quality || 'unknown'])

/** Associate opaque queue progress keys with their owning song and user. */
export const bindCacheProgress = (
  username: string | undefined,
  songId: string,
  quality: string | undefined,
  progressKey: string,
) => {
  const key = scopedProgressKey(username, songId, quality)
  scopedCacheProgress.set(key, progressKey)
  return () => {
    if (scopedCacheProgress.get(key) === progressKey) scopedCacheProgress.delete(key)
  }
}

export const getActiveCacheProgress = (songId: string, quality?: string, username?: string) => {
  const prefix = `${songId}_`
  const exactKey = quality ? getCacheProgressKey(songId, quality) : null
  const now = Date.now()

  if (username !== undefined) {
    for (const [scope, key] of scopedCacheProgress) {
      const [owner, id, q] = JSON.parse(scope) as string[]
      if (owner !== normalizeCacheUsername(username) || id !== songId || (quality && q !== quality)) continue
      const progress = cacheProgress.get(key)
      if (progress && ACTIVE_CACHE_PROGRESS_STATUSES.has(progress.status)) return { key, ...progress }
    }
    return null
  }

  for (const [key, progress] of cacheProgress) {
    if ((exactKey && key !== exactKey) || (!exactKey && !key.startsWith(prefix))) continue
    if (!ACTIVE_CACHE_PROGRESS_STATUSES.has(progress.status)) continue
    const updatedAt = progress.updatedAt || 0
    if (updatedAt > 0 && now - updatedAt > CACHE_PROGRESS_ACTIVE_TTL) continue
    return { key, ...progress }
  }

  return null
}

export const isCacheEntryProcessing = (songId: string, quality?: string, username?: string) =>
  !!getActiveCacheProgress(songId, quality, username)

export const cleanupExpiredCacheProgress = (now = Date.now()) => {
  const expiredBefore = now - CACHE_PROGRESS_TTL
  let removed = 0
  for (const [key, progress] of cacheProgress) {
    const updatedAt = progress.updatedAt || 0
    const terminal = ['error', 'finished', 'exists'].includes(progress.status)
    const expiry = terminal ? expiredBefore : now - CACHE_PROGRESS_ACTIVE_TTL
    if (updatedAt > 0 && updatedAt <= expiry) {
      cacheProgress.delete(key)
      removed++
    }
  }
  if (cacheProgress.size === 0 && cacheProgressCleanupTimer) {
    clearTimeout(cacheProgressCleanupTimer)
    cacheProgressCleanupTimer = null
  }
  return removed
}

const scheduleCacheProgressCleanup = () => {
  if (cacheProgressCleanupTimer || cacheProgress.size === 0) return
  cacheProgressCleanupTimer = setTimeout(() => {
    cacheProgressCleanupTimer = null
    cleanupExpiredCacheProgress()
    if (cacheProgress.size > 0) scheduleCacheProgressCleanup()
  }, CACHE_PROGRESS_TTL)
  ;(cacheProgressCleanupTimer as any)?.unref?.()
}

export const setCacheProgress = (
  key: string,
  progress: {
    progress: number
    status: string
    total?: number
    received?: number
    speed?: number
    updatedAt?: number
    errorMsg?: string
  },
) => {
  cacheProgress.set(key, { ...progress, updatedAt: progress.updatedAt || Date.now() })
  while (cacheProgress.size > CACHE_PROGRESS_MAX_ENTRIES) {
    let oldestKey: string | undefined
    let oldestUpdatedAt = Number.POSITIVE_INFINITY
    for (const [candidateKey, candidate] of cacheProgress) {
      const updatedAt = candidate.updatedAt || 0
      if (updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = updatedAt
        oldestKey = candidateKey
      }
    }
    if (oldestKey === undefined) break
    cacheProgress.delete(oldestKey)
  }
  scheduleCacheProgressCleanup()
}
