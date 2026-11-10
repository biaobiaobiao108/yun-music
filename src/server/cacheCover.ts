import fs from 'fs'
import type { Stats } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { assertSafeRemoteHttpUrl, fetchSafeRemote, type SafeRemoteHttpUrl } from './networkSecurity'
import { CACHE_ROOTS, getCacheLocations, indexManager } from './cacheIndex'
import type { CacheFolder, CacheItem } from './cacheIndex'
import { detectImageMime, hasUsableRemoteCover, hasValidPictureData } from './cacheMetadata'
import {
  assertCachePathInside,
  getCacheDir,
  getRootPath,
  normalizeCacheUsername,
  resolveCacheRelativePath,
} from './cachePaths'
import { withCachePostProcess } from './cachePostProcess'
import { getMusicTagNative } from './musicTagNative'

export const getCoverCacheBaseDirs = (): string[] => {
  const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
  return [...new Set([path.resolve(getRootPath(), 'cover_cache'), path.resolve(dataPath, 'cover_cache')])]
}

export const getCoverCacheUserDir = (baseDir: string, username: string, create: boolean): string => {
  const userDirName = normalizeCacheUsername(username)
  const fullPath = path.join(baseDir, userDirName)
  if (create && !fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true, mode: 0o700 })
  }
  assertCachePathInside(baseDir, fullPath, 'Cover cache directory escapes allowed root')
  return fullPath
}

export const getCoverCacheDir = (username: string, create = true) =>
  getCoverCacheUserDir(getCoverCacheBaseDirs()[0], username, create)

export const getCoverCacheUserDirs = (username: string, create = false): string[] =>
  getCoverCacheBaseDirs().map(baseDir => getCoverCacheUserDir(baseDir, username, create))

export const COVER_CHECK_VERSION = 5

export const getCoverCacheHash = (filename: string, stats?: Stats) => {
  const version = stats ? `${stats.size}:${stats.mtimeMs}` : ''
  return crypto.createHash('md5').update(`${filename}:${version}`).digest('hex')
}

const getCoverCachePaths = (filename: string, username: string, stats?: Stats) => {
  const hash = getCoverCacheHash(filename, stats)
  const coverCacheDir = getCoverCacheDir(username)
  return {
    binPath: path.join(coverCacheDir, `${hash}.bin`),
    mimePath: path.join(coverCacheDir, `${hash}.mime`),
  }
}

const getLegacyCoverCachePaths = (filename: string, username: string, stats?: Stats) => {
  const hash = getCoverCacheHash(filename, stats)
  const coverCacheDir = getCoverCacheUserDirs(username, false)[1] || getCoverCacheDir(username, false)
  return {
    binPath: path.join(coverCacheDir, `${hash}.bin`),
    mimePath: path.join(coverCacheDir, `${hash}.mime`),
  }
}

export const readCoverCache = (filename: string, username: string, stats?: Stats) => {
  const candidates = [
    getCoverCachePaths(filename, username, stats),
    getLegacyCoverCachePaths(filename, username, stats),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate.binPath) || !fs.existsSync(candidate.mimePath)) continue
      const data = fs.readFileSync(candidate.binPath)
      const detectedMime = detectImageMime(data)
      if (!detectedMime) continue
      const storedMime = fs.readFileSync(candidate.mimePath, 'utf8').trim()
      const persistent = getCoverCachePaths(filename, username, stats)
      if (candidate.binPath !== persistent.binPath) {
        fs.copyFileSync(candidate.binPath, persistent.binPath)
        try {
          fs.chmodSync(persistent.binPath, 0o600)
        } catch {}
        fs.writeFileSync(persistent.mimePath, detectedMime || storedMime || 'image/jpeg', { mode: 0o600 })
      }
      return { data, mime: detectedMime || storedMime || 'image/jpeg' }
    } catch {}
  }
  return null
}

export const hasCachedCover = (filename: string, username: string, stats?: Stats) =>
  !!readCoverCache(filename, username, stats)

export const writeCoverCache = (
  filename: string,
  username: string,
  data: Buffer | Uint8Array,
  mime: string,
  stats?: Stats,
) => {
  const detectedMime = detectImageMime(data)
  if (!detectedMime) return false
  const { binPath, mimePath } = getCoverCachePaths(filename, username, stats)
  fs.writeFileSync(binPath, data, { mode: 0o600 })
  fs.writeFileSync(mimePath, detectedMime || mime || 'image/jpeg', { mode: 0o600 })
  return true
}

export const removeCoverCacheFiles = (filename: string, username: string, knownHash = ''): void => {
  const hashes = [...new Set([knownHash, crypto.createHash('md5').update(filename).digest('hex')].filter(Boolean))]
  for (const coverCacheDir of getCoverCacheUserDirs(username, false)) {
    for (const hash of hashes) {
      for (const suffix of ['.bin', '.mime']) {
        try {
          fs.unlinkSync(path.join(coverCacheDir, `${hash}${suffix}`))
        } catch (error: any) {
          if (error?.code !== 'ENOENT') {
            // Cover cleanup is best-effort; stale thumbnails must not block
            // deletion of the audio file and its SQLite index.
          }
        }
      }
    }
  }
}

