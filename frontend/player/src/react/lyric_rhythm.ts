import type { LyricLine, LyricWord } from './types'

export type RhythmGlyph = { text: string; time: number; duration: number; spark?: boolean }
export type RhythmPhrase = { glyphs: RhythmGlyph[]; time: number }

const graphemeSegmenter =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

function graphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), item => item.segment) : Array.from(text)
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
export function buildRhythmPhrases(line: LyricLine, endTime: number, maxRows = 4): RhythmPhrase[] {
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
  for (const glyph of glyphs) {
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

  const count = Math.min(Math.max(1, maxRows), 4, units.length)
  const sizes = units.map(unit => unit.filter(glyph => !/^\s+$/u.test(glyph.text)).length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
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
  return { side, offset: side * (8 + random(seed, 6) * 22), scale: 0.9 + random(seed, 7) * 0.2 }
}

/** Playback position alone determines the frame, so pause and seek stay exact. */
export function rhythmGlyphFrame(glyph: RhythmGlyph, position: number, seed: number, index: number) {
  const baseX = (random(seed + index * 7.13, 1) - 0.5) * 8
  const baseY = (random(seed + index * 7.13, 2) - 0.5) * 8
  const baseRotation = (random(seed + index * 7.13, 3) - 0.5) * 5
  const targetScale = 1.04 + random(seed + index * 7.13, 4) * 0.08
  const since = position - glyph.time + 0.08
  const after = position - Math.max(glyph.time + glyph.duration, glyph.time + 0.15)
  const spring = since > 0 ? 1 - Math.exp(-10 * since) * (Math.cos(10 * since) + Math.sin(10 * since)) : 0
  let x = baseX + Math.sin(baseY) * 25 * (1 - spring)
  let y = baseY + Math.cos(baseX) * 18 * (1 - spring)
  let rotation = baseRotation + 12 * (1 - spring)
  let scale = 0.55 + (targetScale * 1.28 - 0.55) * spring
  let opacity = clamp01(since / 0.1)
  let blur = 6 * (1 - clamp01(since / 0.2))
  let glow = clamp01(since / 0.18)
  if (after > 0) {
    const settled = easeOut(after / 0.5)
    x = baseX
    y = baseY
    rotation = baseRotation + (random(seed + index * 7.13, 5) - 0.5) * 6 * clamp01(after / 5)
    scale = targetScale * (1.28 - 0.28 * settled)
    opacity = 1 - 0.25 * settled
    blur = 0
    glow = 1 - clamp01(after / 0.9)
  }
  return { x, y, rotation, scale, opacity, blur, glow }
}

/** A short, deterministic burst at the beginning of a sung word. */
export function rhythmSparkFrame(glyph: RhythmGlyph, position: number, seed: number, index: number, final = false) {
  if (!glyph.spark || !glyph.text.trim() || /^[\s\p{P}\p{S}]+$/u.test(glyph.text)) return null
  const age = position - glyph.time
  const lifetime = final ? 0.7 : 0.55
  if (age < 0 || age >= lifetime) return null
  const progress = clamp01(age / lifetime)
  return {
    opacity: (1 - progress) ** 2 * (final ? 0.9 : 0.75),
    scale: 0.45 + easeOut(progress) * (final ? 0.95 : 0.7),
    rotation: (random(seed + index * 7.13, 8) - 0.5) * 60,
  }
}
