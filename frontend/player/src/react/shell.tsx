import { Component, lazy, Suspense, useEffect, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from 'react'
import { playerApi, type CacheTask } from './api'
import { Button, Drawer, Icon, Loading, Modal, ToastRegion } from './components'
import { AboutView, AddToListDialog, CommentsDialog, CreateListDialog, FavoritesView, ImmersiveLyricsView, LoginDialog, SearchDetailView, SearchView, SettingsView, UserLoginDialog } from './views'
import { HomeView, GenresView, LibraryAlbumsView, LibraryArtistsView, RecentView } from './library_views'
import { connectAudioCommands, connectPlaybackServiceStore, selectUserLists, useAuthStore, useCacheStore, useLibraryStore, useMediaLibraryStore, usePlaybackStore, usePlayerUiStore, useRecentStore, useSettingsStore, useSleepTimerStore } from './store'
import { songAlbum, songArtist, songImage, songKey, songTitle, type PlayerDetail, type PlayerTab, type Song } from './types'
import { formatDuration, safeImageUrl } from '../../../shared/src/runtime'
import { createPlayerHistoryController } from '../features/player_history'
import { connectPlayerNavigation, goBack, goForward, parsePlayerHash, VALID_PLAYER_TABS } from './route_state'
import { emitPlaybackService } from './playback_service'
import { buildPlaybackUrl, normalizeCachePlaybackUrl, parseCachePlaybackUrl } from './media_url'
import { PlayerFooterBar } from './player_footer'

const SongListView = lazy(() => import('./heavy_views').then(module => ({ default: module.SongListView })))
const LeaderboardView = lazy(() => import('./heavy_views').then(module => ({ default: module.LeaderboardView })))
const LocalMusicView = lazy(() => import('./heavy_views').then(module => ({ default: module.LocalMusicView })))

const QUALITY_FALLBACKS = ['hires', 'flac', '320k', '128k']
const prefetchedUrls = new Map<string, { url: string; quality?: string; type?: string; sourceName?: string; fromCache?: boolean }>()
const pendingSongUrlRequests = new Map<string, Promise<{ url: string; quality?: string; type?: string; sourceName?: string; fromCache?: boolean }>>()

function requestSongUrl(song: Song, quality: string, enableAutoSwitchSource: boolean): Promise<{ url: string; quality?: string; type?: string; sourceName?: string; fromCache?: boolean }> {
  const key = `${songKey(song)}:${quality}`
  const cached = prefetchedUrls.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = pendingSongUrlRequests.get(key)
  if (pending) return pending
  const request = playerApi.songUrl(song, quality, undefined, enableAutoSwitchSource)
    .then(result => {
      if (result.url) prefetchedUrls.set(key, result)
      return result
    })
    .finally(() => {
      pendingSongUrlRequests.delete(key)
    })
  pendingSongUrlRequests.set(key, request)
  return request
}

const NAV_ITEMS: { id: PlayerTab; label: string; icon: string }[] = [
  { id: 'home', label: '首页', icon: 'home' },
  { id: 'favorites', label: '收藏', icon: 'heart' },
  { id: 'recent', label: '最近', icon: 'clock' },
  { id: 'albums', label: '专辑', icon: 'compact-disc' },
  { id: 'artists', label: '歌手', icon: 'user' },
  { id: 'library', label: '音乐库', icon: 'folder-open' },
]

const MORE_NAV_ITEMS: { id: PlayerTab; label: string; icon: string }[] = [
  { id: 'search', label: '搜索音乐', icon: 'search' },
  { id: 'songlist', label: '歌单广场', icon: 'list' },
  { id: 'leaderboard', label: '排行榜', icon: 'chart-line' },
  { id: 'settings', label: '设置', icon: 'gear' },
  { id: 'about', label: '关于', icon: 'circle-info' },
]

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...MORE_NAV_ITEMS, { id: 'localmusic' as PlayerTab, label: '本地音乐', icon: 'folder-open' }]

