import leaderboard from './leaderboard'
import { apis } from '../api-source'
import getLyric from './lyric'
import getMusicInfo from './musicInfo'
import musicSearch from './musicSearch'
import extendSearch from './extendSearch'
import extendDetail from './extendDetail'
import songList from './songList'
import hotSearch from './hotSearch'
import comment from './comment'
import tipSearch from './tipSearch'
import type { MusicSong, MusicPlatform } from '../types'

const wy: MusicPlatform = {
  tipSearch,
  leaderboard,
  musicSearch,
  extendSearch,
  extendDetail,
  songList,
  hotSearch,
  comment,
  getMusicUrl(songInfo: MusicSong, type: string) {
    return apis('wy').getMusicUrl(songInfo, type)
  },
  getLyric(songInfo: MusicSong) {
    return getLyric(songInfo.songmid)
  },
  getPic(songInfo: MusicSong) {
    const requestObj = getMusicInfo(songInfo.songmid)
    return requestObj.promise.then((info: any) => info?.al?.picUrl || null)
  },
  getMusicDetailPageUrl(songInfo: MusicSong) {
    return `https://music.163.com/#/song?id=${songInfo.songmid}`
  },
}

export default wy
