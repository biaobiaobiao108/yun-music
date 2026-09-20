import { safeImageUrl } from '../../../shared/src/runtime'
import { usePlayerUiStore, useSearchStore } from './store'
import type { PlayerDetail, Song } from './types'
import { songArtist, songImage } from './types'

export type SongEntityKind = 'artist' | 'album'

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

export function songEntityName(song: Song, kind: SongEntityKind): string {
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  if (kind === 'artist') {
    return firstText(song.singer, record.artist, record.artistName, record.singerName, meta.artistName, meta.singerName) || songArtist(song)
  }
  const album = record.album
  return firstText(typeof album === 'string' ? album : '', record.albumName, record.albumname, meta.albumName, nestedId(album)) || '未知专辑'
}

export function songEntityId(song: Song, kind: SongEntityKind): string {
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
    )
  }
  return firstText(
    record.albumId,
    record.albumid,
    record.albumMid,
    record.albummid,
    meta.albumId,
    meta.albumid,
    meta.albumMid,
    meta.albummid,
    nestedId(record.album),
  )
}

export function songEntityDetail(song: Song, kind: SongEntityKind): PlayerDetail | null {
  const id = songEntityId(song, kind)
  if (!id) return null
  return {
    page: 'search-detail',
    kind,
    id,
    source: songSource(song),
    name: songEntityName(song, kind),
    image: safeImageUrl(songImage(song)),
  }
}

export function navigateToSongEntity(song: Song, kind: SongEntityKind): void {
  const ui = usePlayerUiStore.getState()
  const detail = songEntityDetail(song, kind)
  if (detail) {
    ui.openLibraryDetail(kind === 'artist' ? 'artists' : 'albums', detail)
    return
  }

  const query = songEntityName(song, kind)
  if (!query || query === '未知歌手' || query === '未知专辑') {
    ui.notify(`当前歌曲没有可用的${kind === 'artist' ? '歌手' : '专辑'}信息`)
    return
  }
  const search = useSearchStore.getState()
  const type = kind === 'artist' ? 'singer' : 'album'
  useSearchStore.setState({ source: songSource(song), type, query, page: 1, results: [], error: '' })
  void search.search(query, 1)
  ui.setTab('search')
}
