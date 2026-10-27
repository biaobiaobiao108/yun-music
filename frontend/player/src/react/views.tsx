import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import {
  loadPlaylistSongs,
  playerApi,
  PLAYLIST_ICON_OPTIONS,
  playlistIcon,
  type CommentItem,
  type PlaylistIconKey,
  type UserPlaylist,
} from './api'
import { Button, DescriptionDisclosure, Icon, Loading, Modal, SafeImage, SelectMenu, SongList } from './components'
import { consumeImmersiveLyricsTrigger, PlayerFooterBar } from './player_footer'
import { navigateToSongEntity, songEntityDetail } from './song_details'
import {
  isSongInLoveList,
  mediaLibraryItemKey,
  selectLoveList,
  selectUserLists,
  useAuthStore,
  useCacheStore,
  useCommentStore,
  useLibraryStore,
  useLyricStore,
  useMediaLibraryStore,
  usePlaybackStore,
  usePlayerUiStore,
  useSearchStore,
  useSettingsStore,
} from './store'
import type { PlayerDetail, PlayerTab, Song } from './types'
import { sameSong, songArtist, songImage, songKey, songTitle } from './types'
import { formatBytes, formatDate, safeImageUrl } from '../../../shared/src/runtime'
import { goBack } from './route_state'
import { ViewFrame } from './view_frame'
import { PlaylistDetailView } from './heavy_views'
import { getSessionGeneration } from './session'
import {
  buildRhythmPhrases,
  isRhythmCjkCharacter,
  rhythmGlyphFrame,
  rhythmGlyphLayoutScale,
  rhythmGlyphWidth,
  rhythmNeedsSmoothFrame,
  rhythmRowFrame,
  rhythmRowShape,
  rhythmSparkFrame,
  type RhythmGlyph,
  type RhythmPhrase,
} from './lyric_rhythm'
import { readPlaybackPosition } from './store/playback'
import type { LyricLine } from './types'

const RHYTHM_SPARK_ANGLES = [0, 60, 120, 180, 240, 300] as const

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
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
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

function SearchEntityGrid({
  items,
  kind,
  onOpen,
}: {
  items: Song[]
  kind: 'artist' | 'album' | 'playlist'
  onOpen: (detail: PlayerDetail) => void
}) {
  const mediaItems = useMediaLibraryStore(state => (kind === 'artist' ? state.artists : state.albums))
  const toggleMedia = useMediaLibraryStore(state => state.toggle)
  const userLists = useLibraryStore(selectUserLists)
  const toggleRemotePlaylist = useLibraryStore(state => state.toggleRemotePlaylist)
  const deleteList = useLibraryStore(state => state.deleteList)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const [busyKey, setBusyKey] = useState('')
  const favoriteController = useRef<AbortController | null>(null)
  useEffect(() => () => favoriteController.current?.abort(), [items, kind])
  const favoriteMediaKeys = useMemo(
    () => (kind === 'playlist' ? new Set<string>() : new Set(mediaItems.map(item => mediaLibraryItemKey(item, kind)))),
    [kind, mediaItems],
  )
  const favoritePlaylistKeys = useMemo(
    () => new Set(userLists.map(list => `${String(list.source || '')}:${String(list.sourceListId ?? '')}`)),
    [userLists],
  )
  if (!items.length)
    return (
      <div className="react-empty">
        <Icon name={kind === 'artist' ? 'user' : kind === 'album' ? 'compact-disc' : 'list'} />
        <p>没有找到匹配的结果</p>
      </div>
    )
  return (
    <div className="react-entity-grid">
      {items.map((item, index) => {
        const entityDetail =
          kind === 'playlist' ? null : songEntityDetail(item, kind, { allowGenericId: true, allowGenericName: true })
        const id = resultId(item, index, kind)
        const name = String(entityDetail?.name ?? item.name ?? item.artistName ?? item.singer ?? item.title ?? '未命名')
        const source = String(entityDetail?.source || item.source || 'wy')
        const subtitle =
          kind === 'artist'
            ? `${String(item.albumSize ?? 0)} 张专辑`
            : kind === 'album'
              ? String(item.artistName ?? item.singer ?? '未知歌手')
              : String(item.creator ?? item.artistName ?? '平台歌单')
        const favoriteKey = `${source}:${kind}:${id}`
        const isFavorite =
          kind === 'playlist'
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
          if (favoriteController.current) return
          if (!userAuthenticated) {
            setDialog('userLogin')
            notify('请先登录用户账户')
            return
          }
          const controller = new AbortController()
          const sessionGeneration = getSessionGeneration()
          favoriteController.current = controller
          setBusyKey(favoriteKey)
          try {
            const next =
              kind === 'playlist'
                ? await (async () => {
                    const collected = userLists.find(
                      list => String(list.source || '') === source && String(list.sourceListId ?? '') === id,
                    )
                    if (collected) {
                      await deleteList(String(collected.id))
                      return false
                    }
                    const songs = await loadPlaylistSongs(source, id, controller.signal)
                    controller.signal.throwIfAborted()
                    if (getSessionGeneration() !== sessionGeneration) throw new Error('登录账户已变化，请重新操作')
                    return toggleRemotePlaylist({ id, source, name, image: resultImage(item) }, songs)
                  })()
                : await toggleMedia(kind, item)
            notify(next ? `已收藏${kind === 'artist' ? '歌手' : kind === 'album' ? '专辑' : '歌单'}` : '已取消收藏')
          } catch (error) {
            if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '收藏操作失败')
          } finally {
            if (favoriteController.current === controller) favoriteController.current = null
            setBusyKey('')
          }
        }
        return (
          <article className="react-entity-card" key={`${source}:${id}`}>
            <button type="button" className="react-entity-open" onClick={open}>
              <SafeImage src={resultImage(item)} width="160" height="160" loading="lazy" alt={`${name}封面`} />
              <strong>{name}</strong>
              <small>{subtitle}</small>
            </button>
            <button
              type="button"
              className={`react-entity-favorite ${isFavorite ? 'is-active' : ''}`}
              aria-label={isFavorite ? `取消收藏${name}` : `收藏${name}`}
              aria-pressed={isFavorite}
              disabled={busyKey === favoriteKey}
              onClick={event => {
                event.stopPropagation()
                void toggleFavorite()
              }}
            >
              <Icon name="heart" />
            </button>
          </article>
        )
      })}
    </div>
  )
}

export function SearchDetailView({ detail }: { detail: PlayerDetail }) {
  return detail.kind === 'playlist' ? (
    <PlaylistDetailView key={`${detail.source}:${detail.id}`} detail={detail} />
  ) : (
    <EntityDetailView detail={detail} />
  )
}

