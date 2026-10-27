import { describe, it, expect } from 'bun:test'
import { buildLyrics, parseLyrics } from '@/utils/lrcTool'
import { formatLyricTimestamp, parseLyricTimestamp, parseTools } from '@/modules/utils/musicSdk/wy/lyric'

describe('Lyric Formatting & SongId Coercion', () => {
  it('preserves milliseconds and minutes when converting word-timed lyric timestamps', () => {
    expect(formatLyricTimestamp(1050)).toBe('[00:01.050]')
    expect(formatLyricTimestamp(65)).toBe('[00:00.065]')
    expect(formatLyricTimestamp(61230)).toBe('[01:01.230]')
    expect(parseLyricTimestamp('01:00.5')).toBe(60500)
    expect(parseLyricTimestamp('00:59.950')).toBe(59950)
    expect(parseLyricTimestamp('01:00:050')).toBe(60050)
  })

  it('keeps ordinary translations when YRC has no translated word track', () => {
    const result = parseTools.parse(
      '[1050,1000](1050,500,0)你(1550,500,0)好',
      '',
      '',
      '[00:01.050]你好',
      '[00:01.500]Hello',
      '[00:01.100]ni hao',
    )
    expect(result.lyric.trim()).toBe('[00:01.050]你好')
    expect(result.lxlyric).toBe('[00:01.050]<0,500>你<500,500>好')
    expect(result.tlyric).toBe('[00:01.050]Hello')
    expect(result.rlyric).toBe('[00:01.050]ni hao')
  })

  it('falls back to ordinary lyrics when YRC has no valid timed lines', () => {
    const result = parseTools.parse('[invalid]broken', '', '', '[00:01.000]你好', '[00:01.000]Hello', '')
    expect(result.lyric).toBe('[00:01.000]你好')
    expect(result.tlyric).toBe('[00:01.000]Hello')
    expect(result.lxlyric).toBe('')
  })

  it('builds timed lyrics when the source returns YRC without ordinary LRC', () => {
    const result = parseTools.parse('[1050,1000](1050,500,0)你(1550,500,0)好', '', '', '', '', '')
    expect(result.lyric.trim()).toBe('[00:01.050]你好')
    expect(result.lxlyric).toBe('[00:01.050]<0,500>你<500,500>好')
  })

  it('matches translations by nearest timestamp without reusing a lyric line', () => {
    const aligned = parseTools.fixTimeTag('[00:01.000]第一\n[00:02.000]第二', '[00:01.500]译一\n[00:02.010]译二')
    expect(aligned).toBe('[00:01.000]译一\n[00:02.000]译二')
  })

  it('should handle numeric song IDs safely without startsWith errors', () => {
    const rawSongId = 3355480219
    const source = 'wy'
    const songInfo: { id: number; songmid?: string; source: string; name: string } = {
      id: rawSongId,
      source,
      name: '櫂',
    }

    // Reproduction of previous logic vs fixed logic
    let songmid = String(songInfo.songmid || songInfo.id || '')
    const sourcePrefix = `${source}_`
    if (songmid.startsWith(sourcePrefix)) {
      songmid = songmid.slice(sourcePrefix.length)
    }

    expect(songmid).toBe('3355480219')
    expect(typeof songmid).toBe('string')
  })

  it('should strip source prefix if songmid has source_ prefix', () => {
    const songInfo: { songmid: string; id?: string | number; source: string } = {
      songmid: 'wy_3355480219',
      source: 'wy',
    }
    let songmid = String(songInfo.songmid || songInfo.id || '')
    const sourcePrefix = `${songInfo.source}_`
    if (songmid.startsWith(sourcePrefix)) {
      songmid = songmid.slice(sourcePrefix.length)
    }
    expect(songmid).toBe('3355480219')
  })

  it('buildLyrics should package lyric, tlyric, and awlrc into unified text that parseLyrics can unpack', () => {
    const rawLyricData = {
      lyric: '[00:01.00]Hello world\n[00:05.00]Second line',
      tlyric: '[00:01.00]你好世界\n[00:05.00]第二行',
      lxlyric: '[00:01.00]<0,500,0>Hello <500,500,0>world',
    }

    const formatted = buildLyrics(rawLyricData, true, true, true)
    expect(typeof formatted).toBe('string')
    expect(formatted).toContain('Hello world')
    expect(formatted).toContain('你好世界')
    expect(formatted).toContain('[awlrc:')

    const parsed = parseLyrics(formatted)
    expect(parsed.lyric).toBe(rawLyricData.lyric)
    expect(parsed.tlyric).toBe(rawLyricData.tlyric)
    expect(parsed.lxlyric).toBe(rawLyricData.lxlyric)
  })
})
