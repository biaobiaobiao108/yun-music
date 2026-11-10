import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Icon, Loading } from './components'
import { consumeImmersiveLyricsTrigger, PlayerFooterBar } from './player_footer'
import { useLyricStore, usePlaybackStore, usePlayerUiStore, useSettingsStore } from './store'
import { songImage, songTitle } from './types'
import { safeImageUrl } from '../../../shared/src/runtime'
import {
  buildRhythmPhrases,
  isRhythmCjkCharacter,
  rhythmGlyphFrame,
  rhythmGlyphLayoutScale,
  rhythmGlyphWidth,
  rhythmNeedsSmoothFrame,
  rhythmRowFrame,
  rhythmRowShape,
  rhythmSparkFrame,
  type RhythmGlyph,
  type RhythmPhrase,
} from './lyric_rhythm'
import { readPlaybackPosition } from './store/playback'
import type { LyricLine } from './types'

const RHYTHM_SPARK_ANGLES = [0, 60, 120, 180, 240, 300] as const
const RHYTHM_INTRO_LINE: LyricLine = { time: 0, text: 'Shh... the melody is doing the talking.' }

function findActiveLyricIndex(lines: readonly { time: number }[], time: number): number {
  let low = 0
  let high = lines.length - 1
  let active = -1
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((lines[middle]?.time ?? Infinity) <= time) {
      active = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return active
}

type ImmersiveFooterHost = 'normal' | 'immersive'

export type ImmersiveLyricsProps = {
  open: boolean
  footerHost: ImmersiveFooterHost
  onFooterHostChange: (host: ImmersiveFooterHost) => void
  onClose: () => void
  onClosed?: () => void
}

type RhythmStyleProperty = 'opacity' | 'transform' | 'color' | 'textShadow'
type RhythmNode = { node: HTMLElement; styles: Partial<Record<RhythmStyleProperty, string>>; settled?: boolean }

// Keep the last authored values: CSSOM reads can normalize colors and transforms.
function writeRhythmStyle(target: RhythmNode, property: RhythmStyleProperty, value: string) {
  if (target.styles[property] === value) return
  target.styles[property] = value
  target.node.style[property] = value
}

function RhythmLyrics({
  open,
  lines,
  loading,
  error,
  showTranslation,
  showRoma,
  seek,
}: {
  open: boolean
  lines: LyricLine[]
  loading: boolean
  error: string
  showTranslation: boolean
  showRoma: boolean
  seek: (time: number) => void
}) {
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const duration = usePlaybackStore(state => state.duration)
  const listRef = useRef<HTMLElement | null>(null)
  const focusRef = useRef(-1)
  const [focus, setFocus] = useState(-1)
  const [reducedMotion, setReducedMotion] = useState(false)
  const currentTime = usePlaybackStore(state => (state.isPlaying && !reducedMotion ? 0 : state.currentTime))
  const [viewport, setViewport] = useState({ width: 960, height: 600 })
  const availableWidth = Math.max(1, Math.min(viewport.width * 0.86, viewport.width - 32))
  const targetFontSize = Math.min(88, Math.max(26, viewport.width * 0.06875))
  const maxPhraseWidth = availableWidth / (targetFontSize * 1.55)

  useEffect(() => {
    const list = listRef.current
    if (!open || !list) return
    const measure = () => {
      const width = list.clientWidth
      const height = list.clientHeight
      setViewport(previous => (previous.width === width && previous.height === height ? previous : { width, height }))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(list)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open])

  const getLayout = useMemo(() => {
    const cache = new Map<number, RhythmPhrase[]>()
    return (index: number) => {
      const line = lines[index]
      if (!line) return []
      let layout = cache.get(index)
      if (!layout) {
        layout = buildRhythmPhrases(
          line,
          lines[index + 1]?.time ?? (duration > line.time ? duration : line.time + 4),
          4,
          maxPhraseWidth,
        )
        cache.set(index, layout)
      }
      return layout
    }
  }, [duration, lines, maxPhraseWidth])
  const introLayouts = useMemo(() => buildRhythmPhrases(RHYTHM_INTRO_LINE, 3, 4, maxPhraseWidth), [maxPhraseWidth])
  const nodesRef = useRef<{
    previous: (RhythmNode & { start: number }) | null
    phrases: (RhythmNode & {
      start: number
      side: number
      offset: number
      y: number
      scale: number
      previous: boolean
    })[]
    words: (RhythmNode & {
      glyph: RhythmGlyph
      seed: number
      index: number
      final: boolean
      previous: boolean
      driftFrame?: number
      sparkActive?: boolean
      stars: (RhythmNode & { angle: number; size: number })[]
    })[]
    characters: (RhythmNode & { start: number; duration: number; previous: boolean })[]
  }>({ previous: null, phrases: [], words: [], characters: [] })
  useEffect(() => {
    const list = listRef.current
    const previous = list?.querySelector<HTMLElement>('.react-rhythm-previous') ?? null
    const inPrevious = (node: HTMLElement) => Boolean(previous?.contains(node))
    nodesRef.current = {
      previous: previous ? { node: previous, start: Number(previous.dataset.lineStart), styles: {} } : null,
      phrases: Array.from(list?.querySelectorAll<HTMLElement>('.react-rhythm-phrase') ?? [], node => ({
        node,
        styles: {},
        start: Number(node.dataset.start),
        side: Number(node.dataset.side),
        offset: Number(node.dataset.offset),
        y: Number(node.dataset.y),
        scale: Number(node.dataset.scale),
        previous: inPrevious(node),
      })),
      words: Array.from(list?.querySelectorAll<HTMLElement>('.react-rhythm-word') ?? [], node => ({
        node,
        styles: {},
        glyph: {
          text: node.textContent ?? '',
          time: Number(node.dataset.start),
          duration: Number(node.dataset.duration),
          spark: node.dataset.spark === 'true',
        },
        seed: Number(node.dataset.seed),
        index: Number(node.dataset.index),
        final: node.dataset.final === 'true',
        sparkActive: node.dataset.sparkActive === 'true',
        previous: inPrevious(node),
        stars: Array.from(node.querySelectorAll<HTMLElement>('.react-rhythm-spark-star'), star => ({
          node: star,
          styles: {},
          angle: Number(star.dataset.angle),
          size: Number(star.dataset.size ?? 1),
        })),
      })),
      characters: Array.from(list?.querySelectorAll<HTMLElement>('.react-rhythm-char') ?? [], node => ({
        node,
        styles: {},
        start: Number(node.dataset.start),
        duration: Math.max(0.2, Math.min(0.9, Number(node.dataset.duration))),
        previous: inPrevious(node),
      })),
    }
    // Measure all words before writing spacing; animation frames never read layout.
    const metrics = nodesRef.current.words.map(({ node: word }) => {
      const next = word.nextElementSibling
      const nextWord = next instanceof HTMLElement && next.classList.contains('react-rhythm-word') ? next : null
      return {
        word,
        width: word.offsetWidth,
        scale: Number(word.dataset.layoutScale),
        nextWidth: nextWord?.offsetWidth ?? 0,
        nextScale: Number(nextWord?.dataset.layoutScale ?? 1),
        gap: Number(word.dataset.fontSize) * 0.08,
        hasNext: Boolean(nextWord),
      }
    })
    for (const metric of metrics) {
      const growth = (metric.width * (metric.scale - 1) + metric.nextWidth * (metric.nextScale - 1)) / 2
      const margin = metric.hasNext ? Math.max(metric.gap * 2, growth + metric.gap) : 0
      metric.word.style.marginInlineEnd = `${margin.toFixed(2)}px`
    }
  }, [error, focus, getLayout, introLayouts, lines, loading, open, reducedMotion, viewport])
  const updateAt = useCallback(
    (time: number) => {
      const index = findActiveLyricIndex(lines, time)
      if (focusRef.current !== index) {
        focusRef.current = index
        setFocus(index)
        return
      }
      const reduced = reducedMotion
      const { words, phrases, characters, previous } = nodesRef.current
      if (previous) {
        const elapsed = Math.min(1, Math.max(0, (time - previous.start) / 0.4))
        const opacity = reduced ? 0 : (1 - elapsed) ** 3
        writeRhythmStyle(previous, 'opacity', String(opacity))
        writeRhythmStyle(previous, 'transform', reduced ? 'none' : `translateY(${(-12 * (1 - opacity)).toFixed(2)}px)`)
      }
      const previousHidden = previous && Number(previous.styles.opacity) <= 0.001
      phrases.forEach(target => {
        const { node: phrase, start, side, offset, y, scale, previous: wasPrevious } = target
        if (previousHidden && wasPrevious) return
        if (time >= start + 1.5 && target.settled) return
        target.settled = time >= start + 1.5
        const frame = rhythmRowFrame(start, time, side)
        const opacity = reduced ? (time >= start ? 1 : 0) : frame.opacity
        writeRhythmStyle(target, 'opacity', String(opacity))
        if (!wasPrevious) {
          const visible = opacity > 0.01
          if (phrase.tabIndex !== (visible ? 0 : -1)) phrase.tabIndex = visible ? 0 : -1
          if (visible && phrase.hasAttribute('aria-hidden')) phrase.removeAttribute('aria-hidden')
          else if (!visible && !phrase.hasAttribute('aria-hidden')) phrase.setAttribute('aria-hidden', 'true')
        }
        writeRhythmStyle(
          target,
          'transform',
          reduced
            ? 'none'
            : `translate(${(offset + frame.x).toFixed(2)}px, ${y.toFixed(2)}px) scale(${(scale * frame.scale).toFixed(3)})`,
        )
      })
      let activeSparks = 0
      for (let index = words.length - 1; index >= 0; index -= 1) {
        const target = words[index]!
        const {
          node: word,
          glyph: lyricWord,
          seed,
          index: wordIndex,
          final: finalSpark,
          previous: wasPrevious,
          stars,
        } = target
        if (previousHidden && wasPrevious) continue
        const start = lyricWord.time
        const length = lyricWord.duration
        const end = Math.max(start + length, start + 0.15)
        const after = time - end
        const settledAt = end + 5
        if (time < start - 0.08 && target.styles.opacity === '0' && !target.sparkActive) continue
        if (time >= settledAt && target.settled) continue
        target.settled = time >= settledAt
        const driftFrame = Math.floor(time * 10)
        if (after > 0.9 && target.driftFrame === driftFrame) continue
        target.driftFrame = after > 0.9 ? driftFrame : undefined
        const frame = rhythmGlyphFrame(lyricWord, time, seed, wordIndex)
        writeRhythmStyle(target, 'color', `rgb(255 255 255 / ${frame.fill.toFixed(3)})`)
        if (reduced) {
          writeRhythmStyle(target, 'opacity', time >= start ? '0.8' : '0')
          writeRhythmStyle(target, 'transform', 'none')
          writeRhythmStyle(target, 'textShadow', 'none')
          if (target.sparkActive) delete word.dataset.sparkActive
          target.sparkActive = false
          continue
        }
        writeRhythmStyle(target, 'opacity', String(frame.opacity))
        const motionScale = Math.min(1, viewport.width / 600)
        writeRhythmStyle(
          target,
          'transform',
          `translate(${(frame.x * motionScale).toFixed(2)}px, ${(frame.y * motionScale).toFixed(2)}px) rotate(${frame.rotation.toFixed(2)}deg) scale(${frame.scale.toFixed(3)})`,
        )
        writeRhythmStyle(
          target,
          'textShadow',
          frame.glow > 0.01
            ? `0 0 ${(frame.glow * 0.24).toFixed(2)}em color-mix(in srgb, var(--app-accent, #f42f4c) ${Math.round(frame.glow * 72)}%, transparent)`
            : 'none',
        )
        const spark = activeSparks < 4 ? rhythmSparkFrame(lyricWord, time, seed, wordIndex, finalSpark) : null
        if (spark) {
          activeSparks += 1
          if (!target.sparkActive) word.dataset.sparkActive = 'true'
          target.sparkActive = true
          stars.forEach(star => {
            const { angle, size } = star
            const distance = 0.12 + spark.spread * (finalSpark ? 1.3 : 1.05)
            writeRhythmStyle(star, 'opacity', spark.opacity.toFixed(3))
            writeRhythmStyle(
              star,
              'transform',
              `translate(-50%, -50%) rotate(${(angle + spark.rotation).toFixed(1)}deg) translateY(-${distance.toFixed(2)}em) rotate(${-angle}deg) scale(${(spark.scale * size).toFixed(2)})`,
            )
          })
        } else if (target.sparkActive) {
          delete word.dataset.sparkActive
          target.sparkActive = false
        }
      }
      characters.forEach(target => {
        const { start, duration, previous: wasPrevious } = target
        if (previousHidden && wasPrevious) return
        const elapsed = time - start
        if (elapsed >= duration * 2.2 && target.settled) return
        target.settled = elapsed >= duration * 2.2
        const pulse =
          elapsed < 0
            ? 0
            : elapsed <= duration
              ? Math.sin((elapsed / duration) * Math.PI)
              : 0.25 * Math.min(1, Math.max(0, (elapsed - duration) / (duration * 1.2)))
        writeRhythmStyle(target, 'transform', reduced ? 'none' : `scale(${(1 + pulse * 0.15).toFixed(3)})`)
      })
    },
    [lines, reducedMotion, viewport.height, viewport.width],
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const refresh = () => setReducedMotion(media.matches)
    media.addEventListener('change', refresh)
    refresh()
    return () => media.removeEventListener('change', refresh)
  }, [])

  useEffect(() => {
    if (!open) return
    let previousTime = Number.NaN
    let frame = 0
    let timer = 0
    const tick = () => {
      frame = 0
      timer = 0
      const time = readPlaybackPosition() ?? usePlaybackStore.getState().currentTime
      if (time !== previousTime) {
        previousTime = time
        updateAt(time)
      }
      const index = findActiveLyricIndex(lines, time)
      const activePhrases = index < 0 ? introLayouts : getLayout(index)
      if (rhythmNeedsSmoothFrame(activePhrases, time)) frame = window.requestAnimationFrame(tick)
      else timer = window.setTimeout(tick, 100)
    }
    if (!isPlaying || reducedMotion || !lines.length) return
    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame)
      if (timer) window.clearTimeout(timer)
      frame = 0
      timer = 0
    }
    const onVisibilityChange = () => {
      stop()
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (!document.hidden) tick()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [getLayout, introLayouts, isPlaying, lines, open, reducedMotion, updateAt])

  useEffect(() => {
    if (!open) return
    const stateTime = usePlaybackStore.getState().currentTime
    // Paused and reduced-motion frames use the exact shared progress snapshot.
    const time = !isPlaying || reducedMotion ? stateTime : (readPlaybackPosition() ?? stateTime)
    updateAt(time)
  }, [currentTime, focus, getLayout, isPlaying, open, reducedMotion, updateAt, viewport])

  const displayIndex = Math.max(0, focus)
  const renderPhrases = (
    rows: RhythmPhrase[],
    lineTime: number,
    keyPrefix: string,
    previous = false,
    seekable = true,
    sparks = true,
  ) => {
    const lastSpark = sparks
      ? rows.flatMap(phrase => phrase.glyphs).findLast(glyph => glyph.spark && /[\p{L}\p{N}]/u.test(glyph.text))
      : undefined
    const widest = Math.max(
      1,
      ...rows.map(phrase => phrase.glyphs.reduce((sum, glyph) => sum + rhythmGlyphWidth(glyph.text), 0)),
    )
    const fontSize = Math.max(
      14,
      Math.min(
        targetFontSize,
        availableWidth / (widest * 1.55),
        (viewport.height * 0.68) / (Math.max(1, rows.length) * 1.55),
      ),
    )
    return rows.map((phrase, phraseIndex) => {
      const shape = rhythmRowShape(lineTime, phraseIndex)
      return (
        <button
          type="button"
          className="react-rhythm-phrase"
          key={`${keyPrefix}-${phrase.time}-${phraseIndex}`}
          data-start={phrase.time}
          data-side={shape.side}
          data-offset={shape.offset * Math.min(1, viewport.width / 600)}
          data-y={(phraseIndex - (rows.length - 1) / 2) * 2.5}
          data-scale={shape.scale}
          aria-label={phrase.glyphs.map(glyph => glyph.text).join('')}
          aria-hidden={previous || undefined}
          disabled={previous || !seekable}
          style={{ fontSize: `${fontSize}px` }}
          onClick={seekable ? () => seek(phrase.time) : undefined}
        >
          {phrase.glyphs
            .reduce<RhythmGlyph[][]>((groups, glyph) => {
              const previousGroup = groups.at(-1)
              if (glyph.group !== undefined && previousGroup?.[0]?.group === glyph.group) previousGroup.push(glyph)
              else groups.push([glyph])
              return groups
            }, [])
            .map((group, groupIndex) => {
              const first = group[0]!
              const groupId = first.group ?? groupIndex
              return (
                <span
                  className="react-rhythm-word"
                  key={`${first.groupTime ?? first.time}-${groupId}`}
                  data-start={first.groupTime ?? first.time}
                  data-duration={first.groupDuration ?? first.duration}
                  data-seed={lineTime}
                  data-index={groupId}
                  data-spark={sparks && first.groupSpark ? 'true' : undefined}
                  data-final={sparks && lastSpark && group.includes(lastSpark) ? 'true' : undefined}
                  data-layout-scale={rhythmGlyphLayoutScale(lineTime, groupId)}
                  data-font-size={fontSize}
                >
                  {sparks && first.groupSpark && (
                    <span className="react-rhythm-spark" aria-hidden="true">
                      {RHYTHM_SPARK_ANGLES.map((angle, sparkIndex) => (
                        <i
                          className="react-rhythm-spark-star"
                          key={angle}
                          data-angle={angle}
                          data-size={sparkIndex % 3 === 1 ? 0.68 : 1}
                        />
                      ))}
                    </span>
                  )}
                  {isRhythmCjkCharacter(first.text) ? (
                    <span
                      className="react-rhythm-char"
                      data-start={first.time}
                      data-duration={first.duration}
                      aria-hidden="true"
                    >
                      {group.map(glyph => glyph.text).join('')}
                    </span>
                  ) : (
                    group.map(glyph => glyph.text).join('')
                  )}
                </span>
              )
            })}
        </button>
      )
    })
  }
  const activeLine = focus >= 0 ? lines[focus] : undefined
  const translation = showTranslation ? activeLine?.translation : undefined
  const secondary = translation ? activeLine?.text : showRoma ? activeLine?.roma : undefined

  return (
    <>
      <div className="react-immersive-lyrics-grid">
        <section ref={listRef} className="react-immersive-lyrics-list" aria-label="歌词">
          {loading ? (
            <Loading label="正在加载歌词…" />
          ) : error ? (
            <p className="react-error" role="alert">
              {error}
            </p>
          ) : lines.length && focus < 0 ? (
            <div className="react-rhythm-phrases react-rhythm-current" role="group" aria-label="音乐前奏">
              {renderPhrases(introLayouts, 0, 'intro', false, false, false)}
            </div>
          ) : lines.length ? (
            <>
              {focus > 0 && (
                <div
                  className="react-rhythm-phrases react-rhythm-previous"
                  data-line-start={lines[focus]?.time}
                  aria-hidden="true"
                >
                  {renderPhrases(getLayout(focus - 1), lines[focus - 1]?.time ?? 0, `line-${focus - 1}`, true)}
                </div>
              )}
              <div className="react-rhythm-phrases react-rhythm-current">
                {renderPhrases(getLayout(displayIndex), lines[displayIndex]?.time ?? 0, `line-${displayIndex}`)}
              </div>
            </>
          ) : (
            <div className="react-empty">
              <Icon name="file-lines" />
              <p>暂无歌词</p>
            </div>
          )}
        </section>
      </div>
      <div className="react-immersive-lyrics-track-meta" aria-live="polite">
        {activeLine && <strong>{translation || activeLine.text}</strong>}
        {secondary && <small>{secondary}</small>}
      </div>
    </>
  )
}

function ScrollingLyrics({
  lines,
  loading,
  error,
  showTranslation,
  showRoma,
  seek,
}: {
  lines: LyricLine[]
  loading: boolean
  error: string
  showTranslation: boolean
  showRoma: boolean
  seek: (time: number) => void
}) {
  const activeIndex = usePlaybackStore(state => findActiveLyricIndex(lines, state.currentTime))
  const listRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!list || !active) return
    const center = (smooth: boolean) => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      list.scrollTo({
        top: active.offsetTop - list.offsetTop - (list.clientHeight - active.offsetHeight) / 2,
        behavior: smooth && !reduced ? 'smooth' : 'auto',
      })
    }
    center(true)
    let width = list.clientWidth
    let height = list.clientHeight
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (width === list.clientWidth && height === list.clientHeight) return
            width = list.clientWidth
            height = list.clientHeight
            center(false)
          })
    observer?.observe(list)
    return () => observer?.disconnect()
  }, [activeIndex, lines])

  return (
    <div className="react-immersive-lyrics-grid react-scrolling-lyrics-grid">
      <section ref={listRef} className="react-immersive-lyrics-list react-scrolling-lyrics" aria-label="滚动歌词">
        {loading ? (
          <Loading label="正在加载歌词…" />
        ) : error ? (
          <p className="react-error" role="alert">
            {error}
          </p>
        ) : lines.length ? (
          lines.map((line, index) => (
            <button
              key={`${line.time}-${index}`}
              type="button"
              className={index === activeIndex ? 'is-active' : ''}
              aria-current={index === activeIndex ? 'true' : undefined}
              onClick={() => seek(line.time)}
            >
              <span>{line.text}</span>
              {showTranslation && line.translation && <small>{line.translation}</small>}
              {showRoma && line.roma && <small>{line.roma}</small>}
            </button>
          ))
        ) : (
          <div className="react-empty">
            <Icon name="file-lines" />
            <p>暂无歌词</p>
          </div>
        )}
      </section>
    </div>
  )
}

