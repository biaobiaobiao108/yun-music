import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Router, type HttpContext } from '../core'
import { toUserMessage } from '../core/context'
import { verifyAdminAuth } from '../auth'
import { serverStatus } from '../state'
import { startupLog } from '@/utils/log4js'
import { resolveInside } from '@/utils/pathSecurity'
import { createLocalBackup } from '../localBackupService'

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true' || value === '1' || value === 'on') return true
    if (value.toLowerCase() === 'false' || value === '0' || value === 'off') return false
  }
  return fallback
}

const parseBoundedInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback
}

const normalizeConfiguredPath = (value: unknown, fallback: string, allowEmpty = false): string => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed && allowEmpty) return ''
  if (!trimmed.startsWith('/') || /[\u0000-\u001f\\]/.test(trimmed)) throw new Error('路径格式无效')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) throw new Error('路径不能包含 . 或 ..')
  const normalized = `/${parts.join('/')}`
  if (normalized === '/api' || normalized.startsWith('/api/')) throw new Error('路径不能以 /api 开头')
  return normalized === '/' && allowEmpty ? '' : normalized
}

const redactUrlCredentials = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value.trim())
    url.username = ''
    url.password = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return '[configured]'
  }
}

/** 重新加载服务器运行时数据 */
export const reloadServerData = async (): Promise<void> => {
  startupLog.info('Hot-reloading server data (users and config)...')
  const configPath = process.env.CONFIG_PATH || path.join(global.lx.dataPath, 'config.js')
  if (fs.existsSync(configPath)) {
    try {
      delete require.cache[require.resolve(configPath)]
      const rootConfig = require(configPath)
      for (const key of Object.keys(rootConfig)) {
        if (key !== 'users') {
          ;(global.lx.config as any)[key] = rootConfig[key]
        }
      }
      startupLog.info('Config.js re-loaded and merged.')
    } catch (err: any) {
      startupLog.error('Failed to reload config.js:', err.message)
    }
  }

}

