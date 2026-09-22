import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Router, type HttpContext } from '../core'
import { isValidHttpHeaderName, normalizeTrustedProxyAddresses, toUserMessage } from '../core/context'
import { clearPlayerSessionCache, verifyAdminAuth } from '../auth'
import { clearUserSessionCache } from './auth'
import { serverStatus } from '../state'
import { startupLog } from '@/utils/log4js'
import { resolveInside } from '@/utils/pathSecurity'
import { createLocalBackup, MAX_LOCAL_BACKUP_BYTES, restoreLocalBackup } from '../localBackupService'
import { refreshUsersFromDatabase } from '@/user/data'
import { resetUserSpaces } from '@/user'
import * as fileCache from '../fileCache'
import { getDatabaseStorageStats, vacuumDatabase } from '@/database'
import { hashPassword, isPasswordHash } from '@/utils/passwordHash'

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

const MAX_LOG_TAIL_BYTES = 4 * 1024 * 1024

const readLogTail = async (filePath: string, lineLimit: number): Promise<string[]> => {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    let offset = stats.size
    let bytesReadTotal = 0
    let newlineCount = 0
    const chunks: Buffer[] = []

    while (offset > 0 && bytesReadTotal < MAX_LOG_TAIL_BYTES) {
      const chunkSize = Math.min(64 * 1024, offset, MAX_LOG_TAIL_BYTES - bytesReadTotal)
      offset -= chunkSize
      const chunk = Buffer.allocUnsafe(chunkSize)
      const result = await handle.read(chunk, 0, chunkSize, offset)
      const actualChunk = chunk.subarray(0, result.bytesRead)
      chunks.unshift(actualChunk)
      bytesReadTotal += result.bytesRead
      for (const byte of actualChunk) if (byte === 10) newlineCount += 1
      if (newlineCount >= lineLimit) break
    }

    const content = Buffer.concat(chunks).toString('utf8')
    return content.split('\n').filter(Boolean).slice(-lineLimit)
  } finally {
    await handle.close()
  }
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
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return '[configured]'
  }
}

const pathsOverlap = (left: string, right: string): boolean => {
  const normalizedLeft = left || '/'
  const normalizedRight = right || '/'
  // Root is intentionally a catch-all fallback path in this application;
  // only two concrete prefixes can shadow each other.
  if (normalizedLeft === '/' || normalizedRight === '/') return normalizedLeft === normalizedRight
  return normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
}

const applyConfiguredPassword = (
  config: Record<string, any>,
  restored: Record<string, unknown>,
  plainKey: 'frontend.password' | 'player.password',
  hashKey: 'frontend.passwordHash' | 'player.passwordHash',
  label: string,
  required: boolean,
): void => {
  if (restored[hashKey] !== undefined) {
    if (!isPasswordHash(restored[hashKey])) throw new Error(`${hashKey} 格式无效`)
    config[hashKey] = restored[hashKey]
    delete config[plainKey]
    return
  }
  if (restored[plainKey] === undefined) return
  const password = restored[plainKey]
  if (typeof password !== 'string' || password.length > 1024 || (required && !password.trim()) || password === '123456') {
    throw new Error(`${label}配置无效`)
  }
  if (password.trim()) config[hashKey] = hashPassword(password)
  else delete config[hashKey]
  delete config[plainKey]
}

const getConfiguredPasswordHash = (
  config: Record<string, any>,
  plainKey: 'frontend.password' | 'player.password',
  hashKey: 'frontend.passwordHash' | 'player.passwordHash',
): string => {
  if (isPasswordHash(config[hashKey])) return config[hashKey]
  if (typeof config[plainKey] === 'string' && config[plainKey].trim()) return hashPassword(config[plainKey])
  return ''
}

const normalizeProxyAddress = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('代理地址格式无效')
  const address = value.trim()
  if (!address) return ''
  if (address.length > 2048 || /[\u0000-\u001f\u007f]/.test(address)) {
    throw new Error('代理地址格式无效')
  }
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new Error('代理地址格式无效')
  }
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(url.protocol)) {
    throw new Error('代理地址协议不受支持')
  }
  if (!url.hostname || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('代理地址格式无效')
  }
  return address
}

