import { Database } from 'bun:sqlite'
import path from 'node:path'
import fs from 'node:fs'

let dbInstance: Database | null = null

export const getDbPath = (): string => {
  const dataPath = global.lx?.dataPath ?? path.join(process.cwd(), 'data')
  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(dataPath, { recursive: true })
  }
  return path.join(dataPath, 'lxserver.db')
}

export const initDatabase = (customDbPath?: string): Database => {
  if (dbInstance) return dbInstance

  const dbPath = customDbPath ?? getDbPath()
  const db = new Database(dbPath, { create: true })

  const existingTables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(row => row.name)
  const currentVersion = Number(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0)
  if (currentVersion !== 0 && currentVersion !== 3) {
    db.close()
    throw new Error('数据库版本不兼容，请先执行 bun run reset:instance')
  }
  if (currentVersion === 0 && existingTables.length > 0) {
    db.close()
    throw new Error('检测到旧版同步数据库，请先执行 bun run reset:instance')
  }

  // 启用 WAL 模式和外键支持
  db.run('PRAGMA journal_mode = WAL;')
  db.run('PRAGMA synchronous = NORMAL;')
  db.run('PRAGMA foreign_keys = ON;')

  // 1. 系统元信息表
  db.run(`
    CREATE TABLE IF NOT EXISTS system_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // 2. 用户账户表
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      max_snapshot_num INTEGER DEFAULT 10,
      add_music_location_type TEXT DEFAULT 'bottom',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  // 3. 快照数据表 (歌单、黑名单)
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      module TEXT NOT NULL,
      data TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_name, module, id)
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_snapshots_lookup ON snapshots(user_name, module, created_at DESC);')

  // 4. 快照元信息表 (记录最新快照)
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshot_meta (
      user_name TEXT NOT NULL,
      module TEXT NOT NULL,
      latest_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_name, module)
    );
  `)

  // 5. 用户设置与偏好表 (扩展配置、音效、曲库等)
  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_name, key)
    );
  `)

  // 6. 用户登录会话：仅保存会话 ID 的哈希，支持服务重启后恢复登录
  db.run(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_hash TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_name) REFERENCES users(name) ON DELETE CASCADE
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_created_at ON user_sessions(created_at);')

  // 7. 播放器访问会话：仅保存会话 ID 的哈希，支持服务重启后恢复登录
  db.run(`
    CREATE TABLE IF NOT EXISTS player_sessions (
      session_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_player_sessions_created_at ON player_sessions(created_at);')

  // 8. 缓存与下载元数据索引表
  db.run(`
    CREATE TABLE IF NOT EXISTS cache_index (
      location TEXT NOT NULL,
      user_name TEXT NOT NULL,
      folder TEXT NOT NULL,
      song_id TEXT NOT NULL,
      quality TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (location, user_name, folder, song_id, quality)
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_cache_query ON cache_index(location, user_name, folder, song_id);')

  db.run('PRAGMA user_version = 3')

  dbInstance = db
  stmtCache.clear()
  return db
}

const stmtCache = new Map<string, any>()

/**
 * 获取或缓存已预编译的 SQLite Statement，避免高频调用时的重复 SQL 词法解析与编译开销
 */
export const getDbStatement = <T = any, Params extends any[] = any[]>(sql: string): any => {
  const db = getDb()
  let stmt = stmtCache.get(sql)
  if (!stmt) {
    stmt = (db as any).prepare(sql)
    stmtCache.set(sql, stmt)
  }
  return stmt
}

export const getDb = (): Database => {
  if (!dbInstance) {
    return initDatabase()
  }
  return dbInstance
}

export const closeDb = (): void => {
  if (dbInstance) {
    stmtCache.clear()
    dbInstance.close()
    dbInstance = null
  }
}

/** VACUUM INTO produces a consistent standalone snapshot including committed WAL data. */
export const createDatabaseSnapshot = (destination: string): void => {
  getDb().run('VACUUM INTO ?', [destination])
}

/** Copy known data tables transactionally; never replace an open database or execute backup schema. */
export const restoreDatabaseSnapshot = (sourcePath: string): void => {
  const source = new Database(sourcePath, { readonly: true })
  const target = getDb()
  const tables = ['system_info', 'users', 'snapshots', 'snapshot_meta', 'user_settings', 'player_sessions', 'user_sessions', 'cache_index']
  try {
    source.run('PRAGMA trusted_schema = OFF')
    const check = source.query<{ quick_check: string }, []>('PRAGMA quick_check').get()
    if (check?.quick_check !== 'ok') throw new Error('备份数据库损坏')
    const schemas = tables.map(table => {
      const definition = source.query<{ type: string; sql: string }, [string]>(
        'SELECT type, sql FROM sqlite_master WHERE name = ?'
      ).get(table)
      if (definition?.type !== 'table' || !/^CREATE TABLE\s/i.test(definition.sql)) throw new Error('备份数据库结构不兼容')
      const columns = target.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map(column => column.name)
      const backupColumns = source.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map(column => column.name)
      if (JSON.stringify(columns) !== JSON.stringify(backupColumns)) throw new Error('备份数据库版本不兼容')
      return { table, columns }
    })
    target.transaction(() => {
      for (const table of [...tables].reverse()) target.run(`DELETE FROM "${table}"`)
      for (const { table, columns } of schemas) {
        const names = columns.map(column => `"${column}"`).join(', ')
        const insert = target.prepare(`INSERT INTO "${table}" (${names}) VALUES (${columns.map(() => '?').join(', ')})`)
        try {
          for (const row of source.query<Record<string, any>, []>(`SELECT ${names} FROM "${table}"`).iterate()) {
            insert.run(...columns.map(column => row[column]))
          }
        } finally {
          insert.finalize()
        }
      }
      // Sessions from a historical backup must not revive logged-out credentials.
      target.run('DELETE FROM user_sessions')
      target.run('DELETE FROM player_sessions')
    })()
    stmtCache.clear()
  } finally {
    source.close()
  }
}
