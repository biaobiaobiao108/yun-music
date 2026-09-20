import { useEffect, useId, useRef, type ReactNode } from 'react'
import { safeImageUrl, formatDuration } from '../../../shared/src/runtime'
import type { Song } from './types'
import { songArtist, songImage, songKey, songTitle } from './types'
import { useLibraryStore, usePlaybackStore, usePlayerUiStore } from './store'

export function Icon({ name }: { name: string }) { return <i className={`fas fa-${name}`} aria-hidden="true" /> }

export function Button({ children, variant = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button className={`react-player-button react-player-button-${variant} ${className}`} {...props}>{children}</button>
}

type SafeImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src?: unknown; fallback?: string }

export function SafeImage({ src, fallback = '/music/assets/yun-yin.png', onError, ...props }: SafeImageProps) {
  const fallbackUrl = safeImageUrl(fallback)
  return <img {...props} src={safeImageUrl(src, fallback)} onError={event => {
    onError?.(event)
    const target = event.currentTarget
    if (target.dataset.fallbackApplied === 'true') return
    target.dataset.fallbackApplied = 'true'
    target.src = fallbackUrl
  }} />
}

export function SongRow({ song, index, list, listId = 'love', compact = false, selected = false, onSelect }: { song: Song; index: number; list: Song[]; listId?: string; compact?: boolean; selected?: boolean; onSelect?: (song: Song) => void }) {
  const playSong = usePlaybackStore(state => state.playSong)
  const enqueue = usePlaybackStore(state => state.enqueue)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const inList = useLibraryStore(state => listId === 'love' ? (state.data.loveList ?? []).some(item => songKey(item) === songKey(song)) : (state.data.userList ?? []).find(listItem => String(listItem.id) === String(listId))?.list?.some(item => songKey(item) === songKey(song)) ?? false)
  const notify = usePlayerUiStore(state => state.notify)
  const actionLabel = listId === 'love' ? (inList ? '取消收藏' : '收藏') : '从歌单移除'
  return <li className={`react-song-row ${onSelect ? 'is-selectable' : ''} ${selected ? 'is-selected' : ''} ${compact ? 'is-compact' : ''}`}>{onSelect && <input type="checkbox" checked={selected} onChange={() => onSelect(song)} aria-label={`选择 ${songTitle(song)}`} />}<button type="button" className="react-song-main" onClick={() => playSong(song, list, index)}><SafeImage src={songImage(song)} width="48" height="48" loading="lazy" alt="" /><span className="react-song-text"><strong>{songTitle(song)}</strong><small>{songArtist(song)}{song.album ? ` · ${String(song.album)}` : ''}</small></span></button><span className="react-song-quality">{String(song.quality || song.type || 'FLAC')}</span><span className="react-song-actions"><button type="button" title="加入队列" aria-label={`将 ${songTitle(song)} 加入队列`} onClick={() => { enqueue([song]); notify('已加入播放队列') }}><Icon name="plus" /></button><button type="button" title={actionLabel} aria-label={`${actionLabel} ${songTitle(song)}`} onClick={() => { const operation = listId === 'love' && !inList ? addSong('love', song) : removeSong(listId, song); void operation.then(() => notify(listId === 'love' && !inList ? '已收藏' : listId === 'love' ? '已取消收藏' : '已从歌单移除')).catch(error => notify(error instanceof Error ? error.message : '操作失败')) }}><Icon name={listId === 'love' ? 'heart' : 'trash'} /></button></span></li>
}

export function SongList({ songs, empty = '暂无歌曲', compact = false, listId = 'love', selected, onSelect }: { songs: Song[]; empty?: string; compact?: boolean; listId?: string; selected?: Set<string>; onSelect?: (song: Song) => void }) {
  if (!songs.length) return <div className="react-empty"><Icon name="music" /><p>{empty}</p></div>
  return <ul className="react-song-list" aria-label="歌曲列表">{songs.map((song, index) => <SongRow key={`${songKey(song)}-${index}`} song={song} index={index} list={songs} listId={listId} compact={compact} selected={selected?.has(songKey(song))} onSelect={onSelect} />)}</ul>
}

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  const titleId = useId()
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (open && !dialog.open) { lastFocus.current = document.activeElement as HTMLElement | null; dialog.showModal() } else if (!open && dialog.open) dialog.close() }, [open])
  useEffect(() => { const dialog = ref.current; if (!dialog) return; const close = () => { lastFocus.current?.focus?.(); if (open) onClose() }; dialog.addEventListener('close', close); return () => dialog.removeEventListener('close', close) }, [onClose, open])
  return <dialog ref={ref} className="react-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}><div className="react-dialog-content"><header><h2 id={titleId}>{title}</h2><button type="button" className="react-icon-button" aria-label="关闭" onClick={onClose}><Icon name="xmark" /></button></header><div className="react-dialog-body">{children}</div></div></dialog>
}

export function Drawer({ open, title, onClose, children, labelledBy }: { open: boolean; title: string; onClose: () => void; children: ReactNode; labelledBy?: string }) {
  return <aside className={`react-player-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open} aria-labelledby={labelledBy} inert={!open ? true : undefined}><div className="react-drawer-header"><h2 id={labelledBy}>{title}</h2><button type="button" className="react-icon-button" onClick={onClose} aria-label={`关闭${title}`}><Icon name="xmark" /></button></div><div className="react-drawer-body">{children}</div></aside>
}

export function ToastRegion() {
  const notice = usePlayerUiStore(state => state.notice)
  const clear = usePlayerUiStore(state => state.clearNotice)
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(clear, 3600); return () => window.clearTimeout(timer) }, [clear, notice])
  return notice ? <div className="react-player-toast" role="status">{notice}</div> : null
}

export function Loading({ label = '加载中…' }: { label?: string }) { return <div className="react-loading" role="status"><Icon name="spinner" /><span>{label}</span></div> }

export function SongMeta({ song }: { song: Song | null }) { return <>{song ? <><strong>{songTitle(song)}</strong><small>{songArtist(song)}</small></> : <><strong>云音</strong><small>选择一首歌曲开始播放</small></>}</> }

export function Time({ value }: { value: number }) { return <span>{formatDuration(value)}</span> }
