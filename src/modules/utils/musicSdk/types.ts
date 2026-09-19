import type { BuiltinOnlineSource } from '@/common/musicSources'

export type MusicId = string | number

export interface MusicSong {
  id?: MusicId
  songmid?: MusicId
  mid?: MusicId
  name?: string | null
  singer?: string | null
  albumName?: string | null
  interval?: string | null
  source?: string
  alias?: string[]
  picUrl?: string | null
  img?: string | null
  avatar?: string | null
  singerPic?: string | null
  singerName?: string | null
  fSinger?: string
  fMusicName?: string
  fAlbumName?: string
  fInterval?: number
  [key: string]: unknown
}

export interface MusicSearchResult {
  source: string
  list: MusicSong[]
  total?: number
  page?: number
  limit?: number
  maxPage?: number
  name?: string
  publishTime?: string
  [key: string]: unknown
}

export interface LyricInfo {
  lyric?: string | null
  lrc?: string | null
  tlyric?: string | null
  rlyric?: string | null
  lxlyric?: string | null
  awlrc?: string | null
  [key: string]: unknown
}

export interface CancelableRequest<T> {
  promise: Promise<T>
  cancelHttp?: () => void
  cancel?: () => void
}

export interface MusicSearchApi {
  search: (keyword: string, page: number, limit: number) => Promise<MusicSearchResult>
}

export interface ExtendSearchApi {
  searchSinger?: (keyword: string, page: number, limit: number) => Promise<MusicSearchResult>
  searchAlbum?: (keyword: string, page: number, limit: number) => Promise<MusicSearchResult>
  searchPlaylist?: (keyword: string, page: number, limit: number) => Promise<MusicSearchResult>
}

export interface ExtendDetailApi {
  getArtistDetail?: (id: string) => Promise<any>
  getArtistAlbums?: (id: string, page: number, limit?: number) => Promise<MusicSearchResult>
  getArtistSongs?: (id: string, page: number, limit: number, order?: string) => Promise<MusicSearchResult>
  getAlbumSongs?: (id: string) => Promise<MusicSearchResult>
}

export interface SongListApi {
  sortList?: unknown
  getTags?: () => Promise<any>
  getList?: (sortId: string, tagId: string, page: number) => Promise<MusicSearchResult>
  getListDetail?: (id: string, page: number, limit?: number) => Promise<MusicSearchResult>
  search?: (text: string, page: number, limit?: number) => Promise<MusicSearchResult>
}

export interface LeaderboardApi {
  getBoards?: () => Promise<any>
  getList?: (id: string, page: number) => Promise<MusicSearchResult>
}

export type CommentApi = Record<string, (...args: unknown[]) => unknown>

export interface MusicPlatform {
  init?: () => Promise<unknown>
  getMusicUrl?: (songInfo: MusicSong, type: string) => CancelableRequest<unknown> | Promise<unknown>
  getPic?: (songInfo: MusicSong) => Promise<string | null>
  getMusicDetailPageUrl?: (songInfo: MusicSong) => string | Promise<string>
  getLyric?: (songInfo: MusicSong) => CancelableRequest<LyricInfo>
  musicSearch?: MusicSearchApi
  extendSearch?: ExtendSearchApi
  extendDetail?: ExtendDetailApi
  songList?: SongListApi
  leaderboard?: LeaderboardApi
  comment?: CommentApi
  hotSearch?: { getList: () => Promise<MusicSearchResult> }
  tipSearch?: { search: (keyword: string) => Promise<any> }
  userPlaylist?: { getList: (uid: string, page: number) => Promise<MusicSearchResult> }
}

export interface MusicSdk {
  sources: Array<{ id: BuiltinOnlineSource; name: string }>
  wy: MusicPlatform
  tx: MusicPlatform
  init: () => Promise<unknown[]>
  supportQuality: Record<string, unknown>
  searchMusic: (params: {
    name: string
    singer?: string
    source?: string
    limit?: number
    page?: number
  }) => Promise<MusicSearchResult[]>
  findMusic: (params: {
    name: string
    singer?: string
    albumName?: string
    interval?: string | null
    source?: string
  }) => Promise<MusicSong[]>
}
