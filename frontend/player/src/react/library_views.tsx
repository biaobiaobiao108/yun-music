import { useEffect, useMemo, useState } from 'react'
import { playlistIcon } from './api'
import { Icon, Loading, SafeImage, SongList } from './components'
import { navigateToSongEntity, songEntityDetail } from './song_details'
import { selectLoveList, selectUserLists, useLibraryStore, useMediaLibraryStore, usePlaybackStore, usePlayerUiStore, useRecentStore } from './store'
import type { Song } from './types'
import { songAlbum, songArtist, songImage, songKey, songTitle } from './types'
import { ViewFrame } from './view_frame'

function sourceOf(song: Song): string {
  return String(song.source || song.platform || 'wy')
}

function ArtworkCard({ song, kind, onOpen, onPlay }: { song: Song; kind?: 'artist' | 'album'; onOpen?: () => void; onPlay?: () => void }) {
  const title = String(kind === 'artist' ? song.singer || song.artist || song.name : songAlbum(song) === '—' ? song.name || '未命名' : songAlbum(song))
  const subtitle = kind === 'artist' ? String(song.songCount ?? song.count ?? '歌手') : String(song.singer || song.artist || '专辑')
  return <article className={`react-artwork-card ${kind === 'artist' ? 'is-artist' : ''}`}>
    <button type="button" className="react-artwork-button" onClick={onOpen ?? onPlay}>
      <span className={`react-artwork-cover ${kind === 'artist' ? 'is-artist' : ''}`}><SafeImage src={songImage(song)} width="196" height="196" loading="lazy" alt={`${title}封面`} /></span>
      <strong title={title}>{title}</strong>
      <small>{subtitle}</small>
    </button>
    {onPlay && <button type="button" className="react-artwork-play-button" aria-label={`播放 ${title}`} onClick={event => { event.stopPropagation(); onPlay() }}><Icon name="play" /></button>}
  </article>
}

