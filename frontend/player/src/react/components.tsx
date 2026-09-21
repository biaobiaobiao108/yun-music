import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { safeImageUrl, formatBytes, formatDuration } from '../../../shared/src/runtime'
import type { Song } from './types'
import { songAlbum, songArtist, songDurationValue, songFormatValue, songImage, songKey, songSizeBytes, songTitle } from './types'
import { isSongInLoveList, useLibraryStore, usePlaybackStore, usePlayerUiStore } from './store'

export function Icon({ name }: { name: string }) { return <i className={`fas fa-${name}`} aria-hidden="true" /> }

export function Button({ children, variant = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button type="button" className={`react-player-button react-player-button-${variant} ${className}`} {...props}>{children}</button>
}

export type SelectOption = { value: string; label: string; disabled?: boolean }

/** A small semantic listbox used instead of browser-dependent native selects. */
export function SelectMenu({ value, options, onChange, label, disabled = false, className = '', placeholder = '请选择' }: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  label?: string
  disabled?: boolean
  className?: string
  placeholder?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))
  const [highlighted, setHighlighted] = useState(selectedIndex)
  const selected = options[selectedIndex]

  useEffect(() => {
    if (!open) return
    setHighlighted(selectedIndex)
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      window.requestAnimationFrame(() => triggerRef.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open, selectedIndex])

  useEffect(() => {
    if (!open) return
    document.getElementById(`${listboxId}-${highlighted}`)?.scrollIntoView({ block: 'nearest' })
  }, [highlighted, listboxId, open])

  const move = (direction: 1 | -1) => {
    if (!options.length) return
    let next = highlighted
    for (let count = 0; count < options.length; count += 1) {
      next = (next + direction + options.length) % options.length
      if (!options[next]?.disabled) break
    }
    setHighlighted(next)
  }

  const choose = (option: SelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); setOpen(true); move(1); return }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); setOpen(true); move(-1); return }
    if (event.key === 'Home') { event.preventDefault(); setOpen(true); setHighlighted(options.findIndex(option => !option.disabled)); return }
    if (event.key === 'End') { event.preventDefault(); setOpen(true); setHighlighted([...options].reverse().findIndex(option => !option.disabled) < 0 ? 0 : options.length - 1); return }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(current => !current); return }
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); return }
  }

  return <div ref={rootRef} className={`react-select-menu ${open ? 'is-open' : ''} ${className}`}>
    <button ref={triggerRef} type="button" className="react-select-menu-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} disabled={disabled} onClick={() => setOpen(current => !current)} onKeyDown={onTriggerKeyDown}>
      <span>{selected?.label ?? placeholder}</span><Icon name="chevron-down" />
    </button>
    {open && <div id={listboxId} className="react-select-menu-list" role="listbox" aria-label={label}>
      {options.map((option, index) => <button id={`${listboxId}-${index}`} key={`${option.value}-${index}`} type="button" role="option" aria-selected={option.value === value} className={`react-select-menu-option ${option.value === value ? 'is-selected' : ''} ${index === highlighted ? 'is-highlighted' : ''}`} disabled={option.disabled} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(option)}><span>{option.label}</span>{option.value === value && <Icon name="check" />}</button>)}
    </div>}
  </div>
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

function songDuration(song: Song): string {
  const value = songDurationValue(song)
  if (typeof value === 'string' && value.includes(':')) return value
  return formatDuration(value)
}

function songSize(song: Song): string {
  const bytes = songSizeBytes(song)
  return bytes === undefined ? '—' : formatBytes(bytes)
}

function songFormat(song: Song): string {
  return String(songFormatValue(song) || 'FLAC').toUpperCase()
}

