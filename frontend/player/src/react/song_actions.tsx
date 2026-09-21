import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { Icon } from './components'
import type { Song } from './types'
import { navigateToSongEntity } from './song_details'

type SongActionsPopoverProps = {
  song: Song | null
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  onAddToList: () => void
  onComment: () => void
  onDownload: () => void
  onSleep: () => void
}

export function SongActionsPopover({ song, open, anchorRef, onClose, onAddToList, onComment, onDownload, onSleep }: SongActionsPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<CSSProperties | null>(null)

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const anchorRect = anchor.getBoundingClientRect()
    const width = panel.offsetWidth || 240
    const height = panel.offsetHeight || 280
    const edge = 10
    const gap = 8
    let top = anchorRect.bottom + gap
    if (top + height > window.innerHeight - edge) top = anchorRect.top - gap - height
    top = Math.max(edge, Math.min(top, window.innerHeight - height - edge))
    const left = Math.max(edge, Math.min(anchorRect.right - width, window.innerWidth - width - edge))
    setPosition({ top: Math.round(top), left: Math.round(left), width: Math.min(width, window.innerWidth - edge * 2), visibility: 'visible' })
  }, [anchorRef])

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const frame = window.requestAnimationFrame(updatePosition)
    return () => window.cancelAnimationFrame(frame)
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && (panelRef.current?.contains(target) || anchorRef.current?.contains(target))) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    const focusFrame = window.requestAnimationFrame(() => firstActionRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef, onClose, open, updatePosition])

  if (!open || !song) return null

  const run = (action: () => void) => {
    onClose()
    action()
  }

  // A native modal dialog is rendered in the browser's top layer. A portal
  // mounted directly under body would stay behind the immersive lyrics dialog,
  // so keep the popover in the active dialog when the footer is immersive.
  const portalTarget = anchorRef.current?.closest('dialog') ?? document.body

  return createPortal(<div ref={panelRef} id="song-actions-popover" className="react-song-actions-popover" role="dialog" aria-label="歌曲更多操作" style={position ?? { visibility: 'hidden', top: 0, left: 0 }}>
    <div className="react-song-actions-popover-heading">歌曲操作</div>
    <div className="react-song-actions-popover-list">
      <button ref={firstActionRef} type="button" onClick={() => run(() => navigateToSongEntity(song, 'artist'))}><Icon name="user" /><span>歌手详情</span></button>
      <button type="button" onClick={() => run(() => navigateToSongEntity(song, 'album'))}><Icon name="compact-disc" /><span>专辑</span></button>
      <button type="button" onClick={() => run(onAddToList)}><Icon name="list-ul" /><span>添加到歌单</span></button>
      <button type="button" onClick={() => run(onComment)}><Icon name="comments" /><span>评论</span></button>
      <button type="button" onClick={() => run(onDownload)}><Icon name="download" /><span>下载歌曲</span></button>
      <button type="button" onClick={() => run(onSleep)}><Icon name="moon" /><span>睡眠定时器</span></button>
    </div>
  </div>, portalTarget)
}
