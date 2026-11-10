import fs from 'fs'
import path from 'path'
import { resolveInsideAsync } from '@/utils/pathSecurity'
import { buildLyrics, parseLyrics } from '../utils/lrcTool'
import { invalidateCacheListSync, lyricMissCache } from './cacheEvents'
import { getCacheLocations, indexManager } from './cacheIndex'
import type { CacheItem } from './cacheIndex'
import { checkAndCleanupCache } from './cacheMaintenance'
import { getFileName, normalizeSongId } from './cacheNaming'
import { ensureCacheDir, getCacheDir, normalizeCacheUsername, resolveCacheRelativePath } from './cachePaths'
import { withCachePostProcess } from './cachePostProcess'
import { detectAudioContainer, embedLyricsIntoFile, getMetadataUnsupportedMessage } from './cacheMetadata'
import { getMusicTagNative } from './musicTagNative'

// [新增] 歌词获取钩子：由 server.ts 在启动时注入，避免 fileCache 直接依赖 musicSdk
// 调用时会通过 /api/music/lyric 接口逻辑（先查本地 .lrc 缓存，再去源站）获取歌词文本
type LyricFetcher = (songInfo: any, signal?: AbortSignal) => Promise<string | null>
let _lyricFetcher: LyricFetcher | null = null
export const setLyricFetcher = (fn: LyricFetcher) => {
  _lyricFetcher = fn
}

export const getLyricFetcher = () => _lyricFetcher

export type CompanionLyricFile = {
  filename: string
  path: string
}

/**
 * Resolve the lyric file next to an audio file. Older downloads can contain
 * an upper-case extension, so the lookup is intentionally case-insensitive.
 */
export const findCompanionLyricFile = (root: string, audioFilename: string): CompanionLyricFile | null => {
  const normalizedAudioFilename = String(audioFilename || '').replace(/\\/g, '/')
  const extension = path.extname(normalizedAudioFilename)
  if (!extension) return null

  const baseFilename = normalizedAudioFilename.slice(0, -extension.length)
  const expectedName = `${path.basename(baseFilename)}.lrc`.toLowerCase()
  const parentRelativePath = path.dirname(baseFilename).replace(/\\/g, '/')
  const parentPath = resolveCacheRelativePath(root, parentRelativePath === '.' ? '' : parentRelativePath)
  if (!parentPath || !fs.existsSync(parentPath)) return null

  try {
    const entry = fs
      .readdirSync(parentPath, { withFileTypes: true })
      .find(candidate => candidate.isFile() && candidate.name.toLowerCase() === expectedName)
    if (entry) {
      const filename = path.join(parentRelativePath === '.' ? '' : parentRelativePath, entry.name).replace(/\\/g, '/')
      const lyricPath = resolveCacheRelativePath(root, filename)
      return lyricPath ? { filename, path: lyricPath } : null
    }

    const exactFilename = `${baseFilename}.lrc`
    const exactPath = resolveCacheRelativePath(root, exactFilename)
    return exactPath && fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()
      ? { filename: exactFilename, path: exactPath }
      : null
  } catch {
    return null
  }
}

export const resolveCompanionLyricFilename = (root: string, audioFilename: string) =>
  findCompanionLyricFile(root, audioFilename)?.filename

type LyricCacheResult = { exists: true; path: string; content: any; filename: string } | { exists: false }

const LYRIC_CACHE_SCAN_MAX_ENTRIES = 100_000
const LYRIC_CACHE_SCAN_MAX_DEPTH = 32
const LYRIC_CACHE_MAX_FILE_BYTES = 2 * 1024 * 1024

const readLyricCacheFile = async (root: string, filename: string): Promise<{ path: string; content: any } | null> => {
  try {
    const filePath = await resolveInsideAsync(root, filename)
    const stats = await fs.promises.lstat(filePath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > LYRIC_CACHE_MAX_FILE_BYTES) return null

    // Recheck the resolved path immediately before opening it so a cached
    // index entry or a replaced directory cannot escape the cache root.
    await resolveInsideAsync(root, filename)
    const content = parseLyrics(await fs.promises.readFile(filePath, 'utf-8'))
    return { path: filePath, content }
  } catch {
    return null
  }
}

