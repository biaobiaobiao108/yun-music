import fs from 'fs'
import path from 'path'
import { getCoverCacheHash, removeCoverCacheFiles } from './cacheCover'
import { invalidateCacheListSync } from './cacheEvents'
import { CACHE_ROOTS, getCacheLocations, indexManager, invalidateCacheFileAvailability } from './cacheIndex'
import type { CacheFolder, CacheItem, RemoveCacheFileResult } from './cacheIndex'
import { getCacheDir, normalizeCacheUsername, resolveCacheRelativePath } from './cachePaths'
import { invalidateGlobalCacheStats } from './cacheStats'

export const removeCacheFile = (
  filename: string,
  username?: string,
  requestedFolder?: CacheFolder,
  requestedLocation?: string,
  knownItem?: CacheItem,
): RemoveCacheFileResult => {
  if (!filename || typeof filename !== 'string') throw new Error('Invalid filename')
  if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') throw new Error('Invalid folder')
  if (requestedLocation && requestedLocation !== CACHE_ROOTS.DATA && requestedLocation !== CACHE_ROOTS.ROOT)
    throw new Error('Invalid cache location')

  const normalizedUsername = normalizeCacheUsername(username)
  const candidateFolders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['cache', 'music']
  const candidateLocations = requestedLocation ? [requestedLocation] : getCacheLocations()
  const matches = candidateLocations
    .flatMap(location =>
      candidateFolders.map(folder => {
        const dir = getCacheDir(normalizedUsername, folder === 'music', location, false)
        const filePath = resolveCacheRelativePath(dir, filename)
        return filePath && fs.existsSync(filePath) ? { folder, dir, filePath, location } : null
      }),
    )
    .filter(
      (entry): entry is { folder: CacheFolder; dir: string; filePath: string; location: string } => entry !== null,
    )

  // Older clients only sent a filename. Keep that format safe when the file has
  // a unique location, but never guess if cache and download both contain it.
  if (!requestedFolder && matches.length > 1) {
    throw new Error(`Ambiguous file location for ${filename}; folder is required`)
  }
  if (matches.length === 0) return { deleted: false }

  const { folder, dir, filePath, location } = matches[0]
  let coverCacheHash = ''
  try {
    coverCacheHash = getCoverCacheHash(filename, fs.statSync(filePath))
  } catch (e) {}

  try {
    fs.unlinkSync(filePath)
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e
  }
  invalidateCacheFileAvailability()
  console.log(`[FileCache] Deleted from ${folder}: ${filename}`)

  const ext = path.extname(filename)
  if (ext !== '.lrc') {
    const baseWithoutExt = filename.substring(0, filename.length - ext.length)
    const lrcPath = resolveCacheRelativePath(dir, baseWithoutExt + '.lrc')
    if (lrcPath && fs.existsSync(lrcPath)) {
      try {
        fs.unlinkSync(lrcPath)
      } catch (e: any) {
        // The audio file and its index row are already gone; a locked/readonly
        // lyric must not keep a stale index entry alive.
        if (e?.code !== 'ENOENT') {
          console.warn(`[FileCache] Failed to delete lyric beside ${filename}: ${e?.message || e}`)
        }
      }
    }
  }

  const item =
    knownItem?.filename === filename
      ? knownItem
      : indexManager.getAll(normalizedUsername, folder, location).find(i => i.filename === filename)
  if (item) indexManager.remove(normalizedUsername, item.id, folder, item.quality, location)
  invalidateCacheListSync(normalizedUsername)

  // Cover cache is shared by filename. Preserve it while the same relative
  // file still exists in any other cache/download location.
  const hasCounterpart = getCacheLocations().some(otherLocation =>
    (['cache', 'music'] as const).some(otherFolder => {
      if (otherLocation === location && otherFolder === folder) return false
      const otherDir = getCacheDir(normalizedUsername, otherFolder === 'music', otherLocation, false)
      const otherPath = resolveCacheRelativePath(otherDir, filename)
      return !!otherPath && fs.existsSync(otherPath)
    }),
  )
  if (!hasCounterpart) {
    removeCoverCacheFiles(filename, normalizedUsername, coverCacheHash)
  }

  invalidateGlobalCacheStats()
  return { deleted: true, folder }
}

/**
 * 记录缓存文件最近一次开始播放的时间。
 *
 * 播放器只会在 audio.play() 成功后调用此方法，因此预读、搜索命中或
 * 单纯打开缓存管理页面都不会把歌曲误判为“最近播放”。
 */
export const markCachePlayback = (
  filename: string,
  username?: string,
  requestedFolder?: CacheFolder,
  requestedLocation?: string,
): boolean => {
  if (!filename || typeof filename !== 'string') return false
  if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') return false
  if (requestedLocation && requestedLocation !== CACHE_ROOTS.DATA && requestedLocation !== CACHE_ROOTS.ROOT)
    return false

  const normalizedUsername = normalizeCacheUsername(username)
  const candidateFolders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['cache', 'music']
  const candidateLocations = requestedLocation ? [requestedLocation] : getCacheLocations()
  const matches = candidateLocations
    .flatMap(location =>
      candidateFolders.map(folder => {
        const dir = getCacheDir(normalizedUsername, folder === 'music', location, false)
        const filePath = resolveCacheRelativePath(dir, filename)
        return filePath && fs.existsSync(filePath) ? { folder, filePath, location } : null
      }),
    )
    .filter((entry): entry is { folder: CacheFolder; filePath: string; location: string } => entry !== null)

  // 播放器始终会传 folder；未传时不在 cache/music 同名文件之间猜测。
  if (!requestedFolder && matches.length !== 1) return false
  if (matches.length === 0) return false

  const { folder, location } = matches[0]
  const item = indexManager
    .getAll(normalizedUsername, folder, location)
    .find(candidate => candidate.filename === filename)
  if (!item) return false

  item.lastPlayedAt = Date.now()
  indexManager.update(normalizedUsername, item, folder, location)
  return true
}
