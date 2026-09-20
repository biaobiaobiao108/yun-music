import { playerApi } from './api'
import { Icon, SafeImage, SongMeta, Time } from './components'
import { useAuthStore, useLibraryStore, usePlaybackStore, usePlayerUiStore } from './store'
import { songImage, songKey, songTitle } from './types'
import { normalizeCachePlaybackUrl } from './media_url'

export function PlayerFooterBar({ embedded = false }: { embedded?: boolean }) {
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
    if (embedded) setImmersiveLyrics(false)
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

  return <footer id={embedded ? undefined : 'player-footer'} className={`react-player-footer ${embedded ? 'react-immersive-footer' : ''}`}>
    <button type="button" className="react-footer-song" onClick={() => { if (!embedded) setImmersiveLyrics(true) }} aria-label="打开沉浸式歌词"><SafeImage src={songImage(currentSong)} width="52" height="52" alt="" /><span><SongMeta song={currentSong} /></span></button>
    <div className="react-footer-center"><div className="react-footer-controls"><button type="button" className="player-secondary-action" aria-label="上一首" onClick={previous}><Icon name="backward-step" /></button><button type="button" id={embedded ? undefined : 'btn-play'} className="react-play-button" aria-label={isPlaying ? '暂停' : '播放'} onClick={toggle}><Icon name={isPlaying ? 'pause' : 'play'} /></button><button type="button" className="player-secondary-action" aria-label="下一首" onClick={next}><Icon name="forward-step" /></button><button type="button" className={`player-secondary-action ${mode !== 'list' ? 'is-active' : ''}`} aria-label={`播放模式：${mode === 'random' ? '随机' : mode === 'single' ? '单曲循环' : '列表循环'}`} onClick={() => setMode(mode === 'list' ? 'random' : mode === 'random' ? 'single' : 'list')}><Icon name={mode === 'random' ? 'shuffle' : mode === 'single' ? 'repeat-1' : 'repeat'} /></button></div><div className="react-progress-row"><Time value={safeCurrentTime} /><input type="range" min="0" max={safeDuration} step="0.1" value={safeCurrentTime} onChange={event => seek(Number(event.target.value))} aria-label="播放进度" /><Time value={safeDuration} /></div></div>
    <div className="react-footer-actions"><button type="button" id={embedded ? undefined : 'player-like-btn'} className={`player-secondary-action react-like-button ${isLiked ? 'is-active' : ''}`} aria-label={isLiked ? '取消喜欢' : '喜欢'} aria-pressed={isLiked} title={isLiked ? '取消喜欢' : '喜欢'} onClick={() => void toggleLike()}><Icon name="heart" /><span>喜欢</span></button><button type="button" className="player-secondary-action" aria-label={muted ? '取消静音' : '静音'} onClick={toggleMute}><Icon name={muted || volume === 0 ? 'volume-xmark' : volume < 0.5 ? 'volume-low' : 'volume-high'} /></button><input className="react-volume-range" type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={event => setVolume(Number(event.target.value))} aria-label="音量" /><button type="button" className="player-secondary-action" aria-label="打开评论" onClick={() => { if (embedded) setImmersiveLyrics(false); setDialog('comments') }}><Icon name="comments" /></button><button type="button" className="player-secondary-action" aria-label="下载歌曲" onClick={() => void download()}><Icon name="download" /></button><button type="button" className="player-secondary-action" aria-label="设置睡眠定时器" onClick={() => { if (embedded) setImmersiveLyrics(false); setDialog('sleep') }}><Icon name="moon" /></button><button type="button" className="player-secondary-action" aria-label="打开播放队列" onClick={() => { if (embedded) setImmersiveLyrics(false); setDrawer('queue') }}><Icon name="list" /></button></div>
  </footer>
}
