import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Readable, Transform, pipeline } from 'node:stream'
import { Router, type HttpContext } from '../core'
import { toUserMessage } from '../core/context'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as fileCache from '../fileCache'
import * as serverDownloadQueue from '../serverDownloadQueue'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { accessLog } from '@/utils/log4js'
import { assertSafeRemoteHttpUrl } from '../networkSecurity'
import { resolveInsideAsync } from '@/utils/pathSecurity'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { identifyLocalSong } from '../utils/identify'
import { canReadPublicLocalMusic } from '../localMusicAccess'

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

const getUpstreamAgent = (protocol: string): http.Agent | https.Agent => protocol === 'https:' ? upstreamHttpsAgent : upstreamHttpAgent

/** Keep upstream buffers bounded by downstream demand; cancellation tears down the whole pipeline. */
export const createProxyResponseStream = (
  source: Readable,
  request: http.ClientRequest,
  maxBytes: number,
  onFinished?: () => void,
): ReadableStream => {
  let received = 0
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    onFinished?.()
  }
  const limited = new Transform({
    highWaterMark: 64 * 1024,
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > maxBytes) callback(new Error('Remote file is too large'))
      else callback(null, chunk)
    },
  })
  const stream = Readable.toWeb(limited, {
    strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
  }) as unknown as ReadableStream
  pipeline(source, limited, error => {
    if (error) request.destroy()
    finish()
  })
  return stream
}

/** 客户端离开页面或取消媒体请求时，Node 会以 AbortError 结束中继请求。
 * 这是正常的连接生命周期，不应按服务端故障写入 error 日志。 */
const isExpectedDownloadAbort = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR'
}

type MusicTagNative = {
  MusicTagger: new () => any
  MetaPicture: new (mime: string, data: Uint8Array, type: string) => any
}

let musicTagNative: MusicTagNative | null = null
const getMusicTagNative = (): MusicTagNative => {
  if (!musicTagNative) musicTagNative = require('music-tag-native') as MusicTagNative
  return musicTagNative
}

/** 辅助获取缓存与下载任务的目标用户名 */
const getCacheRequestUsername = (ctx: HttpContext): string | null => {
  const requested = ctx.query.get('user')?.trim() || ''
  const verified = verifyUserAuth(ctx)
  const isAdmin = verifyAdminAuth(ctx.request)
  const isPublicAlias = requested === 'default' || requested === 'open' || requested === '_open'
  // An omitted user means the current user's private storage. An explicit
  // public alias must remain public even when the browser also sends a
  // personal session cookie.
  if (!requested && verified) return verified
  if (!requested || isPublicAlias) {
    return canReadPublicLocalMusic(ctx, verified, isAdmin) ? '_open' : null
  }
  if (isAdmin) {
    try { return assertSafePathSegment(requested, 'user name') } catch { return null }
  }
  return verified === requested ? verified : null
}

const MAX_PROGRESS_IDS = 60
const isOpaqueBrowserProgressId = (id: string): boolean => (
  /^(?:dl|server)_[A-Za-z0-9_-]{20,128}$/.test(id)
)

const DOWNLOAD_PROXY_MAX_ACTIVE_PER_IP = 4
const DOWNLOAD_PROXY_MAX_TAGGING_PER_IP = 1
const downloadProxyActiveByIp = new Map<string, number>()
const downloadProxyTaggingByIp = new Map<string, number>()

const tryAcquireDownloadProxySlot = (ip: string, tagging: boolean): (() => void) | null => {
  const active = downloadProxyActiveByIp.get(ip) || 0
  const activeTagging = downloadProxyTaggingByIp.get(ip) || 0
  if (active >= DOWNLOAD_PROXY_MAX_ACTIVE_PER_IP || (tagging && activeTagging >= DOWNLOAD_PROXY_MAX_TAGGING_PER_IP)) {
    return null
  }
  downloadProxyActiveByIp.set(ip, active + 1)
  if (tagging) downloadProxyTaggingByIp.set(ip, activeTagging + 1)

  let released = false
  return () => {
    if (released) return
    released = true
    const nextActive = (downloadProxyActiveByIp.get(ip) || 1) - 1
    if (nextActive > 0) downloadProxyActiveByIp.set(ip, nextActive)
    else downloadProxyActiveByIp.delete(ip)
    if (tagging) {
      const nextTagging = (downloadProxyTaggingByIp.get(ip) || 1) - 1
      if (nextTagging > 0) downloadProxyTaggingByIp.set(ip, nextTagging)
      else downloadProxyTaggingByIp.delete(ip)
    }
  }
}

type CacheTargetResult = { ok: true; username: string } | { ok: false; error: Response }

/**
 * 解析缓存请求的目标用户空间。
 * 公共空间 (_open) 的破坏性写操作必须由管理员发起，
 * 否则任何匿名访客都能改写或清空多人共用的曲库。
 */
const resolveCacheTarget = (
  ctx: HttpContext,
  options: { publicWrite?: boolean } = {},
): CacheTargetResult => {
  const requested = ctx.query.get('user')?.trim() || ''
  const isPublicAlias = requested === 'default' || requested === 'open' || requested === '_open'
  const verified = verifyUserAuth(ctx)
  const isAdmin = verifyAdminAuth(ctx.request)

  // An omitted user means the authenticated user's private storage. An
  // explicit public alias means the shared _open storage, even when the
  // request also carries a personal session cookie.
  if (!requested && verified) return { ok: true, username: verified }

  if (!requested || isPublicAlias) {
    if (options.publicWrite && !isAdmin) {
      return { ok: false, error: ctx.fail(403, '权限不足：修改公共本地音乐库需要先验证管理员身份') }
    }
    return { ok: true, username: '_open' }
  }

  if (isAdmin) {
    try { return { ok: true, username: assertSafePathSegment(requested, 'user name') } } catch { return { ok: false, error: ctx.fail(400, '用户名不合法') } }
  }
  if (!verified || verified !== requested) return { ok: false, error: ctx.fail(401, '登录状态已失效，请重新登录') }
  return { ok: true, username: verified }
}

