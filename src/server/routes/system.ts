import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Router, getCompressedCacheStats } from '../core'
import { toUserMessage } from '../core/context'
import { revokeAllAdminSessions, revokeAllPlayerSessions, verifyAdminAuth } from '../auth'
import { revokeAllUserSessions } from './auth'
import { serverStatus } from '../state'
import { resolveInside } from '@/utils/pathSecurity'
import {
  createLocalBackup,
  LocalBackupTooLargeError,
  MAX_LOCAL_BACKUP_BYTES,
  MAX_BACKUP_UPLOAD_BYTES,
  restoreLocalBackup,
} from '../localBackupService'
import { refreshUsersFromDatabase } from '@/user/data'
import { resetUserSpaces } from '@/user'
import * as fileCache from '../fileCache'
import { getDatabaseStorageStats, vacuumDatabase } from '@/database'
import { temporaryFileStream } from '../temporaryFileStream'
import { getProcessMemorySnapshot } from '../memoryMaintenance'
import { getResourceBudgetStats } from '../resourceBudget'
import { getSourceMatchCacheStats } from '../services/musicResolver'
import { getSingerCacheStats } from '../utils/singer'
import { getGeneralCacheStats } from '@/utils/cache'
import { initUserApis } from '../userApi'
import { reconcileRestoredQueue } from '../serverDownloadQueue'
import { MultipartUploadTooLargeError, readMultipartBoundary, writeMultipartBackupToFile } from './backupUpload'
import { readLogTail } from './systemLogs'
import {
  applyValidatedConfig,
  normalizeProxyAddress,
  redactUrlCredentials,
  reloadServerData,
  SystemConfigValidationError,
  updateServerConfig,
} from './systemConfig'

