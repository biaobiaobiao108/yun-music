import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Readable, Transform, pipeline } from 'node:stream'
import { Router } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as fileCache from '../fileCache'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { assertSafeRemoteHttpUrl } from '../networkSecurity'
import { verifyDownloadToken } from '../downloadToken'
import { memoryMaintenance } from '../memoryMaintenance'
import { tryAcquireMediaStream } from '../resourceBudget'
import { getMusicTagNative } from '../musicTagNative'

// Reuse a small, bounded set of upstream sockets for the media relay. The
// relay still validates every target URL and keeps the per-client concurrency
// limits below; keep-alive only removes avoidable TCP/TLS handshakes between
// adjacent tracks from the same host.
const upstreamHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxSockets: 8,
  maxFreeSockets: 4,
  timeout: 30_000,
})
const upstreamHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxSockets: 8,
  maxFreeSockets: 4,
  maxCachedSessions: 100,
  timeout: 30_000,
})

const getUpstreamAgent = (protocol: string): http.Agent | https.Agent =>
  protocol === 'https:' ? upstreamHttpsAgent : upstreamHttpAgent

/** Own the slot through downstream consumption, including small prefetched responses. */
const completeWhenConsumed = (
  stream: ReadableStream<Uint8Array>,
  onFinished: () => void,
): ReadableStream<Uint8Array> => {
  const reader = stream.getReader()
  let finished = false
  let cancelled = false
  const finish = () => {
    if (finished) return
    finished = true
    reader.releaseLock()
    onFinished()
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (cancelled) return
          if (done) {
            controller.close()
            finish()
          } else controller.enqueue(value)
        } catch (error) {
          if (!cancelled) controller.error(error)
          finish()
        }
      },
      async cancel(reason) {
        cancelled = true
        try {
          await reader.cancel(reason)
        } finally {
          finish()
        }
      },
    },
    { highWaterMark: 0 },
  )
}

/** Read tagged files on downstream demand and release resources only after the file handle closes. */
export const createTempFileResponseStream = (tempPath: string, onFinished: () => void): ReadableStream => {
  const source = fs.createReadStream(tempPath, { highWaterMark: 64 * 1024 })
  let closed = false
  let consumed = false
  let finished = false
  const finish = () => {
    if (!closed || !consumed || finished) return
    finished = true
    onFinished()
    memoryMaintenance.schedule('tagged media response end')
  }
  source.once('error', () => {
    consumed = true
  })
  source.once('close', () => {
    closed = true
    finish()
  })
  const stream = Readable.toWeb(source, {
    strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
  }) as unknown as ReadableStream<Uint8Array>
  return completeWhenConsumed(stream, () => {
    consumed = true
    finish()
  })
}

/** Keep upstream buffers bounded by downstream demand; cancellation tears down the whole pipeline. */
export const createProxyResponseStream = (
  source: Readable,
  request: http.ClientRequest,
  maxBytes: number,
  onFinished?: () => void,
  consumeBytes?: (byteCount: number) => boolean,
): ReadableStream => {
  let received = 0
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    onFinished?.()
    memoryMaintenance.schedule('media relay end')
  }
  const limited = new Transform({
    highWaterMark: 64 * 1024,
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > maxBytes) callback(new Error('Remote file is too large'))
      else if (consumeBytes && !consumeBytes(chunk.byteLength))
        callback(new Error('Download relay bandwidth budget exceeded'))
      else callback(null, chunk)
    },
  })
  const stream = Readable.toWeb(limited, {
    strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
  }) as unknown as ReadableStream
  pipeline(source, limited, error => {
    if (error) {
      request.destroy()
      finish()
    }
  })
  return completeWhenConsumed(stream, finish)
}

/** 客户端离开页面或取消媒体请求时，Node 会以 AbortError 结束中继请求。
 * 这是正常的连接生命周期，不应按服务端故障写入 error 日志。 */
const isExpectedDownloadAbort = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR'
}

export const isOpaqueBrowserProgressId = (id: string): boolean => /^(?:dl|server)_[A-Za-z0-9_-]{20,128}$/.test(id)

