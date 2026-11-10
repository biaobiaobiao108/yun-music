import fs from 'fs'
import path from 'path'
import { resolveInside } from '@/utils/pathSecurity'
import { getMusicTagNative } from './musicTagNative'
import { COVER_CHECK_VERSION, downloadCoverImage, hasCachedCover, readCoverCache, writeCoverCache } from './cacheCover'
import { scheduleCacheIndexSync } from './cacheIndexSync'
import { extractSongMetadata, getFileName } from './cacheNaming'
import { getCacheDir, getRootPath, normalizeCacheUsername, resolveCacheRelativePath } from './cachePaths'
import { withCachePostProcess } from './cachePostProcess'
import { resolveCompanionLyricFilename } from './cacheLyrics'
import { moveFileNoOverwriteSync } from './cacheFileMove'
import {
  detectAudioContainer,
  getMetadataUnsupportedMessage,
  hasUsableRemoteCover,
  readEmbeddedCoverState,
} from './cacheMetadata'
import { CACHE_ROOTS, getCacheLocations, indexManager } from './cacheIndex'
import type { CacheFolder, CacheItem } from './cacheIndex'

export { CACHE_ROOTS, getCacheLocation, getCacheLocations, indexManager, setCacheLocation } from './cacheIndex'
export type { CacheFolder, CacheItem, CacheStatsSummary, DownloadProvenance, RemoveCacheFileResult } from './cacheIndex'
export { detectDownloadSource, embedLyricsIntoFile, getAudioMetadataUnsupportedStatus } from './cacheMetadata'
export { downloadCoverImage, getCacheCover, getCoverCacheDir } from './cacheCover'
export { syncCacheIndex } from './cacheIndexSync'
export { subscribeCacheChanges } from './cacheEvents'
export {
  CACHE_NAMING_PATTERNS,
  getNamingPattern,
  getSongIdCandidates,
  normalizeNamingPattern,
  normalizeSongId,
  setNamingPattern,
} from './cacheNaming'
export { getCacheDir, resolveCacheRelativePath } from './cachePaths'
export {
  bindCacheProgress,
  cacheProgress,
  cleanupExpiredCacheProgress,
  getActiveCacheProgress,
  isCacheEntryProcessing,
  setCacheProgress,
} from './cacheProgress'
export { getCachePostProcessStats, withCachePostProcess } from './cachePostProcess'
export {
  getCacheStats,
  getCachedCacheStats,
  getCachedGlobalCacheStats,
  getGlobalCacheStats,
  invalidateGlobalCacheStats,
} from './cacheStats'
export {
  clearAllCache,
  clearAllUsersAudioCache,
  clearLyricCache,
  clearOnlyAudioCache,
  deleteUserCacheData,
  moveUserCacheData,
  checkAndCleanupCache,
} from './cacheMaintenance'
export type { CacheCleanupResult } from './cacheMaintenance'
export { markCachePlayback, removeCacheFile } from './cacheEntry'
export { linkFileWithoutOverwrite } from './cacheFileMove'
export { downloadAndCache } from './cacheDownload'
export { checkCache } from './cacheLookup'
export {
  promoteCacheFile,
  promoteCachedSongToMusic,
  removeDuplicateCacheForSong,
  switchBaseLocation,
  switchFolder,
} from './cacheTransfer'
export {
  checkLyricCache,
  getLyricFetcher,
  resolveCompanionLyricFilename,
  saveLyricCache,
  setLyricFetcher,
} from './cacheLyrics'

// --- Public APIs ---

/**
 * Sync disk files with index database
 */
export const getCacheList = async (username?: string) => {
  const normalizedUsername = normalizeCacheUsername(username)

  // Return the current SQLite index immediately. Disk reconciliation is
  // deliberately detached from the request so a large library cannot hold
  // the list endpoint open while metadata and cover state are inspected.
  scheduleCacheIndexSync(normalizedUsername)

  const items = getCacheLocations().flatMap(location => [
    ...indexManager.getAll(normalizedUsername, 'cache', location).map(item => ({ ...item, location })),
    ...indexManager.getAll(normalizedUsername, 'music', location).map(item => ({ ...item, location })),
  ])

  return items.map(item => ({
    ...item,
    username: normalizedUsername === '_open' ? '公共曲库' : normalizedUsername,
    rawUsername: normalizedUsername,
    songInfo: {
      id: item.id,
      songmid: item.songmid || item.id,
      name: item.name,
      singer: item.singer,
      source: item.source,
      quality: item.quality,
      albumName: item.albumName,
      albumId: item.albumId,
      img: item.img,
      interval: item.interval,
      type: item.quality, // Compatibility
      types: {}, // To be filled if needed
    },
    hasLyric: item.hasLyric || !!item.lyricFilename,
  }))
}

