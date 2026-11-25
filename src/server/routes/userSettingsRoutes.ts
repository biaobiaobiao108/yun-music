import { Router, type HttpContext } from '../core'
import { toUserMessage } from '../core/context'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import { getUserSpace } from '@/user'
import { getDb } from '@/database'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { LIST_IDS } from '@/constants'
import { normalizePlaybackSettings } from '../../../frontend/shared/src/playback-settings'
import { MAX_USER_SETTING_BODY_BYTES, rejectUnavailableDataWrite, resolveTargetUsername } from './userRouteShared'

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
    const canAccessOpen = isAdmin || !!verified || Boolean(global.lx.config['user.enablePublicNonAdminAccess'])
    if (!canAccessOpen) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
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

function readSettingsRecord(username: string): Record<string, unknown> {
  try {
    const row = getDb()
      .query<{ value: string }, [string, string]>('SELECT value FROM user_settings WHERE user_name = ? AND key = ?')
      .get(username, 'settings')
    if (!row) return {}
    const parsed: unknown = JSON.parse(row.value)
    return isSettingsRecord(parsed) ? parsed : {}
  } catch (error) {
    console.error('Failed to get user settings from DB:', error)
    return {}
  }
}

export const createUserSettingsRouter = (): Router => {
  const router = new Router()

  // 4. 用户设置 (GET & POST /api/user/settings)
  router.get('/api/user/settings', ctx => {
    const resolvedUsername = resolveSettingsUsername(ctx)
    if (resolvedUsername instanceof Response) return resolvedUsername
    return ctx.json(readSettingsRecord(resolvedUsername))
  })

  router.get('/api/user/playback-settings', ctx => {
    const resolvedUsername = resolveSettingsUsername(ctx)
    if (resolvedUsername instanceof Response) return resolvedUsername
    return ctx.json(normalizePlaybackSettings(readSettingsRecord(resolvedUsername)))
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

      if (resolvedUsername === '_open' && !verifyAdminAuth(ctx.request)) {
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