function EntityDetailView({ detail }: { detail: PlayerDetail }) {
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
    setLoading(true)
    setError('')
    setLoadingMoreSongs(false)
    setLoadMoreError('')
    setSongs([])
    setSongPage(1)
    setSongTotal(0)
    setHasMoreSongs(false)
    setActiveTab('songs')
    const load = async () => {
      try {
        if (detail.kind === 'artist') {
          const [artist, songPayload] = await Promise.all([
            playerApi.artistDetail(detail.source, detail.id, controller.signal, {
              cacheKey: `artist:detail:${detail.source}:${detail.id}`,
              cacheTtlMs: 60_000,
            }),
            playerApi.artistSongs(detail.source, detail.id, order, 1, 40, controller.signal, {
              cacheKey: `artist:songs:${detail.source}:${detail.id}:${order}:1`,
              cacheTtlMs: 60_000,
            }),
          ])
          if (controller.signal.aborted) return
          const firstPage = extractSongPage(songPayload)
          setInfo(recordOf(artist))
          setSongs(firstPage.songs)
          setSongPage(firstPage.page)
          setSongTotal(firstPage.total)
          setHasMoreSongs(firstPage.hasMore)
        } else if (detail.kind === 'album') {
          const payload = await playerApi.albumSongs(detail.source, detail.id, controller.signal, {
            cacheKey: `album:songs:${detail.source}:${detail.id}`,
            cacheTtlMs: 60_000,
          })
          if (controller.signal.aborted) return
          setInfo(recordOf(payload))
          setSongs(extractSongs(payload))
        }
      } catch (cause) {
        if (!controller.signal.aborted && requestId === songRequestId.current)
          setError(cause instanceof Error ? cause.message : '详情加载失败')
      } finally {
        if (!controller.signal.aborted && requestId === songRequestId.current) setLoading(false)
      }
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
  const mediaKind = detail.kind === 'artist' ? 'artist' : 'album'
  const mediaItems = useMediaLibraryStore(state => (mediaKind === 'artist' ? state.artists : state.albums))
  const toggleMedia = useMediaLibraryStore(state => state.toggle)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const favoriteItem = useMemo<Song>(
    () => ({
      id: detail.id,
      source: detail.source,
      name: detail.name,
      singer: detail.kind === 'artist' ? detail.name : undefined,
      albumName: detail.kind === 'album' ? detail.name : undefined,
      picUrl: detail.image,
    }),
    [detail.id, detail.image, detail.kind, detail.name, detail.source],
  )
  const isDetailFavorite = mediaItems.some(
    item => mediaLibraryItemKey(item, mediaKind) === mediaLibraryItemKey(favoriteItem, mediaKind),
  )
  const toggleDetailFavorite = async () => {
    if (favoriteBusy || loading || error) return
    if (!userAuthenticated) {
      setDialog('userLogin')
      notify('请先登录用户账户')
      return
    }
    setFavoriteBusy(true)
    try {
      const next = await toggleMedia(mediaKind, favoriteItem)
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
      const payload = await playerApi.artistSongs(detail.source, detail.id, order, nextPage, 40, controller.signal, {
        cacheKey: `artist:songs:${detail.source}:${detail.id}:${order}:${nextPage}`,
        cacheTtlMs: 60_000,
      })
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
      if (!controller.signal.aborted && requestId === songRequestId.current)
        setLoadMoreError(cause instanceof Error ? cause.message : '加载更多歌曲失败')
    } finally {
      if (loadMoreController.current === controller) loadMoreController.current = null
      loadMoreInFlight.current = false
      if (requestId === songRequestId.current) setLoadingMoreSongs(false)
    }
  }, [detail.id, detail.kind, detail.source, hasMoreSongs, loading, loadingMoreSongs, order, songPage])
  useEffect(() => {
    loadMoreIntersectionActive.current = false
    const sentinel = loadMoreRef.current
    if (
      !sentinel ||
      detail.kind !== 'artist' ||
      activeTab !== 'songs' ||
      !hasMoreSongs ||
      loading ||
      loadingMoreSongs ||
      typeof IntersectionObserver === 'undefined'
    )
      return
    const root = sentinel.closest('.react-player-content')
    const observer = new IntersectionObserver(
      entries => {
        const entry = entries[0]
        if (!entry?.isIntersecting) {
          loadMoreIntersectionActive.current = false
          return
        }
        if (loadMoreIntersectionActive.current) return
        loadMoreIntersectionActive.current = true
        void loadMoreSongs()
      },
      { root, rootMargin: '0px 0px 420px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [activeTab, detail.kind, hasMoreSongs, loadMoreSongs, loading, loadingMoreSongs])
  useEffect(() => {
    if (detail.kind !== 'artist' || activeTab !== 'albums') return
    const controller = new AbortController()
    void playerApi
      .artistAlbums(detail.source, detail.id, 1, 40, controller.signal, {
        cacheKey: `artist:albums:${detail.source}:${detail.id}:1`,
        cacheTtlMs: 60_000,
      })
      .then(payload => {
        if (!controller.signal.aborted) setAlbums(extractSongs(payload))
      })
      .catch(() => {
        if (!controller.signal.aborted) setAlbums([])
      })
    return () => controller.abort()
  }, [activeTab, detail.id, detail.kind, detail.source])
  const name = String(info.name ?? info.artistName ?? info.albumName ?? info.title ?? detail.name ?? '详情')
  const image = safeImageUrl(songImage(info as Song), detail.image)
  const description = String(info.desc ?? info.description ?? info.intro ?? '')
  const loadedCountLabel = songTotal > 0 ? `${songs.length} / ${songTotal}` : `${songs.length}`
  return (
    <ViewFrame title={name} hideHeader>
      <section className="react-detail-header t-bg-panel">
        <button type="button" className="react-secondary-button" onClick={goBack}>
          <Icon name="arrow-left" />
          返回搜索结果
        </button>
        <div className="react-detail-hero">
          <SafeImage src={image} width="144" height="144" loading="lazy" alt={`${name}封面`} />
          <div>
            <h1>{name}</h1>
            {description && <DescriptionDisclosure text={description} />}
            <small>
              {detail.source.toUpperCase()} · {detail.kind === 'artist' ? loadedCountLabel : songs.length} 首歌曲
            </small>
            <button
              type="button"
              className={`react-detail-favorite ${isDetailFavorite ? 'is-active' : ''}`}
              aria-label={isDetailFavorite ? `取消收藏${name}` : `收藏${name}`}
              aria-pressed={isDetailFavorite}
              disabled={favoriteBusy || loading || Boolean(error)}
              onClick={() => void toggleDetailFavorite()}
            >
              <Icon name="heart" />
              {isDetailFavorite ? '已收藏' : '收藏'}
            </button>
          </div>
        </div>
      </section>
      {detail.kind === 'artist' && (
        <div className="react-detail-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'songs'}
            className={activeTab === 'songs' ? 'is-active' : ''}
            onClick={() => setActiveTab('songs')}
          >
            热门歌曲
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'albums'}
            className={activeTab === 'albums' ? 'is-active' : ''}
            onClick={() => setActiveTab('albums')}
          >
            专辑
          </button>
          {activeTab === 'songs' && (
            <span>
              <button type="button" className={order === 'hot' ? 'is-active' : ''} onClick={() => setOrder('hot')}>
                最热
              </button>
              <button type="button" className={order === 'time' ? 'is-active' : ''} onClick={() => setOrder('time')}>
                最新
              </button>
            </span>
          )}
        </div>
      )}
      <section className="react-content-card t-bg-panel">
        {loading ? (
          <Loading label="正在加载详情…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : detail.kind === 'artist' && activeTab === 'albums' ? (
          <SearchEntityGrid items={albums} kind="album" onOpen={next => setDetail(next)} />
        ) : (
          <>
            <SongList songs={songs} empty="暂无歌曲" />
            {detail.kind === 'artist' && (
              <div ref={loadMoreRef} className="react-load-more" role="status" aria-live="polite">
                <span role={loadMoreError ? 'alert' : undefined}>
                  {loadMoreError ||
                    (loadingMoreSongs
                      ? '正在加载更多歌曲…'
                      : hasMoreSongs
                        ? `继续下滑加载更多 · 已加载 ${loadedCountLabel} 首`
                        : `已加载全部 ${songs.length} 首歌曲`)}
                </span>
                {hasMoreSongs && (
                  <Button type="button" onClick={() => void loadMoreSongs()} disabled={loadingMoreSongs}>
                    <Icon name={loadingMoreSongs ? 'spinner' : 'arrow-down'} />
                    {loadingMoreSongs ? '加载中' : loadMoreError ? '重试' : '加载更多'}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </ViewFrame>
  )
}

export function SearchView({ detail = null }: { detail?: PlayerDetail | null } = {}) {
  const query = useSearchStore(state => state.query)
  const source = useSearchStore(state => state.source)
  const type = useSearchStore(state => state.type)
  const page = useSearchStore(state => state.page)
  const results = useSearchStore(state => state.results)
  const loading = useSearchStore(state => state.loading)
  const error = useSearchStore(state => state.error)
  const search = useSearchStore(state => state.search)
  const setQuery = useSearchStore(state => state.setQuery)
  const setSource = useSearchStore(state => state.setSource)
  const setType = useSearchStore(state => state.setType)
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const [input, setInput] = useState(query)
  useEffect(() => setInput(query), [query])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void search(input, 1)
  }
  const label = type === 'song' ? '单曲' : type === 'singer' ? '歌手' : type === 'album' ? '专辑' : '歌单'
  if (detail) return <SearchDetailView detail={detail} />
  const resultView =
    type === 'singer' ? (
      <SearchEntityGrid items={results} kind="artist" onOpen={setDetail} />
    ) : type === 'album' ? (
      <SearchEntityGrid items={results} kind="album" onOpen={setDetail} />
    ) : type === 'playlist' ? (
      <SearchEntityGrid items={results} kind="playlist" onOpen={setDetail} />
    ) : (
      <SongList songs={results} empty={query ? '没有找到匹配的歌曲' : '输入关键词开始搜索'} />
    )
  return (
    <ViewFrame title="搜索" hideHeader>
      <div className="react-search-page">
        <header className="react-search-page-heading">
          <div className="react-search-page-title">
            <p>
              搜索 · 找到 {results.length}{' '}
              {type === 'song' ? '首单曲' : type === 'singer' ? '位歌手' : type === 'album' ? '张专辑' : '个歌单'}
            </p>
            <h1>{query ? `“${query}”` : '搜索音乐'}</h1>
          </div>
          <form className="react-search-toolbar" onSubmit={submit}>
            <label htmlFor="player-search" className="sr-only">
              搜索音乐
            </label>
            <div className="react-global-search react-search-input">
              <Icon name="search" />
              <input
                id="player-search"
                value={input}
                onChange={event => {
                  setInput(event.target.value)
                  setQuery(event.target.value)
                }}
                placeholder="搜索音乐、歌手、专辑或歌单"
                autoComplete="off"
              />
              {input && (
                <button
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => {
                    setInput('')
                    setQuery('')
                  }}
                >
                  <Icon name="xmark" />
                </button>
              )}
            </div>
            <div className="react-search-source">
              <SelectMenu
                label="音源"
                value={source}
                options={[
                  { value: 'wy', label: '网易云' },
                  { value: 'tx', label: 'QQ音乐' },
                ]}
                onChange={setSource}
              />
            </div>
            <Button variant="primary" type="submit" disabled={loading} aria-label="搜索">
              <Icon name="search" />
            </Button>
          </form>
        </header>
        <div className="react-search-tabs" role="group" aria-label="搜索类型">
          {(
            [
              ['song', '单曲'],
              ['singer', '歌手'],
              ['album', '专辑'],
              ['playlist', '歌单'],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              aria-pressed={type === value}
              className={type === value ? 'is-active' : ''}
              onClick={() => setType(value)}
            >
              {text}
            </button>
          ))}
        </div>
        <section className="react-search-results">
          {loading ? (
            <Loading label="正在搜索…" />
          ) : error ? (
            <p className="react-error" role="alert">
              {error}
            </p>
          ) : (
            resultView
          )}
          {query && (
            <div className="react-pagination react-pagination-bottom">
              <button
                type="button"
                aria-label="上一页"
                disabled={page <= 1 || loading}
                onClick={() => void search(query, page - 1)}
              >
                <Icon name="chevron-left" />
              </button>
              <span>第 {page} 页</span>
              <button
                type="button"
                aria-label="下一页"
                disabled={!query || loading || results.length < 40}
                onClick={() => void search(query, page + 1)}
              >
                <Icon name="chevron-right" />
              </button>
            </div>
          )}
        </section>
      </div>
    </ViewFrame>
  )
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
  const selectedListSongs = useMemo(
    () => songs.filter(song => selectedSongs.has(songKey(song))),
    [selectedSongs, songs],
  )
  const hasSelection = selectedSongs.size > 0
  const toggleSong = (song: Song) =>
    setSelectedSongs(current => {
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
  const headerActions = (
    <>
      <Button
        variant="primary"
        className="react-icon-only-button"
        aria-label="随机漫游"
        onClick={playRandom}
        disabled={!songs.length}
      >
        <Icon name="shuffle" />
      </Button>
      {onRename && (
        <Button
          className="react-icon-only-button"
          aria-label="重命名歌单"
          onClick={() => {
            setRenameValue(name)
            setRenameOpen(true)
          }}
        >
          <Icon name="pen" />
        </Button>
      )}
      {onDelete && (
        <Button
          variant="danger"
          className="react-icon-only-button"
          aria-label="删除歌单"
          onClick={() => setDeleteOpen(true)}
        >
          <Icon name="trash" />
        </Button>
      )}
    </>
  )
  const batchActions = (
    <>
      <span className="react-header-selection-count" aria-live="polite">
        已选择 {selectedSongs.size} 首
      </span>
      <Button
        className="react-icon-only-button"
        aria-label={hasSelection ? '取消选择' : '全选'}
        onClick={() => (hasSelection ? setSelectedSongs(new Set()) : selectAll())}
        disabled={!songs.length}
      >
        <Icon name={hasSelection ? 'xmark' : 'check'} />
      </Button>
      <Button
        variant="primary"
        className="react-icon-only-button"
        aria-label={downloadBusy ? '正在加入下载队列' : '批量下载'}
        onClick={() => void downloadBatch()}
        disabled={!selectedSongs.size || downloadBusy}
      >
        <Icon name={downloadBusy ? 'spinner' : 'download'} />
      </Button>
      <Button
        variant="danger"
        className="react-icon-only-button"
        aria-label="批量移除"
        onClick={() => setConfirmOpen(true)}
        disabled={!selectedSongs.size || downloadBusy}
      >
        <Icon name="trash" />
      </Button>
      <Button
        className="react-icon-only-button"
        aria-label="退出多选"
        onClick={() => {
          setBatchMode(false)
          setSelectedSongs(new Set())
        }}
        disabled={downloadBusy}
      >
        <Icon name="xmark" />
      </Button>
    </>
  )
  const normalActions = (
    <>
      <Button
        className="react-icon-only-button"
        aria-label="多选操作"
        onClick={() => {
          setBatchMode(true)
          setSelectedSongs(new Set())
        }}
        disabled={downloadBusy}
      >
        <Icon name="list" />
      </Button>
      {headerActions}
    </>
  )
  return (
    <ViewFrame
      title={name}
      actions={
        <div className="react-view-header-actions react-playlist-header-actions">
          {batchMode ? batchActions : normalActions}
        </div>
      }
    >
      <section className="react-content-card t-bg-panel react-playlist-page">
        {loading ? (
          <Loading label="正在加载歌单…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : (
          <SongList
            songs={songs}
            listId={listId}
            selected={batchMode ? selectedSongs : undefined}
            onSelect={batchMode ? toggleSong : undefined}
            showFileMetadata={false}
            empty={listId === 'love' ? '还没有喜欢的歌曲，去搜索音乐吧' : '歌单还是空的，去搜索音乐吧'}
          />
        )}
        <Modal open={confirmOpen} title="批量移除歌曲" onClose={() => setConfirmOpen(false)}>
          <p>
            确定从“{name}”移除选中的 {selectedSongs.size} 首歌曲吗？
          </p>
          <div className="react-dialog-actions">
            <Button onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button variant="danger" onClick={() => void removeBatch()}>
              确认移除
            </Button>
          </div>
        </Modal>
        <Modal open={renameOpen} title="重命名歌单" onClose={() => setRenameOpen(false)}>
          <form className="react-dialog-form" onSubmit={submitRename}>
            <label className="sr-only" htmlFor="rename-list-name">
              歌单名称
            </label>
            <input
              id="rename-list-name"
              value={renameValue}
              onChange={event => setRenameValue(event.target.value)}
              maxLength={80}
              required
            />
            <div className="react-dialog-actions">
              <Button type="button" onClick={() => setRenameOpen(false)}>
                取消
              </Button>
              <Button variant="primary" type="submit">
                保存
              </Button>
            </div>
          </form>
        </Modal>
        <Modal open={deleteOpen} title="删除歌单" onClose={() => setDeleteOpen(false)}>
          <p>确定删除歌单“{name}”吗？其中的歌曲也会从该歌单移除。</p>
          <div className="react-dialog-actions">
            <Button type="button" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button variant="danger" type="button" onClick={() => void confirmDelete()}>
              确认删除
            </Button>
          </div>
        </Modal>
      </section>
    </ViewFrame>
  )
}

function LoveListView({ songs, loading, error }: { songs: Song[]; loading: boolean; error: string }) {
  return <SongCollectionView listId="love" name="我喜欢的音乐" songs={songs} loading={loading} error={error} />
}

function UserPlaylistView({
  listId,
  list,
  loading,
  error,
}: {
  listId: string
  list?: UserPlaylist
  loading: boolean
  error: string
}) {
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
  if (!list)
    return (
      <ViewFrame title="歌单">
        <section className="react-content-card t-bg-panel">
          {loading ? (
            <Loading label="正在加载歌单…" />
          ) : (
            <div className="react-empty">
              <Icon name="list" />
              <p>歌单不存在或已被删除</p>
              <Button variant="primary" onClick={() => openFavoriteList('love')}>
                返回我喜欢的音乐
              </Button>
            </div>
          )}
        </section>
      </ViewFrame>
    )
  const name = String(list.name || '未命名歌单')
  return (
    <SongCollectionView
      listId={listId}
      name={name}
      songs={list.list ?? []}
      loading={loading}
      error={error}
      onRename={nextName => renameList(listId, nextName)}
      onDelete={() => deleteList(listId)}
    />
  )
}

export function FavoritesView() {
  const loveSongs = useLibraryStore(selectLoveList)
  const loading = useLibraryStore(state => state.loading)
  const error = useLibraryStore(state => state.error)
  const favoriteListId = usePlayerUiStore(state => state.favoriteListId)
  const list = useLibraryStore(state => selectUserLists(state).find(item => String(item.id) === favoriteListId))
  return favoriteListId === 'love' ? (
    <LoveListView songs={loveSongs} loading={loading} error={error} />
  ) : (
    <UserPlaylistView listId={favoriteListId} list={list} loading={loading} error={error} />
  )
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
  const login = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await userLogin(username, password)
      setAccountError('')
    } catch (e) {
      setAccountError(e instanceof Error ? e.message : '登录失败')
    }
  }
  const logout = async () => {
    await userLogout()
  }
  const toggle = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) => setSetting(key, event.target.checked)
  return (
    <ViewFrame title="设置">
      <section className="react-settings-grid">
        <section className="react-content-card t-bg-panel">
          <h2>外观</h2>
          <div className="react-settings-form">
            <div className="react-setting-field">
              <span>外观模式</span>
              <SelectMenu
                label="外观模式"
                value={String(settings.appearance || 'system')}
                options={[
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '深色' },
                  { value: 'system', label: '跟随系统' },
                ]}
                onChange={value => setSetting('appearance', value)}
              />
            </div>
          </div>
        </section>
        <section className="react-content-card t-bg-panel">
          <h2>播放设置</h2>
          <div className="react-settings-form">
            <div className="react-setting-field">
              <span>默认音质</span>
              <SelectMenu
                label="默认音质"
                value={String(settings.preferredQuality)}
                options={[
                  { value: '128k', label: '128K' },
                  { value: '320k', label: '320K' },
                  { value: 'flac', label: '无损 FLAC' },
                  { value: 'hires', label: 'Hi-Res' },
                ]}
                onChange={value => setSetting('preferredQuality', value)}
              />
            </div>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.autoResume)} onChange={toggle('autoResume')} />
              <span>自动恢复上次播放进度</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableKeyboardShortcuts)}
                onChange={toggle('enableKeyboardShortcuts')}
              />
              <span>启用键盘快捷键</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.showLyricTranslation)}
                onChange={toggle('showLyricTranslation')}
              />
              <span>显示歌词翻译</span>
            </label>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.showLyricRoma)} onChange={toggle('showLyricRoma')} />
              <span>显示罗马音 / 逐字歌词</span>
            </label>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.keepScreenAwake)} onChange={toggle('keepScreenAwake')} />
              <span>播放时保持屏幕唤醒</span>
            </label>
          </div>
        </section>
        <section className="react-content-card t-bg-panel">
          <h2>缓存与播放策略</h2>
          <div className="react-settings-form">
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.enablePreloader)} onChange={toggle('enablePreloader')} />
              <span>预取下一首歌曲</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableAutoDegradeQuality)}
                onChange={toggle('enableAutoDegradeQuality')}
              />
              <span>播放失败时自动降级音质</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableAutoSwitchSource)}
                onChange={toggle('enableAutoSwitchSource')}
              />
              <span>解析失败时自动换源</span>
            </label>
            <label className="react-switch-row">
              <input
                type="checkbox"
                checked={Boolean(settings.enableServerCache)}
                onChange={toggle('enableServerCache')}
              />
              <span>播放后加入服务器缓存</span>
            </label>
            <label className="react-switch-row">
              <input type="checkbox" checked={Boolean(settings.enableCrossfade)} onChange={toggle('enableCrossfade')} />
              <span>切歌淡入淡出</span>
            </label>
          </div>
        </section>
        <section className="react-content-card t-bg-panel react-account-card">
          <div className="react-account-heading">
            <div>
              <p className="react-eyebrow">ACCOUNT</p>
              <h2>用户账户</h2>
              <p>登录后同步歌单、收藏与播放记录</p>
            </div>
            <span className={`react-account-badge ${userAuthenticated ? 'is-active' : ''}`}>
              <Icon name={userAuthenticated ? 'circle-check' : 'circle-user'} />
              {userAuthenticated ? '已登录' : '未登录'}
            </span>
          </div>
          {userAuthenticated ? (
            <div className="react-account-state">
              <Icon name="circle-check" />
              <div className="react-account-copy">
                <strong>{userName}</strong>
                <span>当前账户已连接，可以同步你的音乐数据</span>
              </div>
              <Button onClick={() => void logout()}>退出账户</Button>
            </div>
          ) : (
            <form className="react-settings-form react-account-form" onSubmit={login}>
              <label>
                用户名
                <input
                  value={username}
                  onChange={event => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              {accountError && (
                <p className="react-error" role="alert">
                  {accountError}
                </p>
              )}
              <Button variant="primary" type="submit">
                登录账户
              </Button>
            </form>
          )}
        </section>
      </section>
    </ViewFrame>
  )
}

