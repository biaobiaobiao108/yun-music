import { describe, it, expect } from 'bun:test'
import { buildLyrics, parseLyrics } from '@/utils/lrcTool'

describe('Lyric Formatting & SongId Coercion', () => {
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
