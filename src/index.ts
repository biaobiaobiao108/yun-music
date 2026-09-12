#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

if (typeof (global as any).navigator === 'undefined') {
  (global as any).navigator = { userAgent: 'node.js' }
}

import { initLogger } from '@/utils/log4js'
import defaultConfig from './defaultConfig'
import { ENV_PARAMS, File } from './constants'
import { checkAndCreateDirSync } from './utils'
import { assertSafePathSegment } from './utils/pathSecurity'

// Declare Env Params Type
type ENV_PARAMS_Type = typeof ENV_PARAMS
type ENV_PARAMS_Value_Type = ENV_PARAMS_Type[number]


process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason)
})

let envParams: Partial<Record<Exclude<ENV_PARAMS_Value_Type, 'LX_USER_'>, string>> = {}
let envUsers: LX.User[] = []
const envParamKeys = Object.values(ENV_PARAMS).filter(v => v != 'LX_USER_')

{
  const envLog = [
    ...(envParamKeys.map(e => [e, process.env[e]]) as Array<[Exclude<ENV_PARAMS_Value_Type, 'LX_USER_'>, string]>).filter(([k, v]) => {
      if (!v) return false
      envParams[k] = v
      return true
    }),
    ...Object.entries(process.env)
      .filter(([k, v]) => {
        if (k.startsWith('LX_USER_') && !!v) {
          const name = k.replace('LX_USER_', '')
          if (name) {
            envUsers.push({
              name,
              password: v,
            })
            return true
          }
        }
        return false
      }),
  ].map(([e]) => `${e}: [configured]`)
  if (envLog.length) console.log(`Load env: \n  ${envLog.join('\n  ')}`)
}

let lastConfigHash = ''
const getConfigHash = (filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) return ''
    const content = fs.readFileSync(filePath)
    return crypto.createHash('md5').update(content).digest('hex')
  } catch {
    return ''
  }
}

const dataPath = envParams.DATA_PATH ?? path.join(__dirname, '../data')
const saveConfigToFile = async () => {
  const configPath = process.env.CONFIG_PATH || path.join(dataPath, 'config.js')
  const content = `module.exports = ${JSON.stringify(global.lx.config, null, 2)}\n`
  try {
    const file = Bun.file(configPath)
    if (await file.exists()) {
      const existing = await file.text()
      if (existing.trim() === content.trim()) {
        lastConfigHash = crypto.createHash('md5').update(content).digest('hex')
        return
      }
    }
    await Bun.write(configPath, content)
    lastConfigHash = crypto.createHash('md5').update(content).digest('hex')
    // console.log('Current memory config saved to config.js')
  } catch (err) {
    console.error('Failed to save config.js:', err)
  }
}

global.lx = {
  logPath: envParams.LOG_PATH ?? path.join(__dirname, '../logs'),
  dataPath,
  userPath: path.join(dataPath, File.userDir),
  config: defaultConfig,
  staticPath: process.env.STATIC_PATH ?? path.join(process.cwd(), 'public'),
  saveConfig: saveConfigToFile,
}

const mergeConfigFileEnv = (config: Partial<Record<ENV_PARAMS_Value_Type, string>>) => {
  const envLog = []
  for (const [k, v] of Object.entries(config).filter(([k]) => k.startsWith('env.'))) {
    const envKey = k.replace('env.', '') as keyof typeof envParams
    let value = String(v)
    if (envParamKeys.includes(envKey)) {
      if (envParams[envKey] == null) {
        envLog.push(`${envKey}: [configured]`)
        envParams[envKey] = value
      }
    } else if (envKey.startsWith('LX_USER_') && value) {
      const name = k.replace('LX_USER_', '')
      if (name) {
        envUsers.push({
          name,
          password: value,
        })
        envLog.push(`${envKey}: [configured]`)
      }
    }
  }
  if (envLog.length) console.log(`Load config file env:\n  ${envLog.join('\n  ')}`)
}

