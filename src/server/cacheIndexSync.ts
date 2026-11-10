import fs from 'fs'
import path from 'path'
import { formatPlayTime } from '../utils/common'
import { getMusicTagNative } from './musicTagNative'
import { walkCacheFilesAsync } from './cacheFileWalker'
import {
  detectAudioContainer,
  detectQualityFromBitrate,
  getMetadataUnsupportedMessage,
  hasUsableRemoteCover,
  hasValidEmbeddedCover,
  needsQualityCorrection,
  readEmbeddedCoverState,
  resolveInspectedQuality,
} from './cacheMetadata'
import { COVER_CHECK_VERSION, hasCachedCover } from './cacheCover'
import { normalizeSongIdValue } from './cacheNaming'
import { getCacheDir, normalizeCacheUsername, resolveCacheRelativePath } from './cachePaths'
import { CACHE_LIST_SYNC_TTL, cacheListSyncState } from './cacheEvents'
import { withCachePostProcess } from './cachePostProcess'
import { currentCacheLocation, getCacheLocations, indexManager } from './cacheIndex'
import type { CacheItem } from './cacheIndex'

const pendingCacheIndexSyncs = new Map<string, Promise<void>>()

const runCacheIndexSync = async (username?: string, roots: Array<'cache' | 'music'> = ['cache', 'music']) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']

  for (const location of getCacheLocations()) {
    for (const folder of roots) {
      const index = indexManager.load(normalizedUsername, folder, location)

      const existingKeysInIndex = new Set(index.keys())

      // Pre-build a filename to Item map within this folder for fast lookup
      const filenameToItemMap = new Map<string, { key: string; item: CacheItem }>()
      for (const [key, item] of index.entries()) {
        filenameToItemMap.set(item.filename, { key, item })
      }
      const dir = getCacheDir(normalizedUsername, folder === 'music', location)
      const lyricNamesByDirectory = new Map<string, Promise<Map<string, string>>>()
      const getLyricNames = (relativeDirectory: string) => {
        let pending = lyricNamesByDirectory.get(relativeDirectory)
        if (!pending) {
          const directoryPath = resolveCacheRelativePath(dir, relativeDirectory)
          pending = directoryPath
            ? fs.promises.readdir(directoryPath, { withFileTypes: true }).then(entries => {
                const names = new Map<string, string>()
                for (const entry of entries) {
                  if (
                    entry.isFile() &&
                    path.extname(entry.name).toLowerCase() === '.lrc' &&
                    !names.has(entry.name.toLowerCase())
                  ) {
                    names.set(entry.name.toLowerCase(), entry.name)
                  }
                }
                return names
              })
            : Promise.resolve(new Map<string, string>())
          lyricNamesByDirectory.set(relativeDirectory, pending)
        }
        return pending
      }
      for await (const discoveredPath of walkCacheFilesAsync(dir)) {
        const file = path.relative(dir, discoveredPath).replace(/\\/g, '/')
        if (file === 'cache_index.json' || file === 'music_index.json') continue
        const ext = path.extname(file).toLowerCase()
        if (!extensions.includes(ext)) continue

        const filePath = resolveCacheRelativePath(dir, file)
        if (!filePath) continue
        const stats = await fs.promises.lstat(filePath)
        if (stats.isSymbolicLink() || !stats.isFile()) continue

        // Try to find if this file is already known in index by its filename
        let existingEntry = filenameToItemMap.get(file)
        let existing = existingEntry?.item
        let oldKey = existingEntry?.key
        const originalItemId = existing?.id
        const originalItemQuality = existing?.quality
        let itemChanged = false

        let songId = existing?.id || ''
        let songName = existing?.name || ''
        let singer = existing?.singer || ''
        let source = existing?.source || ''
        let quality = existing?.quality || ''
        let albumName = existing?.albumName || ''
        let hasCover = existing?.hasCover || false

        const subPath = path.dirname(file) === '.' ? '' : path.dirname(file).replace(/\\/g, '/')
        const fileNameOnly = path.basename(file)
        const nameWithoutExt = path.basename(fileNameOnly, ext)

        if (!existing) {
          // Not found by filename, parse the persisted naming patterns.
          const segments = nameWithoutExt.split('_-_')
          if (segments.length >= 5) {
            songName = segments[0]
            singer = segments[1]
            source = segments[2]
            songId = segments[3]
            quality = segments[4]
          } else {
            const segmentsShort = nameWithoutExt.split(' - ')
            if (segmentsShort.length >= 2) {
              songName = segmentsShort[0]
              singer = segmentsShort[1]
              quality = segmentsShort[2] || 'unknown'
              albumName = segmentsShort.slice(3).join(' - ')
              songId = nameWithoutExt
            } else {
              songId = nameWithoutExt
              source = 'unknown'
              quality = 'unknown'
            }
          }
        }

        if (!songId) continue
        const normalizedId = normalizeSongIdValue(songId, source || 'unknown')

        // Read each audio directory once per sync. This keeps legacy extension
        // casing support without synchronously rescanning it for every song.
        const parentRelativePath = path.dirname(file) === '.' ? '' : path.dirname(file).replace(/\\/g, '/')
        const expectedLyricName = `${path.basename(file, path.extname(file))}.lrc`
        const lyricName = (await getLyricNames(parentRelativePath)).get(expectedLyricName.toLowerCase())
        const lyricRelativePath = lyricName
          ? path.posix.join(parentRelativePath || '.', lyricName).replace(/^\.\//, '')
          : null
        const lyricPath = lyricRelativePath ? resolveCacheRelativePath(dir, lyricRelativePath) : null
        const companionLyric = lyricPath && lyricRelativePath ? { filename: lyricRelativePath, path: lyricPath } : null
        const lrcFile = companionLyric?.filename
        const hasLyricOnDisk = !!companionLyric
        let lyricSize = 0
        if (companionLyric) {
          try {
            const lyricStats = await fs.promises.stat(companionLyric.path)
            if (lyricStats.isFile()) lyricSize = lyricStats.size
          } catch {}
        }

        let finalQuality = quality || 'unknown'

        const needsCoverCheck =
          !existing ||
          existing.id !== normalizedId ||
          existing.coverCheckedVersion !== COVER_CHECK_VERSION ||
          existing.coverCheckedMtime !== stats.mtimeMs ||
          existing.coverCheckedSize !== stats.size ||
          existing.hasCover === undefined ||
          (existing.coverType === 'cached' && !hasCachedCover(file, normalizedUsername, stats))
        const metadataFileChanged = !!existing && (existing.size !== stats.size || existing.mtime !== stats.mtimeMs)
        const currentAudioContainer =
          existing?.audioContainer && !metadataFileChanged ? existing.audioContainer : detectAudioContainer(filePath)
        const qualityCorrectionNeeded = !!existing && needsQualityCorrection(existing.quality, currentAudioContainer)

        if (
          !existing ||
          existing.size !== stats.size ||
          existing.hasLyric !== hasLyricOnDisk ||
          existing.lyricFilename !== lrcFile ||
          existing.lyricSize !== lyricSize ||
          existing.subPath !== subPath ||
          needsCoverCheck ||
          !existing.interval ||
          existing.quality === 'unknown' ||
          !existing.bitrate ||
          qualityCorrectionNeeded
        ) {
          itemChanged = true
          if (existing) {
            existing.id = normalizedId
            existing.size = stats.size
            existing.mtime = stats.mtimeMs
            existing.hasLyric = hasLyricOnDisk
            existing.lyricFilename = lrcFile
            existing.lyricSize = lyricSize

            if (existing.subPath !== subPath) existing.subPath = subPath

            if (needsCoverCheck) {
              const hasEmbeddedCover = readEmbeddedCoverState(filePath)
              const hasExternalCover = !hasEmbeddedCover && hasCachedCover(file, normalizedUsername, stats)
              const coverType: CacheItem['coverType'] = hasEmbeddedCover
                ? 'embedded'
                : hasExternalCover
                  ? 'cached'
                  : hasUsableRemoteCover(existing.img)
                    ? 'remote'
                    : 'none'
              existing.hasCover = coverType !== 'none'
              existing.coverType = coverType
              existing.coverCheckedVersion = COVER_CHECK_VERSION
              existing.coverCheckedMtime = stats.mtimeMs
              existing.coverCheckedSize = stats.size
            }

            const metadataNeedsInspection =
              !existing.interval ||
              existing.quality === 'unknown' ||
              !existing.bitrate ||
              existing.hasEmbedLyric === undefined ||
              existing.metadataWritable === undefined ||
              qualityCorrectionNeeded
            if (metadataNeedsInspection && (existing.metadataWritable !== false || metadataFileChanged)) {
              const metadataItem = existing
              await withCachePostProcess(undefined, 'index metadata scan', async () => {
                let tagger: any
                try {
                  tagger = new (getMusicTagNative().MusicTagger)()
                  tagger.loadPath(filePath)
                  const dur = tagger.duration
                  if (dur && !metadataItem.interval) metadataItem.interval = formatPlayTime(dur / 1000)
                  metadataItem.bitrate = tagger.bitRate
                  metadataItem.sampleRate = tagger.sampleRate
                  metadataItem.bitDepth = tagger.bitDepth
                  if (!metadataItem.quality || metadataItem.quality === 'unknown' || qualityCorrectionNeeded) {
                    const detectedQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)
                    metadataItem.quality = resolveInspectedQuality(
                      metadataItem.quality,
                      detectedQuality,
                      currentAudioContainer,
                      tagger,
                    )
                  }
                  if (metadataItem.hasEmbedLyric === undefined) {
                    const lyricsInTag = tagger.lyrics
                    metadataItem.hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                  }
                  metadataItem.audioContainer = currentAudioContainer
                  metadataItem.metadataWritable = true
                  metadataItem.metadataError = undefined
                } catch {
                  metadataItem.audioContainer = currentAudioContainer
                  metadataItem.metadataWritable = false
                  metadataItem.metadataError = getMetadataUnsupportedMessage(metadataItem.audioContainer)
                  metadataItem.hasEmbedLyric = false
                } finally {
                  try {
                    tagger?.dispose()
                  } catch {}
                }
              })
            }
            finalQuality = existing.quality
          } else {
            let interval = ''
            let bitrate: number | undefined
            let sampleRate: number | undefined
            let bitDepth: number | undefined
            let hasEmbedLyric = false
            let metadataWritable = false
            let metadataError: string | undefined
            const audioContainer = detectAudioContainer(filePath)

            await withCachePostProcess(undefined, 'index metadata scan', async () => {
              let tagger: any
              try {
                tagger = new (getMusicTagNative().MusicTagger)()
                tagger.loadPath(filePath)
                if (tagger.title && !songName) songName = tagger.title
                if (tagger.artist && !singer) singer = tagger.artist
                if (tagger.album && !albumName) albumName = tagger.album
                if (hasValidEmbeddedCover(tagger.pictures)) hasCover = true

                const dur = tagger.duration
                interval = dur ? formatPlayTime(dur / 1000) : ''
                bitrate = tagger.bitRate
                sampleRate = tagger.sampleRate
                bitDepth = tagger.bitDepth
                finalQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)
                const lyricsInTag = tagger.lyrics
                hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                metadataWritable = true
              } catch {
                metadataError = getMetadataUnsupportedMessage(audioContainer)
              } finally {
                try {
                  tagger?.dispose()
                } catch {}
              }
            })
            const hasExternalCover = !hasCover && hasCachedCover(file, normalizedUsername, stats)
            if (hasExternalCover) hasCover = true
            const coverType: CacheItem['coverType'] =
              hasCover && !hasExternalCover ? 'embedded' : hasExternalCover ? 'cached' : 'none'
            hasCover = coverType !== 'none'

            existing = {
              id: normalizedId,
              songmid: normalizedId,
              name: songName || nameWithoutExt || 'Unknown',
              singer: singer || 'Unknown',
              albumName: albumName || '',
              albumId: '',
              img: '',
              interval,
              source: source || 'unknown',
              quality: finalQuality as any,
              filename: file,
              folder: folder as any,
              subPath,
              mtime: stats.mtimeMs,
              size: stats.size,
              lyricFilename: lrcFile,
              lyricSize,
              ext: ext.replace('.', ''),
              hasCover,
              coverType,
              hasLyric: hasLyricOnDisk,
              hasEmbedLyric,
              audioContainer,
              metadataWritable,
              metadataError,
              coverCheckedVersion: COVER_CHECK_VERSION,
              coverCheckedMtime: stats.mtimeMs,
              coverCheckedSize: stats.size,
              bitrate,
              sampleRate,
              bitDepth,
            }
          }
        }

        const compositeKey = `${normalizedId}_${finalQuality || 'unknown'}`
        if (oldKey) existingKeysInIndex.delete(oldKey)

        if (oldKey && oldKey !== compositeKey) {
          index.delete(oldKey)
          index.set(compositeKey, existing!)
        } else if (!oldKey) {
          index.set(compositeKey, existing!)
        }

        // The SQLite-backed index does not persist the in-memory Map from
        // `load()`. Write each changed item explicitly so disk discovery
        // repairs lyric/cover flags in the actual database.
        if (itemChanged && existing) {
          if (oldKey && oldKey !== compositeKey && originalItemId && originalItemQuality) {
            indexManager.remove(normalizedUsername, originalItemId, folder, originalItemQuality, location)
          }
          indexManager.update(normalizedUsername, existing, folder, location)
        }

        await new Promise(resolve => setImmediate(resolve))
      }

      // Remove deleted files from index
      for (const key of existingKeysInIndex) {
        const staleItem = index.get(key)
        if (staleItem) {
          // A download can install this key after the disk walk took its
          // snapshot. Re-read the index and keep the new row when its file is
          // already present; otherwise this stale pass can erase a fresh item.
          const latestItem = indexManager.get(
            normalizedUsername,
            staleItem.id,
            folder,
            staleItem.quality,
            true,
            location,
          )
          const latestPath = latestItem ? resolveCacheRelativePath(dir, latestItem.filename) : null
          let latestFileExists = false
          if (latestPath) {
            try {
              const latestStats = await fs.promises.stat(latestPath)
              latestFileExists = latestStats.isFile() && latestStats.size > 0
            } catch {
              latestFileExists = false
            }
          }
          if (latestItem && latestFileExists) {
            index.set(key, latestItem)
            continue
          }
          indexManager.remove(normalizedUsername, staleItem.id, folder, staleItem.quality, location)
        }
        index.delete(key)
      }
    }

    const syncKey = `${location}:${normalizedUsername}`
    const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
    syncState.lastSync = Date.now()
    cacheListSyncState.set(syncKey, syncState)
  }
}