const DOWNLOAD_PROXY_MAX_ACTIVE_PER_IP = 4
const DOWNLOAD_PROXY_MAX_TAGGING_PER_IP = 1
const DOWNLOAD_PROXY_MAX_ACTIVE_GLOBAL = 64
const DOWNLOAD_PROXY_BUDGET_WINDOW_MS = 10 * 60 * 1000
const DOWNLOAD_PROXY_MAX_REQUESTS_PER_IP = 240
const DOWNLOAD_PROXY_MAX_REQUESTS_GLOBAL = 1_200
const DOWNLOAD_PROXY_MAX_BYTES_PER_IP = 2 * 1024 * 1024 * 1024
const DOWNLOAD_PROXY_MAX_BYTES_GLOBAL = 8 * 1024 * 1024 * 1024
const DOWNLOAD_PROXY_MAX_BUDGET_CLIENTS = 10_000
const downloadProxyActiveByIp = new Map<string, number>()
const downloadProxyTaggingByIp = new Map<string, number>()
type DownloadProxyBudgetBucket = { tokens: number; updatedAt: number }
const downloadProxyRequestBudgetByIp = new Map<string, DownloadProxyBudgetBucket>()
const downloadProxyByteBudgetByIp = new Map<string, DownloadProxyBudgetBucket>()
let downloadProxyGlobalActive = 0
let downloadProxyGlobalRequestBudget: DownloadProxyBudgetBucket = {
  tokens: DOWNLOAD_PROXY_MAX_REQUESTS_GLOBAL,
  updatedAt: Date.now(),
}
let downloadProxyGlobalByteBudget: DownloadProxyBudgetBucket = {
  tokens: DOWNLOAD_PROXY_MAX_BYTES_GLOBAL,
  updatedAt: Date.now(),
}

const refillDownloadProxyBucket = (
  bucket: DownloadProxyBudgetBucket | undefined,
  capacity: number,
  now: number,
): DownloadProxyBudgetBucket => {
  if (!bucket) return { tokens: capacity, updatedAt: now }
  const elapsed = Math.max(0, now - bucket.updatedAt)
  return {
    tokens: Math.min(capacity, bucket.tokens + (elapsed * capacity) / DOWNLOAD_PROXY_BUDGET_WINDOW_MS),
    updatedAt: now,
  }
}

const storeDownloadProxyBudgetBucket = (
  buckets: Map<string, DownloadProxyBudgetBucket>,
  key: string,
  bucket: DownloadProxyBudgetBucket,
): void => {
  // Refresh insertion order so bounded eviction removes the least recently used IP.
  buckets.delete(key)
  buckets.set(key, bucket)
  while (buckets.size > DOWNLOAD_PROXY_MAX_BUDGET_CLIENTS) {
    const oldest = buckets.keys().next().value
    if (!oldest) break
    buckets.delete(oldest)
  }
}

const consumeDownloadProxyRequestBudget = (ip: string): boolean => {
  const now = Date.now()
  const client = refillDownloadProxyBucket(
    downloadProxyRequestBudgetByIp.get(ip),
    DOWNLOAD_PROXY_MAX_REQUESTS_PER_IP,
    now,
  )
  const global = refillDownloadProxyBucket(downloadProxyGlobalRequestBudget, DOWNLOAD_PROXY_MAX_REQUESTS_GLOBAL, now)
  const allowed = client.tokens >= 1 && global.tokens >= 1
  if (allowed) {
    client.tokens -= 1
    global.tokens -= 1
  }
  storeDownloadProxyBudgetBucket(downloadProxyRequestBudgetByIp, ip, client)
  downloadProxyGlobalRequestBudget = global
  return allowed
}

const consumeDownloadProxyBytes = (ip: string, byteCount: number): boolean => {
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0) return byteCount === 0
  const now = Date.now()
  const client = refillDownloadProxyBucket(downloadProxyByteBudgetByIp.get(ip), DOWNLOAD_PROXY_MAX_BYTES_PER_IP, now)
  const global = refillDownloadProxyBucket(downloadProxyGlobalByteBudget, DOWNLOAD_PROXY_MAX_BYTES_GLOBAL, now)
  const allowed = client.tokens >= byteCount && global.tokens >= byteCount
  if (allowed) {
    client.tokens -= byteCount
    global.tokens -= byteCount
  }
  storeDownloadProxyBudgetBucket(downloadProxyByteBudgetByIp, ip, client)
  downloadProxyGlobalByteBudget = global
  return allowed
}