function PlayerView({ tab, detail }: { tab: PlayerTab; detail: PlayerDetail | null }) {
  const view = (() => {
    switch (tab) {
      case 'home': return <HomeView />
      case 'recent': return <RecentView />
      case 'albums': return detail?.page === 'search-detail' ? <SearchDetailView detail={detail} /> : <LibraryAlbumsView />
      case 'artists': return detail?.page === 'search-detail' ? <SearchDetailView detail={detail} /> : <LibraryArtistsView />
      case 'genres': return <GenresView />
      case 'songlist': return <SongListView detail={detail?.page === 'songlist-detail' ? detail : null} />
      case 'leaderboard': return <LeaderboardView />
      case 'favorites': return <FavoritesView />
      case 'library': return <LocalMusicView />
      case 'localmusic': return <LocalMusicView />
      case 'settings': return <SettingsView />
      case 'about': return <AboutView />
      default: return <SearchView detail={detail?.page === 'search-detail' ? detail : null} />
    }
  })()
  return <Suspense fallback={<Loading label="正在加载页面…" />}>{view}</Suspense>
}

class PlayerErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Player] 页面渲染失败', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <section className="react-error-view" role="alert"><Icon name="triangle-exclamation" /><h2>页面加载失败</h2><p>刚才的页面遇到异常，播放器的其他功能仍可继续使用。</p><Button variant="primary" onClick={() => this.setState({ error: null })}>重新加载页面</Button></section>
  }
}

