export type Song = Record<string, unknown> & {
  id?: string | number
  songmid?: string | number
  name?: string
  singer?: string
  album?: string
  source?: string
  img?: string
  pic?: string
  url?: string
  duration?: number | string
  interval?: number | string
  hash?: string
}

export type PlayerTab = 'search' | 'songlist' | 'leaderboard' | 'favorites' | 'localmusic' | 'settings' | 'about'
export type PlayerDetail = { page: 'search-detail' | 'songlist-detail'; kind: 'artist' | 'album' | 'playlist'; id: string; source: string; name?: string; image?: string }
export type PlayMode = 'list' | 'single' | 'random'
export type DrawerName = 'queue' | 'cache' | 'download' | null
export type LyricLine = { time: number; text: string; translation?: string; roma?: string; words?: string }

export function songKey(song: Song): string {
  return `${String(song.source || 'unknown')}:${String(song.songmid ?? song.id ?? song.hash ?? song.name ?? '')}`
}

export function songTitle(song: Song | null | undefined): string {
  return String(song?.name || '未知歌曲')
}

export function songArtist(song: Song | null | undefined): string {
  return String(song?.singer || song?.artist || '未知歌手')
}

export function songImage(song: Song | null | undefined): unknown {
  if (!song) return undefined
  const record = song as Record<string, unknown>
  const nested = (...keys: string[]) => keys.flatMap(key => {
    const value = record[key]
    if (!value || typeof value !== 'object') return []
    const nestedRecord = value as Record<string, unknown>
    return ['url', 'src', 'picUrl', 'img', 'pic', 'cover', 'picture'].map(field => nestedRecord[field]).filter(Boolean)
  })
  return [
    record.img,
    record.pic,
    record.picUrl,
    record.cover,
    record.picture,
    record.albumImg,
    ...nested('meta', 'album', 'al', 'music', 'songInfo'),
  ].find(value => (typeof value === 'string' ? value.trim().length > 0 : Boolean(value)))
}
