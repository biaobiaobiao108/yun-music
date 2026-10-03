import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { playerApi, playlistIcon, type CacheTask } from './api'
import { Button, Drawer, DrawerState, Icon, Loading, Modal, SafeImage, ToastRegion } from './components'
import { HomeView, GenresView, LibraryAlbumsView, LibraryArtistsView, MobileLibraryView, RecentView } from './library_views'
import { connectAudioCommands, connectPlaybackServiceStore, selectUserLists, useAuthStore, useCacheStore, useLibraryStore, useMediaLibraryStore, usePlaybackStore, usePlayerUiStore, useRecentStore, useSettingsStore, useSleepTimerStore } from './store'
import { formatSongDuration, songAlbum, songArtist, songDurationValue, songImage, songKey, songTitle, type PlayerDetail, type PlayerTab, type Song } from './types'
import { safeImageUrl } from '../../../shared/src/runtime'
import { createPlayerHistoryController, type PlayerHistoryPayload } from './player_history'
import { connectPlayerNavigation, goBack, goForward, parsePlayerHash, VALID_PLAYER_TABS } from './route_state'
import { emitPlaybackService } from './playback_service'
import { buildPlaybackUrl, normalizeCachePlaybackUrl, parseCachePlaybackUrl } from './media_url'
import { PlayerFooterBar } from './player_footer'
import { getSessionGeneration } from './session'
import { useRealtimePoll } from './data/use_realtime_poll'
import { useCacheEvents } from './data/use_cache_events'
import { clearPlayerPerformanceMark, markPlayerPerformance, measurePlayerPerformance } from './performance'

const SongListView = lazy(() => import('./heavy_views').then(module => ({ default: module.SongListView })))
const LeaderboardView = lazy(() => import('./heavy_views').then(module => ({ default: module.LeaderboardView })))
const LocalMusicView = lazy(() => import('./heavy_views').then(module => ({ default: module.LocalMusicView })))
const AddToListDialog = lazy(() => import('./views').then(module => ({ default: module.AddToListDialog })))
const CommentsDialog = lazy(() => import('./views').then(module => ({ default: module.CommentsDialog })))
const CreateListDialog = lazy(() => import('./views').then(module => ({ default: module.CreateListDialog })))
const FavoritesView = lazy(() => import('./views').then(module => ({ default: module.FavoritesView })))
const ImmersiveLyricsView = lazy(() => import('./views').then(module => ({ default: module.ImmersiveLyricsView })))
const LoginDialog = lazy(() => import('./views').then(module => ({ default: module.LoginDialog })))
const SearchDetailView = lazy(() => import('./views').then(module => ({ default: module.SearchDetailView })))
const SearchView = lazy(() => import('./views').then(module => ({ default: module.SearchView })))
const SettingsView = lazy(() => import('./views').then(module => ({ default: module.SettingsView })))
const UserLoginDialog = lazy(() => import('./views').then(module => ({ default: module.UserLoginDialog })))

const QUALITY_FALLBACKS = ['hires', 'flac', '320k', '128k']
type SongUrlResult = { url: string; quality?: string; type?: string; sourceName?: string; fromCache?: boolean }
type PendingSongUrlRequest = {
  promise: Promise<SongUrlResult>
  controller: AbortController
  consumers: number
  settled: boolean
}

const prefetchedUrls = new Map<string, SongUrlResult>()
const pendingSongUrlRequests = new Map<string, PendingSongUrlRequest>()
let songUrlCacheGeneration = getSessionGeneration()

function songUrlPerformanceName(key: string): string {
  return `yun-music:url:${encodeURIComponent(key).slice(0, 160)}`
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  if (!('mediaSession' in navigator)) return
  try { navigator.mediaSession.playbackState = state } catch { /* media session may be unavailable in this context */ }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function joinSongUrlRequest(entry: PendingSongUrlRequest, signal?: AbortSignal): Promise<SongUrlResult> {
  entry.consumers += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    entry.consumers -= 1
    if (!entry.settled && entry.consumers <= 0) entry.controller.abort()
  }
  return withAbort(entry.promise, signal).finally(release)
}

function songUrlCacheKey(song: Song, quality: string): string {
  const generation = getSessionGeneration()
  if (generation !== songUrlCacheGeneration) {
    prefetchedUrls.clear()
    for (const entry of pendingSongUrlRequests.values()) entry.controller.abort()
    pendingSongUrlRequests.clear()
    songUrlCacheGeneration = generation
  }
  return `${generation}:${songKey(song)}:${quality}`
}

function requestSongUrl(song: Song, quality: string, enableAutoSwitchSource: boolean, signal?: AbortSignal, priority: 'high' | 'low' = 'high'): Promise<SongUrlResult> {
  const key = songUrlCacheKey(song, quality)
  if (signal?.aborted) return Promise.reject(abortError())
  const cached = prefetchedUrls.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = pendingSongUrlRequests.get(key)
  if (pending) return joinSongUrlRequest(pending, signal)

  const performanceName = songUrlPerformanceName(key)
  markPlayerPerformance(`${performanceName}:start`)
  const controller = new AbortController()
  let entry: PendingSongUrlRequest
  const request = playerApi.songUrl(song, quality, controller.signal, enableAutoSwitchSource, priority)
    .then(result => {
      markPlayerPerformance(`${performanceName}:end`)
      measurePlayerPerformance(`yun-music:url:${encodeURIComponent(key).slice(0, 160)}`, `${performanceName}:start`, `${performanceName}:end`)
      if (result.url) prefetchedUrls.set(key, result)
      return result
    }, error => {
      markPlayerPerformance(`${performanceName}:end`)
      measurePlayerPerformance(`yun-music:url:${encodeURIComponent(key).slice(0, 160)}`, `${performanceName}:start`, `${performanceName}:end`)
      throw error
    })
    .finally(() => {
      entry.settled = true
      if (pendingSongUrlRequests.get(key) === entry) pendingSongUrlRequests.delete(key)
    })
  entry = { promise: request, controller, consumers: 0, settled: false }
  pendingSongUrlRequests.set(key, entry)
  return joinSongUrlRequest(entry, signal)
}