/**
 * Get cache list across all users and the public library
 */
export const getAllCacheList = async () => {
  const usernames = new Set<string>(['_open'])
  const configuredUsers = global.lx?.config?.users || []
  for (const u of configuredUsers) {
    if (u?.name) usernames.add(u.name)
  }

  for (const location of getCacheLocations()) {
    for (const folder of ['cache', 'music'] as const) {
      let baseDir = ''
      if (location === CACHE_ROOTS.DATA) {
        const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
        baseDir = path.join(dataPath, folder)
      } else {
        baseDir = path.join(getRootPath(), folder)
      }
      if (fs.existsSync(baseDir)) {
        try {
          const entries = fs.readdirSync(baseDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
              usernames.add(entry.name)
            }
          }
        } catch {}
      }
    }
  }

  const allItems: any[] = []
  for (const user of usernames) {
    try {
      const list = await getCacheList(user)
      allItems.push(...list)
    } catch (err) {
      console.error(`[getAllCacheList] Failed to fetch cache list for ${user}:`, err)
    }
  }
  return allItems
}

/**
 * Batch rename existing files to the current naming pattern
 */
export const batchRenameCacheFiles = async (username: string | undefined) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const folders: Array<'cache' | 'music'> = ['cache', 'music']

  let successCount = 0
  let failCount = 0
  let skipCount = 0

  for (const location of getCacheLocations()) {
    for (const folder of folders) {
      const items = indexManager.getAll(normalizedUsername, folder, location)

      for (const item of items) {
        const songInfo = {
          id: item.id,
          songmid: item.songmid || item.id,
          name: item.name,
          singer: item.singer,
          source: item.source,
          quality: item.quality,
          albumName: item.albumName,
          albumId: item.albumId,
          img: item.img,
          interval: item.interval,
        }

        const newBaseName = getFileName(songInfo, item.quality, folder === 'music', normalizedUsername)
        const newFilename = `${newBaseName}.${item.ext}`

        if (newFilename === item.filename) {
          skipCount++
          continue
        }

        const dir = getCacheDir(normalizedUsername, folder === 'music', location)
        const oldPath = resolveCacheRelativePath(dir, item.filename)
        const newPath = resolveCacheRelativePath(dir, newFilename)
        if (!oldPath || !newPath) {
          failCount++
          continue
        }

        try {
          if (fs.existsSync(oldPath)) {
            if (!fs.existsSync(newPath)) {
              const oldStats = fs.statSync(oldPath)
              const externalCover = readCoverCache(item.filename, normalizedUsername, oldStats)
              fs.renameSync(oldPath, newPath)

              if (item.lyricFilename) {
                const oldLrcPath = resolveCacheRelativePath(dir, item.lyricFilename)
                const newLrcFilename = `${newBaseName}.lrc`
                const newLrcPath = resolveCacheRelativePath(dir, newLrcFilename)
                if (oldLrcPath && newLrcPath && fs.existsSync(oldLrcPath)) {
                  fs.renameSync(oldLrcPath, newLrcPath)
                  item.lyricFilename = newLrcFilename
                }
              }

              item.filename = newFilename
              if (externalCover) {
                writeCoverCache(
                  newFilename,
                  normalizedUsername,
                  externalCover.data,
                  externalCover.mime,
                  fs.statSync(newPath),
                )
                item.coverType = 'cached'
                item.hasCover = true
              }
              indexManager.update(normalizedUsername, item, folder, location)
              successCount++
            } else {
              failCount++
            }
          } else {
            failCount++
          }
        } catch (e) {
          console.error(`[FileCache] Failed to rename ${item.filename} in ${folder}:`, e)
          failCount++
        }
      }
    }
  }

  return { success: true, successCount, failCount, skipCount }
}

/**
 * Batch update ID3 metadata (title, artist, album, cover) from index to physical files
 */
