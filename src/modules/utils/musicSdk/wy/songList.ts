// https://github.com/Binaryify/NeteaseCloudMusicApi/blob/master/module/playlist_catlist.js
// https://github.com/Binaryify/NeteaseCloudMusicApi/blob/master/module/playlist_hot.js
// https://github.com/Binaryify/NeteaseCloudMusicApi/blob/master/module/top_playlist.js
// https://github.com/Binaryify/NeteaseCloudMusicApi/blob/master/module/playlist_detail.js

import { weapi, linuxapi } from './utils/crypto'
import { httpFetch } from '../../request'
import { formatPlayTime, dateFormat, formatPlayCount } from '../../index'
import musicDetailApi from './musicDetail'
import { eapiRequest } from './utils/index'
import { formatSingerName } from '../utils'
import { buildQualitys } from './quality'

export default {
  _requestObj_tags: null as any,
  _requestObj_hotTags: null as any,
  _requestObj_list: null as any,
  limit_list: 30,
  limit_song: 100000,
  successCode: 200,
  cookie: 'MUSIC_U=',
  sortList: [
    {
      name: '最热',
      id: 'hot',
    },
    // {
    //   name: '最新',
    //   id: 'new',
    // },
  ],
  regExps: {
    listDetailLink: /^.+(?:\?|&)id=(\d+)(?:&.*$|#.*$|$)/,
    listDetailLink2: /^.+\/playlist\/(\d+)\/\d+\/.+$/,
  },

  async handleParseId(link: any, retryNum: any= 0): Promise<string> {
    void link
    void retryNum
    throw new Error('Only numeric playlist IDs or recognized playlist links are supported')
  },

  async getListId(id: any) {
    let cookie
    if (/###/.test(id)) {
      const [url, token] = id.split('###')
      id = url
      cookie = `MUSIC_U=${token}`
    }
    if ((/[?&:/]/.test(id))) {
      if (this.regExps.listDetailLink.test(id)) {
        id = id.replace(this.regExps.listDetailLink, '$1')
      } else if (this.regExps.listDetailLink2.test(id)) {
        id = id.replace(this.regExps.listDetailLink2, '$1')
      } else {
        id = await this.handleParseId(id)
      }
      // console.log(id)
    }
    return { id, cookie }
  },
  async getListDetail(rawId: any, page: any = 1, limit: any = 50, tryNum: any = 0): Promise<any> { // 获取歌曲列表内的音乐
    if (tryNum > 2) return Promise.reject(new Error('try max num'))

    const pageNumber = Math.max(1, Number(page) || 1)
    const pageLimit = Math.min(100, Math.max(1, Number(limit) || 50))
    const { id, cookie } = await this.getListId(rawId)
    if (cookie) this.cookie = cookie

    const requestObj_listDetail = httpFetch('https://music.163.com/api/linux/forward', {
      method: 'post',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
        Cookie: this.cookie,
      },
      form: linuxapi({
        method: 'POST',
        url: 'https://music.163.com/api/v3/playlist/detail',
        params: {
          id,
          // 歌曲详情按页加载；trackIds 仍用于获取总数和当前页的 ID。
          n: pageLimit,
          s: 8,
        },
      }),
    })
    const { statusCode, body } = await requestObj_listDetail.promise
    if (statusCode !== 200 || body.code !== this.successCode) return this.getListDetail(id, pageNumber, pageLimit, ++tryNum)

    const trackIds = Array.isArray(body.playlist?.trackIds) ? body.playlist.trackIds : []
    const total = trackIds.length || body.playlist?.tracks?.length || 0
    const rangeStart = (pageNumber - 1) * pageLimit
    const pageIds = trackIds.slice(rangeStart, rangeStart + pageLimit).map((trackId: any) => trackId.id)
    let list: any[] = []

    if (pageIds.length > 0) {
      try {
        list = (await musicDetailApi.getList(pageIds)).list
      } catch (err: any) {
        console.log(err)
        if (err.message === 'try max num') throw err
        return this.getListDetail(id, pageNumber, pageLimit, ++tryNum)
      }
    } else if (trackIds.length === 0 && Array.isArray(body.playlist?.tracks)) {
      // 兼容部分接口只返回 tracks、不返回 trackIds 的响应。
      list = this.filterListDetail(body).slice(rangeStart, rangeStart + pageLimit)
    }

    return {
      list,
      page: pageNumber,
      limit: pageLimit,
      total,
      source: 'wy',
      info: {
        play_count: formatPlayCount(body.playlist.playCount),
        name: body.playlist.name,
        img: body.playlist.coverImgUrl,
        desc: body.playlist.description,
        author: body.playlist.creator.nickname,
      },
    }
  },
  filterListDetail({ playlist: { tracks }, privileges }: any): any[] {
    // console.log(tracks, privileges)
    const list: any[] = []
    tracks.forEach((item: any, index: any) => {
      let privilege = privileges[index]
      if (privilege.id !== item.id) privilege = privileges.find((p: any) => p.id === item.id)
      if (!privilege) return

      const { types, _types } = buildQualitys(item, privilege)

      if (item.pc) {
        list.push({
          singer: item.pc.ar ?? '',
          name: item.pc.sn ?? '',
          albumName: item.pc.alb ?? '',
          albumId: item.al?.id,
          source: 'wy',
          interval: formatPlayTime(item.dt / 1000),
          songmid: item.id,
          img: item.al?.picUrl ?? '',
          lrc: null,
          otherSource: null,
          types,
          _types,
          typeUrl: {},
        })
      } else {
        list.push({
          singer: formatSingerName(item.ar, 'name'),
          name: item.name ?? '',
          albumName: item.al?.name,
          albumId: item.al?.id,
          source: 'wy',
          interval: formatPlayTime(item.dt / 1000),
          songmid: item.id,
          img: item.al?.picUrl,
          lrc: null,
          otherSource: null,
          types,
          _types,
          typeUrl: {},
        })
      }
    })
    return list
  },

  // 获取列表数据
  getList(sortId: any, tagId: any, page: any, tryNum: any= 0) {
    if (tryNum > 2) return Promise.reject(new Error('try max num'))
    if (this._requestObj_list) this._requestObj_list.cancelHttp()
    this._requestObj_list = httpFetch('https://music.163.com/weapi/playlist/list', {
      method: 'post',
      form: weapi({
        cat: tagId || '全部', // 全部,华语,欧美,日语,韩语,粤语,小语种,流行,摇滚,民谣,电子,舞曲,说唱,轻音乐,爵士,乡村,R&B/Soul,古典,民族,英伦,金属,朋克,蓝调,雷鬼,世界音乐,拉丁,另类/独立,New Age,古风,后摇,Bossa Nova,清晨,夜晚,学习,工作,午休,下午茶,地铁,驾车,运动,旅行,散步,酒吧,怀旧,清新,浪漫,性感,伤感,治愈,放松,孤独,感动,兴奋,快乐,安静,思念,影视原声,ACG,儿童,校园,游戏,70后,80后,90后,网络歌曲,KTV,经典,翻唱,吉他,钢琴,器乐,榜单,00后
        order: sortId, // hot,new
        limit: this.limit_list,
        offset: this.limit_list * (page - 1),
        total: true,
      }),
    })
    return this._requestObj_list.promise.then(({ body }: any) => {
      // console.log(body)
      if (body.code !== this.successCode) return this.getList(sortId, tagId, page, ++tryNum)
      return {
        list: this.filterList(body.playlists),
        total: parseInt(body.total),
        page,
        limit: this.limit_list,
        source: 'wy',
      }
    })
  },
  filterList(rawData: any) {
    // console.log(rawData)
    return rawData.map((item: any) => ({
      play_count: formatPlayCount(item.playCount),
      id: String(item.id),
      author: item.creator.nickname,
      name: item.name,
      time: item.createTime ? dateFormat(item.createTime, 'Y-M-D') : '',
      img: item.coverImgUrl,
      grade: item.grade,
      total: item.trackCount,
      desc: item.description,
      source: 'wy',
    }))
  },

  // 获取标签
  getTag(tryNum: any= 0) {
    if (this._requestObj_tags) this._requestObj_tags.cancelHttp()
    this._requestObj_tags = httpFetch('https://music.163.com/weapi/playlist/catalogue', {
      method: 'post',
      form: weapi({}),
    })
    return this._requestObj_tags.promise.then(({ body }: any) => {
      // console.log(JSON.stringify(body))
      if (body.code !== this.successCode) return this.getTag(++tryNum)
      return this.filterTagInfo(body)
    })
  },
  filterTagInfo({ sub, categories }: any) {
    const subList: Record<string, any> = {}
    for (const item of sub) {
      if (!subList[item.category]) subList[item.category] = []
      subList[item.category].push({
        parent_id: categories[item.category],
        parent_name: categories[item.category],
        id: item.name,
        name: item.name,
        source: 'wy',
      })
    }

    const list: any[] = []
    for (const key of Object.keys(categories)) {
      list.push({
        name: categories[key],
        list: subList[key],
        source: 'wy',
      })
    }
    return list
  },

  // 获取热门标签
  getHotTag(tryNum: any= 0) {
    if (this._requestObj_hotTags) this._requestObj_hotTags.cancelHttp()
    if (tryNum > 2) return Promise.reject(new Error('try max num'))
    this._requestObj_hotTags = httpFetch('https://music.163.com/weapi/playlist/hottags', {
      method: 'post',
      form: weapi({}),
    })
    return this._requestObj_hotTags.promise.then(({ body }: any) => {
      // console.log(JSON.stringify(body))
      if (body.code !== this.successCode) return this.getTag(++tryNum)
      return this.filterHotTagInfo(body.tags)
    })
  },
  filterHotTagInfo(rawList: any) {
    return rawList.map((item: any) => ({
      id: item.playlistTag.name,
      name: item.playlistTag.name,
      source: 'wy',
    }))
  },

  getTags() {
    return Promise.all([this.getTag(), this.getHotTag()]).then(([tags, hotTag]: any) => ({ tags, hotTag, source: 'wy' }))
  },

  async getDetailPageUrl(rawId: any) {
    const { id } = await this.getListId(rawId)
    return `https://music.163.com/#/playlist?id=${id}`
  },

  search(text: any, page: any, limit: any= 20) {
    return eapiRequest('/api/cloudsearch/pc', {
      s: text,
      type: 1000, // 1: 单曲, 10: 专辑, 100: 歌手, 1000: 歌单, 1002: 用户, 1004: MV, 1006: 歌词, 1009: 电台, 1014: 视频
      limit,
      total: page == 1,
      offset: limit * (page - 1),
    })
      .promise.then(({ body }: any) => {
        if (body.code != this.successCode) throw new Error('filed')
        // console.log(body)
        return {
          list: this.filterList(body.result.playlists),
          limit,
          total: body.result.playlistCount,
          source: 'wy',
        }
      })
  },
}

// getList
// getTags
// getListDetail
