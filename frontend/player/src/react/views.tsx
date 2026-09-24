import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { playerApi, PLAYLIST_ICON_OPTIONS, playlistIcon, type CommentItem, type PlaylistIconKey, type SearchType, type UserPlaylist } from './api'
import { Button, DescriptionDisclosure, Icon, Loading, Modal, SafeImage, SelectMenu, SongList } from './components'
import { consumeImmersiveLyricsTrigger, PlayerFooterBar } from './player_footer'
import { navigateToSongEntity, songEntityDetail } from './song_details'
import { isSongInLoveList, mediaLibraryItemKey, selectLoveList, selectUserLists, useAuthStore, useCacheStore, useCommentStore, useLibraryStore, useLyricStore, useMediaLibraryStore, usePlaybackStore, usePlayerUiStore, useSearchStore, useSettingsStore } from './store'
import type { PlayerDetail, PlayerTab, Song } from './types'
import { sameSong, songArtist, songImage, songKey, songTitle } from './types'
import { formatBytes, formatDate, safeImageUrl } from '../../../shared/src/runtime'
import { goBack } from './route_state'
import { ViewFrame } from './view_frame'

function extractSongs(payload: unknown): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['list', 'songs', 'data', 'result']) if (Array.isArray(record[key])) return record[key] as Song[]
  return []
}

type SongPage = { songs: Song[]; page: number; limit: number; total: number; hasMore: boolean }

