import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns/promises'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import * as identify from '@/server/utils/identify'
import * as fileCache from '@/server/fileCache'
import * as serverDownloadQueue from '@/server/serverDownloadQueue'
import { createCacheRouter, createProxyResponseStream } from '@/server/routes/cache'
import { userSessions } from '@/server/routes/auth'
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession } from '@/server/auth'
import { closeDb, initDatabase } from '@/database'
import { syncUsersToDatabase } from '@/user'

describe('cache list user scope', () => {
  const username = 'cache_owner'
  const sessionId = 'cache-owner-session'
  let previousLx: typeof global.lx

  beforeEach(() => {
    previousLx = global.lx
    closeDb()
    initDatabase(':memory:')
    global.lx = {
      userPath: process.cwd(),
      config: {
        users: [{ name: username, password: 'password' }],
        'frontend.password': 'cache-admin',
        'user.enablePublicNonAdminLocalMusic': false,
      },
    } as typeof global.lx
    syncUsersToDatabase(global.lx.config.users)
    userSessions.set(sessionId, { username, createdAt: Date.now() })
  })

  afterEach(() => {
    userSessions.delete(sessionId)
    closeDb()
    global.lx = previousLx
  })

  test('uses the authenticated user cache when no public alias is requested', async () => {
    const getCacheList = spyOn(fileCache, 'getCacheList').mockResolvedValue([])
    try {
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/list', {
        headers: { cookie: `lx_user_session=${sessionId}` },
      }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true, data: [] })
      expect(getCacheList).toHaveBeenCalledWith(username)
    } finally {
      getCacheList.mockRestore()
    }
  })

  test('keeps an explicit public alias scoped to the public cache', async () => {
    const getCacheList = spyOn(fileCache, 'getCacheList').mockResolvedValue([])
    try {
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/list?user=_open', {
        headers: { cookie: `lx_user_session=${sessionId}` },
      }))

      expect(response.status).toBe(200)
      expect(getCacheList).toHaveBeenCalledWith('_open')
    } finally {
      getCacheList.mockRestore()
    }
  })

  test('keeps omitted and explicit public cache sync targets separate', async () => {
    const syncCacheIndex = spyOn(fileCache, 'syncCacheIndex').mockResolvedValue(undefined)
    try {
      const personalResponse = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/sync', {
        method: 'POST',
        headers: { cookie: `lx_user_session=${sessionId}` },
      }))
      expect(personalResponse.status).toBe(200)
      expect(syncCacheIndex).toHaveBeenLastCalledWith(username)

      const publicResponse = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/sync?user=_open', {
        method: 'POST',
        headers: { cookie: `lx_user_session=${sessionId}` },
      }))
      expect(publicResponse.status).toBe(200)
      expect(syncCacheIndex).toHaveBeenLastCalledWith('_open')
    } finally {
      syncCacheIndex.mockRestore()
    }
  })

  test('uses the authenticated user for cache removal when user is omitted', async () => {
    const removeCacheFile = spyOn(fileCache, 'removeCacheFile').mockReturnValue({ deleted: true, folder: 'music' })
    try {
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/remove', {
        method: 'POST',
        headers: {
          cookie: `lx_user_session=${sessionId}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ items: [{ filename: 'album/song.mp3', folder: 'music' }] }),
      }))

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ success: true, deletedCount: 1 })
      expect(removeCacheFile).toHaveBeenCalledWith('album/song.mp3', username, 'music')
    } finally {
      removeCacheFile.mockRestore()
    }
  })

  test('keeps an explicit public cache removal protected for personal sessions', async () => {
    const removeCacheFile = spyOn(fileCache, 'removeCacheFile').mockReturnValue({ deleted: true, folder: 'music' })
    try {
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/remove?user=_open', {
        method: 'POST',
        headers: {
          cookie: `lx_user_session=${sessionId}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ items: [{ filename: 'public/song.mp3', folder: 'music' }] }),
      }))

      expect(response.status).toBe(403)
      expect(removeCacheFile).not.toHaveBeenCalled()
    } finally {
      removeCacheFile.mockRestore()
    }
  })

  test('uses the authenticated user for cover lookup when user is omitted', async () => {
    const getCacheCover = spyOn(fileCache, 'getCacheCover').mockResolvedValue({
      data: Buffer.from('cover'),
      mime: 'image/png',
    })
    try {
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/cover?filename=album/song.mp3', {
        headers: { cookie: `lx_user_session=${sessionId}` },
      }))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('cover'))
      expect(getCacheCover).toHaveBeenCalledWith('album/song.mp3', username)
    } finally {
      getCacheCover.mockRestore()
    }
  })

  test('records playback time in the authenticated user cache scope', async () => {
    const markCachePlayback = spyOn(fileCache, 'markCachePlayback').mockReturnValue(true)
    try {
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/playback', {
        method: 'POST',
        headers: {
          cookie: `lx_user_session=${sessionId}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ filename: 'album/song.mp3', folder: 'cache' }),
      }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true, data: { marked: true } })
      expect(markCachePlayback).toHaveBeenCalledWith('album/song.mp3', username, 'cache')
    } finally {
      markCachePlayback.mockRestore()
    }
  })

  test('reports queued cache work as processing before a file exists', async () => {
    const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false })
    const getActiveCacheProgress = spyOn(fileCache, 'getActiveCacheProgress').mockReturnValue(null)
    const getActiveTaskProgress = spyOn(serverDownloadQueue, 'getActiveTaskProgress').mockReturnValue({
      status: 'waiting',
      progress: 0,
      total: 0,
      received: 0,
      speed: 0,
      updatedAt: Date.now(),
    })
    try {
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/check?name=Song&singer=Singer&source=wy&songmid=123&quality=flac', {
        headers: { cookie: `lx_user_session=${sessionId}` },
      }))

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        exists: false,
        processing: true,
        progress: { status: 'waiting' },
      })
      expect(getActiveTaskProgress).toHaveBeenCalledWith(username, expect.objectContaining({ songmid: '123', source: 'wy' }), 'flac')
    } finally {
      getActiveTaskProgress.mockRestore()
      getActiveCacheProgress.mockRestore()
      checkCache.mockRestore()
    }
  })
})

test('cache file routes honor the requested folder and keep personal media private', async () => {
  const previousLx = global.lx
  const username = 'file_owner'
  const sessionId = 'file-owner-session'
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-file-route-test-'))
  const cacheDir = path.join(tempRoot, 'cache')
  const musicDir = path.join(tempRoot, 'music')
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.mkdirSync(musicDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'song.mp3'), 'cache-file')
  fs.writeFileSync(path.join(musicDir, 'song.mp3'), 'music-file')
  global.lx = { config: { users: [{ name: username, password: 'password' }], 'frontend.password': 'file-route-admin' } } as typeof global.lx
  userSessions.set(sessionId, { username, createdAt: Date.now() })
  const getCacheLocation = spyOn(fileCache, 'getCacheLocation').mockReturnValue(fileCache.CACHE_ROOTS.ROOT)
  const getCacheDir = spyOn(fileCache, 'getCacheDir').mockImplementation((_username, isOnlyDownload) => isOnlyDownload ? musicDir : cacheDir)

  try {
    const response = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/file/${username}/song.mp3?folder=music`, {
      headers: { cookie: `lx_user_session=${sessionId}` },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(await response.text()).toBe('music-file')

    const etag = response.headers.get('etag')
    const clampedRange = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/file/${username}/song.mp3?folder=music`, {
      headers: { cookie: `lx_user_session=${sessionId}`, range: 'bytes=0-999' },
    }))
    expect(clampedRange.status).toBe(206)
    expect(clampedRange.headers.get('content-range')).toMatch(/^bytes 0-9\/10$/)
    expect(clampedRange.headers.get('content-length')).toBe('10')
    expect(await clampedRange.text()).toBe('music-file')

    const suffixRange = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/file/${username}/song.mp3?folder=music`, {
      headers: { cookie: `lx_user_session=${sessionId}`, range: 'bytes=-4' },
    }))
    expect(suffixRange.status).toBe(206)
    expect(suffixRange.headers.get('content-range')).toMatch(/^bytes 6-9\/10$/)
    expect(await suffixRange.text()).toBe('file')

    const rangedWithValidator = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/file/${username}/song.mp3?folder=music`, {
      headers: { cookie: `lx_user_session=${sessionId}`, range: 'bytes=0-3', 'if-none-match': etag || '' },
    }))
    expect(rangedWithValidator.status).toBe(206)
    expect(await rangedWithValidator.text()).toBe('musi')

    const unsatisfiableRange = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/file/${username}/song.mp3?folder=music`, {
      headers: { cookie: `lx_user_session=${sessionId}`, range: 'bytes=999-' },
    }))
    expect(unsatisfiableRange.status).toBe(416)
    expect(unsatisfiableRange.headers.get('content-range')).toBe('bytes */10')

    fs.writeFileSync(path.join(musicDir, 'empty.mp3'), '')
    const emptyFile = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/file/${username}/empty.mp3?folder=music`, {
      headers: { cookie: `lx_user_session=${sessionId}` },
    }))
    expect(emptyFile.status).toBe(404)

    const invalidFolder = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/file/${username}/song.mp3?folder=other`, {
      headers: { cookie: `lx_user_session=${sessionId}` },
    }))
    expect(invalidFolder.status).toBe(400)
  } finally {
    getCacheDir.mockRestore()
    getCacheLocation.mockRestore()
    userSessions.delete(sessionId)
    fs.rmSync(tempRoot, { recursive: true, force: true })
    global.lx = previousLx
  }
})

