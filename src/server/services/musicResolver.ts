import { isRetiredOnlineSource, UnsupportedSourceError } from '@/common/musicSources'
import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { isSourceSupported, callUserApiGetMusicUrl } from '../userApi'
import { getDownloadQualityCandidates } from '../downloadQuality'
import * as fileCache from '../fileCache'
import { NativeLruCache } from '@/utils/nativeLru'

export interface ServerSongResolveResult {
  url: string
  quality: string
  songInfo: any
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
}

/**
 * 规范化歌曲信息，确保收藏列表中的 meta 属性在根节点也可用
 */
export const normalizeSongInfo = (songInfo: any) => {
  if (!songInfo) return songInfo
  const meta = songInfo.meta || {}

  // 1. 处理音质信息 (types / _types)
  if (!songInfo.types && meta) {
    songInfo.types = meta.qualitys || meta.types
  }
  if (!songInfo._types && meta) {
    songInfo._types = meta._qualitys || meta._types
  }

  // 2. 处理基础字段备用根节点映射
  if (!songInfo.albumName && meta.albumName) songInfo.albumName = meta.albumName
  if (!songInfo.albumId && meta.albumId) songInfo.albumId = meta.albumId
  if (!songInfo.img && meta.picUrl) songInfo.img = meta.picUrl
  if (!songInfo.name && meta.name) songInfo.name = meta.name
  if (!songInfo.singer && meta.singer) songInfo.singer = meta.singer
  if (!songInfo.source && meta.source) songInfo.source = meta.source
  if (!songInfo.interval && meta.interval) songInfo.interval = meta.interval

  // 3. 处理通用 ID 转换 (id -> songmid)
  if (!songInfo.songmid) {
    if (meta.songId) {
      songInfo.songmid = meta.songId
    } else if (songInfo.id) {
      const sourcePrefix = `${songInfo.source}_`
      if (typeof songInfo.id === 'string' && songInfo.id.startsWith(sourcePrefix)) {
        songInfo.songmid = songInfo.id.slice(sourcePrefix.length)
      } else {
        songInfo.songmid = songInfo.id
      }
    }
  }

  // 4. 针对各平台 SDK 所需的特定字段进行补全
  switch (songInfo.source) {
    case 'wy': // 网易
      if (!songInfo.id && meta.songId) songInfo.id = Number(meta.songId)
      if (!songInfo.songmid && songInfo.id) songInfo.songmid = String(songInfo.id)
      break

    case 'tx': // 腾讯
      if (!songInfo.strMediaMid && meta.strMediaMid) songInfo.strMediaMid = meta.strMediaMid
      if (!songInfo.albumMid && meta.albumMid) songInfo.albumMid = meta.albumMid
      const metaSongId = String(meta.songId || '')
      if (/^\d+$/.test(metaSongId)) {
        songInfo.songId = metaSongId
      }
      break

  }

  return songInfo
}

const AUTO_SOURCE_ORDER = ['wy', 'tx'] as const
const SOURCE_MATCH_CACHE_TTL = 60_000
const sourceMatchCache = new NativeLruCache<string, Promise<any[]>>({
  max: 512,
  ttl: SOURCE_MATCH_CACHE_TTL,
})

export const clearServerSourceMatchCache = (username?: string) => {
  if (!username) {
    sourceMatchCache.clear()
    return
  }
  for (const key of sourceMatchCache.keys()) {
    if (key.startsWith(`${username}:`)) sourceMatchCache.delete(key)
  }
}

export const normalizeSongMatchText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[（(\[].*?[）)\]]/g, '')
  .replace(/[\s\p{P}\p{S}]/gu, '')

export const normalizeSongNameText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, '')

export const splitSingerNames = (value: unknown) => String(value || '')
  .toLowerCase()
  .split(/[、，,&；;|/+]/)
  .map(normalizeSongMatchText)
  .filter(Boolean)

export const isSingerMatch = (candidateSinger: unknown, targetSinger: unknown) => {
  const candidateText = normalizeSongMatchText(candidateSinger)
  const targetText = normalizeSongMatchText(targetSinger)
  if (!targetText) return true
  if (!candidateText) return false
  if (candidateText.includes(targetText) || targetText.includes(candidateText)) return true

  const candidateParts = splitSingerNames(candidateSinger)
  const targetParts = splitSingerNames(targetSinger)
  return candidateParts.some(candidatePart => targetParts.some(targetPart => (
    candidatePart.includes(targetPart) || targetPart.includes(candidatePart)
  )))
}

export const getSongDurationSeconds = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10000 ? Math.round(value / 1000) : Math.round(value)
  }

  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const parsed = Number(text)
    return parsed > 10000 ? Math.round(parsed / 1000) : Math.round(parsed)
  }

  const parts = text.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part))) return 0
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  return 0
}