const margeConfig = (p: string) => {
  let config
  try {
    config = path.extname(p) == '.js'
      ? require(p)
      : JSON.parse(fs.readFileSync(p).toString()) as LX.Config
  } catch (err: any) {
    console.warn('Read config error: ' + (err.message as string))
    return false
  }
  const newConfig = { ...global.lx.config }
  for (const key of Object.keys(defaultConfig) as Array<keyof LX.Config>) {
    // @ts-expect-error
    if (config[key] !== undefined) newConfig[key] = config[key]
  }

  console.log('Load config: ' + p)
  if (newConfig.users.length) {
    const users: LX.UserConfig[] = []
    for (const user of newConfig.users) {
      users.push({
        ...user,
        dataPath: '',
      })
    }
    newConfig.users = users
  }
  global.lx.config = newConfig

  mergeConfigFileEnv(config)
  return true
}

//加载环境变量
const p1 = path.join(__dirname, '../config.js')
fs.existsSync(p1) && margeConfig(p1)
const dataConfigPath = envParams.CONFIG_PATH || path.join(dataPath, 'config.js')
dataConfigPath !== p1 && fs.existsSync(dataConfigPath) && margeConfig(dataConfigPath)
envParams.CONFIG_PATH && envParams.CONFIG_PATH !== dataConfigPath && fs.existsSync(envParams.CONFIG_PATH) && margeConfig(envParams.CONFIG_PATH)
if (envParams.PROXY_HEADER) {
  global.lx.config['proxy.enabled'] = true
  global.lx.config['proxy.header'] = envParams.PROXY_HEADER
}
if (envParams.MAX_SNAPSHOT_NUM) {
  const num = parseInt(envParams.MAX_SNAPSHOT_NUM)
  if (!isNaN(num)) global.lx.config.maxSnapshotNum = num
}
if (envParams.LIST_ADD_MUSIC_LOCATION_TYPE) {
  switch (envParams.LIST_ADD_MUSIC_LOCATION_TYPE) {
    case 'top':
    case 'bottom':
      global.lx.config['list.addMusicLocationType'] = envParams.LIST_ADD_MUSIC_LOCATION_TYPE
      break
  }
}
if (envParams.FRONTEND_PASSWORD) {
  global.lx.config['frontend.password'] = envParams.FRONTEND_PASSWORD
}
if (envParams.USER_ENABLE_PATH) {
  global.lx.config['user.enablePath'] = envParams.USER_ENABLE_PATH === 'true'
}
if (envParams.USER_ENABLE_ROOT) {
  global.lx.config['user.enableRoot'] = envParams.USER_ENABLE_ROOT === 'true'
}
if (envParams.PORT) {
  const port = parseInt(envParams.PORT, 10)
  if (!isNaN(port) && port > 0) global.lx.config.port = port
}
if (envParams.BIND_IP) {
  global.lx.config.bindIP = envParams.BIND_IP
}
if (envParams.ENABLE_WEBPLAYER_AUTH) {
  global.lx.config['player.enableAuth'] = envParams.ENABLE_WEBPLAYER_AUTH === 'true'
}
if (envParams.WEBPLAYER_PASSWORD) {
  global.lx.config['player.password'] = envParams.WEBPLAYER_PASSWORD
}
if (envParams.DISABLE_TELEMETRY) {
  global.lx.config.disableTelemetry = envParams.DISABLE_TELEMETRY === 'true'
}
if (envParams.ENABLE_PUBLIC_USER_RESTRICTION) {
  global.lx.config['user.enablePublicRestriction'] = envParams.ENABLE_PUBLIC_USER_RESTRICTION === 'true'
}
if (envParams.ENABLE_PUBLIC_NON_ADMIN_LOCAL_MUSIC) {
  global.lx.config['user.enablePublicNonAdminLocalMusic'] = envParams.ENABLE_PUBLIC_NON_ADMIN_LOCAL_MUSIC === 'true'
}
if (envParams.ENABLE_PUBLIC_FAVORITES) {
  global.lx.config['user.enablePublicFavorites'] = envParams.ENABLE_PUBLIC_FAVORITES === 'true'
}
if (envParams.ENABLE_PUBLIC_NON_ADMIN_ACCESS) {
  global.lx.config['user.enablePublicNonAdminAccess'] = envParams.ENABLE_PUBLIC_NON_ADMIN_ACCESS === 'true'
}
if (envParams.ENABLE_LOGIN_USER_CACHE_RESTRICTION) {
  global.lx.config['user.enableLoginCacheRestriction'] = envParams.ENABLE_LOGIN_USER_CACHE_RESTRICTION === 'true'
}
if (envParams.ENABLE_CACHE_SIZE_LIMIT) {
  global.lx.config['user.enableCacheSizeLimit'] = envParams.ENABLE_CACHE_SIZE_LIMIT === 'true'
}
if (envParams.CACHE_SIZE_LIMIT) {
  global.lx.config['user.cacheSizeLimit'] = parseInt(envParams.CACHE_SIZE_LIMIT) || 2000
}
if (envParams.PROXY_ALL_ENABLED) {
  global.lx.config['proxy.all.enabled'] = envParams.PROXY_ALL_ENABLED === 'true'
}
if (envParams.PROXY_ALL_ADDRESS) {
  global.lx.config['proxy.all.address'] = envParams.PROXY_ALL_ADDRESS
}
if (envParams.ADMIN_PATH !== undefined) {
  global.lx.config['admin.path'] = envParams.ADMIN_PATH
}
if (envParams.PLAYER_PATH !== undefined) {
  global.lx.config['player.path'] = envParams.PLAYER_PATH
}
if (envParams.SINGER_SOURCE_PRIORITY !== undefined) {
  const priority = envParams.SINGER_SOURCE_PRIORITY.split(',').filter(s => s === 'tx' || s === 'wy') as Array<'tx' | 'wy'>
  if (priority.length > 0) global.lx.config['singer.sourcePriority'] = priority
}
if (envParams.SERVER_NAME) {
  global.lx.config.serverName = envParams.SERVER_NAME
}