export const downloadCoverImage = async (
  imageUrl: string,
  signal?: AbortSignal,
  redirects = 0,
): Promise<{ data: Buffer; mime: string } | null> => {
  if (signal?.aborted) return null
  if (!hasUsableRemoteCover(imageUrl) || redirects > 3) return null
  let safeUrl: SafeRemoteHttpUrl
  try {
    safeUrl = await assertSafeRemoteHttpUrl(imageUrl)
  } catch {
    return null
  }

  try {
    const resp = await fetchSafeRemote(safeUrl, {
      signal,
      method: 'GET',
      timeoutMs: 10000,
      maxBytes: 10 * 1024 * 1024,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: safeUrl.origin,
      },
    })

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location')
      if (location) {
        const nextUrl = new URL(location, safeUrl).toString()
        return await downloadCoverImage(nextUrl, signal, redirects + 1)
      }
      return null
    }

    if (!resp.ok) return null

    const data = Buffer.from(await resp.arrayBuffer())
    const mime = detectImageMime(data)
    return mime ? { data, mime } : null
  } catch {
    return null
  }
}

const setIndexCoverState = (
  filename: string,
  username: string,
  coverType: CacheItem['coverType'],
  stats?: Stats,
  location?: string,
  requestedFolder?: CacheFolder,
) => {
  const folders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['cache', 'music']
  for (const folder of folders) {
    const item = indexManager.getAll(username, folder, location).find(candidate => candidate.filename === filename)
    if (!item) continue
    item.coverType = coverType
    item.hasCover = coverType !== 'none'
    item.coverCheckedVersion = COVER_CHECK_VERSION
    if (stats) {
      item.coverCheckedMtime = stats.mtimeMs
      item.coverCheckedSize = stats.size
    }
    indexManager.update(username, item, folder, location)
    return item
  }
  return null
}

/**
 * Get cover image for a cached file
 */
export const getCacheCover = async (
  filename: string,
  username?: string,
  requestedFolder?: CacheFolder,
  requestedLocation?: string,
) => {
  if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') return null
  if (requestedLocation && requestedLocation !== CACHE_ROOTS.DATA && requestedLocation !== CACHE_ROOTS.ROOT) return null
  const normalizedUsername = normalizeCacheUsername(username)

  const locations = requestedLocation ? [requestedLocation] : getCacheLocations()
  const roots: Array<CacheFolder> = requestedFolder ? [requestedFolder] : ['cache', 'music']

  for (const loc of locations) {
    for (const folder of roots) {
      const dir = getCacheDir(normalizedUsername, folder === 'music', loc, false)
      const filePath = resolveCacheRelativePath(dir, filename) // [Fix] Allow subfolders safely

      if (filePath && fs.existsSync(filePath)) {
        let stats: Stats | undefined
        try {
          stats = fs.statSync(filePath)
          const cachedCover = readCoverCache(filename, normalizedUsername, stats)
          if (cachedCover) {
            setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc, folder)
            return cachedCover
          }
        } catch (e) {
          console.error(`[Cache] Error reading cover cache for: ${filename}`, e)
        }

        try {
          const picData = await withCachePostProcess(undefined, 'read cover tags', async () => {
            let tagger: any
            try {
              tagger = new (getMusicTagNative().MusicTagger)()
              tagger.loadPath(filePath)
              const pics = tagger.pictures
              const pic = Array.isArray(pics) ? pics.find(hasValidPictureData) : null
              if (pic) {
                return {
                  mime: pic.mimeType || 'image/jpeg',
                  data: Buffer.from(pic.data),
                }
              }
              return null
            } finally {
              try {
                if (tagger) tagger.dispose()
              } catch {}
            }
          })
          if (picData) {
            const mime = picData.mime
            const data = picData.data
            writeCoverCache(filename, normalizedUsername, data, mime, stats)
            setIndexCoverState(filename, normalizedUsername, 'embedded', stats, loc, folder)
            return { data, mime: detectImageMime(data) || mime }
          }
        } catch (e) {
          // console.error(`[Cache] Error reading tags for cover: ${filename}`, e)
        }

        const item = roots
          .flatMap(folderName => indexManager.getAll(normalizedUsername, folderName, loc))
          .find(candidate => candidate.filename === filename)
        if (item && hasUsableRemoteCover(item.img)) {
          const remoteCover = await downloadCoverImage(item.img!)
          if (remoteCover && writeCoverCache(filename, normalizedUsername, remoteCover.data, remoteCover.mime, stats)) {
            setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc, folder)
            return remoteCover
          }
        }

        setIndexCoverState(filename, normalizedUsername, 'none', stats, loc, folder)
      }
    }
  }
  return null
}

/**
 * Remove a specific cache file
 */
