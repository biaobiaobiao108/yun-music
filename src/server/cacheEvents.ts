import { NativeLruCache } from '@/utils/nativeLru'
import { normalizeCacheUsername } from './cachePaths'
import { CACHE_ROOTS } from './cacheIndex'

export const CACHE_LIST_SYNC_TTL = 30 * 1000
export const cacheListSyncState = new NativeLruCache<string, { lastSync: number; pending?: Promise<void> }>({
  max: 2048,
  ttl: 10 * 60 * 1000,
})
export const lyricMissCache = new NativeLruCache<string, true>({ max: 4096, ttl: 15_000 })

type CacheChangeListener = (username: string) => void
const cacheChangeListeners = new Set<CacheChangeListener>()

export const invalidateCacheListSync = (username?: string) => {
  const normalizedUsername = normalizeCacheUsername(username)
  lyricMissCache.clear()
  for (const location of [CACHE_ROOTS.ROOT, CACHE_ROOTS.DATA]) {
    cacheListSyncState.delete(`${location}:${normalizedUsername}`)
  }
  for (const listener of cacheChangeListeners) {
    try {
      listener(normalizedUsername)
    } catch {
      /* a disconnected event stream must not affect cache writes */
    }
  }
}

/** Subscribe to physical cache/index changes for live player synchronization. */
export const subscribeCacheChanges = (listener: CacheChangeListener): (() => void) => {
  cacheChangeListeners.add(listener)
  return () => cacheChangeListeners.delete(listener)
}
