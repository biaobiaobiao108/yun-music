import fs from 'node:fs'
import path from 'node:path'
import { filterFileName, toMD5 } from '@/utils'
import { getDb } from '@/database'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { moveUserCacheData } from '@/server/fileCache'
import { hashPassword, isPasswordHash, PASSWORD_HASH_PATTERN, verifyPasswordHash } from '@/utils/passwordHash'

export interface ServerInfo {
  serverId: string
  version: number
}

const RESERVED_USER_ALIASES = new Set(['default', 'open', '_open'])
const isReservedUserAlias = (name: string) => RESERVED_USER_ALIASES.has(name.toLowerCase())
const assertPrivateUserNameNotReserved = (name: string) => {
  if (isReservedUserAlias(name)) throw new Error(`用户名 ${name} 为系统保留名称`)
}

export const getUserDirname = (userName: string): string => {
  if (userName === '_open') return '_open'
  assertSafePathSegment(userName, 'user name')
  assertPrivateUserNameNotReserved(userName)
  return `${filterFileName(userName)}_${toMD5(userName).substring(0, 6)}`
}

const validateStoredUserRow = (row: {
  name: string
  password_hash: string
  max_snapshot_num: number
  add_music_location_type: string
}): void => {
  if (isReservedUserAlias(row.name)) throw new Error('SQLite 用户表包含系统保留用户名 default/open/_open')
  try {
    assertSafePathSegment(row.name, 'user name')
  } catch {
    throw new Error('SQLite 用户表包含不合法的用户名')
  }
  if (!isPasswordHash(row.password_hash)) {
    throw new Error('SQLite 用户表包含不合法的密码哈希')
  }
  if (!Number.isInteger(row.max_snapshot_num) || row.max_snapshot_num < 1 || row.max_snapshot_num > 10000) {
    throw new Error('SQLite 用户表包含不合法的快照数量配置')
  }
  if (row.add_music_location_type !== 'top' && row.add_music_location_type !== 'bottom') {
    throw new Error('SQLite 用户表包含不合法的歌单配置')
  }
}

/** 使用 Node/Bun 原生 scrypt 保存 Web 用户密码，避免明文进入配置与数据库。 */
export const hashUserPassword = hashPassword
export const verifyUserPassword = verifyPasswordHash

/** 将运行时配置中的 Web 用户同步到 SQLite；只写入密码哈希。 */
export const syncUsersToDatabase = (
  users: LX.Config['users'],
  options: { removeMissing?: boolean; purgeMissingData?: readonly string[] } = {},
): void => {
  if (!Array.isArray(users)) throw new Error('用户配置格式无效')
  const db = getDb()
  const now = Date.now()
  const existingRows = db.query<{ name: string; password_hash: string }, []>('SELECT name, password_hash FROM users').all()
  for (const row of existingRows) {
    if (isReservedUserAlias(row.name)) throw new Error('SQLite 用户表包含系统保留用户名 default/open/_open')
  }
  const existingHashes = new Map(existingRows.map(row => [row.name, row.password_hash]))
  // Compute credentials before entering the transaction. A failed transaction
  // must not leave the in-memory config with passwords cleared or newly hashed.
  const preparedUsers = users.map(user => {
    assertPrivateUserNameNotReserved(user.name)
    assertSafePathSegment(user.name, 'user name')
    const maxSnapshotNum = user.maxSnapshotNum ?? global.lx.config.maxSnapshotNum ?? 10
    const addMusicLocationType = user['list.addMusicLocationType'] ?? 'bottom'
    if (!Number.isInteger(maxSnapshotNum) || maxSnapshotNum < 1 || maxSnapshotNum > 10000) {
      throw new Error(`用户 ${user.name} 的快照数量配置无效`)
    }
    if (addMusicLocationType !== 'top' && addMusicLocationType !== 'bottom') {
      throw new Error(`用户 ${user.name} 的歌单配置无效`)
    }
    const passwordHash = user.passwordHash || (user.password ? hashUserPassword(user.password) : existingHashes.get(user.name))
    if (typeof passwordHash !== 'string' || !PASSWORD_HASH_PATTERN.test(passwordHash)) {
      throw new Error(`用户 ${user.name} 缺少有效密码`)
    }
    return { user, passwordHash, maxSnapshotNum, addMusicLocationType }
  })
  const currentNames = new Set(preparedUsers.map(({ user }) => user.name))
  // Names whose structured data must be destroyed together with the account.
  // Everything else (e.g. an entry removed by hand from config.js) keeps its
  // playlists and settings: the users row is dropped, but snapshots,
  // snapshot_meta and user_settings stay so that recreating a user with the
  // same name restores them. Deleting them silently was the P0 in CODE_REVIEW.
  const purgeNames = new Set(options.purgeMissingData ?? [])
  db.transaction(() => {
    if (options.removeMissing) {
      for (const row of existingRows) {
        if (row.name === '_open' || currentNames.has(row.name)) continue
        if (purgeNames.has(row.name)) {
          purgeUserRows(db, row.name)
          continue
        }
        // Sessions and the derived cache index never outlive the account.
        db.run('DELETE FROM user_sessions WHERE user_name = ?', [row.name])
        db.run('DELETE FROM cache_index WHERE user_name = ?', [row.name])
        // The users row must always go: keeping it would resurrect a deleted
        // account (and its password) on the next startup.
        db.run('DELETE FROM users WHERE name = ?', [row.name])
      }
    }
    const stmt = db.prepare(`
      INSERT INTO users (name, password_hash, max_snapshot_num, add_music_location_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        password_hash = excluded.password_hash,
        max_snapshot_num = excluded.max_snapshot_num,
        add_music_location_type = excluded.add_music_location_type,
        updated_at = excluded.updated_at
    `)
    try {
      for (const { user, passwordHash, maxSnapshotNum, addMusicLocationType } of preparedUsers) {
        stmt.run(
          user.name,
          passwordHash,
          maxSnapshotNum,
          addMusicLocationType,
          now,
          now,
        )
      }
    } finally {
      stmt.finalize()
    }
  })()

  // Only publish the normalized runtime representation after the DB commit.
  for (const { user, passwordHash } of preparedUsers) {
    user.passwordHash = passwordHash
    user.password = ''
  }
}

