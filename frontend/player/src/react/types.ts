import { parseByteSize } from '../../../shared/src/runtime'

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

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function qualitySize(record: Record<string, unknown>, preferredQuality: unknown): unknown {
  const preferred = String(preferredQuality ?? '').trim()
  const candidates = [record.qualitys, record._qualitys, record.qualities, record.quality]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const entries = candidate.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
      const preferredEntry = entries.find(item => String(item.type ?? item.quality ?? item.name ?? '').trim() === preferred)
      const entry = preferredEntry ?? entries[0]
      if (entry) {
        const size = entry.size ?? entry.fileSize ?? entry.sizeBytes ?? entry.bytes
        if (size !== undefined && size !== null && size !== '') return size
      }
    } else if (candidate && typeof candidate === 'object') {
      const table = candidate as Record<string, unknown>
      const preferredEntry = preferred ? recordOf(table[preferred]) : {}
      const directSize = preferredEntry.size ?? preferredEntry.fileSize ?? preferredEntry.sizeBytes ?? preferredEntry.bytes
      if (directSize !== undefined && directSize !== null && directSize !== '') return directSize
      for (const value of Object.values(table)) {
        const entry = recordOf(value)
        const size = entry.size ?? entry.fileSize ?? entry.sizeBytes ?? entry.bytes
        if (size !== undefined && size !== null && size !== '') return size
      }
    }
  }
  return undefined
}

/** Read the canonical album label while tolerating source-shaped nested data. */
export function songAlbumValue(song: Song | null | undefined): string {
  if (!song) return ''
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  const album = recordOf(record.album)
  const nestedAlbum = recordOf(meta.album)
  const al = recordOf(record.al)
  const songInfo = recordOf(record.songInfo)
  const info = recordOf(record.info)
  const data = recordOf(record.data)
  const metadata = recordOf(record.metadata)
  const nestedSongInfoMeta = recordOf(songInfo.meta)
  const nestedInfoMeta = recordOf(info.meta)
  const nestedDataMeta = recordOf(data.meta)
  return firstText(
    record.albumName,
    record.albumname,
    typeof record.album === 'string' ? record.album : undefined,
    record.albumTitle,
    album.name,
    album.title,
    album.albumName,
    meta.albumName,
    nestedAlbum.name,
    nestedAlbum.title,
    al.name,
    al.title,
    al.albumName,
    songInfo.albumName,
    songInfo.albumTitle,
    recordOf(songInfo.album).name,
    recordOf(songInfo.album).title,
    info.albumName,
    recordOf(info.album).name,
    recordOf(info.album).title,
    data.albumName,
    recordOf(data.album).name,
    recordOf(data.album).title,
    metadata.albumName,
    recordOf(metadata.album).name,
    recordOf(metadata.album).title,
    nestedSongInfoMeta.albumName,
    nestedInfoMeta.albumName,
    nestedDataMeta.albumName,
  )
}

/** Read a media size from both normalized and source-specific fields. */
export function songSizeValue(song: Song | null | undefined): unknown {
  if (!song) return undefined
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  const songInfo = recordOf(record.songInfo)
  const info = recordOf(record.info)
  const data = recordOf(record.data)
  const metadata = recordOf(record.metadata)
  return record.size ?? record.fileSize ?? record.sizeBytes ?? record.bytes
    ?? meta.size ?? meta.fileSize ?? meta.sizeBytes ?? meta.bytes
    ?? songInfo.size ?? songInfo.fileSize ?? songInfo.sizeBytes ?? songInfo.bytes
    ?? info.size ?? info.fileSize ?? info.sizeBytes ?? info.bytes
    ?? data.size ?? data.fileSize ?? data.sizeBytes ?? data.bytes
    ?? metadata.size ?? metadata.fileSize ?? metadata.sizeBytes ?? metadata.bytes
    ?? qualitySize(record, record.quality ?? meta.quality ?? songInfo.quality ?? info.quality ?? data.quality)
    ?? qualitySize(meta, record.quality ?? meta.quality)
}

export function songSizeBytes(songOrValue: Song | unknown): number | undefined {
  const value = songOrValue && typeof songOrValue === 'object' && !Array.isArray(songOrValue)
    ? songSizeValue(songOrValue as Song)
    : songOrValue
  return parseByteSize(value)
}

export function songDurationValue(song: Song | null | undefined): unknown {
  if (!song) return undefined
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  const songInfo = recordOf(record.songInfo)
  const info = recordOf(record.info)
  const data = recordOf(record.data)
  return record.interval ?? record.duration ?? record.durationMs
    ?? meta.interval ?? meta.duration ?? meta.durationMs
    ?? songInfo.interval ?? songInfo.duration ?? songInfo.durationMs
    ?? info.interval ?? info.duration ?? info.durationMs
    ?? data.interval ?? data.duration ?? data.durationMs
}

export function songFormatValue(song: Song | null | undefined): unknown {
  if (!song) return undefined
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  const songInfo = recordOf(record.songInfo)
  const info = recordOf(record.info)
  const data = recordOf(record.data)
  return record.format ?? record.type ?? record.ext ?? record.quality
    ?? meta.format ?? meta.type ?? meta.ext ?? meta.quality
    ?? songInfo.format ?? songInfo.type ?? songInfo.ext ?? songInfo.quality
    ?? info.format ?? info.type ?? info.ext ?? info.quality
    ?? data.format ?? data.type ?? data.ext ?? data.quality
}

export type PlayerTab = 'home' | 'favorites' | 'recent' | 'albums' | 'artists' | 'genres' | 'library' | 'search' | 'songlist' | 'leaderboard' | 'localmusic' | 'settings'
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
  if (!song) return '未知歌曲'
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  return firstText(record.name, record.title, record.songName, meta.songName, meta.name, meta.title) || '未知歌曲'
}

export function songArtist(song: Song | null | undefined): string {
  if (!song) return '未知歌手'
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  const artists = record.artists ?? meta.artists
  if (Array.isArray(artists)) {
    const names = artists.map(item => firstText(recordOf(item).name, recordOf(item).artist, recordOf(item).singer, item)).filter(Boolean)
    if (names.length) return names.join(' / ')
  }
  return firstText(record.singer, record.artist, record.artistName, meta.singer, meta.singerName, meta.artist, meta.artistName) || '未知歌手'
}

export function songAlbum(song: Song | null | undefined): string {
  const value = songAlbumValue(song)
  return value || '—'
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
