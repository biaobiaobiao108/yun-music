import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadPlaylistSongs, playerApi, type CacheItem } from './api'
import {
  Button,
  DescriptionDisclosure,
  Icon,
  Loading,
  Modal,
  SafeImage,
  SelectMenu,
  SelectionDock,
  SongList,
} from './components'
import {
  musicSourceLabel,
  normalizeMusicSource,
  selectUserLists,
  useAuthStore,
  useLibraryStore,
  usePlaybackStore,
  usePlayerUiStore,
  useSettingsStore,
} from './store'
import type { PlayerDetail, Song } from './types'
import {
  songAlbum,
  songArtist,
  songDurationValue,
  songFormatValue,
  songImage,
  songSizeBytes,
  songSizeValue,
  songTitle,
} from './types'
import { formatBytes, formatDuration, safeImageUrl } from '../../../shared/src/runtime'
import { ViewFrame } from './view_frame'
import { useRequestResource } from './data/use_request'
import { useRealtimePoll } from './data/use_realtime_poll'
import { useCacheEvents } from './data/use_cache_events'
import { goBack } from './route_state'
import { getSessionGeneration } from './session'

const LOCAL_MUSIC_PAGE_SIZE = 100
const LEADERBOARD_PAGE_SIZE = 100

function extractSongs(payload: unknown): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['list', 'songs', 'data', 'result']) if (Array.isArray(record[key])) return record[key] as Song[]
  return []
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

type LeaderboardBoard = { id: string; name: string; image: string }

function leaderboardBoardMeta(board: unknown, index: number): LeaderboardBoard {
  const record = recordOf(board)
  const id = String(record.bangid ?? record.id ?? record.value ?? index)
  return {
    id,
    name: String(record.name ?? record.title ?? id),
    image: safeImageUrl(record.img ?? record.coverImgUrl ?? record.picUrl, ''),
  }
}

type LeaderboardPage = { songs: Song[]; total: number; limit: number; page: number }

function extractLeaderboardPage(payload: unknown, fallbackPage = 1): LeaderboardPage {
  const record = recordOf(payload)
  const songs = extractSongs(payload)
  const pageValue = Number(record.page)
  const limitValue = Number(record.limit)
  const totalValue = Number(record.total ?? record.totalCount ?? record.count)
  const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : fallbackPage
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : LEADERBOARD_PAGE_SIZE
  const total = Number.isFinite(totalValue) && totalValue >= 0 ? totalValue : songs.length
  return { songs, total, limit, page }
}

function extractListItems(payload: unknown): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['list', 'playlists', 'data', 'result'])
    if (Array.isArray(record[key])) return record[key] as Song[]
  return []
}

function listItemId(item: Song, index: number): string {
  return String(item.id ?? item.listId ?? item.dissid ?? item.uid ?? item.songmid ?? index)
}

function listItemImage(item: Song, fallback?: unknown): string {
  const candidate = songImage(item)
  const resolved = safeImageUrl(candidate, '')
  return resolved || safeImageUrl(fallback)
}

