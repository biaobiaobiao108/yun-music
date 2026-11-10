import fs from 'fs'
import type { Stats } from 'fs'
import path from 'path'
import { invalidateCacheListSync } from './cacheEvents'
import { removeCacheFile } from './cacheEntry'
import { moveFileNoOverwriteSync } from './cacheFileMove'
import { CACHE_ROOTS, currentCacheLocation, getCacheLocations, indexManager } from './cacheIndex'
import type { CacheFolder, CacheItem } from './cacheIndex'
import { checkCache } from './cacheLookup'
import { normalizeSongId } from './cacheNaming'
import { getCacheDir, normalizeCacheUsername, pathExists, resolveCacheRelativePath } from './cachePaths'
import { isCacheEntryProcessing } from './cacheProgress'
import { invalidateGlobalCacheStats } from './cacheStats'

export const switchFolder = async (
  filenames: string[],
  username: string | undefined,
  requestedTargetFolder?: CacheFolder,
  requestedLocation?: string,
) => {
  if (requestedLocation && requestedLocation !== CACHE_ROOTS.DATA && requestedLocation !== CACHE_ROOTS.ROOT)
    throw new Error('Invalid cache location')
  const normalizedUsername = normalizeCacheUsername(username)
  let successCount = 0
  let failCount = 0
  let cacheChanged = false
  const moved: Array<{ filename: string; from: CacheFolder; to: CacheFolder }> = []

  const locations = requestedLocation ? [requestedLocation] : getCacheLocations()
  const itemsByFolder = new Map<string, Map<string, CacheItem>>()
  for (const location of locations) {
    for (const folder of ['cache', 'music'] as const) {
      const byFilename = new Map<string, CacheItem>()
      for (const item of indexManager.getAll(normalizedUsername, folder, location)) {
        byFilename.set(item.filename, item)
      }
      itemsByFolder.set(`${location}:${folder}`, byFilename)
    }
  }

  for (const filename of filenames) {
    let sourceFolder: 'cache' | 'music' | null = null
    let item: CacheItem | null = null
    let sourceLocation = currentCacheLocation
    // An explicit destination makes this operation idempotent from the
    // player's perspective: downloads always move cache -> music instead
    // of accidentally toggling an already-downloaded file back to cache.
    const sourceCandidates: CacheFolder[] = requestedTargetFolder
      ? [requestedTargetFolder === 'music' ? 'cache' : 'music']
      : ['cache', 'music']
    for (const candidate of sourceCandidates) {
      for (const location of locations) {
        const found = itemsByFolder.get(`${location}:${candidate}`)?.get(filename)
        if (found) {
          sourceFolder = candidate
          sourceLocation = location
          item = found
          break
        }
      }
      if (sourceFolder) break
    }

    if (!sourceFolder || !item) {
      failCount++
      continue
    }

    if (isCacheEntryProcessing(item.id, item.quality, normalizedUsername)) {
      failCount++
      continue
    }

    const targetFolder: CacheFolder = requestedTargetFolder || (sourceFolder === 'cache' ? 'music' : 'cache')
    const targetItem = itemsByFolder.get(`${sourceLocation}:${targetFolder}`)?.get(filename)
    if (targetItem && isCacheEntryProcessing(targetItem.id, targetItem.quality, normalizedUsername)) {
      failCount++
      continue
    }

    // [Constraint] Cannot move from music subfolder to cache
    if (sourceFolder === 'music' && item.subPath && item.subPath !== '') {
      console.log(`[FileCache] Move blocked: ${filename} is in a subfolder and cannot move to cache.`)
      failCount++
      continue
    }

    const sourceDir = getCacheDir(normalizedUsername, sourceFolder === 'music', sourceLocation)
    const targetDir = getCacheDir(normalizedUsername, targetFolder === 'music', sourceLocation)

    const sourcePath = resolveCacheRelativePath(sourceDir, filename)
    const targetPath = resolveCacheRelativePath(targetDir, filename)
    if (!sourcePath || !targetPath) {
      failCount++
      continue
    }

    try {
      const srcExists = fs.existsSync(sourcePath)

      if (srcExists) {
        // Ensure target directory exists (including any nested subfolders)
        const targetPathDir = path.dirname(targetPath)
        if (!fs.existsSync(targetPathDir)) fs.mkdirSync(targetPathDir, { recursive: true, mode: 0o700 })

        // Check collision in target folder
        if (fs.existsSync(targetPath)) {
          const targetItem = itemsByFolder.get(`${sourceLocation}:${targetFolder}`)?.get(filename)
          const sameIndexedSong =
            targetItem &&
            targetItem.quality === item.quality &&
            (targetItem.id === item.id || normalizeSongId(targetItem) === normalizeSongId(item))
          if (sameIndexedSong) {
            // Older versions copied cache -> music. Once the
            // target is verified as the same song/quality, keep
            // the durable download and remove only the duplicate
            // private cache entry.
            const removedDuplicate = removeCacheFile(filename, normalizedUsername, sourceFolder, sourceLocation, item)
            if (removedDuplicate.deleted) {
              itemsByFolder.get(`${sourceLocation}:${sourceFolder}`)?.delete(filename)
              successCount++
              moved.push({ filename, from: sourceFolder, to: targetFolder })
              continue
            }
          }
          console.log(`[FileCache] Move conflict: ${filename} already exists in ${targetFolder}, skipping.`)
          failCount++
          continue
        }

        let sourceLrcPath: string | null = null
        let targetLrcPath: string | null = null
        let shouldMoveLyric = false
        if (item.lyricFilename) {
          sourceLrcPath = resolveCacheRelativePath(sourceDir, item.lyricFilename)
          targetLrcPath = resolveCacheRelativePath(targetDir, item.lyricFilename)
          if (!sourceLrcPath || !targetLrcPath) {
            failCount++
            continue
          }

          let sourceLyricStats: Stats | null = null
          try {
            sourceLyricStats = fs.lstatSync(sourceLrcPath)
          } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error
          }
          if (sourceLyricStats && (sourceLyricStats.isSymbolicLink() || !sourceLyricStats.isFile())) {
            failCount++
            continue
          }

          shouldMoveLyric = !!sourceLyricStats
          if (shouldMoveLyric && pathExists(targetLrcPath)) {
            // Preserve both files and leave the audio in place when
            // the destination already has a companion lyric.
            failCount++
            continue
          }
          if (shouldMoveLyric) {
            const targetLyricDir = path.dirname(targetLrcPath)
            if (!fs.existsSync(targetLyricDir)) fs.mkdirSync(targetLyricDir, { recursive: true, mode: 0o700 })
          }
        }

        // Move audio file
        try {
          moveFileNoOverwriteSync(sourcePath, targetPath)
          cacheChanged = true
        } catch (moveErr) {
          const errMsg = moveErr instanceof Error ? moveErr.stack : String(moveErr)
          console.error(`[FileCache][ERROR] move audio failed for ${filename}:`, errMsg)
          failCount++
          continue
        }

        // Move the companion lyric without replacing an existing file.
        // If it fails, put the audio back before leaving the source
        // index untouched. A failed rollback is handled as a partial
        // move below so the index still describes the audio on disk.
        if (shouldMoveLyric && sourceLrcPath && targetLrcPath) {
          try {
            moveFileNoOverwriteSync(sourceLrcPath, targetLrcPath)
          } catch (lrErr) {
            const errMsg = lrErr instanceof Error ? lrErr.stack : String(lrErr)
            console.error(`[FileCache][ERROR] move lyric failed for ${filename}:`, errMsg)

            try {
              moveFileNoOverwriteSync(targetPath, sourcePath)
            } catch (rollbackErr) {
              const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.stack : String(rollbackErr)
              console.error(`[FileCache][ERROR] audio rollback failed for ${filename}:`, rollbackMsg)
            }

            const sourceAudioExists = fs.existsSync(sourcePath)
            const targetAudioExists = fs.existsSync(targetPath)
            if (!sourceAudioExists && targetAudioExists) {
              indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLocation)
              item.folder = targetFolder
              item.hasLyric = false
              item.lyricFilename = undefined
              item.lyricSize = 0
              indexManager.update(normalizedUsername, item, targetFolder, sourceLocation)
            } else if (!sourceAudioExists && !targetAudioExists) {
              indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLocation)
            }
            failCount++
            continue
          }
        } else if (item.lyricFilename && targetLrcPath && !pathExists(targetLrcPath)) {
          // The source sidecar was already missing; do not keep a
          // stale lyric reference in the destination index.
          item.hasLyric = false
          item.lyricFilename = undefined
          item.lyricSize = 0
        }

        // Update Index
        indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLocation)
        itemsByFolder.get(`${sourceLocation}:${sourceFolder}`)?.delete(filename)
        item.folder = targetFolder
        indexManager.update(normalizedUsername, item, targetFolder, sourceLocation)
        itemsByFolder.get(`${sourceLocation}:${targetFolder}`)?.set(filename, item)
        cacheChanged = true
        successCount++
        moved.push({ filename, from: sourceFolder, to: targetFolder })
      } else {
        failCount++
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.stack : String(e)
      console.error(`[FileCache] Failed to move ${filename}:`, errMsg)
      failCount++
    }
  }

  if (cacheChanged || successCount > 0) {
    invalidateCacheListSync(normalizedUsername)
    invalidateGlobalCacheStats()
  }
  return { successCount, failCount, moved }
}