export function SongRow({ song, index, list, listId = 'love', compact = false, selected = false, onSelect, showFileMetadata = true }: { song: Song; index: number; list: Song[]; listId?: string; compact?: boolean; selected?: boolean; onSelect?: (song: Song) => void; showFileMetadata?: boolean }) {
  const playSong = usePlaybackStore(state => state.playSong)
  const enqueue = usePlaybackStore(state => state.enqueue)
  const addSong = useLibraryStore(state => state.addSong)
  const removeSong = useLibraryStore(state => state.removeSong)
  const isLoved = useLibraryStore(state => isSongInLoveList(state, song))
  const notify = usePlayerUiStore(state => state.notify)
  const toggleFavorite = () => {
    const operation = isLoved ? removeSong('love', song) : addSong('love', song)
    void operation.then(() => notify(isLoved ? '已取消收藏' : '已收藏')).catch(error => notify(error instanceof Error ? error.message : '操作失败'))
  }
  const removeFromPlaylist = () => {
    void removeSong(listId, song).then(() => notify('已从歌单移除')).catch(error => notify(error instanceof Error ? error.message : '操作失败'))
  }
  const handleMainClick = () => {
    if (onSelect) {
      onSelect(song)
      return
    }
    playSong(song, list, index)
  }
  return <li className={`react-song-row ${onSelect ? 'is-selectable' : ''} ${selected ? 'is-selected' : ''} ${compact ? 'is-compact' : ''}`}>
    {onSelect && <span className="react-song-select"><input type="checkbox" checked={selected} onChange={() => onSelect(song)} aria-label={`选择 ${songTitle(song)}`} /></span>}
    <span className="react-song-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
    <button type="button" className="react-song-main" aria-pressed={onSelect ? selected : undefined} onClick={handleMainClick}><SafeImage src={songImage(song)} width="48" height="48" loading="lazy" alt="" /><span className="react-song-text"><strong>{songTitle(song)}</strong><small>{songArtist(song)}</small></span></button>
    <span className="react-song-album" title={songAlbum(song)}>{songAlbum(song)}</span>
    <button type="button" className={`react-song-favorite ${isLoved ? 'is-loved' : ''}`} title={isLoved ? '取消收藏' : '收藏'} aria-label={`${isLoved ? '取消收藏' : '收藏'} ${songTitle(song)}`} aria-pressed={isLoved} onClick={toggleFavorite}><Icon name="heart" /></button>
    <span className="react-song-duration">{songDuration(song)}</span>
    {showFileMetadata && <><span className="react-song-size">{songSize(song)}</span><span className="react-song-quality">{songFormat(song)}</span></>}
    <span className="react-song-actions">{listId !== 'love' && <button type="button" title="从当前歌单移除" aria-label={`从当前歌单移除 ${songTitle(song)}`} onClick={removeFromPlaylist}><Icon name="trash" /></button>}<button type="button" title="加入队列" aria-label={`将 ${songTitle(song)} 加入队列`} onClick={() => { enqueue([song]); notify('已加入播放队列') }}><Icon name="plus" /></button></span>
  </li>
}

export function SongList({ songs, empty = '暂无歌曲', compact = false, listId = 'love', selected, onSelect, showFileMetadata = true }: { songs: Song[]; empty?: string; compact?: boolean; listId?: string; selected?: Set<string>; onSelect?: (song: Song) => void; showFileMetadata?: boolean }) {
  if (!songs.length) return <div className="react-empty"><Icon name="music" /><p>{empty}</p></div>
  return <div className={`react-song-table ${showFileMetadata ? '' : 'react-song-table--without-file-metadata'}`}>
    <div className={`react-song-head ${onSelect ? 'is-selectable' : ''}`} aria-hidden="true">
      {onSelect && <span />}
      <span>#</span><span>歌曲 / 歌手</span><span>专辑</span><span>收藏</span><span>时长</span>{showFileMetadata && <><span>大小</span><span>格式</span></>}<span />
    </div>
    <ul className="react-song-list" aria-label="歌曲列表">{songs.map((song, index) => <SongRow key={`${songKey(song)}-${index}`} song={song} index={index} list={songs} listId={listId} compact={compact} selected={selected?.has(songKey(song))} onSelect={onSelect} showFileMetadata={showFileMetadata} />)}</ul>
  </div>
}