export const syncCacheIndex = async (username?: string, roots: Array<'cache' | 'music'> = ['cache', 'music']) => {
  const normalizedUsername = normalizeCacheUsername(username)
  const syncKey = `${currentCacheLocation}:${normalizedUsername}:${roots.join(',')}`
  const pending = pendingCacheIndexSyncs.get(syncKey)
  if (pending) return pending

  const sync = runCacheIndexSync(normalizedUsername, roots)
  pendingCacheIndexSyncs.set(syncKey, sync)
  try {
    await sync
  } finally {
    if (pendingCacheIndexSyncs.get(syncKey) === sync) pendingCacheIndexSyncs.delete(syncKey)
  }
}

export const scheduleCacheIndexSync = (username?: string): void => {
  const normalizedUsername = normalizeCacheUsername(username)
  const syncKey = `${currentCacheLocation}:${normalizedUsername}`
  const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
  if (syncState.pending || Date.now() - syncState.lastSync <= CACHE_LIST_SYNC_TTL) {
    cacheListSyncState.set(syncKey, syncState)
    return
  }

  syncState.pending = syncCacheIndex(normalizedUsername)
    .catch(error => {
      console.error(`[fileCache] background index sync failed for ${normalizedUsername}:`, error)
    })
    .finally(() => {
      const current = cacheListSyncState.get(syncKey)
      if (current === syncState) {
        syncState.pending = undefined
        cacheListSyncState.set(syncKey, syncState)
      }
    })
  cacheListSyncState.set(syncKey, syncState)
}
