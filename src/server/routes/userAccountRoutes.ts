import fs from 'node:fs'
import path from 'node:path'
import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { verifyAdminAuth } from '../auth'
import { revokeUserAuth } from './auth'
import {
  getUserDirname,
  renameUserSpace,
  migrateUserData,
  finishRenameUserSpace,
  syncUsersToDatabase,
  hashUserPassword,
  releaseUserSpace,
} from '@/user'
import { getDb } from '@/database'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { deleteUserCacheData } from '@/server/fileCache'
import * as downloadQueue from '@/server/serverDownloadQueue'
import { initUserApis, reloadUserCustomSources } from '../userApi'
import { getSourceRoot, removeUserSourceData } from '@/user/sourceStorage'
import { getPendingUserCleanups, pendingUserCleanupKey, userDirectoryKey } from '@/user/data'
import { getCoverCacheBaseDirs } from '../cacheCover'
import { getRootPath } from '../cachePaths'
import { releaseDataOperation, tryAcquireDataOperation } from '../dataOperationLock'
import { beginAccountChange, endAccountChange, isAccountChangeInProgress } from './userRouteShared'

const hasConflictingUserDirectory = (name: string): boolean => {
  const key = userDirectoryKey(name)
  const roots = [getSourceRoot(), ...getCoverCacheBaseDirs()]
  for (const base of [getRootPath(), global.lx.dataPath]) {
    roots.push(path.join(base, 'cache'), path.join(base, 'music'))
  }
  return roots.some(
    root =>
      fs.existsSync(root) && fs.readdirSync(root).some(entry => entry !== name && userDirectoryKey(entry) === key),
  )
}

const RESERVED_USER_NAMES = new Set(['default', 'open', '_open'])
const isReservedUserName = (name: string) => RESERVED_USER_NAMES.has(userDirectoryKey(name.trim()).toLowerCase())

const saveUsers = async (options: { purgeDataFor?: readonly string[]; pendingCleanup?: readonly string[] } = {}) => {
  try {
    const db = getDb()
    const currentNames = new Set(global.lx.config.users.map((u: any) => u.name))
    const existingUsers = db.query<{ name: string }, []>('SELECT name FROM users').all()
    const removedNames = existingUsers
      .map(user => user.name)
      .filter(name => name !== '_open' && !currentNames.has(name))
    await syncUsersToDatabase(global.lx.config.users, {
      removeMissing: true,
      purgeMissingData: options.purgeDataFor,
      pendingCleanup: options.pendingCleanup,
    })
    // Keep the in-memory session cache in sync only after the DB transaction
    // succeeds. A failed user update must not revoke valid sessions.
    for (const username of removedNames) revokeUserAuth(username)
    const preserved = removedNames.filter(name => !(options.purgeDataFor ?? []).includes(name))
    if (preserved.length > 0) {
      console.warn(
        `[User] 账号已移除但歌单/设置被保留：${preserved.join(', ')}。` +
          `如需彻底清除，请在删除时勾选“同时删除用户数据”。`,
      )
    }
    return { removedNames, preserved }
  } catch (err) {
    console.error('Failed to sync users to SQLite:', err)
    throw err
  }
}

