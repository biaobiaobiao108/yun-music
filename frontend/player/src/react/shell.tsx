import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from 'react'
import { playerApi } from './api'
import { Button, Drawer, Icon, Loading, Modal, SafeImage, SongMeta, Time, ToastRegion } from './components'
import { AboutView, CommentsDialog, CreateListDialog, FavoritesView, ImmersiveLyricsView, LoginDialog, SearchView, SettingsView, UserLoginDialog } from './views'
import { connectAudioCommands, connectPlayerNavigation, useAuthStore, useCacheStore, useLibraryStore, usePlaybackStore, usePlayerUiStore, useSettingsStore, useSleepTimerStore } from './store'
import { songImage, songKey, songTitle, type PlayerDetail, type PlayerTab, type Song } from './types'
import { formatDuration, safeImageUrl } from '../../../shared/src/runtime'
import { createPlayerHistoryController } from '../features/player_history'
import { configureAudioGraph, ensureAudioGraph, getAudioAnalyser, releaseAudioGraph, subscribeAudioGraph } from './audio_graph'
import { buildPlaybackUrl, normalizeCachePlaybackUrl } from './media_url'

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
  { id: 'search', label: '搜索音乐', icon: 'search' },
  { id: 'songlist', label: '歌单广场', icon: 'th-large' },
  { id: 'leaderboard', label: '排行榜', icon: 'chart-line' },
  { id: 'favorites', label: '我的音乐', icon: 'heart' },
  { id: 'localmusic', label: '本地音乐', icon: 'folder-open' },
  { id: 'settings', label: '设置', icon: 'gear' },
  { id: 'about', label: '关于', icon: 'circle-info' },
]

