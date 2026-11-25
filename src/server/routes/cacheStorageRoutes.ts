import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as fileCache from '../fileCache'
import { accessLog } from '@/utils/log4js'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { canReadPublicLocalMusic } from '../localMusicAccess'
import { getCacheRequestUsername, noStoreFail, resolveCacheTarget } from './cacheRouteShared'

export const createCacheStorageRouter = (): Router => {
  const router = new Router()

  // 1. 缓存基础配置与索引同步
  router.post('/api/music/cache/config', async ctx => {
    // 缓存位置与命名规则是全局设置，不能由普通用户改变整个实例的
    // 存储路径或后续文件命名策略。
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(403, '权限不足：修改全局缓存配置需要管理员身份')

    try {
      const { location, namingPattern } = await ctx.bodyJson<{ location?: string; namingPattern?: string }>()
      let updated = false
      const config = global.lx.config
      const previousLocation = fileCache.getCacheLocation()
      const previousNamingPattern = fileCache.getNamingPattern()
      const previousConfiguredLocation = config?.serverCacheLocation

      if (location !== undefined) {
        if (location !== fileCache.CACHE_ROOTS.DATA && location !== fileCache.CACHE_ROOTS.ROOT) {
          return ctx.fail(422, '缓存位置必须是 data 或 root')
        }
      }

      if (location && (location !== previousLocation || config?.serverCacheLocation !== location)) {
        fileCache.setCacheLocation(location)
        if (config) config.serverCacheLocation = location
        updated = true
      }

      if (namingPattern !== undefined) {
        if (
          namingPattern !== fileCache.CACHE_NAMING_PATTERNS.SIMPLE &&
          namingPattern !== fileCache.CACHE_NAMING_PATTERNS.STANDARD
        ) {
          return ctx.fail(422, '缓存命名规则无效')
        }
        const normalizedNamingPattern = fileCache.setNamingPattern(namingPattern)
        if (config && config['cache.namingPattern'] !== normalizedNamingPattern) {
          config['cache.namingPattern'] = normalizedNamingPattern
          updated = true
        }
      }

      if (updated) {
        try {
          if (global.lx.saveConfig) await global.lx.saveConfig()
        } catch (error) {
          fileCache.setCacheLocation(previousLocation)
          fileCache.setNamingPattern(previousNamingPattern)
          if (config) {
            if (previousConfiguredLocation === undefined) delete config.serverCacheLocation
            else config.serverCacheLocation = previousConfiguredLocation
            if (previousNamingPattern === undefined) delete config['cache.namingPattern']
            else config['cache.namingPattern'] = previousNamingPattern
          }
          throw error
        }
        return ctx.json({ success: true })
      }
      return ctx.json({ success: true, message: '配置未发生变化' })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '保存缓存配置失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/sync', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      await fileCache.syncCacheIndex(target.username)
      return ctx.json({ success: true, message: 'Sync completed' })
    } catch (e: any) {
      return ctx.fail(500, '同步缓存索引失败，请稍后重试')
    }
  })

  router.get('/api/music/cache/subdirs', ctx => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    const requestedFolder = ctx.query.get('folder')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') {
      return ctx.fail(400, '目录类型不合法')
    }
    const folder = (requestedFolder as fileCache.CacheFolder | null) || 'music'
    const subdirs = fileCache.getSubDirectories(username, folder)
    return ctx.json({ success: true, data: subdirs })
  })

  router.post('/api/music/cache/mkdir', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const { folder, subPath } = await ctx.bodyJson<{ folder?: fileCache.CacheFolder; subPath?: string }>()
      if (!folder || !subPath) return ctx.fail(400, '缺少必要参数：folder、subPath')
      if (folder !== 'cache' && folder !== 'music') return ctx.fail(400, '目录类型不合法')
      const success = fileCache.createSubDirectory(username, folder, subPath)
      return ctx.json({ success })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '创建目录失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/categorize', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const { filenames, subPath } = await ctx.bodyJson<{ filenames?: string[]; subPath?: string }>()
      if (!Array.isArray(filenames) || typeof subPath !== 'string')
        return ctx.fail(400, '缺少必要参数：filenames、subPath')
      const result = await fileCache.categorizeFiles(filenames, subPath, username)
      return ctx.json({ success: true, ...result })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '归类文件失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/rename', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const result = await fileCache.batchRenameCacheFiles(username)
      return ctx.json(result)
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '批量重命名失败，请稍后重试'))
    }
  })

  // 4. 播放触达记录：仅由播放器在 audio.play() 成功后调用，供缓存上限
  // 按最近播放时间做 LRU 清理。请求目标由 user 查询参数限定在当前用户
  // 或公共空间，不能跨用户写入播放记录。
  router.post('/api/music/cache/playback', async ctx => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    try {
      const body = await ctx.bodyJson<{ filename?: string; folder?: fileCache.CacheFolder; location?: string }>()
      if (!body.filename || typeof body.filename !== 'string') return ctx.fail(400, '缺少必要参数：filename')
      if (body.folder !== 'cache' && body.folder !== 'music') return ctx.fail(400, '目录类型不合法')
      if (body.location && body.location !== fileCache.CACHE_ROOTS.DATA && body.location !== fileCache.CACHE_ROOTS.ROOT)
        return ctx.fail(400, '缓存位置不合法')

      const marked = body.location
        ? fileCache.markCachePlayback(body.filename, username, body.folder, body.location)
        : fileCache.markCachePlayback(body.filename, username, body.folder)
      return ctx.json({ success: true, data: { marked } })
    } catch (err) {
      return ctx.fail(400, toUserMessage(err, '记录播放时间失败，请稍后重试'))
    }
  })

  // 9. 缓存统计与清理
  router.get('/api/music/cache/stats', ctx => {
    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const stats = fileCache.getCachedCacheStats(username)
      return ctx.json({ success: true, data: stats })
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '获取缓存统计失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/clear', ctx => {
    const isAdmin = verifyAdminAuth(ctx.request)
    const reqUser = ctx.query.get('user')
    if (reqUser === 'all' || reqUser === '_all') {
      if (!isAdmin) {
        return ctx.fail(403, '权限不足：只有管理员可以清空所有用户缓存')
      }
      try {
        const result = fileCache.clearAllUsersAudioCache()
        return ctx.json({ success: true, data: result })
      } catch (err) {
        return ctx.fail(500, toUserMessage(err, '清空缓存失败，请稍后重试'))
      }
    }

    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const result = fileCache.clearOnlyAudioCache(target.username)
      return ctx.json({ success: true, data: result })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '清空缓存失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/lyric/clear', ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const result = fileCache.clearLyricCache(target.username)
      return ctx.json({ success: true, data: result })
    } catch (err) {
      return ctx.fail(500, toUserMessage(err, '清空歌词缓存失败，请稍后重试'))
    }
  })

  router.get('/api/music/cache/list', async ctx => {
    const targetUserParam = ctx.query.get('user')
    const reqUsername = targetUserParam || ''
    const isAdmin = verifyAdminAuth(ctx.request)
    const verified = verifyUserAuth(ctx)
    const isPublicAlias = reqUsername === 'default' || reqUsername === 'open' || reqUsername === '_open'
    const isAll = reqUsername === 'all' || reqUsername === '_all'
    const pageParam = ctx.query.get('page')
    if (pageParam !== null) {
      if (!isAdmin) return ctx.fail(403, '权限不足：只有管理员可以分页查看存储文件')
      const page = Number(pageParam)
      const folder = ctx.query.get('folder')
      if (!Number.isSafeInteger(page) || page < 0 || (folder !== 'cache' && folder !== 'music')) {
        return ctx.fail(400, '存储分页参数无效')
      }
      const user = isAll ? undefined : isPublicAlias || !reqUsername ? '_open' : reqUsername
      try {
        if (user) assertSafePathSegment(user, 'user name')
        return ctx.json({
          success: true,
          ...fileCache.getCachePage(user, {
            page,
            folder,
            query: (ctx.query.get('query') ?? '').trim().slice(0, 256),
            sort: ctx.query.get('sort') ?? '',
          }),
        })
      } catch (error) {
        return ctx.fail(500, toUserMessage(error, '无法读取存储列表'))
      }
    }

    if (isAll) {
      if (!isAdmin) {
        return ctx.fail(403, '权限不足：只有管理员可以查看所有用户缓存与下载数据')
      }
      try {
        const list = await fileCache.getAllCacheList()
        return ctx.json({ success: true, data: list }, 200, {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        })
      } catch (err: any) {
        return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
      }
    }

    let username = '_open'

    if (isAdmin && reqUsername && !isPublicAlias) {
      try {
        username = assertSafePathSegment(reqUsername, 'user name')
      } catch {
        return ctx.fail(400, '用户参数不合法')
      }
    } else if (!reqUsername && verified) {
      username = verified
    } else if (!reqUsername || isPublicAlias) {
      if (!canReadPublicLocalMusic(ctx, verified, isAdmin)) {
        return noStoreFail(ctx, 403, '您没有权限查看此目录，请联系管理员设置')
      }
      username = '_open'
    } else {
      if (!verified) {
        return noStoreFail(ctx, 401, '登录状态已失效，请重新登录')
      }
      if (verified !== reqUsername) {
        return noStoreFail(ctx, 403, '无权访问其他用户的本地音乐')
      }
      username = verified
    }

    try {
      const list = await fileCache.getCacheList(username)
      return ctx.json({ success: true, data: list }, 200, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  router.post('/api/music/cache/remove', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username
    const isAdmin = verifyAdminAuth(ctx.request)

    try {
      const payload = await ctx.bodyJson<any>()
      const legacyFilenames = payload.filenames
      const rawItems = Array.isArray(payload.items)
        ? payload.items
        : legacyFilenames
          ? Array.isArray(legacyFilenames)
            ? legacyFilenames
            : [legacyFilenames]
          : []
      if (rawItems.length === 0) throw new Error('Missing items')

      const deleteItems: Array<{
        filename: string
        folder?: fileCache.CacheFolder
        location?: string
        user?: string
      }> = rawItems.map((item: any) => {
        if (typeof item === 'string') return { filename: item }
        if (!item || typeof item.filename !== 'string') throw new Error('Invalid delete item')
        if (item.folder !== undefined && item.folder !== 'cache' && item.folder !== 'music') {
          throw new Error('Invalid folder')
        }
        if (
          item.location !== undefined &&
          item.location !== fileCache.CACHE_ROOTS.DATA &&
          item.location !== fileCache.CACHE_ROOTS.ROOT
        ) {
          throw new Error('Invalid location')
        }
        const requestedUser =
          typeof item.user === 'string' && item.user
            ? item.user
            : typeof item.rawUsername === 'string' && item.rawUsername
              ? item.rawUsername
              : undefined
        if (!isAdmin && requestedUser && requestedUser !== username) {
          throw new Error('普通用户不能指定其他缓存所有者')
        }
        return {
          filename: item.filename,
          folder: item.folder,
          location: item.location,
          user: requestedUser,
        }
      })

      let deletedCount = 0
      const failures: Array<{ filename: string; folder?: fileCache.CacheFolder; message: string }> = []
      for (const item of deleteItems) {
        try {
          const itemUser = isAdmin && item.user ? assertSafePathSegment(item.user, 'user name') : username
          const result = item.location
            ? fileCache.removeCacheFile(item.filename, itemUser, item.folder, item.location)
            : fileCache.removeCacheFile(item.filename, itemUser, item.folder)
          if (result.deleted) {
            deletedCount++
            accessLog.info(
              `music file deleted user=${itemUser} folder=${result.folder} filename=${JSON.stringify(item.filename)}`,
            )
          } else {
            failures.push({ ...item, message: 'File not found' })
          }
        } catch (error: any) {
          failures.push({ ...item, message: error?.message || 'Delete failed' })
          accessLog.warn(
            `music file delete rejected user=${item.user || username} folder=${item.folder || 'unspecified'} filename=${JSON.stringify(item.filename)} reason=${JSON.stringify(error?.message || 'Delete failed')}`,
          )
        }
      }

      const success = failures.length === 0
      const statusCode = success ? 200 : deletedCount > 0 ? 207 : 409
      return ctx.json(
        {
          success,
          deletedCount,
          failedCount: failures.length,
          failures,
          message: success ? undefined : failures[0]?.message,
        },
        statusCode,
      )
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.post('/api/music/cache/move', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const isAdmin = verifyAdminAuth(ctx.request)

    try {
      const payload = await ctx.bodyJson<any>()
      const requestedTargetFolder =
        payload.targetFolder === undefined || payload.targetFolder === null || payload.targetFolder === ''
          ? undefined
          : payload.targetFolder === 'cache' || payload.targetFolder === 'music'
            ? (payload.targetFolder as fileCache.CacheFolder)
            : null
      if (payload.targetFolder !== undefined && requestedTargetFolder === null) return ctx.fail(400, '目标目录不合法')
      const rawItems = Array.isArray(payload.items)
        ? payload.items
        : payload.filenames
          ? Array.isArray(payload.filenames)
            ? payload.filenames.map((f: string) => ({ filename: f, user: payload.user }))
            : [{ filename: payload.filenames, user: payload.user }]
          : []
      if (rawItems.length === 0) return ctx.fail(400, '缺少必要参数：filenames')
      if (rawItems.length > 500) return ctx.fail(400, '单次最多移动 500 个文件')

      const userGroup = new Map<string, { user: string; location?: string; filenames: string[] }>()
      const publicPromotions: Array<{ filename: string; sourceUser: string; location?: string }> = []
      for (const item of rawItems) {
        const requestedSourceUser = String(item.sourceUser || item.user || item.rawUsername || '').trim()
        const sourceUser = ['open', 'default', '_open'].includes(requestedSourceUser) ? '_open' : requestedSourceUser
        if (
          item.location !== undefined &&
          item.location !== fileCache.CACHE_ROOTS.DATA &&
          item.location !== fileCache.CACHE_ROOTS.ROOT
        ) {
          return ctx.fail(400, '缓存位置不合法')
        }
        const location = item.location as string | undefined
        if (!isAdmin && sourceUser === '_open' && target.username !== '_open' && requestedTargetFolder === 'music') {
          publicPromotions.push({ filename: item.filename, sourceUser, location })
          continue
        }
        const itemUser = isAdmin && sourceUser ? assertSafePathSegment(sourceUser, 'user name') : target.username
        const groupKey = JSON.stringify([itemUser, location ?? null])
        const group = userGroup.get(groupKey) || { user: itemUser, location, filenames: [] }
        group.filenames.push(item.filename)
        userGroup.set(groupKey, group)
      }

      let totalSuccess = 0
      let totalFail = 0
      const moved: Array<{ filename: string; from: fileCache.CacheFolder; to: fileCache.CacheFolder; user: string }> =
        []
      for (const item of publicPromotions) {
        const result = await fileCache.promoteCacheFile(
          item.filename,
          item.sourceUser,
          target.username,
          'cache',
          item.location,
        )
        totalSuccess += result.successCount
        totalFail += result.failCount
        moved.push(...result.moved.map(entry => ({ ...entry, user: target.username })))
      }
      for (const { user, location, filenames } of userGroup.values()) {
        const result = await fileCache.switchFolder(filenames, user, requestedTargetFolder ?? undefined, location)
        totalSuccess += result.successCount
        totalFail += result.failCount
        moved.push(...result.moved.map(item => ({ ...item, user })))
      }
      return ctx.json({ success: true, successCount: totalSuccess, failCount: totalFail, moved })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '移动文件失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/switch-base', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filenames } = await ctx.bodyJson<{ filenames?: string[] | string }>()
      if (!filenames) return ctx.fail(400, '缺少必要参数：filenames')
      const fileList = Array.isArray(filenames) ? filenames : [filenames]
      if (fileList.length > 500) return ctx.fail(400, '单次最多转移 500 个文件')
      const result = await fileCache.switchBaseLocation(fileList, target.username)
      return ctx.json({ success: true, ...result })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '跨目录转移文件失败，请稍后重试'))
    }
  })

  return router
}