const NAV_ITEMS: { id: PlayerTab; label: string; icon: string }[] = [
  { id: 'home', label: '首页', icon: 'home' },
  { id: 'songlist', label: '发现', icon: 'compass' },
  { id: 'recent', label: '最近', icon: 'clock' },
  { id: 'library', label: '资料库', icon: 'folder-open' },
  { id: 'search', label: '搜索', icon: 'search' },
]

const MORE_NAV_ITEMS: { id: PlayerTab; label: string; icon: string }[] = [
  { id: 'leaderboard', label: '排行榜', icon: 'chart-line' },
  { id: 'genres', label: '分类', icon: 'shapes' },
  { id: 'favorites', label: '我的收藏', icon: 'heart' },
  { id: 'albums', label: '专辑', icon: 'compact-disc' },
  { id: 'artists', label: '艺人', icon: 'user' },
  { id: 'localmusic', label: '本地音乐', icon: 'folder-open' },
  { id: 'settings', label: '设置', icon: 'gear' },
]

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...MORE_NAV_ITEMS]

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
      case 'library': return <MobileLibraryRoute />
      case 'localmusic': return <LocalMusicView />
      case 'settings': return <SettingsView />
      default: return <SearchView detail={detail?.page === 'search-detail' ? detail : null} />
    }
  })()
  return <Suspense fallback={<Loading label="正在加载页面…" />}>{view}</Suspense>
}

function MobileLibraryRoute() {
  return <MobileLibraryView />
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
  return <><div className={`react-sidebar-backdrop ${sidebarOpen ? 'is-open' : ''}`} onClick={closeSidebar} aria-hidden="true" /><aside id="main-sidebar" className={`react-sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="主导航"><nav className="react-sidebar-nav"><p className="react-sidebar-label">浏览</p>{NAV_ITEMS.map(item => { const isActive = item.id === 'favorites' ? tab === 'favorites' && favoriteListId === 'love' : item.id === 'library' ? ['library', 'favorites', 'albums', 'artists', 'localmusic'].includes(tab) : item.id === 'songlist' ? ['songlist', 'leaderboard', 'genres'].includes(tab) : tab === item.id; return <button type="button" key={item.id} className={`netease-nav-item ${isActive ? 'active-tab' : ''}`} aria-current={isActive ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button> })}<div className="react-sidebar-playlists-heading"><p className="react-sidebar-label">播放列表</p><button type="button" className="react-icon-button" aria-label="新建歌单" onClick={() => setDialog('createList')}><Icon name="plus" /></button></div><div className="react-sidebar-playlists">{userLists.map((list, index) => { const id = String(list.id); const isActive = tab === 'favorites' && favoriteListId === id; return <button type="button" className={`react-sidebar-playlist ${isActive ? 'is-active' : ''}`} aria-current={isActive ? 'page' : undefined} key={`${id}-${index}`} onClick={() => openFavoriteList(id)}><Icon name={playlistIcon(list.icon)} /><span>{list.name}</span><small>{list.list?.length ?? 0}</small></button> })}{!userLists.length && <button type="button" className="react-sidebar-playlist react-sidebar-playlist-empty" onClick={() => setDialog('createList')}><Icon name="plus" /><span>创建第一张歌单</span></button>}</div><p className="react-sidebar-label react-sidebar-more-label">资料库</p>{MORE_NAV_ITEMS.filter(item => item.id !== 'settings').map(item => <button type="button" key={item.id} className={`netease-nav-item ${tab === item.id ? 'active-tab' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}<p className="react-sidebar-label react-sidebar-more-label">偏好设置</p>{MORE_NAV_ITEMS.filter(item => item.id === 'settings').map(item => <button type="button" key={item.id} className={`netease-nav-item ${tab === item.id ? 'active-tab' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav></aside></>
}

const MOBILE_NAV_ITEMS: { id: PlayerTab; label: string; icon: string; activeTabs: PlayerTab[] }[] = [
  { id: 'home', label: '首页', icon: 'house', activeTabs: ['home'] },
  { id: 'songlist', label: '发现', icon: 'compass', activeTabs: ['songlist', 'leaderboard', 'genres'] },
  { id: 'recent', label: '最近', icon: 'clock', activeTabs: ['recent'] },
  { id: 'library', label: '资料库', icon: 'folder-open', activeTabs: ['library', 'favorites', 'albums', 'artists', 'localmusic'] },
  { id: 'search', label: '搜索', icon: 'search', activeTabs: ['search'] },
]

function MobileNavigation() {
  const tab = usePlayerUiStore(state => state.tab)
  const setTab = usePlayerUiStore(state => state.setTab)
  return <nav className="react-mobile-navigation" aria-label="移动端主导航">
    {MOBILE_NAV_ITEMS.map(item => {
      const active = item.activeTabs.includes(tab)
      return <button key={item.id} type="button" className={`react-mobile-navigation-item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => setTab(item.id)}>
        <Icon name={item.icon} /><span>{item.label}</span>
      </button>
    })}
  </nav>
}