/**
 * Promote a shared public cache file into a user's download directory.
 * Public cache files are shared by all users, so this intentionally copies
 * them instead of removing the shared copy. Private cache -> music moves
 * continue to use switchFolder and remain a zero-copy rename.
 */
export const promoteCacheFile = async (
  filename: string,
  sourceUsername: string | undefined,
  targetUsername: string | undefined,
  sourceFolder: CacheFolder = 'cache',
  requestedLocation?: string,
) => {
  const normalizedSource = normalizeCacheUsername(sourceUsername)
  const normalizedTarget = normalizeCacheUsername(targetUsername)
  if (normalizedSource === normalizedTarget)
    return switchFolder([filename], normalizedTarget, 'music', requestedLocation)

  if (requestedLocation && requestedLocation !== CACHE_ROOTS.DATA && requestedLocation !== CACHE_ROOTS.ROOT)
    return { successCount: 0, failCount: 1, moved: [] }
  for (const location of requestedLocation ? [requestedLocation] : getCacheLocations()) {
    const item = indexManager
      .getAll(normalizedSource, sourceFolder, location)
      .find(entry => entry.filename === filename)
    if (!item) continue
    if (isCacheEntryProcessing(item.id, item.quality, normalizedSource))
      return { successCount: 0, failCount: 1, moved: [] }

    const sourceDir = getCacheDir(normalizedSource, sourceFolder === 'music', location)
    const targetDir = getCacheDir(normalizedTarget, true, location)
    const sourcePath = resolveCacheRelativePath(sourceDir, filename)
    const targetPath = resolveCacheRelativePath(targetDir, filename)
    if (!sourcePath || !targetPath || !fs.existsSync(sourcePath)) continue
    const activeTarget = indexManager
      .getAll(normalizedTarget, 'music', location)
      .find(entry => entry.filename === filename)
    if (activeTarget && isCacheEntryProcessing(activeTarget.id, activeTarget.quality, normalizedTarget))
      return { successCount: 0, failCount: 1, moved: [] }

    if (fs.existsSync(targetPath)) {
      const targetItem = indexManager
        .getAll(normalizedTarget, 'music', location)
        .find(entry => entry.filename === filename)
      if (targetItem)
        return { successCount: 1, failCount: 0, moved: [{ filename, from: sourceFolder, to: 'music' as CacheFolder }] }
      return { successCount: 0, failCount: 1, moved: [] }
    }

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 })
      fs.copyFileSync(sourcePath, targetPath)

      if (item.lyricFilename) {
        const sourceLrcPath = resolveCacheRelativePath(sourceDir, item.lyricFilename)
        const targetLrcPath = resolveCacheRelativePath(targetDir, item.lyricFilename)
        if (sourceLrcPath && targetLrcPath && fs.existsSync(sourceLrcPath)) {
          fs.mkdirSync(path.dirname(targetLrcPath), { recursive: true, mode: 0o700 })
          fs.copyFileSync(sourceLrcPath, targetLrcPath)
        }
      }

      indexManager.update(normalizedTarget, { ...item, folder: 'music' }, 'music', location)
      invalidateCacheListSync(normalizedSource)
      invalidateCacheListSync(normalizedTarget)
      invalidateGlobalCacheStats()
      return { successCount: 1, failCount: 0, moved: [{ filename, from: sourceFolder, to: 'music' as CacheFolder }] }
    } catch (error) {
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
      } catch {}
      console.error(`[FileCache] Failed to promote public cache file ${filename}:`, error)
      return { successCount: 0, failCount: 1, moved: [] }
    }
  }

  return { successCount: 0, failCount: 1, moved: [] }
}