if (envUsers.length) {
  const users: LX.Config['users'] = []
  let u
  for (let user of envUsers) {
    let isLikeJSON = true
    try {
      u = JSON.parse(user.password) as Omit<LX.User, 'name'>
    } catch {
      isLikeJSON = false
    }
    if (isLikeJSON && typeof u == 'object') {
      users.push({
        name: user.name,
        ...u,
        dataPath: '',
      })
    } else {
      users.push({
        name: user.name,
        password: user.password,
        dataPath: '',
      })
    }
  }
  global.lx.config.users = users
}

const exit = (message: string): never => {
  console.error(message)
  process.exit(0)
}

const checkAndCreateDir = (path: string) => {
  try {
    checkAndCreateDirSync(path)
  } catch (e: any) {
    if (e.code !== 'EEXIST') {
      exit(`Could not set up log directory, error was: ${e.message as string}`)
    }
  }
}

const checkUserConfig = (users: LX.Config['users']) => {
  const userNames: string[] = []
  const passwords: string[] = []
  // 允许重复密码的条件：开启了路径模式 且 关闭了根路径模式
  const allowDuplicatePasswords = global.lx.config['user.enablePath'] && !global.lx.config['user.enableRoot']

  for (const user of users) {
    try {
      assertSafePathSegment(user.name, 'user name')
    } catch {
      exit('User name contains invalid path characters')
    }
    if (user.name === '_open') exit('User name is reserved: _open')
    if (userNames.includes(user.name)) exit('User name duplicate: ' + user.name)
    if (typeof user.password !== 'string' || user.password.trim() === '') exit(`User ${user.name} must have a non-empty password`)
    if (!allowDuplicatePasswords && passwords.includes(user.password)) exit(`Duplicate password is not allowed for user ${user.name}`)
    userNames.push(user.name)
    passwords.push(user.password)
  }
}

checkAndCreateDir(global.lx.logPath)
checkAndCreateDir(global.lx.dataPath)
checkAndCreateDir(global.lx.userPath)
checkAndCreateDir(global.lx.userPath)

// Load users from users.json if exists
const usersJsonPath = path.join(global.lx.dataPath, 'users.json')
if (fs.existsSync(usersJsonPath)) {
  try {
    const users = JSON.parse(fs.readFileSync(usersJsonPath, 'utf-8'))
    if (Array.isArray(users)) {
      console.log('Load users from users.json')
      global.lx.config.users = users.map(u => ({ ...u, dataPath: '' }))
    }
  } catch (err) {
    console.error('Failed to load users.json', err)
  }
} else {
  // Save initial users to users.json
  try {
    fs.writeFileSync(usersJsonPath, JSON.stringify(global.lx.config.users.map(u => ({
      name: u.name,
      password: u.password,
      maxSnapshotNum: u.maxSnapshotNum,
      'list.addMusicLocationType': u['list.addMusicLocationType'],
    })), null, 2))
  } catch (err) {
    console.error('Failed to save users.json', err)
  }
}

