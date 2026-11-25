import * as fs from 'node:fs'
import * as path from 'node:path'
import { assertSafePathSegment, resolveInside } from '@/utils/pathSecurity'
import { extractMetadata, type UserApiInfo } from './metadata'
import { apiStatus, loadedApis } from './registry'
import { loadUserApi } from './runtime'

function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8')
    fs.renameSync(tempPath, filePath)
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath)
      } catch {}
    }
  }
}
async function loadSourcesFromDir(dirPath: string, owner: string, stats: { loadedCount: number }) {
  const metaPath = path.join(dirPath, 'sources.json')
  if (!fs.existsSync(metaPath)) {
    return
  }

  try {
    let sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    let needsSave = false

    // === 按 order.json 排序，确保 loadedApis 插入顺序 = 用户配置的优先级顺序 ===
    const orderPath = path.join(dirPath, 'order.json')
    if (fs.existsSync(orderPath)) {
      try {
        const order: string[] = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
        if (order.length > 0) {
          const idToIndex = new Map(order.map((id, i) => [id, i]))
          sources = [...sources].sort((a: any, b: any) => {
            const ia = idToIndex.has(a.id) ? idToIndex.get(a.id)! : 999999
            const ib = idToIndex.has(b.id) ? idToIndex.get(b.id)! : 999999
            return ia - ib
          })
        }
      } catch (e) {}
    }
    // =========================================================================

    for (const source of sources) {
      if (!source.enabled) {
        console.log(`[UserApi] [${owner}] 跳过已禁用: ${source.name}`)
        apiStatus.delete(`${owner}_${source.id}`)
        continue
      }

      let scriptId: string
      try {
        scriptId = assertSafePathSegment(source.id, 'source id')
      } catch {
        console.warn(`[UserApi] [${owner}] 跳过非法源 ID`)
        continue
      }
      const scriptPath = resolveInside(dirPath, scriptId)
      if (!fs.existsSync(scriptPath)) {
        console.warn(`[UserApi] [${owner}] 脚本文件未找到: ${source.id}`)
        continue
      }

      try {
        const script = fs.readFileSync(scriptPath, 'utf-8')
        const metadata = extractMetadata(script)

        const result = await loadUserApi({
          id: source.id,
          name: metadata.name || source.name,
          description: metadata.description || '',
          version: metadata.version || 1,
          author: metadata.author || '',
          homepage: metadata.homepage || '',
          script,
          sources: {},
          enabled: source.enabled, // 传递原本的开关状态
          owner: owner, // 设置 owner
        })

        if (result.success) {
          stats.loadedCount++
          apiStatus.set(`${owner}_${source.id}`, { status: 'success' })

          // [Self-Healing] 检查并修复 supportedSources
          const runtimeSources = Object.keys(result.apiInstance.info.sources).sort()
          const storedSources = (source.supportedSources || []).sort()

          if (JSON.stringify(runtimeSources) !== JSON.stringify(storedSources)) {
            console.log(
              `[UserApi] [Fix] [${owner}] 更新源 ${source.name} 的支持列表: ${JSON.stringify(storedSources)} -> ${JSON.stringify(runtimeSources)}`,
            )
            source.supportedSources = runtimeSources
            if (metadata.version && source.version !== metadata.version) source.version = metadata.version
            if (metadata.author && source.author !== metadata.author) source.author = metadata.author
            if (metadata.description && source.description !== metadata.description)
              source.description = metadata.description
            if (metadata.homepage && source.homepage !== metadata.homepage) source.homepage = metadata.homepage
            needsSave = true
          }
        } else {
          console.error(`[UserApi] [${owner}] 加载 ${metadata.name || source.name} 失败: ${result.error}`)
          apiStatus.set(`${owner}_${source.id}`, { status: 'failed', error: result.error })
        }
      } catch (error: any) {
        console.error(`[UserApi] [${owner}] 加载 ${source.name} 失败:`, error.message)
        apiStatus.set(`${owner}_${source.id}`, { status: 'failed', error: error.message })
      }
    }

    if (needsSave) {
      // Write back using the original (file-order) sources array to avoid overwriting sources.json ordering
      const originalSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      const updatedMap = new Map(sources.map((s: any) => [s.id, s]))
      const merged = originalSources.map((s: any) => updatedMap.get(s.id) || s)
      writeJsonFileAtomic(metaPath, merged)
      console.log(`[UserApi] [${owner}] 已更新 sources.json 元数据`)
    }
  } catch (error: any) {
    console.error(`[UserApi] [${owner}] 读取 sources.json 失败:`, error.message)
  }
}

// 文件监控相关
let fsWatcher: fs.FSWatcher | null = null
const lastReloadMap = new Map<string, number>() // 记录每个用户的最后加载时间
let reloadChain: Promise<void> = Promise.resolve()

export const disposeLoadedApis = async (owner?: string) => {
  const entries = Array.from(loadedApis.entries()).filter(([, api]) => !owner || api.info.owner === owner)
  for (const [key, api] of entries) {
    try {
      await api.dispose?.()
    } catch (error: any) {
      console.warn(`[UserApi] 清理旧源失败 (${key}):`, error?.message || error)
    }
    loadedApis.delete(key)
  }
}

const clearReloadRelatedCaches = async (owner?: string) => {
  try {
    const { clearServerSourceMatchCache } = await import('../musicResolver')
    clearServerSourceMatchCache(owner)
  } catch (error: any) {
    console.warn('[UserApi] 清理音源匹配缓存失败:', error?.message || error)
  }
}