const findCompanionLyricFileAsync = async (root: string, audioFilename: string): Promise<CompanionLyricFile | null> => {
  const normalizedAudioFilename = String(audioFilename || '').replace(/\\/g, '/')
  const extension = path.extname(normalizedAudioFilename)
  if (!extension) return null

  const baseFilename = normalizedAudioFilename.slice(0, -extension.length)
  const expectedName = `${path.basename(baseFilename)}.lrc`.toLowerCase()
  const parentRelativePath = path.dirname(baseFilename).replace(/\\/g, '/')
  const parentFilename = parentRelativePath === '.' ? '' : parentRelativePath

  // The normal cache naming path is an exact companion lookup. Check it
  // directly first, and only enumerate the directory for case-only legacy
  // matches on case-sensitive filesystems.
  const exactFilename = `${baseFilename}.lrc`
  try {
    const lyricPath = await resolveInsideAsync(root, exactFilename)
    const stats = await fs.promises.lstat(lyricPath)
    if (stats.isFile() && !stats.isSymbolicLink()) return { filename: exactFilename, path: lyricPath }
  } catch {
    // Fall through to the case-insensitive legacy lookup.
  }

  try {
    const parentPath = await resolveInsideAsync(root, parentFilename)
    const handle = await fs.promises.opendir(parentPath)
    let scanned = 0
    for await (const entry of handle) {
      scanned++
      if (scanned > 20_000) break
      if (!entry.isFile() || entry.name.toLowerCase() !== expectedName) continue

      const filename = path.posix.join(parentFilename, entry.name)
      const lyricPath = await resolveInsideAsync(root, filename)
      const stats = await fs.promises.lstat(lyricPath)
      return stats.isFile() && !stats.isSymbolicLink() ? { filename, path: lyricPath } : null
    }
    return null
  } catch {
    return null
  }
}

const findLyricByIdOnDisk = async (
  root: string,
  targetIds: Set<string>,
  budget: { remainingEntries: number },
): Promise<{ filename: string; path: string; content: any } | null> => {
  const scanDirectory = async (
    directory: string,
    depth: number,
  ): Promise<{ filename: string; path: string; content: any } | null> => {
    if (depth > LYRIC_CACHE_SCAN_MAX_DEPTH || budget.remainingEntries <= 0) return null

    try {
      // opendir streams entries, so a single directory with many files
      // does not allocate a full listing or block the event loop.
      const handle = await fs.promises.opendir(directory)
      for await (const entry of handle) {
        budget.remainingEntries--
        if (budget.remainingEntries < 0) return null
        if (entry.isSymbolicLink()) continue

        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          const relativeDirectory = path.relative(root, fullPath).replace(/\\/g, '/')
          let safeDirectory: string
          try {
            safeDirectory = await resolveInsideAsync(root, relativeDirectory)
            const stats = await fs.promises.lstat(safeDirectory)
            if (!stats.isDirectory() || stats.isSymbolicLink()) continue
          } catch {
            continue
          }
          const nested = await scanDirectory(safeDirectory, depth + 1)
          if (nested) return nested
          if (budget.remainingEntries <= 0) return null
          continue
        }

        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.lrc') continue
        const basename = path.basename(entry.name, path.extname(entry.name))
        const segments = basename.split('_-_')
        if (segments.length < 2) continue
        const fileId = segments[segments.length - 2]
        const cleanFileId = fileId.replace(/^(tx|wy)_/, '')
        if (!targetIds.has(fileId) && !targetIds.has(cleanFileId)) continue

        const filename = path.relative(root, fullPath).replace(/\\/g, '/')
        const lyric = await readLyricCacheFile(root, filename)
        if (lyric) return { filename, path: lyric.path, content: lyric.content }
      }
    } catch {
      // A directory may disappear or become inaccessible during a scan.
    }
    return null
  }

  return scanDirectory(root, 0)
}

