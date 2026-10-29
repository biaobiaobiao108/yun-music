import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { closeDb, getDatabaseStorageStats, getDb, initDatabase, vacuumDatabase } from '../src/database'
import { hashUserPassword, syncUsersToDatabase, verifyUserPassword } from '../src/user/data'

let testDbPath = ''
let testDataDir = ''

describe('Database (bun:sqlite) Structured Storage', () => {
  beforeEach(() => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-yin-database-test-'))
    ;(global as any).lx = {
      dataPath: testDataDir,
      config: {
        maxSnapshotNum: 5,
        'list.addMusicLocationType': 'bottom',
        users: [{ name: 'testuser', password: 'pwd', maxSnapshotNum: 5, 'list.addMusicLocationType': 'bottom' }],
      },
    }
    closeDb()
    testDbPath = path.join(testDataDir, 'yun-yin.db')
    initDatabase(testDbPath)
  })

  afterEach(() => {
    closeDb()
    if (testDataDir) fs.rmSync(testDataDir, { recursive: true, force: true })
    testDbPath = ''
    testDataDir = ''
  })

  it('should initialize tables with foreign keys and WAL mode', () => {
    const db = getDb()
    const journalMode = db.query('PRAGMA journal_mode;').get() as any
    expect(journalMode?.journal_mode.toLowerCase()).toBe('wal')
    const sessionSchema = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_sessions'")
      .get() as { sql?: string }
    expect(sessionSchema.sql).toContain('FOREIGN KEY (user_name) REFERENCES users(name)')
  })

  it('migrates legacy cache sizes across multiple pages', () => {
    const db = getDb()
    db.run('DROP TABLE cache_index')
    db.run(`CREATE TABLE cache_index (
      location TEXT NOT NULL, user_name TEXT NOT NULL, folder TEXT NOT NULL,
      song_id TEXT NOT NULL, quality TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (location, user_name, folder, song_id, quality)
    )`)
    const insert = db.prepare('INSERT INTO cache_index VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < 600; index++) {
      insert.run(
        'root',
        'user',
        'cache',
        String(index),
        'flac',
        index === 300 ? '{' : JSON.stringify({ size: index + 1, lyricSize: index + 2 }),
        0,
      )
    }
    insert.finalize()
    db.run('PRAGMA user_version = 3')
    closeDb()

    const migrated = initDatabase(testDbPath)
    const read = migrated.prepare<{ audio_size: number; lyric_size: number }, [string]>(
      'SELECT audio_size, lyric_size FROM cache_index WHERE song_id = ?',
    )
    expect(read.get('0')).toEqual({ audio_size: 1, lyric_size: 2 })
    expect(read.get('300')).toEqual({ audio_size: 0, lyric_size: 0 })
    expect(read.get('599')).toEqual({ audio_size: 600, lyric_size: 601 })
    read.finalize()
  })

  it('should CRUD user records', async () => {
    const db = getDb()
    const now = Date.now()
    db.run(
      'INSERT OR REPLACE INTO users (name, password_hash, max_snapshot_num, add_music_location_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['alice', await hashUserPassword('secret'), 10, 'top', now, now],
    )

    const user = db.query('SELECT name, password_hash, max_snapshot_num FROM users WHERE name = ?').get('alice') as any

    expect(user).toBeDefined()
    expect(user?.name).toBe('alice')
    expect(user?.password_hash).not.toBe('secret')
    expect(await verifyUserPassword(user?.password_hash, 'secret')).toBe(true)
    expect(user?.max_snapshot_num).toBe(10)
  })

  it('should store and query snapshots correctly', () => {
    const db = getDb()
    const now = Date.now()
    const testData = JSON.stringify({ defaultList: [], userList: [] })
    db.run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['snap_1', 'alice', 'list', testData, testData.length, now],
    )

    const snap = db
      .query('SELECT id, data FROM snapshots WHERE user_name = ? AND module = ? AND id = ?')
      .get('alice', 'list', 'snap_1') as any

    expect(snap).toBeDefined()
    expect(snap?.id).toBe('snap_1')
    expect(JSON.parse(snap.data)).toEqual({ defaultList: [], userList: [] })
  })

  it('refreshes Web user metadata without persisting passwords', async () => {
    const db = getDb()
    const users = [
      { name: 'paired_user', password: 'secret', maxSnapshotNum: 5, dataPath: path.join(testDataDir, 'paired_user') },
    ]
    await syncUsersToDatabase(users)
    db.run('UPDATE users SET created_at = 123 WHERE name = ?', ['paired_user'])

    users[0].maxSnapshotNum = 20
    await syncUsersToDatabase([
      ...users,
      { name: 'new_user', password: 'another', maxSnapshotNum: 10, dataPath: path.join(testDataDir, 'new_user') },
    ])
    await syncUsersToDatabase(users)

    const persisted = db
      .query('SELECT created_at, max_snapshot_num, password_hash FROM users WHERE name = ?')
      .get('paired_user') as any
    expect(persisted?.created_at).toBe(123)
    expect(persisted?.max_snapshot_num).toBe(20)
    expect(persisted?.password_hash).not.toBe('secret')
    expect(await verifyUserPassword(persisted?.password_hash, 'secret')).toBe(true)
    expect(db.query('SELECT name FROM users WHERE name = ?').get('new_user')).toEqual({ name: 'new_user' })
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('devices', 'device_snapshot_state')")
        .all(),
    ).toEqual([])
  })

  it('should store and query user_settings and cache_index', () => {
    const db = getDb()
    const now = Date.now()

    db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
      'alice',
      'theme',
      JSON.stringify({ dark: true }),
      now,
    ])

    const setting = db
      .query('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
      .get('alice', 'theme') as any

    expect(setting).toBeDefined()
    expect(JSON.parse(setting.value)).toEqual({ dark: true })

    const cacheItem = { id: 'song_123', name: 'Test Song', singer: 'Singer', quality: '320k' }
    db.run(
      'INSERT OR REPLACE INTO cache_index (location, user_name, folder, song_id, quality, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['root', 'alice', 'cache', 'song_123', '320k', JSON.stringify(cacheItem), now],
    )

    const cacheRow = db
      .query(
        'SELECT data FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? AND quality = ?',
      )
      .get('root', 'alice', 'cache', 'song_123', '320k') as any

    expect(cacheRow).toBeDefined()
    expect(JSON.parse(cacheRow.data)).toEqual(cacheItem)
  })

  it('should report SQLite storage usage and compact free pages on demand', () => {
    const db = getDb()
    const payload = 'x'.repeat(128 * 1024)
    const now = Date.now()
    db.run(
      'INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['large_snapshot', 'testuser', 'list', payload, payload.length, now],
    )
    const beforeDelete = getDatabaseStorageStats()
    db.run('DELETE FROM snapshots WHERE id = ?', ['large_snapshot'])
    const result = vacuumDatabase()

    expect(beforeDelete.totalBytes).toBeGreaterThan(0)
    expect(result.after.totalBytes).toBeGreaterThan(0)
    expect(result.after.freeBytes).toBeLessThanOrEqual(result.before.freeBytes)
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(0)
  })
})