type ImmersiveFooterHost = 'normal' | 'immersive'

export type ImmersiveLyricsProps = {
  open: boolean
  footerHost: ImmersiveFooterHost
  onFooterHostChange: (host: ImmersiveFooterHost) => void
  onClose: () => void
  onClosed?: () => void
}

function RhythmLyrics({
  open,
  lines,
  loading,
  error,
  showTranslation,
  showRoma,
  seek,
}: {
  open: boolean
  lines: LyricLine[]
  loading: boolean
  error: string
  showTranslation: boolean
  showRoma: boolean
  seek: (time: number) => void
}) {
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const currentTime = usePlaybackStore(state => state.currentTime)
  const duration = usePlaybackStore(state => state.duration)
  const listRef = useRef<HTMLElement | null>(null)
  const focusRef = useRef(-1)
  const [focus, setFocus] = useState(-1)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [viewport, setViewport] = useState({ width: 960, height: 600 })
  const availableWidth = Math.max(1, Math.min(viewport.width * 0.86, viewport.width - 32))
  const targetFontSize = Math.min(88, Math.max(26, viewport.width * 0.06875))
  const maxPhraseWidth = availableWidth / (targetFontSize * 1.55)

  useEffect(() => {
    const list = listRef.current
    if (!open || !list) return
    const measure = () => {
      const width = list.clientWidth
      const height = list.clientHeight
      setViewport(previous => (previous.width === width && previous.height === height ? previous : { width, height }))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(list)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open])

  const layouts = useMemo(
    () =>
      lines.map((line, index) =>
        buildRhythmPhrases(
          line,
          lines[index + 1]?.time ?? (duration > line.time ? duration : line.time + 4),
          4,
          maxPhraseWidth,
        ),
      ),
    [duration, lines, maxPhraseWidth],
  )
  const updateAt = useCallback(
    (time: number) => {
      const index = findActiveLyricIndex(lines, time)
      if (focusRef.current !== index) {
        focusRef.current = index
        setFocus(index)
      }
      const reduced = reducedMotion
      const previous = listRef.current?.querySelector<HTMLElement>('.react-rhythm-previous')
      if (previous) {
        const elapsed = Math.min(1, Math.max(0, (time - Number(previous.dataset.lineStart)) / 0.4))
        const opacity = reduced ? 0 : (1 - elapsed) ** 3
        previous.style.opacity = String(opacity)
        previous.style.transform = reduced ? 'none' : `translateY(${(-12 * (1 - opacity)).toFixed(2)}px)`
      }
      const previousHidden = previous && Number(previous.style.opacity) <= 0.001
      listRef.current?.querySelectorAll<HTMLElement>('.react-rhythm-phrase').forEach(phrase => {
        if (previousHidden && previous?.contains(phrase)) return
        const start = Number(phrase.dataset.start)
        const side = Number(phrase.dataset.side)
        const settledKey = `${start}:${side}:${viewport.width}:${reduced}`
        if (time >= start + 1.5 && phrase.dataset.rhythmSettled === settledKey) return
        if (time >= start + 1.5) phrase.dataset.rhythmSettled = settledKey
        else delete phrase.dataset.rhythmSettled
        const frame = rhythmRowFrame(start, time, side)
        const opacity = reduced ? (time >= start ? 1 : 0) : frame.opacity
        phrase.style.opacity = String(opacity)
        if (!phrase.closest('.react-rhythm-previous')) {
          const visible = opacity > 0.01
          if (phrase.tabIndex !== (visible ? 0 : -1)) phrase.tabIndex = visible ? 0 : -1
          if (visible && phrase.hasAttribute('aria-hidden')) phrase.removeAttribute('aria-hidden')
          else if (!visible && !phrase.hasAttribute('aria-hidden')) phrase.setAttribute('aria-hidden', 'true')
        }
        phrase.style.transform = reduced
          ? 'none'
          : `translate(${(Number(phrase.dataset.offset) + frame.x).toFixed(2)}px, ${Number(phrase.dataset.y).toFixed(2)}px) scale(${(Number(phrase.dataset.scale) * frame.scale).toFixed(3)})`
      })
      const words = listRef.current?.querySelectorAll<HTMLElement>('.react-rhythm-word')
      const layoutKey = `${viewport.width}:${viewport.height}`
      if (words?.length && Array.from(words).some(word => word.dataset.spaceKey !== layoutKey)) {
        const metrics = Array.from(words, word => {
          const next = word.nextElementSibling
          const nextWord = next instanceof HTMLElement && next.classList.contains('react-rhythm-word') ? next : null
          return {
            word,
            width: word.offsetWidth,
            scale: Number(word.dataset.layoutScale),
            nextWidth: nextWord?.offsetWidth ?? 0,
            nextScale: Number(nextWord?.dataset.layoutScale ?? 1),
            gap: Number(word.dataset.fontSize) * 0.08,
            hasNext: Boolean(nextWord),
          }
        })
        for (const metric of metrics) {
          const growth = (metric.width * (metric.scale - 1) + metric.nextWidth * (metric.nextScale - 1)) / 2
          const margin = metric.hasNext ? Math.max(metric.gap * 2, growth + metric.gap) : 0
          metric.word.style.marginInlineEnd = `${margin.toFixed(2)}px`
          metric.word.dataset.spaceKey = layoutKey
        }
      }
      let activeSparks = 0
      for (let index = (words?.length ?? 0) - 1; index >= 0; index -= 1) {
        const word = words![index]!
        if (previousHidden && previous?.contains(word)) continue
        const start = Number(word.dataset.start)
        const length = Number(word.dataset.duration)
        const lyricWord = {
          text: word.textContent ?? '',
          time: start,
          duration: length,
          spark: word.dataset.spark === 'true',
        }
        const seed = Number(word.dataset.seed)
        const wordIndex = Number(word.dataset.index)
        const end = Math.max(start + length, start + 0.15)
        const after = time - end
        const settledAt = end + 5
        const settledKey = `${start}:${length}:${seed}:${wordIndex}:${viewport.width}:${viewport.height}:${reduced}`
        if (time < start - 0.08 && word.style.opacity === '0' && !word.dataset.sparkActive) continue
        if (time >= settledAt && word.dataset.rhythmSettled === settledKey) continue
        if (time >= settledAt) word.dataset.rhythmSettled = settledKey
        else delete word.dataset.rhythmSettled
        const driftFrame = String(Math.floor(time * 10))
        if (after > 0.9 && word.dataset.driftFrame === driftFrame) continue
        if (after > 0.9) word.dataset.driftFrame = driftFrame
        else delete word.dataset.driftFrame
        const frame = rhythmGlyphFrame(lyricWord, time, seed, wordIndex)
        word.style.setProperty('--rhythm-light', frame.fill.toFixed(3))
        if (reduced) {
          word.style.opacity = time >= start ? '0.8' : '0'
          word.style.transform = 'none'
          word.style.filter = 'none'
          word.style.textShadow = 'none'
          delete word.dataset.sparkActive
          continue
        }
        word.style.opacity = String(frame.opacity)
        const motionScale = Math.min(1, viewport.width / 600)
        word.style.transform = `translate(${(frame.x * motionScale).toFixed(2)}px, ${(frame.y * motionScale).toFixed(2)}px) rotate(${frame.rotation.toFixed(2)}deg) scale(${frame.scale.toFixed(3)})`
        word.style.filter = frame.blur > 0.3 ? `blur(${frame.blur.toFixed(2)}px)` : 'none'
        word.style.textShadow =
          frame.glow > 0.01
            ? `0 0 ${(frame.glow * 0.24).toFixed(2)}em color-mix(in srgb, var(--app-accent, #f42f4c) ${Math.round(frame.glow * 72)}%, transparent)`
            : 'none'
        const spark =
          activeSparks < 4 ? rhythmSparkFrame(lyricWord, time, seed, wordIndex, word.dataset.final === 'true') : null
        if (spark) {
          activeSparks += 1
          word.dataset.sparkActive = 'true'
          const finalSpark = word.dataset.final === 'true'
          word.querySelectorAll<HTMLElement>('.react-rhythm-spark-star').forEach(star => {
            const angle = Number(star.dataset.angle)
            const distance = 0.12 + spark.spread * (finalSpark ? 1.3 : 1.05)
            const size = Number(star.dataset.size ?? 1)
            star.style.opacity = spark.opacity.toFixed(3)
            star.style.transform = `translate(-50%, -50%) rotate(${(angle + spark.rotation).toFixed(1)}deg) translateY(-${distance.toFixed(2)}em) rotate(${-angle}deg) scale(${(spark.scale * size).toFixed(2)})`
          })
        } else if (word.dataset.sparkActive) {
          delete word.dataset.sparkActive
        }
      }
      listRef.current?.querySelectorAll<HTMLElement>('.react-rhythm-char').forEach(character => {
        if (previousHidden && previous?.contains(character)) return
        const start = Number(character.dataset.start)
        const duration = Math.max(0.2, Math.min(0.9, Number(character.dataset.duration)))
        const elapsed = time - start
        const settledKey = `${start}:${duration}:${reduced}`
        if (elapsed >= duration * 2.2 && character.dataset.rhythmSettled === settledKey) return
        if (elapsed >= duration * 2.2) character.dataset.rhythmSettled = settledKey
        else delete character.dataset.rhythmSettled
        const pulse =
          elapsed < 0
            ? 0
            : elapsed <= duration
              ? Math.sin((elapsed / duration) * Math.PI)
              : 0.25 * Math.min(1, Math.max(0, (elapsed - duration) / (duration * 1.2)))
        character.style.transform = reduced ? 'none' : `scale(${(1 + pulse * 0.15).toFixed(3)})`
      })
    },
    [lines, reducedMotion, viewport.height, viewport.width],
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const refresh = () => setReducedMotion(media.matches)
    media.addEventListener('change', refresh)
    refresh()
    return () => media.removeEventListener('change', refresh)
  }, [])

  useEffect(() => {
    if (!open) return
    let previousTime = Number.NaN
    let frame = 0
    let timer = 0
    const tick = () => {
      frame = 0
      timer = 0
      const time = readPlaybackPosition() ?? usePlaybackStore.getState().currentTime
      if (time !== previousTime) {
        previousTime = time
        updateAt(time)
      }
      const index = findActiveLyricIndex(lines, time)
      const activePhrases = layouts[index] ?? []
      if (rhythmNeedsSmoothFrame(activePhrases, time)) frame = window.requestAnimationFrame(tick)
      else timer = window.setTimeout(tick, 100)
    }
    if (!isPlaying || reducedMotion || !lines.length) return
    tick()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      if (timer) window.clearTimeout(timer)
    }
  }, [isPlaying, layouts, lines, open, reducedMotion, updateAt])

  useEffect(() => {
    if (open && (!isPlaying || reducedMotion)) updateAt(currentTime)
  }, [currentTime, isPlaying, open, reducedMotion, updateAt])

  useEffect(() => {
    if (open) updateAt(readPlaybackPosition() ?? usePlaybackStore.getState().currentTime)
  }, [focus, layouts, open, updateAt, viewport])

  const displayIndex = Math.max(0, focus)
  const renderPhrases = (
    rows: RhythmPhrase[],
    lineTime: number,
    keyPrefix: string,
    previous = false,
    seekable = true,
    sparks = true,
  ) => {
    const lastSpark = sparks
      ? rows.flatMap(phrase => phrase.glyphs).findLast(glyph => glyph.spark && /[\p{L}\p{N}]/u.test(glyph.text))
      : undefined
    const widest = Math.max(
      1,
      ...rows.map(phrase => phrase.glyphs.reduce((sum, glyph) => sum + rhythmGlyphWidth(glyph.text), 0)),
    )
    const fontSize = Math.max(
      14,
      Math.min(
        targetFontSize,
        availableWidth / (widest * 1.55),
        (viewport.height * 0.68) / (Math.max(1, rows.length) * 1.55),
      ),
    )
    return rows.map((phrase, phraseIndex) => {
      const shape = rhythmRowShape(lineTime, phraseIndex)
      return (
        <button
          type="button"
          className="react-rhythm-phrase"
          key={`${keyPrefix}-${phrase.time}-${phraseIndex}`}
          data-start={phrase.time}
          data-side={shape.side}
          data-offset={shape.offset * Math.min(1, viewport.width / 600)}
          data-y={(phraseIndex - (rows.length - 1) / 2) * 2.5}
          data-scale={shape.scale}
          aria-label={phrase.glyphs.map(glyph => glyph.text).join('')}
          aria-hidden={previous || undefined}
          disabled={previous || !seekable}
          style={{ fontSize: `${fontSize}px` }}
          onClick={seekable ? () => seek(phrase.time) : undefined}
        >
          {phrase.glyphs
            .reduce<RhythmGlyph[][]>((groups, glyph) => {
              const previousGroup = groups.at(-1)
              if (glyph.group !== undefined && previousGroup?.[0]?.group === glyph.group) previousGroup.push(glyph)
              else groups.push([glyph])
              return groups
            }, [])
            .map((group, groupIndex) => {
              const first = group[0]!
              const groupId = first.group ?? groupIndex
              return (
                <span
                  className="react-rhythm-word"
                  key={`${first.groupTime ?? first.time}-${groupId}`}
                  data-start={first.groupTime ?? first.time}
                  data-duration={first.groupDuration ?? first.duration}
                  data-seed={lineTime}
                  data-index={groupId}
                  data-spark={sparks && first.groupSpark ? 'true' : undefined}
                  data-final={sparks && lastSpark && group.includes(lastSpark) ? 'true' : undefined}
                  data-layout-scale={rhythmGlyphLayoutScale(lineTime, groupId)}
                  data-font-size={fontSize}
                >
                  {sparks && first.groupSpark && (
                    <span className="react-rhythm-spark" aria-hidden="true">
                      {RHYTHM_SPARK_ANGLES.map((angle, sparkIndex) => (
                        <i
                          className="react-rhythm-spark-star"
                          key={angle}
                          data-angle={angle}
                          data-size={sparkIndex % 3 === 1 ? 0.68 : 1}
                        />
                      ))}
                    </span>
                  )}
                  {isRhythmCjkCharacter(first.text) ? (
                    <span
                      className="react-rhythm-char"
                      data-start={first.time}
                      data-duration={first.duration}
                      aria-hidden="true"
                    >
                      {group.map(glyph => glyph.text).join('')}
                    </span>
                  ) : (
                    group.map(glyph => glyph.text).join('')
                  )}
                </span>
              )
            })}
        </button>
      )
    })
  }
  const activeLine = focus >= 0 ? lines[focus] : undefined
  const translation = showTranslation ? activeLine?.translation : undefined
  const secondary = translation ? activeLine?.text : showRoma ? activeLine?.roma : undefined

  return (
    <>
      <div className="react-immersive-lyrics-grid">
        <section ref={listRef} className="react-immersive-lyrics-list" aria-label="歌词">
          {loading ? (
            <Loading label="正在加载歌词…" />
          ) : error ? (
            <p className="react-error" role="alert">
              {error}
            </p>
          ) : lines.length ? (
            <>
              {focus > 0 && (
                <div
                  className="react-rhythm-phrases react-rhythm-previous"
                  data-line-start={lines[focus]?.time}
                  aria-hidden="true"
                >
                  {renderPhrases(layouts[focus - 1] ?? [], lines[focus - 1]?.time ?? 0, `line-${focus - 1}`, true)}
                </div>
              )}
              <div className="react-rhythm-phrases react-rhythm-current">
                {renderPhrases(layouts[displayIndex] ?? [], lines[displayIndex]?.time ?? 0, `line-${displayIndex}`)}
              </div>
            </>
          ) : (
            <div className="react-empty">
              <Icon name="file-lines" />
              <p>暂无歌词</p>
            </div>
          )}
        </section>
      </div>
      <div className="react-immersive-lyrics-track-meta" aria-live="polite">
        {activeLine && <strong>{translation || activeLine.text}</strong>}
        {secondary && <small>{secondary}</small>}
      </div>
    </>
  )
}

