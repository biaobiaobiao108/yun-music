import { useEffect, useMemo, useState } from 'react'
import { playerApi } from './api'
import { Button, Icon, Loading, SafeImage, SelectMenu, SongList } from './components'
import { navigateToSongEntity, songEntityDetail } from './song_details'
import { selectLoveList, selectUserLists, useLibraryStore, useMediaLibraryStore, usePlaybackStore, usePlayerUiStore, useRecentStore } from './store'
import type { Song } from './types'
import { songAlbum, songImage, songKey, songTitle } from './types'
import { ViewFrame } from './views'

function listOf(payload: unknown, keys: string[] = ['list', 'data', 'result', 'songs']): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as Song[]
  return []
}

function sourceOf(song: Song): string {
  return String(song.source || song.platform || 'wy')
}

function ArtworkCard({ song, kind, onOpen, onPlay }: { song: Song; kind?: 'artist' | 'album'; onOpen?: () => void; onPlay?: () => void }) {
  const title = String(kind === 'artist' ? song.singer || song.artist || song.name : songAlbum(song) === '—' ? song.name || '未命名' : songAlbum(song))
  const subtitle = kind === 'artist' ? String(song.songCount ?? song.count ?? '歌手') : String(song.singer || song.artist || '专辑')
  return <article className={`react-artwork-card ${kind === 'artist' ? 'is-artist' : ''}`}>
    <button type="button" className="react-artwork-button" onClick={onOpen ?? onPlay}>
      <span className="react-artwork-cover"><SafeImage src={songImage(song)} width="196" height="196" loading="lazy" alt={`${title}封面`} /></span>
      <strong title={title}>{title}</strong>
      <small>{subtitle}</small>
    </button>
    {onPlay && <button type="button" className="react-artwork-play-button" aria-label={`播放 ${title}`} onClick={event => { event.stopPropagation(); onPlay() }}><Icon name="play" /></button>}
  </article>
}

function Shortcut({ icon, title, subtitle, className, onClick }: { icon: string; title: string; subtitle: string; className: string; onClick: () => void }) {
  return <button type="button" className={`react-home-shortcut ${className}`} onClick={onClick}><span className="react-home-shortcut-icon"><Icon name={icon} /></span><span><strong>{title}</strong><small>{subtitle}</small></span><Icon name="arrow-right" /></button>
}