/** 注册系统运维与管理相关路由 */
export const createSystemRouter = (): Router => {
  const router = new Router()

  // 1. 服务运行统计 (CPU/内存/状态)
  router.get('/api/stats', (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    const stats = {
      users: global.lx.config.users?.length ?? 0,
      publicAccess: global.lx.config['user.enablePublicNonAdminAccess'] === true,
      serverStatus: serverStatus.status,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    }
    return ctx.json(stats)
  })

  // 1.1 详细系统状态 /api/status
  router.get('/api/status', (ctx) => {
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
        for (const type in cpu.times) { total += (cpu.times as any)[type] }
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
      return ((deltaUsage.user + deltaUsage.system) / deltaTime / os.cpus().length * 100).toFixed(2)
    }

    const status = {
      users: global.lx.config.users.length,
      publicAccess: global.lx.config['user.enablePublicNonAdminAccess'] === true,
      uptime: process.uptime(),
      memory: process.memoryUsage().rss,
      totalMemory: totalMem,
      freeMemory: freeMem,
      systemMemoryUsage: ((totalMem - freeMem) / totalMem * 100).toFixed(2),
      processMemoryUsage: (process.memoryUsage().rss / totalMem * 100).toFixed(2),
      cpuUsage: getSystemCpuUsage(),
      processCpuUsage: getProcessCpuUsage(),
      osUptime: os.uptime(),
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || 'Unknown',
      cpuSpeed: os.cpus()[0]?.speed || 0,
    }

    return ctx.json(status)
  })

  // 2. 日志读取
  router.get('/api/logs', (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    const logType = ctx.query.get('type') || 'access'
    const fileName = logType === 'error' ? 'error.log' : 'access.log'
    const logFilePath = path.join(global.lx.logPath || path.join(process.cwd(), 'logs'), fileName)

    if (!fs.existsSync(logFilePath)) {
      return ctx.json({ lines: [] })
    }
    try {
      const content = fs.readFileSync(logFilePath, 'utf8')
      const lines = content.split('\n').filter(Boolean)
      const last100 = lines.slice(-100)
      return ctx.json({ lines: last100 })
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '服务器内部错误，请稍后重试'))
    }
  })

  // 3. 配置读取与更新 (GET & POST)
  router.get('/api/config', (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    const c = global.lx.config
    const config = {
      serverName: c.serverName,
      maxSnapshotNum: c.maxSnapshotNum,
      'list.addMusicLocationType': c['list.addMusicLocationType'],
      'proxy.enabled': c['proxy.enabled'],
      'proxy.header': c['proxy.header'],
      'user.enablePath': c['user.enablePath'],
      'user.enableRoot': c['user.enableRoot'],
      'user.enablePublicRestriction': c['user.enablePublicRestriction'],
      'user.enablePublicNonAdminLocalMusic': c['user.enablePublicNonAdminLocalMusic'],
      'user.enablePublicFavorites': c['user.enablePublicFavorites'],
      'user.enablePublicNonAdminAccess': c['user.enablePublicNonAdminAccess'],
      'user.enableLoginCacheRestriction': c['user.enableLoginCacheRestriction'],
      'user.enableCacheSizeLimit': c['user.enableCacheSizeLimit'],
      'user.cacheSizeLimit': c['user.cacheSizeLimit'],
      'frontend.passwordConfigured': Boolean(c['frontend.password']),
      'player.enableAuth': c['player.enableAuth'] || false,
      'player.passwordConfigured': Boolean(c['player.password']),
      'proxy.all.enabled': c['proxy.all.enabled'] || false,
      'proxy.all.address': redactUrlCredentials(c['proxy.all.address']),
      'admin.path': c['admin.path'] ?? '',
      'player.path': c['player.path'] ?? '/music',
      'singer.sourcePriority': (c['singer.sourcePriority'] || ['tx', 'wy']).join(','),
      'artist.maxFetchPages': c['artist.maxFetchPages'] ?? 20,
      'system.allowUnsafeVM': c['system.allowUnsafeVM'] || false,
    }
    return ctx.json(config)
  })

  router.post('/api/config', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    try {
      const newConfig = await ctx.bodyJson<Record<string, any>>()
      const c = global.lx.config
      if (newConfig.serverName !== undefined) c.serverName = newConfig.serverName
      if (newConfig.maxSnapshotNum !== undefined) c.maxSnapshotNum = parseBoundedInteger(newConfig.maxSnapshotNum, 1, 10000, c.maxSnapshotNum)
      if (newConfig['list.addMusicLocationType'] !== undefined) c['list.addMusicLocationType'] = newConfig['list.addMusicLocationType']
      if (newConfig['proxy.enabled'] !== undefined) c['proxy.enabled'] = parseBoolean(newConfig['proxy.enabled'], c['proxy.enabled'])
      if (newConfig['proxy.header'] !== undefined) c['proxy.header'] = typeof newConfig['proxy.header'] === 'string' ? newConfig['proxy.header'].slice(0, 256) : c['proxy.header']
      if (newConfig['user.enablePath'] !== undefined) c['user.enablePath'] = parseBoolean(newConfig['user.enablePath'], c['user.enablePath'] ?? false)
      if (newConfig['user.enableRoot'] !== undefined) c['user.enableRoot'] = parseBoolean(newConfig['user.enableRoot'], c['user.enableRoot'] ?? false)
      if (newConfig['user.enablePublicRestriction'] !== undefined) c['user.enablePublicRestriction'] = parseBoolean(newConfig['user.enablePublicRestriction'], c['user.enablePublicRestriction'] ?? false)
      if (newConfig['user.enablePublicNonAdminLocalMusic'] !== undefined) c['user.enablePublicNonAdminLocalMusic'] = parseBoolean(newConfig['user.enablePublicNonAdminLocalMusic'], c['user.enablePublicNonAdminLocalMusic'] ?? false)
      if (newConfig['user.enablePublicFavorites'] !== undefined) c['user.enablePublicFavorites'] = parseBoolean(newConfig['user.enablePublicFavorites'], c['user.enablePublicFavorites'] ?? false)
      if (newConfig['user.enablePublicNonAdminAccess'] !== undefined) c['user.enablePublicNonAdminAccess'] = parseBoolean(newConfig['user.enablePublicNonAdminAccess'], c['user.enablePublicNonAdminAccess'] ?? false)
      if (newConfig['user.enableLoginCacheRestriction'] !== undefined) c['user.enableLoginCacheRestriction'] = parseBoolean(newConfig['user.enableLoginCacheRestriction'], c['user.enableLoginCacheRestriction'] ?? false)
      if (newConfig['user.enableCacheSizeLimit'] !== undefined) c['user.enableCacheSizeLimit'] = parseBoolean(newConfig['user.enableCacheSizeLimit'], c['user.enableCacheSizeLimit'] ?? false)
      if (newConfig['user.cacheSizeLimit'] !== undefined) c['user.cacheSizeLimit'] = parseBoundedInteger(newConfig['user.cacheSizeLimit'], 1, 1024 * 1024, 2000)
      if (newConfig['system.allowUnsafeVM'] !== undefined) c['system.allowUnsafeVM'] = parseBoolean(newConfig['system.allowUnsafeVM'], false)
      if (newConfig['frontend.password'] !== undefined) {
        if (typeof newConfig['frontend.password'] !== 'string') {
          return ctx.json({ success: false, error: '管理员密码格式无效' }, 422)
        }
        if (newConfig['frontend.password'].trim()) {
          if (newConfig['frontend.password'] === '123456') return ctx.json({ success: false, error: '管理员密码不能使用示例密码' }, 422)
          c['frontend.password'] = newConfig['frontend.password']
        }
      }
      const nextPlayerEnableAuth = newConfig['player.enableAuth'] !== undefined
        ? parseBoolean(newConfig['player.enableAuth'], false)
        : Boolean(c['player.enableAuth'])
      let nextPlayerPassword = c['player.password'] || ''
      if (newConfig['player.password'] !== undefined) {
        if (typeof newConfig['player.password'] !== 'string') {
          return ctx.json({ success: false, error: '播放器密码格式无效' }, 422)
        }
        if (newConfig['player.password'].trim()) {
          if (newConfig['player.password'] === '123456') return ctx.json({ success: false, error: '播放器密码不能使用示例密码' }, 422)
          nextPlayerPassword = newConfig['player.password']
        }
      }
      if (nextPlayerEnableAuth && !nextPlayerPassword.trim()) {
        return ctx.json({ success: false, error: '播放器启用认证时必须配置密码' }, 422)
      }
      c['player.enableAuth'] = nextPlayerEnableAuth
      c['player.password'] = nextPlayerPassword

      if (newConfig['proxy.all.enabled'] !== undefined) c['proxy.all.enabled'] = parseBoolean(newConfig['proxy.all.enabled'], false)
      if (newConfig['proxy.all.address'] !== undefined && typeof newConfig['proxy.all.address'] === 'string') {
        const normalizedAddress = newConfig['proxy.all.address'].slice(0, 2048)
        const currentAddress = redactUrlCredentials(c['proxy.all.address'])
        c['proxy.all.address'] = normalizedAddress && normalizedAddress === currentAddress
          ? c['proxy.all.address']
          : normalizedAddress
      }

      if (newConfig['admin.path'] !== undefined || newConfig['player.path'] !== undefined) {
        const normalizedAdmin = normalizeConfiguredPath(newConfig['admin.path'] !== undefined ? newConfig['admin.path'] : (c['admin.path'] ?? ''), '', true)
        const normalizedPlayer = normalizeConfiguredPath(newConfig['player.path'] !== undefined ? newConfig['player.path'] : (c['player.path'] ?? '/music'), '/music')

        if ((normalizedAdmin || '/') === (normalizedPlayer || '/')) {
          return ctx.json({ success: false, error: '后台管理路径与播放器路径不能相同' }, 422)
        }
        c['admin.path'] = normalizedAdmin
        c['player.path'] = normalizedPlayer
      }

      if (newConfig['singer.sourcePriority'] !== undefined) {
        const priority = String(newConfig['singer.sourcePriority']).split(',').filter(s => s === 'tx' || s === 'wy') as Array<'tx' | 'wy'>
        if (priority.length > 0) c['singer.sourcePriority'] = priority
      }
      if (newConfig['artist.maxFetchPages'] !== undefined) {
        const maxPages = Number(newConfig['artist.maxFetchPages'])
        c['artist.maxFetchPages'] = Number.isFinite(maxPages) && maxPages > 0 ? Math.min(Math.floor(maxPages), 100) : 20
      }


      let warning = ''
      if (!c['user.enablePath'] && !c['user.enableRoot']) {
        c['user.enableRoot'] = true
        warning = '必须至少开启一种连接方式，已自动开启“根路径”模式。'
      }

      if (global.lx.saveConfig) await global.lx.saveConfig()

      return ctx.json({ success: true, warning })
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '操作失败，请稍后重试'))
    }
  })

  // 3.1 测试代理
  router.post('/api/config/test-proxy', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const { address } = await ctx.bodyJson<{ address?: string }>()
      if (!address) throw new Error('Missing address')
      const url = new URL(address)
      if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(url.protocol)) {
        throw new Error('Unsupported protocol: ' + url.protocol)
      }

      const startTime = Date.now()
      const resp = await fetch('https://www.baidu.com', {
        proxy: address,
        signal: AbortSignal.timeout(10000),
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
        },
      })
      const duration = Date.now() - startTime
      return ctx.json({ success: true, message: `连接成功 (状态码: ${resp.status}, 耗时: ${duration}ms)` })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '操作失败，请稍后重试'))
    }
  })

  // 4. 重启与热重载
  router.post('/api/admin/reload', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    await reloadServerData()
    return ctx.json({ success: true, message: '服务器数据已重新加载' })
  })

  router.post('/api/restart', (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    setTimeout(() => {
      process.exit(0)
    }, 500)
    return ctx.json({ success: true, message: '服务器正在重启，请稍后刷新页面' })
  })

  // 5. 本地备份下载
  router.get('/api/backup/download', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    try {
      const zipName = await createLocalBackup()
      if (!zipName) throw new Error('Backup creation failed')
      const zipPath = resolveInside(global.lx.dataPath, zipName)
      if (!fs.existsSync(zipPath)) throw new Error('ZIP file not found')
      const bunFile = Bun.file(zipPath)
      const source = bunFile.stream()
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        try { fs.unlinkSync(zipPath) } catch { }
      }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = source.getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              controller.enqueue(value)
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          } finally {
            reader.releaseLock()
            cleanup()
          }
        },
        cancel() {
          cleanup()
        },
      })
      return new Response(body, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${zipName}"`,
        },
      })
    } catch (err: any) {
      return ctx.fail(500, toUserMessage(err, '服务器内部错误，请稍后重试'))
    }
  })

  return router
}
