import crypto from 'crypto'
import fs from 'fs'
import type { Stats } from 'fs'
import http from 'http'
import https from 'https'
import path from 'path'
import { COVER_CHECK_VERSION, downloadCoverImage, hasCachedCover, writeCoverCache } from './cacheCover'
import { invalidateCacheListSync } from './cacheEvents'
import { linkFileWithoutOverwrite } from './cacheFileMove'
import { indexManager } from './cacheIndex'
import type { CacheItem, DownloadProvenance } from './cacheIndex'
import { checkCache } from './cacheLookup'
import { ensureCachedLyrics, findCompanionLyricFile } from './cacheLyrics'
import { checkAndCleanupCache } from './cacheMaintenance'
import { extractSongMetadata, getFileName, normalizeSongId } from './cacheNaming'
import {
  detectDownloadSource,
  getMetadataUnsupportedMessage,
  hasUsableRemoteCover,
  inspectAudioFile,
  isPlaceholderCoverUrl,
  readEmbeddedCoverState,
} from './cacheMetadata'
import { ensureCacheDir, getCacheDir, normalizeCacheUsername } from './cachePaths'
import { beginCachePostProcess, withCachePostProcess } from './cachePostProcess'
import { bindCacheProgress, cacheProgress, setCacheProgress } from './cacheProgress'
import { promoteCachedSongToMusic, removeDuplicateCacheForSong } from './cacheTransfer'
import { assertSafeRemoteHttpUrl, createSafeRemoteProxyAgent, type SafeRemoteHttpUrl } from './networkSecurity'
import { getMusicTagNative } from './musicTagNative'
import { invalidateGlobalCacheStats } from './cacheStats'

const reconcileCacheItemFromDisk = (
  username: string,
  folder: 'cache' | 'music',
  item: CacheItem,
  filePath: string,
  stats?: Stats,
  location?: string,
) => {
  if (!fs.existsSync(filePath)) return false

  let actualStats: Stats
  try {
    actualStats = stats || fs.statSync(filePath)
    if (!actualStats.isFile()) return false
  } catch {
    return false
  }

  const root = getCacheDir(username, folder === 'music', location)
  const lyricFile = findCompanionLyricFile(root, item.filename)
  const hasLyric = !!lyricFile
  let lyricSize = 0
  if (lyricFile) {
    try {
      const lyricStats = fs.statSync(lyricFile.path)
      if (lyricStats.isFile()) lyricSize = lyricStats.size
    } catch {}
  }
  const coverStateCurrent =
    item.coverCheckedVersion === COVER_CHECK_VERSION &&
    item.coverCheckedMtime === actualStats.mtimeMs &&
    item.coverCheckedSize === actualStats.size &&
    item.coverType !== undefined
  const hasEmbeddedCover = coverStateCurrent ? item.coverType === 'embedded' : readEmbeddedCoverState(filePath)
  const hasExternalCover = !hasEmbeddedCover && hasCachedCover(item.filename, username, actualStats)
  const coverType: CacheItem['coverType'] = hasEmbeddedCover
    ? 'embedded'
    : hasExternalCover
      ? 'cached'
      : hasUsableRemoteCover(item.img)
        ? 'remote'
        : 'none'
  const hasCover = coverType !== 'none'
  const nextLyricFilename = lyricFile?.filename

  const changed =
    item.hasLyric !== hasLyric ||
    item.lyricFilename !== nextLyricFilename ||
    item.lyricSize !== lyricSize ||
    item.hasCover !== hasCover ||
    item.coverType !== coverType ||
    item.size !== actualStats.size ||
    item.mtime !== actualStats.mtimeMs ||
    item.coverCheckedVersion !== COVER_CHECK_VERSION ||
    item.coverCheckedMtime !== actualStats.mtimeMs ||
    item.coverCheckedSize !== actualStats.size

  if (!changed) return false

  item.hasLyric = hasLyric
  item.lyricFilename = nextLyricFilename
  item.lyricSize = lyricSize
  item.hasCover = hasCover
  item.coverType = coverType
  item.size = actualStats.size
  item.mtime = actualStats.mtimeMs
  item.coverCheckedVersion = COVER_CHECK_VERSION
  item.coverCheckedMtime = actualStats.mtimeMs
  item.coverCheckedSize = actualStats.size
  indexManager.update(username, item, folder, location)
  invalidateCacheListSync(username)
  return true
}