export function HomeView() {
  const setTab = usePlayerUiStore(state => state.setTab)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const recent = useRecentStore(state => state.items)
  const loveCount = useLibraryStore(state => selectLoveList(state).length)
  const userLists = useLibraryStore(selectUserLists)
  const albums = useMediaLibraryStore(state => state.albums)
  const playSong = usePlaybackStore(state => state.playSong)
  const playlistCount = userLists.length
  const recentAlbums = useMemo(() => {
    const seen = new Set<string>()
    return recent.filter(song => {
      const key = `${sourceOf(song)}:${String(songAlbum(song) === '—' ? song.name || songKey(song) : songAlbum(song))}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 8)
  }, [recent])
  const visibleUserLists = userLists.slice(0, 6)
  return <ViewFrame title="首页" subtitle="把喜欢的音乐，放在触手可及的地方"><section className="react-home-page">
    <div className="react-home-shortcuts">
      <Shortcut icon="heart" title="我的收藏" subtitle={`${loveCount} 首歌曲`} className="is-love" onClick={() => openFavoriteList('love')} />
      <Shortcut icon="clock" title="最近播放" subtitle={`${recent.length} 首歌曲`} className="is-recent" onClick={() => setTab('recent')} />
      <Shortcut icon="compact-disc" title="音乐库" subtitle={`${albums.length} 张专辑`} className="is-library" onClick={() => setTab('library')} />
      <Shortcut icon="list" title="歌单广场" subtitle={`${playlistCount} 个我的歌单`} className="is-playlist" onClick={() => setTab('songlist')} />
    </div>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">最近听过</p><h2>最近播放</h2></div><button type="button" className="react-text-button" onClick={() => setTab('recent')}>查看全部 <Icon name="arrow-right" /></button></div>{recentAlbums.length ? <div className="react-artwork-grid react-home-rail">{recentAlbums.map((song, index) => <ArtworkCard key={`${songKey(song)}-${index}`} song={song} onPlay={() => playSong(song, recent, index)} />)}</div> : <div className="react-home-empty"><Icon name="clock" /><p>播放歌曲后，这里会显示你的最近播放</p><button type="button" className="react-text-button" onClick={() => setTab('search')}>去搜索音乐</button></div>}</section>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">你的收藏</p><h2>我的歌单</h2></div><button type="button" className="react-text-button" onClick={() => setDialog('createList')}><Icon name="plus" /> 新建歌单</button></div>{visibleUserLists.length ? <div className="react-playlist-grid react-home-playlists">{visibleUserLists.map((list, index) => { const first = list.list?.[0]; return <button type="button" className="react-home-playlist" key={`${list.id}-${index}`} onClick={() => openFavoriteList(String(list.id))}><SafeImage src={songImage(first)} width="112" height="112" loading="lazy" alt="" /><span><strong>{list.name}</strong><small>{list.list?.length ?? 0} 首歌曲</small></span><Icon name="arrow-right" /></button> })}</div> : <div className="react-home-empty"><Icon name="list" /><p>还没有自定义歌单</p><button type="button" className="react-text-button" onClick={() => setDialog('createList')}><Icon name="plus" /> 创建歌单</button></div>}</section>
  </section></ViewFrame>
}

export function RecentView() {
  const recent = useRecentStore(state => state.items)
  return <ViewFrame title="最近" subtitle="最近真正开始播放的歌曲"><section className="react-content-card t-bg-panel react-recent-view"><div className="react-section-heading"><div><h2>播放历史</h2><p>保留最近 50 首歌曲</p></div></div><SongList songs={recent} empty="还没有播放历史，去搜索一首歌吧" /></section></ViewFrame>
}

function MediaGrid({ kind }: { kind: 'album' | 'artist' }) {
  const albums = useMediaLibraryStore(state => state.albums)
  const artists = useMediaLibraryStore(state => state.artists)
  const loading = useMediaLibraryStore(state => state.loading)
  const error = useMediaLibraryStore(state => state.error)
  const openLibraryDetail = usePlayerUiStore(state => state.openLibraryDetail)
  const setTab = usePlayerUiStore(state => state.setTab)
  const items = kind === 'album' ? albums : artists
  const title = kind === 'album' ? '专辑' : '歌手'
  return <ViewFrame title={title} subtitle={`你的音乐库 · 共 ${items.length} 个${kind === 'album' ? '专辑' : '歌手'}`}><section className="react-library-view">{loading ? <Loading label={`正在加载${title}…`} /> : error ? <div className="react-empty"><Icon name="triangle-exclamation" /><p>{error}</p></div> : items.length ? <div className={`react-artwork-grid react-library-grid ${kind === 'artist' ? 'react-artist-grid' : ''}`}>{items.map((item, index) => <ArtworkCard key={`${songKey(item)}-${index}`} song={item} kind={kind} onOpen={() => { const detail = songEntityDetail(item, kind, { allowGenericId: true, allowGenericName: true }); if (detail) openLibraryDetail(kind === 'artist' ? 'artists' : 'albums', detail); else navigateToSongEntity(item, kind, { allowGenericName: true }) }} />)}</div> : <div className="react-empty"><Icon name={kind === 'album' ? 'compact-disc' : 'user'} /><p>媒体库还是空的</p><button type="button" className="react-text-button" onClick={() => setTab('search')}>去搜索音乐</button></div>}</section></ViewFrame>
}

export function LibraryAlbumsView() { return <MediaGrid kind="album" /> }
export function LibraryArtistsView() { return <MediaGrid kind="artist" /> }

type GenreTag = { id: string; name: string }

export function GenresView() {
  const [source, setSource] = useState('wy')
  const [tags, setTags] = useState<GenreTag[]>([])
  const [selected, setSelected] = useState('')
  const [songs, setSongs] = useState<Song[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void playerApi.songListTags(source, controller.signal, { cacheKey: `songlist:tags:${source}`, cacheTtlMs: 300_000 }).then(payload => {
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const values = Array.isArray(record.tags) ? record.tags : Array.isArray(record.categories) ? record.categories : Array.isArray(payload) ? payload : []
      if (active) setTags(values.map((value, index) => typeof value === 'string' ? { id: value, name: value } : { id: String((value as Record<string, unknown>).id ?? (value as Record<string, unknown>).tagId ?? index), name: String((value as Record<string, unknown>).name ?? (value as Record<string, unknown>).title ?? '未命名') }))
    }).catch(() => { if (active) setTags([]) })
    return () => { active = false; controller.abort() }
  }, [source])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void playerApi.songList(source, selected, 'hot', page, controller.signal, { cacheKey: `songlist:${source}:${selected}:hot:${page}`, cacheTtlMs: 60_000 }).then(payload => { if (!controller.signal.aborted) setSongs(listOf(payload)) }).catch(cause => { if (!controller.signal.aborted) { setSongs([]); setError(cause instanceof Error ? cause.message : '风格内容加载失败') } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [page, selected, source])
  return <ViewFrame title="风格" subtitle="按风格发现更多歌单"><section className="react-genres-view"><div className="react-toolbar-card t-bg-panel"><div className="react-toolbar-field"><span>音源</span><SelectMenu label="音源" value={source} options={[{ value: 'wy', label: '网易云' }, { value: 'tx', label: 'QQ音乐' }]} onChange={value => { setSource(value); setSelected(''); setPage(1) }} /></div><div className="react-tag-list" aria-label="风格分类"><button type="button" className={!selected ? 'is-active' : ''} onClick={() => { setSelected(''); setPage(1) }}>全部</button>{tags.map(tag => <button type="button" key={tag.id} className={selected === tag.id ? 'is-active' : ''} onClick={() => { setSelected(tag.id); setPage(1) }}>{tag.name}</button>)}</div></div><section className="react-content-card t-bg-panel"><div className="react-section-heading"><div><h2>{selected ? tags.find(tag => tag.id === selected)?.name ?? '风格歌单' : '热门歌单'}</h2><p>第 {page} 页</p></div></div>{loading ? <Loading /> : error ? <p className="react-error" role="alert">{error}</p> : <SongList songs={songs} empty="这个风格暂时没有歌单" />}<div className="react-pagination react-pagination-bottom"><Button aria-label="上一页" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}><Icon name="chevron-left" /></Button><span>第 {page} 页</span><Button aria-label="下一页" disabled={loading || songs.length < 20} onClick={() => setPage(value => value + 1)}><Icon name="chevron-right" /></Button></div></section></section></ViewFrame>
}
