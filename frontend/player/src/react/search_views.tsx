import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { loadPlaylistSongs, playerApi } from './api'
import { Button, DescriptionDisclosure, Icon, Loading, SafeImage, SongList } from './components'
import { navigateToSongEntity, songEntityDetail } from './song_details'
import {
  mediaLibraryItemKey,
  normalizeMusicSource,
  selectUserLists,
  useAuthStore,
  useLibraryStore,
  useMediaLibraryStore,
  usePlayerUiStore,
  useSearchStore,
  useSettingsStore,
} from './store'
import type { PlayerDetail, Song } from './types'
import { songImage, songKey } from './types'
import { safeImageUrl } from '../../../shared/src/runtime'
import { goBack } from './route_state'
import { ViewFrame } from './view_frame'
import { PlaylistDetailView } from './heavy_views'
import { getSessionGeneration } from './session'

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
  const defaultSource = useSettingsStore(state => normalizeMusicSource(state.settings.defaultSource))
  const [input, setInput] = useState(query)
  useEffect(() => setInput(query), [query])
  useEffect(() => {
    if (useSearchStore.getState().source !== defaultSource) setSource(defaultSource)
  }, [defaultSource, setSource])
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
            <h1>搜索音乐</h1>
            {query && results.length > 0 && (
              <p className="react-search-result-count">
                找到 {results.length}{' '}
                {type === 'song' ? '首单曲' : type === 'singer' ? '位歌手' : type === 'album' ? '张专辑' : '个歌单'}
              </p>
            )}
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