function Sidebar() {
  const tab = usePlayerUiStore(state => state.tab)
  const favoriteListId = usePlayerUiStore(state => state.favoriteListId)
  const setTab = usePlayerUiStore(state => state.setTab)
  const openFavoriteList = usePlayerUiStore(state => state.openFavoriteList)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const sidebarOpen = usePlayerUiStore(state => state.sidebarOpen)
  const closeSidebar = usePlayerUiStore(state => state.closeSidebar)
  const userLists = useLibraryStore(selectUserLists)
  return <><div className={`react-sidebar-backdrop ${sidebarOpen ? 'is-open' : ''}`} onClick={closeSidebar} aria-hidden="true" /><aside id="main-sidebar" className={`react-sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="主导航"><nav className="react-sidebar-nav"><p className="react-sidebar-label">我的空间</p>{NAV_ITEMS.map(item => { const isActive = item.id === 'favorites' ? tab === 'favorites' && favoriteListId === 'love' : tab === item.id; return <button type="button" key={item.id} className={`netease-nav-item ${isActive ? 'active-tab' : ''}`} aria-current={isActive ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button> })}<div className="react-sidebar-playlists-heading"><p className="react-sidebar-label">歌单</p><button type="button" className="react-icon-button" aria-label="新建歌单" onClick={() => setDialog('createList')}><Icon name="plus" /></button></div><div className="react-sidebar-playlists">{userLists.map(list => { const id = String(list.id); const isActive = tab === 'favorites' && favoriteListId === id; return <button type="button" className={`react-sidebar-playlist ${isActive ? 'is-active' : ''}`} aria-current={isActive ? 'page' : undefined} key={id} onClick={() => openFavoriteList(id)}><Icon name="music" /><span>{list.name}</span><small>{list.list?.length ?? 0}</small></button> })}{!userLists.length && <button type="button" className="react-sidebar-playlist react-sidebar-playlist-empty" onClick={() => setDialog('createList')}><Icon name="plus" /><span>创建第一张歌单</span></button>}</div><p className="react-sidebar-label react-sidebar-more-label">更多功能</p>{MORE_NAV_ITEMS.map(item => <button type="button" key={item.id} className={`netease-nav-item ${tab === item.id ? 'active-tab' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav></aside></>
}

function TopBar() {
  const tab = usePlayerUiStore(state => state.tab)
  const favoriteListId = usePlayerUiStore(state => state.favoriteListId)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const userName = useAuthStore(state => state.userName)
  const settings = useSettingsStore(state => state.settings)
  const setSetting = useSettingsStore(state => state.setSetting)
  const userLists = useLibraryStore(selectUserLists)
  const currentPlaylist = favoriteListId === 'love' ? null : userLists.find(list => String(list.id) === favoriteListId)
  const title = tab === 'favorites' && currentPlaylist ? currentPlaylist.name : ALL_NAV_ITEMS.find(item => item.id === tab)?.label ?? (tab === 'favorites' ? '收藏' : '云音')
  useEffect(() => { document.title = `${title} - 云音` }, [title])
  const toggleTheme = () => { const next = settings.appearance === 'dark' ? 'light' : 'dark'; setSetting('appearance', next) }
  return <header className="react-player-topbar"><div className="react-history-controls" aria-label="页面历史"><button type="button" className="react-icon-button" aria-label="后退" onClick={goBack}><Icon name="arrow-left" /></button><button type="button" className="react-icon-button" aria-label="前进" onClick={goForward}><Icon name="arrow-right" /></button></div><div className="react-topbar-actions"><button type="button" className="player-secondary-action" aria-label="切换主题" title="切换深浅色" onClick={toggleTheme}><Icon name={settings.appearance === 'dark' ? 'sun' : 'moon'} /></button><button type="button" className="player-secondary-action" aria-label="缓存任务" onClick={() => setDrawer('cache')}><Icon name="cloud-arrow-down" /></button>{userName ? <span className="react-user-chip"><Icon name="circle-user" />{userName}</span> : <button type="button" className="react-secondary-button" onClick={() => setDialog('userLogin')}>登录</button>}</div></header>
}

function AudioRuntime() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const currentSong = usePlaybackStore(state => state.currentSong)
  const quality = usePlaybackStore(state => state.quality)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const setPlaying = usePlaybackStore(state => state.setPlaying)
  const setResolvedUrl = usePlaybackStore(state => state.setResolvedUrl)
  const volume = usePlaybackStore(state => state.volume)
  const setQuality = usePlaybackStore(state => state.setQuality)
  const togglePlayback = usePlaybackStore(state => state.toggle)
  const previousPlayback = usePlaybackStore(state => state.previous)
  const nextPlayback = usePlaybackStore(state => state.next)
  const recordRecent = useRecentStore(state => state.record)
  const enqueueCache = useCacheStore(state => state.enqueue)
  const settings = useSettingsStore(state => state.settings)
  const userName = useAuthStore(state => state.userName)
  const [resolvedError, setResolvedError] = useState('')
  const notify = usePlayerUiStore(state => state.notify)
  const notifyPlayback = usePlayerUiStore(state => state.notifyPlayback)
  const songId = currentSong ? songKey(currentSong) : ''
  const recoveryAttempts = useRef(new Set<string>())
  const cacheQueued = useRef(new Set<string>())
  const historyRecordedKey = useRef('')
  const resolvedSongKey = useRef('')
  const resolvedPlayback = useRef<{ songKey: string; quality: string; url: string; fromCache: boolean; sourceName?: string } | null>(null)
  const prefetchTriggeredKey = useRef('')
  const playbackStatusKey = useRef('')

  const prefetchNext = () => {
    const state = usePlaybackStore.getState()
    const duration = state.duration
    if (!settings.enablePreloader || !state.currentSong || state.currentSong.url || !Number.isFinite(duration) || duration <= 0 || state.currentTime / duration < .8) return
    if (state.queue.length <= 1) return
    const currentPlaybackKey = `${songKey(state.currentSong)}:${quality}`
    if (prefetchTriggeredKey.current === currentPlaybackKey) return
    const nextIndex = state.mode === 'random'
      ? state.queue.map((_, index) => index).filter(index => index !== state.currentIndex)[Math.floor(Math.random() * (state.queue.length - 1))] ?? -1
      : (state.currentIndex + 1) % state.queue.length
    const nextSong = state.queue[nextIndex]
    if (!nextSong || nextIndex === state.currentIndex || nextSong.url) return
    const key = `${songKey(nextSong)}:${quality}`
    prefetchTriggeredKey.current = currentPlaybackKey
    if (prefetchedUrls.has(key) || pendingSongUrlRequests.has(key)) return
    void requestSongUrl(nextSong, quality, settings.enableAutoSwitchSource !== false).catch(() => undefined)
  }

  useEffect(() => {
    historyRecordedKey.current = ''
    playbackStatusKey.current = ''
  }, [quality, songId])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    connectAudioCommands({
      play: () => {
        const requestedSource = audio.currentSrc || audio.src
        if (!requestedSource || !currentSong) {
          setPlaying(false)
          notify('请选择歌曲后再播放')
          return
        }
        void audio.play().catch(error => {
          // A stale play() rejection must not stop a newer source selected by
          // the user. This is especially common when switching songs quickly.
          const activeSource = audio.currentSrc || audio.src
          if (activeSource !== requestedSource) return
          setPlaying(false)
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            notify('浏览器阻止了自动播放，请点击播放按钮')
          }
        })
      },
      pause: () => audio.pause(),
      seek: time => { if (Number.isFinite(time)) audio.currentTime = Math.max(0, time) },
      volume: next => { audio.volume = next },
    })
    audio.volume = volume
    const onPlay = () => {
      emitPlaybackService({ type: 'play' })
      if (currentSong) {
        const playback = resolvedPlayback.current?.songKey === songId ? resolvedPlayback.current : null
        const playbackUrl = playback?.url || currentSong.url || ''
        const cacheReference = parseCachePlaybackUrl(playbackUrl)
        const status = cacheReference?.folder === 'music'
          ? { message: '已从下载目录播放', kind: 'success' as const, key: 'download' }
          : cacheReference?.folder === 'cache'
            ? { message: '已命中服务器缓存', kind: 'success' as const, key: 'cache' }
            : playback?.fromCache
              ? { message: '已使用本地播放文件', kind: 'success' as const, key: 'local' }
              : { message: playback?.sourceName ? `在线播放 · ${playback.sourceName}` : '在线播放 · 自定义音源', kind: 'info' as const, key: 'online' }
        const statusKey = `${songId}:${quality}:${status.key}:${playback?.sourceName || ''}`
        if (playbackStatusKey.current !== statusKey) {
          playbackStatusKey.current = statusKey
          notifyPlayback(status.message, status.kind)
        }
      }
      const historyKey = `${songId}:${quality}`
      if (currentSong && historyRecordedKey.current !== historyKey) {
        historyRecordedKey.current = historyKey
        recordRecent(currentSong, quality)
      }
      if (settings.enableServerCache && currentSong && !currentSong.url) {
        const cacheKey = `${songKey(currentSong)}:${quality}`
        const playback = resolvedPlayback.current
        const cacheUrl = playback?.songKey === songKey(currentSong) && playback.quality === quality && playback.url && !playback.fromCache
          ? playback.url
          : undefined
        if (!cacheQueued.current.has(cacheKey) && cacheUrl) {
          cacheQueued.current.add(cacheKey)
          // Reuse the URL that started playback. Resolving the source again
          // here would consume a second custom-source quota for the same song.
          void enqueueCache(currentSong, quality, cacheUrl).catch(() => cacheQueued.current.delete(cacheKey))
        }
      }
    }
    const onPause = () => emitPlaybackService({ type: 'pause' })
    const onTime = () => {
      const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      emitPlaybackService({ type: 'progress', currentTime, duration })
      prefetchNext()
    }
    const onLoaded = () => {
      const state = usePlaybackStore.getState()
      const resumeTime = state.currentTime
      const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      emitPlaybackService({ type: 'loaded', duration })
      emitPlaybackService({ type: 'progress', currentTime, duration })
      if (settings.autoResume && duration > 0 && resumeTime > 0 && resumeTime < duration && recoveryAttempts.current.has(`resume:${songId}`) === false) {
        audio.currentTime = resumeTime
        emitPlaybackService({ type: 'progress', currentTime: resumeTime, duration })
        recoveryAttempts.current.add(`resume:${songId}`)
      }
    }
    const onEnded = () => { const state = usePlaybackStore.getState(); if (state.mode === 'single') { audio.currentTime = 0; void audio.play() } else state.next() }
    const onError = () => {
      if (settings.enableAutoDegradeQuality && currentSong && !currentSong.url) {
        const currentQualityIndex = QUALITY_FALLBACKS.indexOf(quality)
        const nextQuality = currentQualityIndex >= 0 ? QUALITY_FALLBACKS[currentQualityIndex + 1] : undefined
        const attemptKey = `${songId}:${quality}`
        if (nextQuality && !recoveryAttempts.current.has(attemptKey)) {
          recoveryAttempts.current.add(attemptKey)
          setQuality(nextQuality)
          notify(`当前音质播放失败，已自动切换到 ${nextQuality}`)
          return
        }
      }
      const message = '播放失败，请尝试切换音质或音源'
      emitPlaybackService({ type: 'error', message })
      setResolvedError(message); notify(message)
    }
    audio.addEventListener('play', onPlay); audio.addEventListener('pause', onPause); audio.addEventListener('timeupdate', onTime); audio.addEventListener('loadedmetadata', onLoaded); audio.addEventListener('ended', onEnded); audio.addEventListener('error', onError)
    return () => { audio.removeEventListener('play', onPlay); audio.removeEventListener('pause', onPause); audio.removeEventListener('timeupdate', onTime); audio.removeEventListener('loadedmetadata', onLoaded); audio.removeEventListener('ended', onEnded); audio.removeEventListener('error', onError) }
  }, [currentSong, enqueueCache, notify, notifyPlayback, quality, recordRecent, settings, setPlaying, setQuality, songId, volume])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentSong || !songId) return
    let cancelled = false
    setResolvedError('')
    if (!currentSong.url) notifyPlayback('正在检查服务器缓存…')
    void (async () => {
      try {
        const prefetchKey = `${songKey(currentSong)}:${quality}`
        const result = typeof currentSong.url === 'string' && currentSong.url
          ? { url: normalizeCachePlaybackUrl(currentSong.url, userName), fromCache: true }
          : await requestSongUrl(currentSong, quality, settings.enableAutoSwitchSource !== false)
        if (cancelled) return
        prefetchedUrls.delete(prefetchKey)
        resolvedPlayback.current = {
          songKey: songId,
          quality,
          url: result.url,
          fromCache: Boolean(result.fromCache) || /\/api\/music\/cache\/file\//.test(result.url),
          sourceName: result.sourceName,
        }
        setResolvedUrl(result.url)
        resolvedSongKey.current = songId
        audio.src = buildPlaybackUrl(result.url, currentSong, settings)
        audio.load()
        if (!parseCachePlaybackUrl(result.url) && !result.fromCache) {
          notifyPlayback(result.sourceName ? `正在连接 · ${result.sourceName}` : '正在连接在线音源…')
        }
        if (usePlaybackStore.getState().isPlaying) await audio.play()
      } catch (error) {
        if (cancelled) return
        setResolvedUrl(null)
        setPlaying(false)
        setResolvedError(error instanceof Error ? error.message : '歌曲解析失败')
        notify(error instanceof Error ? error.message : '歌曲解析失败')
      }
    })()
    return () => {
      cancelled = true
      const playbackUrl = resolvedPlayback.current?.songKey === songId ? resolvedPlayback.current.url : null
      if (resolvedSongKey.current === songId) resolvedSongKey.current = ''
      if (resolvedPlayback.current?.songKey === songId) resolvedPlayback.current = null
      if (playbackUrl && usePlaybackStore.getState().resolvedUrl === playbackUrl) setResolvedUrl(null)
      audio.pause(); audio.removeAttribute('src'); audio.load()
    }
  }, [currentSong, notify, notifyPlayback, quality, setPlaying, setResolvedUrl, settings.enableAutoSwitchSource, settings.enableCustomProxy, settings.customProxyUrl, songId, userName])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentSong || !isPlaying || resolvedSongKey.current !== songId) {
      if (audio && !isPlaying) audio.pause()
      return
    }
    const requestedSource = audio.currentSrc || audio.src
    void audio.play().catch(error => {
      if ((audio.currentSrc || audio.src) !== requestedSource) return
      setPlaying(false)
      if (error instanceof DOMException && error.name === 'NotAllowedError') notify('浏览器阻止了自动播放，请点击播放按钮')
    })
  }, [isPlaying, notify, setPlaying])
  useEffect(() => { if (!currentSong || !('mediaSession' in navigator)) return; navigator.mediaSession.metadata = new MediaMetadata({ title: String(currentSong.name || '未知歌曲'), artist: String(currentSong.singer || ''), album: songAlbum(currentSong), artwork: [{ src: safeImageUrl(songImage(currentSong)) }] }); navigator.mediaSession.setActionHandler?.('play', togglePlayback); navigator.mediaSession.setActionHandler?.('pause', togglePlayback); navigator.mediaSession.setActionHandler?.('previoustrack', previousPlayback); navigator.mediaSession.setActionHandler?.('nexttrack', nextPlayback) }, [currentSong, nextPlayback, previousPlayback, togglePlayback])
  return <><audio ref={audioRef} preload="metadata" aria-label="音乐播放器" />{resolvedError && <span className="sr-only" role="alert">{resolvedError}</span>}</>
}