function TopBar() {
  const tab = usePlayerUiStore(state => state.tab)
  const favoriteListId = usePlayerUiStore(state => state.favoriteListId)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const setTab = usePlayerUiStore(state => state.setTab)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const userName = useAuthStore(state => state.userName)
  const settings = useSettingsStore(state => state.settings)
  const setSetting = useSettingsStore(state => state.setSetting)
  const userLists = useLibraryStore(selectUserLists)
  const currentPlaylist = favoriteListId === 'love' ? null : userLists.find(list => String(list.id) === favoriteListId)
  const title = tab === 'favorites' && currentPlaylist ? currentPlaylist.name : ALL_NAV_ITEMS.find(item => item.id === tab)?.label ?? (tab === 'favorites' ? '收藏' : '云音')
  useEffect(() => { document.title = `${title} - 云音` }, [title])
  const toggleTheme = () => { const next = settings.appearance === 'dark' ? 'light' : 'dark'; setSetting('appearance', next) }
  return <header className="react-player-topbar"><div className="react-history-controls" aria-label="页面历史"><button type="button" id="player-history-back" className="react-icon-button" aria-label="后退" onClick={goBack}><Icon name="arrow-left" /></button><button type="button" id="player-history-forward" className="react-icon-button" aria-label="前进" onClick={goForward}><Icon name="arrow-right" /></button></div><div className="react-topbar-actions"><button type="button" className="player-secondary-action" aria-label="切换主题" title="切换深浅色" onClick={toggleTheme}><Icon name={settings.appearance === 'dark' ? 'sun' : 'moon'} /></button><button type="button" className="player-secondary-action" aria-label="缓存任务" onClick={() => setDrawer('cache')}><Icon name="cloud-arrow-down" /></button><button type="button" className="player-secondary-action react-mobile-settings-button" aria-label="设置" onClick={() => setTab('settings')}><Icon name="gear" /></button>{userName ? <span className="react-user-chip"><Icon name="circle-user" />{userName}</span> : <button type="button" className="react-secondary-button" onClick={() => setDialog('userLogin')}>登录</button>}</div></header>
}

