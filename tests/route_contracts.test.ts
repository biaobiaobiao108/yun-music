import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { closeDb, getDb, initDatabase } from '@/database'
import {
  ADMIN_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createAdminSession,
  createPlayerSession,
  removeAdminSession,
  removePlayerSession,
} from '@/server/auth'
import { HttpContext, NO_STORE_HEADERS } from '@/server/core'
import { createRootRouter } from '@/server/routes'
import { userSessions } from '@/server/routes/auth'
import { syncUsersToDatabase } from '@/user'
import { parseListenPort } from '@/utils/configLoader'

describe('Cross-route contracts and auth alignment', () => {
  let previousLx: typeof global.lx
  let tempRoot: string
  let adminSessionId = ''
  let playerSessionId = ''
  const aliceSession = 'contract-alice-session'

  beforeEach(async () => {
    previousLx = global.lx
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-route-contracts-'))
    closeDb()
    initDatabase(':memory:')
    global.lx = {
      appPath: tempRoot,
      logPath: tempRoot,
      dataPath: tempRoot,
      userPath: tempRoot,
      staticPath: path.join(process.cwd(), 'public'),
      saveConfig: () => {},
      config: {
        serverName: 'ContractTest',
        'player.path': '/music',
        'admin.path': '',
        'player.enableAuth': true,
        'player.password': 'player-secret',
        'frontend.password': 'admin-secret',
        'proxy.enabled': false,
        'proxy.header': 'x-forwarded-for',
        'proxy.trustedAddresses': [],
        'user.enablePublicRestriction': true,
        'user.enablePublicNonAdminLocalMusic': false,
        users: [
          { name: 'alice', password: 'pw1', dataPath: 'alice' },
          { name: 'bob', password: 'pw2', dataPath: 'bob' },
        ],
      },
    } as unknown as typeof global.lx

    await syncUsersToDatabase(global.lx.config.users)
    adminSessionId = createAdminSession()
    playerSessionId = createPlayerSession()
    userSessions.set(aliceSession, { username: 'alice', createdAt: Date.now() })
    getDb().run('INSERT OR REPLACE INTO user_sessions (session_hash, user_name, created_at) VALUES (?, ?, ?)', [
      createHash('sha256').update(aliceSession).digest('hex'),
      'alice',
      Date.now(),
    ])
  })

  afterEach(() => {
    userSessions.delete(aliceSession)
    if (adminSessionId) removeAdminSession(adminSessionId)
    if (playerSessionId) removePlayerSession(playerSessionId)
    closeDb()
    fs.rmSync(tempRoot, { recursive: true, force: true })
    global.lx = previousLx
  })

  test('player static routes and /api/music/* enforce identical access matrix', async () => {
    const router = createRootRouter()
    const protectedPages = ['/music/', '/music/index.html']
    const protectedApis = ['/api/music/cache/list', '/api/music/download/status']
    const exemptPaths = ['/music/login', '/api/music/config', '/api/music/auth/verify']

    for (const p of exemptPaths) {
      const res = await router.handle(new Request(`http://localhost:9527${p}`))
      expect(res.status).toBe(200)
    }

    for (const p of protectedPages) {
      const anon = await router.handle(new Request(`http://localhost:9527${p}`))
      expect(anon.status).toBe(302)
      expect(anon.headers.get('location')).toBe('/music/login')

      const asPlayer = await router.handle(
        new Request(`http://localhost:9527${p}`, {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${playerSessionId}` },
        }),
      )
      expect(asPlayer.status).toBe(200)

      const asAdmin = await router.handle(
        new Request(`http://localhost:9527${p}`, {
          headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${adminSessionId}` },
        }),
      )
      expect(asAdmin.status).toBe(200)
    }

    for (const apiPath of protectedApis) {
      const anon = await router.handle(new Request(`http://localhost:9527${apiPath}`))
      expect(anon.status).toBe(401)

      const asPlayer = await router.handle(
        new Request(`http://localhost:9527${apiPath}`, {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${playerSessionId}` },
        }),
      )
      expect(asPlayer.status).not.toBe(401)

      const asAdmin = await router.handle(
        new Request(`http://localhost:9527${apiPath}`, {
          headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${adminSessionId}` },
        }),
      )
      expect(asAdmin.status).not.toBe(401)
    }

    const crossUserList = await router.handle(
      new Request('http://localhost:9527/api/music/cache/list?user=bob', {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${playerSessionId}; lx_user_session=${aliceSession}`,
        },
      }),
    )
    expect(crossUserList.status).toBe(403)
    expect(crossUserList.headers.get('cache-control')).toBe(NO_STORE_HEADERS['Cache-Control'])
    const crossUserBody = (await crossUserList.json()) as Record<string, unknown>
    expect('Cache-Control' in crossUserBody).toBe(false)
  })

  test('HttpContext.fail passes headers separately from JSON body extras', async () => {
    const ctx = new HttpContext(new Request('http://localhost/test'))
    const res = ctx.fail(429, 'too fast', { retryAfter: 10 }, NO_STORE_HEADERS)
    expect(res.status).toBe(429)
    expect(res.headers.get('cache-control')).toBe(NO_STORE_HEADERS['Cache-Control'])
    expect(await res.json()).toEqual({
      code: 429,
      message: 'too fast',
      success: false,
      retryAfter: 10,
    })
  })

  test('parseListenPort rejects out-of-range and malformed port strings', () => {
    expect(parseListenPort('9527')).toBe(9527)
    expect(parseListenPort(' 8080 ')).toBe(8080)
    expect(parseListenPort('0')).toBeUndefined()
    expect(parseListenPort('-1')).toBeUndefined()
    expect(parseListenPort('65536')).toBeUndefined()
    expect(parseListenPort('9527abc')).toBeUndefined()
    expect(parseListenPort(443)).toBe(443)
  })
})