function extractSongPage(payload: unknown, fallbackPage = 1, fallbackLimit = 40): SongPage {
  const record = recordOf(payload)
  const songs = extractSongs(payload)
  const pageValue = Number(record.page)
  const limitValue = Number(record.limit)
  const totalValue = Number(record.total ?? record.totalCount ?? record.count)
  const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : fallbackPage
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : fallbackLimit
  const total = Number.isFinite(totalValue) && totalValue > 0 ? totalValue : 0
  return { songs, page, limit, total, hasMore: total > 0 ? page * limit < total : songs.length >= limit }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function resultId(song: Song, index: number, kind: 'artist' | 'album' | 'playlist'): string {
  if (kind === 'artist' || kind === 'album') {
    const detail = songEntityDetail(song, kind, { allowGenericId: true, allowGenericName: true })
    if (detail) return detail.id
  }
  return String(song.id ?? song.listId ?? song.songmid ?? song.hash ?? index)
}

function resultImage(song: Song): string {
  return safeImageUrl(songImage(song))
}

function findActiveLyricIndex(lines: readonly { time: number }[], time: number): number {
  let low = 0
  let high = lines.length - 1
  let active = -1
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((lines[middle]?.time ?? Infinity) <= time) {
      active = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return active
}

function SearchEntityGrid({ items, kind, onOpen }: { items: Song[]; kind: 'artist' | 'album' | 'playlist'; onOpen: (detail: PlayerDetail) => void }) {
  const mediaItems = useMediaLibraryStore(state => kind === 'artist' ? state.artists : state.albums)
  const toggleMedia = useMediaLibraryStore(state => state.toggle)
  const userLists = useLibraryStore(selectUserLists)
  const toggleRemotePlaylist = useLibraryStore(state => state.toggleRemotePlaylist)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const [busyKey, setBusyKey] = useState('')
  const favoriteMediaKeys = useMemo(() => kind === 'playlist' ? new Set<string>() : new Set(mediaItems.map(item => mediaLibraryItemKey(item, kind))), [kind, mediaItems])
  const favoritePlaylistKeys = useMemo(() => new Set(userLists.map(list => `${String(list.source || '')}:${String(list.sourceListId ?? '')}`)), [userLists])
  if (!items.length) return <div className="react-empty"><Icon name={kind === 'artist' ? 'user' : kind === 'album' ? 'compact-disc' : 'list'} /><p>没有找到匹配的结果</p></div>
  return <div className="react-entity-grid">{items.map((item, index) => {
    const entityDetail = kind === 'playlist' ? null : songEntityDetail(item, kind, { allowGenericId: true, allowGenericName: true })
    const id = resultId(item, index, kind)
    const name = String(entityDetail?.name ?? item.name ?? item.artistName ?? item.singer ?? item.title ?? '未命名')
    const source = String(entityDetail?.source || item.source || 'wy')
    const subtitle = kind === 'artist' ? `${String(item.albumSize ?? 0)} 张专辑` : kind === 'album' ? String(item.artistName ?? item.singer ?? '未知歌手') : String(item.creator ?? item.artistName ?? '平台歌单')
    const favoriteKey = `${source}:${kind}:${id}`
    const isFavorite = kind === 'playlist'
      ? favoritePlaylistKeys.has(`${source}:${id}`)
      : favoriteMediaKeys.has(mediaLibraryItemKey(item, kind))
    const open = () => {
      if (entityDetail) {
        onOpen(entityDetail)
        return
      }
      if (kind === 'artist' || kind === 'album') {
        navigateToSongEntity(item, kind, { allowGenericName: true })
        return
      }
      onOpen({ page: 'search-detail', kind, id, source, name, image: resultImage(item) })
    }
    const toggleFavorite = async () => {
      if (busyKey) return
      if (!userAuthenticated) {
        setDialog('userLogin')
        notify('请先登录用户账户')
        return
      }
      setBusyKey(favoriteKey)
      try {
        const next = kind === 'playlist'
          ? await (async () => {
            const payload = await playerApi.songListDetail(source, id)
            return toggleRemotePlaylist({ id, source, name, image: resultImage(item) }, extractSongs(payload))
          })()
          : await toggleMedia(kind, item)
        notify(next ? `已收藏${kind === 'artist' ? '歌手' : kind === 'album' ? '专辑' : '歌单'}` : '已取消收藏')
      } catch (error) {
        notify(error instanceof Error ? error.message : '收藏操作失败')
      } finally {
        setBusyKey('')
      }
    }
    return <article className="react-entity-card" key={`${source}:${id}`}><button type="button" className="react-entity-open" onClick={open}><SafeImage src={resultImage(item)} width="160" height="160" loading="lazy" alt={`${name}封面`} /><strong>{name}</strong><small>{subtitle}</small></button><button type="button" className={`react-entity-favorite ${isFavorite ? 'is-active' : ''}`} aria-label={isFavorite ? `取消收藏${name}` : `收藏${name}`} aria-pressed={isFavorite} disabled={busyKey === favoriteKey} onClick={event => { event.stopPropagation(); void toggleFavorite() }}><Icon name="heart" /></button></article>
  })}</div>
}

export function SearchDetailView({ detail }: { detail: PlayerDetail }) {
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const [info, setInfo] = useState<Record<string, unknown>>({})
  const [songs, setSongs] = useState<Song[]>([])
  const [songPage, setSongPage] = useState(1)
  const [songTotal, setSongTotal] = useState(0)
  const [hasMoreSongs, setHasMoreSongs] = useState(false)
  const [loadingMoreSongs, setLoadingMoreSongs] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState('')
  const [albums, setAlbums] = useState<Song[]>([])
  const [activeTab, setActiveTab] = useState<'songs' | 'albums'>('songs')
  const [order, setOrder] = useState<'hot' | 'time'>('hot')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [favoriteBusy, setFavoriteBusy] = useState(false)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const songRequestId = useRef(0)
  const loadMoreInFlight = useRef(false)
  const loadMoreIntersectionActive = useRef(false)
  const loadMoreController = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const requestId = songRequestId.current + 1
    songRequestId.current = requestId
    loadMoreController.current?.abort()
    loadMoreController.current = null
    loadMoreInFlight.current = false
    loadMoreIntersectionActive.current = false
    setLoading(true); setError('')
    setLoadingMoreSongs(false); setLoadMoreError(''); setSongs([]); setSongPage(1); setSongTotal(0); setHasMoreSongs(false); setActiveTab('songs')
    const load = async () => {
      try {
        if (detail.kind === 'artist') {
          const [artist, songPayload] = await Promise.all([
            playerApi.artistDetail(detail.source, detail.id, controller.signal, { cacheKey: `artist:detail:${detail.source}:${detail.id}`, cacheTtlMs: 60_000 }),
            playerApi.artistSongs(detail.source, detail.id, order, 1, 40, controller.signal, { cacheKey: `artist:songs:${detail.source}:${detail.id}:${order}:1`, cacheTtlMs: 60_000 }),
          ])
          if (controller.signal.aborted) return
          const firstPage = extractSongPage(songPayload)
          setInfo(recordOf(artist)); setSongs(firstPage.songs); setSongPage(firstPage.page); setSongTotal(firstPage.total); setHasMoreSongs(firstPage.hasMore)
        } else if (detail.kind === 'album') {
          const payload = await playerApi.albumSongs(detail.source, detail.id, controller.signal, { cacheKey: `album:songs:${detail.source}:${detail.id}`, cacheTtlMs: 60_000 })
          if (controller.signal.aborted) return
          setInfo(recordOf(payload)); setSongs(extractSongs(payload))
        } else {
          const payload = await playerApi.songListDetail(detail.source, detail.id, controller.signal, { cacheKey: `songlist:detail:${detail.source}:${detail.id}`, cacheTtlMs: 60_000 })
          if (controller.signal.aborted) return
          setInfo(recordOf(payload)); setSongs(extractSongs(payload))
        }
      } catch (cause) { if (!controller.signal.aborted && requestId === songRequestId.current) setError(cause instanceof Error ? cause.message : '详情加载失败') } finally { if (!controller.signal.aborted && requestId === songRequestId.current) setLoading(false) }
    }
    void load()
    return () => {
      controller.abort()
      loadMoreController.current?.abort()
      loadMoreController.current = null
      loadMoreInFlight.current = false
      loadMoreIntersectionActive.current = false
    }
  }, [detail.id, detail.kind, detail.source, order])
  const mediaKind = detail.kind === 'artist' || detail.kind === 'album' ? detail.kind : null
  const mediaItems = useMediaLibraryStore(state => mediaKind === 'artist' ? state.artists : state.albums)
  const toggleMedia = useMediaLibraryStore(state => state.toggle)
  const userLists = useLibraryStore(selectUserLists)
  const toggleRemotePlaylist = useLibraryStore(state => state.toggleRemotePlaylist)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const favoriteItem = useMemo<Song>(() => ({
    id: detail.id,
    source: detail.source,
    name: detail.name,
    singer: detail.kind === 'artist' ? detail.name : undefined,
    albumName: detail.kind === 'album' ? detail.name : undefined,
    picUrl: detail.image,
  }), [detail.id, detail.image, detail.kind, detail.name, detail.source])
  const isDetailFavorite = mediaKind
    ? mediaItems.some(item => mediaLibraryItemKey(item, mediaKind) === mediaLibraryItemKey(favoriteItem, mediaKind))
    : userLists.some(list => String(list.source || '') === detail.source && String(list.sourceListId ?? '') === detail.id)
  const toggleDetailFavorite = async () => {
    if (favoriteBusy || loading || error) return
    if (!userAuthenticated) {
      setDialog('userLogin')
      notify('请先登录用户账户')
      return
    }
    setFavoriteBusy(true)
    try {
      const next = mediaKind
        ? await toggleMedia(mediaKind, favoriteItem)
        : await toggleRemotePlaylist({ id: detail.id, source: detail.source, name: detail.name || '在线歌单', image: detail.image }, songs)
      notify(next ? `已收藏${mediaKind === 'artist' ? '歌手' : mediaKind === 'album' ? '专辑' : '歌单'}` : '已取消收藏')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '收藏操作失败')
    } finally {
      setFavoriteBusy(false)
    }
  }
  const loadMoreSongs = useCallback(async () => {
    if (detail.kind !== 'artist' || loading || loadingMoreSongs || loadMoreInFlight.current || !hasMoreSongs) return
    const requestId = songRequestId.current
    const nextPage = songPage + 1
    const controller = new AbortController()
    loadMoreController.current?.abort()
    loadMoreController.current = controller
    loadMoreInFlight.current = true
    setLoadingMoreSongs(true)
    setLoadMoreError('')
    try {
      const payload = await playerApi.artistSongs(detail.source, detail.id, order, nextPage, 40, controller.signal, { cacheKey: `artist:songs:${detail.source}:${detail.id}:${order}:${nextPage}`, cacheTtlMs: 60_000 })
      if (controller.signal.aborted || requestId !== songRequestId.current) return
      const next = extractSongPage(payload, nextPage)
      setSongs(current => {
        const known = new Set(current.map(songKey))
        return [...current, ...next.songs.filter(song => !known.has(songKey(song)))]
      })
      setSongPage(next.page)
      setSongTotal(current => Math.max(current, next.total))
      setHasMoreSongs(next.hasMore)
    } catch (cause) {
      if (!controller.signal.aborted && requestId === songRequestId.current) setLoadMoreError(cause instanceof Error ? cause.message : '加载更多歌曲失败')
    } finally {
      if (loadMoreController.current === controller) loadMoreController.current = null
      loadMoreInFlight.current = false
      if (requestId === songRequestId.current) setLoadingMoreSongs(false)
    }
  }, [detail.id, detail.kind, detail.source, hasMoreSongs, loading, loadingMoreSongs, order, songPage])
  useEffect(() => {
    loadMoreIntersectionActive.current = false
    const sentinel = loadMoreRef.current
    if (!sentinel || detail.kind !== 'artist' || activeTab !== 'songs' || !hasMoreSongs || loading || loadingMoreSongs || typeof IntersectionObserver === 'undefined') return
    const root = sentinel.closest('.react-player-content')
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0]
      if (!entry?.isIntersecting) {
        loadMoreIntersectionActive.current = false
        return
      }
      if (loadMoreIntersectionActive.current) return
      loadMoreIntersectionActive.current = true
      void loadMoreSongs()
    }, { root, rootMargin: '0px 0px 420px 0px', threshold: 0 })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeTab, detail.kind, hasMoreSongs, loadMoreSongs, loading, loadingMoreSongs])
  useEffect(() => {
    if (detail.kind !== 'artist' || activeTab !== 'albums') return
    const controller = new AbortController()
    void playerApi.artistAlbums(detail.source, detail.id, 1, 40, controller.signal, { cacheKey: `artist:albums:${detail.source}:${detail.id}:1`, cacheTtlMs: 60_000 }).then(payload => { if (!controller.signal.aborted) setAlbums(extractSongs(payload)) }).catch(() => { if (!controller.signal.aborted) setAlbums([]) })
    return () => controller.abort()
  }, [activeTab, detail.id, detail.kind, detail.source])
  const name = String(info.name ?? info.artistName ?? info.albumName ?? info.title ?? detail.name ?? '详情')
  const image = safeImageUrl(songImage(info as Song), detail.image)
  const description = String(info.desc ?? info.description ?? info.intro ?? '')
  const loadedCountLabel = songTotal > 0 ? `${songs.length} / ${songTotal}` : `${songs.length}`
  return <ViewFrame title={name} hideHeader><section className="react-detail-header t-bg-panel"><button type="button" className="react-secondary-button" onClick={goBack}><Icon name="arrow-left" />返回搜索结果</button><div className="react-detail-hero"><SafeImage src={image} width="144" height="144" loading="lazy" alt={`${name}封面`} /><div><h1>{name}</h1>{description && <DescriptionDisclosure text={description} />}<small>{detail.source.toUpperCase()} · {detail.kind === 'artist' ? loadedCountLabel : songs.length} 首歌曲</small><button type="button" className={`react-detail-favorite ${isDetailFavorite ? 'is-active' : ''}`} aria-label={isDetailFavorite ? `取消收藏${name}` : `收藏${name}`} aria-pressed={isDetailFavorite} disabled={favoriteBusy || loading || Boolean(error)} onClick={() => void toggleDetailFavorite()}><Icon name="heart" />{isDetailFavorite ? '已收藏' : '收藏'}</button></div></div></section>{detail.kind === 'artist' && <div className="react-detail-tabs" role="tablist"><button type="button" role="tab" aria-selected={activeTab === 'songs'} className={activeTab === 'songs' ? 'is-active' : ''} onClick={() => setActiveTab('songs')}>热门歌曲</button><button type="button" role="tab" aria-selected={activeTab === 'albums'} className={activeTab === 'albums' ? 'is-active' : ''} onClick={() => setActiveTab('albums')}>专辑</button>{activeTab === 'songs' && <span><button type="button" className={order === 'hot' ? 'is-active' : ''} onClick={() => setOrder('hot')}>最热</button><button type="button" className={order === 'time' ? 'is-active' : ''} onClick={() => setOrder('time')}>最新</button></span>}</div>}<section className="react-content-card t-bg-panel">{loading ? <Loading label="正在加载详情…" /> : error ? <p className="react-error" role="alert">{error}</p> : detail.kind === 'artist' && activeTab === 'albums' ? <SearchEntityGrid items={albums} kind="album" onOpen={next => setDetail(next)} /> : <><SongList songs={songs} empty="暂无歌曲" />{detail.kind === 'artist' && <div ref={loadMoreRef} className="react-load-more" role="status" aria-live="polite"><span role={loadMoreError ? 'alert' : undefined}>{loadMoreError || (loadingMoreSongs ? '正在加载更多歌曲…' : hasMoreSongs ? `继续下滑加载更多 · 已加载 ${loadedCountLabel} 首` : `已加载全部 ${songs.length} 首歌曲`)}</span>{hasMoreSongs && <Button type="button" onClick={() => void loadMoreSongs()} disabled={loadingMoreSongs}><Icon name={loadingMoreSongs ? 'spinner' : 'arrow-down'} />{loadingMoreSongs ? '加载中' : loadMoreError ? '重试' : '加载更多'}</Button>}</div>}</>}</section></ViewFrame>
}