function PlayerView({ tab, detail }: { tab: PlayerTab; detail: PlayerDetail | null }) {
  const view = (() => {
    switch (tab) {
      case 'songlist': return <SongListView detail={detail?.page === 'songlist-detail' ? detail : null} />
      case 'leaderboard': return <LeaderboardView />
      case 'favorites': return <FavoritesView />
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
  const setTab = usePlayerUiStore(state => state.setTab)
  const sidebarOpen = usePlayerUiStore(state => state.sidebarOpen)
  const closeSidebar = usePlayerUiStore(state => state.closeSidebar)
  const userName = useAuthStore(state => state.userName)
  return <><div className={`react-sidebar-backdrop ${sidebarOpen ? 'is-open' : ''}`} onClick={closeSidebar} aria-hidden="true" /><aside id="main-sidebar" className={`react-sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="主导航"><div className="react-sidebar-brand"><img src="/music/assets/yun-yin.png" width="36" height="36" alt="云音图标" /><strong>云音</strong><button type="button" className="react-icon-button react-sidebar-close" onClick={closeSidebar} aria-label="关闭导航菜单"><Icon name="xmark" /></button></div><nav className="react-sidebar-nav"><p>发现音乐</p>{NAV_ITEMS.slice(0, 3).map(item => <button type="button" key={item.id} className={`netease-nav-item ${tab === item.id ? 'active-tab' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}<p>我的音乐</p>{NAV_ITEMS.slice(3).map(item => <button type="button" key={item.id} className={`netease-nav-item ${tab === item.id ? 'active-tab' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav><div className="react-sidebar-user">{userName ? <><Icon name="circle-user" /><span>{userName}</span></> : <button type="button" onClick={() => usePlayerUiStore.getState().setDialog('userLogin')}><Icon name="circle-user" /><span>登录用户账户</span></button>}</div></aside></>
}

function TopBar() {
  const tab = usePlayerUiStore(state => state.tab)
  const toggleSidebar = usePlayerUiStore(state => state.toggleSidebar)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const userName = useAuthStore(state => state.userName)
  const title = NAV_ITEMS.find(item => item.id === tab)?.label ?? '云音'
  useEffect(() => { document.title = `${title} - 云音` }, [title])
  return <header className="react-player-topbar"><button type="button" className="react-icon-button react-menu-button" aria-label="打开导航菜单" onClick={toggleSidebar}><Icon name="bars" /></button><div className="react-history-controls"><button type="button" className="react-icon-button" aria-label="后退" onClick={() => window.history.back()}><Icon name="arrow-left" /></button><button type="button" className="react-icon-button" aria-label="前进" onClick={() => window.history.forward()}><Icon name="arrow-right" /></button></div><div className="react-topbar-title"><p>云音播放器</p><h1>{title}</h1></div><div className="react-topbar-actions"><button type="button" className="player-secondary-action" aria-label="播放队列" onClick={() => setDrawer('queue')}><Icon name="list" /></button><button type="button" className="player-secondary-action" aria-label="缓存任务" onClick={() => setDrawer('cache')}><Icon name="cloud-arrow-down" /></button>{userName ? <span className="react-user-chip"><Icon name="circle-user" />{userName}</span> : <button type="button" className="react-secondary-button" onClick={() => setDialog('userLogin')}>登录</button>}</div></header>
}

function AudioRuntime() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const currentSong = usePlaybackStore(state => state.currentSong)
  const quality = usePlaybackStore(state => state.quality)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const setPlaying = usePlaybackStore(state => state.setPlaying)
  const setProgress = usePlaybackStore(state => state.setProgress)
  const volume = usePlaybackStore(state => state.volume)
  const setQuality = usePlaybackStore(state => state.setQuality)
  const settings = useSettingsStore(state => state.settings)
  const userName = useAuthStore(state => state.userName)
  const [resolvedError, setResolvedError] = useState('')
  const notify = usePlayerUiStore(state => state.notify)
  const songId = currentSong ? songKey(currentSong) : ''
  const recoveryAttempts = useRef(new Set<string>())
  const cacheQueued = useRef(new Set<string>())
  const resolvedSongKey = useRef('')
  const resolvedPlayback = useRef<{ songKey: string; quality: string; url: string; fromCache: boolean } | null>(null)
  const prefetchTriggeredKey = useRef('')

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
      setPlaying(true)
      ensureAudioGraph(audio)
      configureAudioGraph({ enabled: Boolean(settings.enableSoundEffects), preset: String(settings.soundEffectsPreset || 'flat') as 'flat' | 'vocal' | 'bass' | 'focus', gain: Number(settings.soundEffectsGain || 1) })
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
          void useCacheStore.getState().enqueue(currentSong, quality, cacheUrl).catch(() => cacheQueued.current.delete(cacheKey))
        }
      }
    }
    const onPause = () => setPlaying(false)
    const onTime = () => {
      const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      setProgress(currentTime, duration)
      prefetchNext()
    }
    const onLoaded = () => {
      const state = usePlaybackStore.getState()
      const resumeTime = state.currentTime
      const currentTime = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      setProgress(currentTime, duration)
      if (settings.autoResume && duration > 0 && resumeTime > 0 && resumeTime < duration && recoveryAttempts.current.has(`resume:${songId}`) === false) {
        audio.currentTime = resumeTime
        setProgress(resumeTime, duration)
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
      setPlaying(false); setResolvedError('播放失败，请尝试切换音质或音源'); notify('播放失败，请尝试切换音质或音源')
    }
    audio.addEventListener('play', onPlay); audio.addEventListener('pause', onPause); audio.addEventListener('timeupdate', onTime); audio.addEventListener('loadedmetadata', onLoaded); audio.addEventListener('ended', onEnded); audio.addEventListener('error', onError)
    return () => { audio.removeEventListener('play', onPlay); audio.removeEventListener('pause', onPause); audio.removeEventListener('timeupdate', onTime); audio.removeEventListener('loadedmetadata', onLoaded); audio.removeEventListener('ended', onEnded); audio.removeEventListener('error', onError) }
  }, [currentSong, notify, quality, settings, setPlaying, setProgress, setQuality, songId, volume])

  useEffect(() => () => releaseAudioGraph(), [])
  useEffect(() => { configureAudioGraph({ enabled: Boolean(settings.enableSoundEffects), preset: String(settings.soundEffectsPreset || 'flat') as 'flat' | 'vocal' | 'bass' | 'focus', gain: Number(settings.soundEffectsGain || 1) }) }, [settings.enableSoundEffects, settings.soundEffectsGain, settings.soundEffectsPreset])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentSong || !songId) return
    let cancelled = false
    setResolvedError('')
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
        }
        resolvedSongKey.current = songId
        audio.src = buildPlaybackUrl(result.url, currentSong, settings)
        audio.load()
        if (usePlaybackStore.getState().isPlaying) await audio.play()
      } catch (error) {
        if (cancelled) return
        setPlaying(false)
        setResolvedError(error instanceof Error ? error.message : '歌曲解析失败')
        notify(error instanceof Error ? error.message : '歌曲解析失败')
      }
    })()
    return () => { cancelled = true; if (resolvedSongKey.current === songId) resolvedSongKey.current = ''; if (resolvedPlayback.current?.songKey === songId) resolvedPlayback.current = null; audio.pause(); audio.removeAttribute('src'); audio.load() }
  }, [currentSong, notify, quality, setPlaying, settings.enableAutoSwitchSource, settings.enableCustomProxy, settings.customProxyUrl, songId, userName])

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
  useEffect(() => { if (!currentSong || !('mediaSession' in navigator)) return; navigator.mediaSession.metadata = new MediaMetadata({ title: String(currentSong.name || '未知歌曲'), artist: String(currentSong.singer || ''), album: String(currentSong.album || '云音'), artwork: [{ src: safeImageUrl(songImage(currentSong)) }] }); navigator.mediaSession.setActionHandler?.('play', () => usePlaybackStore.getState().toggle()); navigator.mediaSession.setActionHandler?.('pause', () => usePlaybackStore.getState().toggle()); navigator.mediaSession.setActionHandler?.('previoustrack', () => usePlaybackStore.getState().previous()); navigator.mediaSession.setActionHandler?.('nexttrack', () => usePlaybackStore.getState().next()) }, [currentSong])
  return <><audio ref={audioRef} preload="metadata" aria-label="音乐播放器" />{resolvedError && <span className="sr-only" role="alert">{resolvedError}</span>}</>
}

function VisualizerCanvas({ enabled }: { enabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [analyser, setAnalyser] = useState(getAudioAnalyser())
  useEffect(() => subscribeAudioGraph(() => setAnalyser(getAudioAnalyser())), [])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !enabled || !analyser) return
    const context = canvas.getContext('2d')
    if (!context) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const data = new Uint8Array(analyser.frequencyBinCount)
    const draw = () => {
      const width = canvas.clientWidth || 480
      const height = canvas.clientHeight || 30
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); context.setTransform(ratio, 0, 0, ratio, 0, 0) }
      analyser.getByteFrequencyData(data)
      context.clearRect(0, 0, width, height)
      const bars = Math.min(48, data.length)
      const gap = 2
      const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars)
      for (let index = 0; index < bars; index += 1) {
        const value = data[index] / 255
        const barHeight = Math.max(2, value * height)
        const x = index * (barWidth + gap)
        const gradient = context.createLinearGradient(0, height, 0, height - barHeight)
        gradient.addColorStop(0, 'rgba(16,185,129,.22)')
        gradient.addColorStop(1, 'rgba(16,185,129,.9)')
        context.fillStyle = gradient
        context.fillRect(x, height - barHeight, barWidth, barHeight)
      }
    }
    let frame = 0
    const loop = () => { draw(); if (!reducedMotion) frame = requestAnimationFrame(loop) }
    loop()
    return () => cancelAnimationFrame(frame)
  }, [analyser, enabled])
  return enabled ? <canvas ref={canvasRef} className="react-footer-visualizer" aria-label="音频可视化" role="img" /> : null
}

function LegacyPlayerFooter() {
  const currentSong = usePlaybackStore(state => state.currentSong)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const currentTime = usePlaybackStore(state => state.currentTime)
  const duration = usePlaybackStore(state => state.duration)
  const volume = usePlaybackStore(state => state.volume)
  const muted = usePlaybackStore(state => state.muted)
  const mode = usePlaybackStore(state => state.mode)
  const toggle = usePlaybackStore(state => state.toggle)
  const next = usePlaybackStore(state => state.next)
  const previous = usePlaybackStore(state => state.previous)
  const seek = usePlaybackStore(state => state.seek)
  const setVolume = usePlaybackStore(state => state.setVolume)
  const toggleMute = usePlaybackStore(state => state.toggleMute)
  const setMode = usePlaybackStore(state => state.setMode)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const setImmersiveLyrics = usePlayerUiStore(state => state.setImmersiveLyrics)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const notify = usePlayerUiStore(state => state.notify)
  const userName = useAuthStore(state => state.userName)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const isLiked = useLibraryStore(state => Boolean(currentSong && (state.data.loveList ?? []).some(song => songKey(song) === songKey(currentSong))))
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const safeCurrentTime = Number.isFinite(currentTime) && currentTime > 0 ? Math.min(currentTime, safeDuration) : 0
  const download = async () => {
    if (!currentSong) return
    try {
      if (typeof currentSong.url === 'string' && currentSong.url.startsWith('/api/music/cache/file/')) {
        const link = document.createElement('a')
        link.href = normalizeCachePlaybackUrl(currentSong.url, userName)
        link.download = `${songTitle(currentSong)}.mp3`
        link.click()
        notify('已开始下载')
        return
      }
      const result = typeof currentSong.url === 'string' ? { url: currentSong.url } : await playerApi.songUrl(currentSong, 'flac', undefined, true)
      await playerApi.download(currentSong, result.url, 'flac')
      notify('已加入下载队列')
      setDrawer('download')
    } catch (error) { notify(error instanceof Error ? error.message : '下载失败') }
  }
  const toggleLike = async () => {
    if (!currentSong) { notify('请选择歌曲后再收藏'); return }
    try {
      if (isLiked) { await removeSong('love', currentSong); notify('已取消喜欢') }
      else { await addSong('love', currentSong); notify('已添加到喜欢') }
    } catch (error) { notify(error instanceof Error ? error.message : '喜欢操作失败') }
  }
  return <footer id="player-footer" className="react-player-footer"><button type="button" className="react-footer-song" onClick={() => setImmersiveLyrics(true)} aria-label="打开沉浸式歌词"><SafeImage src={songImage(currentSong)} width="52" height="52" alt="" /><span><SongMeta song={currentSong} /></span></button><div className="react-footer-center"><div className="react-footer-controls"><button type="button" className="player-secondary-action" aria-label="上一首" onClick={previous}><Icon name="backward-step" /></button><button type="button" id="btn-play" className="react-play-button" aria-label={isPlaying ? '暂停' : '播放'} onClick={toggle}><Icon name={isPlaying ? 'pause' : 'play'} /></button><button type="button" className="player-secondary-action" aria-label="下一首" onClick={next}><Icon name="forward-step" /></button><button type="button" className={`player-secondary-action ${mode !== 'list' ? 'is-active' : ''}`} aria-label={`播放模式：${mode === 'random' ? '随机' : mode === 'single' ? '单曲循环' : '列表循环'}`} onClick={() => setMode(mode === 'list' ? 'random' : mode === 'random' ? 'single' : 'list')}><Icon name={mode === 'random' ? 'shuffle' : mode === 'single' ? 'repeat-1' : 'repeat'} /></button></div><div className="react-progress-row"><Time value={safeCurrentTime} /><input type="range" min="0" max={safeDuration} step="0.1" value={safeCurrentTime} onChange={event => seek(Number(event.target.value))} aria-label="播放进度" /><Time value={safeDuration} /></div></div><div className="react-footer-actions"><button type="button" id="player-like-btn" className={`player-secondary-action react-like-button ${isLiked ? 'is-active' : ''}`} aria-label={isLiked ? '取消喜欢' : '喜欢'} aria-pressed={isLiked} title={isLiked ? '取消喜欢' : '喜欢'} onClick={() => void toggleLike()}><Icon name={isLiked ? 'heart' : 'heart'} /><span>喜欢</span></button><button type="button" className="player-secondary-action" aria-label={muted ? '取消静音' : '静音'} onClick={toggleMute}><Icon name={muted || volume === 0 ? 'volume-xmark' : volume < 0.5 ? 'volume-low' : 'volume-high'} /></button><input className="react-volume-range" type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" className="player-secondary-action" aria-label="打开评论" onClick={() => setDialog('comments')}><Icon name="comments" /></button><button type="button" className="player-secondary-action" aria-label="下载歌曲" onClick={() => void download()}><Icon name="download" /></button><button type="button" className="player-secondary-action" aria-label="设置睡眠定时器" onClick={() => setDialog('sleep')}><Icon name="moon" /></button><button type="button" className="player-secondary-action" aria-label="打开播放队列" onClick={() => setDrawer('queue')}><Icon name="list" /></button></div></footer>
}

function PlayerFooter() {
  const showVisualizer = useSettingsStore(state => Boolean(state.settings.showFooterVisualizer))
  return <><VisualizerCanvas enabled={showVisualizer} /><LegacyPlayerFooter /></>
}

function QueueDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queue = usePlaybackStore(state => state.queue)
  const currentIndex = usePlaybackStore(state => state.currentIndex)
  const playSong = usePlaybackStore(state => state.playSong)
  const remove = usePlaybackStore(state => state.removeFromQueue)
  return <Drawer open={open} title={`播放队列（${queue.length}）`} onClose={onClose} labelledBy="queue-title"><ol className="react-queue-list">{queue.map((song, index) => <li key={`${songKey(song)}-${index}`} className={index === currentIndex ? 'is-current' : ''}><button type="button" onClick={() => playSong(song, queue, index)}><span>{index + 1}</span><span><strong>{songTitle(song)}</strong><small>{String(song.singer || '')}</small></span></button><button type="button" aria-label={`移除 ${songTitle(song)}`} onClick={() => remove(index)}><Icon name="xmark" /></button></li>)}</ol>{!queue.length && <p className="react-empty-text">队列为空</p>}</Drawer>
}

function CacheDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tasks = useCacheStore(state => state.tasks)
  const stats = useCacheStore(state => state.stats)
  const load = useCacheStore(state => state.load)
  const remove = useCacheStore(state => state.remove)
  useEffect(() => { if (open) void load() }, [load, open])
  return <Drawer open={open} title="缓存与下载" onClose={onClose} labelledBy="cache-title"><div className="react-cache-stats"><div><span>缓存</span><strong>{formatBytes(stats?.cacheSize)}</strong></div><div><span>下载</span><strong>{formatBytes(stats?.musicSize)}</strong></div></div><div className="react-drawer-toolbar"><Button onClick={() => void load()}><Icon name="rotate" />刷新</Button></div>{tasks.length ? <ul className="react-task-list">{tasks.map((task, index) => { const id = String(task.id ?? task.songKey ?? index); return <li key={`${id}-${index}`}><span><strong>{String(task.name || task.songKey || '下载任务')}</strong><small>{String(task.status || '等待中')}</small></span><button type="button" onClick={() => void remove(id)} aria-label="移除任务"><Icon name="xmark" /></button></li> })}</ul> : <p className="react-empty-text">暂无下载任务</p>}</Drawer>
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
  const dialog = usePlayerUiStore(state => state.dialog)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const immersiveLyrics = usePlayerUiStore(state => state.immersiveLyrics)
  const setImmersiveLyrics = usePlayerUiStore(state => state.setImmersiveLyrics)
  const currentSong = usePlaybackStore(state => state.currentSong)
  const hydratePlayback = usePlaybackStore(state => state.hydrate)
  const hydrateSettings = useSettingsStore(state => state.hydrate)
  const hydrateLibrary = useLibraryStore(state => state.hydrate)
  const keyboardShortcuts = useSettingsStore(state => Boolean(state.settings.enableKeyboardShortcuts))
  useEffect(() => { hydratePlayback(); void hydrateSettings(); void hydrateLibrary() }, [hydrateLibrary, hydratePlayback, hydrateSettings])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]')
      if (event.key === 'Escape') {
        if (usePlayerUiStore.getState().immersiveLyrics || usePlayerUiStore.getState().dialog || usePlayerUiStore.getState().drawer || usePlayerUiStore.getState().sidebarOpen) {
          event.preventDefault()
          usePlayerUiStore.setState({ immersiveLyrics: false, dialog: null, drawer: null, sidebarOpen: false })
        }
        return
      }
      if (!keyboardShortcuts || editing || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); usePlaybackStore.getState().toggle() }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); const state = usePlaybackStore.getState(); state.seek(Math.max(0, state.currentTime - 5)) }
      else if (event.key === 'ArrowRight') { event.preventDefault(); const state = usePlaybackStore.getState(); state.seek(Math.min(state.duration || Infinity, state.currentTime + 5)) }
      else if (event.key.toLowerCase() === 'm') { event.preventDefault(); usePlaybackStore.getState().toggleMute() }
      else if (event.key.toLowerCase() === 'n') { event.preventDefault(); usePlaybackStore.getState().next() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keyboardShortcuts])
  useEffect(() => {
    const validTabs: PlayerTab[] = ['search', 'songlist', 'leaderboard', 'favorites', 'localmusic', 'settings', 'about']
    const fromHash = window.location.hash.slice(1) as PlayerTab
    const initialTab = validTabs.includes(fromHash) ? fromHash : 'search'
    const historyController = createPlayerHistoryController()
    historyController.initialize({ page: 'tab', tabId: initialTab })
    usePlayerUiStore.getState().setTabFromHistory(initialTab)
    const disconnect = connectPlayerNavigation(navigation => {
      const detail = navigation.detail
      historyController.push(detail ? { page: detail.page, tabId: navigation.tab, kind: detail.kind, id: detail.id, source: detail.source } : { page: 'tab', tabId: navigation.tab })
    })
    const onPop = () => {
      const restored = historyController.handlePopState(window.history.state)
      const tabName = (restored?.state.tabId || window.location.hash.slice(1)) as PlayerTab
      if (validTabs.includes(tabName)) {
        const isDetail = restored?.state.page === 'search-detail' || restored?.state.page === 'songlist-detail'
        const restoredDetail = isDetail && restored?.state.kind && restored.state.id ? { page: restored.state.page, kind: restored.state.kind, id: restored.state.id, source: restored.state.source || 'wy' } as PlayerDetail : null
        usePlayerUiStore.getState().setTabFromHistory(tabName, restoredDetail)
      }
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('hashchange', onPop)
    return () => { disconnect(); window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop) }
  }, [])
  useEffect(() => { if (currentSong && 'mediaSession' in navigator && navigator.mediaSession.setPositionState && Number.isFinite(usePlaybackStore.getState().duration)) { try { navigator.mediaSession.setPositionState({ duration: Math.max(0.1, usePlaybackStore.getState().duration), playbackRate: 1, position: Math.min(usePlaybackStore.getState().currentTime, usePlaybackStore.getState().duration) }) } catch { /* browser may reject transient media metadata */ } } }, [currentSong])
  return <div className="react-player-shell"><AudioRuntime /><Sidebar /><div className="react-player-main"><TopBar /><main id="player-main-content" className="react-player-content" tabIndex={-1}><PlayerErrorBoundary><PlayerView tab={tab} detail={detail} /></PlayerErrorBoundary></main><PlayerFooter /></div><QueueDrawer open={drawer === 'queue'} onClose={() => setDrawer(null)} /><CacheDrawer open={drawer === 'cache' || drawer === 'download'} onClose={() => setDrawer(null)} /><LoginDialog open={dialog === 'login'} onClose={() => setDialog(null)} /><UserLoginDialog open={dialog === 'userLogin'} onClose={() => setDialog(null)} /><CreateListDialog open={dialog === 'createList'} onClose={() => setDialog(null)} /><SleepTimerDialog open={dialog === 'sleep'} onClose={() => setDialog(null)} /><ImmersiveLyricsView open={immersiveLyrics} onClose={() => setImmersiveLyrics(false)} /><CommentsDialog open={dialog === 'comments'} onClose={() => setDialog(null)} /><ToastRegion /></div>
}

export function PlayerAuthGate() {
  const auth = useAuthStore()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => { event.preventDefault(); try { await auth.login(password) } catch (e) { setError(e instanceof Error ? e.message : '登录失败') } }
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
