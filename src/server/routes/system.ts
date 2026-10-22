import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Router, getCompressedCacheStats, type HttpContext } from '../core'
import { isValidHttpHeaderName, normalizeTrustedProxyAddresses, toUserMessage } from '../core/context'
import { revokeAllAdminSessions, revokeAllPlayerSessions, verifyAdminAuth } from '../auth'
import { revokeAllUserSessions } from './auth'
import { serverStatus } from '../state'
import { startupLog } from '@/utils/log4js'
import { resolveInside } from '@/utils/pathSecurity'
import { parseConfigFile } from '@/utils/configLoader'
import {
  createLocalBackup,
  LocalBackupTooLargeError,
  MAX_LOCAL_BACKUP_BYTES,
  restoreLocalBackup,
} from '../localBackupService'
import { refreshUsersFromDatabase } from '@/user/data'
import { resetUserSpaces } from '@/user'
import * as fileCache from '../fileCache'
import { getDatabaseStorageStats, vacuumDatabase } from '@/database'
import { hashPassword, isPasswordHash } from '@/utils/passwordHash'
import { temporaryFileStream } from '../temporaryFileStream'
import { getProcessMemorySnapshot } from '../memoryMaintenance'
import { isPrivateAddress } from '../networkSecurity'
import { getResourceBudgetStats } from '../resourceBudget'
import { getSourceMatchCacheStats } from '../services/musicResolver'
import { getSingerCacheStats } from '../utils/singer'
import { getGeneralCacheStats } from '@/utils/cache'

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

class MultipartUploadTooLargeError extends Error {}

const findBytes = (buffer: Uint8Array, pattern: Uint8Array): number => {
  if (!pattern.length || buffer.length < pattern.length) return -1
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).indexOf(Buffer.from(pattern))
}

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (!left.length) return right
  if (!right.length) return left
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

/** Extract the first `backup` file part without buffering the multipart body. */
const writeMultipartBackupToFile = async (
  stream: ReadableStream<Uint8Array>,
  boundary: string,
  destination: string,
  maxBytes: number,
): Promise<number> => {
  const marker = new TextEncoder().encode(`--${boundary}`)
  const separator = new TextEncoder().encode(`\r\n--${boundary}`)
  const headerTerminator = new Uint8Array([13, 10, 13, 10])
  const crlf = new Uint8Array([13, 10])
  const finalMarker = new Uint8Array([45, 45])
  const reader = stream.getReader()
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let state: 'start' | 'suffix' | 'headers' | 'body' | 'done' = 'start'
  let inBackupFile = false
  let backupFieldSeen = false
  let backupBytes = 0
  let fileHandle: fs.promises.FileHandle | undefined
  let failed = false

  const writePart = async (bytes: Uint8Array) => {
    if (!inBackupFile || !bytes.length) return
    backupBytes += bytes.length
    if (backupBytes > maxBytes) throw new MultipartUploadTooLargeError('备份文件大小不能超过 100 MB')
    if (!fileHandle) fileHandle = await fs.promises.open(destination, 'w')
    let offset = 0
    while (offset < bytes.length) {
      const result = await fileHandle.write(bytes, offset, bytes.length - offset)
      if (!result.bytesWritten) throw new Error('备份文件写入失败')
      offset += result.bytesWritten
    }
  }

  const processBuffer = async () => {
    let progressed = true
    while (progressed) {
      progressed = false
      if (state === 'start') {
        const index = findBytes(buffer, marker)
        if (index < 0) {
          if (buffer.length > marker.length - 1) buffer = buffer.slice(buffer.length - marker.length + 1)
          continue
        }
        buffer = buffer.slice(index + marker.length)
        state = 'suffix'
        progressed = true
      } else if (state === 'suffix') {
        if (buffer.length >= finalMarker.length && buffer[0] === 45 && buffer[1] === 45) {
          buffer = buffer.slice(2)
          state = 'done'
          progressed = true
        } else if (buffer.length >= crlf.length && buffer[0] === 13 && buffer[1] === 10) {
          buffer = buffer.slice(2)
          state = 'headers'
          progressed = true
        } else if (buffer.length >= 2) {
          throw new Error('multipart 备份格式无效')
        }
      } else if (state === 'headers') {
        const index = findBytes(buffer, headerTerminator)
        if (index < 0) {
          if (buffer.length > 16 * 1024) throw new Error('multipart 文件头过大')
          continue
        }
        const headers = new TextDecoder('latin1').decode(buffer.slice(0, index))
        buffer = buffer.slice(index + headerTerminator.length)
        const disposition = headers.split('\r\n').find(line => /^content-disposition\s*:/i.test(line)) || ''
        const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1]
        const hasFilename = /(?:^|;)\s*filename\s*=/i.test(disposition)
        inBackupFile = name === 'backup' && hasFilename && !backupFieldSeen
        if (name === 'backup') backupFieldSeen = true
        state = 'body'
        progressed = true
      } else if (state === 'body') {
        const index = findBytes(buffer, separator)
        if (index >= 0) {
          const suffixOffset = index + separator.length
          if (buffer.length < suffixOffset + 2) {
            await writePart(buffer.slice(0, index))
            buffer = buffer.slice(index)
          } else if (
            (buffer[suffixOffset] === 45 && buffer[suffixOffset + 1] === 45) ||
            (buffer[suffixOffset] === 13 && buffer[suffixOffset + 1] === 10)
          ) {
            await writePart(buffer.slice(0, index))
            buffer = buffer.slice(suffixOffset)
            inBackupFile = false
            state = 'suffix'
            progressed = true
          } else {
            // A zip may contain the boundary prefix as ordinary bytes. Only
            // treat it as framing when its required CRLF/closing suffix follows.
            await writePart(buffer.slice(0, index + 1))
            buffer = buffer.slice(index + 1)
            progressed = true
          }
        } else if (buffer.length >= separator.length) {
          const safeLength = buffer.length - separator.length + 1
          await writePart(buffer.slice(0, safeLength))
          buffer = buffer.slice(safeLength)
        }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = appendBytes(buffer, value)
      await processBuffer()
    }
    await processBuffer()
    if ((state as string) !== 'done') throw new Error('multipart 备份内容不完整')
    return backupBytes
  } catch (error) {
    failed = true
    try {
      await reader.cancel(error)
    } catch {}
    throw error
  } finally {
    reader.releaseLock()
    if (fileHandle) {
      await fileHandle.close()
      if (failed) await fs.promises.unlink(destination).catch(() => {})
    }
  }
}