function PlayerFooter({ hidden = false }: { hidden?: boolean }) {
  // Keep the ordinary footer mounted while immersive lyrics is open. The
  // active footer swaps the stable public id, so the same CSS geometry is
  // reused without duplicate ids or a mount/unmount flash.
  return <PlayerFooterBar isActive={!hidden} />
}

function QueueDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queue = usePlaybackStore(state => state.queue)
  const currentIndex = usePlaybackStore(state => state.currentIndex)
  const playSong = usePlaybackStore(state => state.playSong)
  const remove = usePlaybackStore(state => state.removeFromQueue)
  return <Drawer open={open} title={`播放队列（${queue.length}）`} onClose={onClose} labelledBy="queue-title"><ol className="react-queue-list">{queue.map((song, index) => <li key={`${songKey(song)}-${index}`} className={index === currentIndex ? 'is-current' : ''}><button type="button" onClick={() => playSong(song, queue, index)}><span>{index + 1}</span><span><strong>{songTitle(song)}</strong><small>{String(song.singer || '')}</small></span></button><button type="button" aria-label={`移除 ${songTitle(song)}`} onClick={() => remove(index)}><Icon name="xmark" /></button></li>)}</ol>{!queue.length && <p className="react-empty-text">队列为空</p>}</Drawer>
}