// 启动文件监控
function startWatcher(sourceRoot: string) {
  if (fsWatcher) return

  console.log(`[UserApi] 启动源文件监控: ${sourceRoot}`)
  const debounceMap = new Map<string, NodeJS.Timeout>()

  try {
    // Warning: recursive option for fs.watch is generally supported on Windows/macOS but not Linux
    // For better cross-platform support, chokidar would be preferred, but using fs.watch as requested/minimal dependency
    fsWatcher = fs.watch(sourceRoot, { recursive: true }, (eventType, filename) => {
      if (!filename) return

      // 仅关注 .js 和 sources.json 文件的变化
      if (!filename.endsWith('.js') && !filename.endsWith('sources.json')) {
        return
      }

      // 解析用户名 (目录名)
      // filename on Windows might be "username\file.js"
      const parts = (filename as string).split(path.sep)
      let username = parts[0]

      // 如果是 _open 目录，对应 'open' 用户
      if (username === '_open') {
        username = 'open'
      }

      // 简单的防抖处理
      if (debounceMap.has(username)) {
        clearTimeout(debounceMap.get(username)!)
      }

      debounceMap.set(
        username,
        setTimeout(() => {
          debounceMap.delete(username)
          // 检查是否是最近刚手动加载过 (避免面板上传造成的重复加载)
          // 阈值设为 3000ms，假设手动上传触发的 reload 会在这个时间内完成
          const lastReload = lastReloadMap.get(username) || 0
          if (Date.now() - lastReload < 3000) {
            console.log(`[UserApi] [Watcher] 忽略近期更新的文件变动 (视为手动上传): ${filename}`)
            return
          }
          lastReloadMap.delete(username)

          console.log(`[UserApi] [Watcher] 检测到文件变动 (${eventType}): ${filename} -> 重新加载 ${username}`)
          initUserApis(username).catch(err => {
            console.error(`[UserApi] [Watcher] 重新加载失败:`, err)
          })
        }, 2000),
      ) // 2秒防抖，等待文件写入完成
    })

    // 进程退出时关闭监听
    process.on('exit', () => {
      if (fsWatcher) fsWatcher.close()
    })
  } catch (e) {
    console.error('[UserApi] 启动文件监控失败:', e)
  }
}

// 从文件系统加载所有已启用的自定义源
// 路径变更：DATA_PATH/users/source/{username} 和 DATA_PATH/users/source/_open
async function initUserApisInternal(targetUser?: string) {
  if (targetUser && targetUser !== 'open') assertSafePathSegment(targetUser, 'username')
  const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
  const sourceRoot = path.join(dataPath, 'users', 'source')
  const stats = { loadedCount: 0 }

  // 更新最后加载时间
  if (targetUser) {
    lastReloadMap.set(targetUser, Date.now())
  } else {
    // 全局加载
  }

  console.log(`[UserApi] ========================================`)

  // 如果根目录不存在，无需加载
  if (!fs.existsSync(sourceRoot)) {
    await disposeLoadedApis(targetUser)
    await clearReloadRelatedCaches(targetUser)
    if (!targetUser) apiStatus.clear()
    console.log(`[UserApi] Source root directory not found: ${sourceRoot}`)
    console.log(`[UserApi] ========================================`)
    return
  }

  // 尝试启动监控 (只会在第一次调用且无 watcher 时启动)
  if (!fsWatcher) {
    startWatcher(sourceRoot)
  }

  if (targetUser) {
    console.log(`[UserApi] 重新加载用户源: ${targetUser}`)
    // 清理该用户的旧源和状态
    await disposeLoadedApis(targetUser)
    await clearReloadRelatedCaches(targetUser)
    for (const key of apiStatus.keys()) {
      if (key.startsWith(`${targetUser}_`)) {
        apiStatus.delete(key)
      }
    }

    // 加载该用户的源
    let dirName = targetUser

    // 特殊处理：如果是 'open'，对应目录是 '_open'
    if (targetUser === 'open') {
      dirName = '_open'
    }

    const userSourceDir = resolveInside(sourceRoot, dirName)
    if (fs.existsSync(userSourceDir)) {
      await loadSourcesFromDir(userSourceDir, targetUser, stats)
    }
  } else {
    console.log(`[UserApi] 初始化所有自定义源...`)
    await disposeLoadedApis()
    await clearReloadRelatedCaches()
    apiStatus.clear()
    lastReloadMap.clear()

    // 扫描 sourceRoot 下的所有子目录
    try {
      const entries = fs.readdirSync(sourceRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          let owner = entry.name
          // 如果目录是 _open，owner 为 'open'
          if (entry.name === '_open') {
            owner = 'open'
          }

          const dirPath = resolveInside(sourceRoot, entry.name)
          await loadSourcesFromDir(dirPath, owner, stats)
        }
      }
    } catch (error: any) {
      console.error('[UserApi] 扫描源目录失败:', error.message)
    }
  }

  console.log(`[UserApi] 本次加载: ${stats.loadedCount} 个源`)
  console.log(`[UserApi] 当前总计: ${loadedApis.size} 个源`)
  console.log(`[UserApi] ========================================`)
}

export function initUserApis(targetUser?: string) {
  const nextReload = reloadChain.then(() => initUserApisInternal(targetUser))
  reloadChain = nextReload.catch(() => {})
  return nextReload
}

/** Dispose an old account's runtime sources and load the renamed account. */
export const reloadUserCustomSources = async (oldOwner: string, newOwner?: string): Promise<void> => {
  await disposeLoadedApis(oldOwner)
  await clearReloadRelatedCaches(oldOwner)
  for (const key of apiStatus.keys()) {
    if (key.startsWith(`${oldOwner}_`)) apiStatus.delete(key)
  }
  if (newOwner) await initUserApis(newOwner)
}

// 获取所有已加载的 API
