import fs from 'fs'
import path from 'path'
import { NativeLruCache } from '@/utils/nativeLru'
import { walkCacheFilesAsync } from './cacheFileWalker'
import { CACHE_ROOTS, getCacheLocations, indexManager } from './cacheIndex'
import type { CacheStatsSummary } from './cacheIndex'
import { scheduleCacheIndexSync } from './cacheIndexSync'
import { getCacheDir, getRootPath, normalizeCacheUsername } from './cachePaths'

const scanCacheStats = (username?: string): CacheStatsSummary => {
  const roots = ['cache', 'music']
  const result: any = {
    cache: { totalSize: 0, fileCount: 0 },
    music: { totalSize: 0, fileCount: 0 },
    totalSize: 0,
    fileCount: 0,
  }
  const normalizedUsername = normalizeCacheUsername(username)
  const extensions = CACHE_SIZE_EXTENSIONS
  const seenPaths = new Set<string>()
  for (const location of getCacheLocations()) {
    for (const folder of roots) {
      const dir = getCacheDir(normalizedUsername, folder === 'music', location, false)
      if (!fs.existsSync(dir)) continue
      const files = getCacheFilesRecursively(dir)
      for (const filePath of files) {
        const resolvedPath = path.resolve(filePath)
        if (seenPaths.has(resolvedPath)) continue
        seenPaths.add(resolvedPath)
        const ext = path.extname(filePath).toLowerCase()
        if (extensions.has(ext)) {
          try {
            const stats = fs.statSync(filePath)
            result[folder].totalSize += stats.size
            result.totalSize += stats.size
            if (ext !== '.lrc') {
              result[folder].fileCount++
              result.fileCount++
            }
          } catch (e) {}
        }
      }
    }
  }
  return result
}

let lastGlobalStats: CacheStatsSummary | null = null
let lastGlobalStatsTime = 0
const GLOBAL_STATS_TTL = 10 * 1000

export const invalidateGlobalCacheStats = () => {
  lastGlobalStatsTime = 0
  displayStatsGeneration++
  cachedDisplayStats.clear()
}