export const getSongMatchScore = (candidate: any, target: any) => {
  const candidateName = normalizeSongNameText(candidate?.name)
  const targetName = normalizeSongNameText(target?.name)
  if (!candidateName || !targetName) return -1
  if (!candidateName.includes(targetName) && !targetName.includes(candidateName)) return -1
  if (!isSingerMatch(candidate?.singer, target?.singer)) return -1

  const candidateDuration = getSongDurationSeconds(candidate?.interval)
  const targetDuration = getSongDurationSeconds(target?.interval)
  let durationScore = 0
  if (candidateDuration > 0 && targetDuration > 0) {
    const durationDiff = Math.abs(candidateDuration - targetDuration)
    if (durationDiff > 8) return -1
    durationScore = 8 - durationDiff
  }

  const nameScore = candidateName === targetName ? 20 : 10
  const candidateAlbum = normalizeSongMatchText(candidate?.albumName)
  const targetAlbum = normalizeSongMatchText(target?.albumName)
  const albumScore = candidateAlbum && targetAlbum && candidateAlbum === targetAlbum ? 3 : 0
  return nameScore + durationScore + albumScore
}

export const findServerSourceMatches = async (songInfo: any, username: string) => {
  if (!songInfo?.name || !songInfo?.singer) return []

  const cacheKey = [
    username,
    songInfo.source,
    normalizeSongMatchText(songInfo.name),
    normalizeSongMatchText(songInfo.singer),
    getSongDurationSeconds(songInfo.interval),
  ].join(':')
  const cached = sourceMatchCache.get(cacheKey)
  if (cached) return cached

  const searchSources = AUTO_SOURCE_ORDER.filter(source => (
    source !== songInfo.source && isSourceSupported(source, username) && getBuiltinSource(source)?.musicSearch?.search
  ))
  const query = `${songInfo.name} ${songInfo.singer}`
  const promise = Promise.all(searchSources.map(async source => {
    try {
      const sourceApi = getBuiltinSource(source)
      if (!sourceApi?.musicSearch?.search) return []
      const searchData = await sourceApi.musicSearch.search(query, 1, 20)
      const list = Array.isArray(searchData?.list) ? searchData.list : []
      return list.map((item: any) => ({ ...item, source }))
    } catch (err: any) {
      console.warn(`[ServerAutoSource] Search failed for ${source}: ${err?.message || err}`)
      return []
    }
  })).then(resultGroups => resultGroups.flat()
    .map(candidate => ({ candidate, score: getSongMatchScore(candidate, songInfo) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.candidate))
  const trackedPromise = promise.catch(error => {
    sourceMatchCache.delete(cacheKey)
    throw error
  })

  sourceMatchCache.set(cacheKey, trackedPromise)
  return trackedPromise
}

/**
 * 服务端全能音乐解析：支持自定义源解析、官方源降级、音质阶梯降级与跨源搜索补全
 */
export const resolveServerSong = async (
  rawSongInfo: any,
  requestedQuality: string,
  username: string,
  allowQualityFallback: boolean,
): Promise<ServerSongResolveResult> => {
  const originalSong = normalizeSongInfo({ ...rawSongInfo })
  if (!originalSong?.source) throw new Error('Missing song source')
  if (isRetiredOnlineSource(originalSong.source)) {
    throw new UnsupportedSourceError(originalSong.source)
  }

  const qualities = allowQualityFallback
    ? getDownloadQualityCandidates(requestedQuality)
    : [requestedQuality]
  const errors: string[] = []

  const tryCandidates = async (quality: string, rawCandidates: any[]) => {
    for (const rawCandidate of rawCandidates) {
      const candidate = normalizeSongInfo({ ...rawCandidate })
      const source = candidate?.source
      if (!source || !isSourceSupported(source, username)) continue

      try {
        const result = await callUserApiGetMusicUrl(source, candidate, quality, username, undefined, true)
        if (!result?.url) throw new Error('audio source returned no URL')
        return {
          url: result.url,
          quality: result.type || quality,
          songInfo: candidate,
          requestedSource: originalSong.source,
          downloadSource: fileCache.detectDownloadSource(result.url, source),
          sourceName: result.sourceName,
        }
      } catch (err: any) {
        errors.push(`${source}/${quality}: ${err?.message || 'resolve failed'}`)
      }
    }
    return null
  }

  const originalResult = await tryCandidates(requestedQuality, [originalSong])
  if (originalResult) return originalResult

  const matches = await findServerSourceMatches(originalSong, username)
  const switchedResult = await tryCandidates(requestedQuality, matches)
  if (switchedResult) return switchedResult

  for (const quality of qualities.slice(1)) {
    const fallbackResult = await tryCandidates(quality, [originalSong, ...matches])
    if (fallbackResult) return fallbackResult
  }

  throw new Error(`No downloadable source found (${errors.join('; ')})`)
}
