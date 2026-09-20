import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { playerApi, type CacheItem } from './api'
import { Button, Icon, Loading, Modal, SafeImage, SongList } from './components'
import { useAuthStore, usePlaybackStore, usePlayerUiStore } from './store'
import type { PlayerDetail, Song } from './types'
import { songImage, songKey, songTitle } from './types'
import { formatBytes, formatDuration, safeImageUrl } from '../../../shared/src/runtime'
import { ViewFrame } from './views'
import { useRequestResource } from './data/use_request'
import { goBack } from './route_state'

function extractSongs(payload: unknown): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['list', 'songs', 'data', 'result']) if (Array.isArray(record[key])) return record[key] as Song[]
  return []
}

function extractListItems(payload: unknown): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of ['list', 'playlists', 'data', 'result']) if (Array.isArray(record[key])) return record[key] as Song[]
  return []
}

function listItemId(item: Song, index: number): string {
  return String(item.id ?? item.listId ?? item.dissid ?? item.uid ?? item.songmid ?? index)
}

function listItemImage(item: Song): string {
  return safeImageUrl(songImage(item))
}

function PlaylistDetailView({ detail }: { detail: PlayerDetail }) {
  const loadDetail = useCallback(async (signal: AbortSignal, options: { force: boolean }) => {
    const result = await playerApi.songListDetail(detail.source, detail.id, signal, { cacheKey: `songlist:detail:${detail.source}:${detail.id}`, cacheTtlMs: 60_000, force: options.force })
    const payload = result && typeof result === 'object' ? result as Record<string, unknown> : {}
    return { payload, songs: extractSongs(result) }
  }, [detail.id, detail.source])
  const resource = useRequestResource(loadDetail, [detail.id, detail.source], { initialData: { payload: {}, songs: [] as Song[] } })
  const { payload, songs } = resource.data
  const { loading, error } = resource
  const name = String(payload.name ?? payload.title ?? payload.dissname ?? detail.name ?? '歌单详情')
  const image = listItemImage(payload as Song)
  const description = String(payload.desc ?? payload.description ?? payload.intro ?? '')
  return <ViewFrame title={name} subtitle="歌单详情"><section className="react-detail-header t-bg-panel"><button type="button" className="react-secondary-button" onClick={goBack}><Icon name="arrow-left" />返回歌单广场</button><div className="react-detail-hero"><SafeImage src={image} width="144" height="144" loading="lazy" alt={`${name}封面`} /><div><h2>{name}</h2>{description && <p>{description}</p>}<small>{detail.source.toUpperCase()} · {songs.length} 首歌曲</small></div></div></section><section className="react-content-card t-bg-panel">{loading ? <Loading label="正在加载歌单…" /> : error ? <p className="react-error" role="alert">{error}</p> : <SongList songs={songs} empty="歌单暂无歌曲" />}</section></ViewFrame>
}