export const batchUpdateMetadata = async (
  filenames: string[],
  username: string | undefined,
  requestedLocation?: string,
  requestedFolder?: CacheFolder,
) => {
  const normalizedUsername = normalizeCacheUsername(username)
  let successCount = 0
  let failCount = 0

  const allItems = (requestedLocation ? [requestedLocation] : getCacheLocations()).flatMap(location =>
    (requestedFolder ? [requestedFolder] : (['cache', 'music'] as const)).flatMap(folder =>
      indexManager.getAll(normalizedUsername, folder, location).map(item => ({ item, location })),
    ),
  )

  for (const filename of filenames) {
    const entry = allItems.find(candidate => candidate.item.filename === filename)
    if (!entry) {
      failCount++
      continue
    }
    const { item, location } = entry

    const dir = getCacheDir(normalizedUsername, item.folder === 'music', location)
    const filePath = resolveCacheRelativePath(dir, item.filename)

    if (!filePath || !fs.existsSync(filePath)) {
      failCount++
      continue
    }

    let imageBuffer: Buffer | undefined
    try {
      let imageMime = 'image/jpeg'
      const imageUrl = item.img
      if (typeof imageUrl === 'string' && hasUsableRemoteCover(imageUrl)) {
        const remoteCover = await downloadCoverImage(imageUrl)
        if (remoteCover) {
          imageBuffer = remoteCover.data
          imageMime = remoteCover.mime
        }
      }

      let taggerError: any
      await withCachePostProcess(undefined, 'batch metadata update', async () => {
        let tagger: any
        try {
          tagger = new (getMusicTagNative().MusicTagger)()
          tagger.loadPath(filePath)
          tagger.title = item.name || 'Unknown'
          tagger.artist = item.singer || 'Unknown'
          if (item.albumName) tagger.album = item.albumName
          if (imageBuffer && imageBuffer.length > 0) {
            tagger.pictures = [new (getMusicTagNative().MetaPicture)(imageMime, imageBuffer, 'Cover')]
          }
          tagger.save()
        } catch (e) {
          taggerError = e
        } finally {
          try {
            if (tagger) tagger.dispose()
          } catch (e) {}
        }
      })

      const stats = fs.statSync(filePath)
      const hasEmbeddedCover = readEmbeddedCoverState(filePath)
      let hasCover = hasEmbeddedCover || hasCachedCover(item.filename, normalizedUsername, stats)
      if (!hasCover && imageBuffer?.length) {
        hasCover = writeCoverCache(item.filename, normalizedUsername, imageBuffer, imageMime, stats)
        if (taggerError) {
          console.warn(`[FileCache] Audio tags are unavailable for ${filename}; using external cover cache`)
        }
      }
      if (taggerError && !hasCover) throw taggerError
      item.hasCover = hasCover
      item.coverType = hasEmbeddedCover
        ? 'embedded'
        : hasCover
          ? 'cached'
          : hasUsableRemoteCover(item.img)
            ? 'remote'
            : 'none'
      item.metadataWritable = !taggerError
      item.audioContainer = detectAudioContainer(filePath)
      item.metadataError = taggerError ? getMetadataUnsupportedMessage(item.audioContainer) : undefined
      item.coverCheckedVersion = COVER_CHECK_VERSION
      item.coverCheckedMtime = stats.mtimeMs
      item.coverCheckedSize = stats.size
      item.mtime = stats.mtimeMs
      item.size = stats.size

      indexManager.update(normalizedUsername, item, item.folder as 'cache' | 'music', location)
      successCount++
    } catch (e) {
      console.error(`[FileCache] Failed to update metadata for ${filename}:`, e)
      failCount++
    } finally {
      imageBuffer = undefined
    }
  }

  return { successCount, failCount }
}

/**
 * Link an unindexed local file to a specific online song identity
 */
