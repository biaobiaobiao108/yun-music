import { formatPlayTime } from '../../index'
import { formatSingerName } from '../utils'
import { eapiRequest } from './utils/index'
import { buildQualitys } from './quality'

export default {
  limit: 30,
  musicSearch(str: any, page: any, limit: any, signal?: AbortSignal): Promise<any> {
    // const searchRequest = eapiRequest('/api/cloudsearch/pc', {
    //   s: str,
    //   type: 1, // 1: 单曲, 10: 专辑, 100: 歌手, 1000: 歌单, 1002: 用户, 1004: MV, 1006: 歌词, 1009: 电台, 1014: 视频
    //   limit,
    //   total: page == 1,
    //   offset: limit * (page - 1),
    // })
    const searchRequest = eapiRequest(
      '/api/search/song/list/page',
      {
        keyword: str,
        needCorrect: '1',
        channel: 'typing',
        offset: limit * (page - 1),
        scene: 'normal',
        total: page == 1,
        limit,
      },
      signal,
    )
    return searchRequest.promise.then(({ body }: any) => body)
  },
  handleResult(rawList: any) {
    if (!Array.isArray(rawList)) return []
    const list: any[] = []
    for (const rawItem of rawList) {
      const item = rawItem?.baseInfo?.simpleSongData
      if (!item) continue
      const { types, _types } = buildQualitys(item, item.privilege)

      list.push({
        singer: formatSingerName(item.ar, 'name'),
        name: item.name,
        albumName: item.al?.name || '',
        albumId: item.al?.id || '',
        source: 'wy',
        interval: formatPlayTime((item.dt || 0) / 1000),
        songmid: item.id,
        img: item.al?.picUrl || '',
        lrc: null,
        types,
        _types,
        typeUrl: {},
      })
    }
    return list
  },
  search(str: any, page: any = 1, limit: any, signal?: AbortSignal, retryNum: any = 0): Promise<any> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    if (++retryNum > 3) return Promise.reject(new Error('try max num'))
    const effectiveLimit = limit ?? this.limit
    return this.musicSearch(str, page, effectiveLimit, signal).then((result: any) => {
      if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
      if (!result || result.code !== 200 || !result.data) {
        return this.search(str, page, effectiveLimit, signal, retryNum)
      }
      const list = this.handleResult(result.data.resources || [])
      const total = result.data.totalCount || 0
      const allPage = Math.ceil(total / effectiveLimit)

      return {
        list,
        allPage,
        limit: effectiveLimit,
        total,
        source: 'wy',
      }
    })
  },
}
