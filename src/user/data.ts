import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { filterFileName, toMD5 } from '@/utils'
import { getDb } from '@/database'
import { assertSafePathSegment } from '@/utils/pathSecurity'

export interface ServerInfo {
  serverId: string
  version: number
}

export const getUserDirname = (userName: string): string => {
  if (userName === '_open') return '_open'
  assertSafePathSegment(userName, 'user name')
  return `${filterFileName(userName)}_${toMD5(userName).substring(0, 6)}`
}

const PASSWORD_HASH_PREFIX = 'scrypt$'
const STORED_PASSWORD_HASH_PATTERN = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i

const validateStoredUserRow = (row: {
  name: string
  password_hash: string
  max_snapshot_num: number
  add_music_location_type: string
}): void => {
  if (row.name === '_open') throw new Error('SQLite 用户表包含系统保留用户')
  try {
    assertSafePathSegment(row.name, 'user name')
  } catch {
    throw new Error('SQLite 用户表包含不合法的用户名')
  }
  if (typeof row.password_hash !== 'string' || !STORED_PASSWORD_HASH_PATTERN.test(row.password_hash)) {
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
export const hashUserPassword = (password: string): string => {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    throw new Error('用户密码长度必须在 1 到 1024 个字符之间')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const digest = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${PASSWORD_HASH_PREFIX}${salt}$${digest}`
}

export const verifyUserPassword = (passwordHash: string | undefined, password: unknown): boolean => {
  if (!passwordHash || typeof password !== 'string' || !passwordHash.startsWith(PASSWORD_HASH_PREFIX)) return false
  const [, salt, expectedHex] = passwordHash.split('$')
  if (!/^[a-f0-9]{32}$/i.test(salt) || !/^[a-f0-9]{128}$/i.test(expectedHex) || password.length > 1024) return false
  try {
    const actual = crypto.scryptSync(password, salt, 64)
    const expected = Buffer.from(expectedHex, 'hex')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** 将运行时配置中的 Web 用户同步到 SQLite；只写入密码哈希。 */
export const syncUsersToDatabase = (
  users: LX.Config['users'],
  options: { removeMissing?: boolean } = {},
): void => {
  if (!Array.isArray(users)) throw new Error('用户配置格式无效')
  const db = getDb()
  const now = Date.now()
  const existingRows = db.query<{ name: string; password_hash: string }, []>('SELECT name, password_hash FROM users').all()
  const existingHashes = new Map(existingRows.map(row => [row.name, row.password_hash]))
  // Compute credentials before entering the transaction. A failed transaction
  // must not leave the in-memory config with passwords cleared or newly hashed.
  const preparedUsers = users.map(user => {
    if (user.name === '_open') throw new Error('该用户名为系统保留名称')
    assertSafePathSegment(user.name, 'user name')
    const maxSnapshotNum = user.maxSnapshotNum ?? 10
    const addMusicLocationType = user['list.addMusicLocationType'] ?? 'bottom'
    if (!Number.isInteger(maxSnapshotNum) || maxSnapshotNum < 1 || maxSnapshotNum > 10000) {
      throw new Error(`用户 ${user.name} 的快照数量配置无效`)
    }
    if (addMusicLocationType !== 'top' && addMusicLocationType !== 'bottom') {
      throw new Error(`用户 ${user.name} 的歌单配置无效`)
    }
    const passwordHash = user.passwordHash || (user.password ? hashUserPassword(user.password) : existingHashes.get(user.name))
    if (typeof passwordHash !== 'string' || !STORED_PASSWORD_HASH_PATTERN.test(passwordHash)) {
      throw new Error(`用户 ${user.name} 缺少有效密码`)
    }
    return { user, passwordHash, maxSnapshotNum, addMusicLocationType }
  })
  const currentNames = new Set(preparedUsers.map(({ user }) => user.name))
  db.transaction(() => {
    if (options.removeMissing) {
      for (const row of existingRows) {
        if (row.name === '_open' || currentNames.has(row.name)) continue
        db.run('DELETE FROM snapshots WHERE user_name = ?', [row.name])
        db.run('DELETE FROM snapshot_meta WHERE user_name = ?', [row.name])
        db.run('DELETE FROM user_settings WHERE user_name = ?', [row.name])
        db.run('DELETE FROM user_sessions WHERE user_name = ?', [row.name])
        db.run('DELETE FROM cache_index WHERE user_name = ?', [row.name])
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

  if (rows.length === 0) {
    syncUsersToDatabase(bootstrapUsers)
    return
  }

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
  global.lx.config.users = rows.map(row => ({
    ...configuredByName.get(row.name),
    name: row.name,
    password: '',
    passwordHash: row.password_hash,
    maxSnapshotNum: row.max_snapshot_num,
    'list.addMusicLocationType': row.add_music_location_type as LX.AddMusicLocationType,
    dataPath: path.join(global.lx.userPath, getUserDirname(row.name)),
  }))
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

/** 删除用户的全部结构化业务数据和用户目录。 */
export const deleteUserDataFromDatabase = (userName: string): void => {
  const db = getDb()
  db.transaction(() => {
    db.run('DELETE FROM snapshots WHERE user_name = ?', [userName])
    db.run('DELETE FROM snapshot_meta WHERE user_name = ?', [userName])
    db.run('DELETE FROM user_settings WHERE user_name = ?', [userName])
    db.run('DELETE FROM user_sessions WHERE user_name = ?', [userName])
    db.run('DELETE FROM cache_index WHERE user_name = ?', [userName])
    db.run('DELETE FROM users WHERE name = ?', [userName])
  })()
}

export const getUserConfig = (userName: string): Required<LX.User> => {
  const row = getDb().query<{
    name: string
    password_hash: string
    max_snapshot_num: number
    add_music_location_type: string
  }, [string]>('SELECT name, password_hash, max_snapshot_num, add_music_location_type FROM users WHERE name = ?').get(userName)

  const user = global.lx.config.users?.find(item => item.name === userName)
  if (row) validateStoredUserRow(row)
  if (!user && !row && userName === '_open') {
    return {
      name: '_open',
      password: '',
      passwordHash: '',
      maxSnapshotNum: global.lx.config.maxSnapshotNum,
      'list.addMusicLocationType': global.lx.config['list.addMusicLocationType'],
    }
  }
  if (!user && !row) throw new Error(`user not found: ${userName}`)
  return {
    name: user?.name ?? row!.name,
    password: '',
    passwordHash: user?.passwordHash ?? row?.password_hash ?? '',
    maxSnapshotNum: row?.max_snapshot_num ?? user?.maxSnapshotNum ?? global.lx.config.maxSnapshotNum,
    'list.addMusicLocationType': (row?.add_music_location_type ?? user?.['list.addMusicLocationType'] ?? global.lx.config['list.addMusicLocationType']) as LX.AddMusicLocationType,
  }
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
  try {
    if (shouldMoveDirectory) {
      fs.renameSync(oldDirPath, newDirPath)
      moved = true
    }

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