const readMultipartBoundary = (contentType: string): string | null => {
  const value = contentType
    .match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i)
    ?.slice(1)
    .find(Boolean)
  if (!value || value.length > 200 || /[\r\n]/.test(value)) return null
  return value
}

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
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  )
}

const applyConfiguredPassword = async (
  config: Record<string, any>,
  restored: Record<string, unknown>,
  plainKey: 'frontend.password' | 'player.password',
  hashKey: 'frontend.passwordHash' | 'player.passwordHash',
  label: string,
  required: boolean,
): Promise<void> => {
  if (restored[hashKey] !== undefined) {
    if (!isPasswordHash(restored[hashKey])) throw new Error(`${hashKey} 格式无效`)
    config[hashKey] = restored[hashKey]
    delete config[plainKey]
    return
  }
  if (restored[plainKey] === undefined) return
  const password = restored[plainKey]
  if (
    typeof password !== 'string' ||
    password.length > 1024 ||
    (required && !password.trim()) ||
    password === '123456'
  ) {
    throw new Error(`${label}配置无效`)
  }
  if (password.trim()) config[hashKey] = await hashPassword(password)
  else delete config[hashKey]
  delete config[plainKey]
}

const getConfiguredPasswordHash = async (
  config: Record<string, any>,
  plainKey: 'frontend.password' | 'player.password',
  hashKey: 'frontend.passwordHash' | 'player.passwordHash',
): Promise<string> => {
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
  // A proxy address is an outbound connection target. Loopback/link-local
  // literals are how an admin session gets turned into an internal port scanner
  // (`test-proxy` reports the status code and latency back).
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isPrivateAddress(host) && process.env.ALLOW_PRIVATE_PROXY !== '1') {
    throw new Error('代理地址不能是内网或回环地址（如需内网代理请设置 ALLOW_PRIVATE_PROXY=1）')
  }
  return address
}

