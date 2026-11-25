import fs from 'node:fs'
import type http from 'node:http'
import type { HttpContext } from '../core'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { buildLyrics } from '@/utils/lrcTool'
import * as fileCache from '../fileCache'
import { getMusicTagNative } from '../musicTagNative'
import { createTempAudioPath, MAX_RELAY_AUDIO_BYTES } from '../services/mediaRelayProtocol'

type SettleResponse = (response: Response, releaseSlot?: boolean, preserveTempFile?: boolean) => void

interface TaggedDownloadOptions {
  ctx: HttpContext
  proxyRes: http.IncomingMessage
  headers: Record<string, string>
  filename: string
  taskId: string | null
  consumeProxyBytes: (byteCount: number) => boolean
  isSettled: () => boolean
  finishExpectedAbort: () => void
  settleResponse: SettleResponse
  trackTempFile: (tempPath: string, tempStream: fs.WriteStream) => void
  createTempFileResponse: (tempPath: string, headers: Record<string, string>) => Response
}

export const pipeTaggedDownload = ({
  ctx,
  proxyRes,
  headers,
  filename,
  taskId,
  consumeProxyBytes,
  isSettled,
  finishExpectedAbort,
  settleResponse,
  trackTempFile,
  createTempFileResponse,
}: TaggedDownloadOptions) => {
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
  const tempPath = createTempAudioPath(filename)
  const tempStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
  trackTempFile(tempPath, tempStream)
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
    if (isSettled() || taggedResponseSettled) return
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

  proxyRes.on('data', (chunk: Buffer) => {
    if (isSettled()) return
    received += chunk.length
    if (received > MAX_RELAY_AUDIO_BYTES) {
      proxyRes.destroy(new Error('Remote file is too large'))
      tempStream.destroy()
      markProgressError('Remote file is too large')
      settleTaggedResponse(ctx.fail(413, '远程文件过大，已超过允许的下载上限'))
      return
    }
    if (!consumeProxyBytes(chunk.length)) {
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
    if (isSettled() || taggedResponseSettled) return
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
          const normalizedLyricSongmid = lyricSongmid.startsWith(`${lyricSource}_`)
            ? lyricSongmid.slice(lyricSource.length + 1)
            : lyricSongmid
          const lyricReqObj = lyricApi.getLyric({
            songmid: normalizedLyricSongmid,
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
            lyricText = (lyricResult ? buildLyrics(lyricResult) : '') || lyricResult?.lyric || lyricResult?.lrc || ''
          } catch {
          } finally {
            ctx.request.signal.removeEventListener('abort', abortLyric)
          }
        }
        ctx.request.signal.throwIfAborted()

        // Keep native allocations inside the shared limit and create the
        // tagger only after remote enrichment has completed.
        let tagger: any = null
        try {
          tagger = new (getMusicTagNative().MusicTagger)()
          tagger.loadPath(tempPath)
          if (songName) tagger.title = songName
          if (artist) tagger.artist = artist
          if (album) tagger.album = album
          if (cover) tagger.pictures = [new (getMusicTagNative().MetaPicture)(cover.mime, cover.data, 'Cover')]
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

      if (ctx.request.signal.aborted || isSettled()) return

      headers['Content-Length'] = fs.statSync(tempPath).size.toString()
      // The tagged payload is always a complete 200 response, even when the
      // upstream answered the probe with 206.
      delete headers['Content-Range']
      delete headers['Accept-Ranges']
      finishProgress()
      settleTaggedResponse(createTempFileResponse(tempPath, headers), false, true)
    } catch (error: any) {
      if (ctx.request.signal.aborted || isSettled()) {
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
          headers['Content-Length'] = fs.statSync(tempPath).size.toString()
          delete headers['Content-Range']
          delete headers['Accept-Ranges']
          settleTaggedResponse(createTempFileResponse(tempPath, headers), false, true)
        }
      } else {
        markProgressError(error?.message || 'Download processing failed')
        settleTaggedResponse(ctx.fail(502, '下载处理失败，请重试'))
      }
    }
  })
}
