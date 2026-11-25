import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { checkPlayerAuthSession, verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as fileCache from '../fileCache'
import * as serverDownloadQueue from '../serverDownloadQueue'
import { assertSafeRemoteHttpUrl } from '../networkSecurity'
import { canReadPublicLocalMusic } from '../localMusicAccess'
import { isOpaqueBrowserProgressId } from '../services/mediaRelaySupport'
import { getCacheRequestUsername, resolveCacheTarget } from './cacheRouteShared'

const MAX_CACHE_EVENT_STREAMS = 256
let activeCacheEventStreams = 0
const createCacheEventsStream = (
  username: string,
  request: Request,
  release: () => void,
  authorized: () => boolean,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let cacheChangeTimer: ReturnType<typeof setTimeout> | null = null
  let pendingQueueEvent: Uint8Array | null = null
  let pendingCacheEvent: Uint8Array | null = null
  let unsubscribeQueue = () => {}
  let unsubscribeCache = () => {}

  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    if (cacheChangeTimer) clearTimeout(cacheChangeTimer)
    cacheChangeTimer = null
    pendingQueueEvent = null
    pendingCacheEvent = null
    release()
    unsubscribeQueue()
    unsubscribeCache()
    request.signal.removeEventListener('abort', close)
    try {
      streamController?.close()
    } catch {
      /* the browser may have cancelled first */
    }
  }

  const send = (event: string, payload: unknown) => {
    if (closed || !streamController) return
    try {
      if (!authorized()) return close()
      const message = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      if ((streamController.desiredSize ?? 1) <= 0) {
        if (event === 'queue') pendingQueueEvent = message
        else if (event === 'cache') pendingCacheEvent = message
        return
      }
      if (event === 'queue') pendingQueueEvent = null
      else if (event === 'cache') pendingCacheEvent = null
      streamController.enqueue(message)
    } catch {
      close()
    }
  }

  const flushPendingEvents = () => {
    if (closed || !streamController) return
    try {
      if (!authorized()) return close()
      if (pendingQueueEvent && (streamController.desiredSize ?? 1) > 0) {
        streamController.enqueue(pendingQueueEvent)
        pendingQueueEvent = null
      }
      if (pendingCacheEvent && (streamController.desiredSize ?? 1) > 0) {
        streamController.enqueue(pendingCacheEvent)
        pendingCacheEvent = null
      }
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
    pull() {
      flushPendingEvents()
    },
    cancel() {
      close()
    },
  })
}

