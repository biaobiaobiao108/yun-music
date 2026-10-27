import type { LyricLine, LyricWord } from './types'

export type RhythmGlyph = {
  text: string
  time: number
  duration: number
  spark?: boolean
  group?: number
  groupTime?: number
  groupDuration?: number
  groupSpark?: boolean
}
export type RhythmPhrase = { glyphs: RhythmGlyph[]; time: number }

export function rhythmLyricEnd(line: LyricLine, phrases: RhythmPhrase[]): number {
  let renderedEnd = line.time
  for (const phrase of phrases) {
    for (const glyph of phrase.glyphs) renderedEnd = Math.max(renderedEnd, glyph.time + glyph.duration)
  }
  if (line.timedWords?.length) return renderedEnd
  let textLength = 0
  for (const text of graphemes(line.text)) {
    if (!/^\s+$/u.test(text) && !lyricPunctuation.test(text)) textLength += 1
  }
  const estimatedEnd = line.time + Math.max(1, Math.min(5.5, textLength * 0.2))
  return Math.min(renderedEnd, estimatedEnd)
}

export function isRhythmInterlude(
  lines: LyricLine[],
  lineEnds: number[],
  index: number,
  time: number,
  duration: number,
): boolean {
  if (!lines.length) return false
  if (index < 0) return true
  const line = lines[index]
  if (!line) return false
  const next = lines[index + 1]?.time ?? (duration > time ? duration : 0)
  if (!next || next <= time) return false
  const end = lineEnds[index] ?? line.time
  return next - end >= 1 && time >= end + 0.15 && time < next
}

const graphemeSegmenter =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

function graphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), item => item.segment) : Array.from(text)
}

const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const lyricWordCharacter = /[\p{L}\p{N}]/u
const lyricPunctuation = /^[\p{P}\p{S}]+$/u

export function rhythmGlyphWidth(text: string): number {
  if (/^\s+$/u.test(text)) return 0.3
  if (cjkCharacter.test(text)) return 1
  if (lyricPunctuation.test(text)) return 0.48
  if (/[\p{Script=Latin}\p{N}]/u.test(text)) return 0.56
  return 0.72
}

export function isRhythmCjkCharacter(text: string): boolean {
  return cjkCharacter.test(text)
}

function groupWordGlyphs(glyphs: RhythmGlyph[]): RhythmGlyph[] {
  const groups: { start: number; time: number; finish: number; spark: boolean }[] = []
  const ids: number[] = []
  let active = -1
  let activeKind: 'word' | 'cjk' | 'other' | null = null
  let breakBeforeWord = false

  const startGroup = (glyph: RhythmGlyph, kind: 'word' | 'cjk' | 'other') => {
    active = groups.length
    const singing = !/^\s+$/u.test(glyph.text) && !lyricPunctuation.test(glyph.text)
    const time = singing ? glyph.time : Number.POSITIVE_INFINITY
    const finish = singing ? glyph.time + glyph.duration : Number.NEGATIVE_INFINITY
    groups.push({ start: ids.length, time, finish, spark: Boolean(singing && glyph.spark) })
    activeKind = kind
    return active
  }

  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index]!
    const text = glyph.text
    const previous = glyphs[index - 1]?.text ?? ''
    const next = glyphs[index + 1]?.text ?? ''
    const connector = /^[’'\-‐‑]$/u.test(text) && activeKind === 'word' && lyricWordCharacter.test(next)
    let group: number

    if (/^\s+$/u.test(text)) {
      group = active >= 0 ? active : startGroup(glyph, 'other')
      breakBeforeWord = true
    } else if (connector) {
      group = active
      breakBeforeWord = false
    } else if (lyricPunctuation.test(text)) {
      group = active >= 0 ? active : startGroup(glyph, 'other')
      breakBeforeWord = true
    } else if (cjkCharacter.test(text)) {
      group = startGroup(glyph, 'cjk')
      breakBeforeWord = false
    } else if (lyricWordCharacter.test(text)) {
      group = activeKind === 'word' && !breakBeforeWord ? active : startGroup(glyph, 'word')
      activeKind = 'word'
      breakBeforeWord = false
    } else {
      group = startGroup(glyph, 'other')
      breakBeforeWord = true
    }

    ids.push(group)
    const entry = groups[group]!
    if (!/^\s+$/u.test(text) && !lyricPunctuation.test(text)) {
      entry.time = Math.min(entry.time, glyph.time)
      entry.finish = Math.max(entry.finish, glyph.time + glyph.duration)
      entry.spark ||= Boolean(glyph.spark)
    }

    if (
      lyricPunctuation.test(text) &&
      activeKind === 'word' &&
      /^[’'\-]$/u.test(text) &&
      lyricWordCharacter.test(previous)
    ) {
      breakBeforeWord = false
    }
  }

  return glyphs.map((glyph, index) => {
    const group = ids[index]!
    const metadata = groups[group]!
    const first = metadata.start === index
    return {
      ...glyph,
      group,
      groupTime: Number.isFinite(metadata.time) ? metadata.time : glyph.time,
      groupDuration: Number.isFinite(metadata.finish) ? Math.max(0, metadata.finish - metadata.time) : 0,
      groupSpark: first && metadata.spark,
    }
  })
}

