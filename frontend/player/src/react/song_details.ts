import { safeImageUrl } from '../../../shared/src/runtime'
import { playerApi } from './api'
import { getPlayerUiActions } from './store/ui'
import { getSearchActions, prepareSearch } from './store/search'
import type { PlayerDetail, Song } from './types'
import { songArtist, songImage } from './types'

export type SongEntityKind = 'artist' | 'album'
export type SongEntityOptions = { allowGenericId?: boolean; allowGenericName?: boolean }

let entitySearchController: AbortController | null = null
let entitySearchRequestId = 0

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
  if (Array.isArray(value)) return nestedId(value[0])
  const record = recordOf(value)
  return firstText(
    record.id,
    record.mid,
    record.uid,
    record.artistId,
    record.artistID,
    record.artistMid,
    record.artistMID,
    record.artist_mid,
    record.albumId,
    record.albumID,
    record.albumMid,
    record.albumMID,
    record.album_mid,
    record.singerId,
    record.singerID,
    record.singerMid,
    record.singerMID,
    record.singer_mid,
  )
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
  const album = recordOf(record.album)
  return firstText(record.albumName, record.albumname, typeof record.album === 'string' ? record.album : '', album.name, album.title, options.allowGenericName ? record.name : '', options.allowGenericName ? record.title : '') || '未知专辑'
}

export function songEntityId(song: Song, kind: SongEntityKind, options: SongEntityOptions = {}): string {
  const record = recordOf(song)
  const meta = recordOf(record.meta)
  if (kind === 'artist') {
    return firstText(
      record.artistId,
      record.artistID,
      record.artistid,
      record.artistMid,
      record.artistMID,
      record.artist_mid,
      record.singerId,
      record.singerID,
      record.singerid,
      record.singerMid,
      record.singerMID,
      record.singer_mid,
      meta.artistId,
      meta.artistID,
      meta.artistid,
      meta.artistMid,
      meta.artistMID,
      meta.artist_mid,
      meta.singerId,
      meta.singerID,
      meta.singerid,
      meta.singerMid,
      meta.singerMID,
      meta.singer_mid,
      nestedId(record.artist),
      nestedId(record.singer),
      nestedId(record.artists),
      nestedId(record.singers),
      options.allowGenericId ? record.id : '',
      options.allowGenericId ? record.mid : '',
      options.allowGenericId ? record.uid : '',
    )
  }
  return firstText(
    record.albumId,
    record.albumID,
    record.albumid,
    record.albumMid,
    record.albumMID,
    record.albummid,
    record.album_mid,
    meta.albumId,
    meta.albumID,
    meta.albumid,
    meta.albumMid,
    meta.albumMID,
    meta.album_mid,
    nestedId(record.album),
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

export async function navigateToSongEntity(song: Song, kind: SongEntityKind, options: SongEntityOptions = {}): Promise<void> {
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
  entitySearchController?.abort()
  const controller = new AbortController()
  entitySearchController = controller
  const requestId = ++entitySearchRequestId

  // Search only to resolve the missing entity id. Once the source returns the
  // entity record, open its detail directly instead of briefly routing through
  // the search results page.
  try {
    const results = await playerApi.search(query, songSource(song), type, 1, controller.signal, {
      cacheKey: `entity:${songSource(song)}:${type}:${query}`,
      cacheTtlMs: 30_000,
    })
    if (controller.signal.aborted || requestId !== entitySearchRequestId) return
    const expectedName = query.toLocaleLowerCase()
    const result = (Array.isArray(results) ? results : []).find(item => songEntityName(item, kind, { allowGenericName: true }).toLocaleLowerCase() === expectedName)
      ?? (Array.isArray(results) ? results[0] : undefined)
    const resolved = result && songEntityDetail(result, kind, { allowGenericId: true, allowGenericName: true })
    if (resolved) {
      ui.openLibraryDetail(kind === 'artist' ? 'artists' : 'albums', resolved)
      return
    }
  } catch (error) {
    if (controller.signal.aborted || requestId !== entitySearchRequestId) return
  } finally {
    if (entitySearchController === controller) entitySearchController = null
  }

  // Keep the existing search fallback for sources that cannot resolve an
  // entity record, while ensuring the normal successful path never shows it.
  prepareSearch(songSource(song), type, query)
  void search.search(query, 1)
  ui.setTab('search')
}