/** 启动时以 SQLite 为唯一用户来源；只有全新数据库才使用配置中的初始用户播种。 */
export const initializeUsersFromDatabase = (bootstrapUsers: LX.Config['users']): void => {
  const db = getDb()
  const rows = db.query<{
    name: string
    password_hash: string
    max_snapshot_num: number
    add_music_location_type: string
  }, []>('SELECT name, password_hash, max_snapshot_num, add_music_location_type FROM users ORDER BY name').all()

  const initialized = db.query<{ value: string }, []>("SELECT value FROM system_info WHERE key = 'users_initialized'").get()
  if (rows.length === 0 && !initialized) {
    db.transaction(() => {
      syncUsersToDatabase(bootstrapUsers)
      db.run("INSERT OR REPLACE INTO system_info (key, value) VALUES ('users_initialized', '1')")
    })()
    return
  }
  db.run("INSERT OR REPLACE INTO system_info (key, value) VALUES ('users_initialized', '1')")
  applyUsersFromDatabase(rows, bootstrapUsers)
}

const applyUsersFromDatabase = (rows: Array<{
  name: string
  password_hash: string
  max_snapshot_num: number
  add_music_location_type: string
}>, configuredUsers: LX.Config['users']): void => {
  for (const row of rows) validateStoredUserRow(row)
  const configuredByName = new Map(configuredUsers.map(user => [user.name, user]))
  global.lx.config.users = rows.map(row => {
    const configured = configuredByName.get(row.name)
    const user: LX.Config['users'][number] = {
      ...configured,
      name: row.name,
      password: '',
      passwordHash: row.password_hash,
      'list.addMusicLocationType': row.add_music_location_type as LX.AddMusicLocationType,
      dataPath: path.join(global.lx.userPath, getUserDirname(row.name)),
    }
    // only keep an explicit per-user override. Copying the stored value into
    // the runtime object made `POST /api/config` (global maxSnapshotNum) a
    // no-op for every existing account, because the DB row always won.
    if (configured?.maxSnapshotNum !== undefined) user.maxSnapshotNum = configured.maxSnapshotNum
    else delete user.maxSnapshotNum
    return user
  })
  for (const user of global.lx.config.users) {
    if (user.dataPath && !fs.existsSync(user.dataPath)) fs.mkdirSync(user.dataPath, { recursive: true })
  }
}

