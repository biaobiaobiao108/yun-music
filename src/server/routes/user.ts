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
import { getDb } from '@/database'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { PlaylistIdConflictError, type PlaylistMutation } from '@/modules/list/listDataManage'
import { deleteUserCacheData } from '@/server/fileCache'
import * as downloadQueue from '@/server/serverDownloadQueue'
import { initUserApis, reloadUserCustomSources } from '../userApi'
import { removeUserSourceData } from '@/user/sourceStorage'
import { LIST_IDS } from '@/constants'
import { releaseDataOperation, tryAcquireDataOperation } from '../dataOperationLock'

let accountChangeInProgress = false

const MAX_USER_SETTING_BODY_BYTES = 2 * 1024 * 1024
const MAX_PLAY_HISTORY_ITEMS = 50
const PLAY_HISTORY_SETTING_KEY = 'play_history'
const RESERVED_USER_NAMES = new Set(['default', 'open', '_open'])
const isReservedUserName = (name: string) => RESERVED_USER_NAMES.has(name.trim().toLowerCase())
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function playHistorySongKey(song: Record<string, unknown>): string {
  return `${String(song.source || 'unknown')}:${String(song.songmid ?? song.id ?? song.hash ?? song.name ?? '')}`
}

function validatePlayHistoryItems(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_PLAY_HISTORY_ITEMS) {
    throw new Error(`播放历史最多保存 ${MAX_PLAY_HISTORY_ITEMS} 首歌曲`)
  }
  return value.map(item => {
    if (!isRecord(item)) throw new Error('播放历史数据格式错误')
    const id = item.songmid ?? item.id ?? item.hash ?? item.name
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      !String(id).trim() ||
      (item.source !== undefined && typeof item.source !== 'string') ||
      (item.playedAt !== undefined &&
        (typeof item.playedAt !== 'number' || !Number.isFinite(item.playedAt) || item.playedAt < 0))
    ) {
      throw new Error('播放历史歌曲信息无效')
    }
    return item
  })
}

function mergePlayHistory(...histories: Record<string, unknown>[][]): Record<string, unknown>[] {
  const bySong = new Map<string, Record<string, unknown>>()
  for (const history of histories) {
    for (const song of history) {
      const key = playHistorySongKey(song)
      const previous = bySong.get(key)
      if (!previous || Number(song.playedAt || 0) >= Number(previous.playedAt || 0)) bySong.set(key, song)
    }
  }
  return [...bySong.values()]
    .sort((a, b) => Number(b.playedAt || 0) - Number(a.playedAt || 0))
    .slice(0, MAX_PLAY_HISTORY_ITEMS)
}

/** 辅助获取请求的目标用户空间名称 */
const resolveTargetUsername = (ctx: HttpContext, _requireAuth = true): string | null => {
  const config = (global.lx?.config ?? {}) as any
  const targetUserParam = ctx.query.get('user') || ''
  const reqUsername = targetUserParam
  const isAdmin = verifyAdminAuth(ctx.request)
  const tokenUser = verifyUserAuth(ctx)

  const canAccessOpen =
    config['user.enablePublicFavorites'] && (config['user.enablePublicNonAdminAccess'] || isAdmin || !!tokenUser)

  if (reqUsername === 'default' || reqUsername === 'open' || reqUsername === '_open') {
    if (canAccessOpen) return '_open'
    return null
  }

  if (!reqUsername) return tokenUser || (canAccessOpen ? '_open' : null)
  if (isAdmin) {
    try {
      return assertSafePathSegment(reqUsername, 'user name')
    } catch {
      return null
    }
  }
  return tokenUser && tokenUser === reqUsername ? tokenUser : null
}

