import { describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as fileCache from '@/server/fileCache'
import { closeDb } from '@/database'
import {
  deduplicateDownloadTasks,
  enqueue,
  initialize,
  isDownloadTaskRunnable,
  list,
  markDownloadTaskPausedIfAborted,
  pruneDownloadHistory,
  serializeDownloadTask,
  type ServerDownloadTask,
} from '@/server/serverDownloadQueue'

const makeTask = (
  username: string,
  id: string,
  status: ServerDownloadTask['status'],
  updatedAt: number,
): ServerDownloadTask => ({
  id,
  username,
  songKey: `${username}_${id}`,
  songInfo: { id, name: id },
  quality: '320k',
  requestedQuality: '320k',
  status,
  progress: status === 'finished' ? 100 : 0,
  total: 0,
  received: 0,
  speed: 0,
  errorMsg: '',
  enableOnlyDownloadMode: false,
  cacheLyric: true,
  embedLyric: true,
  background: false,
  createdAt: updatedAt,
  updatedAt,
})

describe('Server download queue retention', () => {
  test('caps terminal history per user while retaining active and resumable tasks', () => {
    const history = Array.from({ length: 5 }, (_, index) => (
      makeTask('user-a', `finished-${index}`, 'finished', index)
    ))
    const otherUserHistory = Array.from({ length: 3 }, (_, index) => (
      makeTask('user-b', `finished-${index}`, 'error', index)
    ))
    const active = makeTask('user-a', 'active', 'downloading', 0)
    const paused = makeTask('user-a', 'paused', 'paused', 0)

    const retained = pruneDownloadHistory(
      [...history, ...otherUserHistory, active, paused],
      2,
    )

    expect(retained.filter(task => task.username === 'user-a' && task.status === 'finished')).toHaveLength(2)
    expect(retained.filter(task => task.username === 'user-b')).toHaveLength(2)
    expect(retained.some(task => task.id === 'active')).toBe(true)
    expect(retained.some(task => task.id === 'paused')).toBe(true)
  })

  test('marks a task paused when an in-flight worker observes cancellation', () => {
    const task = makeTask('user-a', 'aborted', 'downloading', 10)

    expect(markDownloadTaskPausedIfAborted(task, false)).toBe(false)
    expect(task.status).toBe('downloading')

    expect(markDownloadTaskPausedIfAborted(task, true)).toBe(true)
    expect(task.status).toBe('paused')
    expect(task.speed).toBe(0)
    expect(task.errorMsg).toBe('已暂停')
  })
})

describe('Server download queue deduplication', () => {
  test('keeps one task per user/song/quality and prefers a completed task', () => {
    const waiting = makeTask('user-a', 'waiting-copy', 'waiting', 20)
    waiting.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    waiting.songKey = 'wy_167655_flac'
    waiting.quality = 'flac'
    waiting.requestedQuality = 'flac'

    const finished = makeTask('user-a', 'finished-copy', 'finished', 10)
    finished.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    finished.songKey = 'wy_167655_flac'
    finished.quality = 'flac'
    finished.requestedQuality = 'flac'

    const retained = deduplicateDownloadTasks([waiting, finished])

    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe('finished-copy')
    expect(retained[0]?.status).toBe('finished')
  })

  test('keeps the stricter music target when merging cache and music requests', () => {
    const cached = makeTask('user-a', 'cached', 'finished', 20)
    cached.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    cached.songKey = 'wy_167655_flac'
    cached.quality = 'flac'
    cached.requestedQuality = 'flac'

    const music = makeTask('user-a', 'music', 'waiting', 10)
    music.songInfo = { source: 'wy', songmid: 167655, name: 'Sign', singer: 'FLOW' }
    music.songKey = 'wy_167655_flac'
    music.quality = 'flac'
    music.requestedQuality = 'flac'
    music.enableOnlyDownloadMode = true

    const retained = deduplicateDownloadTasks([cached, music])

    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe('music')
    expect(retained[0]?.enableOnlyDownloadMode).toBe(true)
  })

  test('does not persist transient resolved download URLs', () => {
    const task = makeTask('user-a', 'background', 'waiting', 10)
    task.background = true
    task.songInfo.url = 'https://cdn.example.test/song.flac?signature=secret'
    task.songInfo.meta = { url: 'https://cdn.example.test/meta.flac?signature=secret' }
    task.resolvedUrl = 'https://cdn.example.test/song.flac?signature=secret'
    task.resolvedUrlAt = Date.now()

    const serialized = serializeDownloadTask(task) as Record<string, unknown>

    expect(serialized.background).toBe(true)
    expect(serialized).not.toHaveProperty('resolvedUrl')
    expect(serialized).not.toHaveProperty('resolvedUrlAt')
    expect((serialized.songInfo as Record<string, unknown>).url).toBeUndefined()
    expect((serialized.songInfo as Record<string, any>).meta.url).toBeUndefined()
  })

  test('keeps resolver metadata while dropping large transient song payloads', () => {
    const task = makeTask('user-a', 'trimmed', 'waiting', 10)
    task.songInfo = {
      source: 'tx',
      songmid: 'mid-1',
      name: 'Trimmed Song',
      singer: 'Singer',
      albumName: 'Album',
      albumId: 'album-1',
      img: 'https://img.example.test/cover.jpg',
      hash: 'hash-1',
      strMediaMid: 'media-1',
      url: 'https://cdn.example.test/song.flac?signature=secret',
      lyric: 'very large lyric payload'.repeat(1000),
      rawResponse: { nested: 'payload' },
      meta: {
        songId: 'mid-1',
        picUrl: 'https://img.example.test/cover.jpg',
        url: 'https://cdn.example.test/meta.flac?signature=secret',
        lyric: 'large meta lyric payload'.repeat(1000),
      },
    }

    const serialized = serializeDownloadTask(task) as Record<string, any>
    expect(serialized.songInfo).toMatchObject({
      source: 'tx',
      songmid: 'mid-1',
      name: 'Trimmed Song',
      strMediaMid: 'media-1',
    })
    expect(serialized.songInfo.url).toBeUndefined()
    expect(serialized.songInfo.lyric).toBeUndefined()
    expect(serialized.songInfo.rawResponse).toBeUndefined()
    expect(serialized.songInfo.meta.url).toBeUndefined()
    expect(serialized.songInfo.meta.lyric).toBeUndefined()
  })

  test('limits background cache work to one active task and keeps explicit work eligible', () => {
    const background = makeTask('user-a', 'background', 'waiting', 10)
    background.background = true
    const explicit = makeTask('user-a', 'explicit', 'waiting', 20)
    const activeIdentities = new Set<string>()

    expect(isDownloadTaskRunnable(background, 0, 0, activeIdentities, 3)).toBe(true)
    expect(isDownloadTaskRunnable(background, 0, 1, activeIdentities, 3)).toBe(false)
    expect(isDownloadTaskRunnable(explicit, 2, 0, activeIdentities, 3)).toBe(true)
    expect(isDownloadTaskRunnable(explicit, 3, 0, activeIdentities, 3)).toBe(false)
  })

  test('prefers an explicit task over a background task when identities collide', () => {
    const background = makeTask('user-a', 'background', 'waiting', 20)
    background.background = true
    const explicit = makeTask('user-a', 'explicit', 'waiting', 10)
    background.songInfo = explicit.songInfo = { source: 'wy', songmid: 'same-song', name: 'Same Song' }

    const retained = deduplicateDownloadTasks([background, explicit])

    expect(retained).toHaveLength(1)
    expect(retained[0]?.id).toBe('explicit')
  })

  test('marks an existing music target complete without resolving a remote URL', async () => {
    const previousLx = (global as any).lx
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-download-queue-existing-'))
    const songInfo = { source: 'wy', songmid: 'already-downloaded', name: 'Already Downloaded', singer: 'Singer' }
    const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({
      exists: true,
      isCollision: false,
      folder: 'music',
      filename: 'already-downloaded.flac',
      quality: 'flac',
      path: '/tmp/already-downloaded.flac',
    } as any)
    const removeDuplicateCacheForSong = spyOn(fileCache, 'removeDuplicateCacheForSong').mockReturnValue(true)
    let resolverCalls = 0

    try {
      ;(global as any).lx = { dataPath: path.join(root, 'data'), config: {} }
      initialize(async () => {
        resolverCalls++
        return { url: 'https://example.com/already-downloaded.flac', quality: 'flac' }
      })

      const queued = enqueue('existing-download-user', [{
        id: 'wy_already-downloaded_flac',
        songInfo,
        quality: 'flac',
        enableOnlyDownloadMode: true,
      }])
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(queued[0]).toMatchObject({ status: 'exists', progress: 100 })
      expect(list('existing-download-user')[0]).toMatchObject({ status: 'exists', progress: 100 })
      expect(resolverCalls).toBe(0)
      expect(removeDuplicateCacheForSong).toHaveBeenCalledWith(songInfo, 'flac', 'existing-download-user')
    } finally {
      await new Promise(resolve => setTimeout(resolve, 220))
      removeDuplicateCacheForSong.mockRestore()
      checkCache.mockRestore()
      ;(global as any).lx = previousLx
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  test('refreshes a browser-supplied URL once while retaining the requested cache identity', async () => {
    const previousLx = (global as any).lx
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-download-queue-retry-'))
    const downloadAndCache = spyOn(fileCache, 'downloadAndCache')
    let resolverCalls = 0
    let downloadCalls = 0
    downloadAndCache.mockImplementation(async () => {
      downloadCalls++
      if (downloadCalls === 1) throw new Error('expired supplied URL')
    })

    try {
      ;(global as any).lx = { dataPath: path.join(root, 'data'), config: {} }
      initialize(async task => {
        resolverCalls++
        return {
          url: 'https://fresh.example/song.flac',
          quality: task.requestedQuality,
          songInfo: { source: 'tx', songmid: 'fallback-song', name: 'Fallback Song', singer: 'Singer' },
          requestedSource: 'wy',
          downloadSource: 'tx',
        }
      })
      enqueue('retry-user', [{
        id: 'wy_retry-song_flac',
        songInfo: { source: 'wy', songmid: 'retry-song', name: 'Retry Song', singer: 'Singer' },
        quality: 'flac',
        resolvedUrl: 'https://expired.example/song.flac',
        background: true,
      }])

      const deadline = Date.now() + 3000
      let task = list('retry-user').find(item => item.id === 'wy_retry-song_flac')
      while (Date.now() < deadline && task?.status !== 'finished') {
        await new Promise(resolve => setTimeout(resolve, 20))
        task = list('retry-user').find(item => item.id === 'wy_retry-song_flac')
      }

      expect(task?.status).toBe('finished')
      expect(downloadCalls).toBe(2)
      expect(resolverCalls).toBe(1)
      expect(downloadAndCache.mock.calls[0]?.[1]).toBe('https://expired.example/song.flac')
      expect(downloadAndCache.mock.calls[1]?.[1]).toBe('https://fresh.example/song.flac')
      expect(downloadAndCache.mock.calls[1]?.[0]).toMatchObject({ source: 'wy', songmid: 'retry-song' })
      expect(task?.songInfo).toMatchObject({ source: 'wy', songmid: 'retry-song' })
      expect(task?.songKey).toBe('wy_retry-song_flac')
    } finally {
      await new Promise(resolve => setTimeout(resolve, 220))
      downloadAndCache.mockRestore()
      closeDb()
      ;(global as any).lx = previousLx
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
