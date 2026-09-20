import { safeImageUrl } from '../../../shared/src/runtime'
import { getPlayerUiActions } from './store/ui'
import { getSearchActions, prepareSearch } from './store/search'
import type { PlayerDetail, Song } from './types'
import { songArtist, songImage } from './types'

export type SongEntityKind = 'artist' | 'album'
export type SongEntityOptions = { allowGenericId?: boolean; allowGenericName?: boolean }

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function nestedId(value: unknown): string {
  const record = recordOf(value)
  return firstText(record.id, record.mid, record.uid, record.artistId, record.albumId)
}

export function songSource(song: Song): string {
  return firstText(song.source, song.platform, recordOf(song).sourceName) || 'wy'
}

export function songEntityName(song: Song, kind: SongEntityKind, options: SongEntityOptions = {}): string {
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  if (kind === 'artist') {
    return firstText(song.singer, record.artist, record.artistName, record.singerName, meta.artistName, meta.singerName, options.allowGenericName ? record.name : '', options.allowGenericName ? record.title : '') || songArtist(song)
  }
  return firstText(record.albumName, options.allowGenericName ? record.name : '', options.allowGenericName ? record.title : '') || '未知专辑'
}

export function songEntityId(song: Song, kind: SongEntityKind, options: SongEntityOptions = {}): string {
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  if (kind === 'artist') {
    return firstText(
      record.artistId,
      record.artistid,
      record.singerId,
      record.singerid,
      meta.artistId,
      meta.artistid,
      meta.singerId,
      meta.singerid,
      nestedId(record.artist),
      nestedId(record.singer),
      options.allowGenericId ? record.id : '',
      options.allowGenericId ? record.mid : '',
      options.allowGenericId ? record.uid : '',
    )
  }
  return firstText(
    record.albumId,
    record.albumid,
    record.albumMid,
    record.albummid,
    options.allowGenericId ? record.id : '',
    options.allowGenericId ? record.mid : '',
  )
}

export function songEntityDetail(song: Song, kind: SongEntityKind, options: SongEntityOptions = {}): PlayerDetail | null {
  const id = songEntityId(song, kind, options)
  if (!id) return null
  return {
    page: 'search-detail',
    kind,
    id,
    source: songSource(song),
    name: songEntityName(song, kind, options),
    image: safeImageUrl(songImage(song)),
  }
}

export function navigateToSongEntity(song: Song, kind: SongEntityKind, options: SongEntityOptions = {}): void {
  const ui = getPlayerUiActions()
  const detail = songEntityDetail(song, kind, options)
  if (detail) {
    ui.openLibraryDetail(kind === 'artist' ? 'artists' : 'albums', detail)
    return
  }

  const query = songEntityName(song, kind, options)
  if (!query || query === '未知歌手' || query === '未知专辑') {
    ui.notify(`当前歌曲没有可用的${kind === 'artist' ? '歌手' : '专辑'}信息`)
    return
  }
  const search = getSearchActions()
  const type = kind === 'artist' ? 'singer' : 'album'
  prepareSearch(songSource(song), type, query)
  void search.search(query, 1)
  ui.setTab('search')
}