/** 注册系统运维与管理相关路由 */
export const createSystemRouter = (): Router => {
  const router = new Router()

  // 1. 服务运行统计 (CPU/内存/状态)
  router.get('/api/stats', ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    const stats = {
      users: global.lx.config.users?.length ?? 0,
      publicAccess: global.lx.config['user.enablePublicNonAdminAccess'] === true,
      serverStatus: serverStatus.status,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      cacheStats: fileCache.getCachedGlobalCacheStats(),
      cacheLimit: global.lx.config['user.cacheSizeLimit'] || 2000,
    }
    return ctx.json(stats)
  })

  // 1.1 SQLite 存储状态与显式压缩。VACUUM 可能短暂占用额外磁盘空间，
  // 因此只允许管理员按需执行，不在普通请求或启动时自动触发。
  router.get('/api/admin/database/stats', ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    return ctx.json({ success: true, data: getDatabaseStorageStats() })
  })

  router.post('/api/admin/database/vacuum', ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    try {
      return ctx.json({ success: true, data: vacuumDatabase() })
    } catch (error) {
      return ctx.fail(500, toUserMessage(error, '数据库压缩失败，请稍后重试'))
    }
  })

  // 1.2 详细系统状态 /api/status
  router.get('/api/status', ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }

    const totalMem = os.totalmem()
    const freeMem = os.freemem()

    const getSystemCpuUsage = () => {
      const cpus = os.cpus()
      let idle = 0
      let total = 0
      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          total += (cpu.times as any)[type]
        }
        idle += cpu.times.idle
      })
      const last = (global.lx as any).lastCpuSample || { idle: 0, total: 0 }
      const deltaIdle = idle - last.idle
      const deltaTotal = total - last.total
      ;(global.lx as any).lastCpuSample = { idle, total }
      if (deltaTotal === 0) return '0.00'
      return (100 * (1 - deltaIdle / deltaTotal)).toFixed(2)
    }

    const getProcessCpuUsage = () => {
      const currentUsage = process.cpuUsage()
      const currentTime = Date.now()
      const last = (global.lx as any).lastProcessSample || { cpu: process.cpuUsage(), time: Date.now() - 100 }
      const deltaUsage = {
        user: currentUsage.user - last.cpu.user,
        system: currentUsage.system - last.cpu.system,
      }
      const deltaTime = (currentTime - last.time) * 1000
      ;(global.lx as any).lastProcessSample = { cpu: currentUsage, time: currentTime }
      if (deltaTime === 0) return '0.00'
      return (((deltaUsage.user + deltaUsage.system) / deltaTime / os.cpus().length) * 100).toFixed(2)
    }

    const processMemory = getProcessMemorySnapshot()
    const status = {
      users: global.lx.config.users.length,
      publicAccess: global.lx.config['user.enablePublicNonAdminAccess'] === true,
      uptime: process.uptime(),
      memory: processMemory.rss,
      processSwap: processMemory.swap,
      processFootprint: processMemory.footprint,
      heapUsed: processMemory.heapUsed,
      externalMemory: processMemory.external,
      containerMemoryLimit: processMemory.containerMemoryLimit ?? null,
      gcPressureLimit: processMemory.pressureLimit,
      resourceBudgets: getResourceBudgetStats(),
      memoryCaches: {
        sourceMatch: getSourceMatchCacheStats(),
        singers: getSingerCacheStats(),
        general: getGeneralCacheStats(),
        index: fileCache.indexManager.getMemoryStats(),
        compressed: getCompressedCacheStats(),
      },
      totalMemory: totalMem,
      freeMemory: freeMem,
      systemMemoryUsage: (((totalMem - freeMem) / totalMem) * 100).toFixed(2),
      processMemoryUsage: ((processMemory.rss / totalMem) * 100).toFixed(2),
      cpuUsage: getSystemCpuUsage(),
      processCpuUsage: getProcessCpuUsage(),
      osUptime: os.uptime(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || 'Unknown',
      cpuSpeed: os.cpus()[0]?.speed || 0,
      cacheStats: fileCache.getCachedGlobalCacheStats(),
      cacheLimit: global.lx.config['user.cacheSizeLimit'] || 2000,
    }

    return ctx.json(status)
  })

  // 2. 日志读取
  router.get('/api/logs', async ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    const logType = ctx.query.get('type') || 'app'
    const fileNames: Record<string, string> = {
      app: 'app.log',
      access: 'access.log',
      login: 'login.log',
      error: 'errors.log',
      errors: 'errors.log',
    }
    const fileName = fileNames[logType] || fileNames.app
    const requestedLines = Number.parseInt(ctx.query.get('lines') || '100', 10)
    const lineLimit = Number.isInteger(requestedLines) ? Math.min(Math.max(requestedLines, 1), 500) : 100
    const logFilePath = path.join(global.lx.logPath || path.join(process.cwd(), 'logs'), fileName)

    if (!fs.existsSync(logFilePath)) {
      return ctx.json({ logs: [], lines: [] })
    }
    try {
      const selectedLines = await readLogTail(logFilePath, lineLimit)
      // `logs` is the public API field consumed by the admin UI. Keep the
      // historical `lines` alias for older clients.
      return ctx.json({ logs: selectedLines, lines: selectedLines })
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  // 3. 配置读取与更新 (GET & POST)
  router.get('/api/config', ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    const c = global.lx.config
    const config = {
      serverName: c.serverName,
      'list.addMusicLocationType': c['list.addMusicLocationType'],
      'proxy.enabled': c['proxy.enabled'],
      'proxy.header': c['proxy.header'],
      'proxy.trustedAddresses': [...(c['proxy.trustedAddresses'] || [])],
      'user.enablePath': c['user.enablePath'],
      'user.enableRoot': c['user.enableRoot'],
      'user.enablePublicRestriction': c['user.enablePublicRestriction'],
      'user.enablePublicNonAdminLocalMusic': c['user.enablePublicNonAdminLocalMusic'],
      'user.enablePublicFavorites': c['user.enablePublicFavorites'],
      'user.enablePublicNonAdminAccess': c['user.enablePublicNonAdminAccess'],
      'user.enableLoginCacheRestriction': c['user.enableLoginCacheRestriction'],
      'user.enableCacheSizeLimit': c['user.enableCacheSizeLimit'],
      'user.cacheSizeLimit': c['user.cacheSizeLimit'],
      'frontend.passwordConfigured': Boolean(c['frontend.passwordHash'] || c['frontend.password']),
      'frontend.passwordManaged': Boolean(global.lx.managedCredentials?.adminPassword),
      'player.enableAuth': c['player.enableAuth'] || false,
      'player.passwordConfigured': Boolean(c['player.passwordHash'] || c['player.password']),
      'player.passwordManaged': Boolean(global.lx.managedCredentials?.playerPassword),
      'proxy.all.enabled': c['proxy.all.enabled'] || false,
      'proxy.all.address': redactUrlCredentials(c['proxy.all.address']),
      'admin.path': c['admin.path'] ?? '',
      'player.path': c['player.path'] ?? '/music',
      'singer.sourcePriority': (c['singer.sourcePriority'] || ['tx', 'wy']).join(','),
      'artist.maxFetchPages': c['artist.maxFetchPages'] ?? 20,
    }
    return ctx.json(config)
  })

  router.post('/api/config', async ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }

    try {
      const newConfig = await ctx.bodyJson<Record<string, any>>()
      const warning = await updateServerConfig(newConfig)
      return ctx.json({ success: true, warning })
    } catch (error) {
      if (error instanceof SystemConfigValidationError) {
        return ctx.json({ success: false, error: error.message }, 422)
      }
      return ctx.fail(500, toUserMessage(error, '操作失败，请稍后重试'))
    }
  })

  // 3.1 测试代理
  router.post('/api/config/test-proxy', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { address } = await ctx.bodyJson<{ address?: string }>()
      if (!address) throw new Error('Missing address')
      const normalizedAddress = normalizeProxyAddress(address)
      if (!normalizedAddress) throw new Error('代理地址不能为空')

      const startTime = Date.now()
      const resp = await fetch('https://www.baidu.com', {
        proxy: normalizedAddress,
        signal: AbortSignal.timeout(10000),
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
        },
      })
      await resp.body?.cancel()
      const duration = Date.now() - startTime
      return ctx.json({ success: true, message: `连接成功 (状态码: ${resp.status}, 耗时: ${duration}ms)` })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '操作失败，请稍后重试'))
    }
  })

  // 4. 重启与热重载
  router.post('/api/admin/reload', async ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    await reloadServerData()
    return ctx.json({ success: true, message: '服务器数据已重新加载' })
  })

  router.post('/api/restart', ctx => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    setTimeout(() => {
      process.emit('SIGTERM')
    }, 500)
    return ctx.json({ success: true, message: '服务器正在重启，请稍后刷新页面' })
  })

  // 5. 本地备份下载
  router.get('/api/backup/download', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const zipName = await createLocalBackup()
      if (!zipName) throw new Error('Backup creation failed')
      const zipPath = resolveInside(global.lx.dataPath, zipName)
      if (!fs.existsSync(zipPath)) throw new Error('ZIP file not found')
      const body = temporaryFileStream(zipPath)
      return new Response(body, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName}"`,
        },
      })
    } catch (err: any) {
      if (err instanceof LocalBackupTooLargeError) return ctx.fail(413, err.message)
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  // 6. 本地备份还原。上传内容只进入临时目录，完成路径/类型校验后才替换
  // 用户数据和 SQLite；恢复后撤销所有会话，避免备份中的旧凭证重新生效。
  router.post('/api/backup/upload', async ctx => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    const rawContentType = ctx.headers.get('content-type') || ''
    const contentType = rawContentType.toLowerCase()
    const isMultipart = contentType.startsWith('multipart/form-data')
    const maxUploadBytes = isMultipart ? MAX_BACKUP_UPLOAD_BYTES : MAX_LOCAL_BACKUP_BYTES
    const boundary = isMultipart ? readMultipartBoundary(rawContentType) : null
    if (isMultipart && !boundary) return ctx.fail(400, 'multipart 备份格式无效')
    const declaredLength = Number(ctx.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      return ctx.fail(413, '备份文件大小不能超过 100 MB')
    }

    let previousConfig = { ...global.lx.config }
    const onRestored = async (restoredConfig: Record<string, unknown>) => {
      try {
        await applyValidatedConfig(restoredConfig)
        resetUserSpaces()
        refreshUsersFromDatabase()
        await initUserApis()
        if (global.lx.config.serverCacheLocation) {
          fileCache.setCacheLocation(global.lx.config.serverCacheLocation)
        }
        global.lx.config['cache.namingPattern'] = fileCache.setNamingPattern(global.lx.config['cache.namingPattern'])
        if (global.lx.saveConfig) await global.lx.saveConfig()
        revokeAllUserSessions()
        revokeAllPlayerSessions()
        revokeAllAdminSessions()
        await reconcileRestoredQueue(global.lx.config.users.map(user => user.name))
      } catch (error) {
        for (const key of Object.keys(global.lx.config)) {
          if (!(key in previousConfig)) delete (global.lx.config as any)[key]
        }
        Object.assign(global.lx.config, previousConfig)
        // If persistence failed after partially writing config.js, restore
        // the in-memory configuration there as well. The backup service
        // rolls the database and user directory back around this callback.
        if (global.lx.saveConfig) {
          try {
            await global.lx.saveConfig()
          } catch (rollbackError) {
            console.error('[Backup] 配置回滚写盘失败:', rollbackError)
          }
        }
        // The backup service rolls the database back only after this callback
        // throws. Keep the users restored from previousConfig; refreshing now
        // would overwrite them with the still-installed backup accounts.
        try {
          if (global.lx.config.serverCacheLocation) fileCache.setCacheLocation(global.lx.config.serverCacheLocation)
          global.lx.config['cache.namingPattern'] = fileCache.setNamingPattern(global.lx.config['cache.namingPattern'])
        } catch (cacheError) {
          console.error('[Backup] 回滚后恢复缓存目录失败:', cacheError)
        }
        throw error
      }
    }

    let tempUploadPath = ''
    let tempMultipartPath = ''
    try {
      let source: { filePath: string }
      if (isMultipart) {
        const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
        tempMultipartPath = path.join(global.lx.dataPath, `.lx-backup-multipart-${suffix}.tmp`)
        tempUploadPath = path.join(global.lx.dataPath, `.lx-backup-upload-${suffix}.zip`)
        try {
          await ctx.writeBodyToFile(tempMultipartPath, maxUploadBytes)
        } catch (writeError) {
          if (writeError instanceof Error && writeError.message === 'Request body is too large') {
            fs.rmSync(tempMultipartPath, { force: true })
            tempMultipartPath = ''
            return ctx.fail(413, '备份文件大小不能超过 100 MB')
          }
          throw writeError
        }
        const uploadSize = await writeMultipartBackupToFile(
          Bun.file(tempMultipartPath).stream(),
          boundary!,
          tempUploadPath,
          MAX_LOCAL_BACKUP_BYTES,
        )
        fs.rmSync(tempMultipartPath, { force: true })
        tempMultipartPath = ''
        if (uploadSize === 0) {
          fs.rmSync(tempUploadPath, { force: true })
          return ctx.fail(400, '请选择 ZIP 备份文件')
        }
        source = { filePath: tempUploadPath }
      } else {
        tempUploadPath = path.join(
          global.lx.dataPath,
          `.lx-backup-upload-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`,
        )
        try {
          const written = await ctx.writeBodyToFile(tempUploadPath, MAX_LOCAL_BACKUP_BYTES)
          if (written === 0) {
            fs.rmSync(tempUploadPath, { force: true })
            return ctx.fail(400, '请选择 ZIP 备份文件')
          }
        } catch (writeError) {
          fs.rmSync(tempUploadPath, { force: true })
          if (writeError instanceof Error && writeError.message === 'Request body is too large') {
            return ctx.fail(413, '备份文件大小不能超过 100 MB')
          }
          throw writeError
        }
        source = { filePath: tempUploadPath }
      }

      try {
        if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
        await restoreLocalBackup(source, {
          beforeRestore: () => {
            previousConfig = { ...global.lx.config }
          },
          onRestored,
          afterRollback: async () => {
            resetUserSpaces()
            await initUserApis()
          },
        })
      } finally {
        if (tempUploadPath) fs.rmSync(tempUploadPath, { force: true })
        if (tempMultipartPath) fs.rmSync(tempMultipartPath, { force: true })
      }

      // 缓存媒体不在备份内，重新扫描宿主机现有目录，避免恢复后索引长期为空。
      void fileCache.syncCacheIndex('_open')
      for (const user of global.lx.config.users) void fileCache.syncCacheIndex(user.name)
      return ctx.json({ success: true, message: '备份还原成功，会话已重置', users: global.lx.config.users.length })
    } catch (err) {
      if (tempUploadPath) fs.rmSync(tempUploadPath, { force: true })
      if (tempMultipartPath) fs.rmSync(tempMultipartPath, { force: true })
      if (err instanceof MultipartUploadTooLargeError) return ctx.fail(413, err.message)
      if (err instanceof LocalBackupTooLargeError) return ctx.fail(413, err.message)
      return ctx.fail(400, toUserMessage(err, '备份文件无效或无法还原'))
    }
  })

  return router
}