/**
 * Promote the best matching cache entry for a song into the user's download
 * folder. Private entries are moved; the shared _open cache is copied so one
 * user's download cannot remove a file that another user may still play.
 */
export const promoteCachedSongToMusic = async (
  songInfo: any,
  quality: string | undefined,
  username: string | undefined,
) => {
  const result = checkCache({ ...songInfo, quality, exactQuality: true }, username, false, {
    ignoreActiveProgress: true,
    preferredFolder: 'music',
  })
  if (!result.exists || result.isCollision || !result.filename) return { successCount: 0, failCount: 1, moved: [] }
  const normalizedTarget = normalizeCacheUsername(username)
  if (result.folder === 'music' && result.foundIn === normalizedTarget)
    return { successCount: 1, failCount: 0, moved: [] }
  const sourceUsername = result.foundIn || normalizedTarget
  if (sourceUsername === normalizedTarget) {
    return switchFolder([result.filename], normalizedTarget, 'music')
  }
  return promoteCacheFile(
    result.filename,
    sourceUsername,
    normalizedTarget,
    result.folder === 'music' ? 'music' : 'cache',
  )
}

/** Remove a stale private cache copy after a durable music file is confirmed. */
export const removeDuplicateCacheForSong = (
  songInfo: any,
  quality: string | undefined,
  username: string | undefined,
) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const musicResult = checkCache({ ...songInfo, quality, exactQuality: true }, username, false, {
    ignoreActiveProgress: true,
    preferredFolder: 'music',
  })
  if (!musicResult.exists || musicResult.isCollision || musicResult.folder !== 'music') return false

  const cacheResult = checkCache({ ...songInfo, quality, exactQuality: true }, username, false, {
    ignoreActiveProgress: true,
    preferredFolder: 'cache',
  })
  if (!cacheResult.exists || cacheResult.isCollision || cacheResult.folder !== 'cache' || !cacheResult.filename)
    return false
  if (cacheResult.foundIn !== normalizedUsername) return false
  return removeCacheFile(cacheResult.filename, normalizedUsername, 'cache', cacheResult.location).deleted
}