function ScrollingLyrics({
  lines,
  loading,
  error,
  showTranslation,
  showRoma,
  seek,
}: {
  lines: LyricLine[]
  loading: boolean
  error: string
  showTranslation: boolean
  showRoma: boolean
  seek: (time: number) => void
}) {
  const currentTime = usePlaybackStore(state => state.currentTime)
  const activeIndex = findActiveLyricIndex(lines, currentTime)
  const listRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!list || !active) return
    const center = (smooth: boolean) => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      list.scrollTo({
        top: active.offsetTop - list.offsetTop - (list.clientHeight - active.offsetHeight) / 2,
        behavior: smooth && !reduced ? 'smooth' : 'auto',
      })
    }
    center(true)
    let width = list.clientWidth
    let height = list.clientHeight
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (width === list.clientWidth && height === list.clientHeight) return
            width = list.clientWidth
            height = list.clientHeight
            center(false)
          })
    observer?.observe(list)
    return () => observer?.disconnect()
  }, [activeIndex, lines])

  return (
    <div className="react-immersive-lyrics-grid react-scrolling-lyrics-grid">
      <section ref={listRef} className="react-immersive-lyrics-list react-scrolling-lyrics" aria-label="滚动歌词">
        {loading ? (
          <Loading label="正在加载歌词…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : lines.length ? (
          lines.map((line, index) => (
            <button
              key={`${line.time}-${index}`}
              type="button"
              className={index === activeIndex ? 'is-active' : ''}
              aria-current={index === activeIndex ? 'true' : undefined}
              onClick={() => seek(line.time)}
            >
              <span>{line.text}</span>
              {showTranslation && line.translation && <small>{line.translation}</small>}
              {showRoma && line.roma && <small>{line.roma}</small>}
            </button>
          ))
        ) : (
          <div className="react-empty">
            <Icon name="file-lines" />
            <p>暂无歌词</p>
          </div>
        )}
      </section>
    </div>
  )
}