export const checkLyricCache = async (songInfo: any, username?: string): Promise<LyricCacheResult> => {
  const id = normalizeSongId(songInfo)
  const normalizedUsername = normalizeCacheUsername(username)
  const missKey = id ? `${normalizedUsername}\u0000${getCacheLocations().join(',')}\u0000${id}` : ''
  if (missKey && lyricMissCache.has(missKey)) return { exists: false }
  const candidateUsernames = normalizedUsername === '_open' ? ['_open'] : [normalizedUsername, '_open']
  const locations = getCacheLocations()
  const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']

  const readLyricForIndexedItem = async (
    targetUser: string,
    folder: 'cache' | 'music',
    item: CacheItem,
    location?: string,
  ): Promise<Exclude<LyricCacheResult, { exists: false }> | null> => {
    const dir = getCacheDir(targetUser, folder === 'music', location, false)
    let audioPath: string
    try {
      audioPath = await resolveInsideAsync(dir, item.filename)
      const audioStats = await fs.promises.stat(audioPath)
      if (!audioStats.isFile()) return null
    } catch {
      return null
    }

    const indexedLyric = item.lyricFilename ? await readLyricCacheFile(dir, item.lyricFilename) : null
    const companion = indexedLyric ? null : await findCompanionLyricFileAsync(dir, item.filename)
    const lyricFilename = indexedLyric ? item.lyricFilename! : companion?.filename
    if (!lyricFilename) {
      // Reading embedded tags is a native, synchronous operation. Keep it under
      // the shared post-processing limit so lyric lookups cannot stack several
      // tag parsers on the event loop alongside downloads.
      try {
        const lyricsInTag = await withCachePostProcess(undefined, 'read lyric tags', async () => {
          let tagger: any
          try {
            tagger = new (getMusicTagNative().MusicTagger)()
            tagger.loadPath(audioPath)
            return tagger.lyrics as string | undefined
          } finally {
            try {
              tagger?.dispose()
            } catch {}
          }
        })
        if (lyricsInTag && lyricsInTag.trim().length > 10) {
          const content = parseLyrics(lyricsInTag)
          if (!item.hasEmbedLyric) {
            item.hasEmbedLyric = true
            indexManager.update(targetUser, item, folder, location)
          }
          return {
            exists: true,
            path: audioPath,
            content,
            filename: item.filename,
          }
        }
      } catch {}
      return null
    }
    const lyricContents = indexedLyric || (await readLyricCacheFile(dir, lyricFilename))
    const lyricFile = lyricContents ? { filename: lyricFilename, ...lyricContents } : null
    if (!lyricFile) return null

    if (item.hasLyric !== true || item.lyricFilename !== lyricFile.filename) {
      item.hasLyric = true
      item.lyricFilename = lyricFile.filename
      indexManager.update(targetUser, item, folder, location)
      invalidateCacheListSync(targetUser)
    }
    return {
      exists: true,
      path: lyricFile.path,
      content: lyricFile.content,
      filename: lyricFile.filename,
    }
  }

  // Check every indexed quality first. A download can finish with a quality
  // different from the requested one, and an old index may still say that
  // the lyric is missing even though the companion file is already present.
  for (const targetUser of candidateUsernames) {
    for (const location of locations) {
      for (const folder of folderTypes) {
        const candidates = indexManager
          .getAll(targetUser, folder, location)
          .filter(item => item.id === id || normalizeSongId(item) === id)
          .sort((a, b) => {
            const requestedQuality = String(songInfo.quality || '')
            if (!requestedQuality) return 0
            return (a.quality === requestedQuality ? -1 : 0) - (b.quality === requestedQuality ? -1 : 0)
          })
        for (const item of candidates) {
          const lyric = await readLyricForIndexedItem(targetUser, folder, item, location)
          if (lyric) return lyric
        }
      }
    }
  }

  // [Fix] Index-based name+singer fallback for the simple naming pattern
  // When the lrc filename does not contain a song ID, match by name + singer from the index
  if (songInfo.name && songInfo.singer) {
    const targetName = String(songInfo.name).toLowerCase()
    const targetSinger = String(songInfo.singer).toLowerCase()
    for (const targetUser of candidateUsernames) {
      for (const location of locations) {
        for (const folder of folderTypes) {
          const allItems = indexManager.getAll(targetUser, folder, location)
          const matchedItems = allItems.filter(
            item => item.name.toLowerCase() === targetName && item.singer.toLowerCase() === targetSinger,
          )
          for (const matched of matchedItems) {
            const lyric = await readLyricForIndexedItem(targetUser, folder, matched, location)
            if (lyric) return lyric
          }
        }
      }
    }
  }

  // Physical scan fallback (for standard naming pattern: Name_-_Singer_-_Source_-_ID_-_Quality)
  const targetCleanId = id.replace(/^(tx|wy)_/, '')
  const targetIds = new Set([id, targetCleanId].filter(Boolean))
  const roots: Array<'cache' | 'music'> = ['cache', 'music']
  const scanBudget = { remainingEntries: LYRIC_CACHE_SCAN_MAX_ENTRIES }
  for (const targetUser of candidateUsernames) {
    for (const location of locations) {
      for (const folder of roots) {
        const dirPath = getCacheDir(targetUser, folder === 'music', location, false)
        const result = await findLyricByIdOnDisk(dirPath, targetIds, scanBudget)
        if (result) {
          return { exists: true, ...result }
        }
        if (scanBudget.remainingEntries <= 0) break
      }
      if (scanBudget.remainingEntries <= 0) break
    }
    if (scanBudget.remainingEntries <= 0) break
  }

  if (missKey) lyricMissCache.set(missKey, true)
  return { exists: false }
}