checkUserConfig(global.lx.config.users)

const frontendPassword = global.lx.config['frontend.password']
if (typeof frontendPassword !== 'string' || frontendPassword.trim() === '' || frontendPassword === '123456') {
  exit('frontend.password must be explicitly configured and must not use the example password')
}
if (global.lx.config['player.enableAuth']) {
  const playerPassword = global.lx.config['player.password']
  if (typeof playerPassword !== 'string' || playerPassword.trim() === '' || playerPassword === '123456') {
    exit('player.password must be explicitly configured when player authentication is enabled')
  }
}

console.log(`Users:
${global.lx.config.users.map(user => `  ${user.name}: [PROTECTED]`).join('\n') || '  No User'}
`)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getUserDirname } = require('@/user')
for (const user of global.lx.config.users) {
  const dataPath = path.join(global.lx.userPath, getUserDirname(user.name))
  checkAndCreateDir(dataPath)
  user.dataPath = dataPath
}

initLogger()


/**
 * Normalize a port into a number, string, or false.
 */

function normalizePort(val: string) {
  const port = parseInt(val, 10)

  if (isNaN(port) || port < 1) {
    // named pipe
    exit(`port illegal: ${val}`)
  }
  return port
}

/**
 * Get port from environment and store in Express.
 */

// const port = normalizePort(envParams.PORT ?? '9527')
// const bindIP = envParams.BIND_IP ?? '127.0.0.1'

// 初始化全局事件总线
const { createModuleEvent } = await import('@/event')
createModuleEvent()

// 初始化 SQLite 原生数据库 (WAL 模式)
const { initDatabase, closeDb } = await import('@/database')
initDatabase()
const { syncUsersToDatabase } = await import('@/user/data')
syncUsersToDatabase(global.lx.config.users)

// 初始化 Web 服务
const { startServer, stopServer } = await import('@/server')

// [新增] 确保数据目录下的 _open 及 _open/library 目录存在 (用于公共受限资源 & 公开收藏)
const openDir = path.join(global.lx.userPath, '_open')
const openLibDir = path.join(openDir, 'library')
if (!fs.existsSync(openDir)) {
  fs.mkdirSync(openDir, { recursive: true })
}
if (!fs.existsSync(openLibDir)) {
  fs.mkdirSync(openLibDir, { recursive: true })
}

// 启动前最后保存一次合并后的配置，确保环境变量被固化到 config.js 中
await saveConfigToFile()

await startServer(global.lx.config.port, global.lx.config.bindIP)

// 监控 config.js 变动以实现热重载 (由于 nodemon 已忽略该文件)
const rootConfigPath = process.env.CONFIG_PATH || path.join(global.lx.dataPath, 'config.js')
let configWatcher: fs.FSWatcher | null = null
if (fs.existsSync(rootConfigPath)) {
  lastConfigHash = getConfigHash(rootConfigPath)
  let debounceTimer: NodeJS.Timeout | null = null
  configWatcher = fs.watch(rootConfigPath, (event) => {
    if (event === 'change') {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        const currentHash = getConfigHash(rootConfigPath)
        // 如果内容未发生实质改变（如内部写配置触发的 fs.watch 事件），跳过热重载
        if (currentHash && currentHash === lastConfigHash) return
        lastConfigHash = currentHash

        console.log('Detected external config.js change, hot-reloading...')
        try {
          delete require.cache[require.resolve(rootConfigPath)]
          margeConfig(rootConfigPath)
        } catch (e) {
          console.error('Hot-reload config.js failed:', e)
        }
      }, 500)
    }
  })
}

// 优雅停机处理 (Graceful Shutdown)
let isShuttingDown = false
const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log(`\nReceived ${signal}, shutting down gracefully...`)

  try {
    if (configWatcher) {
      configWatcher.close()
      configWatcher = null
    }
  } catch { }

  try {
    await stopServer(true)
  } catch (err) {
    console.error('Error stopping server:', err)
  }

  try {
    closeDb()
  } catch (err) {
    console.error('Error closing database:', err)
  }

  console.log('Server stopped cleanly. Goodbye.')
  process.exit(0)
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
