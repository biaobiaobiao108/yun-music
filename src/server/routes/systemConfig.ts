import fs from 'node:fs'
import path from 'node:path'
import { isValidHttpHeaderName, normalizeTrustedProxyAddresses } from '../core/context'
import { revokeSessionsForConfigChange } from '../auth'
import { startupLog } from '@/utils/log4js'
import { parseConfigFile } from '@/utils/configLoader'
import { hashPassword, isPasswordHash } from '@/utils/passwordHash'
import { isPrivateProxyTarget } from '../networkSecurity'

export const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true' || value === '1' || value === 'on') return true
    if (value.toLowerCase() === 'false' || value === '0' || value === 'off') return false
  }
  return fallback
}

export const parseBoundedInteger = (value: unknown, min: number, max: number, fallback: number): number => {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback
}

export const normalizeConfiguredPath = (value: unknown, fallback: string, allowEmpty = false): string => {
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

export const redactUrlCredentials = (value: unknown): string => {
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

export const pathsOverlap = (left: string, right: string): boolean => {
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

export const getConfiguredPasswordHash = async (
  config: Record<string, any>,
  plainKey: 'frontend.password' | 'player.password',
  hashKey: 'frontend.passwordHash' | 'player.passwordHash',
): Promise<string> => {
  if (isPasswordHash(config[hashKey])) return config[hashKey]
  if (typeof config[plainKey] === 'string' && config[plainKey].trim()) return hashPassword(config[plainKey])
  return ''
}

export const normalizeProxyAddress = (value: unknown): string => {
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
  if (isPrivateProxyTarget(host) && process.env.ALLOW_PRIVATE_PROXY !== '1') {
    throw new Error('代理地址不能是本机、内网或回环地址（如需本机代理请设置 ALLOW_PRIVATE_PROXY=1）')
  }
  return address
}

/** 只应用当前版本已知且经过基本校验的运行时配置。 */
export const applyValidatedConfig = async (
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
      !global.lx.managedCredentials?.adminPassword
    ) {
      await applyConfiguredPassword(config, restored, 'frontend.password', 'frontend.passwordHash', '管理员密码', true)
    }
    if (
      (restored['player.password'] !== undefined || restored['player.passwordHash'] !== undefined) &&
      !global.lx.managedCredentials?.playerPassword
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
      revokeSessionsForConfigChange(previousConfig, global.lx.config as unknown as Record<string, unknown>)
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