test('cover routes forward the requested folder and return public cache headers only for public storage', async () => {
  const previousLx = global.lx
  const username = 'cover_owner'
  const sessionId = 'cover-owner-session'
  global.lx = { config: { users: [{ name: username, password: 'password' }], 'frontend.password': 'cover-route-admin' } } as typeof global.lx
  userSessions.set(sessionId, { username, createdAt: Date.now() })
  const getCacheCover = spyOn(fileCache, 'getCacheCover').mockResolvedValue({
    data: Buffer.from('cover'),
    mime: 'image/png',
  })

  try {
    const response = await createCacheRouter().handle(new Request(`http://localhost/api/music/cache/cover?filename=album/song.mp3&user=${username}&folder=music`, {
      headers: { cookie: `lx_user_session=${sessionId}` },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(getCacheCover).toHaveBeenCalledWith('album/song.mp3', username, 'music')

    const publicResponse = await createCacheRouter().handle(new Request('http://localhost/api/music/cache/cover?filename=album/song.mp3&user=_open&folder=cache'))
    expect(publicResponse.status).toBe(200)
    expect(publicResponse.headers.get('cache-control')).toBe('public, max-age=86400')
    expect(getCacheCover).toHaveBeenLastCalledWith('album/song.mp3', '_open', 'cache')
  } finally {
    getCacheCover.mockRestore()
    userSessions.delete(sessionId)
    global.lx = previousLx
  }
})

test('proxy stream bounds unread data and cancels the upstream transport', async () => {
  let produced = 0
  let destroyed = false
  const source = new Readable({
    highWaterMark: 16 * 1024,
    read() {
      produced += 16 * 1024
      this.push(Buffer.alloc(16 * 1024))
    },
  })
  const stream = createProxyResponseStream(source, { destroy() { destroyed = true } } as any, 10 * 1024 * 1024)
  await Bun.sleep(20)
  expect(produced).toBeLessThan(512 * 1024)
  await stream.cancel()
  await Bun.sleep(10)
  expect(source.destroyed).toBe(true)
  expect(destroyed).toBe(true)
})

test('proxy stream propagates size violations and truncated upstream responses', async () => {
  for (const oversized of [true, false]) {
    let destroyed = false
    const source = oversized ? Readable.from([Buffer.alloc(128)]) : new Readable({ read() { this.destroy(new Error('truncated')) } })
    const stream = createProxyResponseStream(source, { destroy() { destroyed = true } } as any, 64)
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow(oversized ? 'Remote file is too large' : 'truncated')
    await Bun.sleep(10)
    expect(destroyed).toBe(true)
  }
})

test('download proxy isolates active content and preserves media responses', async () => {
  const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any)
  let mime = 'text/html'
  const content = Buffer.from('<script>window.untrusted=true</script>')
  const request = spyOn(http, 'request').mockImplementation((_url: any, _options: any, callback: any) => {
    const req = new EventEmitter() as any
    req.destroy = () => {}
    req.end = () => {
      const response = Readable.from([content]) as any
      response.statusCode = 200
      response.headers = { 'content-type': mime }
      callback(response)
    }
    return req
  })
  try {
    for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'audio/mpeg', 'image/png']) {
      mime = type
      const response = await createCacheRouter().handle(new Request('http://localhost/api/music/download?inline=1&url=http%3A%2F%2Fexample.com%2Ffile'))
      expect(response.status).toBe(200)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toContain('sandbox')
      const media = type === 'audio/mpeg' || type === 'image/png'
      expect(response.headers.get('content-type')).toBe(media ? type : 'application/octet-stream')
      if (media) expect(response.headers.get('content-disposition')).toBeNull()
      else expect(response.headers.get('content-disposition')).toStartWith('attachment;')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(content)
    }
  } finally {
    request.mockRestore()
    lookup.mockRestore()
  }
})

