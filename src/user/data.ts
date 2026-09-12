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

/** 使用 Node/Bun 原生 scrypt 保存 Web 用户密码，避免明文进入配置与数据库。 */
export const hashUserPassword = (password: string): string => {
  const salt = crypto.randomBytes(16).toString('hex')
  const digest = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${PASSWORD_HASH_PREFIX}${salt}$${digest}`
}

export const verifyUserPassword = (passwordHash: string | undefined, password: unknown): boolean => {
  if (!passwordHash || typeof password !== 'string' || !passwordHash.startsWith(PASSWORD_HASH_PREFIX)) return false
  const [, salt, expectedHex] = passwordHash.split('$')
  if (!salt || !expectedHex || !/^[a-f0-9]+$/i.test(expectedHex)) return false
  try {
    const actual = crypto.scryptSync(password, salt, expectedHex.length / 2)
    const expected = Buffer.from(expectedHex, 'hex')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** 将运行时配置中的 Web 用户同步到 SQLite；只写入密码哈希。 */
export const syncUsersToDatabase = (users: LX.Config['users']): void => {
  const db = getDb()
  const now = Date.now()
  const existingHashes = new Map(db.query<{ name: string; password_hash: string }, []>('SELECT name, password_hash FROM users').all().map(row => [row.name, row.password_hash]))
  db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO users (name, password_hash, max_snapshot_num, add_music_location_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        password_hash = excluded.password_hash,
        max_snapshot_num = excluded.max_snapshot_num,
        add_music_location_type = excluded.add_music_location_type,
        updated_at = excluded.updated_at
    `)
    for (const user of users) {
      const passwordHash = user.passwordHash || (user.password ? hashUserPassword(user.password) : existingHashes.get(user.name))
      if (!passwordHash) throw new Error(`用户 ${user.name} 缺少有效密码`)
      stmt.run(
        user.name,
        passwordHash,
        user.maxSnapshotNum ?? 10,
        user['list.addMusicLocationType'] ?? 'bottom',
        now,
        now,
      )
      user.passwordHash = passwordHash
      user.password = ''
    }
  })()
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

  const configuredByName = new Map(bootstrapUsers.map(user => [user.name, user]))
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
  const db = getDb()
  const now = Date.now()
  db.transaction(() => {
    db.run('UPDATE users SET name = ?, updated_at = ? WHERE name = ?', [newName, now, oldName])
    db.run('UPDATE snapshots SET user_name = ? WHERE user_name = ?', [newName, oldName])
    db.run('UPDATE snapshot_meta SET user_name = ? WHERE user_name = ?', [newName, oldName])
    db.run('UPDATE user_settings SET user_name = ? WHERE user_name = ?', [newName, oldName])
    db.run('UPDATE cache_index SET user_name = ? WHERE user_name = ?', [newName, oldName])
  })()

  const oldDirPath = path.join(global.lx.userPath, getUserDirname(oldName))
  const newDirPath = path.join(global.lx.userPath, getUserDirname(newName))
  if (fs.existsSync(oldDirPath) && !fs.existsSync(newDirPath)) {
    fs.cpSync(oldDirPath, newDirPath, { recursive: true })
    fs.rmSync(oldDirPath, { recursive: true, force: true })
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
