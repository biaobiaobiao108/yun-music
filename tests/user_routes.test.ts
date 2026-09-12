import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, getDb, initDatabase } from '@/database'
import { getUserDirname, getUserSpace, releaseUserSpace, syncUsersToDatabase } from '@/user'
import { createUserRouter } from '@/server/routes/user'
import { createAuthRouter, revokeUserAuth, userSessions, verifyUserAuth } from '@/server/routes/auth'
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession } from '@/server/auth'

describe('User snapshot permissions', () => {
  let previousLx: typeof global.lx
  const username = 'snapshot_owner'
  const sessionToken = 'snapshot-owner-session'
  const initialData = { defaultList: [], loveList: [], userList: [] }
  const uploadedData = { ...initialData, userList: [{ id: 'playlist', name: 'Uploaded', list: [] }] }
  const userHeaders = { cookie: `lx_user_session=${sessionToken}` }
  let adminHeaders: Record<string, string>

  beforeEach(async () => {
    previousLx = global.lx
    closeDb()
    initDatabase(':memory:')
    global.lx = {
      userPath: process.cwd(),
      config: {
        users: [{ name: username, password: 'password' }],
        'frontend.password': 'snapshot-admin',
        'user.enablePublicFavorites': true,
        'user.enablePublicNonAdminAccess': true,
        'user.enablePublicRestriction': true,
      },
    } as typeof global.lx
    syncUsersToDatabase(global.lx.config.users)
    adminHeaders = { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}` }
    userSessions.set(sessionToken, { username, createdAt: Date.now() })
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
      expect(remove.status).toBe(200)
      expect(await getUserSpace(owner).listManage.getSnapshot('original')).toBeNull()
    }
    expect((await router.handle(snapshotRequest('upload', 'another_user', userHeaders))).status).toBe(403)
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
})

describe('Deleted account credentials', () => {
  let previousLx: typeof global.lx
  let tempDir: string
  const username = 'deleted_account'
  let adminHeaders: Record<string, string>

  beforeEach(() => {
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
    syncUsersToDatabase(global.lx.config.users)
    adminHeaders = { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`, 'content-type': 'application/json' }
  })

  afterEach(() => {
    revokeUserAuth(username)
    releaseUserSpace(username, true)
    closeDb()
    global.lx = previousLx
    // Only these files/directories are created by the account routes in this fixture.
    const userDir = path.join(tempDir, getUserDirname(username))
    if (fs.existsSync(userDir)) fs.rmdirSync(userDir)
    const usersFile = path.join(tempDir, 'users.json')
    if (fs.existsSync(usersFile)) fs.unlinkSync(usersFile)
    fs.rmdirSync(tempDir)
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