export const createUserAccountRouter = (): Router => {
  const router = new Router()

  // 0. 用户账户管理 (GET / POST / PUT / DELETE /api/users)
  router.get('/api/users', ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    const users = (global.lx.config.users || []).map((u: any) => ({
      name: u.name,
      hasPassword: Boolean(u.passwordHash || u.password),
    }))
    if (global.lx.config['user.enablePublicFavorites']) {
      users.unshift({ name: '_open', hasPassword: false })
    }
    return new Response(JSON.stringify(users), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    })
  })

  router.get('/api/users/cleanup', ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    return ctx.json(getPendingUserCleanups().map(item => item.name))
  })

  router.post('/api/users', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    let dataLockAcquired = false
    try {
      const { name, password } = await ctx.bodyJson<{ name?: string; password?: string }>()
      if (typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password.trim()) {
        return ctx.fail(400, '请填写用户名和密码')
      }
      if (isAccountChangeInProgress()) return ctx.fail(409, '账户数据正在迁移或删除，请稍后重试')
      const normalizedName = name.trim()
      if (password.length > 1024) return ctx.fail(422, '密码长度不能超过 1024 个字符')
      try {
        assertSafePathSegment(normalizedName, 'user name')
      } catch {
        return ctx.fail(422, '用户名不合法，不能包含路径分隔符等特殊字符')
      }
      if (isReservedUserName(normalizedName))
        return ctx.fail(422, 'default、open 和 _open 为系统保留名称，请更换用户名')
      if (global.lx.config.users.some(u => userDirectoryKey(u.name) === userDirectoryKey(normalizedName))) {
        return ctx.fail(409, '该用户名已存在')
      }
      if (getPendingUserCleanups().some(item => userDirectoryKey(item.name) === userDirectoryKey(normalizedName))) {
        return ctx.fail(409, '该用户名的历史文件仍待清理')
      }
      if (hasConflictingUserDirectory(normalizedName)) return ctx.fail(409, '存在名称冲突的历史媒体或音源目录')
      if (!tryAcquireDataOperation('account-change')) return ctx.fail(409, '备份或账户变更正在进行，请稍后重试')
      dataLockAcquired = true
      beginAccountChange()

      const dataPath = path.join(global.lx.userPath, getUserDirname(normalizedName))
      const dataPathExisted = fs.existsSync(dataPath)
      if (!dataPathExisted) fs.mkdirSync(dataPath, { recursive: true })

      const newUser = {
        name: normalizedName,
        password,
        dataPath,
      }
      global.lx.config.users.push(newUser)
      try {
        await saveUsers()
      } catch (error) {
        global.lx.config.users.pop()
        if (!dataPathExisted) {
          try {
            fs.rmSync(dataPath, { recursive: true, force: true })
          } catch {}
        }
        throw error
      }
      return ctx.json({ success: true })
    } catch (error) {
      console.error('[User] 创建用户失败:', error)
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    } finally {
      if (dataLockAcquired) {
        endAccountChange()
        releaseDataOperation('account-change')
      }
    }
  })

  router.put('/api/users', async ctx => {
    const suspendedNames: string[] = []
    let dataLockAcquired = false
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { name, newName, password } = await ctx.bodyJson<{ name?: string; newName?: string; password?: string }>()
      if (typeof name !== 'string' || !name.trim() || (password === undefined && newName === undefined)) {
        return ctx.fail(400, '缺少必填字段')
      }
      if (password !== undefined && (typeof password !== 'string' || !password.trim())) {
        return ctx.fail(422, '密码不能为空')
      }
      if (typeof password === 'string' && password.length > 1024) return ctx.fail(422, '密码长度不能超过 1024 个字符')
      if (isAccountChangeInProgress()) return ctx.fail(409, '账户数据正在迁移或删除，请稍后重试')
      const normalizedName = name.trim()
      const normalizedNewName = typeof newName === 'string' ? newName.trim() : newName
      if (normalizedNewName !== undefined) {
        if (typeof normalizedNewName !== 'string' || !normalizedNewName) return ctx.fail(422, '新用户名不能为空')
        try {
          assertSafePathSegment(normalizedNewName, 'user name')
        } catch {
          return ctx.fail(422, '用户名不合法，不能包含路径分隔符等特殊字符')
        }
        if (isReservedUserName(normalizedNewName))
          return ctx.fail(422, 'default、open 和 _open 为系统保留名称，请更换用户名')
      }
      const userIdx = global.lx.config.users.findIndex((u: any) => u.name === normalizedName)
      if (userIdx === -1) {
        return ctx.fail(404, '用户不存在')
      }

      const user = global.lx.config.users[userIdx]
      if (!tryAcquireDataOperation('account-change')) return ctx.fail(409, '备份或账户变更正在进行，请稍后重试')
      dataLockAcquired = true
      beginAccountChange()

      if (normalizedNewName !== undefined && normalizedNewName !== normalizedName) {
        if (global.lx.config.users.some(u => userDirectoryKey(u.name) === userDirectoryKey(normalizedNewName))) {
          return ctx.fail(409, '新用户名已存在')
        }
        if (
          getPendingUserCleanups().some(item => userDirectoryKey(item.name) === userDirectoryKey(normalizedNewName))
        ) {
          return ctx.fail(409, '该用户名的历史文件仍待清理')
        }
        if (hasConflictingUserDirectory(normalizedNewName)) return ctx.fail(409, '存在名称冲突的历史媒体或音源目录')

        suspendedNames.push(normalizedName, normalizedNewName)
        await Promise.all(suspendedNames.map(name => downloadQueue.suspendUser(name)))
        const previousUser = { ...user }
        let migrationCompleted = false
        let customSourceReloaded = false
        renameUserSpace(normalizedName)
        try {
          // Revoke before changing the users primary key. The SQLite session
          // table intentionally does not cascade ON UPDATE.
          revokeUserAuth(normalizedName)
          const newDataPath = migrateUserData(normalizedName, normalizedNewName)
          migrationCompleted = true
          user.name = normalizedNewName
          user.dataPath = newDataPath
          if (password !== undefined) {
            user.passwordHash = await hashUserPassword(password)
            user.password = ''
          }
          await saveUsers()
          try {
            await reloadUserCustomSources(normalizedName, normalizedNewName)
            customSourceReloaded = true
          } catch (reloadError) {
            console.error('[User] 用户音源重新加载失败:', reloadError)
          }
          await downloadQueue.renameUser(normalizedName, normalizedNewName)
          return ctx.json({ success: true })
        } catch (err: any) {
          if (migrationCompleted) {
            try {
              migrateUserData(normalizedNewName, normalizedName)
            } catch (rollbackError) {
              console.error('[User] 用户重命名回滚失败:', rollbackError)
            }
          }
          Object.assign(user, previousUser)
          try {
            await saveUsers()
          } catch (rollbackError) {
            console.error('[User] 用户重命名配置回滚失败:', rollbackError)
          }
          if (customSourceReloaded) {
            try {
              await reloadUserCustomSources(normalizedNewName, normalizedName)
            } catch (rollbackError) {
              console.error('[User] 用户音源重命名回滚失败:', rollbackError)
            }
          }
          return ctx.fail(500, toUserMessage(err, '数据迁移失败，请稍后重试'))
        } finally {
          finishRenameUserSpace(normalizedName)
        }
      } else {
        const previousUser = { ...user }
        try {
          if (password !== undefined) {
            user.passwordHash = await hashUserPassword(password)
            user.password = ''
          }
          await saveUsers()
          if (password !== undefined) revokeUserAuth(normalizedName)
          return ctx.json({ success: true })
        } catch (error) {
          Object.assign(user, previousUser)
          throw error
        }
      }
    } catch (error) {
      console.error('[User] 更新用户失败:', error)
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    } finally {
      for (const name of suspendedNames) downloadQueue.releaseUser(name)
      if (dataLockAcquired) {
        endAccountChange()
        releaseDataOperation('account-change')
      }
    }
  })

  router.delete('/api/users', async ctx => {
    const suspendedNames: string[] = []
    let dataLockAcquired = false
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const body = await ctx.bodyJson<{
        name?: string
        names?: string[]
        deleteData?: boolean
        retryCleanup?: boolean
      }>()
      if ([body.deleteData, body.retryCleanup].some(value => value !== undefined && typeof value !== 'boolean')) {
        return ctx.fail(422, '删除选项格式无效')
      }
      if (
        body.names !== undefined &&
        (!Array.isArray(body.names) || body.names.length > 100 || body.names.some(name => typeof name !== 'string'))
      ) {
        return ctx.fail(422, 'names 参数格式无效')
      }
      if (body.name !== undefined && typeof body.name !== 'string') {
        return ctx.fail(422, 'name 参数格式无效')
      }
      const targets = [...new Set(body.names || (body.name ? [body.name] : []))]
      if (targets.length === 0) return ctx.fail(400, '缺少要删除的用户名')
      for (const targetName of targets) {
        try {
          assertSafePathSegment(targetName, 'user name')
        } catch {
          return ctx.fail(422, '用户名不合法，不能包含路径分隔符等特殊字符')
        }
        if (targetName === '_open') return ctx.fail(422, '不能删除系统保留用户')
      }

      if (isAccountChangeInProgress() || !tryAcquireDataOperation('account-change'))
        return ctx.fail(409, '备份或账户变更正在进行，请稍后重试')
      dataLockAcquired = true
      beginAccountChange()
      suspendedNames.push(
        ...(body.retryCleanup
          ? getPendingUserCleanups()
              .filter(
                item =>
                  targets.includes(item.name) &&
                  !global.lx.config.users.some(user => userDirectoryKey(user.name) === userDirectoryKey(item.name)),
              )
              .map(item => item.name)
          : targets),
      )
      await Promise.all(suspendedNames.map(name => downloadQueue.suspendUser(name)))
      let deletedCount = 0
      const deletedUsers: { name: string; dataPath?: string }[] = []
      const previousUsers = [...global.lx.config.users]

      for (const targetName of body.retryCleanup ? [] : targets) {
        const idx = global.lx.config.users.findIndex((u: any) => u.name === targetName)
        if (idx !== -1) {
          const user = global.lx.config.users[idx]
          releaseUserSpace(targetName, true)
          // Audio/cover/lyric caches are disposable derived data. Once the
          // account is removed, retaining them would leave inaccessible files
          // and stale cache_index rows even when deleteData is unchecked.
          deletedUsers.push({ name: targetName, dataPath: user.dataPath })
          global.lx.config.users.splice(idx, 1)
          deletedCount++
        }
      }

      if (deletedCount > 0) {
        try {
          // deleteData now means what the UI says: it also wipes the account's
          // playlists/settings. Without it, only the account (and its sessions
          // plus derived cache index) is removed; playlists and settings stay
          // so that recreating the same user name restores them.
          const removedNames = deletedUsers.map(user => user.name)
          await saveUsers({ purgeDataFor: body.deleteData ? removedNames : [], pendingCleanup: removedNames })
        } catch (error) {
          global.lx.config.users.splice(0, global.lx.config.users.length, ...previousUsers)
          throw error
        }
      }
      const pending = getPendingUserCleanups().filter(
        item =>
          targets.includes(item.name) &&
          !global.lx.config.users.some(user => userDirectoryKey(user.name) === userDirectoryKey(item.name)),
      )
      if (!deletedCount && !pending.length && !body.retryCleanup) return ctx.fail(404, '用户不存在')
      const cleanupWarnings: string[] = []
      for (const { name, deleteData } of pending) {
        const dataPath =
          deletedUsers.find(user => user.name === name)?.dataPath ?? path.join(global.lx.userPath, getUserDirname(name))
        const cleanup = [
          () => downloadQueue.removeUser(name),
          () => {
            const result = deleteUserCacheData(name, { preserveMusic: !deleteData })
            if (result.failedDirectories) throw new Error('部分媒体目录未清理')
          },
          () => releaseUserSpace(name, true),
          () => removeUserSourceData(name),
          () => initUserApis(name),
          () => {
            if (deleteData) fs.rmSync(dataPath, { recursive: true, force: true })
          },
        ]
        let failed = false
        for (const step of cleanup) {
          try {
            await step()
          } catch (error) {
            console.error(`[User] 清理 ${name} 的数据失败:`, error)
            failed = true
          }
        }
        if (failed) cleanupWarnings.push(name)
        else getDb().run('DELETE FROM system_info WHERE key = ?', [pendingUserCleanupKey(name)])
      }
      return ctx.json({
        success: true,
        deletedCount,
        ...(body.deleteData ? {} : { dataPreserved: deletedUsers.map(user => user.name) }),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      })
    } catch (error) {
      console.error('[User] 删除用户失败:', error)
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    } finally {
      for (const name of suspendedNames) downloadQueue.releaseUser(name)
      if (dataLockAcquired) {
        endAccountChange()
        releaseDataOperation('account-change')
      }
    }
  })

  return router
}