function AudioRuntime() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const currentSong = usePlaybackStore(state => state.currentSong)
  const quality = usePlaybackStore(state => state.quality)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const setPlaying = usePlaybackStore(state => state.setPlaying)
  const setResolvedUrl = usePlaybackStore(state => state.setResolvedUrl)
  const volume = usePlaybackStore(state => state.volume)
  const muted = usePlaybackStore(state => state.muted)
  const setQuality = usePlaybackStore(state => state.setQuality)
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
  const prefetchIdleHandle = useRef<number | null>(null)
  const prefetchController = useRef<AbortController | null>(null)
  const playbackStatusKey = useRef('')
  const lastProgressEmitAt = useRef(0)
  const lastMediaSessionAt = useRef(0)
  const playbackTraceName = songId ? `yun-music:play:${encodeURIComponent(songId).slice(0, 120)}:${encodeURIComponent(quality)}` : ''

  const cancelScheduledPrefetch = () => {
    prefetchController.current?.abort()
    prefetchController.current = null
    if (prefetchIdleHandle.current === null) return
    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void
    }
    if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(prefetchIdleHandle.current)
    else window.clearTimeout(prefetchIdleHandle.current)
    prefetchIdleHandle.current = null
  }

  useEffect(() => {
    recoveryAttempts.current.clear()
    cacheQueued.current.clear()
    prefetchTriggeredKey.current = ''
    historyRecordedKey.current = ''
    playbackStatusKey.current = ''
  }, [userName])

  const prefetchNext = () => {
    const state = usePlaybackStore.getState()
    const duration = state.duration
    const currentUrl = typeof state.currentSong?.url === 'string' ? state.currentSong.url : ''
    const hasServerCacheUrl = Boolean(currentUrl && parseCachePlaybackUrl(currentUrl))
    if (!settings.enablePreloader || !state.currentSong || hasServerCacheUrl || !Number.isFinite(duration) || duration <= 0 || state.currentTime / duration < .8) return
    if (state.queue.length <= 1) return
    const currentPlaybackKey = `${songKey(state.currentSong)}:${quality}`
    if (prefetchTriggeredKey.current === currentPlaybackKey) return
    const nextIndex = state.mode === 'random'
      ? state.queue.map((_, index) => index).filter(index => index !== state.currentIndex)[Math.floor(Math.random() * (state.queue.length - 1))] ?? -1
      : (state.currentIndex + 1) % state.queue.length
    const nextSong = state.queue[nextIndex]
    if (!nextSong || nextIndex === state.currentIndex || nextSong.url) return
    const key = songUrlCacheKey(nextSong, quality)
    prefetchTriggeredKey.current = currentPlaybackKey
    if (prefetchedUrls.has(key) || pendingSongUrlRequests.has(key)) return

    const runPrefetch = () => {
      prefetchIdleHandle.current = null
      const controller = new AbortController()
      prefetchController.current = controller
      void requestSongUrl(nextSong, quality, settings.enableAutoSwitchSource !== false, controller.signal, 'low')
        .catch(() => undefined)
        .finally(() => {
          if (prefetchController.current === controller) prefetchController.current = null
        })
    }
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }
    if (idleWindow.requestIdleCallback) {
      prefetchIdleHandle.current = idleWindow.requestIdleCallback(runPrefetch, { timeout: 2500 })
    } else {
      prefetchIdleHandle.current = window.setTimeout(runPrefetch, 180)
    }
  }

  useEffect(() => {
    historyRecordedKey.current = ''
    playbackStatusKey.current = ''
    lastProgressEmitAt.current = 0
    lastMediaSessionAt.current = 0
    cancelScheduledPrefetch()
    return cancelScheduledPrefetch
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
    audio.volume = muted ? 0 : volume
    const onPlay = () => {
      setMediaSessionPlaybackState('playing')
      emitPlaybackService({ type: 'play' })
      if (currentSong) {
        const playback = resolvedPlayback.current?.songKey === songId ? resolvedPlayback.current : null
        const playbackUrl = playback?.url || currentSong.url || ''
        const cacheReference = parseCachePlaybackUrl(playbackUrl)
        const status = cacheReference?.folder === 'music'
          ? { message: '下载播放', kind: 'success' as const, key: 'download' }
          : cacheReference?.folder === 'cache'
            ? { message: '命中缓存', kind: 'success' as const, key: 'cache' }
            : playback?.fromCache
              ? { message: '本地播放', kind: 'success' as const, key: 'local' }
              : { message: playback?.sourceName ? `在线播放 · ${playback.sourceName}` : '在线播放', kind: 'info' as const, key: 'online' }
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
      if (settings.enableServerCache && currentSong) {
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
    const onPlaying = () => {
      if (!playbackTraceName) return
      const endMark = `${playbackTraceName}:playing-end`
      markPlayerPerformance(endMark)
      measurePlayerPerformance(`${playbackTraceName}:playing`, `${playbackTraceName}:start`, endMark)
    }
    const onPause = () => {
      setMediaSessionPlaybackState(currentSong ? 'paused' : 'none')
      emitPlaybackService({ type: 'pause' })
    }
    const onTime = () => {
      const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      const now = Date.now()
      // Safari can dispatch timeupdate more often than the footer needs. Keep
      // the imperative audio element smooth while limiting store, React and
      // synchronous localStorage work to a modest update rate.
      if (now - lastProgressEmitAt.current >= 200) {
        lastProgressEmitAt.current = now
        emitPlaybackService({ type: 'progress', currentTime, duration })
        prefetchNext()
      }
      if (currentSong && 'mediaSession' in navigator && navigator.mediaSession.setPositionState && duration > 0 && (now - lastMediaSessionAt.current >= 1000 || currentTime === 0)) {
        lastMediaSessionAt.current = now
        try {
          navigator.mediaSession.setPositionState({
            duration: Math.max(0.1, duration),
            playbackRate: audio.playbackRate || 1,
            position: Math.min(currentTime, duration),
          })
        } catch { /* browser may reject transient media metadata */ }
      }
    }
    const onLoaded = () => {
      const state = usePlaybackStore.getState()
      const resumeTime = state.currentTime
      const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      if (playbackTraceName) {
        const endMark = `${playbackTraceName}:metadata-end`
        markPlayerPerformance(endMark)
        measurePlayerPerformance(`${playbackTraceName}:metadata`, `${playbackTraceName}:start`, endMark, false)
      }
      emitPlaybackService({ type: 'loaded', duration })
      emitPlaybackService({ type: 'progress', currentTime, duration })
      if (settings.autoResume && duration > 0 && resumeTime > 0 && resumeTime < duration && recoveryAttempts.current.has(`resume:${songId}`) === false) {
        audio.currentTime = resumeTime
        emitPlaybackService({ type: 'progress', currentTime: resumeTime, duration })
        recoveryAttempts.current.add(`resume:${songId}`)
      }
    }
    const onEnded = () => { const state = usePlaybackStore.getState(); if (state.mode === 'single' && !state.priorityNextSongKey) { audio.currentTime = 0; void audio.play() } else state.next() }
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
      if (playbackTraceName) clearPlayerPerformanceMark(`${playbackTraceName}:start`)
      emitPlaybackService({ type: 'error', message })
      setResolvedError(message); notify(message)
    }
    audio.addEventListener('play', onPlay); audio.addEventListener('playing', onPlaying); audio.addEventListener('pause', onPause); audio.addEventListener('timeupdate', onTime); audio.addEventListener('loadedmetadata', onLoaded); audio.addEventListener('ended', onEnded); audio.addEventListener('error', onError)
    return () => { audio.removeEventListener('play', onPlay); audio.removeEventListener('playing', onPlaying); audio.removeEventListener('pause', onPause); audio.removeEventListener('timeupdate', onTime); audio.removeEventListener('loadedmetadata', onLoaded); audio.removeEventListener('ended', onEnded); audio.removeEventListener('error', onError) }
  }, [currentSong, enqueueCache, notify, notifyPlayback, playbackTraceName, quality, recordRecent, settings, setPlaying, setQuality, songId, volume, muted])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentSong || !songId) return
    let cancelled = false
    const controller = new AbortController()
    setResolvedError('')
    if (playbackTraceName) markPlayerPerformance(`${playbackTraceName}:start`)
    const storedCacheUrl = typeof currentSong.url === 'string' && currentSong.url
      ? normalizeCachePlaybackUrl(currentSong.url, userName)
      : ''
    const hasStoredCacheUrl = Boolean(storedCacheUrl && parseCachePlaybackUrl(storedCacheUrl))
    if (!hasStoredCacheUrl) notifyPlayback('检查缓存')
    void (async () => {
      try {
        const prefetchKey = songUrlCacheKey(currentSong, quality)
        const result = hasStoredCacheUrl
          ? { url: storedCacheUrl, fromCache: true, sourceName: '本地缓存' }
          : await requestSongUrl(currentSong, quality, settings.enableAutoSwitchSource !== false, controller.signal)
        if (cancelled || controller.signal.aborted) return
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
          notifyPlayback(result.sourceName ? `连接 · ${result.sourceName}` : '连接在线音源')
        }
        if (usePlaybackStore.getState().isPlaying) {
          try {
            await audio.play()
          } catch (error) {
            if (cancelled) return
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
              setPlaying(false)
              notify('歌曲已就绪，请点击播放按钮继续')
              return
            }
            throw error
          }
        }
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
      controller.abort()
      if (playbackTraceName) clearPlayerPerformanceMark(`${playbackTraceName}:start`)
      const playbackUrl = resolvedPlayback.current?.songKey === songId ? resolvedPlayback.current.url : null
      if (resolvedSongKey.current === songId) resolvedSongKey.current = ''
      if (resolvedPlayback.current?.songKey === songId) resolvedPlayback.current = null
      if (playbackUrl && usePlaybackStore.getState().resolvedUrl === playbackUrl) setResolvedUrl(null)
      audio.pause(); audio.removeAttribute('src'); audio.load()
    }
  }, [currentSong, notify, notifyPlayback, playbackTraceName, quality, setPlaying, setResolvedUrl, settings.enableAutoSwitchSource, settings.enableCustomProxy, settings.customProxyUrl, songId, userName])

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
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const mediaSession = navigator.mediaSession
    const setActionHandler = (action: MediaSessionAction, handler: (() => void) | null) => {
      try { mediaSession.setActionHandler?.(action, handler) } catch { /* action is not supported by this browser */ }
    }
    const actions: MediaSessionAction[] = ['play', 'pause', 'previoustrack', 'nexttrack']
    if (!currentSong) {
      mediaSession.metadata = null
      setMediaSessionPlaybackState('none')
      actions.forEach(action => setActionHandler(action, null))
      return
    }

    mediaSession.metadata = new MediaMetadata({
      title: String(currentSong.name || '未知歌曲'),
      artist: String(currentSong.singer || ''),
      album: songAlbum(currentSong),
      artwork: [{ src: safeImageUrl(songImage(currentSong)) }],
    })
    setMediaSessionPlaybackState(audioRef.current && !audioRef.current.paused ? 'playing' : 'paused')
    setActionHandler('play', () => {
      const state = usePlaybackStore.getState()
      if (!state.isPlaying) state.toggle()
    })
    setActionHandler('pause', () => {
      const state = usePlaybackStore.getState()
      if (state.isPlaying) state.toggle()
    })
    setActionHandler('previoustrack', previousPlayback)
    setActionHandler('nexttrack', nextPlayback)
    return () => actions.forEach(action => setActionHandler(action, null))
  }, [currentSong, nextPlayback, previousPlayback])
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
  const currentSong = usePlaybackStore(state => state.currentSong)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const hasHydrated = usePlaybackStore(state => state.hasHydrated)
  const playSong = usePlaybackStore(state => state.playSong)
  const playNext = usePlaybackStore(state => state.playNext)
  const moveQueueItem = usePlaybackStore(state => state.moveQueueItem)
  const remove = usePlaybackStore(state => state.removeFromQueue)
  const mode = usePlaybackStore(state => state.mode)
  const setMode = usePlaybackStore(state => state.setMode)
  const clearQueue = usePlaybackStore(state => state.clearQueue)
  const setTab = usePlayerUiStore(state => state.setTab)
  const notify = usePlayerUiStore(state => state.notify)
  const queueRows = useRef(new Map<string, HTMLLIElement>())
  const queueSongs = useRef(new Map<string, HTMLButtonElement>())
  const queueAnimations = useRef(new Map<string, Animation>())
  const previousQueuePositions = useRef<Map<string, number> | null>(null)
  const [reorderAnnouncement, setReorderAnnouncement] = useState('')
  const modeLabel = mode === 'random' ? '随机播放' : mode === 'single' ? '单曲循环' : '列表循环'
  const cycleMode = () => setMode(mode === 'list' ? 'random' : mode === 'random' ? 'single' : 'list')
  const openSearch = () => { onClose(); setTab('search') }

  const captureQueuePositions = () => {
    const positions = new Map<string, number>()
    queueRows.current.forEach((row, key) => positions.set(key, row.getBoundingClientRect().top))
    previousQueuePositions.current = positions
    return positions
  }

  const reorderQueueItem = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    captureQueuePositions()
    moveQueueItem(fromIndex, toIndex)
  }

  const animateQueuePositions = (song: Song) => {
    const before = queue.map(songKey)
    captureQueuePositions()
    playNext(song)
    const after = usePlaybackStore.getState().queue.map(songKey)
    if (before.length === after.length && before.every((key, index) => key === after[index])) previousQueuePositions.current = null
  }

  useLayoutEffect(() => {
    const previous = previousQueuePositions.current
    previousQueuePositions.current = null
    if (!previous || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    queueRows.current.forEach((row, key) => {
      const oldTop = previous.get(key)
      if (oldTop === undefined) return
      const deltaY = oldTop - row.getBoundingClientRect().top
      if (Math.abs(deltaY) < 1) return
      queueAnimations.current.get(key)?.cancel()
      const animation = row.animate(
        [{ transform: `translateY(${deltaY}px) scale(.995)` }, { transform: 'translateY(0) scale(1)' }],
        { duration: 170, easing: 'cubic-bezier(.2, .75, .25, 1)' },
      )
      queueAnimations.current.set(key, animation)
      animation.onfinish = () => {
        if (queueAnimations.current.get(key) === animation) queueAnimations.current.delete(key)
      }
      animation.oncancel = () => {
        if (queueAnimations.current.get(key) === animation) queueAnimations.current.delete(key)
      }
    })
  }, [queue])

  useEffect(() => {
    return () => {
      queueAnimations.current.forEach(animation => animation.cancel())
      queueAnimations.current.clear()
    }
  }, [])

  const announcePosition = (key: string) => {
    const state = usePlaybackStore.getState()
    const index = state.queue.findIndex(song => songKey(song) === key)
    const song = state.queue[index]
    if (song && index >= 0) setReorderAnnouncement(`${songTitle(song)}，已移动到第 ${index + 1} 首，共 ${state.queue.length} 首`)
  }

  const reorderByKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const state = usePlaybackStore.getState()
    const fromIndex = state.queue.findIndex(song => songKey(song) === key)
    const toIndex = Math.max(0, Math.min(state.queue.length - 1, fromIndex + (event.key === 'ArrowUp' ? -1 : 1)))
    if (fromIndex < 0 || fromIndex === toIndex) return
    reorderQueueItem(fromIndex, toIndex)
    announcePosition(key)
    queueSongs.current.get(key)?.focus({ preventScroll: true })
  }

  return <Drawer
    open={open}
    title="播放列表"
    titleSuffix={<small className="react-drawer-count">{queue.length}</small>}
    onClose={onClose}
    labelledBy="queue-title"
    className="react-queue-drawer react-glass-drawer"
    headerActions={<>
      <button type="button" className={`react-icon-button react-queue-mode-button ${mode === 'single' ? 'is-single' : ''}`} aria-label={'播放模式：' + modeLabel} aria-pressed={mode !== 'list'} title={modeLabel} onClick={cycleMode}>
        <Icon name={mode === 'random' ? 'shuffle' : 'repeat'} />{mode === 'single' && <span className="react-mode-one" aria-hidden="true">1</span>}
      </button>
      <button type="button" className="react-icon-button" aria-label="清空播放列表" title="清空播放列表" disabled={!queue.length} onClick={clearQueue}>
        <Icon name="trash" />
      </button>
      <span className="react-drawer-header-separator" aria-hidden="true" />
    </>}
  >
    {!hasHydrated
      ? <DrawerState kind="loading" title="正在恢复播放列表…" />
      : queue.length
        ? <>
          <p id="queue-reorder-help" className="sr-only">使用上下方向键调整歌曲顺序。</p>
          <span className="sr-only" role="status" aria-live="polite">{reorderAnnouncement}</span>
          <ol className="react-queue-list" aria-label="播放队列">
            {queue.map((song, index) => {
              const key = songKey(song)
              const isCurrent = index === currentIndex && Boolean(currentSong && key === songKey(currentSong))
              return <li
                key={key}
                ref={element => { if (element) queueRows.current.set(key, element); else queueRows.current.delete(key) }}
                data-queue-index={index}
                className={isCurrent ? `is-current ${isPlaying ? 'is-playing' : 'is-paused'}` : ''}
                aria-current={isCurrent ? 'true' : undefined}
              >
                <button
                  ref={element => { if (element) queueSongs.current.set(key, element); else queueSongs.current.delete(key) }}
                  type="button"
                  className="react-queue-song"
                  aria-label={`${songTitle(song)}，${songArtist(song)}${isCurrent ? isPlaying ? '，正在播放' : '，当前歌曲已暂停' : ''}，可用上下方向键调整顺序`}
                  aria-describedby="queue-reorder-help"
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  onKeyDown={event => reorderByKeyboard(event, key)}
                  onClick={() => playSong(song, queue, index)}
                >
                  <span className="react-queue-cover"><SafeImage src={songImage(song)} width="48" height="48" loading="lazy" draggable={false} alt="" />{isCurrent && <span className="react-queue-current-cover"><Icon name={isPlaying ? 'volume-high' : 'pause'} /></span>}</span>
                  <span className="react-queue-meta"><strong title={songTitle(song)}>{songTitle(song)}</strong><small><span className="react-queue-artist" title={songArtist(song)}>{songArtist(song)}</span></small></span>
                </button>
                <span className="react-queue-actions">
                  <time className="react-queue-duration">{formatSongDuration(songDurationValue(song))}</time>
                  <button type="button" className="react-queue-action react-queue-play-next" aria-label={`将 ${songTitle(song)} 设为下一首播放`} title="下一首播放" disabled={isCurrent} onClick={() => { animateQueuePositions(song); notify(currentSong ? `已将《${songTitle(song)}》设为下一首` : `开始播放《${songTitle(song)}》`) }}>
                    <Icon name="forward-step" />
                  </button>
                  <button type="button" className="react-queue-action react-queue-remove" aria-label={'移除 ' + songTitle(song)} title="从播放列表移除" onClick={() => remove(index)}>
                    <Icon name="trash" />
                  </button>
                </span>
              </li>
            })}
          </ol>
        </>
        : <DrawerState kind="empty" icon="list-music" title="播放列表为空" description="搜索歌曲并加入队列后，会显示在这里。" actionLabel="去搜索音乐" onAction={openSearch} />}
  </Drawer>
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

