import { Router, type HttpContext, type Middleware } from '../core'
import { toUserMessage } from '../core/context'
import { verifyUserAuth } from './auth'
import { normalizeSongInfo, resolveServerSong } from '../services/musicResolver'
import { isSourceSupported, callUserApiGetMusicUrl } from '../userApi'
import { isRetiredOnlineSource, UnsupportedSourceError } from '@/common/musicSources'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import * as fileCache from '../fileCache'
import fs from 'node:fs'
import path from 'node:path'
import { assertSafeRemoteHttpUrl, fetchSafeRemote, type SafeRemoteHttpUrl } from '../networkSecurity'
import { canReadPublicLocalMusic } from '../localMusicAccess'

/** 音乐解析进度 SSE 专属通道: requestId -> Controller */
export const musicProgressControllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
const musicProgressTimers = new Map<string, ReturnType<typeof setTimeout>>()
const musicProgressHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
const musicProgressClientIps = new Map<string, string>()
const musicProgressIpCounts = new Map<string, number>()
const MUSIC_PROGRESS_TTL = 10 * 60 * 1000
const MAX_MUSIC_PROGRESS_CHANNELS = 2_048
const MAX_MUSIC_PROGRESS_CHANNELS_PER_IP = 32
const MUSIC_PROGRESS_HEARTBEAT = 15 * 1000
const MUSIC_REQUEST_WINDOW = 60 * 1000
const MUSIC_REQUEST_LIMIT = 120
const MUSIC_REQUEST_BUCKET_LIMIT = 10_000
const musicRequestBuckets = new Map<string, { startedAt: number; count: number }>()

const musicRateLimitMiddleware: Middleware = async (ctx, next) => {
  const now = Date.now()
  const key = ctx.remoteAddress || 'unknown'
  const current = musicRequestBuckets.get(key)
  const bucket = !current || now - current.startedAt >= MUSIC_REQUEST_WINDOW
    ? { startedAt: now, count: 0 }
    : current
  bucket.count += 1
  musicRequestBuckets.set(key, bucket)
  while (musicRequestBuckets.size > MUSIC_REQUEST_BUCKET_LIMIT) {
    const oldest = musicRequestBuckets.keys().next().value
    if (!oldest) break
    musicRequestBuckets.delete(oldest)
  }
  if (bucket.count > MUSIC_REQUEST_LIMIT) {
    return ctx.fail(429, '请求过于频繁，请稍后重试', { retryAfter: 60 })
  }
  return next()
}

const cleanupMusicProgress = (reqId: string, controller?: ReadableStreamDefaultController<Uint8Array>) => {
  if (controller && musicProgressControllers.get(reqId) !== controller) return
  musicProgressControllers.delete(reqId)
  const timer = musicProgressTimers.get(reqId)
  if (timer) clearTimeout(timer)
  musicProgressTimers.delete(reqId)
  const heartbeat = musicProgressHeartbeatTimers.get(reqId)
  if (heartbeat) clearInterval(heartbeat)
  musicProgressHeartbeatTimers.delete(reqId)
  const clientIp = musicProgressClientIps.get(reqId)
  if (clientIp) {
    const nextCount = (musicProgressIpCounts.get(clientIp) || 1) - 1
    if (nextCount > 0) musicProgressIpCounts.set(clientIp, nextCount)
    else musicProgressIpCounts.delete(clientIp)
  }
  musicProgressClientIps.delete(reqId)
}

