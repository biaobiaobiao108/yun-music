import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { getCoverCacheBaseDirs, getCoverCacheHash, getCoverCacheUserDir, getCoverCacheUserDirs } from './cacheCover'
import { walkCacheFilesAsync } from './cacheFileWalker'
import { invalidateCacheListSync } from './cacheEvents'
import { removeCacheFile } from './cacheEntry'
import { scheduleCacheIndexSync } from './cacheIndexSync'
import { CACHE_ROOTS, getCacheLocations, indexManager } from './cacheIndex'
import type { CacheFolder, CacheItem } from './cacheIndex'
import { getCacheDir, getRootPath, normalizeCacheUsername, pathExists, resolveCacheRelativePath } from './cachePaths'
import { isCacheEntryProcessing } from './cacheProgress'
import { CACHE_SIZE_EXTENSIONS, getCacheFilesRecursively, invalidateGlobalCacheStats } from './cacheStats'

export interface CacheCleanupResult {
  deletedCount: number
  freedSize: number
}

const removeDirectoryTree = (dir: string): CacheCleanupResult => {
  if (!pathExists(dir)) return { deletedCount: 0, freedSize: 0 }
  const files = getCacheFilesRecursively(dir)
  let deletedCount = 0
  let freedSize = 0
  for (const filePath of files) {
    try {
      const stats = fs.statSync(filePath)
      fs.unlinkSync(filePath)
      deletedCount++
      freedSize += stats.size
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        // Continue cleaning the remaining files. A locked file should
        // not prevent the rest of a user's disposable cache from being removed.
      }
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // File-level cleanup above is still useful when directory removal is blocked.
  }
  return { deletedCount, freedSize }
}

const addCleanupResult = (target: CacheCleanupResult, source: CacheCleanupResult): void => {
  target.deletedCount += source.deletedCount
  target.freedSize += source.freedSize
}

const getUserCacheDirectories = (username: string, preserveMusic: boolean): string[] => {
  const directories = new Set<string>()
  for (const location of getCacheLocations()) {
    const folders: CacheFolder[] = preserveMusic ? ['cache'] : ['cache', 'music']
    for (const folder of folders) {
      directories.add(getCacheDir(username, folder === 'music', location, false))
    }
  }
  for (const dir of getCoverCacheUserDirs(username, false)) directories.add(dir)
  return [...directories]
}

/** Remove a user's cache files; optionally retain their downloaded music and index. */
export const deleteUserCacheData = (
  username: string,
  options: { preserveMusic?: boolean } = {},
): CacheCleanupResult => {
  const normalizedUsername = normalizeCacheUsername(username)
  const folders: CacheFolder[] = options.preserveMusic ? ['cache'] : ['cache', 'music']
  const result: CacheCleanupResult = { deletedCount: 0, freedSize: 0 }
  for (const dir of getUserCacheDirectories(normalizedUsername, Boolean(options.preserveMusic))) {
    addCleanupResult(result, removeDirectoryTree(dir))
  }
  for (const location of getCacheLocations()) {
    for (const folder of folders) {
      indexManager.clear(normalizedUsername, folder, location)
    }
  }
  invalidateCacheListSync(normalizedUsername)
  return result
}