const tryAcquireDownloadProxySlot = (ip: string, tagging: boolean): (() => void) | null => {
  const active = downloadProxyActiveByIp.get(ip) || 0
  const activeTagging = downloadProxyTaggingByIp.get(ip) || 0
  if (
    downloadProxyGlobalActive >= DOWNLOAD_PROXY_MAX_ACTIVE_GLOBAL ||
    active >= DOWNLOAD_PROXY_MAX_ACTIVE_PER_IP ||
    (tagging && activeTagging >= DOWNLOAD_PROXY_MAX_TAGGING_PER_IP)
  ) {
    return null
  }
  if (!consumeDownloadProxyRequestBudget(ip)) return null
  const releaseGlobalStream = tryAcquireMediaStream()
  if (!releaseGlobalStream) return null
  downloadProxyActiveByIp.set(ip, active + 1)
  downloadProxyGlobalActive += 1
  if (tagging) downloadProxyTaggingByIp.set(ip, activeTagging + 1)

  let released = false
  return () => {
    if (released) return
    released = true
    releaseGlobalStream()
    const nextActive = (downloadProxyActiveByIp.get(ip) || 1) - 1
    if (nextActive > 0) downloadProxyActiveByIp.set(ip, nextActive)
    else downloadProxyActiveByIp.delete(ip)
    downloadProxyGlobalActive = Math.max(0, downloadProxyGlobalActive - 1)
    if (tagging) {
      const nextTagging = (downloadProxyTaggingByIp.get(ip) || 1) - 1
      if (nextTagging > 0) downloadProxyTaggingByIp.set(ip, nextTagging)
      else downloadProxyTaggingByIp.delete(ip)
    }
  }
}

export const createDownloadProxyRouter = (): Router => {
  const router = new Router()

  // 9. 音乐文件下载中继代理 (GET /api/music/download)
  router.get('/api/music/download', ctx => {
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
            const options: any = {
              method: 'GET',
              lookup: parsedUrl.lookup,
              agent: getUpstreamAgent(parsedUrl.protocol),
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
              proxyRes.setTimeout?.(30_000, () => proxyRes.destroy(new Error('Remote response timed out')))
              if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode)) {
                const location = proxyRes.headers.location
                if (location) {
                  // Only the redirect headers are needed. Draining an unbounded
                  // body would keep an unmetered socket alive after this hop.
                  proxyRes.destroy()
                  try {
                    const nextUrl = new URL(location, parsedUrl).href
                    void doFetch(nextUrl, attempt + 1)
                  } catch {
                    settleResponse(ctx.fail(502, '远程地址跳转目标不合法'))
                  }
                  return
                }
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
              const safeInlineType =
                /^(audio|video)\/[a-z0-9.+-]+$/.test(remoteType) ||
                /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(remoteType)
              const contentType = safeInlineType ? remoteType : 'application/octet-stream'

              const headers: Record<string, string> = {
                'Content-Type': contentType,
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "sandbox; default-src 'none'",
              }

              if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length']
              if (proxyRes.headers['accept-ranges']) headers['Accept-Ranges'] = proxyRes.headers['accept-ranges']
              if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range']

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
                    finishProgress()
                    settleTaggedResponse(createTempFileResponse(), false, true)
                  } catch (e: any) {
                    if (ctx.request.signal.aborted || responseSettled) {
                      finishExpectedAbort()
                    } else if (tempStreamError) {
                      markProgressError(tempStreamError.message || 'Download stream failed')
                      settleTaggedResponse(ctx.fail(502, '下载处理失败，请重试'))
                    } else if (fs.existsSync(tempPath)) {
                      finishProgress()
                      if (!headers['Content-Length']) headers['Content-Length'] = fs.statSync(tempPath).size.toString()
                      settleTaggedResponse(createTempFileResponse(), false, true)
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
            proxyReq.setTimeout?.(30_000, () => proxyReq.destroy(new Error('Remote request timed out')))

            proxyReq.on('error', (err: any) => {
              if (isExpectedDownloadAbort(err, ctx.request.signal)) {
                finishExpectedAbort()
                return
              }
              console.error('[DownloadProxy] Request Error:', err)
              settleResponse(ctx.fail(502, '请求远程地址失败，请重试'))
            })

            proxyReq.end()
          } catch (err: any) {
            if (isExpectedDownloadAbort(err, ctx.request.signal)) {
              finishExpectedAbort()
              return
            }
            console.error('[DownloadProxy] Try Error:', err)
            settleResponse(ctx.fail(500, '服务器内部错误，请稍后重试'))
          }
        }

        void doFetch(urlStr, 0)
      } catch (err: any) {
        if (isExpectedDownloadAbort(err, ctx.request.signal)) {
          finishExpectedAbort()
          return
        }
        console.error('[DownloadProxy] Error:', err)
        settleResponse(ctx.fail(500, '服务器内部错误，请稍后重试'))
      }
    })
  })

  return router
}
