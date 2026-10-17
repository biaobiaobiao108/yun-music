import { describe, it, expect, spyOn } from 'bun:test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import * as networkSecurity from '../src/server/networkSecurity'
import { cleanupExpiredCacheProgress, resolveCompanionLyricFilename, setCacheProgress } from '../src/server/fileCache'
import { closeDb, initDatabase } from '../src/database'
import * as fileCache from '../src/server/fileCache'

describe('File Cache Path Traversal Defense', () => {
  const isSafePath = (baseDir: string, requestedRelativePath: string) => {
    // Normalization logic identical to serveCacheFile
    const safeFilename = requestedRelativePath.replace(/\\/g, '/')
    const normalizedBase = path.resolve(baseDir)
    const normalizedTarget = path.resolve(baseDir, safeFilename)
    return normalizedTarget === normalizedBase || normalizedTarget.startsWith(normalizedBase + path.sep)
  }

  const baseDir = path.resolve(process.cwd(), 'data/cache')

  it('should accept valid child paths within base directory', () => {
    expect(isSafePath(baseDir, 'user1/song.mp3')).toBe(true)
    expect(isSafePath(baseDir, 'sub/folder/file.flac')).toBe(true)
  })

  it('should reject path traversal attempts escaping base directory', () => {
    expect(isSafePath(baseDir, '../../package.json')).toBe(false)
    expect(isSafePath(baseDir, '..\\..\\config.js')).toBe(false)
    expect(isSafePath(baseDir, '/etc/passwd')).toBe(false)
    expect(isSafePath(baseDir, '..\\..\\..\\etc\\passwd')).toBe(false)
    if (process.platform === 'win32') {
      expect(isSafePath(baseDir, 'C:\\Windows\\System32\\calc.exe')).toBe(false)
    } else {
      expect(isSafePath(baseDir, '/var/log/syslog')).toBe(false)
    }
  })

  it('does not create legacy cache roots while checking an empty cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-root-probe-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(':memory:')
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)

      const result = fileCache.checkCache({
        source: 'wy',
        songmid: 'missing-song',
        name: 'Missing Song',
        singer: 'Missing Singer',
        quality: 'flac',
        exactQuality: true,
      }, 'probe-user')

      expect(result.exists).toBe(false)
      expect(fs.existsSync(path.join(dataPath, 'cache'))).toBe(false)
      expect(fs.existsSync(path.join(dataPath, 'music'))).toBe(false)
      expect(fileCache.getCacheDir('probe-user', false, fileCache.CACHE_ROOTS.DATA, false))
        .toBe(path.join(dataPath, 'cache', 'probe-user'))
      expect(fs.existsSync(path.join(dataPath, 'cache'))).toBe(false)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should find a companion lyric file even when the extension casing differs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-file-cache-'))
    try {
      fs.mkdirSync(path.join(root, 'albums'), { recursive: true })
      fs.writeFileSync(path.join(root, 'albums', 'song.FLAC'), Buffer.from('audio'))
      fs.writeFileSync(path.join(root, 'albums', 'song.LRC'), '[00:00.00]lyrics')

      expect(resolveCompanionLyricFilename(root, 'albums/song.FLAC')).toBe('albums/song.LRC')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should persist disk-discovered lyric state to the SQLite cache index', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-index-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const musicDir = fileCache.getCacheDir('test-user', true)
      fs.mkdirSync(path.join(musicDir, 'album'), { recursive: true })
      const audioFilename = 'album/song.flac'
      const lyricFilename = 'album/song.lrc'
      const audioPath = path.join(musicDir, audioFilename)
      fs.writeFileSync(audioPath, Buffer.from('not-a-real-audio-file'))
      fs.writeFileSync(path.join(musicDir, lyricFilename), '[00:00.00]lyrics')
      const stats = fs.statSync(audioPath)

      fileCache.indexManager.update('test-user', {
        id: 'wy_test-song',
        songmid: 'wy_test-song',
        name: 'Test Song',
        singer: 'Test Singer',
        albumName: 'Test Album',
        source: 'wy',
        quality: 'flac',
        filename: audioFilename,
        folder: 'music',
        mtime: stats.mtimeMs,
        size: stats.size,
        ext: 'flac',
        hasCover: false,
        coverType: 'none',
        hasLyric: false,
        coverCheckedVersion: 5,
        coverCheckedMtime: stats.mtimeMs,
        coverCheckedSize: stats.size,
        interval: '00:01',
        bitrate: 1000,
      }, 'music')

      const lyric = fileCache.checkLyricCache({
        source: 'wy',
        songmid: 'test-song',
        id: 'wy_test-song',
        name: 'Test Song',
        singer: 'Test Singer',
      }, 'test-user')
      expect(lyric.exists).toBe(true)

      await fileCache.syncCacheIndex('test-user', ['music'])
      const repaired = fileCache.indexManager.get('test-user', 'wy_test-song', 'music', 'flac', true)
      expect(repaired?.hasLyric).toBe(true)
      expect(repaired?.lyricFilename).toBe(lyricFilename)
      expect(repaired?.albumName).toBe('Test Album')
      expect('album' in (repaired ?? {})).toBe(false)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should save lyrics successfully before the audio file is indexed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-lyric-cache-before-audio-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const songInfo = {
        source: 'wy',
        songmid: '1869271',
        id: '1869271',
        name: 'We Will Rock You',
        singer: 'Queen',
        albumName: 'Queen Rocks',
        quality: 'flac',
      }
      const lyric = { lyric: '[00:00.00]We Will Rock You' }

      expect(fileCache.saveLyricCache(songInfo, lyric, 'test-user')).toBe(true)

      const cacheDir = fileCache.getCacheDir('test-user')
      const lyricPath = path.join(cacheDir, 'We Will Rock You - Queen - flac - Queen Rocks.lrc')
      expect(fs.existsSync(lyricPath)).toBe(true)
      expect(fs.readFileSync(lyricPath, 'utf8')).toContain('We Will Rock You')
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should clean up obsolete unknown lyric file when concrete quality lyric is saved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-lyric-unknown-cleanup-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'test-cleanup-user'
      const cacheDir = fileCache.getCacheDir(username)

      const baseSong = {
        source: 'wy',
        songmid: '1463165983',
        id: '1463165983',
        name: '花人局',
        singer: 'ヨルシカ',
        albumName: '盗作',
      }
      const lyric = { lyric: '[00:00.00]花人局' }

      // 1. First write an unknown quality lyric file
      expect(fileCache.saveLyricCache({ ...baseSong, quality: 'unknown' }, lyric, username)).toBe(true)
      const unknownLyricPath = path.join(cacheDir, '花人局 - ヨルシカ - unknown - 盗作.lrc')
      expect(fs.existsSync(unknownLyricPath)).toBe(true)

      // 2. Later save the concrete quality lyric file (e.g. flac)
      expect(fileCache.saveLyricCache({ ...baseSong, quality: 'flac' }, lyric, username)).toBe(true)
      const concreteLyricPath = path.join(cacheDir, '花人局 - ヨルシカ - flac - 盗作.lrc')
      expect(fs.existsSync(concreteLyricPath)).toBe(true)

      // 3. The obsolete unknown lyric file must have been cleaned up automatically
      expect(fs.existsSync(unknownLyricPath)).toBe(false)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should return valid url and path on collision checkCache match', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-collision-check-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'test-collision-user'
      const cacheDir = fileCache.getCacheDir(username, false)
      const audioFile = path.join(cacheDir, 'song.flac')
      fs.writeFileSync(audioFile, Buffer.from('audio'))

      fileCache.indexManager.update(username, {
        id: 'wy_111',
        songmid: '111',
        name: 'Collision Song',
        singer: 'Collision Singer',
        albumName: 'Collision Album',
        source: 'wy',
        quality: 'flac',
        filename: 'song.flac',
        folder: 'cache',
        mtime: Date.now(),
        size: 100,
        ext: 'flac',
      }, 'cache')

      // Query with same name, singer, quality but DIFFERENT id/source
      const res: any = fileCache.checkCache({
        source: 'tx',
        songmid: '222',
        id: 'tx_222',
        name: 'Collision Song',
        singer: 'Collision Singer',
        quality: 'flac',
      }, username)

      expect(res.exists).toBe(true)
      expect(res.isCollision).toBe(true)
      expect(res.filename).toBe('song.flac')
      expect(res.url).toContain('/api/music/cache/file/')
      expect(res.path).toBe(audioFile)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should find a cache entry through compatible song ID fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-id-alias-cache-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'id-alias-user'
      const cacheDir = fileCache.getCacheDir(username)
      const filename = 'id-alias-song.flac'
      fs.writeFileSync(path.join(cacheDir, filename), Buffer.from('cached audio'))
      fileCache.indexManager.update(username, {
        id: 'wy_canonical-id',
        songmid: 'wy_canonical-id',
        name: 'ID Alias Song',
        singer: 'ID Alias Singer',
        albumName: 'ID Alias Album',
        source: 'wy',
        quality: 'flac',
        filename,
        folder: 'cache',
        mtime: Date.now(),
        size: 12,
        ext: 'flac',
      }, 'cache')

      const result: any = fileCache.checkCache({
        source: 'wy',
        songmid: 'not-the-indexed-value',
        songId: 'canonical-id',
        id: 'wy_canonical-id',
        name: 'ID Alias Song',
        singer: 'ID Alias Singer',
        albumName: 'ID Alias Album',
        quality: 'flac',
        exactQuality: true,
      }, username)

      expect(result.exists).toBe(true)
      expect(result.isCollision).toBeUndefined()
      expect(result.filename).toBe(filename)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should accept a same-source metadata alias but keep cross-source collisions guarded', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-source-alias-cache-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'source-alias-user'
      const cacheDir = fileCache.getCacheDir(username)
      const filename = 'source-alias-song.flac'
      fs.writeFileSync(path.join(cacheDir, filename), Buffer.from('cached audio'))
      fileCache.indexManager.update(username, {
        id: 'wy_indexed-id',
        songmid: 'wy_indexed-id',
        name: 'Source Alias Song',
        singer: 'Source Alias Singer',
        albumName: 'Source Alias Album',
        interval: '03:21',
        source: 'wy',
        quality: 'flac',
        filename,
        folder: 'cache',
        mtime: Date.now(),
        size: 12,
        ext: 'flac',
      }, 'cache')

      const sameSource: any = fileCache.checkCache({
        source: 'wy',
        songmid: 'another-id',
        name: 'Source Alias Song',
        singer: 'Source Alias Singer',
        albumName: 'Source Alias Album',
        interval: '03:21',
        quality: 'flac',
        exactQuality: true,
      }, username)
      expect(sameSource.exists).toBe(true)
      expect(sameSource.isCollision).toBe(false)
      expect(sameSource.matchedBy).toBe('metadata')

      const otherSource: any = fileCache.checkCache({
        source: 'tx',
        songmid: 'different-source-id',
        name: 'Source Alias Song',
        singer: 'Source Alias Singer',
        albumName: 'Source Alias Album',
        interval: '03:21',
        quality: 'flac',
        exactQuality: true,
      }, username)
      expect(otherSource.exists).toBe(true)
      expect(otherSource.isCollision).toBe(true)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should find indexed audio in the alternate cache root and record playback there', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-alternate-root-'))
    const previousCwd = process.cwd()
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    const username = 'alternate-root-user'
    const filename = 'alternate-song.mp3'
    try {
      process.chdir(root)
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const rootCacheDir = fileCache.getCacheDir(username, false, fileCache.CACHE_ROOTS.ROOT)
      const audioPath = path.join(rootCacheDir, filename)
      fs.writeFileSync(audioPath, Buffer.from('cached audio'))
      fileCache.indexManager.update(username, {
        id: 'wy_alternate-song',
        songmid: 'alternate-song',
        name: 'Alternate Song',
        singer: 'Alternate Singer',
        albumName: 'Alternate Album',
        source: 'wy',
        quality: 'flac',
        filename,
        folder: 'cache',
        mtime: Date.now(),
        size: 12,
        ext: 'mp3',
      }, 'cache', fileCache.CACHE_ROOTS.ROOT)

      const result: any = fileCache.checkCache({
        source: 'wy',
        songmid: 'alternate-song',
        id: 'alternate-song',
        name: 'Alternate Song',
        singer: 'Alternate Singer',
        quality: 'flac',
      }, username)
      expect(result.exists).toBe(true)
      expect(result.path).toBe(audioPath)
      expect(result.location).toBe(fileCache.CACHE_ROOTS.ROOT)

      expect(fileCache.markCachePlayback(filename, username, 'cache', result.location)).toBe(true)
      const updated = fileCache.indexManager.get(username, 'wy_alternate-song', 'cache', 'flac', true, fileCache.CACHE_ROOTS.ROOT)
      expect(updated?.lastPlayedAt).toBeGreaterThan(0)
      expect(fileCache.indexManager.get(username, 'wy_alternate-song', 'cache', 'flac', true, fileCache.CACHE_ROOTS.DATA)?.lastPlayedAt).toBeUndefined()
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      process.chdir(previousCwd)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should ignore an empty indexed cache file during playback lookup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-empty-cache-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'empty-cache-user'
      const cacheDir = fileCache.getCacheDir(username)
      const filename = 'empty-song.mp3'
      fs.writeFileSync(path.join(cacheDir, filename), '')
      fileCache.indexManager.update(username, {
        id: 'wy_empty-song',
        songmid: 'empty-song',
        name: 'Empty Song',
        singer: 'Empty Singer',
        albumName: '',
        source: 'wy',
        quality: '320k',
        filename,
        folder: 'cache',
        mtime: Date.now(),
        size: 0,
        ext: 'mp3',
      }, 'cache')

      const result: any = fileCache.checkCache({
        source: 'wy',
        songmid: 'empty-song',
        id: 'empty-song',
        name: 'Empty Song',
        singer: 'Empty Singer',
        quality: '320k',
        exactQuality: true,
      }, username)
      expect(result.exists).toBe(false)
      expect(fileCache.indexManager.get(username, 'wy_empty-song', 'cache', '320k', true)).toBeUndefined()
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should hide a cache entry and block moves while queue post-processing mutates the file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-processing-cache-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    const username = 'processing-cache-user'
    const songInfo = {
      source: 'wy',
      songmid: 'processing-song',
      id: 'processing-song',
      name: 'Processing Song',
      singer: 'Processing Singer',
      albumName: 'Processing Album',
      quality: 'flac',
    }
    let unbind = () => {}
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const cacheDir = fileCache.getCacheDir(username)
      const filename = 'processing-song.flac'
      const audioPath = path.join(cacheDir, filename)
      fs.writeFileSync(audioPath, Buffer.from('valid-enough-audio'))
      const stats = fs.statSync(audioPath)
      fileCache.indexManager.update(username, {
        id: 'wy_processing-song',
        songmid: 'processing-song',
        name: songInfo.name,
        singer: songInfo.singer,
        albumName: songInfo.albumName,
        source: songInfo.source,
        quality: 'flac',
        filename,
        folder: 'cache',
        mtime: stats.mtimeMs,
        size: stats.size,
        ext: 'flac',
      }, 'cache')

      const progressKey = 'queue:processing-cache-user:test-task'
      unbind = fileCache.bindCacheProgress(username, fileCache.normalizeSongId(songInfo), 'flac', progressKey)
      setCacheProgress(progressKey, { progress: 100, status: 'tagging' })
      expect(fileCache.checkCache({ ...songInfo, exactQuality: true }, username).exists).toBe(false)
      expect(fileCache.checkCache({ ...songInfo, quality: '320k', exactQuality: false }, username).exists).toBe(false)
      expect(fileCache.checkCache({ ...songInfo, exactQuality: true }, username, false, { ignoreActiveProgress: true }).exists).toBe(true)
      expect((await fileCache.switchFolder([filename], username, 'music')).failCount).toBe(1)
      expect((await fileCache.promoteCacheFile(filename, username, 'other-user')).failCount).toBe(1)

      setCacheProgress(progressKey, { progress: 100, status: 'finished' })
      expect(fileCache.checkCache({ ...songInfo, exactQuality: true }, username).exists).toBe(true)
    } finally {
      unbind()
      fileCache.cacheProgress.delete('queue:processing-cache-user:test-task')
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should remove SQLite index rows when cached files are deleted from disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-index-delete-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const musicDir = fileCache.getCacheDir('test-user', true)
      const audioFilename = 'album/song.flac'
      const audioPath = path.join(musicDir, audioFilename)
      fs.mkdirSync(path.dirname(audioPath), { recursive: true })
      fs.writeFileSync(audioPath, Buffer.from('audio'))
      const stats = fs.statSync(audioPath)
      const item = {
        id: 'wy_deleted-song',
        songmid: 'wy_deleted-song',
        name: 'Deleted Song',
        singer: 'Test Singer',
        albumName: 'Test Album',
        source: 'wy',
        quality: 'flac',
        filename: audioFilename,
        folder: 'music',
        mtime: stats.mtimeMs,
        size: stats.size,
        ext: 'flac',
        hasCover: false,
        coverType: 'none' as const,
        hasLyric: false,
        hasEmbedLyric: true,
        metadataWritable: true,
        audioContainer: 'flac',
        coverCheckedVersion: 5,
        coverCheckedMtime: stats.mtimeMs,
        coverCheckedSize: stats.size,
        interval: '00:01',
        bitrate: 1000,
      }
      fileCache.indexManager.update('test-user', item, 'music')

      await fileCache.syncCacheIndex('test-user', ['music'])
      expect(fileCache.indexManager.get('test-user', item.id, 'music', item.quality, true)).toBeDefined()

      fs.unlinkSync(audioPath)
      await fileCache.syncCacheIndex('test-user', ['music'])
      expect(fileCache.indexManager.get('test-user', item.id, 'music', item.quality, true)).toBeUndefined()
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should clear nested cache files and their SQLite index rows together', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-clear-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const musicDir = fileCache.getCacheDir('test-user', true)
      const audioFilename = 'nested/song.mp3'
      const audioPath = path.join(musicDir, audioFilename)
      fs.mkdirSync(path.dirname(audioPath), { recursive: true })
      fs.writeFileSync(audioPath, Buffer.from('audio'))
      fs.writeFileSync(path.join(musicDir, 'nested/song.lrc'), '[00:00.00]lyrics')
      fileCache.indexManager.update('test-user', {
        id: 'wy_clear-song',
        songmid: 'wy_clear-song',
        name: 'Clear Song',
        singer: 'Test Singer',
        albumName: 'Test Album',
        source: 'wy',
        quality: 'mp3',
        filename: audioFilename,
        folder: 'music',
        mtime: Date.now(),
        size: 5,
        ext: 'mp3',
        hasCover: false,
        coverType: 'none',
        hasLyric: true,
        lyricFilename: 'nested/song.lrc',
      }, 'music')

      const result = fileCache.clearAllCache('test-user')
      expect(result.deletedCount).toBe(2)
      expect(fs.existsSync(audioPath)).toBe(false)
      expect(fileCache.indexManager.getAll('test-user', 'music')).toEqual([])
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should clear both cache roots and per-user cover files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-cover-clear-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'cover-clear-user'
      const cacheDir = fileCache.getCacheDir(username, false, fileCache.CACHE_ROOTS.DATA)
      const audioPath = path.join(cacheDir, 'song.mp3')
      fs.writeFileSync(audioPath, Buffer.from('audio'))
      const legacyCacheDir = fileCache.getCacheDir(username, false, fileCache.CACHE_ROOTS.ROOT)
      const legacyAudioPath = path.join(legacyCacheDir, 'legacy.mp3')
      fs.writeFileSync(legacyAudioPath, Buffer.from('legacy'))
      const coverDir = path.join(dataPath, 'cover_cache', username)
      fs.mkdirSync(coverDir, { recursive: true })
      fs.writeFileSync(path.join(coverDir, 'orphan.bin'), Buffer.from('cover'))

      const result = fileCache.clearAllCache(username)
      expect(result.deletedCount).toBe(3)
      expect(fs.existsSync(audioPath)).toBe(false)
      expect(fs.existsSync(legacyAudioPath)).toBe(false)
      expect(fs.existsSync(coverDir)).toBe(false)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(path.join(process.cwd(), 'cache', 'cover-clear-user'), { recursive: true, force: true })
    }
  })

  it('should move and delete all disposable cache data during account lifecycle changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-lifecycle-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const oldUsername = 'cache-old-user'
      const newUsername = 'cache-new-user'
      const oldCacheDir = fileCache.getCacheDir(oldUsername)
      const oldMusicDir = fileCache.getCacheDir(oldUsername, true)
      fs.writeFileSync(path.join(oldCacheDir, 'cached.mp3'), Buffer.from('cache'))
      fs.writeFileSync(path.join(oldMusicDir, 'downloaded.flac'), Buffer.from('music'))
      const oldCoverDir = path.join(dataPath, 'cover_cache', oldUsername)
      fs.mkdirSync(oldCoverDir, { recursive: true })
      fs.writeFileSync(path.join(oldCoverDir, 'cover.bin'), Buffer.from('cover'))

      expect(fileCache.moveUserCacheData(oldUsername, newUsername).movedDirectories).toBe(3)
      expect(fs.existsSync(path.join(dataPath, 'cache', oldUsername))).toBe(false)
      expect(fs.existsSync(path.join(dataPath, 'cache', newUsername, 'cached.mp3'))).toBe(true)
      expect(fs.existsSync(path.join(dataPath, 'music', newUsername, 'downloaded.flac'))).toBe(true)
      expect(fs.existsSync(path.join(dataPath, 'cover_cache', newUsername, 'cover.bin'))).toBe(true)

      fileCache.deleteUserCacheData(newUsername)
      expect(fs.existsSync(path.join(dataPath, 'cache', newUsername))).toBe(false)
      expect(fs.existsSync(path.join(dataPath, 'music', newUsername))).toBe(false)
      expect(fs.existsSync(path.join(dataPath, 'cover_cache', newUsername))).toBe(false)
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(path.join(process.cwd(), 'cache', 'cache-old-user'), { recursive: true, force: true })
      fs.rmSync(path.join(process.cwd(), 'cache', 'cache-new-user'), { recursive: true, force: true })
      fs.rmSync(path.join(process.cwd(), 'music', 'cache-old-user'), { recursive: true, force: true })
      fs.rmSync(path.join(process.cwd(), 'music', 'cache-new-user'), { recursive: true, force: true })
      fs.rmSync(path.join(process.cwd(), 'cover_cache', 'cache-old-user'), { recursive: true, force: true })
      fs.rmSync(path.join(process.cwd(), 'cover_cache', 'cache-new-user'), { recursive: true, force: true })
    }
  })

  it('should promote a public cache into a user download without removing the shared file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-promote-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const sourceDir = fileCache.getCacheDir('_open', false)
      const sourceFile = path.join(sourceDir, 'public-song.mp3')
      const sourceLyric = path.join(sourceDir, 'public-song.lrc')
      fs.writeFileSync(sourceFile, Buffer.from('public-audio'))
      fs.writeFileSync(sourceLyric, '[00:00.00]public lyric')
      const stats = fs.statSync(sourceFile)
      fileCache.indexManager.update('_open', {
        id: 'wy_public-song',
        songmid: 'public-song',
        name: 'Public Song',
        singer: 'Public Singer',
        albumName: 'Public Album',
        source: 'wy',
        quality: '128k',
        filename: 'public-song.mp3',
        lyricFilename: 'public-song.lrc',
        folder: 'cache',
        mtime: stats.mtimeMs,
        size: stats.size,
        ext: 'mp3',
      }, 'cache')

      const result = await fileCache.promoteCacheFile('public-song.mp3', '_open', 'promote-user')
      expect(result.successCount).toBe(1)
      expect(fs.existsSync(sourceFile)).toBe(true)
      expect(fs.existsSync(path.join(fileCache.getCacheDir('promote-user', true), 'public-song.mp3'))).toBe(true)
      expect(fs.existsSync(path.join(fileCache.getCacheDir('promote-user', true), 'public-song.lrc'))).toBe(true)
      expect(fileCache.indexManager.get('promote-user', 'wy_public-song', 'music', '128k', false, fileCache.CACHE_ROOTS.DATA)?.folder).toBe('music')
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should move a private cache into the download folder without duplicating audio', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-move-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'move-user'
      const cacheDir = fileCache.getCacheDir(username, false)
      const cacheFile = path.join(cacheDir, 'move-song.mp3')
      fs.writeFileSync(cacheFile, Buffer.from('private-audio'))
      const stats = fs.statSync(cacheFile)
      fileCache.indexManager.update(username, {
        id: 'wy_move-song',
        songmid: 'move-song',
        name: 'Move Song',
        singer: 'Move Singer',
        albumName: 'Move Album',
        source: 'wy',
        quality: '128k',
        filename: 'move-song.mp3',
        folder: 'cache',
        mtime: stats.mtimeMs,
        size: stats.size,
        ext: 'mp3',
      }, 'cache')

      await fileCache.downloadAndCache({
        id: 'move-song',
        songmid: 'move-song',
        name: 'Move Song',
        singer: 'Move Singer',
        albumName: 'Move Album',
        source: 'wy',
      }, 'http://127.0.0.1/move-song.mp3', '128k', username, undefined, true)

      expect(fs.existsSync(cacheFile)).toBe(false)
      expect(fs.existsSync(path.join(fileCache.getCacheDir(username, true), 'move-song.mp3'))).toBe(true)
      expect(fileCache.indexManager.get(username, 'wy_move-song', 'cache', '128k', true, fileCache.CACHE_ROOTS.DATA)).toBeUndefined()
      expect(fileCache.indexManager.get(username, 'wy_move-song', 'music', '128k', true, fileCache.CACHE_ROOTS.DATA)?.folder).toBe('music')
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should clean an old private cache duplicate when the download already exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-deduplicate-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = { dataPath, config: {} }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'deduplicate-user'
      const cacheDir = fileCache.getCacheDir(username, false)
      const musicDir = fileCache.getCacheDir(username, true)
      const filename = 'same-song.mp3'
      fs.writeFileSync(path.join(cacheDir, filename), Buffer.from('old-cache'))
      fs.writeFileSync(path.join(musicDir, filename), Buffer.from('downloaded'))
      const cacheStats = fs.statSync(path.join(cacheDir, filename))
      const musicStats = fs.statSync(path.join(musicDir, filename))
      const item = {
        id: 'wy_same-song', songmid: 'same-song', name: 'Same Song', singer: 'Same Singer',
        albumName: 'Same Album', source: 'wy', quality: 'flac', filename, ext: 'mp3',
        folder: 'cache' as const, mtime: cacheStats.mtimeMs, size: cacheStats.size,
      }
      fileCache.indexManager.update(username, item, 'cache')
      fileCache.indexManager.update(username, { ...item, folder: 'music', mtime: musicStats.mtimeMs, size: musicStats.size }, 'music')

      const result = await fileCache.switchFolder([filename], username, 'music')

      expect(result.successCount).toBe(1)
      expect(fs.existsSync(path.join(cacheDir, filename))).toBe(false)
      expect(fs.readFileSync(path.join(musicDir, filename), 'utf8')).toBe('downloaded')
      expect(fileCache.indexManager.get(username, 'wy_same-song', 'cache', 'flac', true, fileCache.CACHE_ROOTS.DATA)).toBeUndefined()
      expect(fileCache.indexManager.get(username, 'wy_same-song', 'music', 'flac', true, fileCache.CACHE_ROOTS.DATA)?.folder).toBe('music')
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should clean up only cache directory and preserve music directory when limit exceeded', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-cleanup-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = {
        dataPath,
        config: {
          'user.enableCacheSizeLimit': true,
          'user.cacheSizeLimit': 0.001, // 0.001 MB = ~1048 bytes
        },
      }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'test-cleanup-user'
      const cacheDir = fileCache.getCacheDir(username, false)
      const musicDir = fileCache.getCacheDir(username, true)

      // 1. Create a file in music directory that would exceed the limit if counted
      const musicFile = path.join(musicDir, 'downloaded.mp3')
      fs.writeFileSync(musicFile, Buffer.alloc(5000, 1))

      // 2. Create 2 files in cache directory: old (1500 bytes) and new (1500 bytes)
      const oldCacheFile = path.join(cacheDir, 'old_cache.mp3')
      const newCacheFile = path.join(cacheDir, 'new_cache.mp3')
      fs.writeFileSync(oldCacheFile, Buffer.alloc(1500, 2))
      const past = new Date(Date.now() - 100000)
      fs.utimesSync(oldCacheFile, past, past)

      fs.writeFileSync(newCacheFile, Buffer.alloc(1500, 3))

      fileCache.indexManager.update(username, {
        id: 'wy_old',
        name: 'Old',
        singer: 'Singer',
        albumName: 'Album',
        source: 'wy',
        quality: '128k',
        filename: 'old_cache.mp3',
        folder: 'cache',
        mtime: past.getTime(),
        size: 1500,
        ext: 'mp3',
      }, 'cache')

      fileCache.indexManager.update(username, {
        id: 'wy_new',
        name: 'New',
        singer: 'Singer',
        albumName: 'Album',
        source: 'wy',
        quality: '128k',
        filename: 'new_cache.mp3',
        folder: 'cache',
        mtime: Date.now(),
        size: 1500,
        ext: 'mp3',
      }, 'cache')

      // Run cleanup
      await fileCache.checkAndCleanupCache(username)

      // music directory file must be completely untouched
      expect(fs.existsSync(musicFile)).toBe(true)

      // oldest cache file should be deleted to satisfy the limit
      expect(fs.existsSync(oldCacheFile)).toBe(false)
      expect(fileCache.indexManager.get(username, 'wy_old', 'cache')).toBeUndefined()
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('should evict the least recently played cache entry instead of the oldest mtime', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-lru-cleanup-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = {
        dataPath,
        config: {
          'user.enableCacheSizeLimit': true,
          'user.cacheSizeLimit': 0.001,
        },
      }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const username = 'test-lru-user'
      const cacheDir = fileCache.getCacheDir(username, false)
      const recentlyPlayedFile = path.join(cacheDir, 'recently_played.mp3')
      const leastRecentlyPlayedFile = path.join(cacheDir, 'least_recently_played.mp3')
      fs.writeFileSync(recentlyPlayedFile, Buffer.alloc(600, 1))
      fs.writeFileSync(leastRecentlyPlayedFile, Buffer.alloc(600, 2))

      // 故意让最近播放的文件 mtime 更早，验证清理依据确实是播放时间而非 mtime。
      const oldMtime = new Date(Date.now() - 100000)
      fs.utimesSync(recentlyPlayedFile, oldMtime, oldMtime)

      const baseItem = {
        name: 'Test',
        singer: 'Singer',
        albumName: 'Album',
        source: 'wy',
        quality: '128k',
        folder: 'cache' as const,
        mtime: Date.now(),
        size: 600,
        ext: 'mp3',
      }
      fileCache.indexManager.update(username, {
        ...baseItem,
        id: 'wy_recent',
        filename: 'recently_played.mp3',
      }, 'cache')
      fileCache.indexManager.update(username, {
        ...baseItem,
        id: 'wy_stale',
        filename: 'least_recently_played.mp3',
        lastPlayedAt: Date.now() - 100000,
      }, 'cache')

      expect(fileCache.markCachePlayback('recently_played.mp3', username, 'cache')).toBe(true)

      await fileCache.checkAndCleanupCache(username)

      expect(fs.existsSync(leastRecentlyPlayedFile)).toBe(false)
      expect(fs.existsSync(recentlyPlayedFile)).toBe(true)
      expect(fileCache.indexManager.get(username, 'wy_stale', 'cache')).toBeUndefined()
      expect(fileCache.indexManager.get(username, 'wy_recent', 'cache')).toBeDefined()
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('File Cache Progress Lifecycle', () => {
  it('expires terminal progress entries through one bounded cleanup path', () => {
    const now = Date.now()
    const finishedKey = `finished-${now}`
    const activeKey = `active-${now}`
    setCacheProgress(finishedKey, { progress: 100, status: 'finished', updatedAt: now - 31_000 })
    setCacheProgress(activeKey, { progress: 45, status: 'downloading', updatedAt: now - 31_000 })

    expect(cleanupExpiredCacheProgress(now)).toBe(1)
    expect(fileCache.cacheProgress.has(finishedKey)).toBe(false)
    expect(fileCache.cacheProgress.has(activeKey)).toBe(true)

    fileCache.cacheProgress.delete(activeKey)
  })

  it('eventually removes stale active progress left by an interrupted worker', () => {
    const now = Date.now()
    const staleActiveKey = `stale-active-${now}`
    setCacheProgress(staleActiveKey, { progress: 12, status: 'downloading', updatedAt: now - 10 * 60 * 1000 - 1 })

    expect(cleanupExpiredCacheProgress(now)).toBe(1)
    expect(fileCache.cacheProgress.has(staleActiveKey)).toBe(false)
  })
})

describe('File Cache Post-processing Limiter', () => {
  it('reuses validated cover metadata until the physical audio file changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cover-state-reuse-'))
    const previousLx = global.lx
    const song = { source: 'wy', songmid: 'cover-state', name: 'Cover State', singer: 'Singer' }
    try {
      closeDb()
      global.lx = { appPath: root, dataPath: path.join(root, 'data'), config: {} } as any
      initDatabase(':memory:')
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)
      const file = path.join(fileCache.getCacheDir('cover-owner'), 'cover-state.mp3')
      fs.writeFileSync(file, Buffer.alloc(128))
      const stats = fs.statSync(file)
      fileCache.indexManager.update('cover-owner', {
        id: 'wy_cover-state', name: song.name, singer: song.singer, albumName: '', source: 'wy',
        quality: '320k', filename: 'cover-state.mp3', folder: 'cache', mtime: stats.mtimeMs,
        size: stats.size, ext: 'mp3', hasCover: true, coverType: 'embedded', coverCheckedVersion: 5,
        coverCheckedMtime: stats.mtimeMs, coverCheckedSize: stats.size,
      }, 'cache')
      // The existing validated state must survive without parsing this dummy
      // audio again. A changed file must invalidate that same state.
      await fileCache.downloadAndCache(song, '', '320k', 'cover-owner', undefined, false, false, false)
      expect(fileCache.indexManager.get('cover-owner', 'wy_cover-state', 'cache', '320k', true)?.coverType).toBe('embedded')
      fs.writeFileSync(file, Buffer.alloc(129))
      await fileCache.downloadAndCache(song, '', '320k', 'cover-owner', undefined, false, false, false)
      expect(fileCache.indexManager.get('cover-owner', 'wy_cover-state', 'cache', '320k', true)?.coverType).toBe('none')
    } finally {
      closeDb()
      global.lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('keeps an aborted download alive until lyric enrichment exits and never writes late lyrics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-abort-enrichment-'))
    const previousLx = global.lx
    const previousFetcher = fileCache.getLyricFetcher()
    const controller = new AbortController()
    let finishLyric!: (value: string) => void
    let lyricStarted!: () => void
    const started = new Promise<void>(resolve => { lyricStarted = resolve })
    const lyric = new Promise<string>(resolve => { finishLyric = resolve })
    const safeUrl = spyOn(networkSecurity, 'assertSafeRemoteHttpUrl').mockResolvedValue(new URL('http://example.com/audio') as any)
    const request = spyOn(http, 'get').mockImplementation(((_url: any, _options: any, callback: any) => {
      const req = new EventEmitter() as any
      req.setTimeout = () => req
      req.destroy = () => req
      queueMicrotask(() => {
        const response = Readable.from([Buffer.alloc(1024)]) as any
        response.statusCode = 200
        response.headers = { 'content-length': '1024', 'content-type': 'audio/mpeg' }
        callback(response)
      })
      return req
    }) as any)
    let completion: Promise<unknown> | undefined
    try {
      closeDb()
      global.lx = { appPath: root, dataPath: path.join(root, 'data'), config: {} } as any
      initDatabase(':memory:')
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)
      fileCache.setLyricFetcher(async (_song, signal) => {
        expect(signal).toBe(controller.signal)
        lyricStarted()
        return lyric
      })
      let settled = false
      completion = fileCache.downloadAndCache({ source: 'wy', songmid: 'abort-song', name: 'Abort Song', singer: 'Singer' },
        'http://example.com/audio', '320k', 'abort-user', controller.signal, false, true, false)
        .then(() => { settled = true; return null }, error => { settled = true; return error })
      await started
      controller.abort()
      await Bun.sleep(5)
      expect(settled).toBe(false)
      expect(fileCache.getCachePostProcessStats().active).toBe(1)
      finishLyric('[00:00.00]late lyrics')
      expect((await completion as Error).message).toBe('Aborted')
      expect(fileCache.getCachePostProcessStats()).toEqual({ active: 0, waiting: 0 })
      const cacheDir = fileCache.getCacheDir('abort-user', false, undefined, false)
      expect(fs.readdirSync(cacheDir).some(file => file.endsWith('.lrc'))).toBe(false)

      let releaseHeld!: () => void
      const held = fileCache.withCachePostProcess(undefined, 'test held slot', () => new Promise<void>(resolve => { releaseHeld = resolve }))
      await Bun.sleep(0)
      const waitingController = new AbortController()
      const waiting = fileCache.downloadAndCache({ source: 'wy', songmid: 'waiting-song', name: 'Waiting Song', singer: 'Singer' },
        'http://example.com/audio', '320k', 'abort-user', waitingController.signal, false, false, false).catch(error => error)
      try {
        const deadline = Date.now() + 1000
        while (fileCache.getCachePostProcessStats().waiting === 0 && Date.now() < deadline) await Bun.sleep(2)
        expect(fileCache.getCachePostProcessStats().waiting).toBe(1)
        waitingController.abort()
        expect((await waiting as Error).message).toBe('Aborted')
        expect(fileCache.getCachePostProcessStats()).toEqual({ active: 1, waiting: 0 })
      } finally {
        releaseHeld()
        await held
        await waiting
      }
    } finally {
      finishLyric?.('')
      await completion
      request.mockRestore()
      safeUrl.mockRestore()
      fileCache.setLyricFetcher(previousFetcher as any)
      closeDb()
      global.lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('resolves opaque queue progress keys only for their owning user', () => {
    const key = 'queue:progress-owner:task'
    const unbind = fileCache.bindCacheProgress('progress-owner', 'wy_progress', '320k', key)
    try {
      setCacheProgress(key, { progress: 100, status: 'tagging' })
      expect(fileCache.isCacheEntryProcessing('wy_progress', '320k', 'progress-owner')).toBe(true)
      expect(fileCache.isCacheEntryProcessing('wy_progress', '320k', 'other-user')).toBe(false)
      expect(fileCache.isCacheEntryProcessing('wy_progress', 'flac', 'progress-owner')).toBe(false)
      unbind()
      expect(fileCache.isCacheEntryProcessing('wy_progress', '320k', 'progress-owner')).toBe(false)
    } finally {
      unbind()
      fileCache.cacheProgress.delete(key)
    }
  })
  it('serializes heavy post-processing and releases the slot after failures', async () => {
    let active = 0
    let maxActive = 0
    const run = (name: string, shouldFail = false) => fileCache.withCachePostProcess(undefined, name, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
      if (shouldFail) throw new Error('expected failure')
      return name
    })

    const results = await Promise.all([run('first'), run('second')])

    expect(results).toEqual(['first', 'second'])
    expect(maxActive).toBe(1)
    expect(fileCache.getCachePostProcessStats()).toEqual({ active: 0, waiting: 0 })

    await expect(run('failed', true)).rejects.toThrow('expected failure')
    expect(fileCache.getCachePostProcessStats()).toEqual({ active: 0, waiting: 0 })
  })
})