export function SearchView({ detail = null }: { detail?: PlayerDetail | null } = {}) {
  const query = useSearchStore(state => state.query)
  const source = useSearchStore(state => state.source)
  const type = useSearchStore(state => state.type)
  const page = useSearchStore(state => state.page)
  const results = useSearchStore(state => state.results)
  const loading = useSearchStore(state => state.loading)
  const error = useSearchStore(state => state.error)
  const hot = useSearchStore(state => state.hot)
  const search = useSearchStore(state => state.search)
  const setQuery = useSearchStore(state => state.setQuery)
  const setSource = useSearchStore(state => state.setSource)
  const setType = useSearchStore(state => state.setType)
  const loadHot = useSearchStore(state => state.loadHot)
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const [input, setInput] = useState(query)
  useEffect(() => { void loadHot() }, [loadHot, source])
  useEffect(() => setInput(query), [query])
  const submit = (event: FormEvent) => { event.preventDefault(); void search(input, 1) }
  const label = type === 'song' ? '歌曲' : type === 'singer' ? '歌手' : type === 'album' ? '专辑' : '歌单'
  if (detail) return <SearchDetailView detail={detail} />
  const resultView = type === 'singer' ? <SearchEntityGrid items={results} kind="artist" onOpen={setDetail} /> : type === 'album' ? <SearchEntityGrid items={results} kind="album" onOpen={setDetail} /> : type === 'playlist' ? <SearchEntityGrid items={results} kind="playlist" onOpen={setDetail} /> : <SongList songs={results} empty={query ? '没有找到匹配的歌曲' : '输入关键词开始搜索'} />
  return <ViewFrame title="搜索音乐"><section className="react-search-card t-bg-panel"><form className="react-search-form" onSubmit={submit}><label htmlFor="player-search" className="sr-only">搜索音乐</label><div className="react-global-search react-search-input"><Icon name="search" /><input id="player-search" value={input} onChange={event => { setInput(event.target.value); setQuery(event.target.value) }} placeholder="搜索音乐、歌手、专辑或歌单" autoComplete="off" /><button type="button" aria-label="清空搜索" onClick={() => { setInput(''); setQuery('') }}><Icon name="xmark" /></button></div><div className="react-search-filter"><SelectMenu label="音源" value={source} options={[{ value: 'wy', label: '网易云' }, { value: 'tx', label: 'QQ音乐' }]} onChange={setSource} /></div><div className="react-search-filter"><SelectMenu label="搜索类型" value={type} options={[{ value: 'song', label: '歌曲' }, { value: 'singer', label: '歌手' }, { value: 'album', label: '专辑' }, { value: 'playlist', label: '歌单' }]} onChange={next => setType(next as SearchType)} /></div><Button variant="primary" type="submit" disabled={loading}><Icon name="search" />搜索</Button></form>{!results.length && !query && <div className="react-hot-search"><h2>热门搜索</h2><div>{hot.slice(0, 20).map((item, index) => { const text = typeof item === 'string' ? item : String((item as Record<string, unknown>)?.name ?? (item as Record<string, unknown>)?.keyword ?? item); return <button type="button" key={`${text}-${index}`} onClick={() => { setInput(text); setQuery(text); void search(text, 1) }}>{text}</button> })}</div></div>}</section><section className="react-content-card t-bg-panel"><div className="react-section-heading"><div><h2>{query ? `“${query}”的${label}结果` : '搜索结果'}</h2>{results.length > 0 && <p>共显示 {results.length} 条</p>}</div></div>{loading ? <Loading label="正在搜索…" /> : error ? <p className="react-error" role="alert">{error}</p> : resultView}<div className="react-pagination react-pagination-bottom"><button type="button" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => void search(query, page - 1)}><Icon name="chevron-left" /></button><span>第 {page} 页</span><button type="button" aria-label="下一页" disabled={!query || loading || results.length < 40} onClick={() => void search(query, page + 1)}><Icon name="chevron-right" /></button></div></section></ViewFrame>
}