// Ensure directory exists
export const downloadAndCache = async (
  songInfo: any,
  url: string,
  quality?: string,
  username?: string,
  signal?: AbortSignal,
  isOnlyDownload?: boolean,
  shouldCacheLyric: boolean = true,
  shouldEmbedLyric: boolean = true,
  provenance: DownloadProvenance = {},
) => {
  const dir = ensureCacheDir(username, isOnlyDownload)
  const baseName = getFileName(songInfo, quality, isOnlyDownload, username)
  // Use a unique staging path so a crash cannot leave a stale .tmp file that
  // blocks a later retry for the same song.
  const tempPath = path.join(
    dir,
    `${baseName}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  )
  const songKey = normalizeSongId(songInfo) + '_' + (quality || 'unknown')
  const progressKey = provenance.progressKey || songKey
  const requestedSource = provenance.requestedSource || songInfo.requestedSource || songInfo.source || 'unknown'
  const downloadSource = detectDownloadSource(
    url,
    provenance.downloadSource || songInfo.downloadSource || songInfo.source,
  )
  const sourceName = provenance.sourceName || songInfo.sourceName

  // This worker is already serialized by the user-scoped download queue;
  // do not let another user's process-global progress hide a valid target.
  const result = checkCache({ ...songInfo, quality, exactQuality: true }, username, false, {
    ignoreActiveProgress: true,
    preferredFolder: isOnlyDownload ? 'music' : undefined,
  })
  if (result.exists && !result.isCollision) {
    const targetFolder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
    if (
      result.folder === targetFolder &&
      result.path &&
      (!isOnlyDownload || result.foundIn === normalizeCacheUsername(username))
    ) {
      const existingPath = result.path
      const requestedOwner = normalizeCacheUsername(username)
      const owner = result.foundIn || requestedOwner
      if (owner === requestedOwner) {
        await withCachePostProcess(signal, 'existing cache', async () => {
          const physicalItem = indexManager
            .getAll(owner, targetFolder, result.location)
            .find(item => item.filename === result.filename)
          const unbind = bindCacheProgress(
            owner,
            physicalItem?.id || normalizeSongId(songInfo),
            quality || result.quality,
            progressKey,
          )
          setCacheProgress(progressKey, { progress: 100, status: 'tagging' })
          try {
            await ensureCachedLyrics(
              songInfo,
              quality || result.quality,
              owner,
              isOnlyDownload,
              existingPath,
              targetFolder,
              shouldCacheLyric,
              shouldEmbedLyric,
              signal,
            )
            if (signal?.aborted) throw new Error('Aborted')
            const existing = indexManager
              .getAll(owner, targetFolder, result.location)
              .find(item => item.filename === result.filename)
            if (existing)
              reconcileCacheItemFromDisk(owner, targetFolder, existing, existingPath, undefined, result.location)
          } finally {
            unbind()
          }
        })
      } else {
        // A private request matched a public (_open) file. Do not embed lyrics
        // into a shared file or write its index under the requester's account.
        console.log(
          `[FileCache] Song already exists in ${targetFolder} owned by ${owner}; skipping post-processing for ${requestedOwner}`,
        )
      }
      if (isOnlyDownload) removeDuplicateCacheForSong(songInfo, quality || result.quality, username)
      console.log(`[FileCache] Song already exists in ${targetFolder}, skipping download: ${result.filename}`)
      // 通知前端轮询：目标目录文件已存在，视为立即完成
      setCacheProgress(progressKey, { progress: 100, status: 'exists' })
      return Promise.resolve()
    }

    if (isOnlyDownload && result.path) {
      if (signal?.aborted) throw new Error('Aborted')
      const promoted = await promoteCachedSongToMusic(songInfo, quality || result.quality, username)
      if (promoted.successCount < 1) throw new Error('缓存文件尚未准备好，请稍后再试')

      const musicResult = checkCache(
        { ...songInfo, quality: quality || result.quality, exactQuality: true },
        username,
        false,
        { ignoreActiveProgress: true, preferredFolder: 'music' },
      )
      const musicPath = musicResult.exists && !musicResult.isCollision ? musicResult.path : undefined
      if (musicPath) {
        await withCachePostProcess(signal, 'promote cache', async () => {
          const unbind = bindCacheProgress(
            username,
            normalizeSongId(songInfo),
            quality || musicResult.quality || result.quality,
            progressKey,
          )
          setCacheProgress(progressKey, { progress: 100, status: 'tagging' })
          try {
            await ensureCachedLyrics(
              songInfo,
              quality || musicResult.quality || result.quality,
              username,
              true,
              musicPath,
              'music',
              shouldCacheLyric,
              shouldEmbedLyric,
              signal,
            )
            if (signal?.aborted) throw new Error('Aborted')
            const normalizedUsername = normalizeCacheUsername(username)
            const existing = indexManager
              .getAll(normalizedUsername, 'music')
              .find(item => item.filename === musicResult.filename)
            if (existing)
              reconcileCacheItemFromDisk(
                normalizedUsername,
                'music',
                existing,
                musicPath,
                undefined,
                musicResult.location,
              )
          } finally {
            unbind()
          }
        })
      }
      if (isOnlyDownload) removeDuplicateCacheForSong(songInfo, quality || musicResult.quality, username)
      const stat = musicPath ? fs.statSync(musicPath) : undefined
      console.log(`[FileCache] Promoted cached song to music folder: ${musicResult.filename || result.filename}`)
      setCacheProgress(progressKey, {
        progress: 100,
        status: 'finished',
        total: stat?.size || 0,
        received: stat?.size || 0,
      })
      return Promise.resolve()
    }

    console.log(`[FileCache] Song already exists in ${result.folder}, skipping download: ${result.filename}`)
    setCacheProgress(progressKey, { progress: 100, status: 'exists' })
    return Promise.resolve()
  }

  if (signal?.aborted) return
  // An existing local file needs no remote connection. Validate the URL only
  // when a cache miss will actually start a network download.
  const safeUrl = await assertSafeRemoteHttpUrl(url)
  if (signal?.aborted) throw new Error('Aborted')
  url = safeUrl.toString()
  console.log(`[FileCache] Starting download for: ${baseName}`)

  return new Promise<void>((resolve, reject) => {
    let req: http.ClientRequest
    let activeResponse: http.IncomingMessage | null = null
    let fileStream: fs.WriteStream | null = null
    let settled = false
    let postProcessing = false
    const unbindProgress = bindCacheProgress(username, normalizeSongId(songInfo), quality, progressKey)
    let unbindActualProgress: (() => void) | undefined

    const fail = (err: Error) => {
      if (settled) return
      const message = err.message || 'Download failed'
      setCacheProgress(progressKey, { progress: 0, status: 'error', errorMsg: message })
      settle(() => reject(err))
    }

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      unbindProgress()
      unbindActualProgress?.()
      if (signal) signal.removeEventListener('abort', abortHandler)
      activeResponse = null
      fileStream = null
      fn()
    }

    const abortHandler = () => {
      if (postProcessing) return
      if (req) req.destroy()
      activeResponse?.destroy()
      fileStream?.destroy()
      if (fs.existsSync(tempPath)) fs.unlink(tempPath, () => {})
      cacheProgress.delete(progressKey)
      // Native enrichment may still own the final path. Keep the worker
      // alive until its finally block releases it before account cleanup.
      settle(() => reject(new Error('Aborted')))
    }

    if (signal) signal.addEventListener('abort', abortHandler)

    const requestWithRedirect = (currentUrl: SafeRemoteHttpUrl, depth = 0) => {
      if (settled || signal?.aborted) return
      if (depth > 5) {
        fail(new Error('Too many redirects'))
        return
      }
      const getAudioReferer = (targetUrl: URL): string => {
        const host = targetUrl.hostname.toLowerCase()
        if (host.includes('qq.com') || host.includes('tencent.com')) return 'https://y.qq.com/'
        if (host.includes('163.com') || host.includes('126.net')) return 'https://music.163.com/'
        if (host.includes('kugou.com')) return 'https://www.kugou.com/'
        if (host.includes('kuwo.cn')) return 'https://www.kuwo.cn/'
        if (host.includes('migu.cn')) return 'https://music.migu.cn/'
        return targetUrl.origin
      }
      const currentProtocol = currentUrl.protocol === 'https:' ? https : http
      const proxyAgent = createSafeRemoteProxyAgent(currentUrl)
      const options: https.RequestOptions = {
        ...(proxyAgent ? { agent: proxyAgent } : { lookup: currentUrl.lookup, agent: false }),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: getAudioReferer(currentUrl),
        },
      }
      req = currentProtocol.get(currentUrl, options, async res => {
        activeResponse = res
        if (proxyAgent) res.once('close', () => proxyAgent.destroy())
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume()
          try {
            let nextUrlStr = res.headers.location
            if (!nextUrlStr.startsWith('http')) {
              nextUrlStr = new URL(nextUrlStr, currentUrl).href
            }
            const safeNextUrl = await assertSafeRemoteHttpUrl(nextUrlStr)
            requestWithRedirect(safeNextUrl, depth + 1)
          } catch (e: any) {
            fail(e)
          }
          return
        }

        const statusCode = res.statusCode || 0
        const contentRange = String(res.headers['content-range'] || '')
        const fullContentRange = /^bytes\s+0-(\d+)\/(\d+)$/i.exec(contentRange)
        const contentLength = Number.parseInt(String(res.headers['content-length'] || '0'), 10) || 0
        const isCompletePartialResponse =
          statusCode === 206 &&
          !!fullContentRange &&
          Number(fullContentRange[1]) + 1 === Number(fullContentRange[2]) &&
          (!contentLength || contentLength === Number(fullContentRange[2]))
        if (statusCode !== 200 && !isCompletePartialResponse) {
          res.resume()
          fs.unlink(tempPath, () => {})
          fail(new Error(`Status: ${statusCode}`))
          return
        }

        setCacheProgress(progressKey, {
          progress: 0,
          status: 'downloading',
          total: 0,
          received: 0,
          speed: 0,
          updatedAt: Date.now(),
        })
        const total = isCompletePartialResponse ? Number(fullContentRange![2]) : contentLength
        const maxAudioBytes = 500 * 1024 * 1024
        if (total > maxAudioBytes) {
          res.resume()
          fail(new Error('Audio file is too large'))
          return
        }
        let received = 0
        let lastSpeedAt = Date.now()
        let lastSpeedBytes = 0
        let currentSpeed = 0
        const contentType = res.headers['content-type'] || ''
        let headerExt = '.mp3'
        if (contentType.includes('audio/flac')) headerExt = '.flac'
        else if (contentType.includes('audio/ogg')) headerExt = '.ogg'
        else if (contentType.includes('audio/x-m4a') || contentType.includes('audio/mp4')) headerExt = '.m4a'
        else if (contentType.includes('audio/wav')) headerExt = '.wav'

        const currentFileStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
        fileStream = currentFileStream
        let writeFinished = false
        res.on('data', chunk => {
          if (settled) return
          received += chunk.length
          if (received > maxAudioBytes) {
            res.destroy(new Error('Audio file is too large'))
            return
          }
          const now = Date.now()
          if (now - lastSpeedAt >= 1000) {
            currentSpeed = Math.max(0, (received - lastSpeedBytes) / ((now - lastSpeedAt) / 1000))
            lastSpeedAt = now
            lastSpeedBytes = received
          }
          const progress = total > 0 ? Math.round((received / total) * 100) : 0
          setCacheProgress(progressKey, {
            progress,
            status: 'downloading',
            total,
            received,
            speed: currentSpeed,
            updatedAt: now,
          })
        })
        const failRemoteResponse = (error: Error) => {
          if (settled) return
          try {
            currentFileStream.destroy()
          } catch {}
          fs.unlink(tempPath, () => {})
          fail(error)
        }
        res.on('aborted', () => failRemoteResponse(new Error('Download response aborted')))
        res.on('error', error => failRemoteResponse(error instanceof Error ? error : new Error(String(error))))

        res.pipe(currentFileStream)
        currentFileStream.on('finish', () => {
          writeFinished = true
        })
        currentFileStream.on('close', async () => {
          if (settled) return
          if (!writeFinished) {
            fs.unlink(tempPath, () => {})
            fail(new Error('Download stream closed before write finished'))
            return
          }
          if (total > 0 && received < total) {
            fs.unlink(tempPath, () => {})
            fail(new Error(`Download incomplete: ${received}/${total}`))
            return
          }
          let releasePostProcess: (() => void) | null = null
          postProcessing = true
          try {
            releasePostProcess = await beginCachePostProcess(signal, `download ${baseName}`)
            if (signal?.aborted) {
              releasePostProcess()
              fs.unlink(tempPath, () => {})
              fail(new Error('Aborted'))
              return
            }
            setCacheProgress(progressKey, {
              progress: 100,
              status: 'tagging',
              total,
              received,
              speed: 0,
              updatedAt: Date.now(),
            })

            let ext = headerExt
            const inspection = inspectAudioFile(tempPath, quality)
            ext = inspection.extension || ext
            const actualQuality = inspection.quality || quality || 'unknown'
            if (actualQuality !== quality)
              unbindActualProgress = bindCacheProgress(username, normalizeSongId(songInfo), actualQuality, progressKey)
            const finalBaseName = getFileName(songInfo, actualQuality, isOnlyDownload, username)
            const finalPath = path.join(dir, finalBaseName + ext)
            linkFileWithoutOverwrite(tempPath, finalPath, async err => {
              if (err) {
                releasePostProcess?.()
                fs.unlink(tempPath, () => {})
                fail(err)
                return
              }

              // The audio file has been promoted to its final path. Metadata,
              // cover and lyric enrichment are best-effort and must not turn a
              // successfully downloaded audio file into a failed task.
              let imageBuffer: Buffer | undefined
              let imageMime = 'image/jpeg'
              try {
                try {
                  const imageUrl = songInfo.img || (songInfo.meta && songInfo.meta.picUrl)
                  if (imageUrl && imageUrl.startsWith('http') && !isPlaceholderCoverUrl(imageUrl)) {
                    const coverResult = await downloadCoverImage(imageUrl, signal)
                    if (coverResult) {
                      imageBuffer = coverResult.data
                      imageMime = coverResult.mime
                    }
                  }
                } catch (e) {}

                if (signal?.aborted) throw new Error('Aborted')

                const metadata = extractSongMetadata(songInfo)
                const id = metadata.id || String(songInfo.id || songInfo.songmid)
                const normalizedUsername = normalizeCacheUsername(username)
                const folderType: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'

                indexManager.update(
                  normalizedUsername,
                  {
                    id,
                    songmid: id,
                    name: metadata.name,
                    singer: metadata.singer,
                    albumName: metadata.albumName,
                    albumId: metadata.albumId,
                    img: metadata.img,
                    interval: metadata.interval,
                    source: metadata.source,
                    requestedSource,
                    downloadSource,
                    sourceName,
                    quality: actualQuality,
                    filename: finalBaseName + ext,
                    folder: folderType,
                    mtime: Date.now(),
                    size: received,
                    ext: ext.replace('.', ''),
                    hasCover: false,
                    hasLyric: false,
                    audioContainer: inspection.audioContainer,
                    bitrate: inspection.bitrate,
                    sampleRate: inspection.sampleRate,
                    bitDepth: inspection.bitDepth,
                  },
                  folderType,
                )
                invalidateCacheListSync(normalizedUsername)

                let tagger: any
                let metadataWritable = false
                try {
                  tagger = new (getMusicTagNative().MusicTagger)()
                  tagger.loadPath(finalPath)
                  tagger.title = metadata.name
                  tagger.artist = metadata.singer
                  tagger.album = metadata.albumName
                  if (imageBuffer && imageBuffer.length > 0)
                    tagger.pictures = [new (getMusicTagNative().MetaPicture)(imageMime, imageBuffer, 'Cover')]
                  tagger.save()
                  metadataWritable = true
                } catch (e) {
                } finally {
                  try {
                    if (tagger) tagger.dispose()
                  } catch (e) {}
                }

                const taggedStats = fs.statSync(finalPath)
                const finalHasEmbeddedCover = readEmbeddedCoverState(finalPath)
                let finalHasCover = finalHasEmbeddedCover
                if (!finalHasCover && imageBuffer?.length) {
                  finalHasCover = writeCoverCache(
                    finalBaseName + ext,
                    normalizedUsername,
                    imageBuffer,
                    imageMime,
                    taggedStats,
                  )
                }
                imageBuffer = undefined
                const taggedItem = indexManager.get(normalizedUsername, id, folderType, actualQuality)
                if (taggedItem) {
                  taggedItem.coverType = finalHasEmbeddedCover
                    ? 'embedded'
                    : finalHasCover
                      ? 'cached'
                      : hasUsableRemoteCover(metadata.img)
                        ? 'remote'
                        : 'none'
                  taggedItem.hasCover = taggedItem.coverType !== 'none'
                  taggedItem.audioContainer = inspection.audioContainer
                  taggedItem.metadataWritable = metadataWritable
                  taggedItem.metadataError = metadataWritable
                    ? undefined
                    : getMetadataUnsupportedMessage(taggedItem.audioContainer)
                  taggedItem.coverCheckedVersion = COVER_CHECK_VERSION
                  taggedItem.coverCheckedMtime = taggedStats.mtimeMs
                  taggedItem.coverCheckedSize = taggedStats.size
                  taggedItem.mtime = taggedStats.mtimeMs
                  taggedItem.size = taggedStats.size
                  indexManager.update(normalizedUsername, taggedItem, folderType)
                }

                if (signal?.aborted) throw new Error('Aborted')
                await ensureCachedLyrics(
                  songInfo,
                  actualQuality,
                  username,
                  isOnlyDownload,
                  finalPath,
                  folderType,
                  shouldCacheLyric,
                  shouldEmbedLyric,
                  signal,
                )
                const finalizedItem = indexManager
                  .getAll(normalizedUsername, folderType)
                  .find(item => item.filename === finalBaseName + ext)
                if (finalizedItem) reconcileCacheItemFromDisk(normalizedUsername, folderType, finalizedItem, finalPath)
                invalidateCacheListSync(normalizedUsername)
              } catch (postProcessError: any) {
                if (!signal?.aborted) {
                  console.warn(
                    `[FileCache] Optional post-processing failed for ${path.basename(finalPath)}: ${postProcessError?.message || postProcessError}`,
                  )
                }
              } finally {
                imageBuffer = undefined
                releasePostProcess?.()
                if (signal?.aborted) {
                  fail(new Error('Aborted'))
                  return
                }
                if (!fs.existsSync(finalPath)) {
                  fail(new Error('Downloaded file is missing after processing'))
                  return
                }

                setCacheProgress(progressKey, {
                  progress: 100,
                  status: 'finished',
                  total: total || received,
                  received,
                  speed: 0,
                  updatedAt: Date.now(),
                })
                invalidateGlobalCacheStats()
                settle(() => {
                  resolve()
                  void checkAndCleanupCache(username)
                })
              }
            })
          } catch (error: any) {
            releasePostProcess?.()
            if (fs.existsSync(tempPath)) fs.unlink(tempPath, () => {})
            fail(error instanceof Error ? error : new Error(String(error)))
          }
        })
        currentFileStream.on('error', err => {
          fs.unlink(tempPath, () => {})
          fail(err)
        })
      })
      req.on('error', err => {
        if (proxyAgent) proxyAgent.destroy()
        fs.unlink(tempPath, () => {})
        fail(err)
      })
      req.setTimeout(30000, () => {
        req.destroy(new Error('Download request timeout'))
      })
    }
    requestWithRedirect(safeUrl)
  })
}

// [新增] 根据文件名从索引中查找对应条目（跨 cache/music 两个目录）