/** Move a user's physical cache when their login name changes. */
export const moveUserCacheData = (oldUsername: string, newUsername: string): { movedDirectories: number } => {
  const oldName = normalizeCacheUsername(oldUsername)
  const newName = normalizeCacheUsername(newUsername)
  if (oldName === '_open' || newName === '_open' || oldName === newName) return { movedDirectories: 0 }

  // Validate names before constructing any filesystem path. This also keeps
  // reserved public-cache names out of the account migration path.
  assertSafePathSegment(oldName, 'old username')
  assertSafePathSegment(newName, 'new username')

  const moves: Array<{ source: string; target: string }> = []
  const seen = new Set<string>()
  const addMove = (source: string, target: string): void => {
    const key = `${source}\u0000${target}`
    if (!seen.has(key)) {
      seen.add(key)
      moves.push({ source, target })
    }
  }
  for (const location of getCacheLocations()) {
    for (const folder of ['cache', 'music'] as const) {
      addMove(
        getCacheDir(oldName, folder === 'music', location, false),
        getCacheDir(newName, folder === 'music', location, false),
      )
    }
  }
  const coverDirs = getCoverCacheBaseDirs()
  for (const baseDir of coverDirs) {
    addMove(getCoverCacheUserDir(baseDir, oldName, false), getCoverCacheUserDir(baseDir, newName, false))
  }

  const existingMoves = moves.filter(move => pathExists(move.source))
  for (const move of existingMoves) {
    const sourceStats = fs.lstatSync(move.source)
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
      throw new Error('用户缓存目录不是安全的普通目录')
    }
    if (pathExists(move.target)) {
      throw new Error(`目标缓存目录已存在：${newName}`)
    }
  }

  const completed: Array<{ source: string; target: string }> = []
  try {
    for (const move of existingMoves) {
      fs.mkdirSync(path.dirname(move.target), { recursive: true, mode: 0o700 })
      fs.renameSync(move.source, move.target)
      completed.push(move)
    }
  } catch (error) {
    for (const move of completed.reverse()) {
      try {
        if (pathExists(move.target) && !pathExists(move.source)) fs.renameSync(move.target, move.source)
      } catch {}
    }
    throw error
  }

  invalidateCacheListSync(oldName)
  invalidateCacheListSync(newName)
  return { movedDirectories: completed.length }
}

export const clearAllCache = (username?: string) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const result: CacheCleanupResult = { deletedCount: 0, freedSize: 0 }
  for (const dir of getUserCacheDirectories(normalizedUsername, false)) {
    addCleanupResult(result, removeDirectoryTree(dir))
  }
  for (const location of getCacheLocations()) {
    for (const folder of ['cache', 'music'] as const) {
      indexManager.clear(normalizedUsername, folder, location)
    }
  }
  invalidateCacheListSync(normalizedUsername)
  invalidateGlobalCacheStats()
  return result
}

export const clearOnlyAudioCache = (username?: string) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const result: CacheCleanupResult = { deletedCount: 0, freedSize: 0 }
  for (const location of getCacheLocations()) {
    const dir = getCacheDir(normalizedUsername, false, location, false)
    addCleanupResult(result, removeDirectoryTree(dir))
    indexManager.clear(normalizedUsername, 'cache', location)
  }
  // Covers are shared across both roots and folders. Keep only those still
  // referenced by durable downloads, including unindexed local music.
  const retainedCoverHashes = new Set<string>()
  for (const location of getCacheLocations()) {
    const musicDir = getCacheDir(normalizedUsername, true, location, false)
    for (const file of getCacheFilesRecursively(musicDir)) {
      const filename = path.relative(musicDir, file).replace(/\\/g, '/')
      try {
        retainedCoverHashes.add(getCoverCacheHash(filename, fs.statSync(file)))
        retainedCoverHashes.add(getCoverCacheHash(filename))
        retainedCoverHashes.add(crypto.createHash('md5').update(filename).digest('hex'))
      } catch {}
    }
  }
  for (const coverDir of getCoverCacheUserDirs(normalizedUsername, false)) {
    for (const file of getCacheFilesRecursively(coverDir)) {
      if (!/\.(?:bin|mime)$/.test(file) || retainedCoverHashes.has(path.basename(file, path.extname(file)))) continue
      try {
        const size = fs.statSync(file).size
        fs.unlinkSync(file)
        result.deletedCount++
        result.freedSize += size
      } catch {}
    }
  }
  invalidateCacheListSync(normalizedUsername)
  invalidateGlobalCacheStats()
  return result
}

