import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { normalizeSongInfo } from '../services/musicResolver'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { boundedInt, normalizeSongListId, MAX_MUSIC_JSON_BODY_BYTES } from './musicRouteShared'

export const createMusicCatalogRouter = (): Router => {
  const router = new Router()

  // 11. 热搜 API
  router.get('/api/music/hotSearch', async ctx => {
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
  router.get('/api/music/songList/tags', async ctx => {
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
  router.get('/api/music/songList/list', async ctx => {
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
  router.get('/api/music/songList/detail', async ctx => {
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
  router.get('/api/music/songList/search', async ctx => {
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
      const result = await sourceApi.songList.search(text, page, limit, ctx.request.signal)
      return ctx.json(result)
    } catch (err: any) {
      if (ctx.request.signal.aborted) return new Response(null, { status: 499 })
      return ctx.fail(500, toUserMessage(err, '搜索歌单失败'))
    }
  })

  // 16. 用户歌单 API
  router.get('/api/music/songList/userPlaylist', async ctx => {
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
  router.get('/api/music/leaderboard/boards', async ctx => {
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
  router.get('/api/music/leaderboard/list', async ctx => {
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
      const list = allSongs.length > limit ? allSongs.slice((page - 1) * limit, page * limit) : allSongs
      return ctx.json({ ...result, list, total, page, limit })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '获取排行榜歌曲失败'))
    }
  })

  // 19. 歌曲评论 API
  router.post('/api/music/comment', async ctx => {
    try {
      let { songInfo, type, page, limit } = await ctx.bodyJson<{
        songInfo?: any
        type?: string
        page?: number
        limit?: number
      }>(MAX_MUSIC_JSON_BODY_BYTES)
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