export const saveLyricCache = (songInfo: any, lyricsObj: any, username?: string, isOnlyDownload?: boolean) => {
  try {
    let baseName = ''
    let quality = songInfo.quality || 'unknown'
    let dir = ''

    const normalizedUsername = normalizeCacheUsername(username)
    const id = normalizeSongId(songInfo)
    const preferredFolders: Array<'cache' | 'music'> = isOnlyDownload ? ['music', 'cache'] : ['cache', 'music']
    let audioResult: any = { exists: false }
    for (const folder of preferredFolders) {
      const cached = indexManager.get(normalizedUsername, id, folder, songInfo.quality, false)
      if (!cached?.filename) continue
      const root = getCacheDir(normalizedUsername, folder === 'music')
      const filePath = resolveCacheRelativePath(root, cached.filename)
      if (filePath && fs.existsSync(filePath)) {
        audioResult = {
          exists: true,
          path: filePath,
          quality: cached.quality,
          folder,
          filename: cached.filename,
        }
        break
      }
    }

    if (audioResult.exists && audioResult.path) {
      // If audio exists, save lyric in the same folder
      dir = path.dirname(audioResult.path)
      quality = audioResult.quality || quality
      baseName = path.basename(audioResult.path, path.extname(audioResult.path))
    } else {
      // Audio not found with requested quality, try finding any cached audio for this song
      for (const folder of preferredFolders) {
        const cachedAny = indexManager.get(normalizedUsername, id, folder)
        if (!cachedAny?.filename) continue
        const root = getCacheDir(normalizedUsername, folder === 'music')
        const filePath = resolveCacheRelativePath(root, cachedAny.filename)
        if (filePath && fs.existsSync(filePath)) {
          audioResult = {
            exists: true,
            path: filePath,
            quality: cachedAny.quality,
            folder,
            filename: cachedAny.filename,
          }
          dir = path.dirname(filePath)
          quality = cachedAny.quality || quality
          baseName = path.basename(filePath, path.extname(filePath))
          break
        }
      }

      if (!audioResult.exists) {
        // Audio not found, fallback to target dir
        dir = ensureCacheDir(username, isOnlyDownload)
        if (songInfo.quality && songInfo.quality !== 'unknown') {
          baseName = getFileName(songInfo, songInfo.quality, isOnlyDownload, username)
        } else {
          baseName = getFileName(songInfo, 'unknown', isOnlyDownload, username)
        }
      }
    }

    const lyricFile = baseName + '.lrc'
    const finalPath = resolveCacheRelativePath(dir, lyricFile)
    if (!finalPath) throw new Error('Invalid lyric cache path')

    const formattedLrc = buildLyrics(lyricsObj)
    if (!formattedLrc) {
      console.log(`[FileCache] Empty lyrics for ${baseName}, skip saving.`)
      return false
    }

    fs.writeFileSync(finalPath, formattedLrc, { encoding: 'utf-8', mode: 0o600 })
    console.log(`[FileCache] Lyric cached saved to: ${finalPath}`)
    const lyricSize = fs.statSync(finalPath).size

    // If saving with a concrete quality, clean up any leftover 'unknown' lyric file for the same song
    if (quality && quality !== 'unknown') {
      try {
        const unknownBaseName = getFileName(songInfo, 'unknown', isOnlyDownload, username)
        const unknownLyricPath = resolveCacheRelativePath(dir, unknownBaseName + '.lrc')
        if (unknownLyricPath && unknownLyricPath !== finalPath && fs.existsSync(unknownLyricPath)) {
          fs.unlinkSync(unknownLyricPath)
          console.log(`[FileCache] Cleaned up obsolete unknown lyric: ${unknownLyricPath}`)
        }
      } catch (_) {}
    }

    // Update the exact indexed audio item when the audio file is already
    // present. Lyrics can also be cached before the audio download starts,
    // in which case audioResult.path is intentionally absent and there is
    // no index row to update. Do not pass that undefined path to
    // path.relative(): Node reports it as “The \"to\" property must be of
    // type string”, even though the lyric file was written successfully.
    if (audioResult.exists && typeof audioResult.path === 'string' && audioResult.folder) {
      try {
        // Prefer the item that owns the resolved audio path because an
        // older task may have used a different source-prefixed ID or
        // an automatically downgraded quality.
        const foldersToUpdate: Array<'cache' | 'music'> = [
          audioResult.folder,
          ...(isOnlyDownload ? ['music', 'cache'] : ['cache', 'music']),
        ].filter((folder, index, folders): folder is 'cache' | 'music' => folders.indexOf(folder) === index)
        for (const folder of foldersToUpdate) {
          const root = getCacheDir(normalizedUsername, folder === 'music')
          const relativeAudioPath = path.relative(root, audioResult.path).replace(/\\/g, '/')
          const existing = indexManager
            .getAll(normalizedUsername, folder)
            .find(
              candidate =>
                candidate.filename === relativeAudioPath || (candidate.id === id && candidate.quality === quality),
            )
          if (existing) {
            existing.lyricFilename = path.relative(root, finalPath).replace(/\\/g, '/')
            existing.lyricSize = lyricSize
            existing.hasLyric = true
            indexManager.update(normalizedUsername, existing, folder)
            invalidateCacheListSync(normalizedUsername)
            break
          }
        }
      } catch (err: any) {
        // The lyric file is already durable. An index repair failure
        // must not turn a successful lyric save into a false failure.
        console.warn(`[FileCache] Lyric cache index update failed: ${err?.message || err}`)
      }
    }
    void checkAndCleanupCache(username)
    return true
  } catch (err: any) {
    console.error(`[FileCache] Lyric cache save failed: ${err.message}`)
    return false
  }
}