export function HomeView() {
  const setTab = usePlayerUiStore(state => state.setTab)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const openLibraryDetail = usePlayerUiStore(state => state.openLibraryDetail)
  const recent = useRecentStore(state => state.items)
  const favoriteSongs = useLibraryStore(selectLoveList)
  const artists = useMediaLibraryStore(state => state.artists)
  const userLists = useLibraryStore(selectUserLists)
  const playSong = usePlaybackStore(state => state.playSong)
  const recentAlbums = useMemo(() => {
    const seen = new Set<string>()
    return recent.filter(song => {
      const key = `${sourceOf(song)}:${String(songAlbum(song) === '—' ? song.name || songKey(song) : songAlbum(song))}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 24)
  }, [recent])
  const visibleUserLists = userLists.slice(0, 6)
  const visibleArtists = artists.slice(0, 12)
  const recentQueueIndex = (song: Song) => recent.findIndex(candidate => songKey(candidate) === songKey(song))
  return <ViewFrame title="首页"><section className="react-home-page">
    {!recent.length && <div className="react-home-welcome"><p className="react-eyebrow">云鹿音乐 · MUSIC FOR EVERY MOMENT</p><h2>今天想听些什么？</h2><p>搜索一首歌，开启你的音乐时刻。</p><button type="button" className="react-player-button" onClick={() => setTab('search')}><Icon name="search" /> 搜索音乐</button></div>}
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">最近听过</p><h2>最近播放</h2></div><button type="button" className="react-text-button" onClick={() => setTab('recent')}>查看全部 <Icon name="arrow-right" /></button></div>{recentAlbums.length ? <div className="react-artwork-grid react-home-rail react-home-songs-grid">{recentAlbums.slice(0, 24).map(song => <ArtworkCard key={songKey(song)} song={song} onPlay={() => playSong(song, recent, recentQueueIndex(song))} />)}</div> : <div className="react-home-empty"><Icon name="clock" /><p>播放歌曲后，这里会显示你的最近播放</p><button type="button" className="react-text-button" onClick={() => setTab('search')}>去搜索音乐</button></div>}</section>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">常听常新</p><h2>收藏歌曲</h2></div><button type="button" className="react-text-button" onClick={() => openFavoriteList('love')}>查看全部 <Icon name="arrow-right" /></button></div>{favoriteSongs.length ? <div className="react-artwork-grid react-home-fixed-grid react-home-songs-grid">{favoriteSongs.slice(0, 24).map(song => <ArtworkCard key={songKey(song)} song={song} onPlay={() => playSong(song, favoriteSongs, favoriteSongs.findIndex(item => songKey(item) === songKey(song)))} />)}</div> : <div className="react-home-empty"><Icon name="heart" /><p>喜欢的歌曲会显示在这里</p><button type="button" className="react-text-button" onClick={() => setTab('search')}>去发现音乐</button></div>}</section>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">来自你的音乐库</p><h2>艺人</h2></div><button type="button" className="react-text-button" onClick={() => setTab('artists')}>查看全部 <Icon name="arrow-right" /></button></div>{visibleArtists.length ? <div className="react-artwork-grid react-artist-grid react-home-fixed-grid react-home-artist-row">{visibleArtists.map((artist, index) => <ArtworkCard key={`${songKey(artist)}-${index}`} song={artist} kind="artist" onOpen={() => { const detail = songEntityDetail(artist, 'artist', { allowGenericId: true, allowGenericName: true }); if (detail) openLibraryDetail('artists', detail); else navigateToSongEntity(artist, 'artist', { allowGenericName: true }) }} />)}</div> : <div className="react-home-empty"><Icon name="user" /><p>艺人会在资料库同步后显示在这里</p><button type="button" className="react-text-button" onClick={() => setTab('artists')}>打开艺人</button></div>}</section>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">你的收藏</p><h2>我的歌单</h2></div><button type="button" className="react-text-button" onClick={() => setDialog('createList')}><Icon name="plus" /> 新建歌单</button></div>{visibleUserLists.length ? <div className="react-playlist-grid react-home-playlists">{visibleUserLists.map((list, index) => { const first = list.list?.[0]; const showIcon = Boolean(list.icon) || !first; return <button type="button" className="react-home-playlist" key={`${list.id}-${index}`} onClick={() => openFavoriteList(String(list.id))}><span className="react-home-playlist-surface" aria-hidden="true" /><span className={`react-home-playlist-media ${showIcon ? 'is-icon' : ''}`}>{showIcon ? <Icon name={playlistIcon(list.icon)} /> : <SafeImage src={songImage(first)} width="112" height="112" loading="lazy" alt="" />}</span><span className="react-home-playlist-copy"><strong>{list.name}</strong><small>{list.list?.length ?? 0} 首歌曲</small></span><span className="react-home-playlist-arrow" aria-hidden="true"><Icon name="arrow-right" /></span></button> })}</div> : <div className="react-home-empty"><Icon name="list" /><p>还没有自定义歌单</p><button type="button" className="react-text-button" onClick={() => setDialog('createList')}><Icon name="plus" /> 创建歌单</button></div>}</section>
  </section></ViewFrame>
}

export function RecentView() {
  const recent = useRecentStore(state => state.items)
  return <ViewFrame title="最近"><section className="react-content-card t-bg-panel react-recent-view"><SongList songs={recent} empty="还没有播放历史，去搜索一首歌吧" /></section></ViewFrame>
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
  return <ViewFrame title={title}><section className="react-library-view">{loading ? <Loading label={`正在加载${title}…`} /> : error ? <div className="react-empty"><Icon name="triangle-exclamation" /><p>{error}</p></div> : items.length ? <div className={`react-artwork-grid react-library-grid ${kind === 'artist' ? 'react-artist-grid' : ''}`}>{items.map((item, index) => <ArtworkCard key={`${songKey(item)}-${index}`} song={item} kind={kind} onOpen={() => { const detail = songEntityDetail(item, kind, { allowGenericId: true, allowGenericName: true }); if (detail) openLibraryDetail(kind === 'artist' ? 'artists' : 'albums', detail); else navigateToSongEntity(item, kind, { allowGenericName: true }) }} />)}</div> : <div className="react-empty"><Icon name={kind === 'album' ? 'compact-disc' : 'user'} /><p>媒体库还是空的</p><button type="button" className="react-text-button" onClick={() => setTab('search')}>去搜索音乐</button></div>}</section></ViewFrame>
}

export function LibraryAlbumsView() { return <MediaGrid kind="album" /> }
export function LibraryArtistsView() { return <MediaGrid kind="artist" /> }
