import { describe, it, expect } from 'bun:test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { resolveCompanionLyricFilename } from '../src/server/fileCache'
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
        album: 'Test Album',
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
        album: 'Queen Rocks',
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
        album: '盗作',
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
        album: 'Collision Album',
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
        album: 'Alternate Album',
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
        album: '',
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
        album: 'Test Album',
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
        album: 'Test Album',
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
        album: 'Album',
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
        album: 'Album',
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
        album: 'Album',
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

describe('File Cache Post-processing Limiter', () => {
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