type SongCollectionViewProps = {
  listId: string
  name: string
  songs: Song[]
  loading: boolean
  error: string
  onRename?: (name: string) => Promise<void>
  onDelete?: () => Promise<void>
}

function SongCollectionView({ listId, name, songs, loading, error, onRename, onDelete }: SongCollectionViewProps) {
  const removeSongs = useLibraryStore(state => state.removeSongs)
  const enqueueDownloads = useCacheStore(state => state.enqueueDownloads)
  const playSong = usePlaybackStore(state => state.playSong)
  const notify = usePlayerUiStore(state => state.notify)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const preferredQuality = useSettingsStore(state => String(state.settings.preferredQuality || 'flac'))
  const [batchMode, setBatchMode] = useState(false)
  const [selectedSongs, setSelectedSongs] = useState<Set<string>>(new Set())
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  useEffect(() => {
    setSelectedSongs(new Set())
    setBatchMode(false)
    setRenameValue(name)
  }, [listId, name])
  const selectedListSongs = useMemo(() => songs.filter(song => selectedSongs.has(songKey(song))), [selectedSongs, songs])
  const toggleSong = (song: Song) => setSelectedSongs(current => {
    const next = new Set(current)
    const key = songKey(song)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const selectAll = () => setSelectedSongs(new Set(songs.map(songKey)))
  const playRandom = () => {
    if (!songs.length) {
      notify('当前歌单没有歌曲')
      return
    }
    const index = Math.floor(Math.random() * songs.length)
    playSong(songs[index], songs, index)
  }
  const removeBatch = async () => {
    if (!selectedListSongs.length) return
    try {
      await removeSongs(listId, selectedListSongs)
      notify(`已从“${name}”移除 ${selectedListSongs.length} 首歌曲`)
      setSelectedSongs(new Set())
      setConfirmOpen(false)
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '批量移除失败')
    }
  }
  const downloadBatch = async () => {
    if (!selectedListSongs.length || downloadBusy) return
    setDownloadBusy(true)
    try {
      const count = await enqueueDownloads(selectedListSongs, preferredQuality)
      notify(`已将 ${count} 首歌曲加入下载队列（${preferredQuality.toUpperCase()}）`)
      setSelectedSongs(new Set())
      setDrawer('download')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '批量下载失败')
    } finally {
      setDownloadBusy(false)
    }
  }
  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    const nextName = renameValue.trim()
    if (!onRename || !nextName) return
    try {
      await onRename(nextName)
      setRenameOpen(false)
      notify('歌单已重命名')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '歌单重命名失败')
    }
  }
  const confirmDelete = async () => {
    if (!onDelete) return
    try {
      await onDelete()
      setDeleteOpen(false)
      openFavoriteList('love')
      notify('歌单已删除')
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '歌单删除失败')
    }
  }
  const headerActions = <><Button variant="primary" onClick={playRandom} disabled={!songs.length}><Icon name="play" />随机漫游</Button>{onRename && <Button onClick={() => { setRenameValue(name); setRenameOpen(true) }}><Icon name="pen" />重命名</Button>}{onDelete && <Button variant="danger" onClick={() => setDeleteOpen(true)}><Icon name="trash" />删除</Button>}</>
  const listActions = <>{batchMode && selectedSongs.size > 0 && <span className="react-header-selection-count">已选择 {selectedSongs.size} 首</span>}{batchMode && <><Button onClick={selectAll} disabled={!songs.length}>全选</Button><Button onClick={() => setSelectedSongs(new Set())} disabled={!selectedSongs.size}>取消选择</Button><Button variant="primary" onClick={() => void downloadBatch()} disabled={!selectedSongs.size || downloadBusy}><Icon name={downloadBusy ? 'spinner' : 'download'} />{downloadBusy ? '加入中…' : '批量下载'}</Button><Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={!selectedSongs.size || downloadBusy}>批量移除</Button></>}<Button onClick={() => { setBatchMode(value => !value); setSelectedSongs(new Set()) }} disabled={downloadBusy}>{batchMode ? '退出多选' : '多选操作'}</Button></>
  return <ViewFrame title={name} actions={<div className="react-view-header-actions">{listActions}{headerActions}</div>}><section className="react-content-card t-bg-panel react-playlist-page">{loading ? <Loading label="正在加载歌单…" /> : error ? <p className="react-error" role="alert">{error}</p> : <SongList songs={songs} listId={listId} selected={batchMode ? selectedSongs : undefined} onSelect={batchMode ? toggleSong : undefined} showFileMetadata={false} empty={listId === 'love' ? '还没有喜欢的歌曲，去搜索音乐吧' : '歌单还是空的，去搜索音乐吧'} />}<Modal open={confirmOpen} title="批量移除歌曲" onClose={() => setConfirmOpen(false)}><p>确定从“{name}”移除选中的 {selectedSongs.size} 首歌曲吗？</p><div className="react-dialog-actions"><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button variant="danger" onClick={() => void removeBatch()}>确认移除</Button></div></Modal><Modal open={renameOpen} title="重命名歌单" onClose={() => setRenameOpen(false)}><form className="react-dialog-form" onSubmit={submitRename}><label htmlFor="rename-list-name">新的歌单名称</label><input id="rename-list-name" value={renameValue} onChange={event => setRenameValue(event.target.value)} maxLength={80} required /><div className="react-dialog-actions"><Button type="button" onClick={() => setRenameOpen(false)}>取消</Button><Button variant="primary" type="submit">保存</Button></div></form></Modal><Modal open={deleteOpen} title="删除歌单" onClose={() => setDeleteOpen(false)}><p>确定删除歌单“{name}”吗？其中的歌曲也会从该歌单移除。</p><div className="react-dialog-actions"><Button type="button" onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" type="button" onClick={() => void confirmDelete()}>确认删除</Button></div></Modal></section></ViewFrame>
}