describe('Global Cache Stats and Audio-only Cache Cleanup', () => {
  it('returns oversized index results without retaining them or deleting persistent records', () => {
    const previousLx = global.lx
    try {
      closeDb()
      global.lx = { dataPath: os.tmpdir(), config: {} } as any
      initDatabase(':memory:')
      fileCache.indexManager.update('oversized-index-user', {
        id: 'wy_large-index', name: 'x'.repeat(4 * 1024 * 1024), singer: 'Singer', albumName: '', source: 'wy',
        quality: '320k', filename: 'large.mp3', folder: 'cache', mtime: 1, size: 1, ext: 'mp3',
      }, 'cache')
      const first = fileCache.indexManager.getAll('oversized-index-user', 'cache')
      const second = fileCache.indexManager.getAll('oversized-index-user', 'cache')
      expect(first.length).toBe(1)
      expect(second.length).toBe(1)
      expect(first).not.toBe(second)
      const firstItem = fileCache.indexManager.get('oversized-index-user', 'wy_large-index', 'cache', '320k', true)
      const secondItem = fileCache.indexManager.get('oversized-index-user', 'wy_large-index', 'cache', '320k', true)
      expect(firstItem?.name.length).toBe(4 * 1024 * 1024)
      expect(firstItem).not.toBe(secondItem)
      const stats = fileCache.indexManager.getMemoryStats()
      expect(stats.items.bytes + stats.lists.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
    } finally {
      closeDb()
      global.lx = previousLx
    }
  })
  it('correctly aggregates global stats and clears only cache without touching music folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-global-cache-'))
    const previousLx = (global as any).lx
    const dataPath = path.join(root, 'data')
    const dbPath = path.join(root, 'yun-yin.db')
    try {
      closeDb()
      ;(global as any).lx = {
        dataPath,
        appPath: root,
        config: {
          users: [{ name: 'user1' }, { name: 'user2' }]
        }
      }
      initDatabase(dbPath)
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.DATA)

      const user1CacheDir = fileCache.getCacheDir('user1', false)
      const user1MusicDir = fileCache.getCacheDir('user1', true)
      const openCacheDir = fileCache.getCacheDir('_open', false)

      fs.mkdirSync(user1CacheDir, { recursive: true })
      fs.mkdirSync(user1MusicDir, { recursive: true })
      fs.mkdirSync(openCacheDir, { recursive: true })

      fs.writeFileSync(path.join(user1CacheDir, 'cached1.mp3'), Buffer.alloc(1000))
      fs.writeFileSync(path.join(user1MusicDir, 'downloaded1.mp3'), Buffer.alloc(2000))
      fs.writeFileSync(path.join(openCacheDir, 'open_cached.flac'), Buffer.alloc(3000))

      const retainedStats = fs.statSync(path.join(user1MusicDir, 'downloaded1.mp3'))
      const retainedHash = createHash('md5').update(`downloaded1.mp3:${retainedStats.size}:${retainedStats.mtimeMs}`).digest('hex')
      const coverDirs = [path.join(root, 'cover_cache', 'user1'), path.join(dataPath, 'cover_cache', 'user1')]
      for (const coverDir of coverDirs) {
        fs.mkdirSync(coverDir, { recursive: true })
        fs.writeFileSync(path.join(coverDir, `${retainedHash}.bin`), 'music-cover')
        fs.writeFileSync(path.join(coverDir, 'orphan.bin'), 'old-cache-cover')
        fs.writeFileSync(path.join(coverDir, 'orphan.mime'), 'image/jpeg')
      }

      fileCache.invalidateGlobalCacheStats()
      const stats = fileCache.getGlobalCacheStats()
      expect(stats.cache.fileCount).toBe(2)
      expect(stats.cache.totalSize).toBe(4000)
      expect(stats.music.fileCount).toBe(1)
      expect(stats.music.totalSize).toBe(2000)
      expect(stats.totalSize).toBe(6000)
      expect(stats.fileCount).toBe(3)

      // Test clearOnlyAudioCache for user1
      await fileCache.clearOnlyAudioCache('user1')
      expect(fs.existsSync(path.join(user1CacheDir, 'cached1.mp3'))).toBe(false)
      expect(fs.existsSync(path.join(user1MusicDir, 'downloaded1.mp3'))).toBe(true) // Strictly preserved!
      expect(fs.existsSync(path.join(openCacheDir, 'open_cached.flac'))).toBe(true) // Untouched!
      for (const coverDir of coverDirs) {
        expect(fs.existsSync(path.join(coverDir, `${retainedHash}.bin`))).toBe(true)
        expect(fs.existsSync(path.join(coverDir, 'orphan.bin'))).toBe(false)
        expect(fs.existsSync(path.join(coverDir, 'orphan.mime'))).toBe(false)
      }

      // Test clearAllUsersAudioCache
      await fileCache.clearAllUsersAudioCache()
      expect(fs.existsSync(path.join(openCacheDir, 'open_cached.flac'))).toBe(false)
      expect(fs.existsSync(path.join(user1MusicDir, 'downloaded1.mp3'))).toBe(true) // Still strictly preserved!
    } finally {
      closeDb()
      ;(global as any).lx = previousLx
      fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
