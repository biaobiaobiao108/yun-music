import { useEffect, useMemo, useRef, useState } from 'react'
import { playerApi, type CacheItem } from './api'
import { Button, Icon, Loading, Modal, SongList } from './components'
import { useAuthStore, usePlaybackStore, usePlayerUiStore } from './store'
import type { PlayerDetail, Song } from './types'
import { songKey, songTitle } from './types'
import { formatBytes, safeImageUrl } from '../../../shared/src/runtime'
import { ViewFrame } from './views'

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
  return safeImageUrl(String(item.picUrl ?? item.img ?? item.pic ?? item.cover ?? '/music/assets/yun-yin.png'))
}

function PlaylistDetailView({ detail }: { detail: PlayerDetail }) {
  const [payload, setPayload] = useState<Record<string, unknown>>({})
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void playerApi.songListDetail(detail.source, detail.id, controller.signal).then(result => {
      if (controller.signal.aborted) return
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
      setPayload(record); setSongs(extractSongs(result))
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '歌单加载失败') }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [detail.id, detail.source])
  const name = String(payload.name ?? payload.title ?? payload.dissname ?? detail.name ?? '歌单详情')
  const image = listItemImage(payload as Song)
  const description = String(payload.desc ?? payload.description ?? payload.intro ?? '')
  return <ViewFrame title={name} subtitle="歌单详情"><section className="react-detail-header t-bg-panel"><button type="button" className="react-secondary-button" onClick={() => window.history.back()}><Icon name="arrow-left" />返回歌单广场</button><div className="react-detail-hero"><img src={image} width="144" height="144" loading="lazy" alt={`${name}封面`} /><div><h2>{name}</h2>{description && <p>{description}</p>}<small>{detail.source.toUpperCase()} · {songs.length} 首歌曲</small></div></div></section><section className="react-content-card t-bg-panel">{loading ? <Loading label="正在加载歌单…" /> : error ? <p className="react-error" role="alert">{error}</p> : <SongList songs={songs} empty="歌单暂无歌曲" />}</section></ViewFrame>
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
    let active = true
    void playerApi.songListTags(source).then(payload => {
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
    return () => { active = false }
  }, [source])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void playerApi.songList(source, category, 'hot', page, controller.signal).then(payload => {
      if (!controller.signal.aborted) setSongs(extractListItems(payload))
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '歌单加载失败')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [category, page, source])

  return <ViewFrame title="歌单广场" subtitle="发现平台精选歌单"><section className="react-toolbar-card t-bg-panel"><label>音源<select value={source} onChange={event => { setSource(event.target.value); setPage(1) }}><option value="wy">网易云</option><option value="tx">QQ音乐</option></select></label><label>分类<select value={category} onChange={event => { setCategory(event.target.value); setPage(1) }}><option value="">全部</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="react-pagination"><button type="button" aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><Icon name="chevron-left" /></button><span>第 {page} 页</span><button type="button" aria-label="下一页" disabled={loading || songs.length < 20} onClick={() => setPage(value => value + 1)}><Icon name="chevron-right" /></button></div></section><section className="react-content-card t-bg-panel">{loading ? <Loading /> : error ? <p className="react-error" role="alert">{error}</p> : songs.length ? <div className="react-playlist-grid">{songs.map((item, index) => { const id = listItemId(item, index); const name = String(item.name ?? item.title ?? item.dissname ?? '未命名歌单'); const sourceName = String(item.source || source); return <article className="react-playlist-card" key={`${sourceName}:${id}`}><button type="button" onClick={() => setDetail({ page: 'songlist-detail', kind: 'playlist', id, source: sourceName, name, image: listItemImage(item) })}><img src={listItemImage(item)} width="180" height="180" loading="lazy" alt={`${name}封面`} /><strong>{name}</strong><small>{String(item.creator ?? item.author ?? '平台歌单')} · {String(item.songCount ?? item.trackCount ?? item.total ?? '歌曲')}</small></button></article> })}</div> : <div className="react-empty"><Icon name="list" /><p>暂无歌单内容</p></div>}</section></ViewFrame>
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
  useEffect(() => {
    let active = true
    void playerApi.leaderboardBoards(source).then(result => {
      if (!active) return
      setBoards(result)
      const first = result[0]
      setSelected(String(typeof first === 'object' && first ? (first as Record<string, unknown>).bangid ?? (first as Record<string, unknown>).id ?? (first as Record<string, unknown>).value ?? '' : first ?? ''))
    }).catch(() => { if (active) setBoards([]) })
    return () => { active = false }
  }, [source])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    setLoading(true)
    void playerApi.leaderboard(source, selected, 1, controller.signal).then(payload => { if (!controller.signal.aborted) setSongs(extractSongs(payload)) }).catch(() => { if (!controller.signal.aborted) setSongs([]) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [selected, source])
  return <ViewFrame title="排行榜" subtitle="查看热门音乐榜单"><section className="react-toolbar-card t-bg-panel"><label>音源<select value={source} onChange={event => setSource(event.target.value)}><option value="wy">网易云</option><option value="tx">QQ音乐</option></select></label><label>榜单<select value={selected} onChange={event => setSelected(event.target.value)}>{boards.map((board, index) => { const value = typeof board === 'object' && board ? String((board as Record<string, unknown>).bangid ?? (board as Record<string, unknown>).id ?? (board as Record<string, unknown>).value ?? index) : String(board); const label = typeof board === 'object' && board ? String((board as Record<string, unknown>).name ?? (board as Record<string, unknown>).title ?? value) : value; return <option key={value} value={value}>{label}</option> })}</select></label></section><section className="react-content-card t-bg-panel">{loading ? <Loading /> : <SongList songs={songs} empty="暂无排行榜歌曲" />}</section></ViewFrame>
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
  const [deviceSongs, setDeviceSongs] = useState<Song[]>([])
  const [activeSource, setActiveSource] = useState<'server' | 'device'>('server')
  const objectUrls = useRef(new Set<string>())
  const playSong = usePlaybackStore(state => state.playSong)
  const notify = usePlayerUiStore(state => state.notify)
  useEffect(() => () => { objectUrls.current.forEach(url => URL.revokeObjectURL(url)); objectUrls.current.clear() }, [])
  const loadCache = async () => {
    setCacheLoading(true)
    setCacheError('')
    try {
      await playerApi.cacheSync(userName || undefined).catch(() => undefined)
      const result = await playerApi.cacheList(userName || undefined)
      setCacheItems(result.data ?? [])
      setSelected(new Set())
    } catch (error) {
      setCacheError(error instanceof Error ? error.message : '本地音乐加载失败')
    } finally {
      setCacheLoading(false)
    }
  }
  useEffect(() => { void loadCache() }, [userName])
  const cacheKey = (item: CacheItem) => `${String(item.rawUsername || userName || '_open')}:${String(item.folder)}:${String(item.filename)}`
  const cacheFileUrl = (item: CacheItem) => {
    const params = new URLSearchParams({ folder: String(item.folder || 'cache') })
    if (item.rawUsername === '_open') params.set('user', '_open')
    return `/api/music/cache/file/${encodeURIComponent(String(item.filename))}?${params.toString()}`
  }
  const cacheSong = (item: CacheItem): Song => ({ ...(item.songInfo ?? {}), id: item.id, songmid: item.songmid ?? item.id, name: item.name, singer: item.singer, album: item.album, source: item.source, img: item.img, quality: item.quality, url: cacheFileUrl(item), cacheItem: item })
  const visibleCacheItems = useMemo(() => {
    const needle = keyword.trim().toLocaleLowerCase()
    return cacheItems.filter(item => (cacheFilter === 'all' || item.folder === cacheFilter) && (!needle || `${item.name} ${item.singer} ${item.album} ${item.filename}`.toLocaleLowerCase().includes(needle)))
  }, [cacheFilter, cacheItems, keyword])
  const onFiles = (files: FileList | null) => {
    if (!files) return
    const next = [...files].filter(file => file.type.startsWith('audio/') || /\.(mp3|flac|m4a|ogg|wav|aac)$/i.test(file.name)).map(file => {
      const url = URL.createObjectURL(file)
      objectUrls.current.add(url)
      return { id: `local-${file.name}-${file.lastModified}`, name: file.name.replace(/\.[^.]+$/, ''), singer: '本地音乐', source: 'local', url, type: file.type }
    })
    setDeviceSongs(current => [...current, ...next])
    notify(next.length ? `已添加 ${next.length} 首本地音乐` : '没有识别到可播放的音频文件')
  }
  const clearDevice = () => { objectUrls.current.forEach(url => URL.revokeObjectURL(url)); objectUrls.current.clear(); setDeviceSongs([]) }
  const toggleSelected = (item: CacheItem) => setSelected(current => { const next = new Set(current); const key = cacheKey(item); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const deleteSelected = async () => {
    const items = visibleCacheItems.filter(item => selected.has(cacheKey(item))).map(item => ({ filename: String(item.filename), folder: String(item.folder), user: item.rawUsername }))
    if (!items.length) return
    try { await playerApi.cacheRemove(items, userName || undefined); notify(`已删除 ${items.length} 个本地文件`); setConfirmOpen(false); await loadCache() } catch (error) { notify(error instanceof Error ? error.message : '删除本地文件失败') }
  }
  const serverSongs = visibleCacheItems.map(cacheSong)
  return <ViewFrame title="本地音乐" subtitle="管理服务器缓存、下载音乐与当前设备中的音频文件"><section className="react-local-drop t-bg-panel"><Icon name="folder-open" /><h2>导入设备音乐</h2><p>文件只在当前浏览器中使用，不会上传到服务器。</p><label className="react-file-button"><Icon name="plus" />选择音频文件<input type="file" accept="audio/*,.flac" multiple onChange={event => onFiles(event.target.files)} /></label></section><section className="react-toolbar-card t-bg-panel react-local-toolbar"><div className="react-segmented" role="tablist" aria-label="本地音乐来源"><button type="button" role="tab" aria-selected={activeSource === 'server'} className={activeSource === 'server' ? 'is-active' : ''} onClick={() => setActiveSource('server')}>服务器音乐</button><button type="button" role="tab" aria-selected={activeSource === 'device'} className={activeSource === 'device' ? 'is-active' : ''} onClick={() => setActiveSource('device')}>设备文件</button></div>{activeSource === 'server' ? <><label>目录<select value={cacheFilter} onChange={event => setCacheFilter(event.target.value as typeof cacheFilter)}><option value="all">全部</option><option value="cache">缓存</option><option value="music">已下载</option></select></label><label className="react-local-search"><Icon name="search" /><input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索歌曲、歌手或文件名" aria-label="搜索本地音乐" /></label><Button onClick={() => void loadCache()} disabled={cacheLoading}><Icon name="rotate" />刷新</Button></> : <span className="react-toolbar-hint">设备文件不会上传到服务器，刷新页面后仍可从服务器音乐恢复。</span>}</section>{activeSource === 'server' ? <section className="react-content-card t-bg-panel"><div className="react-section-heading"><div><h2>服务器音乐 <small>{visibleCacheItems.length} 首</small></h2><p>缓存与明确下载的音乐共用现有服务器存储规则</p></div><div className="react-dialog-actions"><Button onClick={() => setSelected(new Set(visibleCacheItems.map(cacheKey)))} disabled={!visibleCacheItems.length}>全选</Button><Button onClick={() => setSelected(new Set())} disabled={!selected.size}>取消选择</Button><Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={!selected.size}>删除已选（{selected.size}）</Button></div></div>{cacheLoading ? <Loading label="正在扫描本地音乐…" /> : cacheError ? <p className="react-error" role="alert">{cacheError}</p> : visibleCacheItems.length ? <ul className="react-song-list">{visibleCacheItems.map(item => { const song = cacheSong(item); const key = cacheKey(item); return <li className="react-song-row react-local-cache-row" key={key}><input type="checkbox" checked={selected.has(key)} onChange={() => toggleSelected(item)} aria-label={`选择 ${songTitle(song)}`} /><button type="button" className="react-song-main" onClick={() => { void playerApi.cachePlayback({ filename: String(item.filename), folder: String(item.folder), user: item.rawUsername }); playSong(song, serverSongs, serverSongs.findIndex(candidate => songKey(candidate) === songKey(song))) }}><img src={safeImage(item)} width="48" height="48" loading="lazy" alt="" /><span className="react-song-text"><strong>{songTitle(song)}</strong><small>{String(item.singer || '未知歌手')} · {item.folder === 'music' ? '已下载' : '缓存'} · {formatBytes(item.size)}</small></span></button><span className="react-song-quality">{String(item.quality || '未知')}</span><a className="react-row-play" href={cacheFileUrl(item)} download={String(item.filename).split('/').pop()} aria-label={`下载 ${songTitle(song)}`}><Icon name="download" /></a></li> })}</ul> : <div className="react-empty"><Icon name="cloud-arrow-down" /><p>暂无服务器缓存或下载音乐</p></div>}<Modal open={confirmOpen} title="删除本地音乐" onClose={() => setConfirmOpen(false)}><p>确定删除选中的 {selected.size} 个服务器文件吗？该操作会同时清理关联歌词、封面与缓存索引。</p><div className="react-dialog-actions"><Button onClick={() => setConfirmOpen(false)}>取消</Button><Button variant="danger" onClick={() => void deleteSelected()}>确认删除</Button></div></Modal></section> : <section className="react-content-card t-bg-panel"><div className="react-section-heading"><div><h2>设备文件 <small>{deviceSongs.length} 首</small></h2><p>仅保留在本次浏览器会话中</p></div>{deviceSongs.length > 0 && <Button onClick={clearDevice}>清空</Button>}</div>{deviceSongs.length ? <ul className="react-song-list">{deviceSongs.map((song, index) => <li className="react-song-row" key={songKey(song)}><button type="button" className="react-song-main" onClick={() => playSong(song, deviceSongs, index)}><span className="react-local-icon"><Icon name="file-audio" /></span><span className="react-song-text"><strong>{songTitle(song)}</strong><small>设备文件</small></span></button><button type="button" className="react-row-play" onClick={() => playSong(song, deviceSongs, index)} aria-label={`播放 ${songTitle(song)}`}><Icon name="play" /></button></li>)}</ul> : <div className="react-empty"><Icon name="folder-open" /><p>还没有导入设备音乐</p></div>}</section>}</ViewFrame>
}

function safeImage(item: CacheItem): string {
  return safeImageUrl(String(item.img || item.songInfo?.img || item.songInfo?.pic || '/music/assets/yun-yin.png'))
}
