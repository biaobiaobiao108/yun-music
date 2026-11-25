import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { type HttpContext } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as fileCache from '../fileCache'
import { assertSafeRemoteHttpUrl, createSafeRemoteProxyAgent } from '../networkSecurity'
import { verifyDownloadToken } from '../downloadToken'
import {
  buildRelayResponseHeaders,
  MAX_RELAY_AUDIO_BYTES,
  resolveRelayContentType,
} from '../services/mediaRelayProtocol'
import { createProxyResponseStream, createTempFileResponseStream } from '../services/upstreamRelayStream'
import {
  cacheRelayRedirect,
  consumeDownloadProxyBytes,
  getCachedRelayRedirect,
  getUpstreamAgent,
  isExpectedDownloadAbort,
  isOpaqueBrowserProgressId,
  removeRelayRedirect,
  tryAcquireDownloadProxySlot,
} from '../services/mediaRelaySupport'
import { pipeTaggedDownload } from './mediaRelayTagging'

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

          const proxyReq = lib.request(targetUrl, options, (proxyRes: http.IncomingMessage) => {
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
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode || 0)) {
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

            const declaredLength = Number(proxyRes.headers['content-length'] || 0)
            if (declaredLength > MAX_RELAY_AUDIO_BYTES) {
              proxyRes.destroy()
              settleResponse(ctx.fail(413, '远程文件过大，已超过允许的下载上限'))
              return
            }
            const { contentType, safeInlineType } = resolveRelayContentType(
              String(proxyRes.headers['content-type'] || ''),
              ctx.query.get('filename'),
              isInline,
            )

            if (targetUrl !== urlStr && (proxyRes.statusCode === 200 || proxyRes.statusCode === 206)) {
              cacheRelayRedirect(urlStr, targetUrl)
            }

            const headers = buildRelayResponseHeaders(proxyRes.headers, {
              contentType,
              safeInlineType,
              filename,
              isInline,
            })

            if (isTaggingMode && (!rangeHeader || isFullRange)) {
              if (proxyRes.statusCode === 206) {
                const contentRange = String(proxyRes.headers['content-range'] || '')
                const match = contentRange.match(/^bytes\s+0-(\d+)\/(\d+)$/i)
                const endByte = match ? Number(match[1]) : -1
                const totalBytes = match ? Number(match[2]) : -1
                if (!match || totalBytes <= 0 || endByte !== totalBytes - 1) {
                  proxyRes.destroy()
                  if (taskId) {
                    fileCache.setCacheProgress(taskId, {
                      progress: 0,
                      status: 'error',
                      errorMsg: '远程服务器仅返回部分分片，无法完整处理标签',
                      updatedAt: Date.now(),
                    })
                  }
                  settleResponse(ctx.fail(502, '远程服务器仅返回部分分片，请重试'))
                  return
                }
              }
              pipeTaggedDownload({
                ctx,
                proxyRes,
                headers,
                filename,
                taskId,
                consumeProxyBytes,
                isSettled: () => responseSettled,
                finishExpectedAbort,
                settleResponse,
                trackTempFile: (tempPath, tempStream) => {
                  activeTempPath = tempPath
                  activeTempStream = tempStream
                },
                createTempFileResponse: (tempPath, responseHeaders) => {
                  const stream = createTempFileResponseStream(tempPath, () => {
                    releaseProxySlot()
                    cleanupActiveTempFile()
                  })
                  return new Response(stream, { status: 200, headers: responseHeaders })
                },
              })
              return
            }

            const stream = createProxyResponseStream(
              proxyRes,
              proxyReq,
              MAX_RELAY_AUDIO_BYTES,
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

          proxyReq.on('error', (error: any) => {
            removeRelayRedirect(urlStr)
            if (isExpectedDownloadAbort(error, ctx.request.signal)) {
              finishExpectedAbort()
              return
            }
            console.error('[DownloadProxy] Request Error:', error)
            settleResponse(ctx.fail(502, '请求远程地址失败，请重试'))
          })

          proxyReq.end()
        } catch (error: any) {
          removeRelayRedirect(urlStr)
          if (isExpectedDownloadAbort(error, ctx.request.signal)) {
            finishExpectedAbort()
            return
          }
          console.error('[DownloadProxy] Try Error:', error)
          settleResponse(ctx.fail(500, '服务器内部错误，请稍后重试'))
        }
      }

      const initialFetchUrl = getCachedRelayRedirect(urlStr) ?? urlStr
      void doFetch(initialFetchUrl, 0)
    } catch (error: any) {
      if (isExpectedDownloadAbort(error, ctx.request.signal)) {
        finishExpectedAbort()
        return
      }
      console.error('[DownloadProxy] Error:', error)
      settleResponse(ctx.fail(500, '服务器内部错误，请稍后重试'))
    }
  })
}
