import fs from 'node:fs'
import path from 'node:path'
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

/** 将运行时配置中的 Web 用户同步到 SQLite。密码只在运行时配置中使用。 */
export const syncUsersToDatabase = (users: LX.Config['users']): void => {
  const db = getDb()
  const now = Date.now()
  db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO users (name, password, max_snapshot_num, add_music_location_type, created_at, updated_at)
      VALUES (?, '', ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        max_snapshot_num = excluded.max_snapshot_num,
        add_music_location_type = excluded.add_music_location_type,
        updated_at = excluded.updated_at
    `)
    for (const user of users) {
      stmt.run(
        user.name,
        user.maxSnapshotNum ?? 10,
        user['list.addMusicLocationType'] ?? 'bottom',
        now,
        now,
      )
    }
  })()
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
    max_snapshot_num: number
    add_music_location_type: string
  }, [string]>('SELECT name, max_snapshot_num, add_music_location_type FROM users WHERE name = ?').get(userName)

  const user = global.lx.config.users?.find(item => item.name === userName)
  if (!user && !row) throw new Error(`user not found: ${userName}`)
  return {
    name: user?.name ?? row!.name,
    password: user?.password ?? '',
    maxSnapshotNum: row?.max_snapshot_num ?? user?.maxSnapshotNum ?? global.lx.config.maxSnapshotNum,
    'list.addMusicLocationType': (row?.add_music_location_type ?? user?.['list.addMusicLocationType'] ?? global.lx.config['list.addMusicLocationType']) as LX.AddMusicLocationType,
  }
}

/** 重命名用户时同步 SQLite 归属和文件夹；不保留旧客户端设备状态。 */
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