function SongListGrid() {
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const [source, setSource] = useState('wy')
  const [songs, setSongs] = useState<Song[]>([])
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void playerApi.songListTags(source, controller.signal, { cacheKey: `songlist:tags:${source}`, cacheTtlMs: 300_000 }).then(payload => {
      if (!active) return
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const values = Array.isArray(record.tags) ? record.tags : Array.isArray(record.categories) ? record.categories : []
      setCategories(values.map((item, index) => {
        if (typeof item === 'string') return { id: item, name: item }
        const value = item as Record<string, unknown>
        const id = String(value.id ?? value.tagId ?? value.value ?? index)
        return { id, name: String(value.name ?? value.title ?? id) }
      }))
    }).catch(() => { if (active) setCategories([]) })
    return () => { active = false; controller.abort() }
  }, [source])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void playerApi.songList(source, category, 'hot', page, controller.signal, { cacheKey: `songlist:${source}:${category}:hot:${page}`, cacheTtlMs: 60_000 }).then(payload => {
      if (!controller.signal.aborted) setSongs(extractListItems(payload))
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '歌单加载失败')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [category, page, source])

    return <ViewFrame title="歌单广场" subtitle="发现平台精选歌单"><section className="react-toolbar-card t-bg-panel"><label>音源<select value={source} onChange={event => { setSource(event.target.value); setCategory(''); setPage(1) }}><option value="wy">网易云</option><option value="tx">QQ音乐</option></select></label><label>分类<select value={category} onChange={event => { setCategory(event.target.value); setPage(1) }}><option value="">全部</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="react-pagination"><button type="button" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><Icon name="chevron-left" /></button><span>第 {page} 页</span><button type="button" aria-label="下一页" disabled={loading || songs.length < 20} onClick={() => setPage(value => value + 1)}><Icon name="chevron-right" /></button></div></section><section className="react-content-card t-bg-panel">{loading ? <Loading /> : error ? <p className="react-error" role="alert">{error}</p> : songs.length ? <div className="react-playlist-grid">{songs.map((item, index) => { const id = listItemId(item, index); const name = String(item.name ?? item.title ?? item.dissname ?? '未命名歌单'); const sourceName = String(item.source || source); return <article className="react-playlist-card" key={`${sourceName}:${id}:${index}`}><button type="button" onClick={() => setDetail({ page: 'songlist-detail', kind: 'playlist', id, source: sourceName, name, image: listItemImage(item) })}><SafeImage src={listItemImage(item)} width="180" height="180" loading="lazy" alt={`${name}封面`} /><strong>{name}</strong><small>{String(item.creator ?? item.author ?? '平台歌单')} · {String(item.songCount ?? item.trackCount ?? item.total ?? '歌曲')}</small></button></article> })}</div> : <div className="react-empty"><Icon name="list" /><p>暂无歌单内容</p></div>}</section></ViewFrame>
}

export function SongListView({ detail = null }: { detail?: PlayerDetail | null } = {}) {
  return detail?.kind === 'playlist' ? <PlaylistDetailView detail={detail} /> : <SongListGrid />
}

