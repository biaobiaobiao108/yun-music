import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { closeDb, getDb, initDatabase } from '@/database'
import { getUserDirname, getUserSpace, releaseUserSpace, syncUsersToDatabase } from '@/user'
import { createUserRouter } from '@/server/routes/user'
import { createAuthRouter, revokeUserAuth, userSessions, verifyUserAuth } from '@/server/routes/auth'
import * as downloadQueue from '@/server/serverDownloadQueue'
import * as fileCache from '@/server/fileCache'
import { spyOn } from 'bun:test'
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession } from '@/server/auth'

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-user-routes-test-'))

describe('User snapshot permissions', () => {
  let previousLx: typeof global.lx
  const username = 'snapshot_owner'
  const sessionToken = 'snapshot-owner-session'
  const initialData = { defaultList: [], loveList: [], userList: [] }
  const uploadedData = { ...initialData, userList: [{ id: 'playlist', name: 'Uploaded', locationUpdateTime: null, list: [] }] }
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
        'frontend.password': 'snapshot-admin',
        'user.enablePublicFavorites': true,
        'user.enablePublicNonAdminAccess': true,
        'user.enablePublicRestriction': true,
      },
    } as typeof global.lx
    await syncUsersToDatabase(global.lx.config.users)
    adminHeaders = { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}` }
    const createdAt = Date.now()
    userSessions.set(sessionToken, { username, createdAt })
    getDb().run(
      'INSERT OR REPLACE INTO user_sessions (session_hash, user_name, created_at) VALUES (?, ?, ?)',
      [createHash('sha256').update(sessionToken).digest('hex'), username, createdAt],
    )
    for (const owner of ['_open', username]) {
      const manager = getUserSpace(owner).listManage
      await manager.getListData()
      await manager.saveSnapshotWithTime('original', JSON.stringify(initialData), Date.now())
    }
  })

  afterEach(() => {
    userSessions.delete(sessionToken)
    for (const owner of ['_open', username]) releaseUserSpace(owner, true)
    closeDb()
    global.lx = previousLx
  })

  const snapshotRequest = (action: string, owner: string, headers: Record<string, string> = {}) => (
    new Request(`http://localhost/api/data/${action}-snapshot?user=${owner}&filename=uploaded`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(action === 'upload' ? uploadedData : { id: 'original' }),
    })
  )

  test('personal settings use the logged-in user and preserve earlier keys', async () => {
    const router = createUserRouter()
    const save = (body: Record<string, unknown>, url = 'http://localhost/api/user/settings', headers = userHeaders) => router.handle(new Request(url, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))

    expect((await save({ preferredQuality: 'flac' })).status).toBe(200)
    expect((await save({ theme: 'dark' })).status).toBe(200)
    const personal = await router.handle(new Request('http://localhost/api/user/settings', { headers: userHeaders }))
    expect(await personal.json()).toEqual({ preferredQuality: 'flac', theme: 'dark' })
    expect(getDb().query<{ value: string }, [string, string]>(
      'SELECT value FROM user_settings WHERE user_name = ? AND key = ?'
    ).get(username, 'settings')?.value).toBe(JSON.stringify({ preferredQuality: 'flac', theme: 'dark' }))

    const publicSettings = await router.handle(new Request('http://localhost/api/user/settings?user=_open', { headers: userHeaders }))
    expect(await publicSettings.json()).toEqual({})
    expect((await save({ theme: 'light' }, 'http://localhost/api/user/settings?user=_open')).status).toBe(403)
    expect((await save({ theme: 'light' }, 'http://localhost/api/user/settings?user=other')).status).toBe(403)
  })

  test('public readers cannot upload, restore or delete snapshots through any public alias', async () => {
    const router = createUserRouter()
    for (const headers of [{}, userHeaders]) {
      for (const owner of ['default', 'open', '_open']) {
        for (const action of ['upload', 'restore', 'delete']) {
          const response = await router.handle(snapshotRequest(action, owner, headers))
          expect(response.status).toBe(403)
        }
      }
    }
    expect(await getUserSpace('_open').listManage.getSnapshot('original')).toEqual(initialData)
    expect(await getUserSpace('_open').listManage.getSnapshot('uploaded')).toBeNull()
    expect(getDb().query('SELECT latest_id FROM snapshot_meta WHERE user_name = ?').get('_open')).toBeNull()
    const read = await router.handle(new Request('http://localhost/api/data/snapshot?user=_open&id=original'))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual(initialData)
  })

  test('administrators can write public snapshots and users can manage their own snapshots', async () => {
    const router = createUserRouter()
    for (const [owner, headers] of [['_open', adminHeaders], [username, userHeaders]] as const) {
      const upload = await router.handle(snapshotRequest('upload', owner, headers))
      expect(upload.status).toBe(200)
      expect(await getUserSpace(owner).listManage.getSnapshot('uploaded')).toEqual(uploadedData)

      const restore = await router.handle(snapshotRequest('restore', owner, headers))
      expect(restore.status).toBe(200)
      expect(getDb().query('SELECT latest_id FROM snapshot_meta WHERE user_name = ?').get(owner))
        .toEqual({ latest_id: 'original' })

      const remove = await router.handle(snapshotRequest('delete', owner, headers))
      expect(remove.status).toBe(409)
      expect(await getUserSpace(owner).listManage.getSnapshot('original')).toEqual(initialData)

      // Non-current history remains removable.
      const deleteHistory = await router.handle(new Request(`http://localhost/api/data/delete-snapshot?user=${owner}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'uploaded' }),
      }))
      expect(deleteHistory.status).toBe(200)
      expect(await getUserSpace(owner).listManage.getSnapshot('uploaded')).toBeNull()
    }
    expect((await router.handle(snapshotRequest('upload', 'another_user', userHeaders))).status).toBe(403)
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

    const save = await router.handle(new Request('http://localhost/api/user/list', {
      method: 'POST',
      headers: { ...userHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(savedData),
    }))
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

    const add = await router.handle(new Request('http://localhost/api/music/user/list/add', {
      method: 'POST',
      headers: { ...userHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ listId: 'love', musicInfos: [song] }),
    }))
    expect(add.status).toBe(200)

    // A refresh creates a new in-memory user space, so this verifies the
    // actual favorite-button write path rather than only the full-save route.
    releaseUserSpace(username, true)
    const read = await router.handle(new Request('http://localhost/api/user/list', { headers: userHeaders }))
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ defaultList: [], loveList: [song], userList: [] })
  })

  test('bounds imported history and protects the current snapshot across a user-space reload', async () => {
    const manager = getUserSpace(username).listManage
    for (let index = 0; index < 12; index++) {
      await manager.saveSnapshotWithTime(
        `history-${index}`,
        JSON.stringify({ ...initialData, userList: [{ id: `song-${index}`, name: `History ${index}`, list: [] }] }),
        Date.now() + index,
      )
    }

    const retained = await manager.getSnapshotList()
    expect(retained.length).toBeLessThanOrEqual(10)
    expect(retained.some(item => item.id === 'history-11')).toBe(true)

    await manager.restoreSnapshot('history-11')
    const savedData = await manager.getListData()
    await expect(manager.removeSnapshot('history-11')).rejects.toThrow('不能删除当前使用的快照')
    const latest = getDb().query<{ latest_id: string }, [string, string]>(
      'SELECT latest_id FROM snapshot_meta WHERE user_name = ? AND module = ?'
    ).get(username, 'list')
    expect(latest?.latest_id).toBe('history-11')
    releaseUserSpace(username, true)
    expect(await getUserSpace(username).listManage.getListData()).toEqual(savedData)
  })

  test('rejects an import atomically when the current snapshot fills the configured limit', async () => {
    global.lx.config.users[0].maxSnapshotNum = 1
    const manager = getUserSpace(username).listManage
    const current = await manager.createSnapshot()
    const before = getDb().query('SELECT * FROM snapshots WHERE user_name = ?').all(username)
    const router = createUserRouter()
    const response = await router.handle(snapshotRequest('upload', username, userHeaders))
    expect(response.status).toBe(409)
    expect((await response.json() as { message: string }).message).toContain('快照保留空间不足')
    expect(getDb().query('SELECT * FROM snapshots WHERE user_name = ?').all(username)).toEqual(before)
    for (let read = 0; read < 2; read++) expect((await manager.getSnapshotList()).map(row => row.id)).toEqual([current])
    releaseUserSpace(username, true)
    expect(await getUserSpace(username).listManage.getListData()).toEqual(initialData)

    // With enough capacity the same upload survives subsequent list pruning.
    global.lx.config.users[0].maxSnapshotNum = 2
    expect((await router.handle(snapshotRequest('upload', username, userHeaders))).status).toBe(200)
    const reloaded = getUserSpace(username).listManage
    for (let read = 0; read < 2; read++) expect((await reloaded.getSnapshotList()).map(row => row.id)).toContain('uploaded')
    expect(await reloaded.getSnapshot('uploaded')).toEqual(uploadedData)
  })

  test('rejects importing different data over the current snapshot identifier', async () => {
    const manager = getUserSpace(username).listManage
    const current = await manager.createSnapshot()
    await expect(manager.saveSnapshotWithTime(current, JSON.stringify(uploadedData), 1)).rejects.toThrow('不能覆盖当前使用的快照')
    releaseUserSpace(username, true)
    expect(await getUserSpace(username).listManage.getListData()).toEqual(initialData)
  })

  test('keeps an imported snapshot whose timestamp predates the whole history', async () => {
    const manager = getUserSpace(username).listManage
    const payload = JSON.stringify({ ...initialData, userList: [{ id: 'kept', name: 'Kept', locationUpdateTime: null, list: [] }] })
    for (let index = 0; index < 12; index++) {
      await manager.saveSnapshotWithTime(`recent-${index}`, payload, Date.now() - 60_000 + index)
    }
    expect((await manager.getSnapshotList()).length).toBe(10)

    // A backup file's mtime is usually older than every stored snapshot.
    await manager.saveSnapshotWithTime('imported-old-backup', payload, 1)

    const retained = await manager.getSnapshotList()
    expect(retained.some(item => item.id === 'imported-old-backup')).toBe(true)
    expect(retained.length).toBe(10)
    // Display order still uses the file timestamp, so it shows up as the oldest.
    expect(retained[retained.length - 1].id).toBe('imported-old-backup')
  })

  test('pruning never deletes data just because its created_at is old once stored', async () => {
    const manager = getUserSpace(username).listManage
    // Repeated read paths also prune; the imported row must survive them all.
    await manager.saveSnapshotWithTime('imported-old-backup', JSON.stringify(uploadedData), 1)
    for (let index = 0; index < 3; index++) await manager.getSnapshotList()
    expect((await manager.getSnapshotList()).some(item => item.id === 'imported-old-backup')).toBe(true)
  })

  test('public library writes require an administrator while personal libraries remain writable', async () => {
    const router = createUserRouter()
    for (const type of ['artists', 'albums']) {
      const original = [{ id: 'saved-item', name: 'Saved' }]
      getDb().run('INSERT INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
        ['_open', `library_${type}`, JSON.stringify(original), Date.now()])
      const write = (owner: string, headers: Record<string, string>, body: unknown = []) => router.handle(
        new Request(`http://localhost/api/user/library/${type}?user=${owner}`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
        }))
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
    const write = (owner: string, headers: Record<string, string>) => router.handle(
      new Request(`http://localhost/api/user/sound-effects?user=${owner}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
    )

    expect((await write('_open', {})).status).toBe(403)
    expect((await write('_open', userHeaders)).status).toBe(403)
    expect((await write('_open', adminHeaders)).status).toBe(200)
    expect((await write(username, userHeaders)).status).toBe(200)
  })
})

describe('Deleted account credentials', () => {
  let previousLx: typeof global.lx
  let tempDir: string
  const username = 'deleted_account'
  let adminHeaders: Record<string, string>

  beforeEach(async () => {
    previousLx = global.lx
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-account-test-'))
    closeDb()
    initDatabase(':memory:')
    global.lx = {
      dataPath: tempDir,
      userPath: tempDir,
      config: {
        users: [{ name: username, password: 'old-password' }],
        'frontend.password': 'account-admin',
      },
    } as typeof global.lx
    await syncUsersToDatabase(global.lx.config.users)
    adminHeaders = { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`, 'content-type': 'application/json' }
  })

  afterEach(async () => {
    revokeUserAuth(username)
    releaseUserSpace(username, true)
    await downloadQueue.removeUser(username)
    await new Promise(resolve => setTimeout(resolve, 220))
    closeDb()
    global.lx = previousLx
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const deleteAccount = (deleteData: boolean) => createUserRouter().handle(new Request('http://localhost/api/users', {
    method: 'DELETE', headers: adminHeaders, body: JSON.stringify({ name: username, deleteData }),
  }))

  const seedUserData = () => {
    const now = Date.now()
    getDb().run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['pre-delete', username, 'list', JSON.stringify({ defaultList: [], loveList: [], userList: [] }), 40, now, now],
    )
    getDb().run(
      'INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
      [username, 'pref', '"kept"', now],
    )
  }

  const countRows = () => ({
    snapshots: Number(getDb().query<{ c: number }, [string]>('SELECT COUNT(*) c FROM snapshots WHERE user_name = ?').get(username)?.c ?? 0),
    settings: Number(getDb().query<{ c: number }, [string]>('SELECT COUNT(*) c FROM user_settings WHERE user_name = ?').get(username)?.c ?? 0),
    users: Number(getDb().query<{ c: number }, [string]>('SELECT COUNT(*) c FROM users WHERE name = ?').get(username)?.c ?? 0),
    sessions: Number(getDb().query<{ c: number }, [string]>('SELECT COUNT(*) c FROM user_sessions WHERE user_name = ?').get(username)?.c ?? 0),
  })

  test('deleting an account keeps its playlists unless deleteData is set', async () => {
    seedUserData()
    const response = await deleteAccount(false)
    expect(response.status).toBe(200)
    const body = await response.json() as { dataPreserved?: string[] }
    expect(body.dataPreserved).toEqual([username])
    // Account gone (login must not be revived) but structured data kept.
    expect(countRows()).toEqual({ snapshots: 1, settings: 1, users: 0, sessions: 0 })
  })

  test('deleting an account with deleteData wipes playlists and settings', async () => {
    seedUserData()
    const response = await deleteAccount(true)
    expect(response.status).toBe(200)
    const body = await response.json() as { dataPreserved?: string[] }
    expect(body.dataPreserved).toBeUndefined()
    expect(countRows()).toEqual({ snapshots: 0, settings: 0, users: 0, sessions: 0 })
  })

  test('deletion drains active downloads, rejects recreation during cleanup and removes old tasks', async () => {
    const checkCache = spyOn(fileCache, 'checkCache').mockReturnValue({ exists: false } as any)
    let settle!: () => void
    const pending = new Promise<void>(resolve => { settle = resolve })
    try {
      downloadQueue.initialize(async () => { await pending; return { url: 'https://example.com/audio.mp3' } })
      downloadQueue.enqueue(username, [{ songInfo: { id: 'old-account-download' } }])
      const router = createUserRouter()
      let deleted = false
      const removal = router.handle(new Request('http://localhost/api/users', {
        method: 'DELETE', headers: adminHeaders, body: JSON.stringify({ name: username }),
      })).then(response => { deleted = true; return response })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(deleted).toBe(false)
      expect((await router.handle(new Request('http://localhost/api/users', {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: username, password: 'new-password' }),
      }))).status).toBe(409)
      settle()
      expect((await removal).status).toBe(200)
      expect(downloadQueue.list(username)).toEqual([])
      expect((await router.handle(new Request('http://localhost/api/users', {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: username, password: 'new-password' }),
      }))).status).toBe(200)
      expect(downloadQueue.list(username)).toEqual([])
    } finally {
      settle()
      checkCache.mockRestore()
    }
  })

  test('deleting and recreating an account does not revive old sessions', async () => {
    const auth = createAuthRouter()
    const login = await auth.handle(new Request('http://localhost/api/user/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'old-password' }),
    }))
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const sessionToken = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
    const cookieRequest = new Request('http://localhost/api/user/auth/verify', { headers: { cookie } })
    expect(verifyUserAuth(cookieRequest)).toBe(username)

    const users = createUserRouter()
    const deleted = await users.handle(new Request('http://localhost/api/users', {
      method: 'DELETE', headers: adminHeaders, body: JSON.stringify({ name: username }),
    }))
    expect(deleted.status).toBe(200)
    expect(userSessions.has(sessionToken)).toBe(false)
    expect(getDb().query('SELECT * FROM user_sessions WHERE user_name = ?').all(username)).toEqual([])
    expect(verifyUserAuth(cookieRequest)).toBeNull()
    expect(getDb().query('SELECT * FROM user_settings WHERE user_name = ?').all(username)).toEqual([])

    const recreated = await users.handle(new Request('http://localhost/api/users', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: username, password: 'new-password' }),
    }))
    expect(recreated.status).toBe(200)
    expect(verifyUserAuth(cookieRequest)).toBeNull()
    userSessions.clear()
    expect(verifyUserAuth(cookieRequest)).toBeNull()
    expect((await auth.handle(new Request('http://localhost/api/user/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'new-password' }),
    }))).status).toBe(200)
  }, 15_000)

  test('changing a password revokes the account’s existing sessions', async () => {
    const auth = createAuthRouter()
    const login = (password: string) => auth.handle(new Request('http://localhost/api/user/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }))
    const firstLogin = await login('old-password')
    expect(firstLogin.status).toBe(200)
    const cookie = firstLogin.headers.get('set-cookie')!.split(';')[0]
    const authenticated = new Request('http://localhost/api/user/auth/verify', { headers: { cookie } })
    expect(verifyUserAuth(authenticated)).toBe(username)

    const changed = await createUserRouter().handle(new Request('http://localhost/api/users', {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ name: username, password: 'new-password' }),
    }))
    expect(changed.status).toBe(200)
    expect(verifyUserAuth(authenticated)).toBeNull()
    expect(getDb().query('SELECT * FROM user_sessions WHERE user_name = ?').all(username)).toEqual([])
    expect((await login('old-password')).status).toBe(401)
    expect((await login('new-password')).status).toBe(200)
  })

  test('authentication rejects cached and persisted sessions for users removed from configuration', async () => {
    const login = await createAuthRouter().handle(new Request('http://localhost/api/user/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'old-password' }),
    }))
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
