import { useEffect, useMemo, useState } from 'react'
import { playlistIcon } from './api'
import { Icon, Loading, SafeImage, SelectMenu, SongList } from './components'
import { filterPlaylistCatalog, type PlaylistSort } from './playlist_catalog'
import { navigateToSongEntity, songEntityDetail } from './song_details'
import { selectLoveList, selectUserLists, useAuthStore, useLibraryStore, useMediaLibraryStore, usePlaybackStore, usePlayerUiStore, useRecentStore } from './store'
import type { Song } from './types'
import { songAlbum, songArtist, songImage, songKey, songTitle } from './types'
import { ViewFrame } from './view_frame'

function ArtworkCard({ song, kind, onOpen, onPlay }: { song: Song; kind?: 'artist' | 'album'; onOpen?: () => void; onPlay?: () => void }) {
  const title = kind === 'artist' ? String(song.singer || song.artist || song.name) : kind === 'album' ? (songAlbum(song) === '—' ? songTitle(song) : songAlbum(song)) : songTitle(song)
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
  const recentSongs = recent.slice(0, 24)
  const visibleUserLists = userLists.slice(0, 6)
  const visibleArtists = artists.slice(0, 12)
  const recentQueueIndex = (song: Song) => recent.findIndex(candidate => songKey(candidate) === songKey(song))
  return <ViewFrame title="云鹿音乐" titleIconSrc="/music/assets/yun-yin.png" viewId="view-首页"><section className="react-home-page">
    {!recent.length && <div className="react-home-welcome"><p className="react-eyebrow">MUSIC FOR EVERY MOMENT</p><h2>今天想听些什么？</h2><p>搜索一首歌，开启你的音乐时刻。</p><button type="button" className="react-player-button" onClick={() => setTab('search')}><Icon name="search" /> 搜索音乐</button></div>}
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">最近听过</p><h2>最近播放</h2></div><button type="button" className="react-text-button" onClick={() => setTab('recent')}>查看全部 <Icon name="arrow-right" /></button></div>{recentSongs.length ? <div className="react-artwork-grid react-home-rail react-home-songs-grid">{recentSongs.slice(0, 24).map(song => <ArtworkCard key={songKey(song)} song={song} onPlay={() => playSong(song, recent, recentQueueIndex(song))} />)}</div> : <div className="react-home-empty"><Icon name="clock" /><p>播放歌曲后，这里会显示你的最近播放</p><button type="button" className="react-text-button" onClick={() => setTab('search')}>去搜索音乐</button></div>}</section>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">常听常新</p><h2>收藏歌曲</h2></div><button type="button" className="react-text-button" onClick={() => openFavoriteList('love')}>查看全部 <Icon name="arrow-right" /></button></div>{favoriteSongs.length ? <div className="react-artwork-grid react-home-fixed-grid react-home-songs-grid">{favoriteSongs.slice(0, 24).map(song => <ArtworkCard key={songKey(song)} song={song} onPlay={() => playSong(song, favoriteSongs, favoriteSongs.findIndex(item => songKey(item) === songKey(song)))} />)}</div> : <div className="react-home-empty"><Icon name="heart" /><p>喜欢的歌曲会显示在这里</p><button type="button" className="react-text-button" onClick={() => setTab('search')}>去发现音乐</button></div>}</section>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">来自你的音乐库</p><h2>艺人</h2></div><button type="button" className="react-text-button" onClick={() => setTab('artists')}>查看全部 <Icon name="arrow-right" /></button></div>{visibleArtists.length ? <div className="react-artwork-grid react-artist-grid react-home-fixed-grid react-home-artist-row">{visibleArtists.map((artist, index) => <ArtworkCard key={`${songKey(artist)}-${index}`} song={artist} kind="artist" onOpen={() => { const detail = songEntityDetail(artist, 'artist', { allowGenericId: true, allowGenericName: true }); if (detail) openLibraryDetail('artists', detail); else navigateToSongEntity(artist, 'artist', { allowGenericName: true }) }} />)}</div> : <div className="react-home-empty"><Icon name="user" /><p>艺人会在资料库同步后显示在这里</p><button type="button" className="react-text-button" onClick={() => setTab('artists')}>打开艺人</button></div>}</section>
    <section className="react-home-section"><div className="react-home-section-heading"><div><p className="react-eyebrow">你的收藏</p><h2>我的歌单</h2></div><button type="button" className="react-text-button" onClick={() => setDialog('createList')}><Icon name="plus" /> 新建歌单</button></div>{visibleUserLists.length ? <div className="react-playlist-grid react-home-playlists">{visibleUserLists.map((list, index) => { const first = list.list?.[0]; const showIcon = Boolean(list.icon) || !first; return <button type="button" className="react-home-playlist" key={`${list.id}-${index}`} onClick={() => openFavoriteList(String(list.id))}><span className="react-home-playlist-surface" aria-hidden="true" /><span className={`react-home-playlist-media ${showIcon ? 'is-icon' : ''}`}>{showIcon ? <Icon name={playlistIcon(list.icon)} /> : <SafeImage src={songImage(first)} width="112" height="112" loading="lazy" alt="" />}</span><span className="react-home-playlist-copy"><strong>{list.name}</strong><small>{list.list?.length ?? 0} 首歌曲</small></span><span className="react-home-playlist-arrow" aria-hidden="true"><Icon name="arrow-right" /></span></button> })}</div> : <div className="react-home-empty"><Icon name="list" /><p>还没有自定义歌单</p><button type="button" className="react-text-button" onClick={() => setDialog('createList')}><Icon name="plus" /> 创建歌单</button></div>}</section>
  </section></ViewFrame>
}

