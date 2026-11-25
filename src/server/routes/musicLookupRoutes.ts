import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { boundedInt } from './musicRouteShared'

export const createMusicLookupRouter = (): Router => {
  const router = new Router()

  // 1. 音乐搜索 API
  router.get('/api/music/search', async ctx => {
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

        const firstSearch = await sourceApi.musicSearch!.search(
          name,
          firstUpstreamPage,
          UPSTREAM_PAGE_SIZE,
          ctx.request.signal,
        )
        const firstList: any[] = firstSearch.list || []
        allSongs = allSongs.concat(firstList)
        if (firstList.length >= UPSTREAM_PAGE_SIZE && allSongs.length < offsetInFirstPage + limit) {
          const remainingPages = Math.min(maxPages - 1, pagesNeeded - 1, 4)
          const pageResults = await Promise.all(
            Array.from({ length: remainingPages }, (_, offset) =>
              sourceApi.musicSearch!.search(
                name,
                firstUpstreamPage + offset + 1,
                UPSTREAM_PAGE_SIZE,
                ctx.request.signal,
              ),
            ),
          )
          for (const searchData of pageResults) {
            const pageList: any[] = searchData.list || []
            allSongs = allSongs.concat(pageList)
            if (pageList.length < UPSTREAM_PAGE_SIZE || allSongs.length >= offsetInFirstPage + limit) break
          }
        }
        result = allSongs.slice(offsetInFirstPage, offsetInFirstPage + limit)
      } else if (type === 'singer') {
        if (!sourceApi.extendSearch?.searchSinger) {
          throw new Error(`Source ${source} does not support singer search`)
        }
        const searchData = await sourceApi.extendSearch.searchSinger(name, page, limit, ctx.request.signal)
        result = searchData.list || []
      } else if (type === 'album') {
        if (!sourceApi.extendSearch?.searchAlbum) {
          throw new Error(`Source ${source} does not support album search`)
        }
        const searchData = await sourceApi.extendSearch.searchAlbum(name, page, limit, ctx.request.signal)
        result = searchData.list || []
      } else if (type === 'playlist') {
        if (!sourceApi.extendSearch?.searchPlaylist) {
          throw new Error(`Source ${source} does not support playlist search`)
        }
        const searchData = await sourceApi.extendSearch.searchPlaylist(name, page, limit, ctx.request.signal)
        result = searchData.list || []
      } else {
        throw new Error(`Invalid search type: ${type}`)
      }

      return ctx.json(result)
    } catch (err: any) {
      if (ctx.request.signal.aborted) return new Response(null, { status: 499 })
      console.error(err)
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 2. 搜索提示 (TipSearch) API
  router.get('/api/music/tipSearch', async ctx => {
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
  router.get('/api/music/artistDetail', async ctx => {
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
  router.get('/api/music/artistAlbums', async ctx => {
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
  router.get('/api/music/artistSongs', async ctx => {
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
      const MAX_PAGES =
        Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
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
  router.get('/api/music/albumSongs', async ctx => {
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

  return router
}