export const ensureCachedLyrics = async (
  songInfo: any,
  quality: string | undefined,
  username: string | undefined,
  isOnlyDownload: boolean | undefined,
  audioPath: string,
  folder: 'cache' | 'music',
  shouldCacheLyric: boolean,
  shouldEmbedLyric: boolean,
  signal?: AbortSignal,
) => {
  if (signal?.aborted) throw new Error('Aborted')
  if ((!shouldCacheLyric && !shouldEmbedLyric) || !_lyricFetcher || !fs.existsSync(audioPath)) return

  const normalizedUsername = normalizeCacheUsername(username)
  const id = normalizeSongId(songInfo)
  const resolvedQuality = quality || 'unknown'
  const relativeAudioPath = path
    .relative(getCacheDir(normalizedUsername, folder === 'music'), audioPath)
    .replace(/\\/g, '/')
  const item =
    indexManager.get(normalizedUsername, id, folder, resolvedQuality, true) ||
    indexManager.getAll(normalizedUsername, folder).find(candidate => candidate.filename === relativeAudioPath)
  const lyricPath = audioPath.substring(0, audioPath.length - path.extname(audioPath).length) + '.lrc'
  let hasCachedLyric = fs.existsSync(lyricPath)
  let hasEmbedLyric = item?.hasEmbedLyric === true
  let metadataWritable = item?.metadataWritable !== false
  let metadataError = item?.metadataError
  let embedLyricError = item?.embedLyricError
  const audioContainer = item?.audioContainer || detectAudioContainer(audioPath)

  if (shouldEmbedLyric && !hasEmbedLyric && metadataWritable) {
    let tagger: any
    try {
      tagger = new (getMusicTagNative().MusicTagger)()
      tagger.loadPath(audioPath)
      const lyricsInTag = tagger.lyrics
      hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
    } catch (e: any) {
      metadataWritable = false
      metadataError = getMetadataUnsupportedMessage(audioContainer)
      embedLyricError = metadataError
    } finally {
      try {
        if (tagger) tagger.dispose()
      } catch (e) {}
    }
  }

  const embedRequirementHandled = !shouldEmbedLyric || hasEmbedLyric || !metadataWritable
  if ((!shouldCacheLyric || hasCachedLyric) && embedRequirementHandled) {
    if (
      item &&
      (item.hasLyric !== hasCachedLyric ||
        item.hasEmbedLyric !== hasEmbedLyric ||
        item.metadataWritable !== metadataWritable ||
        item.embedLyricError !== embedLyricError)
    ) {
      item.hasLyric = hasCachedLyric
      item.lyricFilename = hasCachedLyric
        ? path.relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath).replace(/\\/g, '/')
        : undefined
      item.lyricSize = hasCachedLyric
        ? (() => {
            try {
              return fs.statSync(lyricPath).size
            } catch {
              return 0
            }
          })()
        : 0
      item.hasEmbedLyric = hasEmbedLyric
      item.audioContainer = audioContainer
      item.metadataWritable = metadataWritable
      item.metadataError = metadataError
      item.embedLyricError = embedLyricError
      indexManager.update(normalizedUsername, item, folder)
    }
    return
  }

  try {
    const lyricText = await _lyricFetcher({ ...songInfo, quality: resolvedQuality }, signal)
    if (signal?.aborted) throw new Error('Aborted')
    if (!lyricText) return

    if (shouldCacheLyric && !hasCachedLyric) {
      const lyricsObj = parseLyrics(lyricText)
      hasCachedLyric =
        saveLyricCache({ ...songInfo, quality: resolvedQuality }, lyricsObj, username, isOnlyDownload) ||
        fs.existsSync(lyricPath)
    }

    if (shouldEmbedLyric && !hasEmbedLyric && metadataWritable) {
      const embedResult = embedLyricsIntoFile(audioPath, lyricText)
      hasEmbedLyric = embedResult.hasEmbedLyric
      metadataWritable = embedResult.metadataWritable
      metadataError = embedResult.metadataWritable ? undefined : embedResult.error
      embedLyricError = embedResult.error
      if (embedResult.success) {
        console.log(
          `[FileCache] USLT lyric embedded for: ${songInfo.name || songInfo.title || path.basename(audioPath)}`,
        )
      } else {
        console.warn(`[FileCache] Lyric tag unavailable for ${path.basename(audioPath)}: ${embedResult.error}`)
      }
    }

    const finalItem = indexManager.get(normalizedUsername, id, folder, resolvedQuality, true) || item
    if (finalItem) {
      if (shouldCacheLyric && hasCachedLyric) {
        finalItem.hasLyric = true
        finalItem.lyricFilename = path
          .relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath)
          .replace(/\\/g, '/')
        try {
          finalItem.lyricSize = fs.statSync(lyricPath).size
        } catch {
          finalItem.lyricSize = 0
        }
      }
      if (shouldEmbedLyric) {
        finalItem.hasEmbedLyric = hasEmbedLyric
        finalItem.audioContainer = audioContainer
        finalItem.metadataWritable = metadataWritable
        finalItem.metadataError = metadataError
        finalItem.embedLyricError = embedLyricError
      }
      indexManager.update(normalizedUsername, finalItem, folder)
    }
  } catch (err: any) {
    console.warn(`[FileCache] Failed to ensure lyrics for ${path.basename(audioPath)}: ${err?.message || err}`)
  }
}