export const createCacheQueueRouter = (): Router => {
  const router = new Router()
  const MAX_PROGRESS_IDS = 60

  // 3. 缓存命中检查
  router.get('/api/music/cache/check', ctx => {
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

  // 5. 服务端持久化下载队列与实时事件流
  router.get('/api/music/cache/events', ctx => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (activeCacheEventStreams >= MAX_CACHE_EVENT_STREAMS) return ctx.fail(503, '实时连接繁忙，请稍后重试')
    activeCacheEventStreams++
    let released = false
    const release = () => {
      if (released) return
      released = true
      activeCacheEventStreams = Math.max(0, activeCacheEventStreams - 1)
    }
    const authorized = () =>
      (!global.lx.config['player.enableAuth'] || checkPlayerAuthSession(ctx.cookies) || verifyAdminAuth(ctx.request)) &&
      getCacheRequestUsername(ctx) === username
    return new Response(createCacheEventsStream(username, ctx.request, release, authorized), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  router.get('/api/music/cache/queue', ctx => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    return ctx.json({ success: true, data: serverDownloadQueue.list(username) })
  })

  router.post('/api/music/cache/queue', async ctx => {
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
      await serverDownloadQueue.flushDownloadQueue()
      return ctx.json({ success: true, data: queued })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '下载任务参数不合法'))
    }
  })

  router.post('/api/music/cache/queue/concurrency', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    try {
      const { concurrency } = await ctx.bodyJson<{ concurrency?: number }>()
      const savedConcurrency = serverDownloadQueue.setConcurrency(username, concurrency)
      await serverDownloadQueue.flushDownloadQueue()
      return ctx.json({ success: true, data: { concurrency: savedConcurrency } })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '并发数不合法'))
    }
  })

  router.post('/api/music/cache/queue/resume', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    try {
      const { id, all } = await ctx.bodyJson<{ id?: string; all?: boolean }>()
      if (all !== true && !id) throw new Error('Missing queue task id')
      serverDownloadQueue.resume(username, all ? undefined : id)
      await serverDownloadQueue.flushDownloadQueue()
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '请求参数不合法'))
    }
  })

  router.post('/api/music/cache/queue/remove', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    try {
      const options = await ctx.bodyJson<{ id?: string; all?: boolean; completed?: boolean }>()
      if (!options || (options.all !== true && options.completed !== true && !options.id)) {
        throw new Error('Missing queue removal option')
      }
      serverDownloadQueue.remove(username, options)
      await serverDownloadQueue.flushDownloadQueue()
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '请求参数不合法'))
    }
  })

  // 5. 触发下载
  router.post('/api/music/cache/download', async ctx => {
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
        const requestOrigin = ctx.requestOrigin
        const parsed = new URL(requestedUrl, requestOrigin)
        if (parsed.origin === requestOrigin && parsed.pathname === '/api/music/download') {
          requestedUrl = parsed.searchParams.get('url')?.trim() || requestedUrl
        } else if (parsed.origin === requestOrigin && parsed.pathname.startsWith('/api/music/cache/file/')) {
          const rawPath = parsed.pathname.slice('/api/music/cache/file/'.length).split('/').filter(Boolean)
          if (!rawPath.length) return ctx.fail(400, '缓存文件路径不合法')
          const requestedCacheUsername = rawPath.length > 1 ? decodeURIComponent(rawPath.shift() || '') : '_open'
          const cacheUsername = ['open', 'default', '_open'].includes(requestedCacheUsername)
            ? '_open'
            : requestedCacheUsername
          const cacheFilename = rawPath.map(part => decodeURIComponent(part)).join('/')
          const cacheFolder = parsed.searchParams.get('folder') === 'music' ? 'music' : 'cache'
          if (!cacheFilename) return ctx.fail(400, '缓存文件名不合法')
          if (cacheFolder === 'music') {
            return ctx.json({
              success: true,
              successCount: 1,
              failCount: 0,
              moved: [],
              message: '歌曲已经在下载目录中',
            })
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
      const username = target.username
      const cached = fileCache.checkCache({ ...songInfo, quality, exactQuality: true }, username, false, {
        preferredFolder: enableOnlyDownloadMode ? 'music' : 'cache',
      })
      const hasPrivateCache = cached.exists && !cached.isCollision && cached.foundIn === username
      const safeDownloadUrl = hasPrivateCache ? null : await assertSafeRemoteHttpUrl(requestedUrl)

      if (namingPattern && verifyAdminAuth(ctx.request)) {
        const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
        if (global.lx.config) global.lx.config['cache.namingPattern'] = normalizedNamingPattern
      }

      const songKey = fileCache.normalizeSongId(songInfo) + '_' + (quality || 'unknown')
      const queued = serverDownloadQueue.enqueue(username, [
        {
          id: songKey,
          songInfo,
          quality,
          resolvedUrl: safeDownloadUrl?.toString(),
          background: background === true,
          enableOnlyDownloadMode: !!enableOnlyDownloadMode,
          cacheLyric: cacheLyric !== false,
          embedLyric: embedLyric !== false,
          requestedSource: requestedSource || songInfo.source,
          downloadSource,
          sourceName,
        },
      ])

      await serverDownloadQueue.flushDownloadQueue()
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
  router.post('/api/music/cache/stop', async ctx => {
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
      await serverDownloadQueue.flushDownloadQueue()
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.get('/api/music/cache/progress', ctx => {
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

  return router
}
