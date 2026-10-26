import { useEffect, useMemo, useState } from 'react'
import { playerApi, playlistIcon } from './api'
import { Icon, Loading, SafeImage, SelectMenu, SongList } from './components'
import { filterPlaylistCatalog, type PlaylistSort } from './playlist_catalog'
import { navigateToSongEntity, songEntityDetail } from './song_details'
import {
  selectLoveList,
  selectUserLists,
  useAuthStore,
  useLibraryStore,
  useMediaLibraryStore,
  usePlaybackStore,
  usePlayerUiStore,
  useRecentStore,
} from './store'
import type { Song } from './types'
import { songAlbum, songArtist, songImage, songKey, songTitle } from './types'
import { safeImageUrl } from '../../../shared/src/runtime'
import { ViewFrame } from './view_frame'

function ArtworkCard({
  song,
  kind,
  onOpen,
  onPlay,
}: {
  song: Song
  kind?: 'artist' | 'album'
  onOpen?: () => void
  onPlay?: () => void
}) {
  const title =
    kind === 'artist'
      ? String(song.singer || song.artist || song.name)
      : kind === 'album'
        ? songAlbum(song) === '—'
          ? songTitle(song)
          : songAlbum(song)
        : songTitle(song)
  const subtitle =
    kind === 'artist' ? String(song.songCount ?? song.count ?? '') : String(song.singer || song.artist || '专辑')
  return (
    <article className={`react-artwork-card ${kind === 'artist' ? 'is-artist' : ''}`}>
      <button type="button" className="react-artwork-button" onClick={onOpen ?? onPlay}>
        <span className={`react-artwork-cover ${kind === 'artist' ? 'is-artist' : ''}`}>
          <SafeImage src={songImage(song)} width="196" height="196" loading="lazy" alt={`${title}封面`} />
        </span>
        <strong title={title}>{title}</strong>
        {subtitle != null && subtitle !== '' && <small>{subtitle}</small>}
      </button>
      {onPlay && (
        <button
          type="button"
          className="react-artwork-play-button"
          aria-label={`播放 ${title}`}
          onClick={event => {
            event.stopPropagation()
            onPlay()
          }}
        >
          <Icon name="play" />
        </button>
      )}
    </article>
  )
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
  return (
    <ViewFrame title="为你推荐" hideHeader viewId="view-首页">
      <section className="react-home-page">
        <section className="react-home-section">
          <div className="react-home-section-heading">
            <div>
              <p className="react-eyebrow">最近听过</p>
              <h2>最近播放</h2>
            </div>
            <button type="button" className="react-text-button" onClick={() => setTab('recent')}>
              查看全部 <Icon name="arrow-right" />
            </button>
          </div>
          {recentSongs.length ? (
            <div className="react-artwork-grid react-home-rail react-home-songs-grid">
              {recentSongs.slice(0, 24).map(song => (
                <ArtworkCard
                  key={songKey(song)}
                  song={song}
                  onPlay={() => playSong(song, recent, recentQueueIndex(song))}
                />
              ))}
            </div>
          ) : (
            <div className="react-home-empty">
              <Icon name="clock" />
              <p>播放歌曲后，这里会显示你的最近播放</p>
              <button type="button" className="react-text-button" onClick={() => setTab('search')}>
                去搜索音乐
              </button>
            </div>
          )}
        </section>
        <section className="react-home-section">
          <div className="react-home-section-heading">
            <div>
              <p className="react-eyebrow">常听常新</p>
              <h2>收藏歌曲</h2>
            </div>
            <button type="button" className="react-text-button" onClick={() => openFavoriteList('love')}>
              查看全部 <Icon name="arrow-right" />
            </button>
          </div>
          {favoriteSongs.length ? (
            <div className="react-artwork-grid react-home-fixed-grid react-home-songs-grid">
              {favoriteSongs.slice(0, 24).map(song => (
                <ArtworkCard
                  key={songKey(song)}
                  song={song}
                  onPlay={() =>
                    playSong(
                      song,
                      favoriteSongs,
                      favoriteSongs.findIndex(item => songKey(item) === songKey(song)),
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <div className="react-home-empty">
              <Icon name="heart" />
              <p>喜欢的歌曲会显示在这里</p>
              <button type="button" className="react-text-button" onClick={() => setTab('search')}>
                去发现音乐
              </button>
            </div>
          )}
        </section>
        <section className="react-home-section">
          <div className="react-home-section-heading">
            <div>
              <p className="react-eyebrow">来自你的音乐库</p>
              <h2>艺人</h2>
            </div>
            <button type="button" className="react-text-button" onClick={() => setTab('artists')}>
              查看全部 <Icon name="arrow-right" />
            </button>
          </div>
          {visibleArtists.length ? (
            <div className="react-artwork-grid react-artist-grid react-home-fixed-grid react-home-artist-row">
              {visibleArtists.map((artist, index) => (
                <ArtworkCard
                  key={`${songKey(artist)}-${index}`}
                  song={artist}
                  kind="artist"
                  onOpen={() => {
                    const detail = songEntityDetail(artist, 'artist', { allowGenericId: true, allowGenericName: true })
                    if (detail) openLibraryDetail('artists', detail)
                    else navigateToSongEntity(artist, 'artist', { allowGenericName: true })
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="react-home-empty">
              <Icon name="user" />
              <p>艺人会在资料库同步后显示在这里</p>
              <button type="button" className="react-text-button" onClick={() => setTab('artists')}>
                打开艺人
              </button>
            </div>
          )}
        </section>
        <section className="react-home-section react-home-playlists-section">
          <div className="react-home-section-heading">
            <div>
              <p className="react-eyebrow">你的收藏</p>
              <h2>我的歌单</h2>
            </div>
            <button type="button" className="react-text-button" onClick={() => setDialog('createList')}>
              <Icon name="plus" /> 新建歌单
            </button>
          </div>
          {visibleUserLists.length ? (
            <ul className="react-playlist-catalog-list react-home-playlists">
              {visibleUserLists.map((list, index) => {
                const first = list.list?.[0]
                const cover = list.img || list.pic || list.picUrl || list.image || (first && songImage(first))
                return (
                  <li key={`${list.id}-${index}`}>
                    <button
                      type="button"
                      className="react-playlist-catalog-row"
                      onClick={() => openFavoriteList(String(list.id))}
                    >
                      <span className={`react-playlist-catalog-cover ${cover ? '' : 'is-icon'}`}>
                        {cover ? (
                          <SafeImage src={cover} width="64" height="64" loading="lazy" alt="" />
                        ) : (
                          <Icon name={playlistIcon(list.icon)} />
                        )}
                      </span>
                      <span className="react-playlist-catalog-copy">
                        <strong>{list.name}</strong>
                        <small>{list.list?.length ?? 0} 首歌曲</small>
                      </span>
                      <Icon name="chevron-right" />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="react-home-empty">
              <Icon name="list" />
              <p>还没有自定义歌单</p>
              <button type="button" className="react-text-button" onClick={() => setDialog('createList')}>
                <Icon name="plus" /> 创建歌单
              </button>
            </div>
          )}
        </section>
        <HomeDiscovery />
      </section>
    </ViewFrame>
  )
}

type HomeChart = { id: string; name: string; songs: Song[] }

function discoveryItems(payload: unknown, keys: string[]): Song[] {
  if (Array.isArray(payload)) return payload as Song[]
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value as Song[]
    if (value && typeof value === 'object') {
      const nested = discoveryItems(value, keys)
      if (nested.length) return nested
    }
  }
  return []
}

function discoveryId(item: Song, index: number): string {
  return String(item.id ?? item.listId ?? item.dissid ?? item.uid ?? index)
}

function HomeDiscovery() {
  const setTab = usePlayerUiStore(state => state.setTab)
  const setDetail = usePlayerUiStore(state => state.setDetail)
  const [playlists, setPlaylists] = useState<Song[]>([])
  const [charts, setCharts] = useState<HomeChart[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      const [playlistResult, boardResult] = await Promise.allSettled([
        playerApi.songList('wy', '', 'hot', 1, controller.signal, {
          cacheKey: 'home:playlists:wy',
          cacheTtlMs: 300_000,
        }),
        playerApi.leaderboardBoards('wy', controller.signal, {
          cacheKey: 'home:boards:wy',
          cacheTtlMs: 300_000,
        }),
      ])
      if (controller.signal.aborted) return
      if (playlistResult.status === 'fulfilled') {
        setPlaylists(discoveryItems(playlistResult.value, ['list', 'playlists', 'data', 'result']).slice(0, 6))
      }

      if (boardResult.status === 'fulfilled') {
        const boards = boardResult.value.slice(0, 4).map((value, index) => {
          const item = value && typeof value === 'object' ? (value as Song) : { name: String(value) }
          return {
            id: String(item.bangid ?? item.id ?? item.value ?? index),
            name: String(item.name ?? item.title ?? `排行榜 ${index + 1}`),
          }
        })
        const results = await Promise.all(
          boards.map(async board => {
            try {
              const payload = await playerApi.leaderboard('wy', board.id, 1, controller.signal, {
                cacheKey: `home:board:${board.id}:wy`,
                cacheTtlMs: 60_000,
              })
              return { ...board, songs: discoveryItems(payload, ['list', 'songs', 'data', 'result']).slice(0, 3) }
            } catch {
              return { ...board, songs: [] }
            }
          }),
        )
        if (!controller.signal.aborted) setCharts(results)
      }
      if (!controller.signal.aborted) setLoading(false)
    }
    void load()
    return () => controller.abort()
  }, [])

  const openPlaylist = (item: Song, index: number) => {
    const id = discoveryId(item, index)
    setTab('songlist')
    setDetail({
      page: 'songlist-detail',
      kind: 'playlist',
      id,
      source: String(item.source || 'wy'),
      name: String(item.name ?? item.title ?? item.dissname ?? '歌单'),
      image: safeImageUrl(songImage(item), ''),
    })
  }

  return (
    <>
      <section className="react-home-section react-home-playlists-discovery">
        <div className="react-home-section-heading">
          <h2>今日为你推荐</h2>
          <button type="button" className="react-text-button" onClick={() => setTab('songlist')}>
            更多歌单 <Icon name="arrow-right" />
          </button>
        </div>
        {playlists.length ? (
          <div className="react-home-playlist-rail">
            {playlists.map((item, index) => {
              const title = String(item.name ?? item.title ?? item.dissname ?? '未命名歌单')
              return (
                <article className="react-home-playlist-card" key={`${discoveryId(item, index)}-${index}`}>
                  <button type="button" onClick={() => openPlaylist(item, index)}>
                    <SafeImage src={songImage(item)} width="220" height="220" loading="lazy" alt={`${title}封面`} />
                    <strong title={title}>{title}</strong>
                    <small>
                      {String(item.creator ?? item.author ?? '精选歌单')} ·{' '}
                      {String(item.songCount ?? item.trackCount ?? item.total ?? '歌单')}
                    </small>
                  </button>
                </article>
              )
            })}
          </div>
        ) : loading ? (
          <Loading label="正在加载推荐歌单…" />
        ) : (
          <div className="react-home-empty">
            <Icon name="list" />
            <p>暂时没有推荐歌单</p>
            <button type="button" className="react-text-button" onClick={() => setTab('songlist')}>
              打开歌单广场
            </button>
          </div>
        )}
      </section>

      <section className="react-home-section react-home-charts-section">
        <div className="react-home-section-heading">
          <h2>排行榜</h2>
          <button type="button" className="react-text-button" onClick={() => setTab('leaderboard')}>
            查看全部 <Icon name="arrow-right" />
          </button>
        </div>
        {charts.length ? (
          <div className="react-home-charts-grid">
            {charts.map(chart => (
              <button
                type="button"
                className="react-home-chart-card"
                key={chart.id}
                onClick={() => setTab('leaderboard')}
              >
                <span className="react-home-chart-art">
                  {chart.songs[0] ? (
                    <SafeImage src={songImage(chart.songs[0])} width="108" height="108" loading="lazy" alt="" />
                  ) : (
                    <Icon name="chart-line" />
                  )}
                </span>
                <span className="react-home-chart-copy">
                  <strong>{chart.name}</strong>
                  <ol>
                    {chart.songs.map((song, index) => (
                      <li key={songKey(song) || index}>
                        <span>{index + 1}</span>
                        <span title={songTitle(song)}>{songTitle(song)}</span>
                        <small title={songArtist(song)}>{songArtist(song)}</small>
                      </li>
                    ))}
                  </ol>
                </span>
              </button>
            ))}
          </div>
        ) : loading ? (
          <Loading label="正在加载排行榜…" />
        ) : (
          <div className="react-home-empty">
            <Icon name="chart-line" />
            <p>暂时无法加载排行榜</p>
          </div>
        )}
      </section>
    </>
  )
}

export function RecentView() {
  const recent = useRecentStore(state => state.items)
  return (
    <ViewFrame title="最近">
      <section className="react-content-card t-bg-panel react-recent-view">
        <SongList songs={recent} empty="还没有播放历史，去搜索一首歌吧" />
      </section>
    </ViewFrame>
  )
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
    {
      icon: 'circle-user',
      title: '账户登录',
      detail: userName ? `已登录：${userName}` : '登录以同步收藏与播放记录',
      onClick: () => (userName ? setTab('settings') : setDialog('userLogin')),
    },
    { icon: 'heart', title: '收藏歌曲', detail: `${favoriteCount} 首歌曲`, onClick: () => openFavoriteList('love') },
    { icon: 'list', title: '歌单', detail: `${userLists.length} 张歌单`, onClick: () => setTab('playlists') },
    { icon: 'user', title: '艺人', detail: `${artists.length} 位`, onClick: () => setTab('artists') },
    { icon: 'compact-disc', title: '专辑', detail: `${albums.length} 张`, onClick: () => setTab('albums') },
    { icon: 'download', title: '本地音乐', detail: '已下载的歌曲', onClick: () => setTab('localmusic') },
    { icon: 'cloud-arrow-down', title: '缓存任务', detail: '查看后台缓存进度', onClick: () => setDrawer('cache') },
    { icon: 'gear', title: '设置', detail: '外观、播放与账户', onClick: () => setTab('settings') },
  ]
  return (
    <ViewFrame
      title="资料库"
      actions={
        <button
          type="button"
          className="react-player-button react-mobile-create-list"
          onClick={() => setDialog('createList')}
          aria-label="新建歌单"
        >
          <Icon name="plus" />
        </button>
      }
    >
      <section className="react-mobile-library" aria-label="音乐资料库">
        <nav className="react-mobile-library-links" aria-label="资料库分类">
          {rows.map(row => (
            <button key={row.title} type="button" className="react-mobile-library-link" onClick={row.onClick}>
              <span className="react-mobile-library-link-icon">
                <Icon name={row.icon} />
              </span>
              <span className="react-mobile-library-link-copy">
                <strong>{row.title}</strong>
                <small>{row.detail}</small>
              </span>
              <Icon name="chevron-right" />
            </button>
          ))}
        </nav>
      </section>
    </ViewFrame>
  )
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
  return (
    <ViewFrame
      title="歌单"
      actions={
        <div className="react-playlist-catalog-actions">
          <button
            type="button"
            className="react-player-button react-mobile-create-list"
            onClick={() => setDialog('createList')}
            aria-label="新建歌单"
          >
            <Icon name="plus" />
          </button>
          <SelectMenu
            label="歌单排序"
            value={sort}
            options={[
              { value: 'default', label: '默认顺序' },
              { value: 'name', label: '按名称' },
              { value: 'songs', label: '歌曲最多' },
            ]}
            onChange={value => setSort(value as PlaylistSort)}
          />
        </div>
      }
    >
      <section className="react-my-playlists" aria-label="自建歌单">
        <label className="react-playlist-catalog-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="搜索歌单"
            placeholder="搜索歌单"
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
          />
          {keyword && (
            <button type="button" aria-label="清空歌单搜索" onClick={() => setKeyword('')}>
              <Icon name="xmark" />
            </button>
          )}
        </label>
        {loading ? (
          <Loading label="正在加载歌单…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : visibleLists.length ? (
          <ul className="react-playlist-catalog-list">
            {visibleLists.map(list => {
              const first = list.list?.[0]
              const cover = list.img || list.pic || list.picUrl || list.image || (first && songImage(first))
              return (
                <li key={String(list.id)}>
                  <button
                    type="button"
                    className="react-playlist-catalog-row"
                    onClick={() => openFavoriteList(String(list.id))}
                  >
                    <span className={`react-playlist-catalog-cover ${cover ? '' : 'is-icon'}`}>
                      {cover ? (
                        <SafeImage src={cover} width="64" height="64" loading="lazy" alt="" />
                      ) : (
                        <Icon name={playlistIcon(list.icon)} />
                      )}
                    </span>
                    <span className="react-playlist-catalog-copy">
                      <strong>{list.name}</strong>
                      <small>{list.list?.length ?? 0} 首歌曲</small>
                    </span>
                    <Icon name="chevron-right" />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="react-home-empty">
            <Icon name="list" />
            <p>{keyword ? '没有匹配的歌单' : '还没有自建歌单'}</p>
            {keyword ? (
              <button type="button" className="react-text-button" onClick={() => setKeyword('')}>
                清空搜索
              </button>
            ) : (
              <button type="button" className="react-text-button" onClick={() => setDialog('createList')}>
                <Icon name="plus" /> 创建歌单
              </button>
            )}
          </div>
        )}
      </section>
    </ViewFrame>
  )
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
  return (
    <ViewFrame title={title}>
      <section className="react-library-view">
        {loading ? (
          <Loading label={`正在加载${title}…`} />
        ) : error ? (
          <div className="react-empty">
            <Icon name="triangle-exclamation" />
            <p>{error}</p>
          </div>
        ) : items.length ? (
          <div className={`react-artwork-grid react-library-grid ${kind === 'artist' ? 'react-artist-grid' : ''}`}>
            {items.map((item, index) => (
              <ArtworkCard
                key={`${songKey(item)}-${index}`}
                song={item}
                kind={kind}
                onOpen={() => {
                  const detail = songEntityDetail(item, kind, { allowGenericId: true, allowGenericName: true })
                  if (detail) openLibraryDetail(kind === 'artist' ? 'artists' : 'albums', detail)
                  else navigateToSongEntity(item, kind, { allowGenericName: true })
                }}
              />
            ))}
          </div>
        ) : (
          <div className="react-empty">
            <Icon name={kind === 'album' ? 'compact-disc' : 'user'} />
            <p>媒体库还是空的</p>
            <button type="button" className="react-text-button" onClick={() => setTab('search')}>
              去搜索音乐
            </button>
          </div>
        )}
      </section>
    </ViewFrame>
  )
}

export function LibraryAlbumsView() {
  return <MediaGrid kind="album" />
}
export function LibraryArtistsView() {
  return <MediaGrid kind="artist" />
}
