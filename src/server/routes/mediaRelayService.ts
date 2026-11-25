import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { type HttpContext } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as fileCache from '../fileCache'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { assertSafeRemoteHttpUrl, createSafeRemoteProxyAgent } from '../networkSecurity'
import { verifyDownloadToken } from '../downloadToken'
import { getMusicTagNative } from '../musicTagNative'
import { createProxyResponseStream, createTempFileResponseStream } from './upstreamRelayStream'
import {
  INFERRED_AUDIO_TYPES,
  cacheRelayRedirect,
  consumeDownloadProxyBytes,
  getCachedRelayRedirect,
  getUpstreamAgent,
  isExpectedDownloadAbort,
  isOpaqueBrowserProgressId,
  removeRelayRedirect,
  tryAcquireDownloadProxySlot,
} from './mediaRelaySupport'

export const handleDownloadProxy = (ctx: HttpContext): Response | Promise<Response> => {
  const urlStr = ctx.query.get('url')
  const filename = (ctx.query.get('filename') || 'download.mp3').slice(0, 255)
  const isInline = ctx.query.get('inline') === '1'
  const isTaggingMode = ctx.query.get('tag') === '1'

  if (!urlStr) return ctx.fail(400, '缺少必要参数：url')
  if (urlStr.length > 4096) return ctx.fail(413, '远程地址过长')

  // This endpoint fetches any URL it is given, so it must not be reachable as
  // an anonymous proxy. A signed token is issued with every /api/music/url
  // result; authenticated callers (admin or a logged-in user) already can
  // download through the cache routes.
  const isAuthenticated = Boolean(verifyAdminAuth(ctx.request) || verifyUserAuth(ctx))
  if (!isAuthenticated && !verifyDownloadToken(urlStr, ctx.query.get('token'))) {
    return ctx.fail(403, '下载链接已失效，请重新开始播放')
  }

  const releaseProxySlot = tryAcquireDownloadProxySlot(ctx.remoteAddress || 'unknown', isTaggingMode)
  if (!releaseProxySlot) return ctx.fail(429, '下载请求过于频繁或当前连接额度已用尽，请稍后重试')
  const proxyClientIp = ctx.remoteAddress || 'unknown'
  const consumeProxyBytes = (byteCount: number) => consumeDownloadProxyBytes(proxyClientIp, byteCount)

  return new Promise<Response>(resolve => {
    let responseSettled = false
    let abortListener: (() => void) | null = null
    let activeProxyRequest: http.ClientRequest | null = null
    let activeProxyResponse: http.IncomingMessage | null = null
    let activeTempStream: fs.WriteStream | null = null
    let activeTempPath: string | null = null
    const cleanupActiveTempFile = () => {
      const tempPath = activeTempPath
      if (!tempPath) return
      activeTempPath = null
      const unlink = () => fs.unlink(tempPath, () => {})
      if (activeTempStream && !activeTempStream.closed) {
        activeTempStream.once('close', unlink)
        activeTempStream.destroy()
      } else {
        unlink()
      }
    }
    const settleResponse = (response: Response, releaseSlot = true, preserveTempFile = false) => {
      if (responseSettled) return
      responseSettled = true
      if (!preserveTempFile) cleanupActiveTempFile()
      if (abortListener) {
        ctx.request.signal.removeEventListener('abort', abortListener)
        abortListener = null
      }
      if (releaseSlot) releaseProxySlot()
      resolve(response)
    }

    const finishExpectedAbort = () => {
      // 499 is intentionally used for an HTTP client-closed request. Bun's
      // server will not send it after the socket is gone, but resolving the
      // route prevents an orphaned async proxy chain from lingering.
      try {
        activeProxyRequest?.destroy()
      } catch {}
      try {
        activeProxyResponse?.destroy()
      } catch {}
      cleanupActiveTempFile()
      settleResponse(new Response(null, { status: 499 }))
    }

    abortListener = finishExpectedAbort
    ctx.request.signal.addEventListener('abort', abortListener, { once: true })
    if (ctx.request.signal.aborted) finishExpectedAbort()

    try {
      const rawTaskId = ctx.query.get('taskId')?.trim() || ''
      const taskId = isOpaqueBrowserProgressId(rawTaskId) ? rawTaskId : null
      const rangeHeader = ctx.headers.get('range')
      const isFullRange = rangeHeader === 'bytes=0-'

      const doFetch = async (targetUrl: string, attempt: number) => {
        if (ctx.request.signal.aborted) {
          finishExpectedAbort()
          return
        }

        if (attempt > 5) {
          settleResponse(ctx.fail(502, '远程地址跳转次数过多，无法下载'))
          return
        }

        try {
          const parsedUrl = await assertSafeRemoteHttpUrl(targetUrl)
          const proxyAgent = createSafeRemoteProxyAgent(parsedUrl)
          const options: any = {
            method: 'GET',
            ...(proxyAgent
              ? { agent: proxyAgent }
              : { lookup: parsedUrl.lookup, agent: getUpstreamAgent(parsedUrl.protocol) }),
            signal: ctx.request.signal,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Referer: parsedUrl.origin,
            },
          }

          if (rangeHeader) options.headers['Range'] = rangeHeader

          const lib = parsedUrl.protocol === 'https:' ? https : http

          const proxyReq = lib.request(targetUrl, options, (proxyRes: any) => {
            activeProxyResponse = proxyRes
            // A paused inline stream applies backpressure and can leave the
            // upstream socket idle for minutes. The request-level timeout is
            // a socket idle timer that survives the response, so clear it now
            // and keep it only for non-streaming downloads/tagging.
            if (isInline && !isTaggingMode) proxyReq.setTimeout?.(0)
            if (proxyAgent) proxyRes.once('close', () => proxyAgent.destroy())
            if (!isInline || isTaggingMode) {
              proxyRes.setTimeout?.(30_000, () => proxyRes.destroy(new Error('Remote response timed out')))
            }
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
              const location = proxyRes.headers.location
              if (location) {
                // Only the redirect headers are needed. Draining an unbounded
                // body would keep an unmetered socket alive after this hop.
                proxyRes.destroy()
                try {
                  const nextUrl = new URL(location, parsedUrl).href
                  cacheRelayRedirect(urlStr, nextUrl)
                  void doFetch(nextUrl, attempt + 1)
                } catch {
                  removeRelayRedirect(urlStr)
                  settleResponse(ctx.fail(502, '远程地址跳转目标不合法'))
                }
                return
              }
            }

            if (
              isTaggingMode &&
              (!rangeHeader || isFullRange) &&
              proxyRes.statusCode !== 200 &&
              proxyRes.statusCode !== 206
            ) {
              proxyRes.destroy()
              if (taskId) {
                fileCache.setCacheProgress(taskId, {
                  progress: 0,
                  status: 'error',
                  errorMsg: '远程服务器返回下载错误',
                  updatedAt: Date.now(),
                })
              }
              settleResponse(ctx.fail(502, '远程服务器返回下载错误，请重试'))
              return
            }

            const maxAudioBytes = 500 * 1024 * 1024
            const declaredLength = Number(proxyRes.headers['content-length'] || 0)
            if (declaredLength > maxAudioBytes) {
              proxyRes.destroy()
              settleResponse(ctx.fail(413, '远程文件过大，已超过允许的下载上限'))
              return
            }
            const remoteType = String(proxyRes.headers['content-type'] || '')
              .split(';')[0]
              .trim()
              .toLowerCase()
            const normalizedRemoteType =
              remoteType === 'audio/x-flac'
                ? 'audio/flac'
                : remoteType === 'audio/x-m4a'
                  ? 'audio/mp4'
                  : remoteType === 'audio/x-wav'
                    ? 'audio/wav'
                    : remoteType === 'audio/x-aac'
                      ? 'audio/aac'
                      : remoteType
            let safeInlineType =
              /^(audio|video)\/[a-z0-9.+-]+$/.test(normalizedRemoteType) ||
              /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(normalizedRemoteType)
            let contentType = safeInlineType ? normalizedRemoteType : 'application/octet-stream'

            if (
              isInline &&
              !safeInlineType &&
              (!remoteType || remoteType === 'application/octet-stream' || remoteType === 'binary/octet-stream')
            ) {
              const requestedFilename = ctx.query.get('filename')
              if (requestedFilename) {
                const ext = path.extname(requestedFilename).toLowerCase()
                if (INFERRED_AUDIO_TYPES[ext]) {
                  contentType = INFERRED_AUDIO_TYPES[ext]
                  safeInlineType = true
                }
              }
            }

            if (targetUrl !== urlStr && (proxyRes.statusCode === 200 || proxyRes.statusCode === 206)) {
              cacheRelayRedirect(urlStr, targetUrl)
            }

            const headers: Record<string, string> = {
              'Content-Type': contentType,
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "sandbox; default-src 'none'",
            }

            if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length']
            if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges']
            if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range']

            if (isInline && safeInlineType) {
              headers['X-Accel-Buffering'] = 'no'
              if (!headers['Accept-Ranges']) headers['Accept-Ranges'] = 'bytes'
            }

            if (!isInline || !safeInlineType) {
              headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(filename)}"`
            }

            if (isTaggingMode && (!rangeHeader || isFullRange)) {
              const songName = ctx.query.get('name') || ''
              const artist = ctx.query.get('singer') || ''
              const album = ctx.query.get('album') || ''
              const imageUrl = ctx.query.get('pic') || ''
              const embedLyric = ctx.query.get('lyric') === '1'
              const lyricSource = ctx.query.get('source') || ''
              const lyricSongmid = ctx.query.get('songmid') || ''
              const lyricHash = ctx.query.get('hash') || ''
              const lyricInterval = ctx.query.get('interval') || ''

              let received = 0
              const total = parseInt((proxyRes.headers['content-length'] as string) || '0', 10)
              let lastSpeedAt = Date.now()
              let lastSpeedBytes = 0
              let currentSpeed = 0
              const requestedExt = path.extname(filename).toLowerCase()
              const ext = ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.aac', '.opus'].includes(requestedExt)
                ? requestedExt
                : '.mp3'
              const tempPath = path.join(
                os.tmpdir(),
                `lx_tag_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`,
              )
              const tempStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
              activeTempStream = tempStream
              activeTempPath = tempPath
              let tempStreamError: Error | null = null
              let taggedResponseSettled = false
              const settleTaggedResponse = (response: Response, releaseSlot = true, preserveTempFile = false) => {
                if (taggedResponseSettled) return
                taggedResponseSettled = true
                settleResponse(response, releaseSlot, preserveTempFile)
              }
              const markProgressError = (message: string) => {
                if (!taskId) return
                fileCache.setCacheProgress(taskId, {
                  progress: 0,
                  status: 'error',
                  errorMsg: message,
                  updatedAt: Date.now(),
                })
              }
              const failTaggedStream = (message: string, status = 502) => {
                if (responseSettled || taggedResponseSettled) return
                markProgressError(message)
                try {
                  tempStream.destroy()
                } catch {}
                try {
                  proxyRes.destroy()
                } catch {}
                settleTaggedResponse(
                  ctx.fail(status, status === 429 ? '下载中继流量额度已用尽，请稍后重试' : '下载数据流中断，请重试'),
                )
              }
              tempStream.on('error', error => {
                tempStreamError = error
                failTaggedStream(error.message || 'Download stream failed')
              })

              if (taskId) {
                fileCache.setCacheProgress(taskId, {
                  progress: 0,
                  status: 'downloading',
                  total,
                  received: 0,
                  speed: 0,
                  updatedAt: Date.now(),
                })
              }

              proxyRes.on('data', (c: any) => {
                if (responseSettled) return
                received += c.length
                if (received > maxAudioBytes) {
                  proxyRes.destroy(new Error('Remote file is too large'))
                  tempStream.destroy()
                  markProgressError('Remote file is too large')
                  settleTaggedResponse(ctx.fail(413, '远程文件过大，已超过允许的下载上限'))
                  return
                }
                if (!consumeProxyBytes(c.length)) {
                  failTaggedStream('Download relay bandwidth budget exceeded', 429)
                  return
                }
                if (taskId) {
                  const now = Date.now()
                  if (now - lastSpeedAt >= 1000) {
                    currentSpeed = Math.max(0, (received - lastSpeedBytes) / ((now - lastSpeedAt) / 1000))
                    lastSpeedAt = now
                    lastSpeedBytes = received
                  }
                  const progress = total > 0 ? Math.round((received / total) * 100) : 0
                  fileCache.setCacheProgress(taskId, {
                    progress,
                    status: 'downloading',
                    total,
                    received,
                    speed: currentSpeed,
                    updatedAt: now,
                  })
                }
              })
              proxyRes.pipe(tempStream)
              proxyRes.on('aborted', () => failTaggedStream('Remote response aborted'))
              proxyRes.on('error', (error: Error) => {
                failTaggedStream(error.message || 'Download stream failed')
              })

              proxyRes.on('end', async () => {
                if (responseSettled || taggedResponseSettled) return
                if (taskId) {
                  fileCache.setCacheProgress(taskId, {
                    progress: 100,
                    status: 'tagging',
                    total,
                    received,
                    speed: 0,
                    updatedAt: Date.now(),
                  })
                }
                const finishProgress = () => {
                  if (!taskId) return
                  fileCache.setCacheProgress(taskId, {
                    progress: 100,
                    status: 'finished',
                    total: total || received,
                    received,
                    speed: 0,
                    updatedAt: Date.now(),
                  })
                }

                const createTempFileResponse = () => {
                  const stream = createTempFileResponseStream(tempPath, () => {
                    releaseProxySlot()
                    cleanupActiveTempFile()
                  })
                  return new Response(stream, { status: 200, headers })
                }
                try {
                  await new Promise<void>((resolveWrite, rejectWrite) => {
                    if (tempStreamError) {
                      rejectWrite(tempStreamError)
                      return
                    }
                    tempStream.once('finish', () => resolveWrite())
                    tempStream.once('error', rejectWrite)
                  })
                  if (fs.statSync(tempPath).size < 100) throw new Error('File too small, possibly invalid')

                  await fileCache.withCachePostProcess(ctx.request.signal, 'download proxy', async () => {
                    let cover: Awaited<ReturnType<typeof fileCache.downloadCoverImage>> = null
                    let lyricText = ''
                    if (imageUrl) {
                      try {
                        cover = await fileCache.downloadCoverImage(imageUrl, ctx.request.signal)
                      } catch (e: any) {
                        console.warn('[DownloadProxy] Picture fetch/embed failed:', e.message)
                      }
                    }
                    ctx.request.signal.throwIfAborted()
                    const lyricApi = lyricSource ? getBuiltinSource(lyricSource) : undefined
                    if (embedLyric && lyricSongmid && lyricApi?.getLyric) {
                      const lyricReqObj = lyricApi.getLyric({
                        songmid: lyricSongmid,
                        name: songName,
                        singer: artist,
                        hash: lyricHash,
                        interval: lyricInterval,
                      })
                      const abortLyric = () => lyricReqObj.cancelHttp?.()
                      ctx.request.signal.addEventListener('abort', abortLyric, { once: true })
                      try {
                        if (ctx.request.signal.aborted) abortLyric()
                        const lyricResult = await lyricReqObj.promise
                        lyricText = lyricResult?.lyric || lyricResult?.lrc || ''
                      } catch {
                      } finally {
                        ctx.request.signal.removeEventListener('abort', abortLyric)
                      }
                    }
                    ctx.request.signal.throwIfAborted()

                    // Keep native allocations inside the shared limit and create
                    // the tagger only after remote enrichment has completed.
                    let tagger: any = null
                    try {
                      tagger = new (getMusicTagNative().MusicTagger)()
                      tagger.loadPath(tempPath)
                      if (songName) tagger.title = songName
                      if (artist) tagger.artist = artist
                      if (album) tagger.album = album
                      if (cover)
                        tagger.pictures = [new (getMusicTagNative().MetaPicture)(cover.mime, cover.data, 'Cover')]
                      if (lyricText) tagger.lyrics = lyricText
                      tagger.save()
                    } finally {
                      try {
                        tagger?.dispose()
                      } finally {
                        cover = null
                      }
                    }
                  })

                  if (ctx.request.signal.aborted || responseSettled) return

                  headers['Content-Length'] = fs.statSync(tempPath).size.toString()
                  // The tagged payload is always a complete 200 response, even
                  // when the upstream answered the probe with 206.
                  delete headers['Content-Range']
                  delete headers['Accept-Ranges']
                  finishProgress()
                  settleTaggedResponse(createTempFileResponse(), false, true)
                } catch (e: any) {
                  if (ctx.request.signal.aborted || responseSettled) {
                    finishExpectedAbort()
                  } else if (tempStreamError) {
                    markProgressError(tempStreamError.message || 'Download stream failed')
                    settleTaggedResponse(ctx.fail(502, '下载处理失败，请重试'))
                  } else if (fs.existsSync(tempPath)) {
                    if (fs.statSync(tempPath).size < 100) {
                      markProgressError('下载内容无效或为空')
                      settleTaggedResponse(ctx.fail(502, '下载内容无效，请重试'))
                    } else {
                      finishProgress()
                      if (!headers['Content-Length']) headers['Content-Length'] = fs.statSync(tempPath).size.toString()
                      delete headers['Content-Range']
                      delete headers['Accept-Ranges']
                      settleTaggedResponse(createTempFileResponse(), false, true)
                    }
                  } else {
                    markProgressError(e?.message || 'Download processing failed')
                    settleTaggedResponse(ctx.fail(502, '下载处理失败，请重试'))
                  }
                }
              })
              return
            }

            const stream = createProxyResponseStream(
              proxyRes,
              proxyReq,
              maxAudioBytes,
              releaseProxySlot,
              consumeProxyBytes,
            )

            settleResponse(
              new Response(stream, {
                status: proxyRes.statusCode || 200,
                headers,
              }),
              false,
            )
          })

          activeProxyRequest = proxyReq
          if (proxyAgent) proxyReq.once('error', () => proxyAgent.destroy())
          proxyReq.setTimeout?.(30_000, () => proxyReq.destroy(new Error('Remote request timed out')))

          proxyReq.on('error', (err: any) => {
            removeRelayRedirect(urlStr)
            if (isExpectedDownloadAbort(err, ctx.request.signal)) {
              finishExpectedAbort()
              return
            }
            console.error('[DownloadProxy] Request Error:', err)
            settleResponse(ctx.fail(502, '请求远程地址失败，请重试'))
          })

          proxyReq.end()
        } catch (err: any) {
          removeRelayRedirect(urlStr)
          if (isExpectedDownloadAbort(err, ctx.request.signal)) {
            finishExpectedAbort()
            return
          }
          console.error('[DownloadProxy] Try Error:', err)
          settleResponse(ctx.fail(500, '服务器内部错误，请稍后重试'))
        }
      }

      const initialFetchUrl = getCachedRelayRedirect(urlStr) ?? urlStr

      void doFetch(initialFetchUrl, 0)
    } catch (err: any) {
      if (isExpectedDownloadAbort(err, ctx.request.signal)) {
        finishExpectedAbort()
        return
      }
      console.error('[DownloadProxy] Error:', err)
      settleResponse(ctx.fail(500, '服务器内部错误，请稍后重试'))
    }
  })
}
