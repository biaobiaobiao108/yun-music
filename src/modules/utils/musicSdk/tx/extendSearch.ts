import { httpFetch } from '../../request'

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

const createSearchFetch = (str: any, searchType: any, resultNum: any, pageNum: any, signal?: AbortSignal) => {
  return httpFetch(MUSICU_URL, {
    method: 'post',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
      'Content-Type': 'application/json;charset=utf-8',
    },
    body: {
      comm: { ct: '19', cv: '1859', uin: '0' },
      req: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: {
          grp: 1,
          num_per_page: resultNum,
          page_num: pageNum,
          query: str,
          search_type: searchType,
        },
      },
    },
    signal,
  })
}

async function search(str: string, type: number, page: number, limit: number, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted()
    const { body } = await createSearchFetch(str, type, limit, page, signal).promise
    if (body?.code !== 0) throw new Error(`QQ 音乐搜索失败 (${body?.code ?? 'invalid response'})`)
    if (body.req?.code === 2001) continue
    if (body.req?.code !== 0) throw new Error(`QQ 音乐搜索失败 (${body.req?.code ?? 'invalid response'})`)
    const data = body.req.data
    if (!data?.body) throw new Error('QQ 音乐搜索返回了无效数据')
    return data
  }
  throw new Error('QQ 音乐暂时限制了搜索请求，请稍后重试')
}

export default {
  /**
   * 搜索歌手
   * @param {string} str 搜索关键词
   * @param {number} page 页码
   * @param {number} limit 每页数量
   */
  searchSinger(str: any, page: any = 1, limit: any = 20, signal?: AbortSignal) {
    return search(str, 1, page, limit, signal).then(data => {
      const singerData = data.body.singer
      const rawList = (singerData && singerData.list) || []
      const list = this.handleSingerResult(rawList)
      return {
        list,
        total: data.meta?.sum ?? list.length,
        allPage: Math.ceil((data.meta?.sum ?? list.length) / limit),
        limit,
        source: 'tx',
      }
    })
  },

  /**
   * 搜索专辑
   * @param {string} str 搜索关键词
   * @param {number} page 页码
   * @param {number} limit 每页数量
   */
  searchAlbum(str: any, page: any = 1, limit: any = 20, signal?: AbortSignal) {
    return search(str, 2, page, limit, signal).then(data => {
      const albumData = data.body.album
      const rawList = (albumData && albumData.list) || []
      const list = this.handleAlbumResult(rawList)
      return {
        list,
        total: data.meta?.sum ?? list.length,
        allPage: Math.ceil((data.meta?.sum ?? list.length) / limit),
        limit,
        source: 'tx',
      }
    })
  },

  /**
   * 格式化歌手搜索结果
   * @param {Array} rawList
   */
  handleSingerResult(rawList: any) {
    if (!rawList || !rawList.length) return []
    return rawList.map((item: any) => {
      const mid = item.singerMID || item.mid || ''
      return {
        id: mid,
        mid,
        name: item.singerName || item.name || '',
        picUrl: mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : '',
        albumSize: item.albumNum || 0,
        source: 'tx',
      }
    })
  },

  /**
   * 格式化专辑搜索结果
   * @param {Array} rawList
   */
  handleAlbumResult(rawList: any) {
    if (!rawList || !rawList.length) return []
    return rawList.map((item: any) => {
      const mid = item.albumMID || item.mid || ''
      const singerName = item.singerName || (item.singer && item.singer[0] && item.singer[0].name) || ''
      const singerId = item.singerMID || item.singer_list?.[0]?.mid || item.singer?.[0]?.mid || ''
      return {
        id: mid,
        mid,
        name: item.albumName || item.name || '',
        picUrl: mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : '',
        artistName: singerName,
        artistId: singerId,
        size: item.song_count || item.songNum || 0,
        publishTime: item.publicTime || item.pubTime || '',
        source: 'tx',
      }
    })
  },
}