function cacheTaskText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function cacheTaskName(task: CacheTask): string {
  const songInfo = task.songInfo
  const infoName = songInfo ? songTitle(songInfo) : ''
  return cacheTaskText(task.name) || (infoName !== '未知歌曲' ? infoName : '') || cacheTaskText(task.songKey) || '下载任务'
}

function cacheTaskArtist(task: CacheTask): string {
  const artist = task.songInfo ? songArtist(task.songInfo) : ''
  return artist === '未知歌手' ? '' : artist
}

function cacheTaskStatus(status: unknown): string {
  const labels: Record<string, string> = { waiting: '等待中', downloading: '下载中', tagging: '整理中', paused: '已暂停', finished: '已完成', exists: '已完成', error: '失败' }
  const value = cacheTaskText(status)
  return labels[value] || value || '等待中'
}

function CacheDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tasks = useCacheStore(state => state.tasks)
  const stats = useCacheStore(state => state.stats)
  const load = useCacheStore(state => state.load)
  const remove = useCacheStore(state => state.remove)
  const removeCompleted = useCacheStore(state => state.removeCompleted)
  const notify = usePlayerUiStore(state => state.notify)
  useEffect(() => { if (open) void load() }, [load, open])
  const cacheSize = stats?.cacheSize ?? stats?.cache?.totalSize
  const musicSize = stats?.musicSize ?? stats?.music?.totalSize
  const completedCount = tasks.filter(task => ['finished', 'exists'].includes(cacheTaskText(task.status))).length
  const clearCompleted = async () => {
    if (!completedCount) return
    try { await removeCompleted(); notify(`已清理 ${completedCount} 个已完成任务`) } catch (error) { notify(error instanceof Error ? error.message : '清理任务失败') }
  }
  return <Drawer open={open} title="缓存与下载" onClose={onClose} labelledBy="cache-title"><div className="react-cache-stats"><div><span>缓存</span><strong>{formatBytes(cacheSize)}</strong></div><div><span>下载</span><strong>{formatBytes(musicSize)}</strong></div></div><div className="react-drawer-toolbar"><Button onClick={() => void load()}><Icon name="rotate" />刷新</Button><Button onClick={() => void clearCompleted()} disabled={!completedCount}><Icon name="broom" />清理已完成{completedCount ? `（${completedCount}）` : ''}</Button></div>{tasks.length ? <ul className="react-task-list">{tasks.map((task, index) => { const id = String(task.id ?? task.songKey ?? index); const artist = cacheTaskArtist(task); return <li key={`${id}-${index}`}><span><strong>{cacheTaskName(task)}</strong><small>{artist ? `${artist} · ` : ''}{cacheTaskStatus(task.status)}</small></span><button type="button" onClick={() => void remove(id)} aria-label={`移除${cacheTaskName(task)}`}><Icon name="xmark" /></button></li> })}</ul> : <p className="react-empty-text">暂无下载任务</p>}</Drawer>
}

function SleepTimerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const remaining = useSleepTimerStore(state => state.remaining)
  const deadline = useSleepTimerStore(state => state.deadline)
  const setTimer = useSleepTimerStore(state => state.setTimer)
  const cancelTimer = useSleepTimerStore(state => state.cancelTimer)
  const tick = useSleepTimerStore(state => state.tick)
  const [minutes, setMinutes] = useState('30')
  useEffect(() => { if (!deadline) return; const timer = window.setInterval(tick, 1000); return () => window.clearInterval(timer) }, [deadline, tick])
  const label = remaining > 0 ? `${Math.floor(remaining / 60)}分 ${remaining % 60}秒后停止` : '未设置定时器'
  return <Modal open={open} title="睡眠定时器" onClose={onClose}><div className="react-sleep-timer"><p role="status">{label}</p><div className="react-dialog-actions">{[15, 30, 60, 90].map(value => <Button key={value} onClick={() => { setTimer(value); onClose() }}>{value} 分钟</Button>)}</div><form className="react-dialog-form" onSubmit={event => { event.preventDefault(); setTimer(Number(minutes)); onClose() }}><label htmlFor="sleep-minutes">自定义分钟数</label><input id="sleep-minutes" type="number" min="1" max="1440" value={minutes} onChange={event => setMinutes(event.target.value)} /><Button variant="primary" type="submit">开始计时</Button></form>{deadline && <Button onClick={() => { cancelTimer(); onClose() }}>取消定时器</Button>}</div></Modal>
}