const scanGlobalCacheStats = (): CacheStatsSummary => {
  const now = Date.now()
  if (lastGlobalStats && now - lastGlobalStatsTime < GLOBAL_STATS_TTL) {
    return lastGlobalStats
  }

  const roots: Array<'cache' | 'music'> = ['cache', 'music']
  const result = {
    cache: { totalSize: 0, fileCount: 0 },
    music: { totalSize: 0, fileCount: 0 },
    totalSize: 0,
    fileCount: 0,
  }
  const extensions = CACHE_SIZE_EXTENSIONS
  const seenPaths = new Set<string>()

  for (const location of getCacheLocations()) {
    for (const folder of roots) {
      let baseDir = ''
      if (location === CACHE_ROOTS.DATA) {
        const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
        baseDir = path.join(dataPath, folder)
      } else {
        baseDir = path.join(getRootPath(), folder)
      }
      if (!fs.existsSync(baseDir)) continue

      let userEntries: fs.Dirent[] = []
      try {
        userEntries = fs.readdirSync(baseDir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const userEntry of userEntries) {
        if (userEntry.isSymbolicLink()) continue
        const userPath = path.join(baseDir, userEntry.name)
        if (userEntry.isDirectory()) {
          const files = getCacheFilesRecursively(userPath)
          for (const filePath of files) {
            const resolved = path.resolve(filePath)
            if (seenPaths.has(resolved)) continue
            seenPaths.add(resolved)

            const ext = path.extname(filePath).toLowerCase()
            if (extensions.has(ext)) {
              try {
                const stats = fs.statSync(filePath)
                result[folder].totalSize += stats.size
                result.totalSize += stats.size
                if (ext !== '.lrc') {
                  result[folder].fileCount++
                  result.fileCount++
                }
              } catch {}
            }
          }
        } else if (userEntry.isFile()) {
          const resolved = path.resolve(userPath)
          if (seenPaths.has(resolved)) continue
          seenPaths.add(resolved)
          const ext = path.extname(userPath).toLowerCase()
          if (extensions.has(ext)) {
            try {
              const stats = fs.statSync(userPath)
              result[folder].totalSize += stats.size
              result.totalSize += stats.size
              if (ext !== '.lrc') {
                result[folder].fileCount++
                result.fileCount++
              }
            } catch {}
          }
        }
      }
    }
  }

  lastGlobalStats = result
  lastGlobalStatsTime = now
  return result
}

/**
 * Read user cache statistics from both physical roots. The index is scoped to
 * one location and can lag behind files created before indexing, so limits
 * must include an on-disk scan rather than trust a partial SQLite aggregate.
 */
export const getCacheStats = (username?: string): CacheStatsSummary => {
  const normalizedUsername = normalizeCacheUsername(username)
  scheduleCacheIndexSync(normalizedUsername)
  // The index is location scoped and may be partially populated while old
  // files remain in the other storage root. Count physical files from both
  // roots so cache limits cannot be bypassed by a partial/stale index.
  return scanCacheStats(normalizedUsername)
}

export const getGlobalCacheStats = (): CacheStatsSummary => {
  const now = Date.now()
  if (lastGlobalStats && now - lastGlobalStatsTime < GLOBAL_STATS_TTL) return lastGlobalStats

  const configuredUsers = global.lx?.config?.users || []
  scheduleCacheIndexSync('_open')
  for (const user of configuredUsers) {
    if (user?.name) scheduleCacheIndexSync(user.name)
  }

  const result = scanGlobalCacheStats()
  lastGlobalStats = result
  lastGlobalStatsTime = now
  return result
}

export const CACHE_SIZE_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.lrc'])

const CACHE_STATS_REFRESH_TTL_MS = 10 * 1000
const cachedDisplayStats = new NativeLruCache<string, { stats: CacheStatsSummary; refreshedAt: number }>({ max: 2048 })
const displayStatsRefreshes = new Map<string, Promise<void>>()
let displayStatsGeneration = 0

const createEmptyCacheStats = (): CacheStatsSummary => ({
  cache: { totalSize: 0, fileCount: 0 },
  music: { totalSize: 0, fileCount: 0 },
  totalSize: 0,
  fileCount: 0,
})

const getStatsRoots = (username?: string): Array<{ folder: 'cache' | 'music'; dir: string }> => {
  const roots: Array<{ folder: 'cache' | 'music'; dir: string }> = []
  for (const location of getCacheLocations()) {
    for (const folder of ['cache', 'music'] as const) {
      const dir = username
        ? getCacheDir(username, folder === 'music', location, false)
        : location === CACHE_ROOTS.DATA
          ? path.join(global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data'), folder)
          : path.join(getRootPath(), folder)
      roots.push({ folder, dir })
    }
  }
  return roots
}

/** Slow, exact disk scan used off the request path and by quota enforcement. */
const scanCacheStatsAsync = async (username?: string): Promise<CacheStatsSummary> => {
  const result = createEmptyCacheStats()
  const seenRoots = new Set<string>()

  for (const { folder, dir } of getStatsRoots(username)) {
    const resolvedRoot = path.resolve(dir)
    if (seenRoots.has(resolvedRoot)) continue
    seenRoots.add(resolvedRoot)

    for await (const filePath of walkCacheFilesAsync(dir)) {
      if (!CACHE_SIZE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue
      try {
        const stats = await fs.promises.stat(filePath)
        if (!stats.isFile()) continue
        result[folder].totalSize += stats.size
        result.totalSize += stats.size
        if (path.extname(filePath).toLowerCase() !== '.lrc') {
          result[folder].fileCount++
          result.fileCount++
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') console.error(`[fileCache] failed to read cache size: ${filePath}`, error)
      }
    }
  }
  return result
}

const scheduleDisplayStatsRefresh = (key: string, username?: string): void => {
  if (displayStatsRefreshes.has(key)) return
  const generation = displayStatsGeneration
  const refresh = scanCacheStatsAsync(username)
    .then(stats => {
      if (generation === displayStatsGeneration) {
        cachedDisplayStats.set(key, { stats, refreshedAt: Date.now() })
        if (key === 'global') {
          lastGlobalStats = stats
          lastGlobalStatsTime = Date.now()
        }
      }
    })
    .catch(error => {
      console.error(`[fileCache] cache stats refresh failed${username ? ` for ${username}` : ''}:`, error)
    })
    .finally(() => {
      if (displayStatsRefreshes.get(key) === refresh) displayStatsRefreshes.delete(key)
    })
  displayStatsRefreshes.set(key, refresh)
}

/**
 * Display-only stats: serve a recent disk scan or the SQLite aggregate, then
 * refresh from disk asynchronously. Cache limits use the exact async scan.
 */
export const getCachedCacheStats = (username?: string): CacheStatsSummary => {
  const normalizedUsername = normalizeCacheUsername(username)
  const key = `user:${normalizedUsername}`
  let cached = cachedDisplayStats.get(key)
  if (!cached) {
    cached = { stats: indexManager.getStats(normalizedUsername).stats, refreshedAt: 0 }
    cachedDisplayStats.set(key, cached)
  }
  if (Date.now() - cached.refreshedAt >= CACHE_STATS_REFRESH_TTL_MS) {
    scheduleCacheIndexSync(normalizedUsername)
    scheduleDisplayStatsRefresh(key, normalizedUsername)
  }
  return cached.stats
}

/** Display-only global stats; the SQLite aggregate avoids a cold disk scan. */
export const getCachedGlobalCacheStats = (): CacheStatsSummary => {
  let cached = cachedDisplayStats.get('global')
  if (!cached) {
    cached = { stats: indexManager.getStats().stats, refreshedAt: 0 }
    cachedDisplayStats.set('global', cached)
  }
  if (Date.now() - cached.refreshedAt >= CACHE_STATS_REFRESH_TTL_MS) {
    scheduleCacheIndexSync('_open')
    for (const user of global.lx?.config?.users || []) {
      if (user?.name) scheduleCacheIndexSync(user.name)
    }
    scheduleDisplayStatsRefresh('global')
  }
  return cached.stats
}

export const getCacheFilesRecursively = (root: string): string[] => {
  const files: string[] = []
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const filePath = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(filePath)
      else if (entry.isFile()) files.push(filePath)
    }
  }
  visit(root)
  return files
}