export function RecentView() {
  const recent = useRecentStore(state => state.items)
  return <ViewFrame title="最近"><section className="react-content-card t-bg-panel react-recent-view"><SongList songs={recent} empty="还没有播放历史，去搜索一首歌吧" /></section></ViewFrame>
}

export function MobileLibraryView() {
  const setTab = usePlayerUiStore(state => state.setTab)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const userName = useAuthStore(state => state.userName)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const userLists = useLibraryStore(selectUserLists)
  const favoriteCount = useLibraryStore(state => selectLoveList(state).length)
  const albums = useMediaLibraryStore(state => state.albums)
  const artists = useMediaLibraryStore(state => state.artists)
  const rows = [
      { icon: 'circle-user', title: '账户登录', detail: userName ? `已登录：${userName}` : '登录以同步收藏与播放记录', onClick: () => userName ? setTab('settings') : setDialog('userLogin') },
    { icon: 'heart', title: '收藏歌曲', detail: `${favoriteCount} 首歌曲`, onClick: () => openFavoriteList('love') },
    { icon: 'list', title: '歌单', detail: `${userLists.length} 张歌单`, onClick: () => setTab('playlists') },
    { icon: 'user', title: '艺人', detail: `${artists.length} 位`, onClick: () => setTab('artists') },
    { icon: 'compact-disc', title: '专辑', detail: `${albums.length} 张`, onClick: () => setTab('albums') },
    { icon: 'download', title: '本地音乐', detail: '已下载的歌曲', onClick: () => setTab('localmusic') },
    { icon: 'cloud-arrow-down', title: '缓存任务', detail: '查看后台缓存进度', onClick: () => setDrawer('cache') },
    { icon: 'gear', title: '设置', detail: '外观、播放与账户', onClick: () => setTab('settings') },
  ]
  return <ViewFrame title="资料库" actions={<button type="button" className="react-player-button react-mobile-create-list" onClick={() => setDialog('createList')} aria-label="新建歌单"><Icon name="plus" /></button>}>
    <section className="react-mobile-library" aria-label="音乐资料库">
      <nav className="react-mobile-library-links" aria-label="资料库分类">
        {rows.map(row => <button key={row.title} type="button" className="react-mobile-library-link" onClick={row.onClick}>
          <span className="react-mobile-library-link-icon"><Icon name={row.icon} /></span>
          <span className="react-mobile-library-link-copy"><strong>{row.title}</strong><small>{row.detail}</small></span>
          <Icon name="chevron-right" />
        </button>)}
      </nav>
    </section>
  </ViewFrame>
}

export function MyPlaylistsView() {
  const userLists = useLibraryStore(selectUserLists)
  const loading = useLibraryStore(state => state.loading)
  const error = useLibraryStore(state => state.error)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const [keyword, setKeyword] = useState('')
  const [sort, setSort] = useState<PlaylistSort>('default')
  const visibleLists = useMemo(() => filterPlaylistCatalog(userLists, keyword, sort), [userLists, keyword, sort])
  return <ViewFrame title="歌单" actions={<div className="react-playlist-catalog-actions"><button type="button" className="react-player-button react-mobile-create-list" onClick={() => setDialog('createList')} aria-label="新建歌单"><Icon name="plus" /></button><SelectMenu label="歌单排序" value={sort} options={[{ value: 'default', label: '默认顺序' }, { value: 'name', label: '按名称' }, { value: 'songs', label: '歌曲最多' }]} onChange={value => setSort(value as PlaylistSort)} /></div>}>
    <section className="react-my-playlists" aria-label="自建歌单">
      <label className="react-playlist-catalog-search"><Icon name="search" /><input type="search" aria-label="搜索歌单" placeholder="搜索歌单" value={keyword} onChange={event => setKeyword(event.target.value)} />{keyword && <button type="button" aria-label="清空歌单搜索" onClick={() => setKeyword('')}><Icon name="xmark" /></button>}</label>
      {loading ? <Loading label="正在加载歌单…" /> : error ? <p className="react-error" role="alert">{error}</p> : visibleLists.length ? <ul className="react-playlist-catalog-list">{visibleLists.map(list => {
        const first = list.list?.[0]
        const cover = list.img || list.pic || list.picUrl || list.image || (first && songImage(first))
        return <li key={String(list.id)}><button type="button" className="react-playlist-catalog-row" onClick={() => openFavoriteList(String(list.id))}>
          <span className={`react-playlist-catalog-cover ${cover ? '' : 'is-icon'}`}>{cover ? <SafeImage src={cover} width="64" height="64" loading="lazy" alt="" /> : <Icon name={playlistIcon(list.icon)} />}</span>
          <span className="react-playlist-catalog-copy"><strong>{list.name}</strong><small>{list.list?.length ?? 0} 首歌曲</small></span>
          <Icon name="chevron-right" />
        </button></li>
      })}</ul> : <div className="react-home-empty"><Icon name="list" /><p>{keyword ? '没有匹配的歌单' : '还没有自建歌单'}</p>{keyword ? <button type="button" className="react-text-button" onClick={() => setKeyword('')}>清空搜索</button> : <button type="button" className="react-text-button" onClick={() => setDialog('createList')}><Icon name="plus" /> 创建歌单</button>}</div>}
    </section>
  </ViewFrame>
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