/** 只应用当前版本已知且经过基本校验的运行时配置。 */
const applyValidatedConfig = async (
  restored: Record<string, unknown>,
  options: { includeSecrets?: boolean } = {},
): Promise<void> => {
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
  if (
    typeof restored.bindIP === 'string' &&
    restored.bindIP.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(restored.bindIP)
  ) {
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
  } catch {}
  try {
    if (restored['proxy.all.address'] !== undefined && !process.env.PROXY_ALL_ADDRESS) {
      config['proxy.all.address'] = normalizeProxyAddress(restored['proxy.all.address'])
    }
  } catch {}
  if (typeof restored['admin.path'] === 'string' || typeof restored['player.path'] === 'string') {
    const normalizedAdmin =
      typeof restored['admin.path'] === 'string'
        ? normalizeConfiguredPath(restored['admin.path'], '', true)
        : (config['admin.path'] ?? '')
    const normalizedPlayer =
      typeof restored['player.path'] === 'string'
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
    if (
      (restored['frontend.password'] !== undefined || restored['frontend.passwordHash'] !== undefined) &&
      !process.env.FRONTEND_PASSWORD
    ) {
      await applyConfiguredPassword(config, restored, 'frontend.password', 'frontend.passwordHash', '管理员密码', true)
    }
    if (
      (restored['player.password'] !== undefined || restored['player.passwordHash'] !== undefined) &&
      !process.env.WEBPLAYER_PASSWORD
    ) {
      await applyConfiguredPassword(
        config,
        restored,
        'player.password',
        'player.passwordHash',
        '播放器密码',
        Boolean(config['player.enableAuth']),
      )
    }
  }

  if (config['proxy.all.enabled'] && !String(config['proxy.all.address'] || '').trim()) {
    throw new Error('启用全局代理时必须配置代理地址')
  }
  if (
    config['player.enableAuth'] &&
    !isPasswordHash(config['player.passwordHash']) &&
    !String(config['player.password'] || '').trim()
  ) {
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
      // Parse instead of require(): requiring executes whatever is in the data
      // directory as JS in this process, and it also registers the file with
      // bun --watch (a config save would restart the server mid-response).
      const rootConfig = parseConfigFile(configPath)
      if (!rootConfig || typeof rootConfig !== 'object' || Array.isArray(rootConfig))
        throw new Error('配置文件格式无效')
      await applyValidatedConfig(rootConfig, { includeSecrets: true })
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
      cacheStats: fileCache.getGlobalCacheStats(),
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
      cacheStats: fileCache.getGlobalCacheStats(),
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

  router.post('/api/config', async ctx => {
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
        if (
          typeof newConfig.serverName !== 'string' ||
          newConfig.serverName.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(newConfig.serverName)
        ) {
          rollbackConfig()
          return ctx.json({ success: false, error: '服务名称格式无效' }, 422)
        }
        c.serverName = newConfig.serverName
      }
      if (newConfig.maxSnapshotNum !== undefined)
        c.maxSnapshotNum = parseBoundedInteger(newConfig.maxSnapshotNum, 1, 10000, c.maxSnapshotNum)
      if (newConfig['list.addMusicLocationType'] !== undefined) {
        if (newConfig['list.addMusicLocationType'] !== 'top' && newConfig['list.addMusicLocationType'] !== 'bottom') {
          rollbackConfig()
          return ctx.json({ success: false, error: '歌单添加位置格式无效' }, 422)
        }
        c['list.addMusicLocationType'] = newConfig['list.addMusicLocationType']
      }
      if (newConfig['proxy.enabled'] !== undefined)
        c['proxy.enabled'] = parseBoolean(newConfig['proxy.enabled'], c['proxy.enabled'])
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
      if (newConfig['user.enablePath'] !== undefined)
        c['user.enablePath'] = parseBoolean(newConfig['user.enablePath'], c['user.enablePath'] ?? false)
      if (newConfig['user.enableRoot'] !== undefined)
        c['user.enableRoot'] = parseBoolean(newConfig['user.enableRoot'], c['user.enableRoot'] ?? false)
      if (newConfig['user.enablePublicRestriction'] !== undefined)
        c['user.enablePublicRestriction'] = parseBoolean(
          newConfig['user.enablePublicRestriction'],
          c['user.enablePublicRestriction'] ?? false,
        )
      if (newConfig['user.enablePublicNonAdminLocalMusic'] !== undefined)
        c['user.enablePublicNonAdminLocalMusic'] = parseBoolean(
          newConfig['user.enablePublicNonAdminLocalMusic'],
          c['user.enablePublicNonAdminLocalMusic'] ?? false,
        )
      if (newConfig['user.enablePublicFavorites'] !== undefined)
        c['user.enablePublicFavorites'] = parseBoolean(
          newConfig['user.enablePublicFavorites'],
          c['user.enablePublicFavorites'] ?? false,
        )
      if (newConfig['user.enablePublicNonAdminAccess'] !== undefined)
        c['user.enablePublicNonAdminAccess'] = parseBoolean(
          newConfig['user.enablePublicNonAdminAccess'],
          c['user.enablePublicNonAdminAccess'] ?? false,
        )
      if (newConfig['user.enableLoginCacheRestriction'] !== undefined)
        c['user.enableLoginCacheRestriction'] = parseBoolean(
          newConfig['user.enableLoginCacheRestriction'],
          c['user.enableLoginCacheRestriction'] ?? false,
        )
      if (newConfig['user.enableCacheSizeLimit'] !== undefined)
        c['user.enableCacheSizeLimit'] = parseBoolean(
          newConfig['user.enableCacheSizeLimit'],
          c['user.enableCacheSizeLimit'] ?? false,
        )
      if (newConfig['user.cacheSizeLimit'] !== undefined)
        c['user.cacheSizeLimit'] = parseBoundedInteger(newConfig['user.cacheSizeLimit'], 1, 1024 * 1024, 2000)
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
          c['frontend.passwordHash'] = await hashPassword(newConfig['frontend.password'])
          delete c['frontend.password']
        }
      }
      const nextPlayerEnableAuth =
        newConfig['player.enableAuth'] !== undefined
          ? parseBoolean(newConfig['player.enableAuth'], false)
          : Boolean(c['player.enableAuth'])
      let nextPlayerPasswordHash = await getConfiguredPasswordHash(c, 'player.password', 'player.passwordHash')
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
          nextPlayerPasswordHash = await hashPassword(newConfig['player.password'])
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

      if (newConfig['proxy.all.enabled'] !== undefined)
        c['proxy.all.enabled'] = parseBoolean(newConfig['proxy.all.enabled'], false)
      if (newConfig['proxy.all.address'] !== undefined) {
        const normalizedAddress = normalizeProxyAddress(newConfig['proxy.all.address'])
        const currentAddress = redactUrlCredentials(c['proxy.all.address'])
        c['proxy.all.address'] =
          normalizedAddress && normalizedAddress === currentAddress ? c['proxy.all.address'] : normalizedAddress
      }
      if (c['proxy.all.enabled'] && !String(c['proxy.all.address'] || '').trim()) {
        rollbackConfig()
        return ctx.json({ success: false, error: '启用全局代理时必须配置代理地址' }, 422)
      }

      if (newConfig['admin.path'] !== undefined || newConfig['player.path'] !== undefined) {
        const normalizedAdmin = normalizeConfiguredPath(
          newConfig['admin.path'] !== undefined ? newConfig['admin.path'] : (c['admin.path'] ?? ''),
          '',
          true,
        )
        const normalizedPlayer = normalizeConfiguredPath(
          newConfig['player.path'] !== undefined ? newConfig['player.path'] : (c['player.path'] ?? '/music'),
          '/music',
        )

        if (pathsOverlap(normalizedAdmin, normalizedPlayer)) {
          rollbackConfig()
          return ctx.json({ success: false, error: '后台管理路径与播放器路径不能相同或互相包含' }, 422)
        }
        c['admin.path'] = normalizedAdmin
        c['player.path'] = normalizedPlayer
      }

      if (newConfig['singer.sourcePriority'] !== undefined) {
        const priority = String(newConfig['singer.sourcePriority'])
          .split(',')
          .filter(s => s === 'tx' || s === 'wy') as Array<'tx' | 'wy'>
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

      const adminPasswordChanged =
        c['frontend.passwordHash'] !== originalConfig['frontend.passwordHash'] ||
        c['frontend.password'] !== originalConfig['frontend.password']
      const playerAuthChanged =
        c['player.passwordHash'] !== originalConfig['player.passwordHash'] ||
        c['player.password'] !== originalConfig['player.password'] ||
        Boolean(c['player.enableAuth']) !== Boolean(originalConfig['player.enableAuth'])
      if (adminPasswordChanged) revokeAllAdminSessions()
      if (playerAuthChanged) revokeAllPlayerSessions()
      if (global.lx.saveConfig) await global.lx.saveConfig()

      return ctx.json({ success: true, warning })
    } catch (e: any) {
      // 配置更新是一个整体操作；任何校验、序列化或写盘失败都不能留下半套内存配置。
      rollbackConfig()
      return ctx.fail(500, toUserMessage(e, '操作失败，请稍后重试'))
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
      process.exit(0)
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
    const maxUploadBytes = isMultipart ? MAX_LOCAL_BACKUP_BYTES + 1024 * 1024 : MAX_LOCAL_BACKUP_BYTES
    const boundary = isMultipart ? readMultipartBoundary(rawContentType) : null
    if (isMultipart && !boundary) return ctx.fail(400, 'multipart 备份格式无效')
    const declaredLength = Number(ctx.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      return ctx.fail(413, '备份文件大小不能超过 100 MB')
    }

    const previousConfig = { ...global.lx.config }
    const onRestored = async (restoredConfig: Record<string, unknown>) => {
      try {
        await applyValidatedConfig(restoredConfig)
        resetUserSpaces()
        refreshUsersFromDatabase()
        if (global.lx.config.serverCacheLocation) {
          fileCache.setCacheLocation(global.lx.config.serverCacheLocation)
        }
        global.lx.config['cache.namingPattern'] = fileCache.setNamingPattern(global.lx.config['cache.namingPattern'])
        if (global.lx.saveConfig) await global.lx.saveConfig()
        revokeAllUserSessions()
        revokeAllPlayerSessions()
        revokeAllAdminSessions()
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
        await restoreLocalBackup(source, { onRestored })
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