/** 只应用当前版本已知且经过基本校验的运行时配置。 */
const applyValidatedConfig = (restored: Record<string, unknown>, options: { includeSecrets?: boolean } = {}): void => {
  const config = global.lx.config as Record<string, any>
  const scalarKeys = [
    'proxy.enabled',
    'user.enablePath',
    'user.enableRoot',
    'user.enablePublicRestriction',
    'user.enablePublicNonAdminLocalMusic',
    'user.enablePublicFavorites',
    'user.enablePublicNonAdminAccess',
    'user.enableLoginCacheRestriction',
    'user.enableCacheSizeLimit',
    'disableTelemetry',
    'proxy.all.enabled',
    'player.enableAuth',
  ]
  for (const key of scalarKeys) {
    if (typeof restored[key] === 'boolean') config[key] = restored[key]
  }

  if (typeof restored.serverName === 'string' && restored.serverName.trim() && restored.serverName.length <= 256) {
    config.serverName = restored.serverName
  }
  if (typeof restored.bindIP === 'string' && restored.bindIP.length <= 256 && !/[\u0000-\u001f\u007f]/.test(restored.bindIP)) {
    config.bindIP = restored.bindIP
  }
  if (Number.isInteger(restored.port) && Number(restored.port) >= 1 && Number(restored.port) <= 65535) {
    config.port = Number(restored.port)
  }
  if (Number.isInteger(restored.maxSnapshotNum) && Number(restored.maxSnapshotNum) >= 1) {
    config.maxSnapshotNum = Math.min(Number(restored.maxSnapshotNum), 10000)
  }
  if (Number.isInteger(restored['user.cacheSizeLimit']) && Number(restored['user.cacheSizeLimit']) >= 1) {
    config['user.cacheSizeLimit'] = Math.min(Number(restored['user.cacheSizeLimit']), 1024 * 1024)
  }
  if (Number.isInteger(restored['artist.maxFetchPages']) && Number(restored['artist.maxFetchPages']) >= 1) {
    config['artist.maxFetchPages'] = Math.min(Number(restored['artist.maxFetchPages']), 100)
  }
  if (restored['list.addMusicLocationType'] === 'top' || restored['list.addMusicLocationType'] === 'bottom') {
    config['list.addMusicLocationType'] = restored['list.addMusicLocationType']
  }
  if (restored['cache.namingPattern'] === 'simple' || restored['cache.namingPattern'] === 'standard') {
    config['cache.namingPattern'] = restored['cache.namingPattern']
  }
  if (restored.serverCacheLocation === 'data' || restored.serverCacheLocation === 'root') {
    config.serverCacheLocation = restored.serverCacheLocation
  }
  if (isValidHttpHeaderName(restored['proxy.header'])) config['proxy.header'] = restored['proxy.header']
  try {
    if (restored['proxy.trustedAddresses'] !== undefined) {
      config['proxy.trustedAddresses'] = normalizeTrustedProxyAddresses(restored['proxy.trustedAddresses'])
    }
  } catch { }
  try {
    if (restored['proxy.all.address'] !== undefined && !process.env.PROXY_ALL_ADDRESS) {
      config['proxy.all.address'] = normalizeProxyAddress(restored['proxy.all.address'])
    }
  } catch { }
  if (typeof restored['admin.path'] === 'string' || typeof restored['player.path'] === 'string') {
    const normalizedAdmin = typeof restored['admin.path'] === 'string'
      ? normalizeConfiguredPath(restored['admin.path'], '', true)
      : (config['admin.path'] ?? '')
    const normalizedPlayer = typeof restored['player.path'] === 'string'
      ? normalizeConfiguredPath(restored['player.path'], '/music')
      : (config['player.path'] ?? '/music')
    if (pathsOverlap(normalizedAdmin, normalizedPlayer)) {
      throw new Error('后台管理路径与播放器路径不能相同或互相包含')
    }
    config['admin.path'] = normalizedAdmin
    config['player.path'] = normalizedPlayer
  }
  if (Array.isArray(restored['singer.sourcePriority'])) {
    const priority = restored['singer.sourcePriority'].filter(value => value === 'tx' || value === 'wy')
    if (priority.length > 0) config['singer.sourcePriority'] = priority
  }

  if (options.includeSecrets) {
    if ((restored['frontend.password'] !== undefined || restored['frontend.passwordHash'] !== undefined) && !process.env.FRONTEND_PASSWORD) {
      applyConfiguredPassword(config, restored, 'frontend.password', 'frontend.passwordHash', '管理员密码', true)
    }
    if ((restored['player.password'] !== undefined || restored['player.passwordHash'] !== undefined) && !process.env.WEBPLAYER_PASSWORD) {
      applyConfiguredPassword(config, restored, 'player.password', 'player.passwordHash', '播放器密码', Boolean(config['player.enableAuth']))
    }
  }

  if (config['proxy.all.enabled'] && !String(config['proxy.all.address'] || '').trim()) {
    throw new Error('启用全局代理时必须配置代理地址')
  }
  if (config['player.enableAuth'] && !isPasswordHash(config['player.passwordHash']) && !String(config['player.password'] || '').trim()) {
    throw new Error('播放器启用认证时必须配置密码')
  }
}