function LoveListView({ songs, loading, error }: { songs: Song[]; loading: boolean; error: string }) {
  return <SongCollectionView listId="love" name="我喜欢的音乐" songs={songs} loading={loading} error={error} />
}

function UserPlaylistView({ listId, list, loading, error }: { listId: string; list?: UserPlaylist; loading: boolean; error: string }) {
  const notify = usePlayerUiStore(state => state.notify)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const renameList = useLibraryStore(state => state.renameList)
  const deleteList = useLibraryStore(state => state.deleteList)
  useEffect(() => {
    if (!loading && !list) {
      notify('歌单不存在，已返回我喜欢的音乐')
      openFavoriteList('love')
    }
  }, [list, loading, notify, openFavoriteList])
  if (!list) return <ViewFrame title="歌单"><section className="react-content-card t-bg-panel">{loading ? <Loading label="正在加载歌单…" /> : <div className="react-empty"><Icon name="list" /><p>歌单不存在或已被删除</p><Button variant="primary" onClick={() => openFavoriteList('love')}>返回我喜欢的音乐</Button></div>}</section></ViewFrame>
  const name = String(list.name || '未命名歌单')
  return <SongCollectionView listId={listId} name={name} songs={list.list ?? []} loading={loading} error={error} onRename={nextName => renameList(listId, nextName)} onDelete={() => deleteList(listId)} />
}

export function FavoritesView() {
  const loveSongs = useLibraryStore(selectLoveList)
  const loading = useLibraryStore(state => state.loading)
  const error = useLibraryStore(state => state.error)
  const favoriteListId = usePlayerUiStore(state => state.favoriteListId)
  const list = useLibraryStore(state => selectUserLists(state).find(item => String(item.id) === favoriteListId))
  return favoriteListId === 'love' ? <LoveListView songs={loveSongs} loading={loading} error={error} /> : <UserPlaylistView listId={favoriteListId} list={list} loading={loading} error={error} />
}

