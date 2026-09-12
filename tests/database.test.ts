import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { randomUUID } from 'crypto'
import { initDatabase, getDb, closeDb } from '../src/database'
import { syncUsersToDatabase } from '../src/user/data'

let testDbPath = ''

describe('Database (bun:sqlite) Structured Storage', () => {
  beforeEach(() => {
    const dataDir = path.join(process.cwd(), 'data')
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
    ;(global as any).lx = {
      dataPath: dataDir,
      config: {
        maxSnapshotNum: 5,
        'list.addMusicLocationType': 'bottom',
        users: [{ name: 'testuser', password: 'pwd', maxSnapshotNum: 5, 'list.addMusicLocationType': 'bottom' }],
      },
    }
    testDbPath = path.join(dataDir, `lx-test-${randomUUID()}.db`)
    initDatabase(testDbPath)
  })

  afterEach(() => {
    closeDb()
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath)
      const wal = testDbPath + '-wal'
      const shm = testDbPath + '-shm'
      if (fs.existsSync(wal)) fs.unlinkSync(wal)
      if (fs.existsSync(shm)) fs.unlinkSync(shm)
    } catch {}
  })

  it('should initialize tables with foreign keys and WAL mode', () => {
    const db = getDb()
    const journalMode = db.query('PRAGMA journal_mode;').get() as any
    expect(journalMode?.journal_mode.toLowerCase()).toBe('wal')
  })

  it('should CRUD user records', () => {
    const db = getDb()
    const now = Date.now()
    db.run(
      'INSERT OR REPLACE INTO users (name, password, max_snapshot_num, add_music_location_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['alice', 'secret', 10, 'top', now, now]
    )

    const user = db.query('SELECT name, password, max_snapshot_num FROM users WHERE name = ?').get('alice') as any

    expect(user).toBeDefined()
    expect(user?.name).toBe('alice')
    expect(user?.password).toBe('secret')
    expect(user?.max_snapshot_num).toBe(10)
  })

  it('should store and query snapshots correctly', () => {
    const db = getDb()
    const now = Date.now()
    const testData = JSON.stringify({ defaultList: [], userList: [] })
    db.run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['snap_1', 'alice', 'list', testData, testData.length, now]
    )

    const snap = db.query('SELECT id, data FROM snapshots WHERE user_name = ? AND module = ? AND id = ?').get('alice', 'list', 'snap_1') as any

    expect(snap).toBeDefined()
    expect(snap?.id).toBe('snap_1')
    expect(JSON.parse(snap.data)).toEqual({ defaultList: [], userList: [] })
  })

  it('refreshes Web user metadata without persisting passwords', () => {
    const db = getDb()
    const users = [{ name: 'paired_user', password: 'secret', maxSnapshotNum: 5 }]
    syncUsersToDatabase(users)
    db.run('UPDATE users SET created_at = 123 WHERE name = ?', ['paired_user'])

    users[0].maxSnapshotNum = 20
    syncUsersToDatabase([...users, { name: 'new_user', password: 'another', maxSnapshotNum: 10 }])
    syncUsersToDatabase(users)

    expect(db.query('SELECT created_at, max_snapshot_num, password FROM users WHERE name = ?').get('paired_user'))
      .toEqual({ created_at: 123, max_snapshot_num: 20, password: '' })
    expect(db.query('SELECT name FROM users WHERE name = ?').get('new_user')).toEqual({ name: 'new_user' })
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('devices', 'device_snapshot_state')").all()).toEqual([])
  })

  it('should store and query user_settings and cache_index', () => {
    const db = getDb()
    const now = Date.now()

    db.run(
      'INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
      ['alice', 'theme', JSON.stringify({ dark: true }), now]
    )

    const setting = db.query('SELECT value FROM user_settings WHERE user_name = ? AND key = ?').get('alice', 'theme') as any

    expect(setting).toBeDefined()
    expect(JSON.parse(setting.value)).toEqual({ dark: true })

    const cacheItem = { id: 'song_123', name: 'Test Song', singer: 'Singer', quality: '320k' }
    db.run(
      'INSERT OR REPLACE INTO cache_index (location, user_name, folder, song_id, quality, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['root', 'alice', 'cache', 'song_123', '320k', JSON.stringify(cacheItem), now]
    )

    const cacheRow = db.query('SELECT data FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? AND quality = ?').get('root', 'alice', 'cache', 'song_123', '320k') as any

    expect(cacheRow).toBeDefined()
    expect(JSON.parse(cacheRow.data)).toEqual(cacheItem)
  })
})