export function LeaderboardView() {
  const [source, setSource] = useState('wy')
  const [boards, setBoards] = useState<unknown[]>([])
  const [selected, setSelected] = useState('')
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setBoards([]); setSongs([]); setSelected(''); setError('')
    void playerApi.leaderboardBoards(source, controller.signal, { cacheKey: `leaderboard:boards:${source}`, cacheTtlMs: 60_000 }).then(result => {
      if (!active) return
      setBoards(result)
      const first = result[0]
      setSelected(String(typeof first === 'object' && first ? (first as Record<string, unknown>).bangid ?? (first as Record<string, unknown>).id ?? (first as Record<string, unknown>).value ?? '' : first ?? ''))
    }).catch(cause => { if (active) { setBoards([]); setError(cause instanceof Error ? cause.message : '排行榜加载失败') } })
    return () => { active = false; controller.abort() }
  }, [source])
  useEffect(() => {
    if (!selected) { setLoading(false); return }
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void playerApi.leaderboard(source, selected, 1, controller.signal, { cacheKey: `leaderboard:${source}:${selected}:1`, cacheTtlMs: 30_000 }).then(payload => { if (!controller.signal.aborted) setSongs(extractSongs(payload)) }).catch(cause => { if (!controller.signal.aborted) { setSongs([]); setError(cause instanceof Error ? cause.message : '排行榜歌曲加载失败') } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [selected, source])
  return <ViewFrame title="排行榜" subtitle="查看热门音乐榜单"><section className="react-toolbar-card t-bg-panel"><label>音源<select value={source} onChange={event => setSource(event.target.value)}><option value="wy">网易云</option><option value="tx">QQ音乐</option></select></label><label>榜单<select value={selected} disabled={!boards.length} onChange={event => setSelected(event.target.value)}>{!boards.length && <option value="">暂无榜单</option>}{boards.map((board, index) => { const value = typeof board === 'object' && board ? String((board as Record<string, unknown>).bangid ?? (board as Record<string, unknown>).id ?? (board as Record<string, unknown>).value ?? index) : String(board); const label = typeof board === 'object' && board ? String((board as Record<string, unknown>).name ?? (board as Record<string, unknown>).title ?? value) : value; return <option key={`${value}-${index}`} value={value}>{label}</option> })}</select></label></section><section className="react-content-card t-bg-panel">{error && <p className="react-error" role="alert">{error}</p>}{loading ? <Loading /> : <SongList songs={songs} empty="暂无排行榜歌曲" />}</section></ViewFrame>
}

export function LocalMusicView() {
  const userName = useAuthStore(state => state.userName)
  const [cacheItems, setCacheItems] = useState<CacheItem[]>([])
  const [cacheLoading, setCacheLoading] = useState(false)
  const [cacheError, setCacheError] = useState('')
  const [cacheFilter, setCacheFilter] = useState<'all' | 'cache' | 'music'>('all')
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const cacheController = useRef<AbortController | null>(null)
  const playSong = usePlaybackStore(state => state.playSong)
  const notify = usePlayerUiStore(state => state.notify)
  const loadCache = async () => {
    cacheController.current?.abort()
    const controller = new AbortController()
    cacheController.current = controller
    setCacheLoading(true)
    setCacheError('')
    try {
      await playerApi.cacheSync(userName || undefined, controller.signal).catch(() => undefined)
      const result = await playerApi.cacheList(userName || undefined, controller.signal)
      if (controller.signal.aborted) return
      setCacheItems(result.data ?? [])
      setSelected(new Set())
    } catch (error) {
      if (!controller.signal.aborted) setCacheError(error instanceof Error ? error.message : '本地音乐加载失败')
    } finally {
      if (cacheController.current === controller) {
        cacheController.current = null
        setCacheLoading(false)
      }
    }
  }
  useEffect(() => { void loadCache(); return () => cacheController.current?.abort() }, [userName])
  const cacheKey = (item: CacheItem) => `${String(item.rawUsername || userName || '_open')}:${String(item.folder)}:${String(item.filename)}`
  const cacheFileUrl = (item: CacheItem) => {
    const params = new URLSearchParams({ folder: String(item.folder || 'cache') })
    const username = String(item.rawUsername || item.username || userName || '_open').trim()
    const encodedFilename = encodeURIComponent(String(item.filename))
    const isPublic = username === '_open' || username === 'open' || username === 'default'
    const target = isPublic
      ? encodedFilename
      : `${encodeURIComponent(username)}/${encodedFilename}`
    return `/api/music/cache/file/${target}?${params.toString()}`
  }
  const cacheSong = (item: CacheItem): Song => {
    const metadata = item.songInfo ?? {}
    const image = [item.img, songImage(metadata), metadata.img, metadata.pic, metadata.picUrl]
      .find(value => typeof value === 'string' && value.trim()) as string | undefined
    return {
      ...metadata,
      id: item.id ?? metadata.id,
      songmid: item.songmid ?? metadata.songmid ?? metadata.id,
      name: item.name || metadata.name,
      singer: item.singer || metadata.singer,
      album: item.album || metadata.album,
      source: item.source || metadata.source,
      img: image,
      quality: item.quality || metadata.quality,
      url: cacheFileUrl(item),
      cacheItem: item,
    }
  }
  const visibleCacheItems = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase()
    return cacheItems.filter(item => (cacheFilter === 'all' || item.folder === cacheFilter) && (!needle || `${item.name} ${item.singer} ${item.album} ${item.filename}`.toLocaleLowerCase().includes(needle)))
  }, [cacheFilter, cacheItems, keyword])
  const toggleSelected = (item: CacheItem) => setSelected(current => { const next = new Set(current); const key = cacheKey(item); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const deleteSelected = async () => {
    const items = visibleCacheItems.filter(item => selected.has(cacheKey(item))).map(item => ({ filename: String(item.filename), folder: String(item.folder), user: item.rawUsername }))
    if (!items.length) return
    try { await playerApi.cacheRemove(items, userName || undefined); notify(`已删除 ${items.length} 个本地文件`); setConfirmOpen(false); await loadCache() } catch (error) { notify(error instanceof Error ? error.message : '删除本地文件失败') }
  }
  const serverSongs = visibleCacheItems.map(cacheSong)
  const cacheDuration = (item: CacheItem, song: Song): string => {
    const value = item.duration ?? item.interval ?? song.interval ?? song.duration
    if (typeof value === 'string' && value.includes(':')) return value
    return formatDuration(value)
  }
  return <ViewFrame title="本地音乐" subtitle="管理服务器缓存与下载音乐"><section className="react-toolbar-card t-bg-panel react-local-toolbar"><label>目录<select value={cacheFilter} onChange={event => setCacheFilter(event.target.value as typeof cacheFilter)}><option value="all">全部</option><option value="cache">缓存</option><option value="music">已下载</option></select></label><label className="react-local-search"><Icon name="search" /><input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索歌曲、歌手或文件名" aria-label="搜索本地音乐" /></label><Button onClick={() => void loadCache()} disabled={cacheLoading}><Icon name="rotate" />刷新</Button></section><section className="react-content-card t-bg-panel"><div className="react-section-heading"><div><h2>服务器音乐 <small>{visibleCacheItems.length} 首</small></h2><p>缓存与明确下载的音乐共用现有服务器存储规则</p></div><div className="react-dialog-actions"><Button onClick={() => setSelected(new Set(visibleCacheItems.map(cacheKey)))} disabled={!visibleCacheItems.length}>全选</Button><Button onClick={() => setSelected(new Set())} disabled={!selected.size}>取消选择</Button><Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={!selected.size}>删除已选（{selected.size}）</Button></div></div>{cacheLoading ? <Loading label="正在扫描本地音乐…" /> : cacheError ? <p className="react-error" role="alert">{cacheError}</p> : visibleCacheItems.length ? <div className="react-song-table react-local-song-table"><div className="react-song-head is-selectable" aria-hidden="true"><span /><span>#</span><span>歌曲 / 歌手</span><span>专辑</span><span>收藏</span><span>时长</span><span>大小</span><span>格式</span><span /></div><ul className="react-song-list">{visibleCacheItems.map((item, index) => { const song = cacheSong(item); const key = cacheKey(item); return <li className="react-song-row is-selectable react-local-cache-row" key={key}><span className="react-song-select"><input type="checkbox" checked={selected.has(key)} onChange={() => toggleSelected(item)} aria-label={`选择 ${songTitle(song)}`} /></span><span className="react-song-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><button type="button" className="react-song-main" onClick={() => { void playerApi.cachePlayback({ filename: String(item.filename), folder: String(item.folder), user: item.rawUsername }); playSong(song, serverSongs, serverSongs.findIndex(candidate => songKey(candidate) === songKey(song))) }}><SafeImage src={songImage(song)} width="48" height="48" loading="lazy" alt="" /><span className="react-song-text"><strong>{songTitle(song)}</strong><small>{String(item.singer || '未知歌手')}</small></span></button><span className="react-song-album" title={String(song.album || '—')}>{String(song.album || '—')}</span><span className="react-song-favorite" aria-hidden="true">—</span><span className="react-song-duration">{cacheDuration(item, song)}</span><span className="react-song-size">{formatBytes(item.size)}</span><span className="react-song-quality">{String(item.quality || song.quality || '未知').toUpperCase()}</span><span className="react-song-actions"><a className="react-row-play" href={cacheFileUrl(item)} download={String(item.filename).split('/').pop()} aria-label={`下载 ${songTitle(song)}`}><Icon name="download" /></a></span></li> })}</ul></div> : <div className="react-empty"><Icon name="cloud-arrow-down" /><p>暂无服务器缓存或下载音乐</p></div>}<Modal open={confirmOpen} title="删除本地音乐" onClose={() => setConfirmOpen(false)}><p>确定删除选中的 {selected.size} 个服务器文件吗？该操作会同时清理关联歌词、封面与缓存索引。</p><div className="react-dialog-actions"><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button variant="danger" onClick={() => void deleteSelected()}>确认删除</Button></div></Modal></section></ViewFrame>
}
