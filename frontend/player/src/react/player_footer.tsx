import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { playerApi } from './api'
import { Icon, SafeImage, Time } from './components'
import { SongActionsPopover } from './song_actions'
import { useAuthStore, useLibraryStore, usePlaybackStore, usePlayerUiStore, useSettingsStore } from './store'
import { sameSong, songArtist, songImage, songTitle } from './types'
import { buildCachePlaybackUrl, extractRemotePlaybackUrl, parseCachePlaybackUrl } from './media_url'

let immersiveLyricsTrigger: HTMLButtonElement | null = null

export function rememberImmersiveLyricsTrigger(trigger: HTMLButtonElement | null): void {
  immersiveLyricsTrigger = trigger
}

export function consumeImmersiveLyricsTrigger(): HTMLButtonElement | null {
  const trigger = immersiveLyricsTrigger
  immersiveLyricsTrigger = null
  return trigger
}

function VolumeControl({ volume, muted, onVolumeChange, onToggleMute, active = true, popoverId = 'player-volume-popover' }: {
  volume: number
  muted: boolean
  onVolumeChange: (value: number) => void
  onToggleMute: () => void
  active?: boolean
  popoverId?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!active) setOpen(false)
  }, [active])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const displayedVolume = muted ? 0 : volume
  const icon = muted || displayedVolume === 0 ? 'volume-xmark' : displayedVolume < .5 ? 'volume-low' : 'volume-high'
  const volumeStyle = { '--volume': `${Math.round(displayedVolume * 100)}%` } as CSSProperties
  return <div ref={rootRef} className={`react-volume-control ${open ? 'is-open' : ''}`}>
    <button ref={triggerRef} type="button" className="player-secondary-action react-volume-trigger" aria-label={open ? '收起音量控制' : '展开音量控制'} aria-expanded={open} aria-controls={popoverId} onClick={() => setOpen(value => !value)}><Icon name={icon} /></button>
    {open && <div id={popoverId} className="react-volume-popover" role="dialog" aria-label="音量控制">
      <button type="button" className="react-volume-mute" aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted} onClick={onToggleMute}><Icon name={muted ? 'volume-xmark' : 'volume-high'} /><span>{muted ? '已静音' : '音量'}</span></button>
      <input className="react-volume-range" style={volumeStyle} type="range" min="0" max="1" step="0.01" value={displayedVolume} onChange={event => onVolumeChange(Number(event.target.value))} aria-label="音量大小" />
    </div>}
  </div>
}

export type PlayerFooterVariant = 'normal' | 'immersive'