test('download proxy treats client aborts as normal request cancellation', async () => {
  const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any)
  const request = spyOn(http, 'request').mockImplementation(() => {
    const req = new EventEmitter() as any
    req.destroy = () => {}
    req.end = () => {
      queueMicrotask(() => {
        const error = Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        })
        req.emit('error', error)
      })
    }
    return req
  })
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await createCacheRouter().handle(new Request(
      'http://localhost/api/music/download?url=http%3A%2F%2Fexample.com%2Faudio',
    ))
    expect(response.status).toBe(499)
    expect(errorLog).not.toHaveBeenCalled()
  } finally {
    errorLog.mockRestore()
    request.mockRestore()
    lookup.mockRestore()
  }
})

test('local identification resolves its module and forwards a bounded file path', async () => {
  const previousLx = global.lx
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-identify-test-'))
  const file = path.join(dir, 'song.mp3')
  fs.writeFileSync(file, 'fixture')
  global.lx = { config: { 'frontend.password': 'identify-admin' } } as typeof global.lx
  const cacheDir = spyOn(fileCache, 'getCacheDir').mockReturnValue(dir)
  const identifySong = spyOn(identify, 'identifyLocalSong').mockResolvedValue([{ name: 'Identified song' }] as any)
  try {
  const adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`
  const request = (filename: string) => createCacheRouter().handle(new Request('http://localhost/api/music/identify', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ filename }),
    }))
    const response = await request('song.mp3')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, results: [{ name: 'Identified song' }] })
    expect(identifySong).toHaveBeenCalledWith(file)
    identifySong.mockClear()
    expect((await request('../outside.mp3')).status).toBe(500)
    expect(identifySong).not.toHaveBeenCalled()
  } finally {
    identifySong.mockRestore()
    cacheDir.mockRestore()
    global.lx = previousLx
    fs.unlinkSync(file)
    fs.rmdirSync(dir)
  }
})
