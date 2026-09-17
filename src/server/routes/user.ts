import fs from 'node:fs'
import path from 'node:path'
import { Router, type HttpContext } from '../core'
import { toUserMessage } from '../core/context'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth, revokeUserAuth } from './auth'
import {
  getUserSpace,
  getUserDirname,
  renameUserSpace,
  migrateUserData,
  finishRenameUserSpace,
  syncUsersToDatabase,
  hashUserPassword,
  releaseUserSpace,
} from '@/user'
import { startupLog } from '@/utils/log4js'
import { getDb } from '@/database'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { assertSnapshotId } from '@/modules/list/snapshotDataManage'

const MAX_USER_SETTING_BODY_BYTES = 2 * 1024 * 1024

/** 辅助获取请求的目标用户空间名称 */
const resolveTargetUsername = (ctx: HttpContext, _requireAuth = true): string | null => {
  const config = (global.lx?.config ?? {}) as any
  const targetUserParam = ctx.query.get('user') || ''
  const reqUsername = targetUserParam
  const isAdmin = verifyAdminAuth(ctx.request)
  const tokenUser = verifyUserAuth(ctx)

  const canAccessOpen = config['user.enablePublicFavorites'] && (
    config['user.enablePublicNonAdminAccess'] || isAdmin || !!tokenUser
  )

  if (reqUsername === '_open') {
    if (canAccessOpen) return '_open'
    return null
  }

  if (!reqUsername || reqUsername === 'default') return tokenUser || (canAccessOpen ? '_open' : null)
  if (isAdmin) {
    try { return assertSafePathSegment(reqUsername, 'user name') } catch { return null }
  }
  return tokenUser && tokenUser === reqUsername ? tokenUser : null
}

const saveUsers = () => {
  try {
    const db = getDb()
    const currentNames = new Set(global.lx.config.users.map((u: any) => u.name))
    const existingUsers = db.query<{ name: string }, []>('SELECT name FROM users').all()
    const removedNames = existingUsers
      .map(user => user.name)
      .filter(name => name !== '_open' && !currentNames.has(name))
    syncUsersToDatabase(global.lx.config.users, { removeMissing: true })
    // Keep the in-memory session cache in sync only after the DB transaction
    // succeeds. A failed user update must not revoke valid sessions.
    for (const username of removedNames) revokeUserAuth(username)
  } catch (err) {
    console.error('Failed to sync users to SQLite:', err)
    throw err
  }
}

const resolveSnapshotUsername = (ctx: HttpContext, userParam: string, write = false): string | null => {
  const isAdmin = verifyAdminAuth(ctx.request)
  if (isAdmin) {
    if (userParam === 'default' || userParam === 'open' || userParam === '_open') return '_open'
    try { return assertSafePathSegment(userParam, 'user name') } catch { return null }
  }

  if (userParam === 'default' || userParam === 'open' || userParam === '_open') {
    if (write) return null
    const config = (global.lx?.config ?? {}) as any
    const tokenUser = verifyUserAuth(ctx)
    const canAccessOpen = config['user.enablePublicFavorites'] && (
      config['user.enablePublicNonAdminAccess'] || !!tokenUser
    )
    return canAccessOpen ? '_open' : null
  }

  const tokenUser = verifyUserAuth(ctx)
  return tokenUser && tokenUser === userParam ? tokenUser : null
}