export const linkLocalFile = async (
  oldFilename: string,
  songInfo: any,
  username: string | undefined,
  requestedLocation?: string,
) => {
  const normalizedUsername = normalizeCacheUsername(username)
  if (requestedLocation && !getCacheLocations().includes(requestedLocation)) throw new Error('Invalid cache location')
  const matches = (requestedLocation ? [requestedLocation] : getCacheLocations()).flatMap(location =>
    (['cache', 'music'] as const).flatMap(folder =>
      indexManager
        .getAll(normalizedUsername, folder, location)
        .filter(item => item.filename === oldFilename)
        .map(item => ({ item, location })),
    ),
  )
  if (matches.length === 0) throw new Error('File not found in index')
  if (matches.length > 1) throw new Error('文件存在多个位置，请指定唯一文件')
  const { item, location } = matches[0]!

  const folder = item.folder as 'cache' | 'music'
  const dir = getCacheDir(normalizedUsername, folder === 'music', location)
  const oldPath = resolveCacheRelativePath(dir, item.filename)
  if (!oldPath || !fs.existsSync(oldPath)) throw new Error('Physical file not found')

  // Prepare new metadata from songInfo
  const metadata = extractSongMetadata(songInfo)
  const newId = metadata.id
  const quality = item.quality || 'unknown'
  const ext = item.ext ? `.${item.ext}` : path.extname(oldFilename)

  // Generate new filename based on pattern (preserving subPath)
  const newBaseName = getFileName(songInfo, quality, folder === 'music', normalizedUsername)
  const subPath = item.subPath || ''
  const newFilename = subPath ? path.join(subPath, newBaseName + ext).replace(/\\/g, '/') : newBaseName + ext
  const newPath = resolveCacheRelativePath(dir, newFilename)
  if (!newPath) throw new Error('Invalid target filename')

  // Check collision
  if (newFilename !== oldFilename && fs.existsSync(newPath)) {
    throw new Error('Target filename already exists on disk')
  }

  // 1. Rename physical file
  if (newFilename !== oldFilename) {
    fs.renameSync(oldPath, newPath)
    // Also rename lyrics if exists
    if (item.lyricFilename) {
      const oldLrcPath = resolveCacheRelativePath(dir, item.lyricFilename)
      const newLrcFilename = subPath
        ? path.join(subPath, newBaseName + '.lrc').replace(/\\/g, '/')
        : newBaseName + '.lrc'
      const newLrcPath = resolveCacheRelativePath(dir, newLrcFilename)
      if (oldLrcPath && newLrcPath && fs.existsSync(oldLrcPath)) {
        try {
          if (fs.existsSync(newLrcPath)) throw new Error('Target lyric already exists')
          fs.renameSync(oldLrcPath, newLrcPath)
        } catch (error) {
          fs.renameSync(newPath, oldPath)
          throw error
        }
        item.lyricFilename = newLrcFilename
      }
    }
  }

  // 2. Update Index
  // Remove old entry (keyed by old ID and quality)
  indexManager.remove(normalizedUsername, item.id, folder, item.quality, location)

  // Update item properties
  item.id = newId
  item.songmid = newId
  item.name = metadata.name
  item.singer = metadata.singer
  item.albumName = metadata.albumName
  item.albumId = metadata.albumId
  item.img = metadata.img
  item.source = metadata.source
  item.filename = newFilename
  item.mtime = Date.now()

  // Add back to index with new identity
  indexManager.update(normalizedUsername, item, folder, location)

  // 3. Post-link processing: Update ID3 tags and cover
  await batchUpdateMetadata([newFilename], normalizedUsername, location, folder)

  return {
    success: true,
    filename: newFilename,
    id: newId,
    metadata,
  }
}

export const getIndexItemByFilename = (filename: string, username: string, requestedLocation?: string) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const locations = requestedLocation ? [requestedLocation] : getCacheLocations()
  for (const location of locations) {
    for (const folder of ['cache', 'music'] as const) {
      const items = indexManager.getAll(normalizedUsername, folder, location)
      const found = items.find((i: any) => i.filename === filename)
      if (found) return { ...found, folder, location }
    }
  }
  return null
}

// [新增] 更新索引中指定文件的 hasEmbedLyric 状态（由 embedLyric 接口成功写入后调用）
export const setIndexEmbedLyric = (
  filename: string,
  username: string,
  value: boolean,
  metadata?: Pick<CacheItem, 'audioContainer' | 'metadataWritable' | 'metadataError' | 'embedLyricError'>,
  requestedLocation?: string,
) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const locations = requestedLocation ? [requestedLocation] : getCacheLocations()
  for (const location of locations) {
    for (const folder of ['cache', 'music'] as const) {
      const items = indexManager.getAll(normalizedUsername, folder, location)
      const found = items.find((i: any) => i.filename === filename)
      if (found) {
        ;(found as any).hasEmbedLyric = value
        if (metadata) Object.assign(found, metadata)
        indexManager.update(normalizedUsername, found, folder, location)
        return true
      }
    }
  }
  return false
}