const saveUsers = async (options: { purgeDataFor?: readonly string[] } = {}) => {
  try {
    const db = getDb()
    const currentNames = new Set(global.lx.config.users.map((u: any) => u.name))
    const existingUsers = db.query<{ name: string }, []>('SELECT name FROM users').all()
    const removedNames = existingUsers
      .map(user => user.name)
      .filter(name => name !== '_open' && !currentNames.has(name))
    await syncUsersToDatabase(global.lx.config.users, { removeMissing: true, purgeMissingData: options.purgeDataFor })
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

const rejectUnavailableDataWrite = (ctx: HttpContext, username: string): Response | null => {
  if (accountChangeInProgress) return ctx.fail(409, '账户数据正在迁移或删除，请稍后重试')
  if (username === '_open') return null
  if (global.lx.config.users.some(user => user.name === username)) return null
  return ctx.fail(409, '账户已变更，请刷新页面后重试')
}

const resolveDataUsername = (ctx: HttpContext, userParam: string): string | null => {
  const isAdmin = verifyAdminAuth(ctx.request)
  if (isAdmin) {
    if (userParam === 'default' || userParam === 'open' || userParam === '_open') return '_open'
    try {
      return assertSafePathSegment(userParam, 'user name')
    } catch {
      return null
    }
  }

  if (userParam === 'default' || userParam === 'open' || userParam === '_open') {
    const config = (global.lx?.config ?? {}) as any
    const tokenUser = verifyUserAuth(ctx)
    const canAccessOpen =
      config['user.enablePublicFavorites'] && (config['user.enablePublicNonAdminAccess'] || !!tokenUser)
    return canAccessOpen ? '_open' : null
  }

  const tokenUser = verifyUserAuth(ctx)
  return tokenUser && tokenUser === userParam ? tokenUser : null
}

const resolveSettingsUsername = (ctx: HttpContext, write = false): string | Response => {
  const requested = ctx.query.get('user')?.trim() || ''
  const verified = verifyUserAuth(ctx)
  const isAdmin = verifyAdminAuth(ctx.request)
  const isPublic = ['default', 'open', '_open'].includes(requested) || (!requested && !verified)

  if (isPublic) {
    if (write && global.lx.config['user.enablePublicRestriction'] && !isAdmin) {
      return ctx.fail(403, '权限不足：公共用户保存设置受限，请先验证管理员身份')
    }
    return '_open'
  }
  if (!requested) return verified!
  if (isAdmin) {
    try {
      return assertSafePathSegment(requested, 'user name')
    } catch {
      return ctx.fail(400, '用户名不合法')
    }
  }
  return verified === requested ? verified : ctx.fail(403, '没有权限操作该用户的设置')
}

const isSettingsRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 注册用户歌单、账户管理、偏好与曲库数据管理路由 */
export const createUserRouter = (): Router => {
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

  router.post('/api/users', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    let dataLockAcquired = false
    try {
      const { name, password } = await ctx.bodyJson<{ name?: string; password?: string }>()
      if (typeof name !== 'string' || !name.trim() || typeof password !== 'string' || !password.trim()) {
        return ctx.fail(400, '请填写用户名和密码')
      }
      if (accountChangeInProgress) return ctx.fail(409, '账户数据正在迁移或删除，请稍后重试')
      const normalizedName = name.trim()
      if (password.length > 1024) return ctx.fail(422, '密码长度不能超过 1024 个字符')
      try {
        assertSafePathSegment(normalizedName, 'user name')
      } catch {
        return ctx.fail(422, '用户名不合法，不能包含路径分隔符等特殊字符')
      }
      if (isReservedUserName(normalizedName))
        return ctx.fail(422, 'default、open 和 _open 为系统保留名称，请更换用户名')
      if (global.lx.config.users.some((u: any) => u.name === normalizedName)) {
        return ctx.fail(409, '该用户名已存在')
      }
      if (!tryAcquireDataOperation('account-change')) return ctx.fail(409, '备份或账户变更正在进行，请稍后重试')
      dataLockAcquired = true
      accountChangeInProgress = true

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
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    } finally {
      if (dataLockAcquired) {
        accountChangeInProgress = false
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
      if (accountChangeInProgress) return ctx.fail(409, '账户数据正在迁移或删除，请稍后重试')
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
      accountChangeInProgress = true

      if (normalizedNewName !== undefined && normalizedNewName !== normalizedName) {
        if (global.lx.config.users.some((u: any) => u.name === normalizedNewName)) {
          return ctx.fail(409, '新用户名已存在')
        }

        suspendedNames.push(normalizedName, normalizedNewName)
        await Promise.all(suspendedNames.map(name => downloadQueue.suspendUser(name)))
        const previousUser = { ...user }
        let migrationCompleted = false
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
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    } finally {
      for (const name of suspendedNames) downloadQueue.releaseUser(name)
      if (dataLockAcquired) {
        accountChangeInProgress = false
        releaseDataOperation('account-change')
      }
    }
  })

  router.delete('/api/users', async ctx => {
    const suspendedNames: string[] = []
    let dataLockAcquired = false
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const body = await ctx.bodyJson<{ name?: string; names?: string[]; deleteData?: boolean }>()
      if (body.deleteData !== undefined && typeof body.deleteData !== 'boolean') {
        return ctx.fail(422, 'deleteData 参数格式无效')
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

      if (accountChangeInProgress || !tryAcquireDataOperation('account-change'))
        return ctx.fail(409, '备份或账户变更正在进行，请稍后重试')
      dataLockAcquired = true
      accountChangeInProgress = true
      suspendedNames.push(...targets)
      await Promise.all(targets.map(name => downloadQueue.suspendUser(name)))
      let deletedCount = 0
      const deletedUsers: { name: string; dataPath?: string }[] = []
      const previousUsers = [...global.lx.config.users]

      for (const targetName of targets) {
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
          await saveUsers({ purgeDataFor: body.deleteData ? deletedUsers.map(user => user.name) : [] })
        } catch (error) {
          global.lx.config.users.splice(0, global.lx.config.users.length, ...previousUsers)
          throw error
        }
        const cleanupWarnings: string[] = []
        if (deletedUsers.length > 0) {
          for (const user of deletedUsers) {
            try {
              await downloadQueue.removeUser(user.name)
              deleteUserCacheData(user.name, { preserveMusic: !body.deleteData })
              releaseUserSpace(user.name, true)
              removeUserSourceData(user.name)
              await initUserApis(user.name)
              if (body.deleteData && user.dataPath && fs.existsSync(user.dataPath)) {
                fs.rmSync(user.dataPath, { recursive: true, force: true })
              }
            } catch (err) {
              console.error(`Failed to delete disposable data for ${user.name}:`, err)
              cleanupWarnings.push(user.name)
            }
          }
        }
        return ctx.json({
          success: true,
          deletedCount,
          ...(body.deleteData ? {} : { dataPreserved: deletedUsers.map(user => user.name) }),
          ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
        })
      }
      return ctx.fail(404, '用户不存在')
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    } finally {
      for (const name of suspendedNames) downloadQueue.releaseUser(name)
      if (dataLockAcquired) {
        accountChangeInProgress = false
        releaseDataOperation('account-change')
      }
    }
  })

  // 1. 读取用户歌单数据 (GET /api/user/list)
  router.get('/api/user/list', async ctx => {
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

  router.post('/api/user/playlists', async ctx => {
    const username = resolveTargetUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '公共歌单修改需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const mutation = await ctx.bodyJson<PlaylistMutation>(MAX_USER_SETTING_BODY_BYTES)
      if (!mutation || !['create', 'toggle', 'rename', 'delete'].includes(mutation.action))
        return ctx.fail(400, '歌单操作无效')
      if (mutation.action === 'create' || mutation.action === 'toggle') {
        const playlist = mutation.playlist
        if (
          !playlist ||
          typeof playlist.id !== 'string' ||
          !playlist.id.trim() ||
          ['default', 'love', 'temp'].includes(playlist.id) ||
          typeof playlist.name !== 'string' ||
          !playlist.name.trim() ||
          playlist.name.length > 80 ||
          !Array.isArray(playlist.list) ||
          playlist.list.some(song => !song || typeof song !== 'object' || Array.isArray(song))
        )
          return ctx.fail(400, '歌单数据无效')
        if (
          mutation.action === 'toggle' &&
          (!['wy', 'tx'].includes(String(playlist.source)) ||
            typeof playlist.sourceListId !== 'string' ||
            !playlist.sourceListId)
        )
          return ctx.fail(400, '在线歌单来源无效')
      } else {
        if (typeof mutation.id !== 'string' || !mutation.id) return ctx.fail(400, '歌单 ID 无效')
        if (
          mutation.action === 'rename' &&
          (typeof mutation.name !== 'string' || !mutation.name.trim() || mutation.name.length > 80)
        )
          return ctx.fail(400, '歌单名称无效')
      }
      const manager = getUserSpace(username).listManage
      const result = await manager.runWithPersistence(() => manager.listDataManage.mutatePlaylist(mutation))
      if (!result) return ctx.fail(404, '歌单不存在')
      return ctx.json({ success: true, ...result })
    } catch (err: any) {
      if (err instanceof PlaylistIdConflictError) return ctx.fail(409, err.message)
      return ctx.fail(400, toUserMessage(err, '歌单操作失败，请稍后重试'))
    }
  })

  // 2. 覆盖保存用户歌单数据 (POST /api/user/list)
  router.post('/api/user/list', async ctx => {
    const isAdmin = verifyAdminAuth(ctx.request)
    const username = resolveTargetUsername(ctx, false)

    if (!username) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    if (username === '_open' && !isAdmin) {
      return ctx.json({ success: false, error: '权限不足：公共歌单修改受限，请先验证管理员身份。' }, 403)
    }
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable

    try {
      const listData = await ctx.bodyJson<LX.List.ListData>()
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() => userSpace.listManage.listDataManage.restore(listData))
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 用户最近播放历史单独保存，避免播放时重写歌单数据。
  router.get('/api/user/play-history', ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const row = getDb()
        .query<{ value: string; updated_at: number }, [string, string]>(
          'SELECT value, updated_at FROM user_settings WHERE user_name = ? AND key = ?',
        )
        .get(username, PLAY_HISTORY_SETTING_KEY)
      const revision = row?.updated_at ?? 0
      const unchanged = ctx.query.get('v') === '2' && ctx.query.get('since') === String(revision)
      const items = unchanged ? [] : row ? validatePlayHistoryItems(JSON.parse(row.value)) : []
      return new Response(
        JSON.stringify(
          ctx.query.get('v') === '2' ? { items, revision, ...(unchanged ? { unchanged: true } : {}) } : { items },
        ),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        },
      )
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '播放历史读取失败'))
    }
  })

  router.post('/api/user/play-history', async ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable

    try {
      const body = await ctx.bodyJson<{ items?: unknown }>(MAX_USER_SETTING_BODY_BYTES)
      const incoming = validatePlayHistoryItems(body?.items)
      const db = getDb()
      const previous = db
        .query<{ value: string; updated_at: number }, [string, string]>(
          'SELECT value, updated_at FROM user_settings WHERE user_name = ? AND key = ?',
        )
        .get(username, PLAY_HISTORY_SETTING_KEY)
      const now = Date.now()
      const clampTime = (song: Record<string, unknown>) => ({
        ...song,
        playedAt: Math.min(Number(song.playedAt || 0), now),
      })
      const existing = previous ? validatePlayHistoryItems(JSON.parse(previous.value)).map(clampTime) : []
      const items = mergePlayHistory(existing, incoming.map(clampTime))
      db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        username,
        PLAY_HISTORY_SETTING_KEY,
        JSON.stringify(items),
        Math.max(now, (previous?.updated_at ?? 0) + 1),
      ])
      return ctx.json({ items })
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '播放历史保存失败'))
    }
  })

  // Playback events are idempotent so retries and multiple tabs cannot reorder a song twice.
  router.post('/api/user/play-history/events', async ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const body = await ctx.bodyJson<{ events?: unknown }>(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(body?.events) || body.events.length > 50) throw new Error('播放记录格式错误')
      const events = body.events.map((event: unknown) => {
        if (!isRecord(event) || typeof event.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(event.id))
          throw new Error('播放记录标识无效')
        return { id: event.id, song: validatePlayHistoryItems([event.song])[0]! }
      })
      const db = getDb()
      const result = db.transaction(() => {
        const getSetting = (key: string) =>
          db
            .query<{ value: string; updated_at: number }, [string, string]>(
              'SELECT value, updated_at FROM user_settings WHERE user_name = ? AND key = ?',
            )
            .get(username, key)
        const previous = getSetting(PLAY_HISTORY_SETTING_KEY)
        let history = previous ? validatePlayHistoryItems(JSON.parse(previous.value)) : []
        const now = Date.now()
        // Import IDs written by the previous release before removing its JSON blob.
        const legacy = getSetting('play_history_events')
        if (legacy) {
          const seen: Record<string, unknown> = JSON.parse(legacy.value)
          const insert = db.prepare(
            'INSERT OR IGNORE INTO play_history_events (user_name, event_id, created_at) VALUES (?, ?, ?)',
          )
          for (const [id, time] of Object.entries(seen)) {
            if (typeof time === 'number' && time >= now - 30 * 86400000) insert.run(username, id, time)
          }
          db.run('DELETE FROM user_settings WHERE user_name = ? AND key = ?', [username, 'play_history_events'])
        }
        const insert = db.prepare(
          'INSERT OR IGNORE INTO play_history_events (user_name, event_id, created_at) VALUES (?, ?, ?)',
        )
        let changed = false
        let orderTime = now
        for (const event of events) {
          if (!insert.run(username, event.id, now).changes) continue
          if (!changed)
            history = history.map(song => ({ ...song, playedAt: Math.min(now, Number(song.playedAt || 0)) }))
          const song = { ...event.song, playedAt: ++orderTime }
          history = [song, ...history.filter(item => playHistorySongKey(item) !== playHistorySongKey(song))].slice(
            0,
            MAX_PLAY_HISTORY_ITEMS,
          )
          changed = true
        }
        let revision = previous?.updated_at ?? 0
        if (changed) {
          revision = Math.max(now, revision + 1)
          db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
            username,
            PLAY_HISTORY_SETTING_KEY,
            JSON.stringify(history),
            revision,
          ])
          db.run('DELETE FROM play_history_events WHERE user_name = ? AND created_at < ?', [
            username,
            now - 30 * 86400000,
          ])
          db.run(
            `DELETE FROM play_history_events WHERE rowid IN (
            SELECT rowid FROM play_history_events WHERE user_name = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 5000
          )`,
            [username],
          )
        }
        return { items: history, revision }
      })()
      return ctx.json(result)
    } catch (err: any) {
      return ctx.fail(400, toUserMessage(err, '播放历史保存失败'))
    }
  })

  // 3. 用户曲库：歌手与专辑 (GET & POST)
  router.get('/api/user/library/artists', ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const db = getDb()
      const row = db
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(username, 'library_artists')

      if (row) {
        return ctx.json(JSON.parse(row.value))
      }
      return ctx.json([])
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/user/library/artists', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '修改公开收藏需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const parsed = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(parsed)) throw new Error('Expected an array')
      const db = getDb()
      db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        username,
        'library_artists',
        JSON.stringify(parsed),
        Date.now(),
      ])
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.get('/api/user/library/albums', ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const db = getDb()
      const row = db
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(username, 'library_albums')

      if (row) {
        return ctx.json(JSON.parse(row.value))
      }
      return ctx.json([])
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/user/library/albums', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) return ctx.fail(403, '修改公开收藏需要管理员权限')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const parsed = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      if (!Array.isArray(parsed)) throw new Error('Expected an array')
      const db = getDb()
      db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        username,
        'library_albums',
        JSON.stringify(parsed),
        Date.now(),
      ])
      return ctx.json({ success: true })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  // 4. 用户设置 (GET & POST /api/user/settings)
  router.get('/api/user/settings', ctx => {
    const resolvedUsername = resolveSettingsUsername(ctx)
    if (resolvedUsername instanceof Response) return resolvedUsername

    try {
      const db = getDb()
      const row = db
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(resolvedUsername, 'settings')

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

  router.post('/api/user/settings', async ctx => {
    const resolvedUsername = resolveSettingsUsername(ctx, true)
    if (resolvedUsername instanceof Response) return resolvedUsername
    const unavailable = rejectUnavailableDataWrite(ctx, resolvedUsername)
    if (unavailable) return unavailable

    try {
      const parsedSettings = await ctx.bodyJson<unknown>(MAX_USER_SETTING_BODY_BYTES)
      if (!isSettingsRecord(parsedSettings)) return ctx.fail(400, '设置数据格式错误')
      let settings: Record<string, unknown> = parsedSettings

      if (resolvedUsername === '_open' && global.lx.config['user.enablePublicRestriction']) {
        const restrictedSettings: Record<string, unknown> = {}
        const allowedKeys = [
          'serverCacheLocation',
          'serverCacheNamingPattern',
          'downloadConcurrency',
          'preferredQuality',
          'enablePublicSources',
        ]
        for (const key of allowedKeys) {
          if (settings[key] !== undefined) restrictedSettings[key] = settings[key]
        }
        settings = restrictedSettings
      }

      const db = getDb()
      const previous = db
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(resolvedUsername, 'settings')
      let existing: Record<string, unknown> = {}
      if (previous) {
        try {
          const parsed: unknown = JSON.parse(previous.value)
          if (isSettingsRecord(parsed)) existing = parsed
        } catch {
          /* Replace a malformed legacy value with valid settings. */
        }
      }
      const value = JSON.stringify({ ...existing, ...settings })
      if (Buffer.byteLength(value) > MAX_USER_SETTING_BODY_BYTES) return ctx.fail(413, '设置数据过大')
      db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        resolvedUsername,
        'settings',
        value,
        Date.now(),
      ])
      return ctx.json({ success: true })
    } catch {
      return ctx.fail(400, '请求数据格式错误')
    }
  })

  // 5. 音效配置 (GET & POST /api/user/sound-effects)
  router.get('/api/user/sound-effects', ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const db = getDb()
      const row = db
        .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
        .get(username, 'sound_effects')

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

  router.post('/api/user/sound-effects', async ctx => {
    const username = resolveTargetUsername(ctx, false)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    if (username === '_open' && !verifyAdminAuth(ctx.request)) {
      return ctx.fail(403, '权限不足：公开音效配置仅允许管理员修改')
    }
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const body = await ctx.bodyJson(MAX_USER_SETTING_BODY_BYTES)
      const db = getDb()
      db.run('INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)', [
        username,
        'sound_effects',
        JSON.stringify(body),
        Date.now(),
      ])
      return ctx.json({ success: true })
    } catch {
      return ctx.fail(400, '请求数据格式错误')
    }
  })

  // 6. 歌单与歌曲批量修改 (POST /api/music/user/list/*)
  router.post('/api/music/user/list/remove', async ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '需要用户认证，请先登录')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const { listId, songIds } = await ctx.bodyJson<{ listId?: string; songIds?: string[] }>()
      if (!listId || !Array.isArray(songIds)) return ctx.text('参数错误:需要listId和songIds数组', 400)
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() =>
        userSpace.listManage.listDataManage.listMusicRemove(listId, songIds),
      )
      return ctx.text('删除成功', 200)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '删除失败，请稍后重试'))
    }
  })

  router.post('/api/music/user/list/add', async ctx => {
    const username = verifyUserAuth(ctx)
    if (!username) return ctx.fail(401, '需要用户认证，请先登录')
    const unavailable = rejectUnavailableDataWrite(ctx, username)
    if (unavailable) return unavailable
    try {
      const {
        listId,
        musicInfos,
        location: requestedLocation,
      } = await ctx.bodyJson<{
        listId?: string
        musicInfos?: any[]
        location?: unknown
      }>()
      if (!listId || !Array.isArray(musicInfos)) return ctx.text('参数错误:需要listId和musicInfos数组', 400)
      const userLocation = global.lx.config.users.find(user => user.name === username)?.['list.addMusicLocationType']
      const configuredLocation = userLocation ?? global.lx.config['list.addMusicLocationType']
      const location =
        requestedLocation === 'top' || requestedLocation === 'bottom'
          ? requestedLocation
          : configuredLocation === 'top'
            ? 'top'
            : 'bottom'
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() =>
        userSpace.listManage.listDataManage.listMusicAdd(listId, musicInfos, location),
      )
      return ctx.text('添加成功', 200)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '添加失败，请稍后重试'))
    }
  })

  // 7. 管理员读取用户歌单数据
  router.get('/api/data', async ctx => {
    const userParam = ctx.query.get('user')
    if (!userParam) return ctx.fail(400, '缺少必要参数：user')

    const verifiedUser = resolveDataUsername(ctx, userParam)
    if (!verifiedUser) return ctx.fail(403, '没有权限操作该用户的数据')

    try {
      const userSpace = getUserSpace(verifiedUser)
      const data = await userSpace.listManage.getListData()
      return ctx.json(data)
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 8. 歌单与歌曲精准修改 (POST /api/data/*)
  router.post('/api/data/delete-playlist', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId } = await ctx.bodyJson<{ username?: string; playlistId?: string }>()
      if (!username || !playlistId) return ctx.fail(400, '缺少必要参数')
      if ([LIST_IDS.DEFAULT, LIST_IDS.LOVE, LIST_IDS.TEMP, LIST_IDS.DOWNLOAD].includes(playlistId as any)) {
        return ctx.fail(422, '不能删除内置歌单')
      }
      const unavailable = rejectUnavailableDataWrite(ctx, username)
      if (unavailable) return unavailable
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() =>
        userSpace.listManage.listDataManage.userListsRemove([playlistId]),
      )
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/delete-song', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId, songId } = await ctx.bodyJson<{
        username?: string
        playlistId?: string
        songId?: string
      }>()
      if (!username || !playlistId || !songId) return ctx.fail(400, '缺少必要参数')
      const unavailable = rejectUnavailableDataWrite(ctx, username)
      if (unavailable) return unavailable
      const userSpace = getUserSpace(username)
      await userSpace.listManage.runWithPersistence(() =>
        userSpace.listManage.listDataManage.listMusicRemove(playlistId, [songId]),
      )
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/rename-playlist', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId, newName } = await ctx.bodyJson<{
        username?: string
        playlistId?: string
        newName?: string
      }>()
      if (!username || !playlistId || !newName) return ctx.fail(400, '缺少必要参数')
      const unavailable = rejectUnavailableDataWrite(ctx, username)
      if (unavailable) return unavailable
      const userSpace = getUserSpace(username)
      const listData = await userSpace.listManage.getListData()
      const target = listData.userList.find((l: any) => l.id === playlistId)
      if (!target) return ctx.fail(404, '歌单不存在')
      target.name = newName
      await userSpace.listManage.runWithPersistence(() => userSpace.listManage.listDataManage.restore(listData))
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/data/batch-delete-songs', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { username, playlistId, songIndices } = await ctx.bodyJson<{
        username?: string
        playlistId?: string
        songIndices?: number[]
      }>()
      if (!username || !playlistId || !Array.isArray(songIndices)) return ctx.fail(400, '缺少必要参数')
      const unavailable = rejectUnavailableDataWrite(ctx, username)
      if (unavailable) return unavailable

      const userSpace = getUserSpace(username)
      const listManage = userSpace.listManage
      const listData = await listManage.getListData()
      const playlist = listData.userList.find((list: any) => list.id === playlistId)
      if (!playlist) return ctx.fail(404, '歌单不存在')

      const songIds = songIndices.map(index => playlist.list?.[index]?.id).filter(Boolean)
      if (songIds.length === 0) return ctx.fail(400, '没有选中有效的歌曲')

      await listManage.runWithPersistence(() => listManage.listDataManage.listMusicRemove(playlistId, songIds))
      return ctx.json({ success: true })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  return router
}