/** 从 SQLite 刷新运行时用户列表；与启动初始化不同，不会把旧引导用户重新写回空数据库。 */
export const refreshUsersFromDatabase = (): void => {
  const rows = getDb().query<{
    name: string
    password_hash: string
    max_snapshot_num: number
    add_music_location_type: string
  }, []>('SELECT name, password_hash, max_snapshot_num, add_music_location_type FROM users ORDER BY name').all()
  if (rows.length === 0) {
    global.lx.config.users = []
    return
  }
  applyUsersFromDatabase(rows, global.lx.config.users)
}

/** 在调用方的事务内删除该用户的全部结构化数据（含 users 行）。 */
const purgeUserRows = (db: ReturnType<typeof getDb>, userName: string): void => {
  db.run('DELETE FROM snapshots WHERE user_name = ?', [userName])
  db.run('DELETE FROM snapshot_meta WHERE user_name = ?', [userName])
  db.run('DELETE FROM user_settings WHERE user_name = ?', [userName])
  db.run('DELETE FROM user_sessions WHERE user_name = ?', [userName])
  db.run('DELETE FROM cache_index WHERE user_name = ?', [userName])
  db.run('DELETE FROM users WHERE name = ?', [userName])
}

/**
 * 快照数量上限的解析顺序：用户级显式覆盖 → 全局配置 → 数据库镜像值 → 10。
 *
 * 不抛 "user not found"：账号删除后如果保留了歌单数据（deleteData=false），
 * 之后的历史列表/裁剪仍需要读这个值，否则每次请求都会 500。
 */
export const resolveMaxSnapshotNum = (userName: string, storedValue?: number): number => {
  const user = global.lx.config.users?.find(item => item.name === userName)
  const candidates: Array<number | undefined> = [
    user?.maxSnapshotNum,
    global.lx.config.maxSnapshotNum,
    storedValue,
    10,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 1 && candidate <= 10000) return candidate
  }
  return 10
}

export const getMaxSnapshotNum = (userName: string): number => {
  const row = getDb().query<{ max_snapshot_num: number }, [string]>(
    'SELECT max_snapshot_num FROM users WHERE name = ?'
  ).get(userName)
  return resolveMaxSnapshotNum(userName, row?.max_snapshot_num)
}

/** 重命名用户时同步 SQLite 归属和文件夹；不保留旧协议状态。 */
export const migrateUserData = (oldName: string, newName: string): string => {
  const oldDirPath = path.join(global.lx.userPath, getUserDirname(oldName))
  const newDirPath = path.join(global.lx.userPath, getUserDirname(newName))
  const shouldMoveDirectory = fs.existsSync(oldDirPath)
  if (shouldMoveDirectory && fs.existsSync(newDirPath)) {
    throw new Error('目标用户数据目录已存在，无法安全迁移')
  }

  let moved = false
  let movedCache = false
  try {
    if (shouldMoveDirectory) {
      fs.renameSync(oldDirPath, newDirPath)
      moved = true
    }
    movedCache = moveUserCacheData(oldName, newName).movedDirectories > 0

    const db = getDb()
    const now = Date.now()
    db.transaction(() => {
      // user_sessions references users without ON UPDATE CASCADE. Sessions
      // for a renamed account are intentionally revoked and must be removed
      // before changing the primary key.
      db.run('DELETE FROM user_sessions WHERE user_name = ?', [oldName])
      db.run('UPDATE users SET name = ?, updated_at = ? WHERE name = ?', [newName, now, oldName])
      db.run('UPDATE snapshots SET user_name = ? WHERE user_name = ?', [newName, oldName])
      db.run('UPDATE snapshot_meta SET user_name = ? WHERE user_name = ?', [newName, oldName])
      db.run('UPDATE user_settings SET user_name = ? WHERE user_name = ?', [newName, oldName])
      db.run('UPDATE cache_index SET user_name = ? WHERE user_name = ?', [newName, oldName])
    })()
  } catch (error) {
    if (movedCache) {
      try { moveUserCacheData(newName, oldName) } catch (rollbackError) {
        console.error('[User] 用户缓存迁移回滚失败:', rollbackError)
      }
    }
    if (moved && fs.existsSync(newDirPath) && !fs.existsSync(oldDirPath)) {
      try { fs.renameSync(newDirPath, oldDirPath) } catch (rollbackError) {
        console.error('[User] 用户目录迁移回滚失败:', rollbackError)
      }
    }
    throw error
  }
  return newDirPath
}

export class UserDataManage {
  readonly userName: string
  readonly userDir: string

  constructor(userName: string) {
    this.userName = userName
    this.userDir = path.join(global.lx.userPath, getUserDirname(userName))
  }
}
