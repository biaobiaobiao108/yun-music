import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { verifyUserAuth } from './auth'
import { normalizeSongInfo } from '../services/musicResolver'
import { isRetiredOnlineSource, UnsupportedSourceError } from '@/common/musicSources'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import * as fileCache from '../fileCache'
import { canReadPublicLocalMusic } from '../localMusicAccess'
import { MAX_MUSIC_JSON_BODY_BYTES } from './musicRouteShared'

export const createMusicLyricRouter = (): Router => {
  const router = new Router()

  // 10. 在线歌词查询 API (POST & GET)
  router.post('/api/music/lyric', async ctx => {
    try {
      let { songInfo } = await ctx.bodyJson<{ songInfo?: any }>(MAX_MUSIC_JSON_BODY_BYTES)
      songInfo = normalizeSongInfo(songInfo)
      if (!songInfo) {
        throw new Error('Invalid songInfo')
      }

      const verifiedUsername = verifyUserAuth(ctx)
      const lyricUsername = verifiedUsername || '_open'
      const canReadLocalLyricCache = lyricUsername !== '_open' || canReadPublicLocalMusic(ctx, verifiedUsername)
      const lyricCacheControl = lyricUsername === '_open' ? 'public, max-age=86400' : 'private, no-store'

      if (canReadLocalLyricCache) {
        const localLyricResult = await fileCache.checkLyricCache(songInfo, lyricUsername)
        if (localLyricResult.exists && localLyricResult.content) {
          return ctx.json({ ...localLyricResult.content, _fromLocalCache: true }, 200, {
            'Cache-Control': lyricCacheControl,
          })
        }
      }

      const source = songInfo.source
      if (!source || isRetiredOnlineSource(source)) {
        if (canReadLocalLyricCache) {
          const fallback = await fileCache.checkLyricCache(songInfo, lyricUsername)
          if (fallback.exists && fallback.content) {
            return ctx.json({ ...fallback.content, _fromLocalCache: true }, 200, {
              'Cache-Control': lyricCacheControl,
            })
          }
        }
        throw new Error(source ? `Source ${source} not supported` : 'Invalid songInfo')
      }

      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.getLyric) {
        if (canReadLocalLyricCache) {
          const fallback = await fileCache.checkLyricCache(songInfo, lyricUsername)
          if (fallback.exists && fallback.content) {
            return ctx.json({ ...fallback.content, _fromLocalCache: true }, 200, {
              'Cache-Control': lyricCacheControl,
            })
          }
        }
        throw new Error(`Source ${source} not supported`)
      }
      try {
        const requestObj = sourceApi.getLyric(songInfo)
        const result = await requestObj.promise
        return ctx.json(result, 200, {
          'Cache-Control': lyricCacheControl,
        })
      } catch (upstreamErr: any) {
        if (canReadLocalLyricCache) {
          const fallback = await fileCache.checkLyricCache(songInfo, lyricUsername)
          if (fallback.exists && fallback.content) {
            return ctx.json({ ...fallback.content, _fromLocalCache: true }, 200, {
              'Cache-Control': lyricCacheControl,
            })
          }
        }
        throw upstreamErr
      }
    } catch (err: any) {
      console.error('[Lyric] Fetch error (POST):', err?.message || err)
      return ctx.fail(500, toUserMessage(err, '获取数据失败，请稍后重试'))
    }
  })

  router.get('/api/music/lyric', async ctx => {
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
    const lyricCacheControl = lyricUsername === '_open' ? 'public, max-age=86400' : 'private, no-store'

    const localLyricResult = canReadLocalLyricCache
      ? await fileCache.checkLyricCache(
          {
            source,
            songmid,
            id: ctx.query.get('songId') || ctx.query.get('id') || songmid,
            name: ctx.query.get('name') || '',
            singer: ctx.query.get('singer') || '',
          },
          lyricUsername,
        )
      : { exists: false, content: null }

    if (localLyricResult.exists && localLyricResult.content) {
      return ctx.json({ ...localLyricResult.content, _fromLocalCache: true }, 200, {
        'Cache-Control': lyricCacheControl,
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
        'Cache-Control': lyricCacheControl,
      })
    } catch (err: any) {
      console.error('[Lyric] Fetch error:', source, songmid, err.message || err)
      const fallbackResult = canReadLocalLyricCache
        ? await fileCache.checkLyricCache(
            {
              source,
              songmid,
              id: ctx.query.get('songId') || ctx.query.get('id') || songmid,
              name: ctx.query.get('name') || '',
              singer: ctx.query.get('singer') || '',
            },
            lyricUsername,
          )
        : { exists: false, content: null }

      if (fallbackResult.exists && fallbackResult.content) {
        return ctx.json({ ...fallbackResult.content, _fromLocalCache: true }, 200, {
          'Cache-Control': lyricCacheControl,
        })
      }

      return ctx.fail(500, toUserMessage(err, '获取歌词失败，请稍后重试'))
    }
  })

  return router
}