/** 注册用户歌单、账户管理、偏好与曲库数据管理路由 */
export const createUserRouter = (): Router => {
  const router = new Router()

  // 0. 用户账户管理 (GET / POST / PUT / DELETE /api/users)
  router.get('/api/users', (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    const users = (global.lx.config.users || []).map((u: any) => ({ name: u.name, hasPassword: Boolean(u.passwordHash || u.password) }))
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

  router.post('/api/users', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { name, password } = await ctx.bodyJson<{ name?: string; password?: string }>()
      if (typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password.trim()) {
        return ctx.fail(400, '请填写用户名和密码')
      }
      if (password.length > 1024) return ctx.fail(422, '密码长度不能超过 1024 个字符')
      try {
        assertSafePathSegment(name, 'user name')
      } catch {
        return ctx.fail(422, '用户名不合法，不能包含路径分隔符等特殊字符')
      }
      if (name === '_open') return ctx.fail(422, '该用户名为系统保留名称，请更换')
      if (global.lx.config.users.some((u: any) => u.name === name)) {
        return ctx.fail(409, '该用户名已存在')
      }

      const dataPath = path.join(global.lx.userPath, getUserDirname(name))
      const dataPathExisted = fs.existsSync(dataPath)
      if (!dataPathExisted) fs.mkdirSync(dataPath, { recursive: true })

      const newUser = {
        name,
        password,
        dataPath,
      }
      global.lx.config.users.push(newUser)
      try {
        saveUsers()
      } catch (error) {
        global.lx.config.users.pop()
        if (!dataPathExisted) {
          try { fs.rmSync(dataPath, { recursive: true, force: true }) } catch { }
        }
        throw error
      }
      return ctx.json({ success: true })
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    }
  })

  router.put('/api/users', async (ctx) => {
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
      if (newName !== undefined) {
        if (typeof newName !== 'string' || !newName.trim()) return ctx.fail(422, '新用户名不能为空')
        try {
          assertSafePathSegment(newName, 'user name')
        } catch {
          return ctx.fail(422, '用户名不合法，不能包含路径分隔符等特殊字符')
        }
        if (newName === '_open') return ctx.fail(422, '该用户名为系统保留名称，请更换')
      }
      const userIdx = global.lx.config.users.findIndex((u: any) => u.name === name)
      if (userIdx === -1) {
        return ctx.fail(404, '用户不存在')
      }

      const user = global.lx.config.users[userIdx]

      if (newName !== undefined && newName !== name) {
        if (global.lx.config.users.some((u: any) => u.name === newName)) {
          return ctx.fail(409, '新用户名已存在')
        }

        const previousUser = { ...user }
        let migrationCompleted = false
        renameUserSpace(name)
        try {
          // Revoke before changing the users primary key. The SQLite session
          // table intentionally does not cascade ON UPDATE.
          revokeUserAuth(name)
          const newDataPath = migrateUserData(name, newName)
          migrationCompleted = true
          user.name = newName
          user.dataPath = newDataPath
          if (password !== undefined) {
            user.passwordHash = hashUserPassword(password)
            user.password = ''
          }
          saveUsers()
          return ctx.json({ success: true })
        } catch (err: any) {
          if (migrationCompleted) {
            try {
              migrateUserData(newName, name)
            } catch (rollbackError) {
              console.error('[User] 用户重命名回滚失败:', rollbackError)
            }
          }
          Object.assign(user, previousUser)
          return ctx.fail(500, toUserMessage(err, '数据迁移失败，请稍后重试'))
        } finally {
          finishRenameUserSpace(name)
        }
      } else {
        const previousUser = { ...user }
        try {
          if (password !== undefined) {
            user.passwordHash = hashUserPassword(password)
            user.password = ''
          }
          saveUsers()
          return ctx.json({ success: true })
        } catch (error) {
          Object.assign(user, previousUser)
          throw error
        }
      }
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    }
  })

  router.delete('/api/users', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const body = await ctx.bodyJson<{ name?: string; names?: string[]; deleteData?: boolean }>()
      if (body.deleteData !== undefined && typeof body.deleteData !== 'boolean') {
        return ctx.fail(422, 'deleteData 参数格式无效')
      }
      if (body.names !== undefined && (!Array.isArray(body.names) || body.names.length > 100 || body.names.some(name => typeof name !== 'string'))) {
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

      let deletedCount = 0
      const deletedUsers: { name: string; dataPath: string }[] = []
      const previousUsers = [...global.lx.config.users]

      for (const targetName of targets) {
        const idx = global.lx.config.users.findIndex((u: any) => u.name === targetName)
        if (idx !== -1) {
          const user = global.lx.config.users[idx]
          releaseUserSpace(targetName, true)
          if (body.deleteData && user.dataPath) {
            deletedUsers.push({ name: targetName, dataPath: user.dataPath })
          }
          global.lx.config.users.splice(idx, 1)
          deletedCount++
        }
      }

      if (deletedCount > 0) {
        try {
          saveUsers()
        } catch (error) {
          global.lx.config.users.splice(0, global.lx.config.users.length, ...previousUsers)
          throw error
        }
        if (body.deleteData && deletedUsers.length > 0) {
          for (const user of deletedUsers) {
            try {
              releaseUserSpace(user.name, true)
              if (fs.existsSync(user.dataPath)) {
                fs.rmSync(user.dataPath, { recursive: true, force: true })
              }
            } catch (err) {
              console.error(`Failed to delete user data folder for ${user.name}:`, err)
            }
          }
        }
        return ctx.json({ success: true, deletedCount })
      }
      return ctx.fail(404, '用户不存在')
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    }
  })

  // 1. 读取用户歌单数据 (GET /api/user/list)
  router.get('/api/user/list', async (ctx) => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }

    try {
      const userSpace = getUserSpace(username)
      const data = await userSpace.listManage.getListData()
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 2. 覆盖保存用户歌单数据 (POST /api/user/list)
  router.post('/api/user/list', async (ctx) => {
    const isAdmin = verifyAdminAuth(ctx.request)
    const username = resolveTargetUsername(ctx, false)

    if (!username) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    if (username === '_open' && !isAdmin) {
      return ctx.json({ success: false, error: '权限不足：公共歌单修改受限，请先验证管理员身份。' }, 403)
    }

    try {
      const listData = await ctx.bodyJson<LX.List.ListData>()
      const userSpace = getUserSpace(username)
      await userSpace.listManage.listDataManage.restore(listData)
      await userSpace.listManage.createSnapshot()
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 3. 用户曲库：歌手与专辑 (GET & POST)
  router.get('/api/user/library/artists', (ctx) => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const db = getDb()
      const row = db.query<{ value: string }, [string, string]>(
        'SELECT value FROM user_settings WHERE user_name = ? AND key = ?'
      ).get(username, 'library_artists')

      if (row) {
        return ctx.json(JSON.parse(row.value))
      }
      return ctx.json([])
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/user/library/artists', async (ctx) => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '修改公开收藏需要管理员权限')
    try {
      const parsed = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(parsed)) throw new Error('Expected an array')
      const db = getDb()
      db.run(
        'INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
        [username, 'library_artists', JSON.stringify(parsed), Date.now()]
      )
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.get('/api/user/library/albums', (ctx) => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const db = getDb()
      const row = db.query<{ value: string }, [string, string]>(
        'SELECT value FROM user_settings WHERE user_name = ? AND key = ?'
      ).get(username, 'library_albums')

      if (row) {
        return ctx.json(JSON.parse(row.value))
      }
      return ctx.json([])
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/user/library/albums', async (ctx) => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '修改公开收藏需要管理员权限')
    try {
      const parsed = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(parsed)) throw new Error('Expected an array')
      const db = getDb()
      db.run(
        'INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
        [username, 'library_albums', JSON.stringify(parsed), Date.now()]
      )
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  // 4. 用户设置 (GET & POST /api/user/settings)
  router.get('/api/user/settings', (ctx) => {
    const reqUsername = ctx.query.get('user') || ''
    const isPublic = !reqUsername || reqUsername === 'default'
    let resolvedUsername: string | null = null

    const config = (global.lx?.config ?? {}) as any
    if (isPublic && config['user.enablePublicRestriction']) {
      resolvedUsername = '_open'
    } else {
      resolvedUsername = verifyUserAuth(ctx)
      if (!resolvedUsername) {
        return ctx.fail(401, '登录状态已失效，请重新登录')
      }
    }

    try {
      const db = getDb()
      const row = db.query<{ value: string }, [string, string]>(
        'SELECT value FROM user_settings WHERE user_name = ? AND key = ?'
      ).get(resolvedUsername, 'settings')

      if (row) {
        return new Response(row.value, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    } catch (e) {
      console.error('Failed to get user settings from DB:', e)
    }
    return ctx.json({})
  })

  router.post('/api/user/settings', async (ctx) => {
    const reqUsername = ctx.query.get('user') || ''
    const isPublic = !reqUsername || reqUsername === 'default'
    let resolvedUsername: string | null = null
    const config = (global.lx?.config ?? {}) as any

    if (isPublic) {
      if (config['user.enablePublicRestriction']) {
        const isAdmin = verifyAdminAuth(ctx.request)
        if (!isAdmin) {
          return ctx.json({ success: false, error: '权限不足：公共用户保存设置受限，请先验证管理员身份。' }, 403)
        }
      }
      resolvedUsername = '_open'
    } else {
      resolvedUsername = verifyUserAuth(ctx)
      if (!resolvedUsername) {
        return ctx.fail(401, '登录状态已失效，请重新登录')
      }
    }

    try {
      let settings = await ctx.bodyJson<Record<string, unknown>>(MAX_USER_SETTING_BODY_BYTES)

      if (resolvedUsername === '_open' && config['user.enablePublicRestriction']) {
        const restrictedSettings: any = {}
        const allowedKeys = [
          'serverCacheLocation', 'serverCacheNamingPattern', 'downloadConcurrency',
          'preferredQuality', 'enablePublicSources',
        ]
        for (const key of allowedKeys) {
          if (settings[key] !== undefined) restrictedSettings[key] = settings[key]
        }
        settings = restrictedSettings
      }

      const db = getDb()
      db.run(
        'INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
        [resolvedUsername, 'settings', JSON.stringify(settings), Date.now()]
      )
      return ctx.json({ success: true })
    } catch {
      return ctx.fail(400, '请求数据格式错误')
    }
  })

  // 5. 音效配置 (GET & POST /api/user/sound-effects)
  router.get('/api/user/sound-effects', (ctx) => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const db = getDb()
      const row = db.query<{ value: string }, [string, string]>(
        'SELECT value FROM user_settings WHERE user_name = ? AND key = ?'
      ).get(username, 'sound_effects')

      if (row) {
        return new Response(row.value, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    } catch (e) {
      console.error('Failed to get sound-effects from DB:', e)
    }
    return ctx.json({})
  })

  router.post('/api/user/sound-effects', async (ctx) => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const body = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      const db = getDb()
      db.run(
        'INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
        [username, 'sound_effects', JSON.stringify(body), Date.now()]
      )
      return ctx.json({ success: true })
    } catch {
      return ctx.fail(400, '请求数据格式错误')
    }
  })

  // 6. 歌单与歌曲批量修改 (POST /api/music/user/list/*)
  router.post('/api/music/user/list/remove', async (ctx) => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '需要用户认证，请先登录')
    try {
      const { listId, songIds } = await ctx.bodyJson<{ listId?: string; songIds?: string[] }>()
      if (!listId || !Array.isArray(songIds)) return ctx.text('参数错误:需要listId和songIds数组', 400)
      const userSpace = getUserSpace(username)
      await userSpace.listManage.listDataManage.listMusicRemove(listId, songIds)
      await userSpace.listManage.createSnapshot()
      return ctx.text('删除成功', 200)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '删除失败，请稍后重试'))
    }
  })

  router.post('/api/music/user/list/add', async (ctx) => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '需要用户认证，请先登录')
    try {
      const { listId, musicInfos, location = 'bottom' } = await ctx.bodyJson<{ listId?: string; musicInfos?: any[]; location?: any }>()
      if (!listId || !Array.isArray(musicInfos)) return ctx.text('参数错误:需要listId和musicInfos数组', 400)
      const userSpace = getUserSpace(username)
      await userSpace.listManage.listDataManage.listMusicAdd(listId, musicInfos, location)
      await userSpace.listManage.createSnapshot()
      return ctx.text('添加成功', 200)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '添加失败，请稍后重试'))
    }
  })

  // 7. 快照管理 (GET & POST /api/data/*)
  router.get('/api/data', async (ctx) => {
    const userParam = ctx.query.get('user')
    if (!userParam) return ctx.fail(400, '缺少必要参数：user')

    const verifiedUser = resolveSnapshotUsername(ctx, userParam)
    if (!verifiedUser) return ctx.fail(403, '没有权限操作该用户的数据')

    try {
      const userSpace = getUserSpace(verifiedUser)
      const data = await userSpace.listManage.getListData()
      return ctx.json(data)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.get('/api/data/snapshots', async (ctx) => {
    const userParam = ctx.query.get('user')
    if (!userParam) return ctx.fail(400, '缺少必要参数：user')

    const verifiedUser = resolveSnapshotUsername(ctx, userParam)
    if (!verifiedUser) return ctx.fail(403, '没有权限执行该操作')

    try {
      const userSpace = getUserSpace(verifiedUser)
      const list = await userSpace.listManage.getSnapshotList()
      return ctx.json(list)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.get('/api/data/snapshot', async (ctx) => {
    const userParam = ctx.query.get('user')
    const id = ctx.query.get('id')
    if (!userParam || !id) return ctx.fail(400, '缺少必要参数')

    const verifiedUser = resolveSnapshotUsername(ctx, userParam)
    if (!verifiedUser) return ctx.fail(403, '没有权限执行该操作')
    try { assertSnapshotId(id) } catch { return ctx.fail(422, '快照标识无效') }

    try {
      const userSpace = getUserSpace(verifiedUser)
      const data = await userSpace.listManage.getSnapshot(id)
      if (!data) return ctx.fail(404, '资源不存在')
      return ctx.json(data)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/restore-snapshot', async (ctx) => {
    const userParam = ctx.query.get('user')
    if (!userParam) return ctx.fail(400, '缺少必要参数：user')

    const verifiedUser = resolveSnapshotUsername(ctx, userParam, true)
    if (!verifiedUser) return ctx.fail(403, '没有权限执行该操作')

    try {
      const { id } = await ctx.bodyJson<{ id?: string }>()
      if (!id) return ctx.fail(400, '缺少必要参数：id')
      try { assertSnapshotId(id) } catch { return ctx.fail(422, '快照标识无效') }
      const userSpace = getUserSpace(verifiedUser)
      await userSpace.listManage.restoreSnapshot(id)
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/delete-snapshot', async (ctx) => {
    const userParam = ctx.query.get('user')
    if (!userParam) return ctx.fail(400, '缺少必要参数：user')

    const verifiedUser = resolveSnapshotUsername(ctx, userParam, true)
    if (!verifiedUser) return ctx.fail(403, '没有权限执行该操作')

    try {
      const { id } = await ctx.bodyJson<{ id?: string }>()
      if (!id) return ctx.fail(400, '缺少必要参数：id')
      try { assertSnapshotId(id) } catch { return ctx.fail(422, '快照标识无效') }
      const userSpace = getUserSpace(verifiedUser)
      await userSpace.listManage.removeSnapshot(id)
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/upload-snapshot', async (ctx) => {
    const userParam = ctx.query.get('user')
    const time = parseInt(ctx.query.get('time') || '0')
    const filename = ctx.query.get('filename')

    if (!userParam || !filename) return ctx.fail(400, '缺少必要参数')
    if (filename.length > 256) return ctx.fail(413, '快照文件名过长')

    const verifiedUser = resolveSnapshotUsername(ctx, userParam, true)
    if (!verifiedUser) return ctx.fail(403, '没有权限执行该操作')

    try {
      const body = await ctx.bodyText()
      let finalData = body

      try {
        const jsonData = JSON.parse(body)
        if (jsonData && jsonData.type === 'playList_v2' && Array.isArray(jsonData.data)) {
          startupLog.info(`[Snapshot] Detected legacy backup format for user ${verifiedUser}, converting...`)
          const defaultList = jsonData.data.find((l: any) => l.id === 'default')?.list || []
          const loveList = jsonData.data.find((l: any) => l.id === 'love')?.list || []
          const userList = jsonData.data.filter((l: any) => l.id !== 'default' && l.id !== 'love')
          finalData = JSON.stringify({ defaultList, loveList, userList })
        }
      } catch { }

      let name = filename
      if (name.startsWith('snapshot_')) name = name.substring(9)
      try { assertSnapshotId(name) } catch { return ctx.fail(422, '快照标识无效') }

      const userSpace = getUserSpace(verifiedUser)
      await userSpace.listManage.saveSnapshotWithTime(name, finalData, time)
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 8. 歌单与歌曲精准修改 (POST /api/data/*)
  router.post('/api/data/delete-playlist', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId } = await ctx.bodyJson<{ username?: string; playlistId?: string }>()
      if (!username || !playlistId) return ctx.fail(400, '缺少必要参数')
      const userSpace = getUserSpace(username)
      await userSpace.listManage.listDataManage.userListsRemove([playlistId])
      await userSpace.listManage.createSnapshot()
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/delete-song', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId, songId } = await ctx.bodyJson<{ username?: string; playlistId?: string; songId?: string }>()
      if (!username || !playlistId || !songId) return ctx.fail(400, '缺少必要参数')
      const userSpace = getUserSpace(username)
      await userSpace.listManage.listDataManage.listMusicRemove(playlistId, [songId])
      await userSpace.listManage.createSnapshot()
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/rename-playlist', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId, newName } = await ctx.bodyJson<{ username?: string; playlistId?: string; newName?: string }>()
      if (!username || !playlistId || !newName) return ctx.fail(400, '缺少必要参数')
      const userSpace = getUserSpace(username)
      const listData = await userSpace.listManage.getListData()
      const target = listData.userList.find((l: any) => l.id === playlistId)
      if (!target) return ctx.fail(404, '歌单不存在')
      target.name = newName
      await userSpace.listManage.listDataManage.restore(listData)
      await userSpace.listManage.createSnapshot()
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/batch-delete-songs', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId, songIndices } = await ctx.bodyJson<{ username?: string; playlistId?: string; songIndices?: number[] }>()
      if (!username || !playlistId || !Array.isArray(songIndices)) return ctx.fail(400, '缺少必要参数')

      const userSpace = getUserSpace(username)
      const listManage = userSpace.listManage
      const listData = await listManage.getListData()
      const playlist = listData.userList.find((list: any) => list.id === playlistId)
      if (!playlist) return ctx.fail(404, '歌单不存在')

      const songIds = songIndices.map(index => playlist.list?.[index]?.id).filter(Boolean)
      if (songIds.length === 0) return ctx.fail(400, '没有选中有效的歌曲')

      await listManage.listDataManage.listMusicRemove(playlistId, songIds)
      await listManage.createSnapshot()
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  return router
}
