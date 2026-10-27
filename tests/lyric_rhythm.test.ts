import { describe, expect, it } from 'bun:test'
import {
  buildRhythmPhrases,
  rhythmGlyphFrame,
  rhythmRowFrame,
  rhythmSparkFrame,
} from '../frontend/player/src/react/lyric_rhythm'

describe('immersive lyric rhythm', () => {
  it('uses word timestamps while preserving the original spaces', () => {
    const phrases = buildRhythmPhrases(
      {
        time: 1,
        text: '你好 世界',
        timedWords: [
          { text: '你好', time: 1, duration: 1 },
          { text: '世界', time: 2, duration: 0.6 },
        ],
      },
      4,
      10,
    )
    const glyphs = phrases.flatMap(phrase => phrase.glyphs)
    expect(glyphs.map(glyph => glyph.text).join('')).toBe('你好 世界')
    expect(glyphs.map(glyph => glyph.time)).toEqual([1, 1.5, 2, 2, 2.3])
    expect(glyphs[0]?.duration).toBe(0.5)
    expect(glyphs.map(glyph => Boolean(glyph.spark))).toEqual([true, false, false, true, false])
  })

  it('keeps original punctuation when the timed source omits it', () => {
    const phrases = buildRhythmPhrases(
      {
        time: 1,
        text: '你好，世界！',
        timedWords: [
          { text: '你好', time: 1, duration: 1 },
          { text: '世界', time: 2, duration: 1 },
        ],
      },
      4,
    )
    const glyphs = phrases.flatMap(phrase => phrase.glyphs)
    expect(glyphs.map(glyph => glyph.text).join('')).toBe('你好，世界！')
    expect(glyphs.find(glyph => glyph.text === '世')?.time).toBe(2)
    expect(glyphs.find(glyph => glyph.text === '界')?.time).toBe(2.5)
  })

  it('splits long sentences into bounded phrases without dropping text', () => {
    const text = '若是你愿望非所求又何妨看命运的玩笑总会散场'
    const phrases = buildRhythmPhrases({ time: 2, text }, 8)
    expect(phrases.length).toBeLessThanOrEqual(4)
    expect(phrases.map(phrase => phrase.glyphs.map(glyph => glyph.text).join('')).join('')).toBe(text)
    expect(phrases.every(phrase => phrase.glyphs.length > 0)).toBe(true)
  })

  it('keeps English words together and estimates timing for ordinary LRC', () => {
    const phrases = buildRhythmPhrases({ time: 2, text: 'hello world' }, 6)
    const glyphs = phrases.flatMap(phrase => phrase.glyphs)
    expect(phrases.map(phrase => phrase.glyphs.map(glyph => glyph.text).join(''))).toEqual(['hello world'])
    expect(glyphs[0]?.time).toBe(2)
    expect(glyphs.find(glyph => glyph.text === 'w')?.time).toBeGreaterThan(2)
    expect(glyphs.at(-1)!.time + glyphs.at(-1)!.duration).toBeLessThan(6)
  })

  it('reconstructs the same animation frame after pause or seek', () => {
    const glyph = { text: '歌', time: 2, duration: 0.4 }
    expect(rhythmGlyphFrame(glyph, 1.5, 2, 0).opacity).toBe(0)
    expect(rhythmGlyphFrame(glyph, 2.1, 2, 0).opacity).toBe(1)
    expect(rhythmGlyphFrame(glyph, 2.1, 2, 0)).toEqual(rhythmGlyphFrame(glyph, 2.1, 2, 0))
    expect(rhythmGlyphFrame(glyph, 3, 2, 0).scale).toBeLessThan(rhythmGlyphFrame(glyph, 2.1, 2, 0).scale)
    expect(rhythmRowFrame(2, 1.5, -1).opacity).toBe(0)
    expect(rhythmRowFrame(2, 2.2, -1).opacity).toBe(1)
  })

  it('shows a bounded spark only when a timed word begins', () => {
    const glyph = { text: '歌', time: 2, duration: 0.4, spark: true }
    expect(rhythmSparkFrame(glyph, 1.9, 2, 0)).toBeNull()
    const spark = rhythmSparkFrame(glyph, 2.2, 2, 0)
    expect(spark?.opacity).toBeGreaterThan(0)
    expect(spark).toEqual(rhythmSparkFrame(glyph, 2.2, 2, 0))
    expect(rhythmSparkFrame(glyph, 2.6, 2, 0)).toBeNull()
    expect(rhythmSparkFrame({ ...glyph, text: ' ' }, 2.2, 2, 0)).toBeNull()
    expect(rhythmSparkFrame({ ...glyph, spark: false }, 2.2, 2, 0)).toBeNull()
    expect(rhythmSparkFrame(glyph, 2.6, 2, 0, true)).not.toBeNull()
  })
})