export function SettingsView() {
  const settings = useSettingsStore(state => state.settings)
  const setSetting = useSettingsStore(state => state.setSetting)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const userName = useAuthStore(state => state.userName)
  const userLogin = useAuthStore(state => state.userLogin)
  const userLogout = useAuthStore(state => state.userLogout)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [accountError, setAccountError] = useState('')
  const login = async (event: FormEvent) => { event.preventDefault(); try { await userLogin(username, password); setAccountError('') } catch (e) { setAccountError(e instanceof Error ? e.message : '登录失败') } }
  const logout = async () => { await userLogout() }
  const toggle = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => setSetting(key, event.target.checked)
  return <ViewFrame title="设置"><section className="react-settings-grid"><section className="react-content-card t-bg-panel"><h2>外观与播放</h2><div className="react-settings-form"><div className="react-setting-field"><span>主题</span><SelectMenu label="主题" value={String(settings.appearance ?? 'system')} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={value => setSetting('appearance', value)} /></div><div className="react-setting-field"><span>强调色</span><SelectMenu label="强调色" value={String(settings.themeColor ?? 'netease')} options={[{ value: 'netease', label: '网易红' }, { value: 'emerald', label: '翡翠绿' }, { value: 'blue', label: '海洋蓝' }, { value: 'amber', label: '琥珀橙' }, { value: 'violet', label: '紫罗兰' }, { value: 'rose', label: '玫瑰粉' }]} onChange={value => setSetting('themeColor', value)} /></div><div className="react-setting-field"><span>默认音质</span><SelectMenu label="默认音质" value={String(settings.preferredQuality)} options={[{ value: '128k', label: '128K' }, { value: '320k', label: '320K' }, { value: 'flac', label: '无损 FLAC' }, { value: 'hires', label: 'Hi-Res' }]} onChange={value => setSetting('preferredQuality', value)} /></div><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.autoResume)} onChange={toggle('autoResume')} /><span>自动恢复上次播放进度</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableKeyboardShortcuts)} onChange={toggle('enableKeyboardShortcuts')} /><span>启用键盘快捷键</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.showLyricTranslation)} onChange={toggle('showLyricTranslation')} /><span>显示歌词翻译</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.showLyricRoma)} onChange={toggle('showLyricRoma')} /><span>显示罗马音 / 逐字歌词</span></label></div></section><section className="react-content-card t-bg-panel"><h2>缓存与播放策略</h2><div className="react-settings-form"><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enablePreloader)} onChange={toggle('enablePreloader')} /><span>预取下一首歌曲</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableAutoDegradeQuality)} onChange={toggle('enableAutoDegradeQuality')} /><span>播放失败时自动降级音质</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableAutoSwitchSource)} onChange={toggle('enableAutoSwitchSource')} /><span>解析失败时自动换源</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableServerCache)} onChange={toggle('enableServerCache')} /><span>播放后加入服务器缓存</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.enableCrossfade)} onChange={toggle('enableCrossfade')} /><span>切歌淡入淡出</span></label><label className="react-switch-row"><input type="checkbox" checked={Boolean(settings.keepScreenAwake)} onChange={toggle('keepScreenAwake')} /><span>播放时保持屏幕唤醒</span></label></div></section><section className="react-content-card t-bg-panel react-account-card"><div className="react-account-heading"><div><p className="react-eyebrow">ACCOUNT</p><h2>用户账户</h2><p>登录后同步歌单、收藏与播放记录</p></div><span className={`react-account-badge ${userAuthenticated ? 'is-active' : ''}`}><Icon name={userAuthenticated ? 'circle-check' : 'circle-user'} />{userAuthenticated ? '已登录' : '未登录'}</span></div>{userAuthenticated ? <div className="react-account-state"><Icon name="circle-check" /><div className="react-account-copy"><strong>{userName}</strong><span>当前账户已连接，可以同步你的音乐数据</span></div><Button onClick={() => void logout()}>退出账户</Button></div> : <form className="react-settings-form react-account-form" onSubmit={login}><label>用户名<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required /></label><label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>{accountError && <p className="react-error" role="alert">{accountError}</p>}<Button variant="primary" type="submit">登录账户</Button></form>}</section></section></ViewFrame>
}

type ImmersiveFooterHost = 'normal' | 'immersive'

export type ImmersiveLyricsProps = { open: boolean; footerHost: ImmersiveFooterHost; onFooterHostChange: (host: ImmersiveFooterHost) => void; onClose: () => void; onClosed?: () => void }

function lyricFocusClass(index: number, active: number): string {
  if (active < 0) return 'is-idle'
  const distance = Math.abs(index - active)
  if (distance === 0) return 'is-active'
  if (distance === 1) return 'is-adjacent'
  if (distance <= 3) return 'is-near'
  return 'is-distant'
}