export function PlaylistDetailView({ detail }: { detail: PlayerDetail }) {
  const [page, setPage] = useState(1)
  const [collecting, setCollecting] = useState(false)
  const collectionController = useRef<AbortController | null>(null)
  useEffect(() => () => collectionController.current?.abort(), [detail.id, detail.source])
  const loadDetail = useCallback(
    async (signal: AbortSignal, options: { force: boolean }) => {
      const result = await playerApi.songListDetail(
        detail.source,
        detail.id,
        signal,
        {
          cacheKey: `songlist:detail:${detail.source}:${detail.id}:${page}`,
          cacheTtlMs: 60_000,
          force: options.force,
        },
        page,
      )
      const payload = result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
      return { payload, songs: extractSongs(result) }
    },
    [detail.id, detail.source, page],
  )
  const resource = useRequestResource(loadDetail, [detail.id, detail.source, page], {
    initialData: { payload: {}, songs: [] as Song[] },
  })
  const { payload, songs } = resource.data
  const { loading, error } = resource
  const total = Number(payload.total) || songs.length
  const userLists = useLibraryStore(selectUserLists)
  const toggleRemotePlaylist = useLibraryStore(state => state.toggleRemotePlaylist)
  const deleteList = useLibraryStore(state => state.deleteList)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const notify = usePlayerUiStore(state => state.notify)
  const info = recordOf(payload.info)
  const name = String(payload.name ?? payload.title ?? payload.dissname ?? info.name ?? detail.name ?? '歌单详情')
  const image = listItemImage(payload as Song, detail.image)
  const description = String(payload.desc ?? payload.description ?? payload.intro ?? info.desc ?? '')
  const collectedList = userLists.find(
    list => String(list.source || '') === detail.source && String(list.sourceListId ?? '') === detail.id,
  )
  const isCollected = Boolean(collectedList)
  const toggleCollected = async () => {
    if (loading || error || collectionController.current) return
    if (!userAuthenticated) {
      setDialog('userLogin')
      notify('请先登录用户账户')
      return
    }
    const controller = new AbortController()
    const sessionGeneration = getSessionGeneration()
    collectionController.current = controller
    setCollecting(true)
    try {
      if (collectedList) {
        await deleteList(String(collectedList.id))
        notify('已取消收藏歌单')
        return
      }
      const completeSongs = await loadPlaylistSongs(detail.source, detail.id, controller.signal)
      controller.signal.throwIfAborted()
      if (getSessionGeneration() !== sessionGeneration) throw new Error('登录账户已变化，请重新操作')
      const next = await toggleRemotePlaylist({ id: detail.id, source: detail.source, name, image }, completeSongs)
      notify(next ? '歌单已收藏' : '已取消收藏歌单')
    } catch (cause) {
      if (!controller.signal.aborted) notify(cause instanceof Error ? cause.message : '歌单收藏失败')
    } finally {
      if (collectionController.current === controller) collectionController.current = null
      setCollecting(false)
    }
  }
  return (
    <ViewFrame title={name} hideHeader>
      <section className="react-detail-header t-bg-panel">
        <button type="button" className="react-secondary-button" onClick={goBack}>
          <Icon name="arrow-left" />
          {detail.page === 'search-detail' ? '返回搜索结果' : '返回歌单广场'}
        </button>
        <div className="react-detail-hero">
          <SafeImage src={image} width="144" height="144" loading="lazy" alt={`${name}封面`} />
          <div>
            <h1>{name}</h1>
            {description && <DescriptionDisclosure text={description} />}
            <small>
              {String(payload.source ?? detail.source).toUpperCase()} · {total} 首歌曲
            </small>
            <button
              type="button"
              className={`react-entity-favorite react-detail-favorite ${isCollected ? 'is-active' : ''}`}
              aria-label={isCollected ? '取消收藏歌单' : '收藏歌单'}
              aria-pressed={isCollected}
              disabled={loading || Boolean(error) || collecting}
              onClick={() => void toggleCollected()}
            >
              <Icon name="heart" />
              {collecting ? '处理中…' : isCollected ? '已收藏' : '收藏歌单'}
            </button>
          </div>
        </div>
      </section>
      <section className="react-content-card t-bg-panel">
        {loading ? (
          <Loading label="正在加载歌单…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : (
          <SongList songs={songs} empty="歌单暂无歌曲" />
        )}
        <div className="react-pagination react-pagination-bottom">
          <button
            type="button"
            aria-label="上一页"
            disabled={page <= 1 || loading}
            onClick={() => setPage(value => value - 1)}
          >
            <Icon name="chevron-left" />
          </button>
          <span>第 {page} 页</span>
          <button
            type="button"
            aria-label="下一页"
            disabled={loading || Boolean(error) || page * 50 >= total}
            onClick={() => setPage(value => value + 1)}
          >
            <Icon name="chevron-right" />
          </button>
        </div>
      </section>
    </ViewFrame>
  )
}

