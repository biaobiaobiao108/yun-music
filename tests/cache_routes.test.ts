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