export function ImmersiveLyricsView({ open, footerHost, onFooterHostChange, onClose, onClosed }: ImmersiveLyricsProps) {
  const song = usePlaybackStore(state => state.currentSong)
  const time = usePlaybackStore(state => (open ? state.currentTime : 0))
  const seek = usePlaybackStore(state => state.seek)
  const lines = useLyricStore(state => state.lines)
  const loading = useLyricStore(state => state.loading)
  const error = useLyricStore(state => state.error)
  const load = useLyricStore(state => state.load)
  const settings = useSettingsStore(state => state.settings)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const notify = usePlayerUiStore(state => state.notify)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<number | null>(null)
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([])
  const lyricsListRef = useRef<HTMLElement | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const [isClosing, setIsClosing] = useState(false)
  const [lyricsInputModality, setLyricsInputModality] = useState<'keyboard' | 'pointer'>(() => document.documentElement.dataset.playerInputModality === 'pointer' ? 'pointer' : 'keyboard')
  useEffect(() => { if (open) void load(song) }, [load, open, song])
  const active = useMemo(() => (open ? findActiveLyricIndex(lines, time) : -1), [lines, open, time])
  const finishClose = useCallback(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    const surface = dialog.querySelector<HTMLElement>('.react-immersive-lyrics')
    if (dialog.open) dialog.close()
    surface?.style.removeProperty('--react-immersive-scrollbar-gutter')
    const focusTarget = lastFocus.current
    const restoreFallback = () => document.querySelector<HTMLButtonElement>('.react-player-main > #player-footer .react-footer-cover-button')?.focus()
    if (focusTarget?.isConnected && focusTarget !== document.body && !dialog.contains(focusTarget) && !focusTarget.matches(':disabled')) focusTarget.focus()
    else if (document.querySelector('.react-player-main > #player-footer .react-footer-cover-button')) restoreFallback()
    else window.requestAnimationFrame(restoreFallback)
    lastFocus.current = null
    onFooterHostChange('normal')
    setIsClosing(false)
    onClosed?.()
  }, [onClosed, onFooterHostChange])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const surface = dialog.querySelector<HTMLElement>('.react-immersive-lyrics')
    const syncFooterPosition = () => {
      const bodyWidth = document.body.getBoundingClientRect().width
      const viewportWidth = window.innerWidth
      const scrollbarGutter = Math.max(0, viewportWidth - bodyWidth)
      surface?.style.setProperty('--react-immersive-scrollbar-gutter', `${scrollbarGutter}px`)
    }
    if (open) {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      setIsClosing(false)
    }
    if (open && !dialog.open) {
      lastFocus.current = consumeImmersiveLyricsTrigger() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      syncFooterPosition()
      dialog.showModal()
      onFooterHostChange('immersive')
      dialog.querySelector<HTMLButtonElement>('[data-immersive-close]')?.focus()
    } else if (open) {
      syncFooterPosition()
      onFooterHostChange('immersive')
    } else if (dialog.open && !isClosing) {
      setIsClosing(true)
      const closeDuration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220
      if (closeDuration === 0) finishClose()
      else closeTimer.current = window.setTimeout(finishClose, closeDuration)
    } else if (!open && !dialog.open) {
      onFooterHostChange('normal')
      onClosed?.()
    }
    if (open) {
      window.addEventListener('resize', syncFooterPosition)
      return () => window.removeEventListener('resize', syncFooterPosition)
    }
    return undefined
  }, [finishClose, isClosing, onClosed, onFooterHostChange, open])
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    if (dialogRef.current?.open) dialogRef.current.close()
    const focusTarget = lastFocus.current
    const restoreFallback = () => document.querySelector<HTMLButtonElement>('.react-player-main > #player-footer .react-footer-cover-button')?.focus()
    if (focusTarget?.isConnected && focusTarget !== document.body && !focusTarget.matches(':disabled')) focusTarget.focus()
    else window.requestAnimationFrame(restoreFallback)
    lastFocus.current = null
    onFooterHostChange('normal')
  }, [onFooterHostChange])
  useEffect(() => {
    if (active < 0) return
    const list = lyricsListRef.current
    const line = lineRefs.current[active]
    if (!list || !line) return
    const listRect = list.getBoundingClientRect()
    const lineRect = line.getBoundingClientRect()
    const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight)
    const targetTop = Math.min(maxScrollTop, Math.max(0, list.scrollTop + lineRect.top - listRect.top - (list.clientHeight - line.clientHeight) / 2))
    const startTop = list.scrollTop
    const distance = targetTop - startTop
    if (Math.abs(distance) < 1) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      list.scrollTop = targetTop
      return
    }
    const duration = 320
    let startTime = 0
    const step = (time: number) => {
      if (startTime === 0) startTime = time
      const progress = Math.min(1, (time - startTime) / duration)
      const eased = progress * progress * (3 - 2 * progress)
      list.scrollTop = startTop + distance * eased
      if (progress < 1) scrollFrameRef.current = window.requestAnimationFrame(step)
      else scrollFrameRef.current = null
    }
    scrollFrameRef.current = window.requestAnimationFrame(step)
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
    }
  }, [active, lines])
  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])
  const lyricStyle = { '--react-lyric-size': `${Math.max(.9, Number(settings.lyricFontSize || 1.25))}rem` } as CSSProperties
  const title = songTitle(song)
  const artwork = safeImageUrl(songImage(song))
  const immersiveStyle = {
    ...lyricStyle,
    '--react-immersive-art': `url("${artwork.replaceAll('"', '\\"')}")`,
  } as CSSProperties
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.()
  }
  const isLiked = useLibraryStore(state => isSongInLoveList(state, song))
  const toggleLike = async () => {
    if (!song) return
    try {
      if (isLiked) { await removeSong('love', song); notify('已取消喜欢') }
      else { await addSong('love', song); notify('已添加到喜欢') }
    } catch (error) { notify(error instanceof Error ? error.message : '喜欢操作失败') }
  }
  return <dialog ref={dialogRef} className={`react-immersive-lyrics-dialog ${isClosing ? 'is-closing' : ''}`} aria-labelledby="immersive-lyrics-title" onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={() => setLyricsInputModality('keyboard')}>
    <div className="react-immersive-lyrics" style={immersiveStyle} onPointerMoveCapture={() => setLyricsInputModality('pointer')} onPointerDownCapture={() => setLyricsInputModality('pointer')}>
      <header className="react-immersive-lyrics-header">
        <button type="button" className="react-immersive-nav-button" data-immersive-close aria-label="关闭沉浸式歌词" onClick={onClose}><Icon name="chevron-down" /></button>
        <button type="button" className="react-immersive-nav-button" aria-label="切换全屏" onClick={toggleFullscreen}><Icon name="expand" /></button>
      </header>
      <div className="react-immersive-lyrics-grid">
        <section className="react-immersive-cover-panel" aria-label={song ? `${title}封面` : '暂无歌曲'}>
          <div className="react-immersive-cover-wrap"><SafeImage className="react-immersive-cover" src={artwork} width="560" height="560" alt={song ? `${title}封面` : ''} /></div>
          <div className="react-immersive-meta"><div><h2 id="immersive-lyrics-title">{song ? title : '选择一首歌曲开始播放'}</h2><span>{song ? songArtist(song) : '沉浸式歌词'}</span></div><button type="button" className={`react-immersive-like ${isLiked ? 'is-active' : ''}`} aria-label={isLiked ? '取消喜欢' : '喜欢'} aria-pressed={isLiked} onClick={() => void toggleLike()}><Icon name="heart" /></button></div>
          {/* The normal footer is suppressed while this local transport stays
              under the artwork, matching the reference lyrics composition. */}
          <PlayerFooterBar variant="immersive" isActive={footerHost === 'immersive'} />
        </section>
        <section ref={lyricsListRef} className="react-immersive-lyrics-list" aria-label="歌词" aria-live="polite" data-input-modality={lyricsInputModality}>
          {loading ? <Loading label="正在加载歌词…" /> : error ? <p className="react-error" role="alert">{error}</p> : lines.length ? lines.map((line, index) => {
            const focusClass = lyricFocusClass(index, active)
            return <button type="button" key={`${line.time}-${index}`} ref={element => { lineRefs.current[index] = element }} className={focusClass} data-lyric-focus={focusClass.replace('is-', '')} aria-current={index === active ? 'true' : undefined} onClick={event => { seek(line.time); if (event.detail > 0) event.currentTarget.blur() }}><span>{line.text}</span>{Boolean(settings.showLyricTranslation) && line.translation && <small>{line.translation}</small>}{Boolean(settings.showLyricRoma) && line.roma && <small>{line.roma}</small>}</button>
          }) : <div className="react-empty"><Icon name="file-lines" /><p>暂无歌词</p></div>}
        </section>
      </div>
    </div>
  </dialog>
}

export function LyricsDialog(props: ImmersiveLyricsProps) {
  return <ImmersiveLyricsView {...props} />
}

function CommentItemView({ item, nested = false }: { item: CommentItem; nested?: boolean }) {
  const replies = Array.isArray(item.reply) ? item.reply : []
  const timestamp = item.timeStr || (item.time ? new Date(item.time).toLocaleString() : '')
  return <article className={`react-comment-item ${nested ? 'is-reply' : ''}`}><img src={safeImageUrl(item.avatar)} width="40" height="40" loading="lazy" alt={`${String(item.userName || '用户')}的头像`} /><div><header><strong>{String(item.userName || '用户')}</strong><small>{String(item.likedCount ?? 0)} 赞</small></header><p>{String(item.text || '')}</p><footer>{String(timestamp)}{item.location ? ` · ${String(item.location)}` : ''}</footer>{replies.length > 0 && <div className="react-comment-replies">{replies.map((reply, index) => <CommentItemView key={`${String(reply.userName)}-${index}`} item={reply} nested />)}</div>}</div></article>
}