export function ImmersiveLyricsView({ open, footerHost, onFooterHostChange, onClose, onClosed }: ImmersiveLyricsProps) {
  const song = usePlaybackStore(state => state.currentSong)
  const seek = usePlaybackStore(state => state.seek)
  const lines = useLyricStore(state => state.lines)
  const loading = useLyricStore(state => state.loading)
  const error = useLyricStore(state => state.error)
  const load = useLyricStore(state => state.load)
  const settings = useSettingsStore(state => state.settings)
  const notify = usePlayerUiStore(state => state.notify)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const fullscreenOwned = useRef(false)
  const openRef = useRef(open)
  openRef.current = open
  const [fullscreenSupported, setFullscreenSupported] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const lastFocus = useRef<HTMLElement | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [isClosing, setIsClosing] = useState(false)
  const [lyricMode, setLyricMode] = useState<'rhythm' | 'scroll'>('rhythm')
  const artwork = safeImageUrl(songImage(song))
  const [statusColor, setStatusColor] = useState('#3b3b3b')
  useEffect(() => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitExitFullscreen?: () => void
      webkitFullscreenEnabled?: boolean
    }
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }
    const fullscreenEnabled = document.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? true
    setFullscreenSupported(Boolean(fullscreenEnabled && (root.requestFullscreen || root.webkitRequestFullscreen)))
    const syncFullscreen = () => {
      const active = doc.fullscreenElement ?? doc.webkitFullscreenElement
      setFullscreen(Boolean(active))
      if (!active) fullscreenOwned.current = false
      else if (!openRef.current && fullscreenOwned.current && active === document.documentElement) {
        fullscreenOwned.current = false
        if (doc.exitFullscreen) void doc.exitFullscreen().catch(error => console.error('退出全屏失败:', error))
        else doc.webkitExitFullscreen?.()
      }
    }
    syncFullscreen()
    document.addEventListener('fullscreenchange', syncFullscreen)
    document.addEventListener('webkitfullscreenchange', syncFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      document.removeEventListener('webkitfullscreenchange', syncFullscreen)
    }
  }, [])
  const exitOwnedFullscreen = useCallback(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
    if (!fullscreenOwned.current) return
    const active = doc.fullscreenElement ?? doc.webkitFullscreenElement
    if (!active) return
    fullscreenOwned.current = false
    if (active !== document.documentElement) return
    if (doc.exitFullscreen) void doc.exitFullscreen().catch(error => console.error('退出全屏失败:', error))
    else doc.webkitExitFullscreen?.()
  }, [])
  useEffect(() => {
    if (!open) exitOwnedFullscreen()
  }, [exitOwnedFullscreen, open])
  useEffect(() => {
    openRef.current = open
    return () => {
      openRef.current = false
      exitOwnedFullscreen()
    }
  }, [exitOwnedFullscreen])
  const toggleFullscreen = async () => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
    const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }
    try {
      if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
        if (doc.exitFullscreen) await doc.exitFullscreen()
        else doc.webkitExitFullscreen?.()
        fullscreenOwned.current = false
      } else {
        fullscreenOwned.current = true
        if (root.requestFullscreen) await root.requestFullscreen()
        else root.webkitRequestFullscreen?.()
        if (!openRef.current) exitOwnedFullscreen()
      }
    } catch (error) {
      fullscreenOwned.current = false
      console.error('切换全屏失败:', error)
      notify('无法切换全屏，请检查浏览器设置')
    }
  }
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setStatusColor('#3b3b3b')
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 16
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(image, 0, 0, 16, 16)
        const pixels = context.getImageData(0, 0, 16, 4).data
        const sums = [0, 0, 0]
        for (let i = 0; i < pixels.length; i += 4) {
          for (let channel = 0; channel < 3; channel++) sums[channel] += pixels[i + channel]
        }
        if (!cancelled)
          setStatusColor(`rgb(${sums.map(sum => Math.round((sum / (pixels.length / 4)) * 0.58)).join(' ')})`)
      } catch {
        // Cross-origin artwork can be displayed but cannot always be sampled.
      }
    }
    image.src = artwork
    return () => {
      cancelled = true
      image.onload = null
    }
  }, [artwork, open])
  useEffect(() => {
    if (open) void load(song)
  }, [load, open, song])
  const finishClose = useCallback(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    const surface = dialog.querySelector<HTMLElement>('.react-immersive-lyrics')
    if (dialog.open) dialog.close()
    surface?.style.removeProperty('--react-immersive-scrollbar-gutter')
    const focusTarget = lastFocus.current
    const restoreFallback = () =>
      document
        .querySelector<HTMLButtonElement>('.react-player-main > #player-footer .react-footer-cover-button')
        ?.focus()
    if (
      focusTarget?.isConnected &&
      focusTarget !== document.body &&
      !dialog.contains(focusTarget) &&
      !focusTarget.matches(':disabled')
    )
      focusTarget.focus()
    else if (document.querySelector('.react-player-main > #player-footer .react-footer-cover-button')) restoreFallback()
    else window.requestAnimationFrame(restoreFallback)
    lastFocus.current = null
    onFooterHostChange('normal')
    setIsClosing(false)
    onClosed?.()
  }, [onClosed, onFooterHostChange])
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const surface = dialog.querySelector<HTMLElement>('.react-immersive-lyrics')
    const syncFooterPosition = () => {
      const bodyWidth = document.body.getBoundingClientRect().width
      const viewportWidth = window.innerWidth
      const scrollbarGutter = Math.max(0, viewportWidth - bodyWidth)
      surface?.style.setProperty('--react-immersive-scrollbar-gutter', `${scrollbarGutter}px`)
    }
    if (open) {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      setIsClosing(false)
    }
    if (open && !dialog.open) {
      lastFocus.current =
        consumeImmersiveLyricsTrigger() ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      syncFooterPosition()
      dialog.showModal()
      onFooterHostChange('immersive')
      surface?.focus({ preventScroll: true })
    } else if (open) {
      syncFooterPosition()
      onFooterHostChange('immersive')
    } else if (dialog.open && !isClosing) {
      setIsClosing(true)
      const closeDuration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220
      if (closeDuration === 0) finishClose()
      else closeTimer.current = window.setTimeout(finishClose, closeDuration)
    } else if (!open && !dialog.open) {
      onFooterHostChange('normal')
      onClosed?.()
    }
    if (open) {
      window.addEventListener('resize', syncFooterPosition)
      return () => window.removeEventListener('resize', syncFooterPosition)
    }
    return undefined
  }, [finishClose, isClosing, onClosed, onFooterHostChange, open])
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
      if (dialogRef.current?.open) dialogRef.current.close()
      const focusTarget = lastFocus.current
      const restoreFallback = () =>
        document
          .querySelector<HTMLButtonElement>('.react-player-main > #player-footer .react-footer-cover-button')
          ?.focus()
      if (focusTarget?.isConnected && focusTarget !== document.body && !focusTarget.matches(':disabled'))
        focusTarget.focus()
      else window.requestAnimationFrame(restoreFallback)
      lastFocus.current = null
      onFooterHostChange('normal')
    },
    [onFooterHostChange],
  )
  const lyricStyle = {
    '--react-lyric-size': `${Math.max(0.9, Number(settings.lyricFontSize || 1.25))}rem`,
  } as CSSProperties
  const title = songTitle(song)
  const immersiveStyle = {
    ...lyricStyle,
    '--react-immersive-art': `url("${artwork.replaceAll('"', '\\"')}")`,
    '--immersive-status-color': statusColor,
  } as CSSProperties
  return (
    <dialog
      ref={dialogRef}
      className={`react-immersive-lyrics-dialog ${isClosing ? 'is-closing' : ''}`}
      style={immersiveStyle}
      aria-label={song ? `${title} 歌词` : '沉浸式歌词'}
      onCancel={event => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="immersive-status-color" aria-hidden="true" />
      <div className="react-immersive-lyrics" style={immersiveStyle} tabIndex={-1}>
        <header className="react-immersive-lyrics-header">
          {fullscreenSupported && (
            <button
              type="button"
              className="react-lyrics-fullscreen"
              aria-label={fullscreen ? '退出全屏' : '进入全屏'}
              aria-pressed={fullscreen}
              onClick={() => void toggleFullscreen()}
            >
              <Icon name={fullscreen ? 'compress' : 'expand'} />
            </button>
          )}
          <button
            type="button"
            className="react-immersive-nav-button"
            data-immersive-close
            aria-label="关闭沉浸式歌词"
            onClick={onClose}
          >
            <Icon name="chevron-down" />
          </button>
          <button
            type="button"
            className="react-lyrics-mode"
            aria-label={lyricMode === 'rhythm' ? '当前为律动歌词，切换到滚动歌词' : '当前为滚动歌词，切换到律动歌词'}
            onClick={() => setLyricMode(mode => (mode === 'rhythm' ? 'scroll' : 'rhythm'))}
          >
            {lyricMode === 'rhythm' ? <Icon name="music" /> : <Icon name="list" />}
          </button>
        </header>
        {lyricMode === 'rhythm' ? (
          <RhythmLyrics
            open={open}
            lines={lines}
            loading={loading}
            error={error}
            showTranslation={Boolean(settings.showLyricTranslation)}
            showRoma={Boolean(settings.showLyricRoma)}
            seek={seek}
          />
        ) : (
          <ScrollingLyrics
            lines={lines}
            loading={loading}
            error={error}
            showTranslation={Boolean(settings.showLyricTranslation)}
            showRoma={Boolean(settings.showLyricRoma)}
            seek={seek}
          />
        )}
        <PlayerFooterBar variant="immersive" isActive={footerHost === 'immersive'} />
      </div>
    </dialog>
  )
}

export function LyricsDialog(props: ImmersiveLyricsProps) {
  return <ImmersiveLyricsView {...props} />
}