export function PlayerFooterBar({ variant = 'normal', isActive = true }: { variant?: PlayerFooterVariant; isActive?: boolean }) {
  const immersive = variant === 'immersive'
  const currentSong = usePlaybackStore(state => state.currentSong)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const currentTime = usePlaybackStore(state => state.currentTime)
  const duration = usePlaybackStore(state => state.duration)
  const volume = usePlaybackStore(state => state.volume)
  const muted = usePlaybackStore(state => state.muted)
  const mode = usePlaybackStore(state => state.mode)
  const quality = usePlaybackStore(state => state.quality)
  const resolvedUrl = usePlaybackStore(state => state.resolvedUrl)
  const toggle = usePlaybackStore(state => state.toggle)
  const next = usePlaybackStore(state => state.next)
  const previous = usePlaybackStore(state => state.previous)
  const seek = usePlaybackStore(state => state.seek)
  const setVolume = usePlaybackStore(state => state.setVolume)
  const toggleMute = usePlaybackStore(state => state.toggleMute)
  const setMode = usePlaybackStore(state => state.setMode)
  const setCurrentSongUrl = usePlaybackStore(state => state.setCurrentSongUrl)
  const setDialog = usePlayerUiStore(state => state.setDialog)
  const setImmersiveLyrics = usePlayerUiStore(state => state.setImmersiveLyrics)
  const setDrawer = usePlayerUiStore(state => state.setDrawer)
  const notify = usePlayerUiStore(state => state.notify)
  const openAddToList = usePlayerUiStore(state => state.openAddToList)
  const userName = useAuthStore(state => state.userName)
  const userAuthenticated = useAuthStore(state => state.userAuthenticated)
  const preferredQuality = useSettingsStore(state => String(state.settings.preferredQuality || 'flac'))
  const enableAutoSwitchSource = useSettingsStore(state => state.settings.enableAutoSwitchSource !== false)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const isLiked = useLibraryStore(state => Boolean(currentSong && (state.data.loveList ?? []).some(song => sameSong(song, currentSong))))
  const [songMenuOpen, setSongMenuOpen] = useState(false)
  const songMenuButtonRef = useRef<HTMLButtonElement>(null)
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const safeCurrentTime = Number.isFinite(currentTime) && currentTime > 0 ? Math.min(currentTime, safeDuration) : 0
  const progressPercent = safeDuration > 0 ? Math.min(100, Math.max(0, safeCurrentTime / safeDuration * 100)) : 0
  const progressStyle = { '--progress': `${progressPercent}%` } as CSSProperties
  const modeLabel = mode === 'random' ? '随机' : mode === 'single' ? '单曲循环' : '列表循环'
  const footerId = isActive ? 'player-footer' : immersive ? 'player-footer-immersive-hidden' : 'player-footer-normal-hidden'
  const volumePopoverId = isActive ? 'player-volume-popover' : `${footerId}-volume-popover`

  const closeSongMenu = useCallback(() => {
    setSongMenuOpen(false)
    window.requestAnimationFrame(() => songMenuButtonRef.current?.focus())
  }, [])

  const toggleSongMenu = () => {
    if (!currentSong) { notify('请选择歌曲后再查看歌曲操作'); return }
    setSongMenuOpen(value => !value)
  }

  useEffect(() => {
    if (!isActive) setSongMenuOpen(false)
  }, [isActive])

  const download = useCallback(async () => {
    if (!currentSong) return
    try {
      const currentReference = parseCachePlaybackUrl(currentSong.url) ?? parseCachePlaybackUrl(resolvedUrl)
      let cachedItem = currentReference ? {
        filename: currentReference.filename,
        folder: currentReference.folder,
        username: currentReference.username || '_open',
      } : null

      // A normally-playing online song has no URL on its Song object. Look up
      // the cache index before asking the server to download anything so a
      // completed background cache can be moved to /music without resolving
      // the source again.
      if (!cachedItem) {
        try {
          const listed = await playerApi.cacheList(userName || undefined)
          const items = listed.data ?? []
          const matches = items.filter(item => {
            if (item.songInfo && sameSong(item.songInfo, currentSong)) return true
            return String(item.songmid ?? '') !== '' && String(item.songmid ?? '') === String(currentSong.songmid ?? currentSong.id ?? '') && String(item.source || '') === String(currentSong.source || '')
          })
          const match = matches.find(item => String(item.folder) === 'music') ?? matches.find(item => String(item.folder) === 'cache')
          if (match) cachedItem = { filename: String(match.filename), folder: String(match.folder || 'cache') as 'cache' | 'music', username: String(match.rawUsername || match.username || userName || '_open').trim() || '_open' }
        } catch {
          // A cache index read is an optimization. The already-resolved source
          // below is still safe to submit to the server download queue.
        }
      }

      if (cachedItem) {
        if (cachedItem.folder === 'music') {
          const nextUrl = buildCachePlaybackUrl({ filename: cachedItem.filename, folder: 'music', username: cachedItem.username === '_open' ? (userName ?? undefined) : cachedItem.username })
          setCurrentSongUrl(nextUrl)
          notify('歌曲已经在下载目录中，已切换到下载路径')
          setDrawer('download')
          return
        }
        const result = await playerApi.cacheMove([{ filename: cachedItem.filename, folder: cachedItem.folder, user: cachedItem.username, rawUsername: cachedItem.username, sourceUser: cachedItem.username }], 'music')
        if (Number(result.successCount || 0) < 1) throw new Error('缓存文件尚未准备好，请稍后再试')
        const nextUrl = buildCachePlaybackUrl({ filename: cachedItem.filename, folder: 'music', username: cachedItem.username === '_open' ? (userName ?? undefined) : cachedItem.username })
        setCurrentSongUrl(nextUrl)
        notify('已移入下载目录，后续播放不会重复消耗音源次数')
        setDrawer('download')
        return
      }

      const remoteUrl = extractRemotePlaybackUrl(resolvedUrl) ?? extractRemotePlaybackUrl(currentSong.url)
      const result = remoteUrl && quality === preferredQuality
        ? { url: remoteUrl }
        : await playerApi.songUrl(currentSong, preferredQuality, undefined, enableAutoSwitchSource)
      await playerApi.download(currentSong, result.url, preferredQuality)
      notify(remoteUrl && quality === preferredQuality ? '已加入下载队列，继续复用当前播放链接' : `已加入下载队列，音质：${preferredQuality}`)
      setDrawer('download')
    } catch (error) { notify(error instanceof Error ? error.message : '下载失败') }
  }, [currentSong, enableAutoSwitchSource, notify, preferredQuality, quality, resolvedUrl, setCurrentSongUrl, setDrawer, userName])

  const toggleLike = useCallback(async () => {
    if (!currentSong) { notify('请选择歌曲后再收藏'); return }
    try {
      if (isLiked) { await removeSong('love', currentSong); notify('已取消喜欢') }
      else { await addSong('love', currentSong); notify('已添加到喜欢') }
    } catch (error) { notify(error instanceof Error ? error.message : '喜欢操作失败') }
  }, [addSong, currentSong, isLiked, notify, removeSong])

  const openAddToListAction = useCallback(() => {
    if (!currentSong) return
    if (!userAuthenticated) {
      usePlayerUiStore.setState({ playlistSong: currentSong, dialog: 'userLogin' })
      notify('请先登录用户账户')
      return
    }
    openAddToList(currentSong)
  }, [currentSong, notify, openAddToList, userAuthenticated])

  const openComments = useCallback(() => {
    setDialog('comments')
  }, [setDialog])

  const openSleepTimer = useCallback(() => {
    setDialog('sleep')
  }, [setDialog])

  const openQueue = () => {
    setDrawer('queue')
  }

  const openLyrics = (event: MouseEvent<HTMLButtonElement>) => {
    if (currentSong && !immersive && isActive) {
      rememberImmersiveLyricsTrigger(event.currentTarget)
      setImmersiveLyrics(true)
    }
  }

  return <>
    <footer id={footerId} aria-hidden={isActive ? undefined : true} inert={isActive ? undefined : true} className={`react-player-footer${immersive ? ' react-immersive-shared-footer' : ''}${isActive ? '' : ' is-inactive'}`}>
      <div className="react-footer-controls">
        <button type="button" className="player-secondary-action" aria-label="上一首" onClick={previous}><Icon name="backward-step" /></button>
        <button type="button" id={isActive ? 'btn-play' : undefined} className="react-play-button" aria-label={isPlaying ? '暂停' : '播放'} onClick={toggle}><Icon name={isPlaying ? 'pause' : 'play'} /></button>
        <button type="button" className="player-secondary-action" aria-label="下一首" onClick={next}><Icon name="forward-step" /></button>
      </div>
      <div className="react-footer-song-section">
        <div className="react-footer-song">
          <button type="button" className="react-footer-cover-button" onClick={openLyrics} aria-label={immersive ? '当前歌曲封面' : '打开沉浸式歌词'} disabled={!currentSong || immersive}><SafeImage src={songImage(currentSong)} width="48" height="48" alt="" /></button>
          <div className="react-footer-song-meta">
            <div className="react-footer-title-row"><strong title={currentSong ? songTitle(currentSong) : undefined}>{currentSong ? songTitle(currentSong) : '云音'}</strong></div>
            <small title={currentSong ? songArtist(currentSong) : undefined}>{currentSong ? songArtist(currentSong) : '选择一首歌曲开始播放'}</small>
          </div>
        </div>
        <div className="react-progress-row"><span className="react-progress-time"><Time value={safeCurrentTime} /></span><input style={progressStyle} type="range" min="0" max={safeDuration} step="0.1" value={safeCurrentTime} onChange={event => seek(Number(event.target.value))} aria-label="播放进度" /><span className="react-progress-time"><Time value={safeDuration} /></span></div>
      </div>
      <div className="react-footer-actions">
        <button ref={immersive ? undefined : songMenuButtonRef} type="button" className={`player-secondary-action react-song-menu-button${immersive ? ' is-immersive-placeholder' : ''}`} aria-label="打开歌曲更多操作" aria-expanded={immersive ? false : songMenuOpen} aria-controls="song-actions-popover" onClick={toggleSongMenu} disabled={immersive || !isActive || !currentSong} tabIndex={immersive || !isActive ? -1 : undefined}><Icon name="ellipsis" /></button>
        <button type="button" className={`player-secondary-action react-mode-button ${mode === 'single' ? 'is-single' : ''}`} aria-label={`播放模式：${modeLabel}`} aria-pressed={mode !== 'list'} onClick={() => setMode(mode === 'list' ? 'random' : mode === 'random' ? 'single' : 'list')}><Icon name={mode === 'random' ? 'shuffle' : 'repeat'} />{mode === 'single' && <span className="react-mode-one" aria-hidden="true">1</span>}</button>
        <button type="button" id={!immersive && isActive ? 'player-like-btn' : undefined} className={`player-secondary-action react-like-button ${isLiked ? 'is-active' : ''}`} aria-label={isLiked ? '取消喜欢' : '喜欢'} aria-pressed={isLiked} title={isLiked ? '取消喜欢' : '喜欢'} onClick={() => void toggleLike()}><Icon name="heart" /><span>喜欢</span></button>
        {immersive && <div className="react-immersive-utility-actions">
          <button type="button" className="player-secondary-action" aria-label="打开评论" onClick={openComments}><Icon name="comments" /></button>
          <button type="button" className="player-secondary-action" aria-label="下载歌曲" onClick={() => void download()}><Icon name="download" /></button>
          <button type="button" className="player-secondary-action" aria-label="设置睡眠定时器" onClick={openSleepTimer}><Icon name="moon" /></button>
        </div>}
        <button type="button" className="player-secondary-action" aria-label="打开播放队列" onClick={openQueue}><Icon name="list" /></button>
        <VolumeControl volume={volume} muted={muted} active={isActive} popoverId={volumePopoverId} onVolumeChange={setVolume} onToggleMute={toggleMute} />
      </div>
    </footer>
    {!immersive && <SongActionsPopover song={currentSong} open={isActive && songMenuOpen} anchorRef={songMenuButtonRef} onClose={closeSongMenu} onAddToList={openAddToListAction} onComment={openComments} onDownload={() => void download()} onSleep={openSleepTimer} />}
  </>
}
