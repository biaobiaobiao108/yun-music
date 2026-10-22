import { isBuiltinOnlineSource, type BuiltinOnlineSource } from '@/common/musicSources'
import tx from './tx/index'
import wy from './wy/index'
import { supportQuality } from './api-source'
import type { MusicPlatform, MusicSdk, MusicSearchResult, MusicSong } from './types'

export { dateFormat, dateFormat2, decodeName, sizeFormate, formatPlayTime, formatPlayCount } from '../index'
export * from './types'

const sources: Pick<MusicSdk, 'sources' | 'tx' | 'wy'> = {
  sources: [
    { name: 'QQ音乐', id: 'tx' },
    { name: '网易音乐', id: 'wy' },
  ],
  tx,
  wy,
}

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : String(value ?? ''))

const getIntervalSeconds = (interval: string | null | undefined): number => {
  if (!interval) return 0
  return interval.split(':').reduce((total, part) => total * 60 + (Number.parseInt(part, 10) || 0), 0)
}

const filterText = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[\s'.,，&"、()（）`~\-<>|/\][!！]/g, '')

const sourceSdk = (source: BuiltinOnlineSource) => sources[source]

/** 获取内置音源；自定义 userApi 音源不会进入这个注册表。 */
export const getBuiltinSource = (source: string): MusicPlatform | undefined =>
  isBuiltinOnlineSource(source) ? sourceSdk(source) : undefined

const musicSdk: MusicSdk = {
  ...sources,
  init: async () => {
    const tasks = sources.sources
      .map(({ id }) => sourceSdk(id).init?.())
      .filter((task): task is Promise<unknown> => Boolean(task))
    return Promise.all(tasks)
  },
  supportQuality,

  async searchMusic({ name, singer, source: excludedSource, limit = 25, page = 1 }): Promise<MusicSearchResult[]> {
    const keyword = `${trimString(name)} ${trimString(singer)}`.trim()
    const tasks = sources.sources
      .filter(({ id }) => id !== excludedSource)
      .map(async ({ id }) => {
        const search = sourceSdk(id).musicSearch?.search
        if (!search) return null
        try {
          return await search(keyword, page, limit)
        } catch (error: unknown) {
          console.error(`[MusicSdk] Search error in ${id}:`, error)
          return null
        }
      })
    return (await Promise.all(tasks)).filter((result): result is MusicSearchResult => result !== null)
  },

  async findMusic({
    name,
    singer = '',
    albumName = '',
    interval = null,
    source: excludedSource,
  }): Promise<MusicSong[]> {
    const lists = await musicSdk.searchMusic({ name, singer, source: excludedSource, limit: 25 })
    const singersRxp = /、|&|;|；|\/|,|，|\|/
    const sortSingle = (value: string) =>
      singersRxp.test(value)
        ? value
            .split(singersRxp)
            .sort((a, b) => a.localeCompare(b))
            .join('、')
        : value
    const sortMusic = (items: MusicSong[], callback: (item: MusicSong) => boolean): MusicSong[] => {
      const tempResult: MusicSong[] = []
      for (let index = items.length - 1; index > -1; index--) {
        const item = items[index]
        if (!item) continue
        if (callback(item)) {
          delete item.fSinger
          delete item.fMusicName
          delete item.fAlbumName
          delete item.fInterval
          tempResult.push(item)
          items.splice(index, 1)
        }
      }
      tempResult.reverse()
      return tempResult
    }
    const getIntv = (value: unknown) => getIntervalSeconds(typeof value === 'string' ? value : null)
    const fMusicName = filterText(name)
    const fSinger = filterText(sortSingle(singer))
    const fAlbumName = filterText(albumName)
    const fInterval = getIntv(interval)
    const isEqualsInterval = (intv: number) => Math.abs((fInterval || intv) - (intv || fInterval)) < 5
    const isIncludesName = (value: string) => fMusicName.includes(value) || value.includes(fMusicName)
    const isIncludesSinger = (value: string) => !fSinger || fSinger.includes(value) || value.includes(fSinger)
    const isEqualsAlbum = (value: string) => !fAlbumName || fAlbumName === value

    const result = lists
      .map(source => {
        for (const item of source.list) {
          item.name = trimString(item.name)
          item.singer = trimString(item.singer)
          item.fSinger = filterText(sortSingle(item.singer))
          item.fMusicName = filterText(item.name)
          item.fAlbumName = filterText(item.albumName)
          item.fInterval = getIntv(item.interval)
          if (!isEqualsInterval(item.fInterval)) {
            item.name = null
            continue
          }
          if (item.fMusicName === fMusicName && isIncludesSinger(item.fSinger)) return item
        }
        for (const item of source.list) {
          if (item.name == null) continue
          if (item.fSinger === fSinger && isIncludesName(item.fMusicName ?? '')) return item
        }
        for (const item of source.list) {
          if (item.name == null) continue
          if (
            isEqualsAlbum(item.fAlbumName ?? '') &&
            isIncludesSinger(item.fSinger ?? '') &&
            isIncludesName(item.fMusicName ?? '')
          )
            return item
        }
        return null
      })
      .filter((item): item is MusicSong => item !== null)

    const newResult: MusicSong[] = []
    newResult.push(
      ...sortMusic(
        result,
        item => item.fSinger === fSinger && item.fMusicName === fMusicName && item.interval === interval,
      ),
    )
    newResult.push(
      ...sortMusic(
        result,
        item => item.fMusicName === fMusicName && item.fSinger === fSinger && item.fAlbumName === fAlbumName,
      ),
    )
    newResult.push(...sortMusic(result, item => item.fSinger === fSinger && item.fMusicName === fMusicName))
    newResult.push(...sortMusic(result, item => item.fMusicName === fMusicName && item.interval === interval))
    newResult.push(...sortMusic(result, item => item.fSinger === fSinger && item.interval === interval))
    newResult.push(...sortMusic(result, item => item.fInterval === fInterval))
    newResult.push(...sortMusic(result, item => item.fMusicName === fMusicName))
    newResult.push(...sortMusic(result, item => item.fSinger === fSinger))
    newResult.push(...sortMusic(result, item => item.fAlbumName === fAlbumName))
    for (const item of result) {
      delete item.fSinger
      delete item.fMusicName
      delete item.fAlbumName
      delete item.fInterval
    }
    newResult.push(...result)
    return newResult
  },
}

export default musicSdk