/** 重新加载服务器运行时数据 */
export const reloadServerData = async (): Promise<void> => {
  startupLog.info('Hot-reloading server data (users and config)...')
  const configPath = process.env.CONFIG_PATH || path.join(global.lx.dataPath, 'config.js')
  if (fs.existsSync(configPath)) {
    const previousConfig = { ...global.lx.config }
    try {
      delete require.cache[require.resolve(configPath)]
      const rootConfig = require(configPath)
      if (!rootConfig || typeof rootConfig !== 'object' || Array.isArray(rootConfig)) throw new Error('配置文件格式无效')
      applyValidatedConfig(rootConfig, { includeSecrets: true })
      startupLog.info('Config.js re-loaded and merged.')
    } catch (err: any) {
      for (const key of Object.keys(global.lx.config)) {
        if (!(key in previousConfig)) delete (global.lx.config as any)[key]
      }
      Object.assign(global.lx.config, previousConfig)
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
      cacheStats: fileCache.getGlobalCacheStats(),
      cacheLimit: global.lx.config['user.cacheSizeLimit'] || 2000,
    }
    return ctx.json(stats)
  })

  // 1.1 SQLite 存储状态与显式压缩。VACUUM 可能短暂占用额外磁盘空间，
  // 因此只允许管理员按需执行，不在普通请求或启动时自动触发。
  router.get('/api/admin/database/stats', (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    return ctx.json({ success: true, data: getDatabaseStorageStats() })
  })

  router.post('/api/admin/database/vacuum', (ctx) => {
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
      cacheStats: fileCache.getGlobalCacheStats(),
      cacheLimit: global.lx.config['user.cacheSizeLimit'] || 2000,
    }

    return ctx.json(status)
  })

  // 2. 日志读取
  router.get('/api/logs', async (ctx) => {
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
      'player.enableAuth': c['player.enableAuth'] || false,
      'player.passwordConfigured': Boolean(c['player.passwordHash'] || c['player.password']),
      'proxy.all.enabled': c['proxy.all.enabled'] || false,
      'proxy.all.address': redactUrlCredentials(c['proxy.all.address']),
      'admin.path': c['admin.path'] ?? '',
      'player.path': c['player.path'] ?? '/music',
      'singer.sourcePriority': (c['singer.sourcePriority'] || ['tx', 'wy']).join(','),
      'artist.maxFetchPages': c['artist.maxFetchPages'] ?? 20,
    }
    return ctx.json(config)
  })

  router.post('/api/config', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }
    const c = global.lx.config
    const originalConfig = { ...c }
    const rollbackConfig = () => {
      for (const key of Object.keys(c)) {
        if (!(key in originalConfig)) delete (c as any)[key]
      }
      Object.assign(c, originalConfig)
    }
    try {
      const newConfig = await ctx.bodyJson<Record<string, any>>()
      if (newConfig.serverName !== undefined) {
        if (typeof newConfig.serverName !== 'string' || newConfig.serverName.length > 256 || /[\u0000-\u001f\u007f]/.test(newConfig.serverName)) {
          rollbackConfig()
          return ctx.json({ success: false, error: '服务名称格式无效' }, 422)
        }
        c.serverName = newConfig.serverName
      }
      if (newConfig.maxSnapshotNum !== undefined) c.maxSnapshotNum = parseBoundedInteger(newConfig.maxSnapshotNum, 1, 10000, c.maxSnapshotNum)
      if (newConfig['list.addMusicLocationType'] !== undefined) {
        if (newConfig['list.addMusicLocationType'] !== 'top' && newConfig['list.addMusicLocationType'] !== 'bottom') {
          rollbackConfig()
          return ctx.json({ success: false, error: '歌单添加位置格式无效' }, 422)
        }
        c['list.addMusicLocationType'] = newConfig['list.addMusicLocationType']
      }
      if (newConfig['proxy.enabled'] !== undefined) c['proxy.enabled'] = parseBoolean(newConfig['proxy.enabled'], c['proxy.enabled'])
      if (newConfig['proxy.header'] !== undefined) {
        if (!isValidHttpHeaderName(newConfig['proxy.header'])) {
          rollbackConfig()
          return ctx.json({ success: false, error: '代理转发头名称格式无效' }, 422)
        }
        c['proxy.header'] = newConfig['proxy.header']
      }
      if (newConfig['proxy.trustedAddresses'] !== undefined) {
        try {
          c['proxy.trustedAddresses'] = normalizeTrustedProxyAddresses(newConfig['proxy.trustedAddresses'])
        } catch (error) {
          rollbackConfig()
          return ctx.json({ success: false, error: toUserMessage(error, '可信代理地址格式无效') }, 422)
        }
      }
      if (newConfig['user.enablePath'] !== undefined) c['user.enablePath'] = parseBoolean(newConfig['user.enablePath'], c['user.enablePath'] ?? false)
      if (newConfig['user.enableRoot'] !== undefined) c['user.enableRoot'] = parseBoolean(newConfig['user.enableRoot'], c['user.enableRoot'] ?? false)
      if (newConfig['user.enablePublicRestriction'] !== undefined) c['user.enablePublicRestriction'] = parseBoolean(newConfig['user.enablePublicRestriction'], c['user.enablePublicRestriction'] ?? false)
      if (newConfig['user.enablePublicNonAdminLocalMusic'] !== undefined) c['user.enablePublicNonAdminLocalMusic'] = parseBoolean(newConfig['user.enablePublicNonAdminLocalMusic'], c['user.enablePublicNonAdminLocalMusic'] ?? false)
      if (newConfig['user.enablePublicFavorites'] !== undefined) c['user.enablePublicFavorites'] = parseBoolean(newConfig['user.enablePublicFavorites'], c['user.enablePublicFavorites'] ?? false)
      if (newConfig['user.enablePublicNonAdminAccess'] !== undefined) c['user.enablePublicNonAdminAccess'] = parseBoolean(newConfig['user.enablePublicNonAdminAccess'], c['user.enablePublicNonAdminAccess'] ?? false)
      if (newConfig['user.enableLoginCacheRestriction'] !== undefined) c['user.enableLoginCacheRestriction'] = parseBoolean(newConfig['user.enableLoginCacheRestriction'], c['user.enableLoginCacheRestriction'] ?? false)
      if (newConfig['user.enableCacheSizeLimit'] !== undefined) c['user.enableCacheSizeLimit'] = parseBoolean(newConfig['user.enableCacheSizeLimit'], c['user.enableCacheSizeLimit'] ?? false)
      if (newConfig['user.cacheSizeLimit'] !== undefined) c['user.cacheSizeLimit'] = parseBoundedInteger(newConfig['user.cacheSizeLimit'], 1, 1024 * 1024, 2000)
      if (newConfig['frontend.password'] !== undefined) {
        if (typeof newConfig['frontend.password'] !== 'string') {
          rollbackConfig()
          return ctx.json({ success: false, error: '管理员密码格式无效' }, 422)
        }
        if (newConfig['frontend.password'].length > 1024) {
          rollbackConfig()
          return ctx.json({ success: false, error: '管理员密码长度不能超过 1024 个字符' }, 422)
        }
        if (newConfig['frontend.password'].trim()) {
          if (newConfig['frontend.password'] === '123456') {
            rollbackConfig()
            return ctx.json({ success: false, error: '管理员密码不能使用示例密码' }, 422)
          }
          c['frontend.passwordHash'] = hashPassword(newConfig['frontend.password'])
          delete c['frontend.password']
        }
      }
      const nextPlayerEnableAuth = newConfig['player.enableAuth'] !== undefined
        ? parseBoolean(newConfig['player.enableAuth'], false)
        : Boolean(c['player.enableAuth'])
      let nextPlayerPasswordHash = getConfiguredPasswordHash(c, 'player.password', 'player.passwordHash')
      if (newConfig['player.password'] !== undefined) {
        if (typeof newConfig['player.password'] !== 'string') {
          rollbackConfig()
          return ctx.json({ success: false, error: '播放器密码格式无效' }, 422)
        }
        if (newConfig['player.password'].length > 1024) {
          rollbackConfig()
          return ctx.json({ success: false, error: '播放器密码长度不能超过 1024 个字符' }, 422)
        }
        if (newConfig['player.password'].trim()) {
          if (newConfig['player.password'] === '123456') {
            rollbackConfig()
            return ctx.json({ success: false, error: '播放器密码不能使用示例密码' }, 422)
          }
          nextPlayerPasswordHash = hashPassword(newConfig['player.password'])
        }
      }
      if (nextPlayerEnableAuth && !nextPlayerPasswordHash) {
        rollbackConfig()
        return ctx.json({ success: false, error: '播放器启用认证时必须配置密码' }, 422)
      }
      c['player.enableAuth'] = nextPlayerEnableAuth
      if (nextPlayerPasswordHash) c['player.passwordHash'] = nextPlayerPasswordHash
      else delete c['player.passwordHash']
      delete c['player.password']

      if (newConfig['proxy.all.enabled'] !== undefined) c['proxy.all.enabled'] = parseBoolean(newConfig['proxy.all.enabled'], false)
      if (newConfig['proxy.all.address'] !== undefined) {
        const normalizedAddress = normalizeProxyAddress(newConfig['proxy.all.address'])
        const currentAddress = redactUrlCredentials(c['proxy.all.address'])
        c['proxy.all.address'] = normalizedAddress && normalizedAddress === currentAddress
          ? c['proxy.all.address']
          : normalizedAddress
      }
      if (c['proxy.all.enabled'] && !String(c['proxy.all.address'] || '').trim()) {
        rollbackConfig()
        return ctx.json({ success: false, error: '启用全局代理时必须配置代理地址' }, 422)
      }

      if (newConfig['admin.path'] !== undefined || newConfig['player.path'] !== undefined) {
        const normalizedAdmin = normalizeConfiguredPath(newConfig['admin.path'] !== undefined ? newConfig['admin.path'] : (c['admin.path'] ?? ''), '', true)
        const normalizedPlayer = normalizeConfiguredPath(newConfig['player.path'] !== undefined ? newConfig['player.path'] : (c['player.path'] ?? '/music'), '/music')

        if (pathsOverlap(normalizedAdmin, normalizedPlayer)) {
          rollbackConfig()
          return ctx.json({ success: false, error: '后台管理路径与播放器路径不能相同或互相包含' }, 422)
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
      // 配置更新是一个整体操作；任何校验、序列化或写盘失败都不能留下半套内存配置。
      rollbackConfig()
      return ctx.fail(500, toUserMessage(e, '操作失败，请稍后重试'))
    }
  })

  // 3.1 测试代理
  router.post('/api/config/test-proxy', async (ctx) => {
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
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
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
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        try { fs.unlinkSync(zipPath) } catch { }
      }
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const activeReader = source.getReader()
          reader = activeReader
          try {
            while (true) {
              const { done, value } = await activeReader.read()
              if (done) break
              controller.enqueue(value)
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          } finally {
            activeReader.releaseLock()
            if (reader === activeReader) reader = null
            cleanup()
          }
        },
        async cancel(reason) {
          const activeReader = reader
          reader = null
          try { await activeReader?.cancel(reason) } catch { }
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

  // 6. 本地备份还原。上传内容只进入临时目录，完成路径/类型校验后才替换
  // 用户数据和 SQLite；管理员会话本身保留，但所有播放器/用户会话都会失效。
  router.post('/api/backup/upload', async (ctx) => {
    if (!verifyAdminAuth(ctx.request)) return ctx.fail(401, '登录状态已失效，请重新登录')
    const declaredLength = Number(ctx.headers.get('content-length') || 0)
    const maxMultipartBytes = MAX_LOCAL_BACKUP_BYTES + 1024 * 1024
    if (Number.isFinite(declaredLength) && declaredLength > maxMultipartBytes) {
      return ctx.fail(413, '备份文件大小不能超过 100 MB')
    }

    try {
      // Include a small multipart envelope allowance while keeping chunked
      // uploads bounded before the platform parses FormData.
      const form = await ctx.formData(maxMultipartBytes)
      const upload = form.get('backup')
      if (!(upload instanceof Blob)) return ctx.fail(400, '请选择 ZIP 备份文件')
      if (upload.size <= 0 || upload.size > MAX_LOCAL_BACKUP_BYTES) {
        return ctx.fail(413, '备份文件大小不能超过 100 MB')
      }

      const previousConfig = { ...global.lx.config }
      await restoreLocalBackup(new Uint8Array(await upload.arrayBuffer()), { onRestored: async (restoredConfig) => {
        try {
          applyValidatedConfig(restoredConfig)
          resetUserSpaces()
          refreshUsersFromDatabase()
          clearUserSessionCache()
          clearPlayerSessionCache()
          if (global.lx.config.serverCacheLocation) {
            fileCache.setCacheLocation(global.lx.config.serverCacheLocation)
          }
          global.lx.config['cache.namingPattern'] = fileCache.setNamingPattern(global.lx.config['cache.namingPattern'])
          if (global.lx.saveConfig) await global.lx.saveConfig()
        } catch (error) {
          for (const key of Object.keys(global.lx.config)) {
            if (!(key in previousConfig)) delete (global.lx.config as any)[key]
          }
          Object.assign(global.lx.config, previousConfig)
          // If persistence failed after partially writing config.js, restore
          // the in-memory configuration there as well. The backup service
          // rolls the database and user directory back around this callback.
          if (global.lx.saveConfig) {
            try { await global.lx.saveConfig() } catch (rollbackError) {
              console.error('[Backup] 配置回滚写盘失败:', rollbackError)
            }
          }
          throw error
        }
      }})

      // 缓存媒体不在备份内，重新扫描宿主机现有目录，避免恢复后索引长期为空。
      void fileCache.syncCacheIndex('_open')
      for (const user of global.lx.config.users) void fileCache.syncCacheIndex(user.name)
      return ctx.json({ success: true, message: '备份还原成功，会话已重置', users: global.lx.config.users.length })
    } catch (err) {
      return ctx.fail(400, toUserMessage(err, '备份文件无效或无法还原'))
    }
  })

  return router
}
