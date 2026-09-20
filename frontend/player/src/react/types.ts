export type Song = Record<string, unknown> & {
  id?: string | number
  songmid?: string | number
  name?: string
  singer?: string
  albumName?: string
  source?: string
  img?: string
  pic?: string
  url?: string
  duration?: number | string
  interval?: number | string
  hash?: string
}

export type PlayerTab = 'home' | 'favorites' | 'recent' | 'albums' | 'artists' | 'genres' | 'library' | 'search' | 'songlist' | 'leaderboard' | 'localmusic' | 'settings' | 'about'
export type PlayerDetail = { page: 'search-detail' | 'songlist-detail'; kind: 'artist' | 'album' | 'playlist'; id: string; source: string; name?: string; image?: string }
export type PlayMode = 'list' | 'single' | 'random'
export type DrawerName = 'queue' | 'cache' | 'download' | null
export type LyricLine = { time: number; text: string; translation?: string; roma?: string; words?: string }

export function songKey(song: Song): string {
  return `${String(song.source || 'unknown')}:${String(song.songmid ?? song.id ?? song.hash ?? song.name ?? '')}`
}

// List mutations are keyed by the persisted MusicInfo.id on the server.
// Some older entries only have songmid, so keep that as a compatibility fallback.
export function songListId(song: Song): string {
  const record = song as Record<string, unknown>
  const meta = record.meta && typeof record.meta === 'object' ? record.meta as Record<string, unknown> : {}
  return String(song.id ?? song.songmid ?? song.hash ?? meta.songId ?? meta.songmid ?? '').trim()
}

/**
 * Music results from different sources are not shaped consistently.  Keep
 * comparisons tolerant of numeric/string ids and legacy songmid-only rows.
 */
export function sameSong(left: Song | null | undefined, right: Song | null | undefined): boolean {
  if (!left || !right) return false
  if (songKey(left) === songKey(right)) return true
  const leftId = songListId(left)
  const rightId = songListId(right)
  if (!leftId || !rightId || leftId !== rightId) return false
  const leftSource = String(left.source || '').trim()
  const rightSource = String(right.source || '').trim()
  return !leftSource || !rightSource || leftSource === rightSource
}

/** Ensure list mutations always send the persisted id field when possible. */
export function normalizeSongForList(song: Song): Song {
  const id = songListId(song)
  if (!id || song.id !== undefined && song.id !== null && String(song.id).trim()) return song
  return { ...song, id }
}

export function songTitle(song: Song | null | undefined): string {
  return String(song?.name || '未知歌曲')
}

export function songArtist(song: Song | null | undefined): string {
  return String(song?.singer || song?.artist || '未知歌手')
}

export function songAlbum(song: Song | null | undefined): string {
  const value = song?.albumName
  return value === undefined || value === null || !String(value).trim() ? '—' : String(value).trim()
}

export function songImage(song: Song | null | undefined): unknown {
  if (!song) return undefined
  const record = song as Record<string, unknown>
  const nested = (...keys: string[]) => keys.flatMap(key => {
    const value = record[key]
    if (!value || typeof value !== 'object') return []
    const nestedRecord = value as Record<string, unknown>
    return ['url', 'src', 'picUrl', 'pic_url', 'img', 'pic', 'cover', 'coverUrl', 'coverImgUrl', 'cover_url', 'cover_url_medium', 'picture', 'logo', 'image', 'thumbnail'].map(field => nestedRecord[field]).filter(Boolean)
  })
  return [
    record.img,
    record.pic,
    record.picUrl,
    record.pic_url,
    record.cover,
    record.coverUrl,
    record.coverImgUrl,
    record.cover_url,
    record.cover_url_medium,
    record.picture,
    record.logo,
    record.image,
    record.thumbnail,
    record.albumImg,
    record.disscover,
    record.dissCover,
    ...nested('meta', 'album', 'al', 'music', 'songInfo', 'info', 'playlist', 'diss', 'data', 'result'),
  ].find(value => (typeof value === 'string' ? value.trim().length > 0 : Boolean(value)))
}