/** 格式化字节大小 */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`
}

const SONG_LIST_HOSTS: Record<string, ReadonlySet<string>> = {
  wy: new Set(['music.163.com']),
  tx: new Set(['y.qq.com', 'i.y.qq.com']),
}

/**
 * 只从数字 ID 或官方歌单链接提取 ID，不访问用户提供的原始链接。
 * 旧版 SDK 会对无法识别的链接发起请求，路由层必须先完成这一层收敛。
 */
export const normalizeSongListId = (source: string, rawId: string): string | null => {
  const input = String(rawId || '').trim()
  if (!input || input.length > 512) return null
  if (/^\d+$/.test(input)) return input

  const allowedHosts = SONG_LIST_HOSTS[source]
  if (!allowedHosts) return null

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) return null

  const candidates = [
    parsed.searchParams.get('id'),
    parsed.pathname.match(/\/playlist\/(\d+)/i)?.[1],
    parsed.hash.match(/[?&]id=(\d+)/i)?.[1],
  ]
  return candidates.find(candidate => Boolean(candidate && /^\d+$/.test(candidate))) || null
}

const parseContentLength = (headers: Headers): number | null => {
  const range = headers.get('content-range')
  const total = range?.match(/\/(\d+)$/)?.[1]
  if (total) {
    const parsed = Number(total)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  const length = Number(headers.get('content-length'))
  if (Number.isFinite(length) && length > 0) return length

  return null
}

const getAudioRemoteSize = async (audioUrl: string): Promise<number | null> => {
  if (!/^https?:\/\//i.test(audioUrl)) return null

  let safeUrl: SafeRemoteHttpUrl
  try {
    safeUrl = await assertSafeRemoteHttpUrl(audioUrl)
  } catch {
    return null
  }
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': safeUrl.origin,
  }

  try {
    const resp = await fetchSafeRemote(safeUrl, {
      method: 'HEAD',
      timeoutMs: 8000,
      maxBytes: 1024,
      headers,
    })
    const size = parseContentLength(resp.headers)
    if (size) return size
  } catch (e: any) {
    console.warn(`[QualitySize] HEAD failed: ${e.message}`)
  }

  try {
    const resp = await fetchSafeRemote(safeUrl, {
      method: 'GET',
      timeoutMs: 8000,
      maxBytes: 1024,
      headers: {
        ...headers,
        Range: 'bytes=0-0',
      },
    })
    const size = parseContentLength(resp.headers)
    await resp.body?.cancel()
    return size
  } catch (e: any) {
    console.warn(`[QualitySize] Range probe failed: ${e.message}`)
  }

  return null
}

/** 注册在线音乐检索、解析与播放元数据路由 */
export const createMusicRouter = (): Router => {
  const router = new Router()
  router.use('/api/music', musicRateLimitMiddleware)
  const boundedInt = (value: string | null, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(value || '', 10)
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
  }

  // 1. 音乐搜索 API
  router.get('/api/music/search', async (ctx) => {
    const name = ctx.query.get('name') || ''
    const source = ctx.query.get('source') || 'wy'
    const type = ctx.query.get('type') || 'song'
    const limit = boundedInt(ctx.query.get('limit'), 40, 1, 100)
    const page = boundedInt(ctx.query.get('page'), 1, 1, 1000)
    const fetchPages = boundedInt(ctx.query.get('pages'), 1, 1, 5)

    if (!name) return ctx.fail(400, '缺少必要参数：name')

    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi) {
        throw new Error(`Source ${source} is not supported`)
      }

      let result: any
      if (type === 'song') {
        // Some upstream search endpoints cap one request at 20 items even
        // when a larger limit is supplied. Compose the web-player page from
        // stable 20-item upstream pages so page boundaries stay contiguous.
        const UPSTREAM_PAGE_SIZE = 20
        const startIndex = (page - 1) * limit
        const firstUpstreamPage = Math.floor(startIndex / UPSTREAM_PAGE_SIZE) + 1
        const offsetInFirstPage = startIndex % UPSTREAM_PAGE_SIZE
        const pagesNeeded = Math.ceil((offsetInFirstPage + limit) / UPSTREAM_PAGE_SIZE)
        const maxPages = Math.max(fetchPages, pagesNeeded)
        let allSongs: any[] = []

        for (let offset = 0; offset < maxPages; offset++) {
          const searchData = await sourceApi.musicSearch!.search(name, firstUpstreamPage + offset, UPSTREAM_PAGE_SIZE)
          const pageList: any[] = searchData.list || []
          allSongs = allSongs.concat(pageList)
          if (pageList.length < UPSTREAM_PAGE_SIZE || allSongs.length >= offsetInFirstPage + limit) break
        }
        result = allSongs.slice(offsetInFirstPage, offsetInFirstPage + limit)
      } else if (type === 'singer') {
        if (!sourceApi.extendSearch?.searchSinger) {
          throw new Error(`Source ${source} does not support singer search`)
        }
        const searchData = await sourceApi.extendSearch.searchSinger(name, page, limit)
        result = searchData.list || []
      } else if (type === 'album') {
        if (!sourceApi.extendSearch?.searchAlbum) {
          throw new Error(`Source ${source} does not support album search`)
        }
        const searchData = await sourceApi.extendSearch.searchAlbum(name, page, limit)
        result = searchData.list || []
      } else if (type === 'playlist') {
        if (!sourceApi.extendSearch?.searchPlaylist) {
          throw new Error(`Source ${source} does not support playlist search`)
        }
        const searchData = await sourceApi.extendSearch.searchPlaylist(name, page, limit)
        result = searchData.list || []
      } else {
        throw new Error(`Invalid search type: ${type}`)
      }

      return ctx.json(result)
    } catch (err: any) {
      console.error(err)
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 2. 搜索提示 (TipSearch) API
  router.get('/api/music/tipSearch', async (ctx) => {
    const name = ctx.query.get('name') || ''
    const source = ctx.query.get('source') || 'wy'
    if (!name) return ctx.json([])
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.tipSearch) {
        return ctx.json([])
      }
      const tips = await sourceApi.tipSearch.search(name)
      return ctx.json(tips || [])
    } catch {
      return ctx.json([])
    }
  })

  // 3. 歌手详情 API
  router.get('/api/music/artistDetail', async (ctx) => {
    const id = ctx.query.get('id')
    const source = ctx.query.get('source') || 'wy'
    if (!id) return ctx.fail(400, '缺少必要参数：id')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.extendDetail?.getArtistDetail) throw new Error(`Source ${source} does not support artist details`)
      const data = await sourceApi.extendDetail.getArtistDetail(id)
      return ctx.json(data)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取数据失败，请稍后重试'))
    }
  })

  // 4. 歌手专辑列表 API
  router.get('/api/music/artistAlbums', async (ctx) => {
    const id = ctx.query.get('id')
    const source = ctx.query.get('source') || 'wy'
    const page = boundedInt(ctx.query.get('page'), 1, 1, 1000)
    const limit = boundedInt(ctx.query.get('limit'), 40, 1, 100)
    if (!id) return ctx.fail(400, '缺少必要参数：id')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.extendDetail?.getArtistAlbums) throw new Error(`Source ${source} does not support artist albums`)
      const data = await sourceApi.extendDetail.getArtistAlbums(id, page, limit)
      return ctx.json(data)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取数据失败，请稍后重试'))
    }
  })

  // 5. 歌手歌曲列表 API
  router.get('/api/music/artistSongs', async (ctx) => {
    const id = ctx.query.get('id')
    const source = ctx.query.get('source') || 'wy'
    const order = ctx.query.get('order') || 'hot'
    const requestedPage = ctx.query.get('page')
    const requestedLimit = ctx.query.get('limit')
    if (!id) return ctx.fail(400, '缺少必要参数：id')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.extendDetail?.getArtistSongs) throw new Error(`Source ${source} does not support artist songs`)

      // Web Player 按页读取，避免进入高产歌手详情时串行抓取并传输上千首歌曲。
      // 未传分页参数时仍保留旧的全量数组响应，兼容现有 API 调用方。
      if (requestedPage !== null || requestedLimit !== null) {
        const page = boundedInt(requestedPage, 1, 1, 1000)
        const limit = boundedInt(requestedLimit, 40, 1, 100)
        // Legacy default marker: const limit = boundedInt(requestedLimit, 50, 1, 100)
        const data = await sourceApi.extendDetail.getArtistSongs(id, page, limit, order)
        const list = Array.isArray(data?.list) ? data.list : []
        return ctx.json({
          list,
          total: Math.max(Number(data?.total) || 0, list.length),
          page,
          limit,
        })
      }

      const PAGE_SIZE = 100
      const configuredMaxPages = Number((global.lx.config as any)?.['artist.maxFetchPages'])
      const MAX_PAGES = Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
        ? Math.min(Math.floor(configuredMaxPages), 100)
        : 20
      let allSongs: any[] = []
      for (let p = 1; p <= MAX_PAGES; p++) {
        const data = await sourceApi.extendDetail.getArtistSongs(id, p, PAGE_SIZE, order)
        const pageList: any[] = data.list || []
        allSongs = allSongs.concat(pageList)
        const total = Number(data.total) || 0
        if (pageList.length < PAGE_SIZE || (total > 0 && allSongs.length >= total)) break
      }
      return ctx.json(allSongs)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取数据失败，请稍后重试'))
    }
  })

  // 6. 专辑歌曲 API
  router.get('/api/music/albumSongs', async (ctx) => {
    const id = ctx.query.get('id')
    const source = ctx.query.get('source') || 'wy'
    if (!id) return ctx.fail(400, '缺少必要参数：id')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.extendDetail?.getAlbumSongs) throw new Error(`Source ${source} does not support album songs`)
      const data = await sourceApi.extendDetail.getAlbumSongs(id)
      return ctx.json(data)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取数据失败，请稍后重试'))
    }
  })

  // 7. 音乐解析进度 SSE 端点 (无需登录, 用 reqId 区分)
  router.get('/api/music/progress', (ctx) => {
    const rawReqId = ctx.query.get('reqId')?.trim() || ''
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(rawReqId)) return ctx.fail(400, '进度请求标识格式无效')
    const reqId = rawReqId

    const clientIp = ctx.remoteAddress || 'unknown'
    const previous = musicProgressControllers.get(reqId)
    if (previous) {
      try { previous.close() } catch { }
      cleanupMusicProgress(reqId, previous)
    }
    if ((musicProgressIpCounts.get(clientIp) || 0) >= MAX_MUSIC_PROGRESS_CHANNELS_PER_IP) {
      return ctx.fail(429, '该客户端的进度连接数过多，请稍后重试', { retryAfter: 15 })
    }

    const encoder = new TextEncoder()
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(encoder.encode('retry: 3000\n\n'))
        while (musicProgressControllers.size >= MAX_MUSIC_PROGRESS_CHANNELS) {
          const oldestReqId = musicProgressControllers.keys().next().value
          if (!oldestReqId) break
          const oldest = musicProgressControllers.get(oldestReqId)
          try { oldest?.close() } catch { }
          cleanupMusicProgress(oldestReqId, oldest)
        }
        musicProgressControllers.set(reqId, controller)
        musicProgressClientIps.set(reqId, clientIp)
        musicProgressIpCounts.set(clientIp, (musicProgressIpCounts.get(clientIp) || 0) + 1)
        musicProgressHeartbeatTimers.set(reqId, setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'))
          } catch {
            try { controller.close() } catch { }
            cleanupMusicProgress(reqId, controller)
          }
        }, MUSIC_PROGRESS_HEARTBEAT))
        musicProgressTimers.set(reqId, setTimeout(() => {
          try { controller.close() } catch { }
          cleanupMusicProgress(reqId, controller)
        }, MUSIC_PROGRESS_TTL))
        ;(musicProgressHeartbeatTimers.get(reqId) as any)?.unref?.()
        ;(musicProgressTimers.get(reqId) as any)?.unref?.()
      },
      cancel() {
        cleanupMusicProgress(reqId, streamController || undefined)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  })

  // 8. 音乐播放 URL 解析 API
  router.post('/api/music/url', async (ctx) => {
    const verifiedUsername = verifyUserAuth(ctx) || 'open'

    const rawReqId = ctx.headers.get('x-req-id')?.trim() || ''
    const reqId = /^[A-Za-z0-9_-]{8,128}$/.test(rawReqId) ? rawReqId : undefined

    const pushProgress = async (attempt: any, retries = 10): Promise<void> => {
      if (!reqId) return
      const controller = musicProgressControllers.get(reqId)
      if (controller) {
        try {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(attempt)}\n\n`))
        } catch {
          cleanupMusicProgress(reqId, controller)
        }
        return
      }
      if (retries > 0) {
        await new Promise((r) => setTimeout(r, 300))
        await pushProgress(attempt, retries - 1)
      } else {
        console.warn(`[SSE] ReqId ${reqId} not found after retries (${musicProgressControllers.size} clients registered)`)
      }
    }

    try {
      let { songInfo, quality, enableAutoSwitchApiSource } = await ctx.bodyJson<{
        songInfo?: any
        quality?: string
        enableAutoSwitchApiSource?: boolean
      }>()

      songInfo = normalizeSongInfo(songInfo)
      if (!songInfo || !songInfo.source) {
        throw new Error('Invalid songInfo')
      }

      // 优先前置检查服务端本地缓存（命中则直接返回，避免消耗外部第三方音源解析额度）
      const cacheTargetUser = verifiedUsername === 'open' ? '_open' : verifiedUsername
      if (cacheTargetUser !== '_open' || canReadPublicLocalMusic(ctx)) {
        const cached = fileCache.checkCache({ ...songInfo, quality }, cacheTargetUser, false, { ignoreActiveProgress: true })
        if (cached.exists && !cached.isCollision && cached.url) {
          return ctx.json({
            url: cached.url,
            type: cached.quality || quality || '128k',
            quality: cached.quality || quality || '128k',
            sourceName: '本地缓存',
            fromCache: true,
          })
        }
      }

      const source = songInfo.source
      if (isRetiredOnlineSource(source)) throw new UnsupportedSourceError(source)
      let result: any
      let customSourceError: string | null = null
      let attempts: any[] = []

      if (isSourceSupported(source, verifiedUsername)) {
        try {
          console.log(`[MusicUrl] Using custom source for: ${source} (ReqId: ${reqId || 'None'}, User: ${verifiedUsername})`)
          const userApiResult = await callUserApiGetMusicUrl(
            source,
            songInfo,
            quality || '128k',
            verifiedUsername,
            (attempt) => { void pushProgress(attempt) },
            enableAutoSwitchApiSource !== false
          )
          result = userApiResult
          attempts = userApiResult.attempts || []
        } catch (userApiError: any) {
          console.error(`[MusicUrl] Custom source failed:`, userApiError.message)
          customSourceError = userApiError.message
          attempts = userApiError.attempts || []
        }
      } else {
        void pushProgress({ name: '系统', status: 'fail', message: `未找到支持 ${source} 平台的自定义源，请在「设置 → 自定义源」中添加或启用相关音源` })
      }

      if (!result) {
        const errMsg = customSourceError || `未找到支持 ${source} 平台的自定义源，请在「设置 → 自定义源」中添加或启用相关音源`
        const err: any = new Error(errMsg)
        err.attempts = attempts
        // 音源缺失或解析失败都属于用户可自行修复的问题，用 422 而非 500
        err.code = 422
        throw err
      }

      if (attempts.length > 0) result.attempts = attempts

      if (!result || typeof result.url !== 'string' || !result.url.trim()) {
        const err: any = new Error('音源未返回有效播放链接')
        err.code = 422
        err.attempts = attempts
        throw err
      }

      if (result.url) {
        if (/^https?:\/\//i.test(result.url)) {
          const checkRedirect = async (u: string, depth = 0): Promise<string> => {
            const safeUrl = await assertSafeRemoteHttpUrl(u)
            if (depth > 3) return safeUrl.toString()
            try {
              const resp = await fetchSafeRemote(safeUrl, {
                method: 'HEAD',
                timeoutMs: 4000,
                maxBytes: 1024,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Referer': safeUrl.origin,
                },
              })
              const location = resp.headers.get('location')
              if ([301, 302, 303, 307, 308].includes(resp.status) && location) {
                let nextUrl = location
                if (!nextUrl.startsWith('http')) {
                  try { nextUrl = new URL(nextUrl, safeUrl).href } catch { }
                }
                return checkRedirect(nextUrl, depth + 1)
              }
              if (resp.status >= 400) {
                console.warn(`[MusicUrl] Redirect check failed with status ${resp.status}, using original URL`)
                return safeUrl.toString()
              }
            } catch (e: any) {
              console.warn(`[MusicUrl] head check failed: ${e.message}`)
            }
            return safeUrl.toString()
          }

          const finalUrl = await checkRedirect(result.url)
          result.url = finalUrl
        } else {
          const err: any = new Error('音源返回了不支持的播放链接')
          err.code = 422
          err.attempts = attempts
          throw err
        }

        result.requestedSource = songInfo.source
        result.downloadSource = fileCache.detectDownloadSource(result.url, songInfo.source)
      }

      return ctx.json(result)
    } catch (err: any) {
      console.error('[MusicUrl] Error:', err.message)
      const status = err.code === 422 ? 422 : 500
      return ctx.fail(status, toUserMessage(err, '解析歌曲失败，请稍后重试'), { attempts: err.attempts })
    }
  })

  // 9. 音质真实文件大小 API
  router.post('/api/music/quality/size', async (ctx) => {
    const verifiedUsername = verifyUserAuth(ctx) || 'open'

    try {
      let { songInfo, quality } = await ctx.bodyJson<{ songInfo?: any; quality?: string }>()
      songInfo = normalizeSongInfo(songInfo)
      if (!songInfo || !songInfo.source || !quality) {
        throw new Error('Invalid quality size request')
      }

      const result = await resolveServerSong(songInfo, quality, verifiedUsername, false)
      const bytes = await getAudioRemoteSize(result.url)
      if (!bytes) throw new Error('无法读取真实文件大小')

      return ctx.json({
        success: true,
        quality,
        bytes,
        size: formatBytes(bytes),
        type: result.quality,
        source: fileCache.detectDownloadSource(result.url, result.downloadSource || result.songInfo?.source),
        sourceName: result.sourceName,
      })
    } catch (err: any) {
      console.error('[QualitySize] Error:', err.message)
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 10. 在线歌词查询 API (POST & GET)
  router.post('/api/music/lyric', async (ctx) => {
    try {
      let { songInfo } = await ctx.bodyJson<{ songInfo?: any }>()
      songInfo = normalizeSongInfo(songInfo)
      if (!songInfo || !songInfo.source) {
        throw new Error('Invalid songInfo')
      }
      const source = songInfo.source
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.getLyric) {
        throw new Error(`Source ${source} not supported`)
      }
      // musicSdk lyric methods return a CancelableRequest. Serializing that
      // wrapper produces `{ promise: {} }` in JSON instead of the lyric body.
      // The GET endpoint already unwraps it; keep the POST contract identical.
      const requestObj = sourceApi.getLyric(songInfo)
      const result = await requestObj.promise
      return ctx.json(result)
    } catch (err: any) {
      console.error(err)
      return ctx.fail(500, toUserMessage(err, '获取数据失败，请稍后重试'))
    }
  })

  router.get('/api/music/lyric', async (ctx) => {
    const source = ctx.query.get('source')
    const rawSongmid = ctx.query.get('songmid') || ctx.query.get('songId') || ctx.query.get('id')

    if (!source || !rawSongmid) {
      return ctx.fail(400, '缺少必要参数：source、songmid')
    }
    if (isRetiredOnlineSource(source)) {
      return ctx.json({ error: new UnsupportedSourceError(source).message, code: 400 }, 400)
    }

    let songmid = String(rawSongmid)
    const sourcePrefix = `${source}_`
    if (songmid.startsWith(sourcePrefix)) {
      songmid = songmid.slice(sourcePrefix.length)
    }

    const verifiedUsername = verifyUserAuth(ctx)
    const lyricUsername = verifiedUsername || '_open'
    const canReadLocalLyricCache = lyricUsername !== '_open' || canReadPublicLocalMusic(ctx, verifiedUsername)

    const localLyricResult = canReadLocalLyricCache
      ? fileCache.checkLyricCache({
        source,
        songmid,
        id: ctx.query.get('songId') || ctx.query.get('id') || songmid,
        name: ctx.query.get('name') || '',
        singer: ctx.query.get('singer') || '',
      }, lyricUsername)
      : { exists: false, content: null }

    if (localLyricResult.exists && localLyricResult.content) {
      return ctx.json({ ...localLyricResult.content, _fromLocalCache: true }, 200, {
        'Cache-Control': 'public, max-age=86400',
      })
    }

    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.getLyric) throw new Error('Source not supported')

      const songInfo = {
        songmid,
        name: ctx.query.get('name') || '',
        singer: ctx.query.get('singer') || '',
        hash: ctx.query.get('hash') || '',
        interval: ctx.query.get('interval') || '',
        copyrightId: ctx.query.get('copyrightId') || '',
        albumId: ctx.query.get('albumId') || '',
        lrcUrl: ctx.query.get('lrcUrl') || '',
        mrcUrl: ctx.query.get('mrcUrl') || '',
        trcUrl: ctx.query.get('trcUrl') || '',
      }

      const requestObj = sourceApi.getLyric(songInfo)
      const lyricInfo = await requestObj.promise

      return ctx.json(lyricInfo, 200, {
        'Cache-Control': 'public, max-age=86400',
      })
    } catch (err: any) {
      console.error('[Lyric] Fetch error:', source, songmid, err.message || err)
      const fallbackResult = canReadLocalLyricCache
        ? fileCache.checkLyricCache({
          source,
          songmid,
          id: ctx.query.get('songId') || ctx.query.get('id') || songmid,
          name: ctx.query.get('name') || '',
          singer: ctx.query.get('singer') || '',
        }, lyricUsername)
        : { exists: false, content: null }

      if (fallbackResult.exists && fallbackResult.content) {
        return ctx.json({ ...fallbackResult.content, _fromLocalCache: true })
      }

      return ctx.fail(500, toUserMessage(err, '获取歌词失败，请稍后重试'))
    }
  })

  // 11. 热搜 API
  router.get('/api/music/hotSearch', async (ctx) => {
    const source = ctx.query.get('source') || 'wy'
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.hotSearch) {
        return ctx.json({ error: '该音源不支持热搜功能' }, 404)
      }
      const result = await sourceApi.hotSearch.getList()
      return ctx.json(result, 200, { 'Cache-Control': 'public, max-age=300' })
    } catch (err: any) {
      console.error('[HotSearch] Error:', err.message)
      return ctx.json([])
    }
  })

  // 12. 歌单分类标签 API
  router.get('/api/music/songList/tags', async (ctx) => {
    const source = ctx.query.get('source') || 'wy'
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.songList?.getTags) {
        throw new Error(`Source ${source} does not support songList`)
      }
      const result = await sourceApi.songList.getTags()
      const sortList = sourceApi.songList.sortList
      return ctx.json({ ...result, sortList })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取歌单标签失败'))
    }
  })

  // 13. 歌单列表 API
  router.get('/api/music/songList/list', async (ctx) => {
    const source = ctx.query.get('source') || 'wy'
    const tagId = ctx.query.get('tagId') || ''
    const sortId = ctx.query.get('sortId') || 'hot'
    const page = boundedInt(ctx.query.get('page'), 1, 1, 1000)
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.songList?.getList) {
        throw new Error(`Source ${source} does not support songList`)
      }
      const result = await sourceApi.songList.getList(sortId, tagId, page)
      return ctx.json(result)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取歌单列表失败'))
    }
  })

  // 14. 歌单详情 API
  router.get('/api/music/songList/detail', async (ctx) => {
    const source = ctx.query.get('source') || 'wy'
    const rawId = ctx.query.get('id')
    const page = boundedInt(ctx.query.get('page'), 1, 1, 1000)
    const limit = boundedInt(ctx.query.get('limit'), 50, 1, 100)
    if (!rawId) return ctx.fail(400, '缺少必要参数：id')
    const id = normalizeSongListId(source, rawId)
    if (!id) return ctx.fail(400, '歌单 ID 或官方歌单链接不合法')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.songList?.getListDetail) {
        throw new Error(`Source ${source} does not support songList`)
      }
      const result = await sourceApi.songList.getListDetail(id, page, limit)
      if (result && result.list) {
        result.list = result.list.map(normalizeSongInfo)
      }
      return ctx.json(result)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取歌单详情失败'))
    }
  })

  // 15. 歌单搜索 API
  router.get('/api/music/songList/search', async (ctx) => {
    const source = ctx.query.get('source') || 'wy'
    const text = ctx.query.get('text')
    const page = boundedInt(ctx.query.get('page'), 1, 1, 1000)
    const limit = boundedInt(ctx.query.get('limit'), 40, 1, 100)
    if (!text) return ctx.fail(400, '缺少必要参数：text')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.songList?.search) {
        throw new Error(`Source ${source} does not support songList`)
      }
      const result = await sourceApi.songList.search(text, page, limit)
      return ctx.json(result)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '搜索歌单失败'))
    }
  })

  // 16. 用户歌单 API
  router.get('/api/music/songList/userPlaylist', async (ctx) => {
    const source = ctx.query.get('source') || 'tx'
    const uid = ctx.query.get('uid')
    const page = boundedInt(ctx.query.get('page'), 1, 1, 1000)
    if (!uid) return ctx.fail(400, '缺少必要参数：uid')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.userPlaylist) {
        throw new Error(`Source ${source} does not support userPlaylist`)
      }
      const result = await sourceApi.userPlaylist.getList(uid, page)
      return ctx.json(result)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取用户歌单失败'))
    }
  })

  // 17. 排行榜列表 API
  router.get('/api/music/leaderboard/boards', async (ctx) => {
    const source = ctx.query.get('source') || 'wy'
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.leaderboard?.getBoards) {
        throw new Error(`Source ${source} does not support leaderboard`)
      }
      const result = await sourceApi.leaderboard.getBoards()
      return ctx.json(result, 200, { 'Cache-Control': 'public, max-age=600' })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取排行榜列表失败'))
    }
  })

  // 18. 排行榜内歌曲列表 API
  router.get('/api/music/leaderboard/list', async (ctx) => {
    const source = ctx.query.get('source') || 'wy'
    const bangid = ctx.query.get('bangid')
    const page = boundedInt(ctx.query.get('page'), 1, 1, 1000)
    const limit = boundedInt(ctx.query.get('limit'), 40, 1, 100)
    if (!bangid) return ctx.fail(400, '缺少必要参数：bangid')
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.leaderboard?.getList) {
        throw new Error(`Source ${source} does not support leaderboard`)
      }
      const result = await sourceApi.leaderboard.getList(bangid, page)
      const allSongs = Array.isArray(result?.list) ? result.list.map(normalizeSongInfo) : []
      const total = Number(result?.total) > 0 ? Number(result.total) : allSongs.length
      // Built-in leaderboard adapters may return the complete board. Normalize
      // the response at the route boundary so the web player only receives one
      // small page and can append the next page on demand.
      const list = allSongs.length > limit
        ? allSongs.slice((page - 1) * limit, page * limit)
        : allSongs
      return ctx.json({ ...result, list, total, page, limit })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取排行榜歌曲失败'))
    }
  })

  // 19. 歌曲评论 API
  router.post('/api/music/comment', async (ctx) => {
    try {
      let { songInfo, type, page, limit } = await ctx.bodyJson<{
        songInfo?: any
        type?: string
        page?: number
        limit?: number
      }>()
      page = boundedInt(String(page ?? ''), 1, 1, 1000)
      limit = boundedInt(String(limit ?? ''), 20, 1, 100)
      songInfo = normalizeSongInfo(songInfo)
      if (!songInfo || !songInfo.source) throw new Error('Invalid songInfo')
      const source = songInfo.source

      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.comment) {
        throw new Error(`Source ${source} not supported for comments`)
      }

      const method = type === 'hot' ? 'getHotComment' : 'getComment'
      if (typeof sourceApi.comment[method] !== 'function') {
        throw new Error(`Method ${method} not supported for source ${source}`)
      }

      const result = await sourceApi.comment[method](songInfo, page, limit)
      return ctx.json(result)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  return router
}