export function PlayerShell() {
  const tab = usePlayerUiStore(state => state.tab)
  const detail = usePlayerUiStore(state => state.detail)
  const drawer = usePlayerUiStore(state => state.drawer)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const closeSidebar = usePlayerUiStore(state => state.closeSidebar)
  const sidebarOpen = usePlayerUiStore(state => state.sidebarOpen)
  const setTabFromHistory = usePlayerUiStore(state => state.setTabFromHistory)
  const dialog = usePlayerUiStore(state => state.dialog)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const immersiveLyrics = usePlayerUiStore(state => state.immersiveLyrics)
  const setImmersiveLyrics = usePlayerUiStore(state => state.setImmersiveLyrics)
  const closeAddToList = usePlayerUiStore(state => state.closeAddToList)
  const currentSong = usePlaybackStore(state => state.currentSong)
  const currentTime = usePlaybackStore(state => state.currentTime)
  const duration = usePlaybackStore(state => state.duration)
  const togglePlayback = usePlaybackStore(state => state.toggle)
  const seekPlayback = usePlaybackStore(state => state.seek)
  const toggleMute = usePlaybackStore(state => state.toggleMute)
  const nextPlayback = usePlaybackStore(state => state.next)
  const previousPlayback = usePlaybackStore(state => state.previous)
  const hydratePlayback = usePlaybackStore(state => state.hydrate)
  const hydrateSettings = useSettingsStore(state => state.hydrate)
  const hydrateLibrary = useLibraryStore(state => state.hydrate)
  const hydrateRecent = useRecentStore(state => state.hydrate)
  const hydrateMediaLibrary = useMediaLibraryStore(state => state.hydrate)
  const keyboardShortcuts = useSettingsStore(state => Boolean(state.settings.enableKeyboardShortcuts))
  const [immersiveFooterHost, setImmersiveFooterHost] = useState<'normal' | 'immersive'>('normal')
  useEffect(() => { hydratePlayback(); hydrateRecent(); void hydrateSettings(); void hydrateLibrary(); void hydrateMediaLibrary() }, [hydrateLibrary, hydrateMediaLibrary, hydratePlayback, hydrateRecent, hydrateSettings])
  useEffect(() => connectPlaybackServiceStore(), [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]')
      if (event.key === 'Escape') {
        // Native dialogs own Escape. In particular, comments may be opened on
        // top of immersive lyrics and closing the comments dialog must not
        // close the underlying lyrics surface as well.
        if (dialog) return
        if (drawer) { event.preventDefault(); setDrawer(null); return }
        if (sidebarOpen) { event.preventDefault(); closeSidebar(); return }
        if (immersiveLyrics) { event.preventDefault(); setImmersiveLyrics(false) }
        return
      }
      if (!keyboardShortcuts || editing || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); togglePlayback() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seekPlayback(Math.max(0, currentTime - 5)) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seekPlayback(Math.min(duration || Infinity, currentTime + 5)) }
      else if (event.key.toLowerCase() === 'm') { event.preventDefault(); toggleMute() }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); nextPlayback() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSidebar, currentTime, dialog, drawer, duration, immersiveLyrics, keyboardShortcuts, nextPlayback, seekPlayback, setDrawer, setImmersiveLyrics, sidebarOpen, toggleMute, togglePlayback])
  useEffect(() => {
    const initialRoute = parsePlayerHash(window.location.hash)
    const initialTab = initialRoute.tab
    const historyController = createPlayerHistoryController()
    historyController.initialize({ page: 'tab', tabId: initialTab, ...(initialTab === 'favorites' ? { listId: initialRoute.listId } : {}) })
    setTabFromHistory(initialTab, null, initialRoute.listId)
    const disconnect = connectPlayerNavigation(navigation => {
      const detail = navigation.detail
      historyController.push(detail ? { page: detail.page, tabId: navigation.tab, kind: detail.kind, id: detail.id, source: detail.source, name: detail.name, image: detail.image, listId: navigation.listId } : { page: 'tab', tabId: navigation.tab, listId: navigation.listId })
    })
    const onPop = () => {
      const restored = historyController.handlePopState(window.history.state)
      const parsed = parsePlayerHash(window.location.hash)
      const tabName = (restored?.state.tabId || parsed.tab) as PlayerTab
      if (VALID_PLAYER_TABS.includes(tabName)) {
        const isDetail = restored?.state.page === 'search-detail' || restored?.state.page === 'songlist-detail'
        const restoredDetail = isDetail && restored?.state.kind && restored.state.id ? { page: restored.state.page, kind: restored.state.kind, id: restored.state.id, source: restored.state.source || 'wy', name: restored.state.name, image: restored.state.image } as PlayerDetail : null
        setTabFromHistory(tabName, restoredDetail, restored?.state.listId || parsed.listId || 'love')
      }
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)
    return () => { disconnect(); window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop) }
  }, [setTabFromHistory])
  useEffect(() => { if (currentSong && 'mediaSession' in navigator && navigator.mediaSession.setPositionState && Number.isFinite(duration)) { try { navigator.mediaSession.setPositionState({ duration: Math.max(0.1, duration), playbackRate: 1, position: Math.min(currentTime, duration) }) } catch { /* browser may reject transient media metadata */ } } }, [currentSong, currentTime, duration])
  return <div className="react-player-shell"><AudioRuntime /><Sidebar /><div className="react-player-main"><TopBar /><main id="player-main-content" className="react-player-content" tabIndex={-1}><PlayerErrorBoundary><PlayerView tab={tab} detail={detail} /></PlayerErrorBoundary></main><PlayerFooter hidden={immersiveFooterHost !== 'normal'} /></div><QueueDrawer open={drawer === 'queue'} onClose={() => setDrawer(null)} /><CacheDrawer open={drawer === 'cache' || drawer === 'download'} onClose={() => setDrawer(null)} /><LoginDialog open={dialog === 'login'} onClose={() => setDialog(null)} /><UserLoginDialog open={dialog === 'userLogin'} onClose={() => setDialog(null)} /><CreateListDialog open={dialog === 'createList'} onClose={() => setDialog(null)} /><AddToListDialog open={dialog === 'addToList'} onClose={closeAddToList} /><SleepTimerDialog open={dialog === 'sleep'} onClose={() => setDialog(null)} /><ImmersiveLyricsView open={immersiveLyrics} footerHost={immersiveFooterHost} onFooterHostChange={setImmersiveFooterHost} onClose={() => setImmersiveLyrics(false)} /><CommentsDialog open={dialog === 'comments'} onClose={() => setDialog(null)} /><ToastRegion /></div>
}

export function PlayerAuthGate() {
  const login = useAuthStore(state => state.login)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await login(password) } catch (e) { setError(e instanceof Error ? e.message : '登录失败') } }
  return <main className="react-player-auth-page"><section className="react-player-auth-card"><img src="/music/assets/yun-yin.png" width="80" height="80" alt="云音图标" /><h1>云音</h1><p>输入密码以访问播放器</p><form onSubmit={submit}><label htmlFor="auth-password">访问密码</label><input id="auth-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required placeholder="请输入访问密码" />{error && <p className="react-error" role="alert">{error}</p>}<Button variant="primary" type="submit">进入播放器</Button></form></section></main>
}

export function PlayerApp() {
  const checking = useAuthStore(state => state.checking)
  const required = useAuthStore(state => state.playerAuthRequired)
  const authenticated = useAuthStore(state => state.playerAuthenticated)
  const hydrate = useAuthStore(state => state.hydrate)
  useEffect(() => { void hydrate() }, [hydrate])
  if (checking) return <main className="react-player-loading"><Loading label="正在准备播放器…" /></main>
  if (required && !authenticated) return <PlayerAuthGate />
  return <PlayerShell />
}

function formatBytes(value: unknown): string { const bytes = Number(value); if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}` }