export const clearAllUsersAudioCache = () => {
  const result: CacheCleanupResult = { deletedCount: 0, freedSize: 0 }
  const usernames = new Set<string>()
  const addUsername = (value: unknown) => {
    if (typeof value !== 'string' || !value) return
    try {
      usernames.add(normalizeCacheUsername(value))
    } catch {
      // Stale directories or legacy aliases are not valid cache users.
    }
  }
  addUsername('_open')
  const configuredUsers = global.lx?.config?.users || []
  for (const u of configuredUsers) {
    addUsername(u?.name)
  }
  for (const location of getCacheLocations()) {
    let baseDir = ''
    if (location === CACHE_ROOTS.DATA) {
      const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
      baseDir = path.join(dataPath, 'cache')
    } else {
      baseDir = path.join(getRootPath(), 'cache')
    }
    if (fs.existsSync(baseDir)) {
      try {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            addUsername(entry.name)
          }
        }
      } catch {}
    }
  }
  for (const u of usernames) {
    try {
      addCleanupResult(result, clearOnlyAudioCache(u))
    } catch (error) {
      console.warn(`[FileCache] Failed to clear audio cache for ${JSON.stringify(u)}:`, error)
    }
  }
  invalidateGlobalCacheStats()
  return result
}

export const clearLyricCache = (username?: string) => {
  const roots: Array<'cache' | 'music'> = ['cache', 'music']
  let deletedCount = 0
  let freedSize = 0
  const normalizedUsername = normalizeCacheUsername(username)
  for (const location of getCacheLocations()) {
    for (const folder of roots) {
      const dir = getCacheDir(normalizedUsername, folder === 'music', location, false)
      if (!fs.existsSync(dir)) continue
      for (const filePath of getCacheFilesRecursively(dir)) {
        if (path.extname(filePath).toLowerCase() === '.lrc') {
          try {
            const stats = fs.statSync(filePath)
            fs.unlinkSync(filePath)
            deletedCount++
            freedSize += stats.size
          } catch (error: any) {
            if (error?.code !== 'ENOENT') {
            }
          }
        }
      }
      const items = indexManager.getAll(normalizedUsername, folder, location)
      items.forEach(item => {
        if (!item.hasLyric && !item.lyricFilename) return
        item.hasLyric = false
        item.lyricFilename = undefined
        item.lyricSize = 0
        indexManager.update(normalizedUsername, item, folder, location)
      })
    }
  }
  invalidateCacheListSync(normalizedUsername)
  return { deletedCount, freedSize }
}