export function ImmersiveLyricsView({ open, footerHost, onFooterHostChange, onClose, onClosed }: ImmersiveLyricsProps) {
  const song = usePlaybackStore(state => state.currentSong)
  const seek = usePlaybackStore(state => state.seek)
  const lines = useLyricStore(state => state.lines)
  const loading = useLyricStore(state => state.loading)
  const error = useLyricStore(state => state.error)
  const load = useLyricStore(state => state.load)
  const settings = useSettingsStore(state => state.settings)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [isClosing, setIsClosing] = useState(false)
  const [lyricMode, setLyricMode] = useState<'rhythm' | 'scroll'>('rhythm')
  useEffect(() => {
    if (open) void load(song)
  }, [load, open, song])
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
    const restoreFallback = () =>
      document
        .querySelector<HTMLButtonElement>('.react-player-main > #player-footer .react-footer-cover-button')
        ?.focus()
    if (
      focusTarget?.isConnected &&
      focusTarget !== document.body &&
      !dialog.contains(focusTarget) &&
      !focusTarget.matches(':disabled')
    )
      focusTarget.focus()
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
      lastFocus.current =
        consumeImmersiveLyricsTrigger() ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      syncFooterPosition()
      dialog.showModal()
      onFooterHostChange('immersive')
      surface?.focus({ preventScroll: true })
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
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
      if (dialogRef.current?.open) dialogRef.current.close()
      const focusTarget = lastFocus.current
      const restoreFallback = () =>
        document
          .querySelector<HTMLButtonElement>('.react-player-main > #player-footer .react-footer-cover-button')
          ?.focus()
      if (focusTarget?.isConnected && focusTarget !== document.body && !focusTarget.matches(':disabled'))
        focusTarget.focus()
      else window.requestAnimationFrame(restoreFallback)
      lastFocus.current = null
      onFooterHostChange('normal')
    },
    [onFooterHostChange],
  )
  const lyricStyle = {
    '--react-lyric-size': `${Math.max(0.9, Number(settings.lyricFontSize || 1.25))}rem`,
  } as CSSProperties
  const title = songTitle(song)
  const artwork = safeImageUrl(songImage(song))
  const immersiveStyle = {
    ...lyricStyle,
    '--react-immersive-art': `url("${artwork.replaceAll('"', '\\"')}")`,
  } as CSSProperties
  return (
    <dialog
      ref={dialogRef}
      className={`react-immersive-lyrics-dialog ${isClosing ? 'is-closing' : ''}`}
      aria-label={song ? `${title} 歌词` : '沉浸式歌词'}
      onCancel={event => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="react-immersive-lyrics" style={immersiveStyle} tabIndex={-1}>
        <header className="react-immersive-lyrics-header">
          <button
            type="button"
            className="react-immersive-nav-button"
            data-immersive-close
            aria-label="关闭沉浸式歌词"
            onClick={onClose}
          >
            <Icon name="chevron-down" />
          </button>
          <button
            type="button"
            className="react-lyrics-mode"
            aria-label={lyricMode === 'rhythm' ? '当前为律动歌词，切换到滚动歌词' : '当前为滚动歌词，切换到律动歌词'}
            onClick={() => setLyricMode(mode => (mode === 'rhythm' ? 'scroll' : 'rhythm'))}
          >
            {lyricMode === 'rhythm' ? <Icon name="music" /> : <Icon name="list" />}
          </button>
        </header>
        {lyricMode === 'rhythm' ? (
          <RhythmLyrics
            open={open}
            lines={lines}
            loading={loading}
            error={error}
            showTranslation={Boolean(settings.showLyricTranslation)}
            showRoma={Boolean(settings.showLyricRoma)}
            seek={seek}
          />
        ) : (
          <ScrollingLyrics
            lines={lines}
            loading={loading}
            error={error}
            showTranslation={Boolean(settings.showLyricTranslation)}
            showRoma={Boolean(settings.showLyricRoma)}
            seek={seek}
          />
        )}
        <PlayerFooterBar variant="immersive" isActive={footerHost === 'immersive'} />
      </div>
    </dialog>
  )
}

