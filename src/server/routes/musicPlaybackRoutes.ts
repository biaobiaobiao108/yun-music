import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { verifyUserAuth } from './auth'
import { normalizeSongInfo, resolveServerSong } from '../services/musicResolver'
import { isSourceSupported, callUserApiGetMusicUrl } from '../userApi'
import { isRetiredOnlineSource, UnsupportedSourceError } from '@/common/musicSources'
import * as fileCache from '../fileCache'
import { canReadPublicLocalMusic } from '../localMusicAccess'
import { issueDownloadToken } from '../downloadToken'
import { assertSafeRemoteHttpUrl } from '../networkSecurity'
import { formatBytes, getAudioRemoteSize } from '../services/musicAudioProbe'
import { handleMusicProgress, sendMusicProgress } from './musicProgress'
import { MAX_MUSIC_JSON_BODY_BYTES } from './musicRouteShared'

export const createMusicPlaybackRouter = (): Router => {
  const router = new Router()

  // 7. 音乐解析进度 SSE 端点 (无需登录, 用 reqId 区分)
  router.get('/api/music/progress', handleMusicProgress)

  // 8. 音乐播放 URL 解析 API
  router.post('/api/music/url', async ctx => {
    const urlStartedAt = performance.now()
    const verifiedUsername = verifyUserAuth(ctx) || 'open'

    const rawReqId = ctx.headers.get('x-req-id')?.trim() || ''
    const reqId = /^[A-Za-z0-9_-]{8,128}$/.test(rawReqId) ? rawReqId : undefined

    let sseActive = true
    const pushProgress = async (attempt: any, retries = 2): Promise<void> => {
      if (!reqId || !sseActive) return
      if (sendMusicProgress(reqId, attempt)) return
      if (retries > 0) {
        await new Promise(r => setTimeout(r, 100))
        await pushProgress(attempt, retries - 1)
      } else {
        sseActive = false
      }
    }

    try {
      let { songInfo, quality, enableAutoSwitchApiSource } = await ctx.bodyJson<{
        songInfo?: any
        quality?: string
        enableAutoSwitchApiSource?: boolean
      }>(MAX_MUSIC_JSON_BODY_BYTES)

      songInfo = normalizeSongInfo(songInfo)
      if (!songInfo) {
        throw new Error('Invalid songInfo')
      }

      // 优先前置检查服务端本地缓存（命中则直接返回，避免消耗外部第三方音源解析额度）
      const cacheTargetUser = verifiedUsername === 'open' ? '_open' : verifiedUsername
      const cacheStartedAt = performance.now()
      let cacheDurationMs = 0
      if (cacheTargetUser !== '_open' || canReadPublicLocalMusic(ctx)) {
        const cached = fileCache.checkCache(
          { ...songInfo, quality },
          cacheTargetUser,
          false,
          // A durable download is the strongest local source. If it is not
          // present, check the regular server cache before resolving online.
          { preferredFolder: 'music' },
        )
        cacheDurationMs = performance.now() - cacheStartedAt
        if (cached.exists && !cached.isCollision && cached.url) {
          return ctx.json(
            {
              url: cached.url,
              type: cached.quality || quality || '128k',
              quality: cached.quality || quality || '128k',
              sourceName: '本地缓存',
              fromCache: true,
              downloadToken: issueDownloadToken(cached.url),
            },
            200,
            {
              'Server-Timing': `cache;dur=${cacheDurationMs.toFixed(1)}, total;dur=${(performance.now() - urlStartedAt).toFixed(1)}`,
            },
          )
        }
      }

      const resolveStartedAt = performance.now()

      // A legacy saved entry may omit its source but still be identifiable by
      // the server cache metadata. Only require a source when we actually
      // need to fall through to online resolution.
      if (!songInfo.source) throw new Error('Invalid songInfo')

      const source = songInfo.source
      if (isRetiredOnlineSource(source)) throw new UnsupportedSourceError(source)
      let result: any
      let customSourceError: string | null = null
      let attempts: any[] = []

      if (isSourceSupported(source, verifiedUsername)) {
        try {
          console.log(
            `[MusicUrl] Using custom source for: ${source} (ReqId: ${reqId || 'None'}, User: ${verifiedUsername})`,
          )
          const userApiResult = await callUserApiGetMusicUrl(
            source,
            songInfo,
            quality || '128k',
            verifiedUsername,
            attempt => {
              void pushProgress(attempt)
            },
            enableAutoSwitchApiSource !== false,
          )
          result = userApiResult
          attempts = userApiResult.attempts || []
        } catch (userApiError: any) {
          console.error(`[MusicUrl] Custom source failed:`, userApiError.message)
          customSourceError = userApiError.message
          attempts = userApiError.attempts || []
        }
      } else {
        void pushProgress({
          name: '系统',
          status: 'fail',
          message: `未找到支持 ${source} 平台的自定义源，请联系管理员配置或启用对应音源`,
        })
      }

      if (!result) {
        const errMsg = customSourceError || `未找到支持 ${source} 平台的自定义源，请联系管理员配置或启用对应音源`
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
          // The media relay already validates and follows redirects when the
          // browser requests the audio bytes. Do not perform a blocking HEAD
          // request here: many music hosts make HEAD slower or reject it even
          // though the subsequent ranged GET is playable.
          result.url = (await assertSafeRemoteHttpUrl(result.url)).toString()
        } else {
          const err: any = new Error('音源返回了不支持的播放链接')
          err.code = 422
          err.attempts = attempts
          throw err
        }

        result.requestedSource = songInfo.source
        result.downloadSource = fileCache.detectDownloadSource(result.url, songInfo.source)
      }

      // Signed proof that this URL came from this server, required by the
      // /api/music/download relay so it cannot be used as an open proxy.
      if (typeof result.url === 'string' && result.url) result.downloadToken = issueDownloadToken(result.url)

      return ctx.json(result, 200, {
        'Server-Timing': `cache;dur=${cacheDurationMs.toFixed(1)}, resolve;dur=${(performance.now() - resolveStartedAt).toFixed(1)}, total;dur=${(performance.now() - urlStartedAt).toFixed(1)}`,
      })
    } catch (err: any) {
      console.error('[MusicUrl] Error:', err.message)
      const status = err.code === 422 ? 422 : 500
      return ctx.fail(status, toUserMessage(err, '解析歌曲失败，请稍后重试'), { attempts: err.attempts })
    }
  })

  // 9. 音质真实文件大小 API
  router.post('/api/music/quality/size', async ctx => {
    const verifiedUsername = verifyUserAuth(ctx) || 'open'

    try {
      let { songInfo, quality } = await ctx.bodyJson<{ songInfo?: any; quality?: string }>(MAX_MUSIC_JSON_BODY_BYTES)
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

  return router
}