const createCacheEventsStream = (username: string, request: Request): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let cacheChangeTimer: ReturnType<typeof setTimeout> | null = null
  let unsubscribeQueue = () => {}
  let unsubscribeCache = () => {}

  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    if (cacheChangeTimer) clearTimeout(cacheChangeTimer)
    cacheChangeTimer = null
    unsubscribeQueue()
    unsubscribeCache()
    request.signal.removeEventListener('abort', close)
    try { streamController?.close() } catch { /* the browser may have cancelled first */ }
  }

  const send = (event: string, payload: unknown) => {
    if (closed || !streamController) return
    try {
      streamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`))
    } catch {
      close()
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      request.signal.addEventListener('abort', close, { once: true })
      send('ready', { at: Date.now() })
      unsubscribeQueue = serverDownloadQueue.subscribe(username, tasks => send('queue', { tasks, at: Date.now() }))
      unsubscribeCache = fileCache.subscribeCacheChanges(changedUsername => {
        if (changedUsername !== username || closed || cacheChangeTimer) return
        cacheChangeTimer = setTimeout(() => {
          cacheChangeTimer = null
          send('cache', { at: Date.now() })
        }, 100)
        ;(cacheChangeTimer as any)?.unref?.()
      })
      heartbeat = setInterval(() => send('heartbeat', { at: Date.now() }), 15_000)
      ;(heartbeat as any)?.unref?.()
      if (request.signal.aborted) close()
    },
    cancel() {
      close()
    },
  })
}

/** 注册本地音乐缓存、下载队列与文件分发路由 */
export const createCacheRouter = (): Router => {
  const router = new Router()

  // 1. 缓存基础配置与索引同步
  router.post('/api/music/cache/config', async (ctx) => {
    // 缓存位置与命名规则是全局设置，不能由普通用户改变整个实例的
    // 存储路径或后续文件命名策略。
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(403, '权限不足：修改全局缓存配置需要管理员身份')

    try {
      const { location, namingPattern } = await ctx.bodyJson<{ location?: string; namingPattern?: string }>()
      let updated = false

      if (location && location !== fileCache.getCacheLocation()) {
        fileCache.setCacheLocation(location)
        updated = true
      }

      if (namingPattern) {
        const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
        if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
        updated = true
      }

      if (updated) {
        return ctx.json({ success: true })
      }
      return ctx.json({ success: true, message: '配置未发生变化' })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '保存缓存配置失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/sync', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      await fileCache.syncCacheIndex(target.username)
      return ctx.json({ success: true, message: 'Sync completed' })
    } catch (e: any) {
      return ctx.fail(500, '同步缓存索引失败，请稍后重试')
    }
  })

  router.get('/api/music/cache/subdirs', (ctx) => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    const requestedFolder = ctx.query.get('folder')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') {
      return ctx.fail(400, '目录类型不合法')
    }
    const folder = (requestedFolder as fileCache.CacheFolder | null) || 'music'
    const subdirs = fileCache.getSubDirectories(username, folder)
    return ctx.json({ success: true, data: subdirs })
  })

  router.post('/api/music/cache/mkdir', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const { folder, subPath } = await ctx.bodyJson<{ folder?: fileCache.CacheFolder; subPath?: string }>()
      if (!folder || !subPath) return ctx.fail(400, '缺少必要参数：folder、subPath')
      if (folder !== 'cache' && folder !== 'music') return ctx.fail(400, '目录类型不合法')
      const success = fileCache.createSubDirectory(username, folder, subPath)
      return ctx.json({ success })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '创建目录失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/categorize', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const { filenames, subPath } = await ctx.bodyJson<{ filenames?: string[]; subPath?: string }>()
      if (!Array.isArray(filenames) || typeof subPath !== 'string') return ctx.fail(400, '缺少必要参数：filenames、subPath')
      const result = await fileCache.categorizeFiles(filenames, subPath, username)
      return ctx.json({ success: true, ...result })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '归类文件失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/rename', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const result = await fileCache.batchRenameCacheFiles(username)
      return ctx.json(result)
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '批量重命名失败，请稍后重试'))
    }
  })

  // 3. 缓存命中检查
  router.get('/api/music/cache/check', (ctx) => {
    const name = ctx.query.get('name')
    const singer = ctx.query.get('singer')
    const source = ctx.query.get('source')
    const songmid = ctx.query.get('songmid')
    const songId = ctx.query.get('songId')
    const id = ctx.query.get('id')
    const quality = ctx.query.get('quality')
    const exactQuality = ctx.query.get('exactQuality') === '1' || ctx.query.get('exactQuality') === 'true'

    if (!name || !singer || !source || (!songmid && !songId && !id)) {
      return ctx.fail(400, '缺少必要参数')
    }

    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    const cacheSong = { name, singer, source, songmid, songId, id: id || undefined, quality, exactQuality }
    // cacheProgress is process-global and has no user ownership metadata. It
    // must not make one user's cache lookup wait for another user's download.
    // The persistent queue below is user-scoped and is the authoritative
    // processing signal for this endpoint.
    const result = fileCache.checkCache(cacheSong, username, false, { ignoreActiveProgress: true })
    const activeTaskProgress = serverDownloadQueue.getActiveTaskProgress(username, cacheSong, quality || undefined)
    if (activeTaskProgress) {
      return ctx.json({
        ...result,
        processing: true,
        progress: activeTaskProgress,
      })
    }
    return ctx.json(result)
  })

  // 4. 播放触达记录：仅由播放器在 audio.play() 成功后调用，供缓存上限
  // 按最近播放时间做 LRU 清理。请求目标由 user 查询参数限定在当前用户
  // 或公共空间，不能跨用户写入播放记录。
  router.post('/api/music/cache/playback', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const body = await ctx.bodyJson<{ filename?: string; folder?: fileCache.CacheFolder; location?: string }>()
      if (!body.filename || typeof body.filename !== 'string') return ctx.fail(400, '缺少必要参数：filename')
      if (body.folder !== 'cache' && body.folder !== 'music') return ctx.fail(400, '目录类型不合法')
      if (body.location && body.location !== fileCache.CACHE_ROOTS.DATA && body.location !== fileCache.CACHE_ROOTS.ROOT) return ctx.fail(400, '缓存位置不合法')

      const marked = body.location
        ? fileCache.markCachePlayback(body.filename, target.username, body.folder, body.location)
        : fileCache.markCachePlayback(body.filename, target.username, body.folder)
      return ctx.json({ success: true, data: { marked } })
    } catch (err) {
      return ctx.fail(400, toUserMessage(err, '记录播放时间失败，请稍后重试'))
    }
  })

  // 5. 服务端持久化下载队列与实时事件流
  router.get('/api/music/cache/events', (ctx) => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    return new Response(createCacheEventsStream(username, ctx.request), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  router.get('/api/music/cache/queue', (ctx) => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    return ctx.json({ success: true, data: serverDownloadQueue.list(username) })
  })

  router.post('/api/music/cache/queue', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    try {
      const { tasks, namingPattern, concurrency } = await ctx.bodyJson<{
        tasks?: any[]
        namingPattern?: string
        concurrency?: number
      }>()
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Missing tasks')
      if (tasks.length > 100) throw new Error('Too many tasks')
      if (concurrency !== undefined) serverDownloadQueue.setConcurrency(username, concurrency)
      if (namingPattern && verifyAdminAuth(ctx.request)) {
        const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
        if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
      }
      const queued = serverDownloadQueue.enqueue(username, tasks)
      return ctx.json({ success: true, data: queued })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '下载任务参数不合法'))
    }
  })

  router.post('/api/music/cache/queue/concurrency', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    try {
      const { concurrency } = await ctx.bodyJson<{ concurrency?: number }>()
      const savedConcurrency = serverDownloadQueue.setConcurrency(username, concurrency)
      return ctx.json({ success: true, data: { concurrency: savedConcurrency } })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '并发数不合法'))
    }
  })

  router.post('/api/music/cache/queue/resume', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    try {
      const { id, all } = await ctx.bodyJson<{ id?: string; all?: boolean }>()
      if (all !== true && !id) throw new Error('Missing queue task id')
      serverDownloadQueue.resume(username, all ? undefined : id)
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '请求参数不合法'))
    }
  })

  router.post('/api/music/cache/queue/remove', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    try {
      const options = await ctx.bodyJson<{ id?: string; all?: boolean; completed?: boolean }>()
      if (!options || (options.all !== true && options.completed !== true && !options.id)) {
        throw new Error('Missing queue removal option')
      }
      serverDownloadQueue.remove(username, options)
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '请求参数不合法'))
    }
  })

  // 5. 触发下载
  router.post('/api/music/cache/download', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const {
        songInfo,
        url,
        quality,
        enableOnlyDownloadMode,
        namingPattern,
        cacheLyric,
        embedLyric,
        background,
        requestedSource,
        downloadSource,
        sourceName,
      } = await ctx.bodyJson<any>()

      if (!songInfo || !url) return ctx.fail(400, '缺少必要参数')
      let requestedUrl = String(url).trim()
      try {
        const requestOrigin = new URL(ctx.request.url).origin
        const parsed = new URL(requestedUrl, requestOrigin)
        if (parsed.origin === requestOrigin && parsed.pathname === '/api/music/download') {
          requestedUrl = parsed.searchParams.get('url')?.trim() || requestedUrl
        } else if (parsed.origin === requestOrigin && parsed.pathname.startsWith('/api/music/cache/file/')) {
          const rawPath = parsed.pathname.slice('/api/music/cache/file/'.length).split('/').filter(Boolean)
          if (!rawPath.length) return ctx.fail(400, '缓存文件路径不合法')
          const requestedCacheUsername = rawPath.length > 1 ? decodeURIComponent(rawPath.shift() || '') : '_open'
          const cacheUsername = ['open', 'default', '_open'].includes(requestedCacheUsername) ? '_open' : requestedCacheUsername
          const cacheFilename = rawPath.map(part => decodeURIComponent(part)).join('/')
          const cacheFolder = parsed.searchParams.get('folder') === 'music' ? 'music' : 'cache'
          if (!cacheFilename) return ctx.fail(400, '缓存文件名不合法')
          if (cacheFolder === 'music') {
            return ctx.json({ success: true, successCount: 1, failCount: 0, moved: [], message: '歌曲已经在下载目录中' })
          }
          if (cacheUsername === '_open' && target.username !== '_open') {
            if (!canReadPublicLocalMusic(ctx, verifyUserAuth(ctx), verifyAdminAuth(ctx.request))) {
              return ctx.fail(403, '您没有权限下载公共本地音乐')
            }
            const promoted = await fileCache.promoteCacheFile(cacheFilename, cacheUsername, target.username)
            if (promoted.successCount < 1) return ctx.fail(409, '缓存文件尚未准备好，请稍后再试')
            return ctx.json({ success: true, ...promoted, message: '已移入下载目录' })
          }
          if (cacheUsername !== target.username && !verifyAdminAuth(ctx.request)) {
            return ctx.fail(403, '无权移动其他用户的缓存文件')
          }
          const moved = await fileCache.switchFolder([cacheFilename], cacheUsername, 'music')
          if (moved.successCount < 1) return ctx.fail(409, '缓存文件尚未准备好，请稍后再试')
          return ctx.json({ success: true, ...moved, message: '已移入下载目录' })
        }
      } catch {
        return ctx.fail(400, '下载地址不合法')
      }
      const safeDownloadUrl = await assertSafeRemoteHttpUrl(requestedUrl)

      const username = target.username

      if (namingPattern && verifyAdminAuth(ctx.request)) {
        const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
        if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
      }

      const songKey = fileCache.normalizeSongId(songInfo) + '_' + (quality || 'unknown')
      const queued = serverDownloadQueue.enqueue(username, [{
        id: songKey,
        songInfo,
        quality,
        resolvedUrl: safeDownloadUrl.toString(),
        background: background === true,
        enableOnlyDownloadMode: !!enableOnlyDownloadMode,
        cacheLyric: cacheLyric !== false,
        embedLyric: embedLyric !== false,
        requestedSource: requestedSource || songInfo.source,
        downloadSource,
        sourceName,
      }])

      return ctx.json({
        success: true,
        data: queued,
        message: queued.length > 0 ? 'Download queued' : 'Download already queued',
      })
    } catch (err: any) {
      console.error('[Cache] Download trigger error:', err?.message || err)
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    }
  })

  // 6. 停止下载任务
  router.post('/api/music/cache/stop', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const { songKey, queueId, all } = await ctx.bodyJson<{ songKey?: string; queueId?: string; all?: boolean }>()
      if (all) {
        serverDownloadQueue.pause(username)
        console.log(`[Cache] Stopped all tasks for user: ${username}`)
      } else if (queueId) {
        serverDownloadQueue.pause(username, queueId)
        console.log(`[Cache] Paused persistent queue task ${queueId} for user: ${username}`)
      } else if (songKey) {
        serverDownloadQueue.pauseBySongKey(username, songKey)
        console.log(`[Cache] Stopped task ${songKey} for user: ${username}`)
      }
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  // 8. 分发缓存文件（基于 Bun.file 零拷贝高性能分发）
  router.get('/api/music/cache/file/*', async (ctx) => {
    const parts = ctx.pathname.replace('/api/music/cache/file/', '').split('/')
    let reqUsername = '_open'
    let filename = parts[0]
    try {
      if (parts.length > 1) {
        reqUsername = decodeURIComponent(parts[0])
        filename = parts.slice(1).join('/')
      }
    } catch {
      return ctx.fail(400, '文件路径不合法')
    }

    if (!filename) return ctx.fail(400, '缺少必要参数：filename')

    let username = '_open'
    const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default' || reqUsername === 'open'

    if (isPublic && !canReadPublicLocalMusic(ctx)) {
      return ctx.fail(403, '您没有权限访问公共本地音乐，请联系管理员设置', {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      })
    }

    if (!isPublic) {
      const isAdmin = verifyAdminAuth(ctx.request)
      const tokenUser = verifyUserAuth(ctx)
      if (!isAdmin && (!tokenUser || tokenUser !== reqUsername)) {
        return ctx.fail(401, '登录状态已失效，请重新登录')
      }
      username = reqUsername
    }

    let decodedFilename = filename
    try {
      decodedFilename = decodeURIComponent(filename)
    } catch {
      return ctx.fail(400, '文件路径不合法')
    }
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const requestedFolder = ctx.query.get('folder')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') {
      return ctx.fail(400, '目录类型不合法')
    }
    const locations = [
      fileCache.getCacheLocation(),
      fileCache.getCacheLocation() === fileCache.CACHE_ROOTS.DATA ? fileCache.CACHE_ROOTS.ROOT : fileCache.CACHE_ROOTS.DATA,
    ]
    const roots: Array<fileCache.CacheFolder> = requestedFolder
      ? [requestedFolder as fileCache.CacheFolder]
      : ['cache', 'music']
    let filePath = ''
    let fileStats: fs.Stats | null = null

    for (const loc of locations) {
      for (const folder of roots) {
        const dir = fileCache.getCacheDir(normalizedUsername, folder === 'music', loc, false)
        const safeFilename = decodedFilename.replace(/\\/g, '/')
        let checkPath: string
        try {
          checkPath = await resolveInsideAsync(dir, safeFilename)
        } catch {
          continue
        }
        try {
          fileStats = await fs.promises.stat(checkPath)
          filePath = checkPath
          break
        } catch {
          // The cache may disappear between index lookup and file delivery.
        }
      }
      if (filePath) break
    }

    if (!filePath || !fileStats || !fileStats.isFile() || fileStats.size <= 0) {
      return ctx.fail(404, '文件不存在')
    }

    const bunFile = Bun.file(filePath)
    const size = fileStats.size
    const mtime = fileStats.mtimeMs
    const etag = `W/"${size}-${mtime}"`
    const lastModified = new Date(mtime).toUTCString()

    const rangeHeader = ctx.headers.get('range')
    const ifNoneMatch = ctx.headers.get('if-none-match')
    const ifModifiedSince = ctx.headers.get('if-modified-since')
    const cacheControl = normalizedUsername === '_open' ? 'public, max-age=86400' : 'private, no-store'
    const unsatisfiableRangeResponse = () => new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': '0',
        'ETag': etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
      },
    })
    // A media client may combine validators with a Range request. Return the
    // requested partial content in that case instead of a 304 response that
    // cannot satisfy the media element's byte-range demand.
    if (!rangeHeader && (ifNoneMatch === etag || (ifModifiedSince && ifModifiedSince === lastModified))) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': cacheControl,
        },
      })
    }

    const contentType = bunFile.type || 'audio/mpeg'

    if (rangeHeader) {
      const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/)
      if (match && (match[1] || match[2])) {
        let start: number
        let end: number

        if (!match[1]) {
          const suffixLength = Number.parseInt(match[2], 10)
          if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return unsatisfiableRangeResponse()
          }
          start = Math.max(0, size - suffixLength)
          end = size - 1
        } else {
          start = Number.parseInt(match[1], 10)
          end = match[2] ? Number.parseInt(match[2], 10) : size - 1
          if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
            return unsatisfiableRangeResponse()
          }
          end = Math.min(end, size - 1)
        }

        const chunk = bunFile.slice(start, end + 1)
        return new Response(chunk, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': contentType,
            'ETag': etag,
            'Last-Modified': lastModified,
            'Cache-Control': cacheControl,
          },
        })
      }
    }

    return new Response(bunFile, {
      status: 200,
      headers: {
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'ETag': etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
      },
    })
  })

  // 9. 缓存统计与清理
  router.get('/api/music/cache/stats', (ctx) => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const stats = fileCache.getCacheStats(username)
      return ctx.json({ success: true, data: stats })
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '获取缓存统计失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/clear', (ctx) => {
    const isAdmin = verifyAdminAuth(ctx.request)
    const reqUser = ctx.query.get('user')
    if (reqUser === 'all' || reqUser === '_all') {
      if (!isAdmin) {
        return ctx.fail(403, '权限不足：只有管理员可以清空所有用户缓存')
      }
      try {
        const result = fileCache.clearAllUsersAudioCache()
        return ctx.json({ success: true, data: result })
      } catch (err) {
        return ctx.fail(500, toUserMessage(err, '清空缓存失败，请稍后重试'))
      }
    }

    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const result = fileCache.clearOnlyAudioCache(target.username)
      return ctx.json({ success: true, data: result })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '清空缓存失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/lyric/clear', (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const result = fileCache.clearLyricCache(target.username)
      return ctx.json({ success: true, data: result })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '清空歌词缓存失败，请稍后重试'))
    }
  })

  router.get('/api/music/cache/progress', (ctx) => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    const ids = (ctx.query.get('ids')?.split(',') || [])
      .map(id => id.trim())
      .filter(id => id.length > 0 && id.length <= 128)
      .slice(0, MAX_PROGRESS_IDS)
    const progress: Record<string, any> = serverDownloadQueue.getProgressForUser(username, ids)
    // Browser-side proxy downloads do not belong to the persistent server
    // queue. Their IDs are high-entropy UUID-style handles, so only accept
    // that narrow format instead of exposing arbitrary global cache keys.
    for (const id of ids) {
      if (progress[id] || !isOpaqueBrowserProgressId(id)) continue
      const value = fileCache.cacheProgress.get(id)
      if (value) progress[id] = value
    }
    return ctx.json({ success: true, data: progress })
  })

  router.get('/api/music/cache/list', async (ctx) => {
    const targetUserParam = ctx.query.get('user')
    const reqUsername = targetUserParam || ''
    const isAdmin = verifyAdminAuth(ctx.request)
    const verified = verifyUserAuth(ctx)
    const isPublicAlias = reqUsername === 'default' || reqUsername === 'open' || reqUsername === '_open'
    const isAll = reqUsername === 'all' || reqUsername === '_all'

    if (isAll) {
      if (!isAdmin) {
        return ctx.fail(403, '权限不足：只有管理员可以查看所有用户缓存与下载数据')
      }
      try {
        const list = await fileCache.getAllCacheList()
        return ctx.json({ success: true, data: list }, 200, {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        })
      } catch (err: any) {
        return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
      }
    }

    let username = '_open'

    if (isAdmin && reqUsername && !isPublicAlias) {
      try {
        username = assertSafePathSegment(reqUsername, 'user name')
      } catch {
        return ctx.fail(400, '用户参数不合法')
      }
    } else if (!reqUsername && verified) {
      username = verified
    } else if (!reqUsername || isPublicAlias) {
      if (!canReadPublicLocalMusic(ctx, verified, isAdmin)) {
        return ctx.json({ success: false, message: '您没有权限查看此目录，请联系管理员设置' }, 403, {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        })
      }
      username = '_open'
    } else {
      if (!verified) {
        return ctx.fail(401, '登录状态已失效，请重新登录', {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        })
      }
      username = verified
    }

    try {
      const list = await fileCache.getCacheList(username)
      return ctx.json({ success: true, data: list }, 200, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.get('/api/music/cache/cover', async (ctx) => {
    const reqUsername = ctx.query.get('user') || ''
    const isPublicAlias = reqUsername === '_open' || reqUsername === 'default' || reqUsername === 'open'
    const verified = verifyUserAuth(ctx)
    const isAdmin = verifyAdminAuth(ctx.request)
    let username = verified || '_open'

    if (isPublicAlias) {
      username = '_open'
    } else if (reqUsername && isAdmin) {
      username = reqUsername
    } else if (reqUsername && (!verified || verified !== reqUsername)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }

    if (username === '_open' && !canReadPublicLocalMusic(ctx, verified)) {
      return ctx.fail(403, '您没有权限访问公共本地音乐，请联系管理员设置', {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      })
    }

    const filename = ctx.query.get('filename')
    if (!filename) return ctx.fail(400, '缺少必要参数：filename')
    const requestedFolder = ctx.query.get('folder')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') {
      return ctx.fail(400, '目录类型不合法')
    }

    const cover = (await (requestedFolder
      ? fileCache.getCacheCover(filename, username, requestedFolder as fileCache.CacheFolder)
      : fileCache.getCacheCover(filename, username))) as any
    if (cover && cover.data) {
      return new Response(cover.data, {
        status: 200,
        headers: {
          'Content-Type': cover.mime || 'image/jpeg',
          'Cache-Control': username === '_open' ? 'public, max-age=86400' : 'private, no-store',
        },
      })
    }
    return ctx.fail(404, '资源不存在')
  })

  router.post('/api/music/cache/remove', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    const isAdmin = verifyAdminAuth(ctx.request)

    try {
      const payload = await ctx.bodyJson<any>()
      const legacyFilenames = payload.filenames
      const rawItems = Array.isArray(payload.items)
        ? payload.items
        : (legacyFilenames ? (Array.isArray(legacyFilenames) ? legacyFilenames : [legacyFilenames]) : [])
      if (rawItems.length === 0) throw new Error('Missing items')

      const deleteItems: Array<{ filename: string; folder?: fileCache.CacheFolder; user?: string }> = rawItems.map((item: any) => {
        if (typeof item === 'string') return { filename: item }
        if (!item || typeof item.filename !== 'string') throw new Error('Invalid delete item')
        if (item.folder !== undefined && item.folder !== 'cache' && item.folder !== 'music') {
          throw new Error('Invalid folder')
        }
        return {
          filename: item.filename,
          folder: item.folder,
          user: typeof item.user === 'string' && item.user ? item.user : (typeof item.rawUsername === 'string' && item.rawUsername ? item.rawUsername : undefined),
        }
      })

      let deletedCount = 0
      const failures: Array<{ filename: string; folder?: fileCache.CacheFolder; message: string }> = []
      for (const item of deleteItems) {
        try {
          const itemUser = (isAdmin && item.user)
            ? assertSafePathSegment(item.user, 'user name')
            : username
          const result = fileCache.removeCacheFile(item.filename, itemUser, item.folder)
          if (result.deleted) {
            deletedCount++
            accessLog.info(`music file deleted user=${itemUser} folder=${result.folder} filename=${JSON.stringify(item.filename)}`)
          } else {
            failures.push({ ...item, message: 'File not found' })
          }
        } catch (error: any) {
          failures.push({ ...item, message: error?.message || 'Delete failed' })
          accessLog.warn(`music file delete rejected user=${item.user || username} folder=${item.folder || 'unspecified'} filename=${JSON.stringify(item.filename)} reason=${JSON.stringify(error?.message || 'Delete failed')}`)
        }
      }

      const success = failures.length === 0
      const statusCode = success ? 200 : (deletedCount > 0 ? 207 : 409)
      return ctx.json({
        success,
        deletedCount,
        failedCount: failures.length,
        failures,
        message: success ? undefined : failures[0]?.message,
      }, statusCode)
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.post('/api/music/cache/move', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const isAdmin = verifyAdminAuth(ctx.request)

    try {
      const payload = await ctx.bodyJson<any>()
      const requestedTargetFolder = payload.targetFolder === undefined || payload.targetFolder === null || payload.targetFolder === ''
        ? undefined
        : (payload.targetFolder === 'cache' || payload.targetFolder === 'music' ? payload.targetFolder as fileCache.CacheFolder : null)
      if (payload.targetFolder !== undefined && requestedTargetFolder === null) return ctx.fail(400, '目标目录不合法')
      const rawItems = Array.isArray(payload.items)
        ? payload.items
        : (payload.filenames ? (Array.isArray(payload.filenames) ? payload.filenames.map((f: string) => ({ filename: f, user: payload.user })) : [{ filename: payload.filenames, user: payload.user }]) : [])
      if (rawItems.length === 0) return ctx.fail(400, '缺少必要参数：filenames')
      if (rawItems.length > 500) return ctx.fail(400, '单次最多移动 500 个文件')

      const userGroup = new Map<string, string[]>()
      const publicPromotions: Array<{ filename: string; sourceUser: string }> = []
      for (const item of rawItems) {
        const requestedSourceUser = String(item.sourceUser || item.user || item.rawUsername || '').trim()
        const sourceUser = ['open', 'default', '_open'].includes(requestedSourceUser) ? '_open' : requestedSourceUser
        if (!isAdmin && sourceUser === '_open' && target.username !== '_open' && requestedTargetFolder === 'music') {
          publicPromotions.push({ filename: item.filename, sourceUser })
          continue
        }
        const itemUser = (isAdmin && sourceUser)
          ? assertSafePathSegment(sourceUser, 'user name')
          : target.username
        const list = userGroup.get(itemUser) || []
        list.push(item.filename)
        userGroup.set(itemUser, list)
      }

      let totalSuccess = 0
      let totalFail = 0
      const moved: Array<{ filename: string; from: fileCache.CacheFolder; to: fileCache.CacheFolder; user: string }> = []
      for (const item of publicPromotions) {
        const result = await fileCache.promoteCacheFile(item.filename, item.sourceUser, target.username)
        totalSuccess += result.successCount
        totalFail += result.failCount
        moved.push(...result.moved.map(entry => ({ ...entry, user: target.username })))
      }
      for (const [user, filenames] of userGroup.entries()) {
        const result = await fileCache.switchFolder(filenames, user, requestedTargetFolder ?? undefined)
        totalSuccess += result.successCount
        totalFail += result.failCount
        moved.push(...result.moved.map(item => ({ ...item, user })))
      }
      return ctx.json({ success: true, successCount: totalSuccess, failCount: totalFail, moved })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '移动文件失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/switch-base', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filenames } = await ctx.bodyJson<{ filenames?: string[] | string }>()
      if (!filenames) return ctx.fail(400, '缺少必要参数：filenames')
      const fileList = Array.isArray(filenames) ? filenames : [filenames]
      if (fileList.length > 500) return ctx.fail(400, '单次最多转移 500 个文件')
      const result = await fileCache.switchBaseLocation(fileList, target.username)
      return ctx.json({ success: true, ...result })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '跨目录转移文件失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/updateMetadata', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filenames } = await ctx.bodyJson<{ filenames?: string[] | string }>()
      if (!filenames) return ctx.fail(400, '缺少必要参数：filenames')
      const fileList = Array.isArray(filenames) ? filenames : [filenames]
      if (fileList.length > 500) return ctx.fail(400, '单次最多处理 500 个文件')
      const result = await fileCache.batchUpdateMetadata(fileList, target.username)
      return ctx.json({ success: true, ...result })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '更新歌曲元数据失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/embedLyric', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const { filenames } = await ctx.bodyJson<{ filenames?: string[] }>()
      if (!filenames || !Array.isArray(filenames)) throw new Error('Missing filenames')
      if (filenames.length > 500) throw new Error('Too many files')

      let successCount = 0
      let skippedCount = 0
      let failCount = 0
      const details: any[] = []

      for (const filename of filenames) {
        let filePath = ''
        let folder: 'cache' | 'music' = 'cache'

        for (const f of ['cache', 'music'] as const) {
          const dir = fileCache.getCacheDir(username, f === 'music')
          const candidate = fileCache.resolveCacheRelativePath(dir, filename)
          if (!candidate) continue
          if (fs.existsSync(candidate)) {
            filePath = candidate
            folder = f
            break
          }
        }

        if (!filePath) {
          details.push({ filename, status: 'fail', reason: '文件不存在' })
          failCount++
          continue
        }

        try {
          const indexItem = fileCache.getIndexItemByFilename(filename, username) as any
          if (indexItem?.metadataWritable === false) {
            details.push({
              filename,
              status: 'fail',
              reason: indexItem.embedLyricError || indexItem.metadataError || '当前音频容器不支持嵌入歌词，外置歌词文件仍可正常使用',
            })
            failCount++
            continue
          }

          let checkTagger: any
          let existingLyrics = ''
          try {
            checkTagger = new (getMusicTagNative().MusicTagger)()
            checkTagger.loadPath(filePath)
            existingLyrics = checkTagger.lyrics || ''
          } catch (checkError: any) {
            const unsupportedStatus = fileCache.getAudioMetadataUnsupportedStatus(filePath)
            fileCache.setIndexEmbedLyric(filename, username, false, {
              audioContainer: unsupportedStatus.audioContainer,
              metadataWritable: false,
              metadataError: unsupportedStatus.error,
              embedLyricError: unsupportedStatus.error,
            })
            details.push({
              filename,
              status: 'fail',
              reason: unsupportedStatus.error || '当前音频容器不支持嵌入歌词，外置歌词文件仍可正常使用',
            })
            failCount++
            continue
          } finally {
            try { if (checkTagger) checkTagger.dispose() } catch { }
          }

          if (existingLyrics && existingLyrics.trim().length > 10) {
            details.push({ filename, status: 'skipped', reason: '已有歌词标签' })
            skippedCount++
            continue
          }

          const songInfo = indexItem
          const ext = path.extname(filename)
          const baseName = filename.slice(0, filename.length - ext.length)
          const lrcFilename = baseName + '.lrc'
          const dir = fileCache.getCacheDir(username, folder === 'music')
          const lrcPath = fileCache.resolveCacheRelativePath(dir, lrcFilename)

          let lyricText: string | null = null

          if (lrcPath && fs.existsSync(lrcPath)) {
            lyricText = fs.readFileSync(lrcPath, 'utf8')
            console.log(`[EmbedLyric] Using local .lrc for: ${filename}`)
          } else if (songInfo && songInfo.source && songInfo.source !== 'unknown') {
            const lyricFetcherFn = fileCache.getLyricFetcher()
            if (lyricFetcherFn) {
              lyricText = await lyricFetcherFn(songInfo)
            }
            if (lyricText) {
              console.log(`[EmbedLyric] Fetched lyric from SDK for: ${filename}`)
            }
          }

          if (!lyricText) {
            details.push({ filename, status: 'fail', reason: '无法获取歌词' })
            failCount++
            continue
          }

          const embedResult = fileCache.embedLyricsIntoFile(filePath, lyricText)
          fileCache.setIndexEmbedLyric(filename, username, embedResult.hasEmbedLyric, {
            audioContainer: embedResult.audioContainer,
            metadataWritable: embedResult.metadataWritable,
            metadataError: embedResult.metadataWritable ? undefined : embedResult.error,
            embedLyricError: embedResult.error,
          })
          if (!embedResult.success) {
            details.push({
              filename,
              status: 'fail',
              reason: embedResult.error || '歌词标签写入后校验失败，外置歌词文件仍可正常使用',
            })
            failCount++
            continue
          }

          details.push({ filename, status: 'success' })
          successCount++
          console.log(`[EmbedLyric] Embedded lyric for: ${filename}`)
        } catch (itemErr: any) {
          details.push({ filename, status: 'fail', reason: itemErr.message || '未知错误' })
          failCount++
        }
      }

      return ctx.json({ success: true, successCount, skippedCount, failCount, details })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.post('/api/music/cache/link', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filename, songInfo } = await ctx.bodyJson<{ filename?: string; songInfo?: any }>()
      if (!filename || !songInfo) return ctx.fail(400, '缺少必要参数：filename、songInfo')
      const result = await fileCache.linkLocalFile(filename, songInfo, target.username)
      return ctx.json(result)
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '关联本地文件失败，请稍后重试'))
    }
  })

  router.post('/api/music/identify', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filename, folder } = await ctx.bodyJson<{ filename?: string; folder?: 'cache' | 'music' }>()
      if (!filename) return ctx.fail(400, '缺少必要参数：filename')
      const dir = fileCache.getCacheDir(target.username, folder === 'music')
      const filePath = fileCache.resolveCacheRelativePath(dir, filename)
      if (!filePath) throw new Error('文件名不合法')
      if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filename}`)
      const results = await identifyLocalSong(filePath)
      return ctx.json({ success: true, results })
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '识别歌曲失败，请稍后重试'))
    }
  })

  router.get('/api/music/cache/lyric', (ctx) => {
    const source = ctx.query.get('source')
    const songmid = ctx.query.get('songmid') || ctx.query.get('songId') || ctx.query.get('id')
    const songId = ctx.query.get('songId') || ctx.query.get('id')

    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    if (!source || (!songmid && !songId)) return ctx.fail(400, '缺少必要参数：source、songmid')

    const name = ctx.query.get('name') || ''
    const singer = ctx.query.get('singer') || ''
    const result = fileCache.checkLyricCache({ source, songmid, id: songId, name, singer }, username)
    if (result.exists) {
      return ctx.json({ success: true, data: result.content })
    }
    return ctx.fail(404, '缓存中未找到该内容')
  })

  router.post('/api/music/cache/lyric', async (ctx) => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { songInfo, lyricsObj, enableOnlyDownloadMode } = await ctx.bodyJson<{
        songInfo?: any
        lyricsObj?: any
        enableOnlyDownloadMode?: boolean
      }>()
      const username = target.username

      if (!songInfo || !lyricsObj) return ctx.fail(400, '缺少必要参数')

      const success = fileCache.saveLyricCache(songInfo, lyricsObj, username, !!enableOnlyDownloadMode)
      return ctx.json({ success })
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    }
  })

  // 9. 音乐文件下载中继代理 (GET /api/music/download)
  router.get('/api/music/download', (ctx) => {
    const urlStr = ctx.query.get('url')
    const filename = (ctx.query.get('filename') || 'download.mp3').slice(0, 255)
    const isInline = ctx.query.get('inline') === '1'
    const isTaggingMode = ctx.query.get('tag') === '1'

    if (!urlStr) return ctx.fail(400, '缺少必要参数：url')
    if (urlStr.length > 4096) return ctx.fail(413, '远程地址过长')

    const releaseProxySlot = tryAcquireDownloadProxySlot(ctx.remoteAddress || 'unknown', isTaggingMode)
    if (!releaseProxySlot) return ctx.fail(429, '当前下载请求过多，请稍后重试')

    return new Promise<Response>((resolve) => {
      let responseSettled = false
      let abortListener: (() => void) | null = null
      let activeProxyRequest: http.ClientRequest | null = null
      let activeProxyResponse: http.IncomingMessage | null = null
      let activeTempStream: fs.WriteStream | null = null
      const settleResponse = (response: Response, releaseSlot = true) => {
        if (responseSettled) return
        responseSettled = true
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
        try { activeProxyRequest?.destroy() } catch { }
        try { activeProxyResponse?.destroy() } catch { }
        try { activeTempStream?.destroy() } catch { }
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': parsedUrl.origin,
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
                  proxyRes.resume()
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
              const remoteType = String(proxyRes.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
              const safeInlineType = /^(audio|video)\/[a-z0-9.+-]+$/.test(remoteType)
                || /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(remoteType)
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
                const tempPath = path.join(os.tmpdir(), `lx_tag_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`)
                const tempStream = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 })
                activeTempStream = tempStream
                let tempStreamError: Error | null = null
                let taggedResponseSettled = false
                const settleTaggedResponse = (response: Response, releaseSlot = true) => {
                  if (taggedResponseSettled) return
                  taggedResponseSettled = true
                  settleResponse(response, releaseSlot)
                }
                const markProgressError = (message: string) => {
                  if (!taskId) return
                  fileCache.setCacheProgress(taskId, { progress: 0, status: 'error', errorMsg: message, updatedAt: Date.now() })
                }
                const failTaggedStream = (message: string) => {
                  if (responseSettled || taggedResponseSettled) return
                  markProgressError(message)
                  try { tempStream.destroy() } catch { }
                  try { proxyRes.destroy() } catch { }
                  fs.unlink(tempPath, () => { })
                  settleTaggedResponse(ctx.fail(502, '下载数据流中断，请重试'))
                }
                tempStream.on('error', (error) => {
                  tempStreamError = error
                  failTaggedStream(error.message || 'Download stream failed')
                })

                if (taskId) {
                  fileCache.setCacheProgress(taskId, { progress: 0, status: 'downloading', total, received: 0, speed: 0, updatedAt: Date.now() })
                }

                proxyRes.on('data', (c: any) => {
                  if (responseSettled) return
                  received += c.length
                  if (received > maxAudioBytes) {
                    proxyRes.destroy(new Error('Remote file is too large'))
                    tempStream.destroy()
                    fs.unlink(tempPath, () => { })
                    markProgressError('Remote file is too large')
                    settleTaggedResponse(ctx.fail(413, '远程文件过大，已超过允许的下载上限'))
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
                    fileCache.setCacheProgress(taskId, { progress, status: 'downloading', total, received, speed: currentSpeed, updatedAt: now })
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
                    fileCache.setCacheProgress(taskId, { progress: 100, status: 'tagging', total, received, speed: 0, updatedAt: Date.now() })
                  }
                  const finishProgress = () => {
                    if (!taskId) return
                    fileCache.setCacheProgress(taskId, { progress: 100, status: 'finished', total: total || received, received, speed: 0, updatedAt: Date.now() })
                  }

                  let tagger: any = null
                  const createTempFileResponse = () => {
                    const readStream = fs.createReadStream(tempPath)
                    let cleaned = false
                    const cleanup = () => {
                      if (cleaned) return
                      cleaned = true
                      releaseProxySlot()
                      readStream.destroy()
                      fs.unlink(tempPath, () => { })
                    }
                    const stream = new ReadableStream({
                      start(controller) {
                        readStream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
                        readStream.on('end', () => {
                          cleanup()
                          controller.close()
                        })
                        readStream.on('error', (error) => {
                          cleanup()
                          controller.error(error)
                        })
                      },
                      cancel() {
                        cleanup()
                      },
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

                    tagger = new (getMusicTagNative().MusicTagger)()
                    tagger.loadPath(tempPath)
                    if (songName) tagger.title = songName
                    if (artist) tagger.artist = artist
                    if (album) tagger.album = album

                    if (imageUrl) {
                      try {
                        const cover = await fileCache.downloadCoverImage(imageUrl)
                        if (cover) {
                          tagger.pictures = [new (getMusicTagNative().MetaPicture)(cover.mime, new Uint8Array(cover.data), 'Cover')]
                        }
                      } catch (e: any) {
                        console.warn('[DownloadProxy] Picture fetch/embed failed:', imageUrl, e.message)
                      }
                    }

                    const lyricApi = lyricSource ? getBuiltinSource(lyricSource) : undefined
                    if (embedLyric && lyricSongmid && lyricApi?.getLyric) {
                      try {
                        const lyricReqObj = lyricApi.getLyric({
                          songmid: lyricSongmid,
                          name: songName,
                          singer: artist,
                          hash: lyricHash,
                          interval: lyricInterval,
                        })
                        const lyricResult = await lyricReqObj.promise
                        const lyricText = lyricResult?.lyric || lyricResult?.lrc || ''
                        if (lyricText) tagger.lyrics = lyricText
                      } catch { }
                    }

                    tagger.save()
                    tagger.dispose()
                    tagger = null

                    headers['Content-Length'] = fs.statSync(tempPath).size.toString()
                    finishProgress()
                    settleTaggedResponse(createTempFileResponse(), false)
                  } catch (e: any) {
                    if (tempStreamError) {
                      markProgressError(tempStreamError.message || 'Download stream failed')
                      fs.unlink(tempPath, () => { })
                      settleTaggedResponse(ctx.fail(502, '下载处理失败，请重试'))
                    } else if (fs.existsSync(tempPath)) {
                      finishProgress()
                      if (!headers['Content-Length']) headers['Content-Length'] = fs.statSync(tempPath).size.toString()
                      settleTaggedResponse(createTempFileResponse(), false)
                    } else {
                      markProgressError(e?.message || 'Download processing failed')
                      settleTaggedResponse(ctx.fail(502, '下载处理失败，请重试'))
                    }
                  } finally {
                    if (tagger) tagger.dispose()
                  }
                })
                return
              }

              const stream = createProxyResponseStream(proxyRes, proxyReq, maxAudioBytes, releaseProxySlot)

              settleResponse(new Response(stream, {
                status: proxyRes.statusCode || 200,
                headers,
              }), false)
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