export const switchBaseLocation = async (filenames: string[], username: string | undefined) => {
  const normalizedUsername = normalizeCacheUsername(username)
  let successCount = 0
  let failCount = 0
  const sourceLoc = currentCacheLocation
  const targetLoc = sourceLoc === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA

  const folders: Array<'cache' | 'music'> = ['cache', 'music']

  // Helper to get dir for a specific location
  const getLocalDir = (folder: string, loc: string) => {
    return getCacheDir(normalizedUsername, folder === 'music', loc)
  }

  for (const filename of filenames) {
    let sourceFolder: 'cache' | 'music' | null = null
    let item: CacheItem | null = null

    // Find folder in SOURCE location
    for (const folder of folders) {
      const items = indexManager.getAll(normalizedUsername, folder, sourceLoc)
      const found = items.find(i => i.filename === filename)
      if (found) {
        sourceFolder = folder
        item = found
        break
      }
    }

    if (!sourceFolder || !item) {
      failCount++
      continue
    }

    const sourceDir = getLocalDir(sourceFolder, sourceLoc)
    const targetItem = indexManager
      .getAll(normalizedUsername, sourceFolder, targetLoc)
      .find(entry => entry.filename === filename)
    if (
      isCacheEntryProcessing(item.id, item.quality, normalizedUsername) ||
      (targetItem && isCacheEntryProcessing(targetItem.id, targetItem.quality, normalizedUsername))
    ) {
      failCount++
      continue
    }
    const targetDir = getLocalDir(sourceFolder, targetLoc)

    const sourcePath = resolveCacheRelativePath(sourceDir, filename)
    const targetPath = resolveCacheRelativePath(targetDir, filename)
    if (!sourcePath || !targetPath) {
      failCount++
      continue
    }

    let sourceLrcPath: string | null = null
    let targetLrcPath: string | null = null
    let shouldMoveLyric = false
    if (item.lyricFilename) {
      sourceLrcPath = resolveCacheRelativePath(sourceDir, item.lyricFilename)
      targetLrcPath = resolveCacheRelativePath(targetDir, item.lyricFilename)
      if (!sourceLrcPath || !targetLrcPath) {
        failCount++
        continue
      }
      shouldMoveLyric = fs.existsSync(sourceLrcPath)
      if (shouldMoveLyric && fs.existsSync(targetLrcPath)) {
        // Keep both lyric files intact and leave the audio/index at source.
        failCount++
        continue
      }
    }

    let movedAudio = false
    let movedLyric = false
    try {
      if (fs.existsSync(sourcePath)) {
        const targetPathDir = path.dirname(targetPath)
        if (!fs.existsSync(targetPathDir)) fs.mkdirSync(targetPathDir, { recursive: true, mode: 0o700 })

        // Check collision in target location
        if (fs.existsSync(targetPath)) {
          console.log(`[FileCache] Base move conflict: ${filename} already exists at ${targetLoc}, skipping.`)
          failCount++
          continue
        }

        // Move audio file
        moveFileNoOverwriteSync(sourcePath, targetPath)
        movedAudio = true

        // Move lyrics
        if (shouldMoveLyric && sourceLrcPath && targetLrcPath) {
          const targetLrcDir = path.dirname(targetLrcPath)
          if (!fs.existsSync(targetLrcDir)) fs.mkdirSync(targetLrcDir, { recursive: true, mode: 0o700 })
          moveFileNoOverwriteSync(sourceLrcPath, targetLrcPath)
          movedLyric = true
        }

        // Update Indices
        indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLoc)
        // item is now in the other location's index
        indexManager.update(normalizedUsername, item, sourceFolder, targetLoc)

        successCount++
      } else {
        failCount++
      }
    } catch (e) {
      console.error(`[FileCache] Failed to move ${filename} from ${sourceLoc} to ${targetLoc}:`, e)
      if (movedLyric && sourceLrcPath && targetLrcPath) {
        try {
          moveFileNoOverwriteSync(targetLrcPath, sourceLrcPath)
        } catch (rollbackError) {
          console.error(`[FileCache] Failed to roll back lyric ${filename}:`, rollbackError)
        }
      }
      if (movedAudio) {
        try {
          moveFileNoOverwriteSync(targetPath, sourcePath)
        } catch (rollbackError) {
          console.error(`[FileCache] Failed to roll back audio ${filename}:`, rollbackError)
        }
      }

      // Keep the index aligned with whichever copy actually remains after a
      // failed move or rollback. In particular, do not leave it pointing at
      // the source after the audio was stranded at the destination.
      const sourceAudioExists = fs.existsSync(sourcePath)
      const targetAudioExists = fs.existsSync(targetPath)
      if (movedAudio) {
        try {
          if (sourceAudioExists) {
            indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, targetLoc)
            const sourceRecord = { ...item }
            sourceRecord.hasLyric = !!(sourceLrcPath && fs.existsSync(sourceLrcPath))
            if (!sourceRecord.hasLyric) {
              sourceRecord.lyricFilename = undefined
              sourceRecord.lyricSize = 0
            }
            indexManager.update(normalizedUsername, sourceRecord, sourceFolder, sourceLoc)
          } else if (targetAudioExists) {
            const targetRecord = { ...item }
            targetRecord.hasLyric = !!(targetLrcPath && fs.existsSync(targetLrcPath))
            if (!targetRecord.hasLyric) {
              targetRecord.lyricFilename = undefined
              targetRecord.lyricSize = 0
            }
            indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLoc)
            indexManager.update(normalizedUsername, targetRecord, sourceFolder, targetLoc)
          } else {
            indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLoc)
            indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, targetLoc)
          }
        } catch (indexError) {
          console.error(`[FileCache] Failed to reconcile index for ${filename}:`, indexError)
        }
      }
      failCount++
    }
  }

  if (successCount > 0) invalidateGlobalCacheStats()
  return { successCount, failCount, targetLoc }
}

/**
 * [New] Get all subdirectories in the music/cache folders
 */