export const getSubDirectories = (username: string | undefined, folder: 'cache' | 'music') => {
  const normalizedUsername = normalizeCacheUsername(username)
  const root = getCacheDir(normalizedUsername, folder === 'music')
  if (!fs.existsSync(root)) return []

  const dirs = new Set<string>()

  // 1. Get from index
  const items = indexManager.getAll(normalizedUsername, folder)
  items.forEach(item => {
    if (item.subPath) dirs.add(item.subPath)
  })

  // 2. Scan physical tree (to include empty folders)
  const scanDirs = (dirPath: string, base: string) => {
    if (!fs.existsSync(dirPath)) return
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(dirPath, entry.name)
        dirs.add(path.relative(base, fullPath).replace(/\\/g, '/'))
        scanDirs(fullPath, base)
      }
    }
  }
  scanDirs(root, root)

  return Array.from(dirs).sort()
}

/**
 * [New] Create a subdirectory
 */
export const createSubDirectory = (username: string | undefined, folder: 'cache' | 'music', subPath: string) => {
  const root = getCacheDir(username, folder === 'music')
  if (typeof subPath !== 'string' || subPath.length > 512) throw new Error('Invalid subdirectory')
  const target = resolveInside(root, subPath)
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    return true
  }
  return false
}

/**
 * [New] Categorize multiple files into a subdirectory
 */
export const categorizeFiles = async (filenames: string[], targetSubPath: string, username: string | undefined) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const folder = 'music' // Categorization is primarily for music folder
  const root = getCacheDir(normalizedUsername, true)
  if (
    !Array.isArray(filenames) ||
    filenames.length > 500 ||
    typeof targetSubPath !== 'string' ||
    targetSubPath.length > 512
  ) {
    throw new Error('Invalid categorize request')
  }
  const targetDir = resolveInside(root, targetSubPath)

  if (targetSubPath && !fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  }

  const allItems = indexManager.getAll(normalizedUsername, folder)
  let successCount = 0
  let failCount = 0

  for (const filename of filenames) {
    const item = allItems.find(i => i.filename === filename)
    if (!item) {
      console.warn(`[FileCache] Categorize: item not found for ${filename}`)
      failCount++
      continue
    }

    const oldPath = resolveInside(root, filename)
    const newFilename = targetSubPath
      ? path.join(targetSubPath, path.basename(filename)).replace(/\\/g, '/')
      : path.basename(filename)
    const newPath = resolveInside(root, newFilename)
    const oldLyricFilename = resolveCompanionLyricFilename(root, filename)
    const oldLrcPath = oldLyricFilename ? resolveInside(root, oldLyricFilename) : null
    const newLyricFilename = oldLyricFilename
      ? (targetSubPath
          ? path.join(targetSubPath, path.basename(oldLyricFilename))
          : path.basename(oldLyricFilename)
        ).replace(/\\/g, '/')
      : undefined
    const newLrcPath = newLyricFilename ? resolveInside(root, newLyricFilename) : null

    if (oldPath === newPath) {
      successCount++
      continue
    }

    // Check both destinations before moving either file. The actual move
    // also uses create-if-absent semantics to close the rename-overwrite
    // race between this check and the filesystem operation.
    if (fs.existsSync(newPath) || (newLrcPath && fs.existsSync(newLrcPath))) {
      failCount++
      continue
    }

    try {
      if (fs.existsSync(oldPath)) {
        moveFileNoOverwriteSync(oldPath, newPath)
        if (oldLrcPath && newLrcPath && fs.existsSync(oldLrcPath)) {
          try {
            moveFileNoOverwriteSync(oldLrcPath, newLrcPath)
          } catch (error) {
            // Keep the index and the source location consistent if
            // a lyric destination appeared after the preflight.
            try {
              moveFileNoOverwriteSync(newPath, oldPath)
            } catch {}
            throw error
          }
        }

        // Update index
        item.filename = newFilename
        item.subPath = targetSubPath
        item.lyricFilename = newLyricFilename
        item.hasLyric = !!newLyricFilename
        indexManager.update(normalizedUsername, item, folder)
      } else {
        failCount++
        continue
      }

      successCount++
    } catch (e: any) {
      console.error('[FileCache] Categorize failed for ' + filename + ':', e)
      failCount++
    }
  }

  return { successCount, failCount }
}