export function LyricsDialog(props: ImmersiveLyricsProps) {
  return <ImmersiveLyricsView {...props} />
}

function CommentItemView({ item, nested = false }: { item: CommentItem; nested?: boolean }) {
  const replies = Array.isArray(item.reply) ? item.reply : []
  const timestamp = item.timeStr || (item.time ? new Date(item.time).toLocaleString() : '')
  return (
    <article className={`react-comment-item ${nested ? 'is-reply' : ''}`}>
      <img
        src={safeImageUrl(item.avatar)}
        width="40"
        height="40"
        loading="lazy"
        alt={`${String(item.userName || '用户')}的头像`}
      />
      <div>
        <header>
          <strong>{String(item.userName || '用户')}</strong>
          <small>{String(item.likedCount ?? 0)} 赞</small>
        </header>
        <p>{String(item.text || '')}</p>
        <footer>
          {String(timestamp)}
          {item.location ? ` · ${String(item.location)}` : ''}
        </footer>
        {replies.length > 0 && (
          <div className="react-comment-replies">
            {replies.map((reply, index) => (
              <CommentItemView key={`${String(reply.userName)}-${index}`} item={reply} nested />
            ))}
          </div>
        )}
      </div>
    </article>
  )
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
  useEffect(() => {
    if (open) void load(song, type, 1)
  }, [load, open, song])
  return (
    <Modal
      open={open}
      title={song ? `${songTitle(song)} · 评论` : '评论'}
      onClose={onClose}
      className="react-comments-modal"
    >
      <div className="react-comments-dialog">
        <div className="react-comment-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={type === 'hot'}
            className={type === 'hot' ? 'is-active' : ''}
            onClick={() => setType('hot')}
          >
            热门
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={type === 'new'}
            className={type === 'new' ? 'is-active' : ''}
            onClick={() => setType('new')}
          >
            最新
          </button>
          <span>{total ? `${total} 条` : ''}</span>
        </div>
        {loading ? (
          <Loading label="正在加载评论…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : items.length ? (
          <div className="react-comment-list">
            {items.map((item, index) => (
              <CommentItemView key={`${String(item.userName)}-${String(item.time)}-${index}`} item={item} />
            ))}
          </div>
        ) : (
          <div className="react-empty">
            <Icon name="comments" />
            <p>暂无评论</p>
          </div>
        )}
        <nav className="react-comment-pagination" aria-label="评论分页">
          <button type="button" onClick={previous} disabled={loading || page <= 1}>
            上一页
          </button>
          <span>
            第 {page} / {maxPage} 页
          </span>
          <button type="button" onClick={next} disabled={loading || page >= maxPage}>
            下一页
          </button>
        </nav>
      </div>
    </Modal>
  )
}

