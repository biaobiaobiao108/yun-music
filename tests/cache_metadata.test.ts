import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectAudioContainer,
  detectDownloadSource,
  detectImageMime,
  detectQualityFromBitrate,
  getAudioMetadataUnsupportedStatus,
  hasUsableRemoteCover,
} from '@/server/cacheMetadata'

describe('cache metadata helpers', () => {
  test('detects supported image signatures and rejects unknown data', () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(detectImageMime(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(detectImageMime(Buffer.from('RIFF0000WEBP'))).toBe('image/webp')
    expect(detectImageMime(Buffer.from('BM'))).toBe('image/bmp')
    expect(detectImageMime(Buffer.from('not-an-image'))).toBeNull()
  })

  test('accepts real remote covers but rejects provider placeholders', () => {
    expect(hasUsableRemoteCover('https://img.example.test/cover.jpg')).toBe(true)
    expect(hasUsableRemoteCover('https://y.gtimg.cn/music/photo/T002R300x300M000.jpg')).toBe(false)
    expect(hasUsableRemoteCover('file:///tmp/cover.jpg')).toBe(false)
  })

  test('detects common audio containers and unsupported encrypted files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-cache-metadata-'))
    try {
      const fixtures = new Map<string, Buffer>([
        ['song.mp3', Buffer.from('ID3metadata')],
        ['song.flac', Buffer.from('fLaCmetadata')],
        ['song.ogg', Buffer.from('OggSmetadata')],
        ['song.wav', Buffer.from('RIFF0000WAVE')],
        ['song.m4a', Buffer.from('0000ftypM4A ')],
        ['song.ape', Buffer.from('MAC metadata')],
        ['song.bin', Buffer.from('{}')],
      ])
      for (const [filename, content] of fixtures) fs.writeFileSync(path.join(root, filename), content)

      expect(detectAudioContainer(path.join(root, 'song.mp3'))).toBe('mp3')
      expect(detectAudioContainer(path.join(root, 'song.flac'))).toBe('flac')
      expect(detectAudioContainer(path.join(root, 'song.ogg'))).toBe('ogg')
      expect(detectAudioContainer(path.join(root, 'song.wav'))).toBe('wav')
      expect(detectAudioContainer(path.join(root, 'song.m4a'))).toBe('mp4')
      expect(detectAudioContainer(path.join(root, 'song.ape'))).toBe('ape')
      expect(detectAudioContainer(path.join(root, 'song.bin'))).toBe('encrypted')
      expect(getAudioMetadataUnsupportedStatus(path.join(root, 'song.bin'))).toEqual({
        audioContainer: 'encrypted',
        metadataWritable: false,
        error: '音频为加密或非标准容器，无法写入封面和歌词标签',
      })
      expect(detectAudioContainer(path.join(root, 'missing.mp3'))).toBe('unknown')
    } finally {
      const relative = path.relative(os.tmpdir(), root)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup path')
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('recognizes download providers and keeps a fallback', () => {
    expect(detectDownloadSource('https://music.163.com/song/media/outer/url?id=1')).toBe('wy')
    expect(detectDownloadSource('https://stream.qqmusic.qq.com/song.flac')).toBe('tx')
    expect(detectDownloadSource('https://cdn.example.test/song.flac', 'custom')).toBe('custom')
    expect(detectDownloadSource('https://cdn.example.test/song.flac')).toBeUndefined()
  })

  test('derives quality from lossless metadata and lossy bitrate', () => {
    expect(detectQualityFromBitrate(900, '.flac')).toBe('flac')
    expect(detectQualityFromBitrate(1411, '.flac')).toBe('flac24bit')
    expect(detectQualityFromBitrate(4600, '.flac', { sampleRate: 192000 })).toBe('master')
    expect(detectQualityFromBitrate(320, '.mp3')).toBe('320k')
    expect(detectQualityFromBitrate(192, '.mp3')).toBe('192k')
    expect(detectQualityFromBitrate(128, '.mp3')).toBe('128k')
  })
})
