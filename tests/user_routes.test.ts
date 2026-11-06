import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { closeDb, getDb, initDatabase } from '@/database'
import { releaseUserSpace, syncUsersToDatabase } from '@/user'
import { createUserRouter } from '@/server/routes/user'
import { createAuthRouter, revokeUserAuth, userSessions, verifyUserAuth } from '@/server/routes/auth'
import * as downloadQueue from '@/server/serverDownloadQueue'
import * as fileCache from '@/server/fileCache'
import { spyOn } from 'bun:test'
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession } from '@/server/auth'

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-user-routes-test-'))

describe('User data routes', () => {
  let previousLx: typeof global.lx
  const username = 'user_data_owner'
  const sessionToken = 'user-data-session'
  const userHeaders = { cookie: `lx_user_session=${sessionToken}` }
  let adminHeaders: Record<string, string>

  beforeEach(async () => {
    previousLx = global.lx
    closeDb()
    initDatabase(':memory:')
    global.lx = {
      userPath: testDataDir,
      config: {
        users: [{ name: username, password: 'password' }],
        'frontend.password': 'user-data-admin',
        'user.enablePublicFavorites': true,
        'user.enablePublicNonAdminAccess': true,
        'user.enablePublicRestriction': true,
      },
    } as typeof global.lx
    await syncUsersToDatabase(global.lx.config.users)
    adminHeaders = { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}` }
    const createdAt = Date.now()
    userSessions.set(sessionToken, { username, createdAt })
    getDb().run('INSERT OR REPLACE INTO user_sessions (session_hash, user_name, created_at) VALUES (?, ?, ?)', [
      createHash('sha256').update(sessionToken).digest('hex'),
      username,
      createdAt,
    ])
  })

  afterEach(() => {
    userSessions.delete(sessionToken)
    for (const owner of ['_open', username]) releaseUserSpace(owner, true)
    closeDb()
    global.lx = previousLx
  })

  test('personal settings use the logged-in user and preserve earlier keys', async () => {
    const router = createUserRouter()
    const save = (body: Record<string, unknown>, url = 'http://localhost/api/user/settings', headers = userHeaders) =>
      router.handle(
        new Request(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )

    expect((await save({ preferredQuality: 'flac' })).status).toBe(200)
    expect((await save({ theme: 'dark' })).status).toBe(200)
    const personal = await router.handle(new Request('http://localhost/api/user/settings', { headers: userHeaders }))
    expect(await personal.json()).toEqual({ preferredQuality: 'flac', theme: 'dark' })
    expect(
      getDb()
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(username, 'settings')?.value,
    ).toBe(JSON.stringify({ preferredQuality: 'flac', theme: 'dark' }))

    const publicSettings = await router.handle(
      new Request('http://localhost/api/user/settings?user=_open', { headers: userHeaders }),
    )
    expect(await publicSettings.json()).toEqual({})
    expect((await save({ theme: 'light' }, 'http://localhost/api/user/settings?user=_open')).status).toBe(403)
    expect((await save({ theme: 'light' }, 'http://localhost/api/user/settings?user=other')).status).toBe(403)
  })

  test('play history is account-bound, merges repeated songs and survives a user-space reload', async () => {
    const router = createUserRouter()
    const endpoint = 'http://localhost/api/user/play-history'
    expect((await router.handle(new Request(endpoint))).status).toBe(401)

    const first = { id: 'recent-1', songmid: 'recent-1', name: 'Recent 1', source: 'wy', playedAt: 100 }
    const latest = { ...first, quality: 'flac', playedAt: 200 }
    const save = (items: unknown[]) =>
      router.handle(
        new Request(endpoint, {
          method: 'POST',
          headers: { ...userHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ items }),
        }),
      )

    const initialSave = await save([first, latest])
    expect(initialSave.status).toBe(200)
    expect((await initialSave.json()).items).toEqual([latest])

    const second = { id: 'recent-2', songmid: 'recent-2', name: 'Recent 2', source: 'tx', playedAt: 300 }
    const mergedSave = await save([second])
    expect(mergedSave.status).toBe(200)
    expect((await mergedSave.json()).items).toEqual([second, latest])

    releaseUserSpace(username, true)
    const read = await router.handle(new Request(`${endpoint}?user=_open`, { headers: userHeaders }))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ items: [second, latest] })
    expect(
      getDb()
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(username, 'play_history')?.value,
    ).toBe(JSON.stringify([second, latest]))

    const anonymousSave = await router.handle(
      new Request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [second] }),
      }),
    )
    expect(anonymousSave.status).toBe(401)
  })

  test('merges playback events across devices and ignores retries', async () => {
    const router = createUserRouter()
    const endpoint = 'http://localhost/api/user/play-history/events'
    const save = (events: unknown[]) =>
      router.handle(
        new Request(endpoint, {
          method: 'POST',
          headers: { ...userHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
        }),
      )
    const song = (id: string, playedAt: number) => ({ id, source: 'wy', name: id, playedAt })
    const first = { id: 'event-one', song: song('one', 9999999999999) }
    const second = { id: 'event-two', song: song('two', 1) }
    const results = await Promise.all([save([first]), save([second])])
    expect(results.map(result => result.status)).toEqual([200, 200])
    const read = async () =>
      (
        await (
          await router.handle(new Request('http://localhost/api/user/play-history', { headers: userHeaders }))
        ).json()
      ).items
    const beforeRetry = await read()
    expect(beforeRetry.map((item: { id: string }) => item.id)).toEqual(['two', 'one'])
    expect(beforeRetry[0].playedAt).toBeGreaterThan(1)
    expect(beforeRetry[1].playedAt).toBeLessThan(9999999999999)
    expect((await save([first])).status).toBe(200)
    expect(await read()).toEqual(beforeRetry)
    expect((await save([{ id: 'event-three', song: song('one', 0) }])).status).toBe(200)
    expect((await read()).map((item: { id: string }) => item.id)).toEqual(['one', 'two'])
  })

  test('does not lose the first favorite or playlist write during user-space initialization', async () => {
    const router = createUserRouter()
    releaseUserSpace(username, true)
    const song = { id: 'song-1', songmid: 'song-1', name: 'Song 1', singer: 'Singer 1', source: 'wy' }
    const savedData = {
      defaultList: [],
      loveList: [song],
      userList: [{ id: 'playlist-1', name: '我的歌单', icon: 'cloud-rain', list: [song] }],
    }

    const save = await router.handle(
      new Request('http://localhost/api/user/list', {
        method: 'POST',
        headers: { ...userHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(savedData),
      }),
    )
    expect(save.status).toBe(200)

    // Force the next read through a newly-created in-memory user space, as a
    // browser refresh does after the previous request has completed.
    releaseUserSpace(username, true)
    const read = await router.handle(new Request('http://localhost/api/user/list', { headers: userHeaders }))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(savedData)
  })

  test('persists an incremental favorite across a browser refresh', async () => {
    const router = createUserRouter()
    releaseUserSpace(username, true)
    const song = { id: 'favorite-1', songmid: 'favorite-1', name: 'Favorite 1', singer: 'Singer 1', source: 'wy' }

    const add = await router.handle(
      new Request('http://localhost/api/music/user/list/add', {
        method: 'POST',
        headers: { ...userHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ listId: 'love', musicInfos: [song] }),
      }),
    )
    expect(add.status).toBe(200)

    // A refresh creates a new in-memory user space, so this verifies the
    // actual favorite-button write path rather than only the full-save route.
    releaseUserSpace(username, true)
    const read = await router.handle(new Request('http://localhost/api/user/list', { headers: userHeaders }))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ defaultList: [], loveList: [song], userList: [] })
  })

  test('public library writes require an administrator while personal libraries remain writable', async () => {
    const router = createUserRouter()
    for (const type of ['artists', 'albums']) {
      const original = [{ id: 'saved-item', name: 'Saved' }]
      getDb().run('INSERT INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        '_open',
        `library_${type}`,
        JSON.stringify(original),
        Date.now(),
      ])
      const write = (owner: string, headers: Record<string, string>, body: unknown = []) =>
        router.handle(
          new Request(`http://localhost/api/user/library/${type}?user=${owner}`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )
      for (const owner of ['_open', 'default', '']) {
        expect((await write(owner, {})).status).toBe(403)
      }
      expect((await write('_open', userHeaders)).status).toBe(403)
      const read = await router.handle(new Request(`http://localhost/api/user/library/${type}?user=_open`))
      expect(await read.json()).toEqual(original)
      expect((await write('_open', adminHeaders)).status).toBe(200)
      expect((await write(username, userHeaders, original)).status).toBe(200)
      expect((await write('another-user', userHeaders)).status).toBe(401)
    }
  })

  test('public sound effects can only be changed by an administrator', async () => {
    const router = createUserRouter()
    const write = (owner: string, headers: Record<string, string>) =>
      router.handle(
        new Request(`http://localhost/api/user/sound-effects?user=${owner}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        }),
      )

    expect((await write('_open', {})).status).toBe(403)
    expect((await write('_open', userHeaders)).status).toBe(403)
    expect((await write('_open', adminHeaders)).status).toBe(200)
    expect((await write(username, userHeaders)).status).toBe(200)
  })
})

describe('Deleted account credentials', () => {
  let previousLx: typeof global.lx
  let previousCacheLocation: string
  let tempDir: string
  const username = 'deleted_account'
  let adminHeaders: Record<string, string>

  beforeEach(async () => {
    previousLx = global.lx
    previousCacheLocation = fileCache.getCacheLocation()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-account-test-'))
    fileCache.setCacheLocation(fileCache.CACHE_ROOTS.ROOT)
    closeDb()
    initDatabase(':memory:')
    global.lx = {
      appPath: tempDir,
      logPath: tempDir,
      dataPath: tempDir,
      userPath: tempDir,
      staticPath: path.join(tempDir, 'static'),
      saveConfig: () => {},
      config: {
        users: [{ name: username, password: 'old-password' }],
        'frontend.password': 'account-admin',
      },
    } as unknown as typeof global.lx
    await syncUsersToDatabase(global.lx.config.users)
    adminHeaders = {
      cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`,
      'content-type': 'application/json',
    }
  })

  afterEach(async () => {
    revokeUserAuth(username)
    releaseUserSpace(username, true)
    await downloadQueue.removeUser(username)
    await new Promise(resolve => setTimeout(resolve, 220))
    closeDb()
    fileCache.setCacheLocation(previousCacheLocation)
    global.lx = previousLx
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const deleteAccount = (deleteData: boolean) =>
    createUserRouter().handle(
      new Request('http://localhost/api/users', {
        method: 'DELETE',
        headers: adminHeaders,
        body: JSON.stringify({ name: username, deleteData }),
      }),
    )

  const seedUserData = () => {
    const now = Date.now()
    getDb().run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
      username,
      'library_lists',
      JSON.stringify({ defaultList: [], loveList: [{ id: 'favorite' }], userList: [] }),
      now,
    ])
    getDb().run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
      username,
      'dislike_rules',
      'blocked@singer',
      now,
    ])
    getDb().run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
      username,
      'pref',
      '"kept"',
      now,
    ])
  }

  const countRows = () => ({
    settings: Number(
      getDb().query<{ c: number }, [string]>('SELECT COUNT(*) c FROM user_settings WHERE user_name = ?').get(username)
        ?.c ?? 0,
    ),
    users: Number(
      getDb().query<{ c: number }, [string]>('SELECT COUNT(*) c FROM users WHERE name = ?').get(username)?.c ?? 0,
    ),
    sessions: Number(
      getDb().query<{ c: number }, [string]>('SELECT COUNT(*) c FROM user_sessions WHERE user_name = ?').get(username)
        ?.c ?? 0,
    ),
  })

  test('deleting an account keeps its structured data unless deleteData is set', async () => {
    seedUserData()
    const musicDir = fileCache.getCacheDir(username, true)
    const cacheDir = fileCache.getCacheDir(username, false)
    fs.writeFileSync(path.join(musicDir, 'downloaded.mp3'), 'keep')
    fs.writeFileSync(path.join(cacheDir, 'cached.mp3'), 'remove')
    const response = await deleteAccount(false)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { dataPreserved?: string[] }
    expect(body.dataPreserved).toEqual([username])
    // Account gone (login must not be revived) but structured data kept.
    expect(countRows()).toEqual({ settings: 3, users: 0, sessions: 0 })
    expect(fs.existsSync(path.join(musicDir, 'downloaded.mp3'))).toBe(true)
    expect(fs.existsSync(cacheDir)).toBe(false)
  })

  test('deleting an account with deleteData wipes playlists and settings', async () => {
    seedUserData()
    const musicDir = fileCache.getCacheDir(username, true)
    fs.writeFileSync(path.join(musicDir, 'downloaded.mp3'), 'remove')
    const response = await deleteAccount(true)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { dataPreserved?: string[] }
    expect(body.dataPreserved).toBeUndefined()
    expect(countRows()).toEqual({ settings: 0, users: 0, sessions: 0 })
    expect(fs.existsSync(path.join(musicDir, 'downloaded.mp3'))).toBe(false)
  })

  test('deletion drains active downloads, rejects recreation during cleanup and removes old tasks', async () => {
    const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
    let settle!: () => void
    const pending = new Promise<void>(resolve => {
      settle = resolve
    })
    try {
      downloadQueue.initialize(async () => {
        await pending
        return { url: 'https://example.com/audio.mp3' }
      })
      downloadQueue.enqueue(username, [{ songInfo: { id: 'old-account-download' } }])
      const router = createUserRouter()
      let deleted = false
      const removal = router
        .handle(
          new Request('http://localhost/api/users', {
            method: 'DELETE',
            headers: adminHeaders,
            body: JSON.stringify({ name: username }),
          }),
        )
        .then(response => {
          deleted = true
          return response
        })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(deleted).toBe(false)
      expect(
        (
          await router.handle(
            new Request('http://localhost/api/users', {
              method: 'POST',
              headers: adminHeaders,
              body: JSON.stringify({ name: username, password: 'new-password' }),
            }),
          )
        ).status,
      ).toBe(409)
      settle()
      expect((await removal).status).toBe(200)
      expect(downloadQueue.list(username)).toEqual([])
      expect(
        (
          await router.handle(
            new Request('http://localhost/api/users', {
              method: 'POST',
              headers: adminHeaders,
              body: JSON.stringify({ name: username, password: 'new-password' }),
            }),
          )
        ).status,
      ).toBe(200)
      expect(downloadQueue.list(username)).toEqual([])
    } finally {
      settle()
      checkCache.mockRestore()
    }
  })

  test('deleting and recreating an account does not revive old sessions', async () => {
    const auth = createAuthRouter()
    const login = await auth.handle(
      new Request('http://localhost/api/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'old-password' }),
      }),
    )
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const sessionToken = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
    const cookieRequest = new Request('http://localhost/api/user/auth/verify', { headers: { cookie } })
    expect(verifyUserAuth(cookieRequest)).toBe(username)

    const users = createUserRouter()
    const deleted = await users.handle(
      new Request('http://localhost/api/users', {
        method: 'DELETE',
        headers: adminHeaders,
        body: JSON.stringify({ name: username }),
      }),
    )
    expect(deleted.status).toBe(200)
    expect(userSessions.has(sessionToken)).toBe(false)
    expect(getDb().query('SELECT * FROM user_sessions WHERE user_name = ?').all(username)).toEqual([])
    expect(verifyUserAuth(cookieRequest)).toBeNull()
    expect(getDb().query('SELECT * FROM user_settings WHERE user_name = ?').all(username)).toEqual([])

    const recreated = await users.handle(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ name: username, password: 'new-password' }),
      }),
    )
    expect(recreated.status).toBe(200)
    expect(verifyUserAuth(cookieRequest)).toBeNull()
    userSessions.clear()
    expect(verifyUserAuth(cookieRequest)).toBeNull()
    expect(
      (
        await auth.handle(
          new Request('http://localhost/api/user/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username, password: 'new-password' }),
          }),
        )
      ).status,
    ).toBe(200)
  }, 15_000)

  test('changing a password revokes the account’s existing sessions', async () => {
    const auth = createAuthRouter()
    const login = (password: string) =>
      auth.handle(
        new Request('http://localhost/api/user/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }),
      )
    const firstLogin = await login('old-password')
    expect(firstLogin.status).toBe(200)
    const cookie = firstLogin.headers.get('set-cookie')!.split(';')[0]
    const authenticated = new Request('http://localhost/api/user/auth/verify', { headers: { cookie } })
    expect(verifyUserAuth(authenticated)).toBe(username)

    const changed = await createUserRouter().handle(
      new Request('http://localhost/api/users', {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ name: username, password: 'new-password' }),
      }),
    )
    expect(changed.status).toBe(200)
    expect(verifyUserAuth(authenticated)).toBeNull()
    expect(getDb().query('SELECT * FROM user_sessions WHERE user_name = ?').all(username)).toEqual([])
    expect((await login('old-password')).status).toBe(401)
    expect((await login('new-password')).status).toBe(200)
  })

  test('authentication rejects cached and persisted sessions for users removed from configuration', async () => {
    const login = await createAuthRouter().handle(
      new Request('http://localhost/api/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'old-password' }),
      }),
    )
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const request = new Request('http://localhost/api/user/auth/verify', { headers: { cookie } })
    userSessions.set('cached-removed-account', { username, createdAt: Date.now() })
    userSessions.delete(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)))
    global.lx.config.users = []
    expect(verifyUserAuth(request)).toBeNull()
    expect(userSessions.has('cached-removed-account')).toBe(false)
    expect(getDb().query('SELECT * FROM user_sessions WHERE user_name = ?').all(username)).toEqual([])
  })
})
