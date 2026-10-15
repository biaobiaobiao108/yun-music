import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb, getDb, initDatabase } from '@/database'
import { getUserSpace, releaseUserSpace, syncUsersToDatabase } from '@/user'
import { createUserRouter } from '@/server/routes/user'
import { createAdminSession } from '@/server/auth'

let previous: typeof global.lx
let directory: string
let cookie: string
beforeEach(() => {
  previous = global.lx
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-playlist-mutations-'))
  closeDb()
  initDatabase(':memory:')
  global.lx = { userPath: directory, config: { users: [{ name: 'playlist_owner', password: 'password' }], 'frontend.password': 'admin' } } as typeof global.lx
  syncUsersToDatabase(global.lx.config.users)
  cookie = `lx_admin_session=${createAdminSession()}`
})
afterEach(() => {
  releaseUserSpace('playlist_owner', true)
  closeDb()
  global.lx = previous
  fs.rmSync(directory, { recursive: true, force: true })
})

test('concurrent playlist intents preserve all lists and unrelated favorites', async () => {
  const router = createUserRouter()
  const post = (body: object, headers = { cookie }) => router.handle(new Request('http://localhost/api/user/playlists?user=playlist_owner', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  const manager = getUserSpace('playlist_owner').listManage
  await manager.listDataManage.restore({ defaultList: [], loveList: [{ id: 'favorite' }], userList: [] } as unknown as LX.List.ListData)
  const responses = await Promise.all(['first', 'second'].map(id => post({ action: 'create', playlist: { id, name: id, list: [], img: 'https://example.com/cover.jpg' } })))
  expect(responses.map(response => response.status)).toEqual([200, 200])
  expect((await post({ action: 'rename', id: 'first', name: 'renamed' })).status).toBe(200)
  let data = await manager.getListData()
  expect(data.userList.map(list => list.name)).toEqual(['renamed', 'second'])
  expect(data.loveList).toEqual([{ id: 'favorite' }] as unknown as LX.Music.MusicInfo[])
  expect(data.userList[0]).toHaveProperty('img', 'https://example.com/cover.jpg')
  expect((await post({ action: 'delete', id: 'first' })).status).toBe(200)
  data = await manager.getListData()
  expect(data.userList.map(list => list.id)).toEqual(['second'])
  expect(data.loveList).toEqual([{ id: 'favorite' }] as unknown as LX.Music.MusicInfo[])
  expect((await post({ action: 'rename', id: 'missing', name: 'x' })).status).toBe(404)
  expect((await post({ action: 'delete', id: 'second' }, { cookie: '' })).status).toBe(401)
})

test('remote playlist toggle acts atomically on its source identity', async () => {
  const router = createUserRouter()
  const playlist = { id: 'remote', name: 'Remote', source: 'wy', sourceListId: '123', list: [] }
  const toggle = (id: string) => router.handle(new Request('http://localhost/api/user/playlists?user=playlist_owner', {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle', playlist: { ...playlist, id } }),
  }))
  const [first, second] = await Promise.all([toggle('a'), toggle('b')])
  expect(await first.json()).toMatchObject({ added: true })
  expect(await second.json()).toMatchObject({ added: false })
  expect((await getUserSpace('playlist_owner').listManage.getListData()).userList).toEqual([])
})

test('invalid list replacements and imported snapshots preserve current favorites', async () => {
  const router = createUserRouter()
  const manager = getUserSpace('playlist_owner').listManage
  const initial: LX.List.ListData = {
    defaultList: [], userList: [],
    loveList: [{ id: 'favorite', name: 'Favorite', singer: 'Singer', source: 'wy', interval: null,
      meta: { songId: 'favorite', albumName: '', qualitys: [], _qualitys: {} } }],
  }
  await manager.listDataManage.restore(initial)
  await manager.createSnapshot()
  const originalSnapshots = await manager.getSnapshotList()
  const invalidBodies = [{}, { ...initial, userList: [{ id: 'broken', name: 'Broken', list: null }] }]
  for (const body of invalidBodies) {
    const response = await router.handle(new Request('http://localhost/api/user/list?user=playlist_owner', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    expect(response.ok).toBe(false)
    expect(await manager.getListData()).toEqual(initial)
    const upload = await router.handle(new Request('http://localhost/api/data/upload-snapshot?user=playlist_owner&filename=invalid', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    expect(upload.ok).toBe(false)
  }
  expect(await manager.getSnapshotList()).toEqual(originalSnapshots)
  // Invalid historical/database data must also be rejected when restoring.
  getDb().run('INSERT INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['invalid', 'playlist_owner', 'list', '{}', 2, Date.now()])
  await expect(manager.restoreSnapshot('invalid')).rejects.toThrow('Snapshot not found')
  expect(await manager.getListData()).toEqual(initial)
})
