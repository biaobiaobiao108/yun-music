import { useCallback, useRef, useState, type MouseEvent } from 'react'
import { playerApi } from './api'
import { Icon, SafeImage, Time } from './components'
import { SongActionsPopover } from './song_actions'
import { useAuthStore, useLibraryStore, usePlaybackStore, usePlayerUiStore } from './store'
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

export function PlayerFooterBar({ embedded = false }: { embedded?: boolean }) {
  const currentSong = usePlaybackStore(state => state.currentSong)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const currentTime = usePlaybackStore(state => state.currentTime)
  const duration = usePlaybackStore(state => state.duration)
  const volume = usePlaybackStore(state => state.volume)
  const muted = usePlaybackStore(state => state.muted)
  const mode = usePlaybackStore(state => state.mode)
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
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const isLiked = useLibraryStore(state => Boolean(currentSong && (state.data.loveList ?? []).some(song => sameSong(song, currentSong))))
  const [songMenuOpen, setSongMenuOpen] = useState(false)
  const songMenuButtonRef = useRef<HTMLButtonElement>(null)
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const safeCurrentTime = Number.isFinite(currentTime) && currentTime > 0 ? Math.min(currentTime, safeDuration) : 0

  const closeSongMenu = useCallback(() => {
    setSongMenuOpen(false)
    window.requestAnimationFrame(() => songMenuButtonRef.current?.focus())
  }, [])

  const toggleSongMenu = () => {
    if (!currentSong) { notify('请选择歌曲后再查看歌曲操作'); return }
    setSongMenuOpen(value => !value)
  }

  const download = useCallback(async () => {
    if (!currentSong) return
    if (embedded) setImmersiveLyrics(false)
    try {
      const currentReference = parseCachePlaybackUrl(currentSong.url)
      let cachedItem = currentReference ? {
        filename: currentReference.filename,
        folder: currentReference.folder,
        username: currentReference.username,
      } : null

      // A normally-playing online song has no URL on its Song object. Look up
      // the cache index before asking the server to download anything so a
      // completed background cache can be moved to /music without resolving
      // the source again.
      if (!cachedItem) {
        try {
          const listed = await playerApi.cacheList(userName || undefined)
          const items = listed.data ?? []
          const match = items.find(item => {
            if (String(item.folder) !== 'cache') return false
            if (item.songInfo && sameSong(item.songInfo, currentSong)) return true
            return String(item.songmid ?? '') !== '' && String(item.songmid ?? '') === String(currentSong.songmid ?? currentSong.id ?? '') && String(item.source || '') === String(currentSong.source || '')
          })
          if (match) cachedItem = { filename: String(match.filename), folder: 'cache', username: String(match.rawUsername || match.username || userName || '').trim() || undefined }
        } catch {
          // A cache index read is an optimization. The already-resolved source
          // below is still safe to submit to the server download queue.
        }
      }

      if (cachedItem) {
        if (cachedItem.folder === 'music') {
          notify('歌曲已经在下载目录中')
          return
        }
        const result = await playerApi.cacheMove([{ filename: cachedItem.filename, folder: cachedItem.folder, user: cachedItem.username, rawUsername: cachedItem.username }], 'music')
        if (Number(result.successCount || 0) < 1) throw new Error('缓存文件尚未准备好，请稍后再试')
        const nextUrl = buildCachePlaybackUrl({ filename: cachedItem.filename, folder: 'music', username: cachedItem.username })
        setCurrentSongUrl(nextUrl)
        notify('已移入下载目录，后续播放不会重复消耗音源次数')
        setDrawer('download')
        return
      }

      const remoteUrl = extractRemotePlaybackUrl(resolvedUrl) ?? extractRemotePlaybackUrl(currentSong.url)
      const result = remoteUrl ? { url: remoteUrl } : await playerApi.songUrl(currentSong, 'flac', undefined, true)
      await playerApi.download(currentSong, result.url, 'flac')
      notify('已加入下载队列，继续复用当前播放链接')
      setDrawer('download')
    } catch (error) { notify(error instanceof Error ? error.message : '下载失败') }
  }, [currentSong, embedded, notify, resolvedUrl, setCurrentSongUrl, setDrawer, setImmersiveLyrics, userName])

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
    if (embedded) setImmersiveLyrics(false)
    setDialog('comments')
  }, [embedded, setDialog, setImmersiveLyrics])

  const openSleepTimer = useCallback(() => {
    if (embedded) setImmersiveLyrics(false)
    setDialog('sleep')
  }, [embedded, setDialog, setImmersiveLyrics])

  const openQueue = () => {
    if (embedded) setImmersiveLyrics(false)
    setDrawer('queue')
  }

  const openLyrics = (event: MouseEvent<HTMLButtonElement>) => {
    if (currentSong && !embedded) {
      rememberImmersiveLyricsTrigger(event.currentTarget)
      setImmersiveLyrics(true)
    }
  }

  return <>
    <footer id={embedded ? undefined : 'player-footer'} className={`react-player-footer ${embedded ? 'react-immersive-footer' : ''}`}>
      <div className="react-footer-controls">
        <button type="button" className="player-secondary-action" aria-label="上一首" onClick={previous}><Icon name="backward-step" /></button>
        <button type="button" id={embedded ? undefined : 'btn-play'} className="react-play-button" aria-label={isPlaying ? '暂停' : '播放'} onClick={toggle}><Icon name={isPlaying ? 'pause' : 'play'} /></button>
        <button type="button" className="player-secondary-action" aria-label="下一首" onClick={next}><Icon name="forward-step" /></button>
      </div>
      <div className="react-footer-song-section">
        <div className="react-footer-song">
          <button type="button" className="react-footer-cover-button" onClick={openLyrics} aria-label="打开沉浸式歌词" disabled={!currentSong || embedded}><SafeImage src={songImage(currentSong)} width="48" height="48" alt="" /></button>
          <div className="react-footer-song-meta">
            <div className="react-footer-title-row"><strong title={currentSong ? songTitle(currentSong) : undefined}>{currentSong ? songTitle(currentSong) : '云音'}</strong>{!embedded && <button ref={songMenuButtonRef} type="button" className="react-footer-song-menu-trigger" aria-label="打开歌曲更多操作" aria-expanded={songMenuOpen} aria-controls="song-actions-popover" onClick={toggleSongMenu} disabled={!currentSong}><Icon name="ellipsis" /></button>}</div>
            <small title={currentSong ? songArtist(currentSong) : undefined}>{currentSong ? songArtist(currentSong) : '选择一首歌曲开始播放'}</small>
          </div>
        </div>
        <div className="react-progress-row"><Time value={safeCurrentTime} /><input type="range" min="0" max={safeDuration} step="0.1" value={safeCurrentTime} onChange={event => seek(Number(event.target.value))} aria-label="播放进度" /><Time value={safeDuration} /></div>
      </div>
      <div className="react-footer-actions">
        <button type="button" className={`player-secondary-action ${mode !== 'list' ? 'is-active' : ''}`} aria-label={`播放模式：${mode === 'random' ? '随机' : mode === 'single' ? '单曲循环' : '列表循环'}`} onClick={() => setMode(mode === 'list' ? 'random' : mode === 'random' ? 'single' : 'list')}><Icon name={mode === 'random' ? 'shuffle' : mode === 'single' ? 'repeat-1' : 'repeat'} /></button>
        <button type="button" id={embedded ? undefined : 'player-like-btn'} className={`player-secondary-action react-like-button ${isLiked ? 'is-active' : ''}`} aria-label={isLiked ? '取消喜欢' : '喜欢'} aria-pressed={isLiked} title={isLiked ? '取消喜欢' : '喜欢'} onClick={() => void toggleLike()}><Icon name="heart" /><span>喜欢</span></button>
        {embedded && <>
          <button type="button" className="player-secondary-action" aria-label="打开评论" onClick={openComments}><Icon name="comments" /></button>
          <button type="button" className="player-secondary-action" aria-label="下载歌曲" onClick={() => void download()}><Icon name="download" /></button>
          <button type="button" className="player-secondary-action" aria-label="设置睡眠定时器" onClick={openSleepTimer}><Icon name="moon" /></button>
        </>}
        <button type="button" className="player-secondary-action" aria-label="打开播放队列" onClick={openQueue}><Icon name="list" /></button>
        <button type="button" className="player-secondary-action" aria-label={muted ? '取消静音' : '静音'} onClick={toggleMute}><Icon name={muted || volume === 0 ? 'volume-xmark' : volume < 0.5 ? 'volume-low' : 'volume-high'} /></button>
        <input className="react-volume-range" type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" />
      </div>
    </footer>
    {!embedded && <SongActionsPopover song={currentSong} open={songMenuOpen} anchorRef={songMenuButtonRef} onClose={closeSongMenu} onAddToList={openAddToListAction} onComment={openComments} onDownload={() => void download()} onSleep={openSleepTimer} />}
  </>
}