function cacheTaskProgress(task: CacheTask): number | null {
  const value = Number(task.progress)
  if (!Number.isFinite(value)) return null
  return Math.min(100, Math.max(0, Math.round(value)))
}

function CacheDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tasks = useCacheStore(state => state.tasks)
  const stats = useCacheStore(state => state.stats)
  const loading = useCacheStore(state => state.loading)
  const error = useCacheStore(state => state.error)
  const loadedAt = useCacheStore(state => state.loadedAt)
  const pendingTaskActions = useCacheStore(state => state.pendingTaskActions)
  const pendingBatchAction = useCacheStore(state => state.pendingBatchAction)
  const load = useCacheStore(state => state.load)
  const applyQueue = useCacheStore(state => state.applyQueue)
  const pauseTask = useCacheStore(state => state.pauseTask)
  const resumeTask = useCacheStore(state => state.resumeTask)
  const pauseAll = useCacheStore(state => state.pauseAll)
  const resumeAll = useCacheStore(state => state.resumeAll)
  const remove = useCacheStore(state => state.remove)
  const removeCompleted = useCacheStore(state => state.removeCompleted)
  const notify = usePlayerUiStore(state => state.notify)
  const setTab = usePlayerUiStore(state => state.setTab)
  const eventsConnected = useCacheEvents({
    enabled: open,
    onQueue: applyQueue,
    onCache: () => { void load({ force: true }) },
  })
  useEffect(() => { if (open) void load({ force: true }) }, [load, open])
  useRealtimePoll({ enabled: open && !eventsConnected, intervalMs: 1800, refresh: () => load({ force: true }) })
  const cacheSize = stats?.cacheSize ?? stats?.cache?.totalSize
  const musicSize = stats?.musicSize ?? stats?.music?.totalSize
  const completedCount = tasks.filter(task => ['finished', 'exists'].includes(cacheTaskText(task.status))).length
  const hasPausableTasks = tasks.some(task => ['waiting', 'downloading', 'tagging'].includes(cacheTaskText(task.status)))
  const hasResumableTasks = tasks.some(task => ['paused', 'error'].includes(cacheTaskText(task.status)))
  const batchAction = hasPausableTasks ? 'pause' : hasResumableTasks ? 'resume' : null
  const visibleBatchAction = pendingBatchAction === 'pause' || pendingBatchAction === 'resume' ? pendingBatchAction : batchAction
  const openSearch = () => { onClose(); setTab('search') }
  const clearCompleted = async () => {
    if (!completedCount) return
    if (await removeCompleted()) notify(`已清理 ${completedCount} 个已完成任务`)
  }
  return <Drawer
    open={open}
    title="缓存与下载"
    titleSuffix={<small className="react-drawer-count">{tasks.length}</small>}
    onClose={onClose}
    labelledBy="cache-title"
    className="react-download-drawer react-glass-drawer"
    headerActions={<>
      <button type="button" className="react-icon-button" aria-label="刷新缓存与下载" title="刷新" onClick={() => void load({ force: true })}>
        <Icon name="rotate" />
      </button>
      <button type="button" className="react-icon-button" aria-label="清理已完成任务" title="清理已完成任务" disabled={!completedCount || pendingBatchAction !== null || Object.keys(pendingTaskActions).length > 0} onClick={() => void clearCompleted()}>
        <Icon name="broom" />
      </button>
      {visibleBatchAction && <button type="button" className="react-icon-button" aria-label={visibleBatchAction === 'pause' ? '暂停全部下载' : '继续全部下载'} title={visibleBatchAction === 'pause' ? '暂停全部' : '继续全部'} disabled={pendingBatchAction !== null || Object.keys(pendingTaskActions).length > 0} onClick={() => { if (visibleBatchAction === 'pause') void pauseAll(); else void resumeAll() }}>
        <Icon name={pendingBatchAction ? 'spinner' : visibleBatchAction === 'pause' ? 'pause' : 'play'} />
      </button>}
      <span className="react-drawer-header-separator" aria-hidden="true" />
    </>}
  >
    <div className="react-cache-stats" role="group" aria-label="存储空间">
      <div><span>缓存占用</span><strong>{stats ? formatBytes(cacheSize) : '—'}</strong></div>
      <div><span>下载占用</span><strong>{stats ? formatBytes(musicSize) : '—'}</strong></div>
    </div>
    {error && tasks.length > 0 && <p className="react-cache-refresh-error" role="status">无法刷新任务：{error}</p>}
    {loading && loadedAt === 0
      ? <DrawerState kind="loading" title="正在加载下载任务…" />
      : error && tasks.length === 0
        ? <DrawerState kind="error" title="下载任务加载失败" description={error} actionLabel="重试" onAction={() => void load({ force: true })} />
        : tasks.length
          ? <ul className="react-cache-task-list" aria-label="缓存与下载任务">
            {tasks.map((task, index) => {
              const taskId = String(task.id ?? task.songKey ?? '')
              const key = taskId || `${cacheTaskName(task)}-${index}`
              const name = cacheTaskName(task)
              const artist = cacheTaskArtist(task)
              const progress = cacheTaskProgress(task)
              const rawStatus = cacheTaskText(task.status)
              const status = cacheTaskStatus(rawStatus)
              const taskError = cacheTaskText(task.errorMsg)
              const canPause = ['waiting', 'downloading', 'tagging'].includes(rawStatus)
              const canResume = rawStatus === 'paused'
              const canRetry = rawStatus === 'error'
              const pending = taskId ? pendingTaskActions[taskId] : undefined
              const pendingAction = pending === 'pause' || pending === 'resume' ? pending : null
              const taskActionLabel = pendingAction === 'pause' ? '正在暂停' : pendingAction === 'resume' ? '正在继续' : canPause ? '暂停' : canRetry ? '重试' : '继续'
              return <li key={key} className={`react-cache-task${pending ? ' is-busy' : ''}`} aria-busy={Boolean(pending)}>
                <span className="react-cache-cover" aria-hidden="true">
                  <SafeImage src={task.songInfo ? songImage(task.songInfo) : undefined} width="48" height="48" loading="lazy" alt="" />
                </span>
                <span className="react-cache-meta">
                  <strong title={name}>{name}</strong>
                  <small title={taskError || artist || status}>{artist ? `${artist} · ${status}` : status}{progress === null ? '' : ` · ${progress}%`}</small>
                  {taskError && <small className="react-cache-error-detail" title={taskError}>{taskError}</small>}
                  {progress !== null && <progress className="react-task-progress" max="100" value={progress} aria-label={`${name}下载进度`}>{progress}%</progress>}
                </span>
                <span className="react-cache-actions">
                  {(canPause || canResume || canRetry || pendingAction) && <button type="button" className="react-cache-task-action" disabled={!taskId || pending !== undefined || pendingBatchAction !== null} aria-label={`${taskActionLabel} ${name}`} title={`${taskActionLabel}任务`} onClick={() => { if (!taskId) return; void (canPause ? pauseTask(taskId) : resumeTask(taskId)) }}>
                    <Icon name={pendingAction ? 'spinner' : canPause ? 'pause' : canRetry ? 'rotate' : 'play'} />
                  </button>}
                  <button type="button" className="react-cache-remove" disabled={!taskId || pending !== undefined || pendingBatchAction !== null} onClick={() => { if (taskId) void remove(taskId) }} aria-label={`移除${name}`} title="移除任务">
                    <Icon name={pending === 'remove' ? 'spinner' : 'xmark'} />
                  </button>
                </span>
              </li>
            })}
          </ul>
          : <DrawerState kind="empty" icon="download" title="暂无下载任务" description="加入下载的歌曲会显示在这里。" actionLabel="去搜索音乐" onAction={openSearch} />}
  </Drawer>
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
  const [immersiveLyricsMounted, setImmersiveLyricsMounted] = useState(false)
  const closeImmersiveLyrics = useCallback(() => {
    setImmersiveLyricsMounted(true)
    setImmersiveLyrics(false)
  }, [setImmersiveLyrics])
  const openQueueFromPlayer = useCallback(() => {
    closeImmersiveLyrics()
    setDrawer('queue')
  }, [closeImmersiveLyrics, setDrawer])
  const unmountImmersiveLyrics = useCallback(() => setImmersiveLyricsMounted(false), [])
  useEffect(() => { if (immersiveLyrics) setImmersiveLyricsMounted(true) }, [immersiveLyrics])
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
      else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        const time = usePlaybackStore.getState().currentTime
        seekPlayback(Math.max(0, time - 5))
      }
      else if (event.key === 'ArrowRight') {
        event.preventDefault()
        const state = usePlaybackStore.getState()
        seekPlayback(Math.min(state.duration || Infinity, state.currentTime + 5))
      }
      else if (event.key.toLowerCase() === 'm') { event.preventDefault(); toggleMute() }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); nextPlayback() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSidebar, dialog, drawer, immersiveLyrics, keyboardShortcuts, nextPlayback, seekPlayback, setDrawer, setImmersiveLyrics, sidebarOpen, toggleMute, togglePlayback])
  useEffect(() => {
    const initialRoute = parsePlayerHash(window.location.hash)
    const initialTab = initialRoute.tab
    const historyController = createPlayerHistoryController()
    const savedState = window.history.state
    const isSavedDetail = savedState && (savedState.page === 'search-detail' || savedState.page === 'songlist-detail') && savedState.kind && savedState.id
    const initialDetail = isSavedDetail ? {
      page: savedState.page,
      kind: savedState.kind,
      id: savedState.id,
      source: savedState.source || 'wy',
      name: savedState.name,
      image: savedState.image,
    } as PlayerDetail : null
    const targetTab = (savedState?.tabId && VALID_PLAYER_TABS.includes(savedState.tabId as PlayerTab) ? savedState.tabId as PlayerTab : initialTab)
    const targetListId = savedState?.listId || initialRoute.listId

    const initialPayload: PlayerHistoryPayload = initialDetail
      ? {
          page: initialDetail.page,
          tabId: targetTab,
          kind: initialDetail.kind,
          id: initialDetail.id,
          source: initialDetail.source,
          name: initialDetail.name,
          image: initialDetail.image,
          listId: targetListId,
        }
      : {
          page: 'tab',
          tabId: targetTab,
          ...(targetTab === 'favorites' ? { listId: targetListId } : {}),
        }

    historyController.initialize(initialPayload)
    setTabFromHistory(targetTab, initialDetail, targetListId)
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
  return <div className="react-player-shell"><AudioRuntime /><Sidebar /><div className="react-player-main"><TopBar /><main id="player-main-content" className="react-player-content" tabIndex={-1}><PlayerErrorBoundary><PlayerView tab={tab} detail={detail} /></PlayerErrorBoundary></main><PlayerFooter hidden={immersiveFooterHost !== 'normal'} /></div><MobileNavigation />{drawer === 'queue' && <QueueDrawer open onClose={() => setDrawer(null)} />}{(drawer === 'cache' || drawer === 'download') && <CacheDrawer open onClose={() => setDrawer(null)} />}<Suspense fallback={null}>{dialog === 'login' && <LoginDialog open onClose={() => setDialog(null)} />}{dialog === 'userLogin' && <UserLoginDialog open onClose={() => setDialog(null)} />}{dialog === 'createList' && <CreateListDialog open onClose={() => setDialog(null)} />}{dialog === 'addToList' && <AddToListDialog open onClose={closeAddToList} />}{dialog === 'sleep' && <SleepTimerDialog open onClose={() => setDialog(null)} />}{(immersiveLyricsMounted || immersiveLyrics) && <ImmersiveLyricsView open={immersiveLyrics} footerHost={immersiveFooterHost} onFooterHostChange={setImmersiveFooterHost} onClose={closeImmersiveLyrics} onOpenQueue={openQueueFromPlayer} onClosed={unmountImmersiveLyrics} />}{dialog === 'comments' && <CommentsDialog open onClose={() => setDialog(null)} />}</Suspense><ToastRegion /></div>
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
  useEffect(() => {
    const root = document.documentElement
    const onPointerDown = () => root.setAttribute('data-focus-modality', 'pointer')
    const onKeyDown = () => root.removeAttribute('data-focus-modality')
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      root.removeAttribute('data-focus-modality')
    }
  }, [])
  useEffect(() => { void hydrate() }, [hydrate])
  if (checking) return <main className="react-player-loading"><Loading label="正在准备播放器…" /></main>
  if (required && !authenticated) return <PlayerAuthGate />
  return <PlayerShell />
}

function formatBytes(value: unknown): string { const bytes = Number(value); if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}` }