function SongListGrid() {
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const setTab = usePlayerUiStore(state => state.setTab)
  const source = useSettingsStore(state => normalizeMusicSource(state.settings.defaultSource))
  const [songs, setSongs] = useState<Song[]>([])
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void playerApi
      .songListTags(source, controller.signal, { cacheKey: `songlist:tags:${source}`, cacheTtlMs: 300_000 })
      .then(payload => {
        if (!active) return
        const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
        const values = Array.isArray(record.tags)
          ? record.tags
          : Array.isArray(record.categories)
            ? record.categories
            : []
        setCategories(
          values.map((item, index) => {
            if (typeof item === 'string') return { id: item, name: item }
            const value = item as Record<string, unknown>
            const id = String(value.id ?? value.tagId ?? value.value ?? index)
            return { id, name: String(value.name ?? value.title ?? id) }
          }),
        )
      })
      .catch(() => {
        if (active) setCategories([])
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [source])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void playerApi
      .songList(source, category, 'hot', page, controller.signal, {
        cacheKey: `songlist:${source}:${category}:hot:${page}`,
        cacheTtlMs: 60_000,
      })
      .then(payload => {
        if (!controller.signal.aborted) setSongs(extractListItems(payload))
      })
      .catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '歌单加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [category, page, source])

  return (
    <ViewFrame title="歌单广场" viewId="react-view-songlist">
      <nav className="react-mobile-discover-links" aria-label="发现更多音乐">
        <button type="button" onClick={() => setTab('leaderboard')}>
          <span>
            <Icon name="chart-line" />
          </span>
          <strong>排行榜</strong>
          <small>热门歌曲榜单</small>
          <Icon name="chevron-right" />
        </button>
      </nav>
      <section className="react-toolbar-card t-bg-panel">
        <div className="react-toolbar-field">
          <span>分类</span>
          <SelectMenu
            label="分类"
            value={category}
            options={[{ value: '', label: '全部' }, ...categories.map(item => ({ value: item.id, label: item.name }))]}
            onChange={value => {
              setCategory(value)
              setPage(1)
            }}
          />
        </div>
      </section>
      <section className="react-content-card t-bg-panel">
        {loading ? (
          <Loading />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : songs.length ? (
          <div className="react-playlist-grid">
            {songs.map((item, index) => {
              const id = listItemId(item, index)
              const name = String(item.name ?? item.title ?? item.dissname ?? '未命名歌单')
              const sourceName = String(item.source || source)
              return (
                <article className="react-playlist-card" key={`${sourceName}:${id}:${index}`}>
                  <button
                    type="button"
                    onClick={() =>
                      setDetail({
                        page: 'songlist-detail',
                        kind: 'playlist',
                        id,
                        source: sourceName,
                        name,
                        image: listItemImage(item),
                      })
                    }
                  >
                    <SafeImage src={listItemImage(item)} width="180" height="180" loading="lazy" alt={`${name}封面`} />
                    <strong>{name}</strong>
                    <small>
                      {String(item.creator ?? item.author ?? '平台歌单')} ·{' '}
                      {String(item.songCount ?? item.trackCount ?? item.total ?? '歌曲')}
                    </small>
                  </button>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="react-empty">
            <Icon name="list" />
            <p>暂无歌单内容</p>
          </div>
        )}
        <div className="react-pagination react-pagination-bottom">
          <button
            type="button"
            aria-label="上一页"
            disabled={page <= 1 || loading}
            onClick={() => setPage(value => value - 1)}
          >
            <Icon name="chevron-left" />
          </button>
          <span>第 {page} 页</span>
          <button
            type="button"
            aria-label="下一页"
            disabled={loading || songs.length < 20}
            onClick={() => setPage(value => value + 1)}
          >
            <Icon name="chevron-right" />
          </button>
        </div>
      </section>
    </ViewFrame>
  )
}

export function SongListView({ detail = null }: { detail?: PlayerDetail | null } = {}) {
  return detail?.kind === 'playlist' ? (
    <PlaylistDetailView key={`${detail.source}:${detail.id}`} detail={detail} />
  ) : (
    <SongListGrid />
  )
}

export function LeaderboardView() {
  const [preferredBoardId] = useState(() => usePlayerUiStore.getState().leaderboardBoardId)
  const source = useSettingsStore(state => normalizeMusicSource(state.settings.defaultSource))
  const selectLeaderboardBoard = usePlayerUiStore(state => state.selectLeaderboardBoard)
  const playSong = usePlaybackStore(state => state.playSong)
  const [boards, setBoards] = useState<LeaderboardBoard[]>([])
  const [selected, setSelected] = useState('')
  const [songs, setSongs] = useState<Song[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(LEADERBOARD_PAGE_SIZE)
  const [boardsLoading, setBoardsLoading] = useState(true)
  const [songsLoading, setSongsLoading] = useState(false)
  const [boardsError, setBoardsError] = useState('')
  const [songsError, setSongsError] = useState('')
  const loadedBoardRef = useRef('')
  const loadedPageRef = useRef(0)
  const songsScrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setBoards([])
    setSongs([])
    setTotal(0)
    setSelected('')
    setPage(1)
    setBoardsLoading(true)
    setBoardsError('')
    setSongsError('')
    void playerApi
      .leaderboardBoards(source, controller.signal, { cacheKey: `leaderboard:boards:${source}`, cacheTtlMs: 60_000 })
      .then(result => {
        if (!active) return
        const nextBoards = result.map(leaderboardBoardMeta)
        setBoards(nextBoards)
        const requested = nextBoards.findIndex(board => board.id === preferredBoardId)
        const selectedIndex = requested >= 0 ? requested : 0
        const nextBoard = nextBoards[selectedIndex]
        setSelected(nextBoard?.id ?? '')
        if (nextBoard) selectLeaderboardBoard(nextBoard.id)
      })
      .catch(cause => {
        if (active) {
          setBoards([])
          setBoardsError(cause instanceof Error ? cause.message : '排行榜加载失败')
        }
      })
      .finally(() => {
        if (active) setBoardsLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [preferredBoardId, selectLeaderboardBoard, source])
  useEffect(() => {
    if (!selected) {
      setSongs([])
      setTotal(0)
      setSongsLoading(false)
      loadedBoardRef.current = ''
      loadedPageRef.current = 0
      return
    }
    const controller = new AbortController()
    const boardChanged = loadedBoardRef.current !== selected
    const pageChanged = loadedPageRef.current !== page
    if (boardChanged) setTotal(0)
    setSongsLoading(true)
    setSongsError('')
    void playerApi
      .leaderboard(
        source,
        selected,
        page,
        controller.signal,
        {
          cacheKey: `leaderboard:${source}:${selected}:${page}:${LEADERBOARD_PAGE_SIZE}`,
          cacheTtlMs: 30_000,
        },
        LEADERBOARD_PAGE_SIZE,
      )
      .then(payload => {
        if (controller.signal.aborted) return
        const result = extractLeaderboardPage(payload, page)
        setSongs(result.songs)
        setTotal(result.total)
        setLimit(result.limit)
        if (boardChanged || pageChanged) songsScrollRef.current?.scrollTo({ top: 0 })
        loadedBoardRef.current = selected
        loadedPageRef.current = page
      })
      .catch(cause => {
        if (!controller.signal.aborted) {
          setTotal(0)
          setSongsError(cause instanceof Error ? cause.message : '排行榜歌曲加载失败')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSongsLoading(false)
      })
    return () => controller.abort()
  }, [page, selected, source])
  const selectedBoard = boards.find(board => board.id === selected)
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, limit)))
  const chooseBoard = (boardId: string) => {
    if (boardId === selected) return
    setSelected(boardId)
    setPage(1)
    selectLeaderboardBoard(boardId)
  }
  return (
    <ViewFrame title="排行榜" hideHeader viewId="react-view-leaderboard">
      <div className="react-leaderboard-layout">
        <aside className="react-leaderboard-index-region" aria-label="排行榜列表">
          <div className="react-leaderboard-index custom-scrollbar">
            {boardsError ? (
              <p className="react-error" role="alert">
                {boardsError}
              </p>
            ) : boardsLoading ? (
              <Loading label="正在加载榜单…" />
            ) : boards.length ? (
              boards.map(board => (
                <button
                  key={board.id}
                  type="button"
                  className={`react-leaderboard-board ${selected === board.id ? 'is-active' : ''}`}
                  aria-current={selected === board.id ? 'true' : undefined}
                  onClick={() => chooseBoard(board.id)}
                >
                  <span className="react-leaderboard-board-cover">
                    {board.image ? (
                      <SafeImage src={board.image} width="48" height="48" loading="lazy" alt="" />
                    ) : (
                      <Icon name="chart-line" />
                    )}
                  </span>
                  <span>{board.name}</span>
                </button>
              ))
            ) : (
              <div className="react-empty">
                <Icon name="chart-line" />
                <p>暂无排行榜</p>
              </div>
            )}
          </div>
        </aside>
        {selectedBoard ? (
          <section className="react-leaderboard-detail">
            <header className="react-leaderboard-header">
              <span className="react-leaderboard-cover">
                {selectedBoard.image ? (
                  <SafeImage src={selectedBoard.image} width="72" height="72" loading="lazy" alt="" />
                ) : (
                  <Icon name="chart-line" />
                )}
              </span>
              <div className="react-leaderboard-copy">
                <h2>{selectedBoard.name}</h2>
                <p>
                  {musicSourceLabel(source)}
                  {total > 0 ? ` · 共 ${total} 首` : ''}
                  {songsLoading && (
                    <span className="react-leaderboard-busy" role="status">
                      正在更新
                    </span>
                  )}
                </p>
              </div>
              {songs.length > 0 && !songsLoading && (
                <Button variant="primary" onClick={() => playSong(songs[0], songs, 0)}>
                  <Icon name="play" />
                  播放全部
                </Button>
              )}
            </header>
            <div className="react-leaderboard-songs-region">
              <div
                ref={songsScrollRef}
                className={`react-leaderboard-content custom-scrollbar ${songsLoading ? 'is-loading' : ''} ${songsError ? 'has-error' : ''}`}
                aria-busy={songsLoading}
              >
                {songsError && (
                  <div className="react-leaderboard-error" role="alert">
                    <Icon name="triangle-exclamation" />
                    <p>{songsError}</p>
                  </div>
                )}
                {songsLoading && !songs.length ? (
                  <Loading />
                ) : songs.length ? (
                  <div className="react-leaderboard-songs">
                    <SongList songs={songs} empty="暂无排行榜歌曲" />
                  </div>
                ) : !songsError ? (
                  <SongList songs={songs} empty="暂无排行榜歌曲" />
                ) : null}
                {total > limit && (
                  <div className="react-pagination react-pagination-bottom">
                    <button
                      type="button"
                      aria-label="上一页"
                      disabled={page <= 1 || songsLoading}
                      onClick={() => setPage(value => value - 1)}
                    >
                      <Icon name="chevron-left" />
                    </button>
                    <span>
                      第 {page} / {pageCount} 页
                    </span>
                    <button
                      type="button"
                      aria-label="下一页"
                      disabled={songsLoading || page >= pageCount}
                      onClick={() => setPage(value => value + 1)}
                    >
                      <Icon name="chevron-right" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="react-leaderboard-empty">
            {boardsLoading ? (
              <Loading label="正在加载榜单…" />
            ) : (
              <div className="react-empty">
                <Icon name="chart-line" />
                <p>暂无可显示的榜单</p>
              </div>
            )}
          </section>
        )}
      </div>
    </ViewFrame>
  )
}

function localCacheItemKey(item: CacheItem, fallbackUsername?: string | null): string {
  return `${String(item.rawUsername || fallbackUsername || '_open')}:${String(item.location || '')}:${String(item.folder)}:${String(item.filename)}`
}

function sameCacheItems(current: CacheItem[], next: CacheItem[]): boolean {
  if (current.length !== next.length) return false
  const fields: Array<keyof CacheItem> = [
    'rawUsername',
    'location',
    'folder',
    'filename',
    'mtime',
    'size',
    'quality',
    'hasLyric',
    'hasCover',
  ]
  return current.every((item, index) => fields.every(field => item[field] === next[index]?.[field]))
}

export function LocalMusicView() {
  const userName = useAuthStore(state => state.userName)
  const [cacheItems, setCacheItems] = useState<CacheItem[]>([])
  const [cacheDataScope, setCacheDataScope] = useState<string | null>(null)
  const [cacheLoading, setCacheLoading] = useState(false)
  const [cacheError, setCacheError] = useState('')
  const [cacheErrorScope, setCacheErrorScope] = useState<string | null>(null)
  const [cacheFilter, setCacheFilter] = useState<'all' | 'cache' | 'music'>('all')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cacheController = useRef<AbortController | null>(null)
  const cacheUserScope = useRef(userName || '')
  const playSong = usePlaybackStore(state => state.playSong)
  const notify = usePlayerUiStore(state => state.notify)
  const loadCache = useCallback(
    async (options: { sync?: boolean; silent?: boolean; restart?: boolean } = {}) => {
      const sync = options.sync !== false
      const silent = options.silent === true
      const restart = options.restart === true
      if (silent && cacheController.current && !restart) return
      cacheController.current?.abort()
      const controller = new AbortController()
      cacheController.current = controller
      if (!silent) {
        setCacheLoading(true)
        setCacheError('')
      }
      const syncPromise = sync
        ? playerApi.cacheSync(userName || undefined, controller.signal).catch(() => undefined)
        : undefined
      let syncRefreshScheduled = false
      try {
        const result = await playerApi.cacheList(userName || undefined, controller.signal)
        if (controller.signal.aborted) return
        const nextItems = result.data ?? []
        setCacheItems(current => (sameCacheItems(current, nextItems) ? current : nextItems))
        setCacheDataScope(userName || '')
        setCacheError('')
        setCacheErrorScope(null)
        setSelected(current => {
          const available = new Set(nextItems.map(item => localCacheItemKey(item, userName)))
          const next = new Set([...current].filter(key => available.has(key)))
          if (next.size === current.size && [...current].every(key => next.has(key))) return current
          return next
        })
        if (syncPromise) {
          syncRefreshScheduled = true
          void syncPromise
            .then(async () => {
              if (controller.signal.aborted) return
              const refreshed = await playerApi.cacheList(userName || undefined, controller.signal)
              if (controller.signal.aborted) return
              const refreshedItems = refreshed.data ?? []
              setCacheItems(current => (sameCacheItems(current, refreshedItems) ? current : refreshedItems))
              setCacheDataScope(userName || '')
              setCacheError('')
              setCacheErrorScope(null)
              setSelected(current => {
                const available = new Set(refreshedItems.map(item => localCacheItemKey(item, userName)))
                const next = new Set([...current].filter(key => available.has(key)))
                if (next.size === current.size && [...current].every(key => next.has(key))) return current
                return next
              })
            })
            .catch(() => undefined)
            .finally(() => {
              if (cacheController.current === controller) cacheController.current = null
            })
        }
      } catch (error) {
        if (!controller.signal.aborted && !silent) {
          setCacheError(error instanceof Error ? error.message : '本地音乐加载失败')
          setCacheErrorScope(userName || '')
        }
      } finally {
        if (cacheController.current === controller) {
          if (syncPromise && !syncRefreshScheduled) {
            void syncPromise.finally(() => {
              if (cacheController.current === controller) cacheController.current = null
            })
          } else if (!syncPromise) {
            cacheController.current = null
          }
        }
        if (!silent) setCacheLoading(false)
      }
    },
    [userName],
  )
  useEffect(() => {
    const nextScope = userName || ''
    if (cacheUserScope.current === nextScope) return
    cacheUserScope.current = nextScope
    setCacheItems([])
    setCacheDataScope(null)
    setCacheError('')
    setCacheErrorScope(null)
    setSelected(new Set())
    setConfirmOpen(false)
  }, [userName])
  useEffect(() => {
    void loadCache({ sync: true })
    return () => cacheController.current?.abort()
  }, [loadCache])
  const eventsConnected = useCacheEvents({
    enabled: true,
    user: userName || undefined,
    onCache: () => {
      void loadCache({ sync: false, silent: true, restart: true })
    },
  })
  useRealtimePoll({
    enabled: !eventsConnected,
    intervalMs: 2500,
    refresh: () => loadCache({ sync: false, silent: true }),
  })
  const cacheFileUrl = useCallback(
    (item: CacheItem) => {
      const params = new URLSearchParams({ folder: String(item.folder || 'cache') })
      if (item.location === 'data' || item.location === 'root') params.set('location', item.location)
      const username = String(item.rawUsername || item.username || userName || '_open').trim()
      const encodedFilename = encodeURIComponent(String(item.filename))
      const isPublic = username === '_open' || username === 'open' || username === 'default'
      const target = isPublic ? encodedFilename : `${encodeURIComponent(username)}/${encodedFilename}`
      return `/api/music/cache/file/${target}?${params.toString()}`
    },
    [userName],
  )
  const cacheSong = useCallback(
    (item: CacheItem): Song => {
      const metadata = item.songInfo ?? {}
      const image = [item.img, songImage(metadata), metadata.img, metadata.pic, metadata.picUrl].find(
        value => typeof value === 'string' && value.trim(),
      ) as string | undefined
      return {
        ...metadata,
        id: item.id ?? metadata.id,
        songmid: item.songmid ?? metadata.songmid ?? metadata.id,
        name: item.name || metadata.name,
        singer: item.singer || songArtist(metadata),
        albumName: item.albumName || songAlbum(metadata),
        source: item.source || metadata.source,
        img: image,
        size: item.size ?? songSizeValue(metadata),
        quality: item.quality || metadata.quality,
        url: cacheFileUrl(item),
        cacheItem: item,
      }
    },
    [cacheFileUrl],
  )
  const visibleCacheItems = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase()
    const currentItems = cacheDataScope === (userName || '') ? cacheItems : []
    return currentItems.filter(
      item =>
        (cacheFilter === 'all' || item.folder === cacheFilter) &&
        (!needle ||
          `${item.name} ${item.singer} ${item.albumName} ${item.filename}`.toLocaleLowerCase().includes(needle)),
    )
  }, [cacheDataScope, cacheFilter, cacheItems, keyword, userName])
  const pageCount = Math.max(1, Math.ceil(visibleCacheItems.length / LOCAL_MUSIC_PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageItems = useMemo(
    () => visibleCacheItems.slice(pageIndex * LOCAL_MUSIC_PAGE_SIZE, (pageIndex + 1) * LOCAL_MUSIC_PAGE_SIZE),
    [pageIndex, visibleCacheItems],
  )
  const hasCacheDataForCurrentUser = cacheDataScope === (userName || '')
  const cacheErrorForCurrentUser = cacheErrorScope === (userName || '') ? cacheError : ''
  const allVisibleSelected =
    visibleCacheItems.length > 0 && visibleCacheItems.every(item => selected.has(localCacheItemKey(item, userName)))
  useEffect(() => {
    setPage(0)
    setSelected(new Set())
  }, [cacheFilter, keyword])
  const toggleSelected = (item: CacheItem) =>
    setSelected(current => {
      const next = new Set(current)
      const key = localCacheItemKey(item, userName)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  useEffect(() => {
    if (!batchMode) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setBatchMode(false)
      setSelected(new Set())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [batchMode])
  const deleteSelected = async () => {
    const items = visibleCacheItems
      .filter(item => selected.has(localCacheItemKey(item, userName)))
      .map(item => ({
        filename: String(item.filename),
        folder: String(item.folder),
        location: item.location,
        user: item.rawUsername,
      }))
    if (!items.length) return
    try {
      await playerApi.cacheRemove(items, userName || undefined)
      notify(`已删除 ${items.length} 个本地文件`)
      setConfirmOpen(false)
      setSelected(new Set())
      await loadCache()
    } catch (error) {
      notify(error instanceof Error ? error.message : '删除本地文件失败')
    }
  }
  const serverSongs = useMemo(() => visibleCacheItems.map(cacheSong), [cacheSong, visibleCacheItems])
  const cacheDuration = (item: CacheItem, song: Song): string => {
    const value = item.duration ?? item.interval ?? songDurationValue(item) ?? songDurationValue(song)
    if (typeof value === 'string' && value.includes(':')) return value
    return formatDuration(value)
  }
  return (
    <ViewFrame
      title="本地音乐"
      actions={
        batchMode ? undefined : (
          <div className="react-view-header-actions react-playlist-header-actions">
            <Button
              className="react-icon-only-button"
              aria-label="多选操作"
              onClick={() => {
                setBatchMode(true)
                setSelected(new Set())
              }}
              disabled={!visibleCacheItems.length}
            >
              <Icon name="list" />
            </Button>
          </div>
        )
      }
    >
      <section className="react-toolbar-card t-bg-panel react-local-toolbar">
        <div className="react-toolbar-field">
          <span>目录</span>
          <SelectMenu
            label="本地音乐目录"
            value={cacheFilter}
            options={[
              { value: 'all', label: '全部' },
              { value: 'cache', label: '缓存' },
              { value: 'music', label: '已下载' },
            ]}
            onChange={value => {
              setPage(0)
              setCacheFilter(value as typeof cacheFilter)
            }}
          />
        </div>
        <label className="react-global-search react-local-search">
          <Icon name="search" />
          <input
            value={keyword}
            onChange={event => {
              setPage(0)
              setKeyword(event.target.value)
            }}
            placeholder="搜索歌曲、歌手或文件名"
            aria-label="搜索本地音乐"
          />
        </label>
        <Button onClick={() => void loadCache({ sync: true })} disabled={cacheLoading}>
          <Icon name={cacheLoading ? 'spinner' : 'rotate'} />
          刷新
        </Button>
      </section>
      <section className="react-content-card t-bg-panel">
        <div className="react-section-heading">
          <div>
            <h2>
              服务器音乐 <small>{visibleCacheItems.length} 首</small>
            </h2>
            <p>缓存与明确下载的音乐共用现有服务器存储规则</p>
          </div>
        </div>
        {cacheErrorForCurrentUser && hasCacheDataForCurrentUser && (
          <p className="react-cache-refresh-error" role="status">
            无法刷新本地音乐：{cacheErrorForCurrentUser}
          </p>
        )}
        {!hasCacheDataForCurrentUser ? (
          cacheErrorForCurrentUser ? (
            <p className="react-error" role="alert">
              {cacheErrorForCurrentUser}
            </p>
          ) : (
            <Loading label="正在扫描本地音乐…" />
          )
        ) : visibleCacheItems.length ? (
          <div className="react-song-table react-local-song-table">
            <ul className="react-song-list">
              {pageItems.map((item, offset) => {
                const index = pageIndex * LOCAL_MUSIC_PAGE_SIZE + offset
                const song = serverSongs[index]
                const key = localCacheItemKey(item, userName)
                const album = songAlbum(song)
                const sizeBytes = songSizeBytes(item.size ?? song)
                return (
                  <li
                    className={`react-song-row react-local-cache-row ${batchMode ? 'is-selectable' : ''} ${
                      selected.has(key) ? 'is-selected' : ''
                    }`}
                    key={key}
                  >
                    <span className="react-song-index" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <button
                      type="button"
                      className="react-song-main"
                      aria-pressed={batchMode ? selected.has(key) : undefined}
                      onClick={() => {
                        if (batchMode) {
                          toggleSelected(item)
                          return
                        }
                        void playerApi
                          .cachePlayback({
                            filename: String(item.filename),
                            folder: String(item.folder),
                            location: item.location,
                            user: item.rawUsername,
                          })
                          .catch(() => undefined)
                        playSong(song, serverSongs, index)
                      }}
                    >
                      <SafeImage src={songImage(song)} width="48" height="48" loading="lazy" alt="" />
                      <span className="react-song-text">
                        <strong>{songTitle(song)}</strong>
                        <small>{songArtist(song)}</small>
                      </span>
                    </button>
                    <span className="react-song-album">{album}</span>
                    <span className="react-song-duration">{cacheDuration(item, song)}</span>
                    <span className="react-song-size">{sizeBytes === undefined ? '—' : formatBytes(sizeBytes)}</span>
                    <span className="react-song-quality">
                      {String(item.quality || songFormatValue(song) || '未知').toUpperCase()}
                    </span>
                    <span className="react-song-actions">
                      <a
                        className="react-row-play"
                        href={cacheFileUrl(item)}
                        download={String(item.filename).split('/').pop()}
                        aria-label={`下载 ${songTitle(song)}`}
                      >
                        <Icon name="download" />
                      </a>
                    </span>
                  </li>
                )
              })}
            </ul>
            {pageCount > 1 && (
              <nav className="react-dialog-actions react-local-pagination" aria-label="本地音乐列表分页">
                <Button disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>
                  上一页
                </Button>
                <span aria-live="polite">
                  第 {pageIndex + 1} / {pageCount} 页
                </span>
                <Button disabled={pageIndex + 1 >= pageCount} onClick={() => setPage(pageIndex + 1)}>
                  下一页
                </Button>
              </nav>
            )}
            {batchMode && <div className="react-selection-dock-spacer" aria-hidden="true" />}
          </div>
        ) : (
          <div className="react-empty">
            <Icon name="cloud-arrow-down" />
            <p>暂无服务器缓存或下载音乐</p>
          </div>
        )}
        {batchMode && (
          <SelectionDock
            count={selected.size}
            allSelected={allVisibleSelected}
            canSelectAll={visibleCacheItems.length > 0}
            onToggleAll={() =>
              setSelected(
                allVisibleSelected
                  ? new Set()
                  : new Set(visibleCacheItems.map(item => localCacheItemKey(item, userName))),
              )
            }
            onClose={() => {
              setBatchMode(false)
              setSelected(new Set())
            }}
          >
            <button
              type="button"
              className="react-selection-action is-danger"
              onClick={() => setConfirmOpen(true)}
              disabled={!selected.size}
            >
              <Icon name="trash" />
              <span>删除</span>
            </button>
          </SelectionDock>
        )}
        <Modal open={confirmOpen} title="删除本地音乐" onClose={() => setConfirmOpen(false)}>
          <p>确定删除选中的 {selected.size} 个服务器文件吗？该操作会同时清理关联歌词、封面与缓存索引。</p>
          <div className="react-dialog-actions">
            <Button onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button variant="danger" onClick={() => void deleteSelected()}>
              确认删除
            </Button>
          </div>
        </Modal>
      </section>
    </ViewFrame>
  )
}