export function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const login = useAuthStore(state => state.login)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await login(password)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    }
  }
  return (
    <Modal open={open} title="访问播放器" onClose={onClose}>
      <form className="react-dialog-form" onSubmit={submit}>
        <label htmlFor="player-password">访问密码</label>
        <input
          id="player-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          required
        />
        {error && (
          <p className="react-error" role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit">
          进入播放器
        </Button>
      </form>
    </Modal>
  )
}

export function UserLoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const userLogin = useAuthStore(state => state.userLogin)
  const pendingSong = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await userLogin(username, password)
      if (pendingSong) setDialog('addToList')
      else onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败')
    }
  }
  return (
    <Modal open={open} title="登录用户账户" onClose={onClose}>
      <form className="react-dialog-form" onSubmit={submit}>
        <label htmlFor="user-name">用户名</label>
        <input
          id="user-name"
          autoComplete="username"
          value={username}
          onChange={event => setUsername(event.target.value)}
          required
        />
        <label htmlFor="user-password">密码</label>
        <input
          id="user-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
          required
        />
        {error && (
          <p className="react-error" role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit">
          登录
        </Button>
      </form>
    </Modal>
  )
}

export function CreateListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createList = useLibraryStore(state => state.createList)
  const notify = usePlayerUiStore(state => state.notify)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const pendingSong = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const [name, setName] = useState('')
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [icon, setIcon] = useState<PlaylistIconKey>('music')
  useEffect(() => {
    if (open) {
      setName('')
      setIcon('music')
    }
  }, [open])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      const created = await createList(name.trim(), icon)
      setName('')
      setIcon('music')
      if (pendingSong) setDialog('addToList')
      else {
        onClose()
        openFavoriteList(String(created.id))
      }
      notify('歌单已创建')
    } catch (error) {
      notify(error instanceof Error ? error.message : '创建歌单失败')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <Modal open={open} title="新建歌单" onClose={onClose}>
      <form className="react-dialog-form" onSubmit={submit}>
        <label htmlFor="new-list-name">歌单名称</label>
        <input
          id="new-list-name"
          value={name}
          onChange={event => setName(event.target.value)}
          required
          maxLength={80}
        />
        <fieldset className="react-playlist-icon-picker">
          <div className="react-playlist-icon-options" role="radiogroup" aria-label="选择歌单图标">
            {PLAYLIST_ICON_OPTIONS.map(option => (
              <label
                className={`react-playlist-icon-option ${icon === option.key ? 'is-selected' : ''}`}
                key={option.key}
              >
                <input
                  type="radio"
                  name="playlist-icon"
                  value={option.key}
                  aria-label={option.label}
                  checked={icon === option.key}
                  onChange={() => setIcon(option.key)}
                />
                <span className="react-playlist-icon-option-visual">
                  <Icon name={option.key} />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? '创建中…' : '创建'}
        </Button>
      </form>
    </Modal>
  )
}

export function AddToListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = usePlayerUiStore(state => state.playlistSong)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const loveSongs = useLibraryStore(selectLoveList)
  const userLists = useLibraryStore(selectUserLists)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const lists = useMemo(
    () => [
      { id: 'love', name: '我的收藏', icon: 'heart', songs: loveSongs },
      ...userLists.map(list => ({
        id: String(list.id),
        name: list.name,
        icon: playlistIcon(list.icon),
        songs: list.list ?? [],
      })),
    ],
    [loveSongs, userLists],
  )
  const toggleList = async (list: { id: string; name: string; songs: Song[] }) => {
    if (!song) return
    const included = list.songs.some(item => sameSong(item, song))
    try {
      if (included) {
        await removeSong(list.id, song)
        notify(`已从“${list.name}”移除`)
      } else {
        await addSong(list.id, song)
        notify(`已添加到“${list.name}”`)
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : '歌单操作失败')
    }
  }
  return (
    <Modal open={open} title="添加到歌单" onClose={onClose}>
      <div className="react-add-to-list-dialog">
        {song && (
          <p className="react-add-to-list-song">
            <SafeImage src={songImage(song)} width="44" height="44" alt="" />
            <span>
              <strong>{songTitle(song)}</strong>
              <small>{songArtist(song)}</small>
            </span>
          </p>
        )}
        <div className="react-add-to-list-options">
          {lists.map((list, index) => {
            const included = Boolean(song && list.songs.some(item => sameSong(item, song)))
            return (
              <button
                type="button"
                key={`${list.id}-${index}`}
                className={`react-add-to-list-option ${included ? 'is-included' : ''}`}
                aria-pressed={included}
                onClick={() => void toggleList(list)}
              >
                <span>
                  <Icon name={list.icon} />
                  <strong>{list.name}</strong>
                  <small>{list.songs.length} 首歌曲</small>
                </span>
                <Icon name={included ? 'check' : 'plus'} />
              </button>
            )
          })}
          <Button type="button" className="react-add-to-list-create" onClick={() => setDialog('createList')}>
            <Icon name="plus" />
            新建歌单
          </Button>
        </div>
        {!song && <p className="react-empty-text">当前没有正在播放的歌曲</p>}
      </div>
    </Modal>
  )
}