export const checkAndCleanupCache = async (username?: string) => {
  const config = (global as any).lx.config
  if (!config || !config['user.enableCacheSizeLimit']) return
  const normalizedUsername = normalizeCacheUsername(username)
  scheduleCacheIndexSync(normalizedUsername)

  type CleanupCandidate = {
    path: string
    location: string
    size: number
    mtime: number
    lastPlayedAt: number
    id?: string
    quality?: string
    item?: CacheItem
  }
  const allFiles: CleanupCandidate[] = []
  let cacheSize = 0
  for (const location of getCacheLocations()) {
    const dir = getCacheDir(normalizedUsername, false, location, false)
    const files = new Map<string, { size: number; mtime: number; ext: string }>()
    const companionLyrics = new Map<string, string>()
    for await (const filePath of walkCacheFilesAsync(dir)) {
      const ext = path.extname(filePath).toLowerCase()
      try {
        const fileStat = await fs.promises.stat(filePath)
        if (ext === '.tmp') {
          if (Date.now() - fileStat.mtime.getTime() > 3600_000) await fs.promises.unlink(filePath)
          continue
        }
        if (!CACHE_SIZE_EXTENSIONS.has(ext) || !fileStat.isFile()) continue
        const file = { size: fileStat.size, mtime: fileStat.mtime.getTime(), ext }
        files.set(filePath, file)
        cacheSize += file.size
        if (ext === '.lrc') {
          const key = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)).toLowerCase())
          companionLyrics.set(key, filePath)
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') console.error(`[fileCache] failed to read cache size: ${filePath}`, error)
      }
    }

    const indexedFiles = new Set<string>()
    const indexedItems = indexManager.getAll(normalizedUsername, 'cache', location)

    // 以歌曲为清理单元，把同名歌词一起计入大小，避免先删掉歌词、
    // 后删音频时出现索引状态和实际占用不一致。
    for (const item of indexedItems) {
      const audioPath = resolveCacheRelativePath(dir, item.filename)
      const audioFile = audioPath ? files.get(audioPath) : undefined
      if (!audioPath || !audioFile || audioFile.ext === '.lrc') continue

      const lyricPath = item.lyricFilename
        ? resolveCacheRelativePath(dir, item.lyricFilename)
        : companionLyrics.get(
            path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)).toLowerCase()),
          )
      const lyricFile = lyricPath ? files.get(lyricPath) : undefined
      indexedFiles.add(audioPath)
      if (lyricFile && lyricPath) indexedFiles.add(lyricPath)
      const size = audioFile.size + (lyricFile?.size || 0)
      const mtime = Math.min(audioFile.mtime, lyricFile?.mtime ?? Number.POSITIVE_INFINITY)
      const lastPlayedAt = Number(item.lastPlayedAt)
      // A file that was just downloaded has no playback record yet. Treat
      // "never played" as its mtime, not as 0, otherwise every quota cleanup
      // deletes the newest download before any older played track.
      const effectivePlayedAt = Number.isFinite(lastPlayedAt) && lastPlayedAt > 0 ? lastPlayedAt : mtime
      allFiles.push({
        path: audioPath,
        location,
        size,
        mtime,
        lastPlayedAt: effectivePlayedAt,
        id: item.id,
        quality: item.quality,
        item,
      })
    }

    // Unindexed legacy files, including orphan lyrics, remain eligible and
    // are treated as never played.
    for (const [filePath, fileStat] of files) {
      if (indexedFiles.has(filePath)) continue
      allFiles.push({
        path: filePath,
        location,
        size: fileStat.size,
        mtime: fileStat.mtime,
        lastPlayedAt: fileStat.mtime,
      })
    }
  }

  const limitBytes = (config['user.cacheSizeLimit'] || 2000) * 1024 * 1024
  if (cacheSize <= limitBytes) return

  allFiles.sort((a, b) => a.lastPlayedAt - b.lastPlayedAt || a.mtime - b.mtime)
  let currentSize = cacheSize
  const targetSize = limitBytes * 0.95
  let deletedCount = 0
  for (const file of allFiles) {
    if (currentSize <= targetSize) break
    if (!fs.existsSync(file.path)) continue
    // A download that is still tagging/embedding has an index row but must not
    // be evicted by a cleanup triggered by a sibling task.
    if (file.id && isCacheEntryProcessing(file.id, file.quality, normalizedUsername)) continue
    try {
      const dir = getCacheDir(normalizedUsername, false, file.location, false)
      const relPath = path.relative(dir, file.path).replace(/\\/g, '/')
      const res = removeCacheFile(relPath, normalizedUsername, 'cache', file.location, file.item)
      if (res.deleted) {
        currentSize -= file.size
        deletedCount++
      }
    } catch (e) {
      try {
        fs.unlinkSync(file.path)
        const dir = getCacheDir(normalizedUsername, false, file.location, false)
        const relPath = path.relative(dir, file.path).replace(/\\/g, '/')
        const item =
          file.item ||
          indexManager
            .getAll(normalizedUsername, 'cache', file.location)
            .find(candidate => candidate.filename === relPath)
        if (item) indexManager.remove(normalizedUsername, item.id, 'cache', item.quality, file.location)
        currentSize -= file.size
        deletedCount++
      } catch (_) {}
    }
  }
  if (deletedCount > 0) {
    invalidateCacheListSync(normalizedUsername)
  }
  console.log(`[FileCache] Cleaned up ${deletedCount} least-recently-played cache entries for ${normalizedUsername}`)
}
/**
 * Switch files between 'cache' and 'music' folders
 */