function expandWords(words: LyricWord[]): RhythmGlyph[] {
  return words.flatMap(word => {
    const characters = graphemes(word.text)
    const count = characters.filter(text => !/^\s+$/u.test(text)).length
    const duration = Math.max(0, word.duration) / Math.max(1, count)
    let index = 0
    return characters.map(text => {
      const time = word.time + duration * index
      if (/^\s+$/u.test(text)) return { text, time, duration: 0 }
      const spark = index === 0
      index += 1
      return { text, time, duration, spark }
    })
  })
}

/** Split one timed lyric line into short, readable phrases without losing text. */
export function buildRhythmPhrases(line: LyricLine, endTime: number, maxRows = 4, maxPhraseWidth = 14): RhythmPhrase[] {
  const timed = line.timedWords?.length ? expandWords(line.timedWords) : []
  const normalized = (text: string) =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '')
  const decoration = (text: string) => /^[\s\p{P}\p{S}]+$/u.test(text)
  const matchesLine = timed.length > 0 && normalized(timed.map(item => item.text).join('')) === normalized(line.text)
  const characters = graphemes(line.text)
  const availableDuration = Math.max(0.1, Math.min(6, endTime > line.time ? endTime - line.time : 4)) * 0.85
  const estimatedDuration = availableDuration / Math.max(1, characters.filter(text => !/^\s+$/u.test(text)).length)
  let timedIndex = 0
  let estimatedIndex = 0
  const glyphs: RhythmGlyph[] = characters.map((text, index) => {
    if (matchesLine) {
      if (decoration(text) && text !== timed[timedIndex]?.text) {
        const last = timed.at(-1)
        return { text, time: timed[timedIndex]?.time ?? (last ? last.time + last.duration : line.time), duration: 0 }
      }
      while (!decoration(text) && decoration(timed[timedIndex]?.text ?? '')) timedIndex += 1
      const glyph = timed[timedIndex++]
      if (glyph) return { ...glyph, text }
    }
    const time = line.time + estimatedDuration * estimatedIndex
    if (/^\s+$/u.test(text)) return { text, time, duration: 0 }
    estimatedIndex += 1
    const previous = characters[index - 1] ?? ''
    const boundary = !previous || (decoration(previous) && !/^[’'\-]$/u.test(previous))
    const spark = !decoration(text) && (/[^\x00-\xff]/u.test(text) || boundary)
    return { text, time, duration: estimatedDuration, spark }
  })

  const wordGlyphs = groupWordGlyphs(glyphs)
  const units: RhythmGlyph[][] = []
  let run: RhythmGlyph[] = []
  const flushRun = () => {
    if (!run.length) return
    const cjk = run.some(glyph => /[^\x00-\xff]/u.test(glyph.text) && !/[\p{P}\s]/u.test(glyph.text))
    const pieces = cjk && run.length > 6 ? Math.ceil(run.length / 4) : 1
    for (let i = 0; i < pieces; i += 1) {
      units.push(run.slice(Math.floor((run.length * i) / pieces), Math.floor((run.length * (i + 1)) / pieces)))
    }
    run = []
  }
  for (const glyph of wordGlyphs) {
    const breaks = /[\s\p{P}]/u.test(glyph.text) && !/[’'\-]/u.test(glyph.text)
    if (breaks && !run.length && units.length) {
      units[units.length - 1]!.push(glyph)
    } else {
      run.push(glyph)
      if (breaks) flushRun()
    }
  }
  flushRun()
  if (!units.length) return []

  const sizes = units.map(unit => unit.reduce((sum, glyph) => sum + rhythmGlyphWidth(glyph.text), 0))
  const total = sizes.reduce((sum, size) => sum + size, 0)
  const count = Math.min(Math.max(1, maxRows), 4, units.length, Math.max(1, Math.ceil(total / maxPhraseWidth)))
  const phrases: RhythmPhrase[] = []
  let from = 0
  let previousSize = 0
  for (let row = 1; row <= count; row += 1) {
    let cut = units.length
    if (row < count) {
      let best = Infinity
      let size = previousSize
      for (let index = from + 1; index <= units.length - (count - row); index += 1) {
        size += sizes[index - 1]!
        const last = units[index - 1]!.at(-1)?.text ?? ''
        const distance = Math.abs(size - (total * row) / count) - (/[\p{P}]/u.test(last) ? total * 0.15 : 0)
        if (distance < best) {
          best = distance
          cut = index
        }
      }
    }
    const rowGlyphs = units.slice(from, cut).flat()
    if (rowGlyphs.length) phrases.push({ glyphs: rowGlyphs, time: rowGlyphs[0]!.time })
    previousSize += sizes.slice(from, cut).reduce((sum, size) => sum + size, 0)
    from = cut
  }
  return phrases
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
const easeOut = (value: number) => 1 - (1 - clamp01(value)) ** 3
const random = (seed: number, offset: number) => {
  const value = Math.sin(seed + offset) * 10000
  return value - Math.floor(value)
}

export function rhythmRowFrame(start: number, position: number, side: number) {
  const since = position - start + 0.08
  const spring = since > 0 ? 1 - Math.exp(-10 * since) * (Math.cos(10 * since) + Math.sin(10 * since)) : 0
  return { opacity: clamp01(since / 0.1), x: side * 30 * (1 - spring), scale: 0.85 + 0.15 * spring }
}

export function rhythmRowShape(lineTime: number, index: number) {
  const seed = lineTime + index * 7.13
  const side = index % 2 === 0 ? -1 : 1
  return { side, offset: 0, scale: 0.98 + random(seed, 7) * 0.04 }
}

export function rhythmNeedsSmoothFrame(phrases: RhythmPhrase[], position: number) {
  let previousGroup: number | undefined
  for (const phrase of phrases) {
    const rowEnd = phrase.time + 1.5
    if (position >= phrase.time - 0.18 && position <= rowEnd) return true
    for (const glyph of phrase.glyphs) {
      if (glyph.group !== undefined) {
        if (previousGroup === glyph.group) continue
        previousGroup = glyph.group
      } else previousGroup = undefined
      const start = glyph.groupTime ?? glyph.time
      const duration = glyph.groupDuration ?? glyph.duration
      const end = Math.max(start + duration, start + 0.15)
      const charPulseEnd = isRhythmCjkCharacter(glyph.text)
        ? start + Math.max(0.2, Math.min(0.9, glyph.duration)) * 2.2
        : start
      if (position >= start - 0.18 && position <= Math.max(end + 0.9, charPulseEnd)) return true
    }
  }
  return false
}

export function rhythmGlyphLayoutScale(seed: number, index: number) {
  return 1.06 + random(seed + index * 7.13, 4) * 0.14
}

/** Playback position alone determines the frame, so pause and seek stay exact. */
export function rhythmGlyphFrame(glyph: RhythmGlyph, position: number, seed: number, index: number) {
  const motionSeed = seed + index * 7.13
  const baseX = (random(motionSeed, 1) - 0.5) * 20
  const baseY = (random(motionSeed, 2) - 0.5) * 18
  const baseRotation = (random(motionSeed, 3) - 0.5) * 8
  const originX = baseX + Math.sin(baseY) * 58
  const originY = baseY + Math.cos(baseX) * 34
  const originRotation = 20
  const targetScale = rhythmGlyphLayoutScale(seed, index)
  const peakScale = targetScale * 1.3
  const since = position - glyph.time + 0.08
  const after = position - Math.max(glyph.time + glyph.duration, glyph.time + 0.15)
  const spring = since > 0 ? 1 - Math.exp(-10 * since) * (Math.cos(10 * since) + Math.sin(10 * since)) : 0
  let x = baseX + (originX - baseX) * (1 - spring)
  let y = baseY + (originY - baseY) * (1 - spring)
  let rotation = baseRotation + originRotation * (1 - spring)
  let scale = 0.5 + (peakScale - 0.5) * spring
  let opacity = clamp01(since / 0.1)
  let blur = 10 * (1 - clamp01(since / 0.2))
  let fill = 0.5 + 0.5 * clamp01(since / Math.max(0.08, glyph.duration))
  let glow = clamp01(since / Math.max(0.08, 0.3 * glyph.duration))
  if (after > 0) {
    const settled = easeOut(after / 0.5)
    x = baseX
    y = baseY
    rotation = baseRotation + (random(motionSeed, 8) - 0.5) * 10 * clamp01(after / 5)
    scale = peakScale + (targetScale - peakScale) * settled
    opacity = 1 - 0.18 * settled
    fill = 1 - 0.5 * easeOut(after / 0.8)
    blur = 0
    glow = 1 - clamp01(after / 0.9)
  }
  return { x, y, rotation, scale, opacity, blur, fill, glow }
}

/** A short, deterministic star burst at the beginning of a sung word. */
export function rhythmSparkFrame(glyph: RhythmGlyph, position: number, seed: number, index: number, final = false) {
  if (!glyph.spark || !glyph.text.trim() || /^[\s\p{P}\p{S}]+$/u.test(glyph.text)) return null
  const age = position - glyph.time
  const lifetime = final ? 0.55 : 0.42
  if (age < 0 || age >= lifetime) return null
  const progress = clamp01(age / lifetime)
  return {
    opacity: (1 - progress) ** 2 * (final ? 0.78 : 0.68),
    spread: easeOut(progress),
    scale: 0.9 - progress * 0.4,
    rotation: (random(seed + index * 7.13, 8) - 0.5) * 60,
  }
}