export function CommentsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = usePlaybackStore(state => state.currentSong)
  const type = useCommentStore(state => state.type)
  const page = useCommentStore(state => state.page)
  const total = useCommentStore(state => state.total)
  const maxPage = useCommentStore(state => state.maxPage)
  const items = useCommentStore(state => state.items)
  const loading = useCommentStore(state => state.loading)
  const error = useCommentStore(state => state.error)
  const load = useCommentStore(state => state.load)
  const setType = useCommentStore(state => state.setType)
  const next = useCommentStore(state => state.next)
  const previous = useCommentStore(state => state.previous)
  useEffect(() => { if (open) void load(song, type, 1) }, [load, open, song])
  return <Modal open={open} title={song ? `${songTitle(song)} · 评论` : '评论'} onClose={onClose} className="react-comments-modal"><div className="react-comments-dialog"><div className="react-comment-tabs" role="tablist"><button type="button" role="tab" aria-selected={type === 'hot'} className={type === 'hot' ? 'is-active' : ''} onClick={() => setType('hot')}>热门</button><button type="button" role="tab" aria-selected={type === 'new'} className={type === 'new' ? 'is-active' : ''} onClick={() => setType('new')}>最新</button><span>{total ? `${total} 条` : ''}</span></div>{loading ? <Loading label="正在加载评论…" /> : error ? <p className="react-error" role="alert">{error}</p> : items.length ? <div className="react-comment-list">{items.map((item, index) => <CommentItemView key={`${String(item.userName)}-${String(item.time)}-${index}`} item={item} />)}</div> : <div className="react-empty"><Icon name="comments" /><p>暂无评论</p></div>}<nav className="react-comment-pagination" aria-label="评论分页"><button type="button" onClick={previous} disabled={loading || page <= 1}>上一页</button><span>第 {page} / {maxPage} 页</span><button type="button" onClick={next} disabled={loading || page >= maxPage}>下一页</button></nav></div></Modal>
}

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const login = useAuthStore(state => state.login)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await login(password); onClose() } catch (e) { setError(e instanceof Error ? e.message : '登录失败') } }
  return <Modal open={open} title="访问播放器" onClose={onClose}><form className="react-dialog-form" onSubmit={submit}><label htmlFor="player-password">访问密码</label><input id="player-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />{error && <p className="react-error" role="alert">{error}</p>}<Button variant="primary" type="submit">进入播放器</Button></form></Modal>
}

export function UserLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const userLogin = useAuthStore(state => state.userLogin)
  const pendingSong = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await userLogin(username, password); if (pendingSong) setDialog('addToList'); else onClose() } catch (e) { setError(e instanceof Error ? e.message : '登录失败') } }
  return <Modal open={open} title="登录用户账户" onClose={onClose}><form className="react-dialog-form" onSubmit={submit}><label htmlFor="user-name">用户名</label><input id="user-name" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /><label htmlFor="user-password">密码</label><input id="user-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />{error && <p className="react-error" role="alert">{error}</p>}<Button variant="primary" type="submit">登录</Button></form></Modal>
}

export function CreateListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createList = useLibraryStore(state => state.createList)
  const notify = usePlayerUiStore(state => state.notify)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const pendingSong = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<PlaylistIconKey>('music')
  useEffect(() => { if (open) { setName(''); setIcon('music') } }, [open])
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim()) return; try { const created = await createList(name.trim(), icon); setName(''); setIcon('music'); if (pendingSong) setDialog('addToList'); else { onClose(); openFavoriteList(String(created.id)) }; notify('歌单已创建') } catch (error) { notify(error instanceof Error ? error.message : '创建歌单失败') } }
  return <Modal open={open} title="新建歌单" onClose={onClose}><form className="react-dialog-form" onSubmit={submit}><label htmlFor="new-list-name">歌单名称</label><input id="new-list-name" value={name} onChange={event => setName(event.target.value)} required maxLength={80} /><fieldset className="react-playlist-icon-picker"><div className="react-playlist-icon-options" role="radiogroup" aria-label="选择歌单图标">{PLAYLIST_ICON_OPTIONS.map(option => <label className={`react-playlist-icon-option ${icon === option.key ? 'is-selected' : ''}`} key={option.key}><input type="radio" name="playlist-icon" value={option.key} aria-label={option.label} checked={icon === option.key} onChange={() => setIcon(option.key)} /><span className="react-playlist-icon-option-visual"><Icon name={option.key} /></span></label>)}</div></fieldset><Button variant="primary" type="submit">创建</Button></form></Modal>
}

export function AddToListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const loveSongs = useLibraryStore(selectLoveList)
  const userLists = useLibraryStore(selectUserLists)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const lists = useMemo(() => [
    { id: 'love', name: '我的收藏', icon: 'heart', songs: loveSongs },
    ...userLists.map(list => ({ id: String(list.id), name: list.name, icon: playlistIcon(list.icon), songs: list.list ?? [] })),
  ], [loveSongs, userLists])
  const toggleList = async (list: { id: string; name: string; songs: Song[] }) => {
    if (!song) return
    const included = list.songs.some(item => sameSong(item, song))
    try {
      if (included) { await removeSong(list.id, song); notify(`已从“${list.name}”移除`) }
      else { await addSong(list.id, song); notify(`已添加到“${list.name}”`) }
    } catch (error) { notify(error instanceof Error ? error.message : '歌单操作失败') }
  }
  return <Modal open={open} title="添加到歌单" onClose={onClose}><div className="react-add-to-list-dialog">{song && <p className="react-add-to-list-song"><SafeImage src={songImage(song)} width="44" height="44" alt="" /><span><strong>{songTitle(song)}</strong><small>{songArtist(song)}</small></span></p>}<div className="react-add-to-list-options">{lists.map((list, index) => { const included = Boolean(song && list.songs.some(item => sameSong(item, song))); return <button type="button" key={`${list.id}-${index}`} className={`react-add-to-list-option ${included ? 'is-included' : ''}`} aria-pressed={included} onClick={() => void toggleList(list)}><span><Icon name={list.icon} /><strong>{list.name}</strong><small>{list.songs.length} 首歌曲</small></span><Icon name={included ? 'check' : 'plus'} /></button> })}<Button type="button" className="react-add-to-list-create" onClick={() => setDialog('createList')}><Icon name="plus" />新建歌单</Button></div>{!song && <p className="react-empty-text">当前没有正在播放的歌曲</p>}</div></Modal>
}