export function Modal({ open, title, onClose, children, className }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      lastFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      dialog.querySelector<HTMLElement>('[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
      const focusTarget = lastFocus.current
      const restoreFallback = () => document.getElementById('admin-main')?.focus() ?? document.getElementById('player-main-content')?.focus()
      if (focusTarget?.isConnected && focusTarget !== document.body && !dialog.contains(focusTarget) && !focusTarget.matches(':disabled')) focusTarget.focus()
      else window.requestAnimationFrame(restoreFallback)
      lastFocus.current = null
    }
  }, [open])
  return <dialog ref={ref} className={`react-dialog${className ? ` ${className}` : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}><div className="react-dialog-content"><header><h2 id={titleId}>{title}</h2><button type="button" className="react-icon-button" aria-label="关闭" onClick={onClose}><Icon name="xmark" /></button></header><div className="react-dialog-body">{children}</div></div></dialog>
}

export function Drawer({ open, title, onClose, children, labelledBy }: { open: boolean; title: string; onClose: () => void; children: ReactNode; labelledBy?: string }) {
  return <aside className={`react-player-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open} aria-labelledby={labelledBy} inert={!open ? true : undefined}><div className="react-drawer-header"><h2 id={labelledBy}>{title}</h2><button type="button" className="react-icon-button" onClick={onClose} aria-label={`关闭${title}`}><Icon name="xmark" /></button></div><div className="react-drawer-body">{children}</div></aside>
}

export function ToastRegion() {
  const notice = usePlayerUiStore(state => state.notice)
  const clear = usePlayerUiStore(state => state.clearNotice)
  const [phase, setPhase] = useState<'entering' | 'visible' | 'leaving'>('entering')
  useEffect(() => {
    if (!notice) return undefined
    setPhase('entering')
    const frame = window.requestAnimationFrame(() => setPhase('visible'))
    const leaveTimer = window.setTimeout(() => setPhase('leaving'), Math.max(0, notice.durationMs - 120))
    const clearTimer = window.setTimeout(clear, notice.durationMs)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(leaveTimer)
      window.clearTimeout(clearTimer)
    }
  }, [clear, notice?.id])
  if (!notice) return null
  const icon = notice.kind === 'success'
    ? 'circle-check'
    : notice.kind === 'warning'
      ? 'triangle-exclamation'
      : notice.kind === 'error'
        ? 'circle-xmark'
        : 'circle-info'
  return <div className={`react-player-toast is-${phase}`} role="status" aria-live="polite"><Icon name={icon} /><span>{notice.message}</span></div>
}

/** Keep long entity introductions compact while leaving the complete text one click away. */
export function DescriptionDisclosure({ text }: { text: string }) {
  const value = text.trim()
  const paragraphRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const likelyLong = value.length > 96 || value.split(/\r?\n/).length > 3

  useLayoutEffect(() => {
    const paragraph = paragraphRef.current
    if (!paragraph) return undefined
    const measure = () => setCanExpand(likelyLong || paragraph.scrollHeight > paragraph.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => observer.disconnect()
  }, [likelyLong, value])

  if (!value) return null
  return <div className={`react-description-disclosure${expanded ? ' is-expanded' : ''}`}>
    <p ref={paragraphRef} className={expanded ? undefined : 'is-collapsed'}>{value}</p>
    {canExpand && <button type="button" className="react-description-toggle" aria-expanded={expanded} onClick={() => setExpanded(current => !current)}>{expanded ? '收起简介' : '展开简介'}<Icon name={expanded ? 'chevron-up' : 'chevron-down'} /></button>}
  </div>
}

export function Loading({ label = '加载中…' }: { label?: string }) { return <div className="react-loading" role="status"><Icon name="spinner" /><span>{label}</span></div> }

export function SongMeta({ song }: { song: Song | null }) { return <>{song ? <><strong>{songTitle(song)}</strong><small>{songArtist(song)}</small></> : <><strong>云音</strong><small>选择一首歌曲开始播放</small></>}</> }

export function Time({ value }: { value: number }) { return <span>{formatDuration(value)}</span> }
