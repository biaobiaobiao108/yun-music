import * as fs from 'node:fs'
import * as path from 'node:path'
import { isRetiredOnlineSource, UnsupportedSourceError } from '@/common/musicSources'
import { assertSafePathSegment, resolveInside } from '@/utils/pathSecurity'
import { normalizeSongInfo } from '../songInfo'
import { loadedApis } from './registry'

const jsonFileCache = new Map<string, { mtimeMs: number; value: unknown }>()
const MAX_JSON_FILE_CACHE_ENTRIES = 256

const readCachedJsonFile = <T>(filePath: string, fallback: T): T => {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false })
    if (!stat) {
      jsonFileCache.delete(filePath)
      return fallback
    }
    const cached = jsonFileCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.value as T
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    if (jsonFileCache.size >= MAX_JSON_FILE_CACHE_ENTRIES) {
      jsonFileCache.delete(jsonFileCache.keys().next().value!)
    }
    jsonFileCache.set(filePath, { mtimeMs: stat.mtimeMs, value: parsed })
    return parsed
  } catch {
    return fallback
  }
}

const getSourceRoot = (): string => {
  const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
  return path.join(dataPath, 'users', 'source')
}

const readUserSourceOverrides = (
  sourceRoot: string,
  clientUsername?: string,
): { userStates: Record<string, any>; userApiIds: Set<string> } => {
  const userStates: Record<string, any> = {}
  const userApiIds = new Set<string>()
  if (!clientUsername || clientUsername === 'default') {
    return { userStates, userApiIds }
  }
  const userPath = resolveInside(sourceRoot, clientUsername)
  Object.assign(userStates, readCachedJsonFile<Record<string, any>>(path.join(userPath, 'states.json'), {}))
  const userSources = readCachedJsonFile<Array<{ id?: string }>>(path.join(userPath, 'sources.json'), [])
  if (Array.isArray(userSources)) {
    for (const s of userSources) {
      if (s?.id) userApiIds.add(s.id)
    }
  }
  return { userStates, userApiIds }
}

const sleepWithSignal = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const isNonRetryableCustomSourceError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return message.includes('已卸载') || message.includes('未注册 request 处理器')
}

export async function callUserApiGetMusicUrl(
  source: string,
  songInfo: any,
  quality: string,
  clientUsername?: string,
  onProgress?: (attempt: any) => Promise<void> | void,
  enableAutoSwitchApiSource?: boolean,
  signal?: AbortSignal,
): Promise<{ url: string; type: string; sourceName?: string; attempts?: any[] }> {
  if (isRetiredOnlineSource(source)) {
    throw new UnsupportedSourceError(source)
  }
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open' && clientUsername !== '_open') {
    clientUsername = assertSafePathSegment(clientUsername, 'username')
  }
  // 标准化 songInfo 格式：复用共享字段映射并保留自定义源脚本可能读取的附加字段
  const normalizedSongInfo = normalizeSongInfo({ ...songInfo })
  if (songInfo?.meta) {
    Object.assign(normalizedSongInfo, songInfo.meta)
    normalizeSongInfo(normalizedSongInfo)
  }

  for (const field of ['hash', 'copyrightId', 'strMediaMid', 'albumMid', 'albumId', 'lrcUrl', 'mrcUrl', 'trcUrl']) {
    if (!normalizedSongInfo[field] && songInfo?.[field]) {
      normalizedSongInfo[field] = songInfo[field]
    }
  }
  if (typeof normalizedSongInfo.hash === 'string' && !normalizedSongInfo.hash) {
    delete normalizedSongInfo.hash
  }

  let supportedCount = 0
  let lastError: Error | null = null
  const sourceRoot = getSourceRoot()

  // 查找支持该 source 的 API
  // 收集所有支持该 source 的 API，并根据权限过滤
  let candidates: any[] = []
  const { userStates, userApiIds } = readUserSourceOverrides(sourceRoot, clientUsername)

  // 按 loadedApis 收集所有可用候选源（权限过滤，不强制任何顺序）
  for (const [, api] of loadedApis) {
    if (!api.info.sources || !api.info.sources[source]) continue

    if (api.info.owner === 'open') {
      // 计算公开源对当前用户的有效启用状态
      let isEnabled = api.info.enabled
      if (clientUsername && clientUsername !== 'default' && userStates[api.info.id]) {
        if (typeof userStates[api.info.id].enabled === 'boolean') {
          isEnabled = userStates[api.info.id].enabled
        }
      }
      if (!isEnabled) continue
      if (userApiIds.has(api.info.id)) continue // 被同名私有版本覆盖，跳过
      candidates.push(api)
    } else if (clientUsername && api.info.owner === clientUsername) {
      if (!api.info.enabled) continue
      candidates.push(api)
      userApiIds.add(api.info.id) // 兜底：确保后续不重复添加公开同名源
    }
  }

  // === 按 order.json 对候选列表排序（基于 mtime 缓存） ===
  if (candidates.length > 1) {
    let orderData: string[] = []

    // 优先读用户自己的排序（admin/order.json），再回退到公开源排序（_open/order.json）
    const orderCandidates =
      clientUsername && clientUsername !== 'default'
        ? [resolveInside(sourceRoot, clientUsername, 'order.json'), resolveInside(sourceRoot, '_open', 'order.json')]
        : [resolveInside(sourceRoot, '_open', 'order.json')]

    for (const orderPath of orderCandidates) {
      const parsed = readCachedJsonFile<string[]>(orderPath, [])
      if (Array.isArray(parsed) && parsed.length > 0) {
        orderData = parsed
        break
      }
    }

    if (orderData.length > 0) {
      const idToIndex = new Map(orderData.map((id, i) => [id, i]))
      candidates.sort((a: any, b: any) => {
        const ia = idToIndex.has(a.info.id) ? idToIndex.get(a.info.id)! : 999999
        const ib = idToIndex.has(b.info.id) ? idToIndex.get(b.info.id)! : 999999
        return ia - ib
      })
    }
  }
  // =========================================

  if (enableAutoSwitchApiSource === false && candidates.length > 1) {
    candidates = [candidates[0]]
  }

  supportedCount = candidates.length

  if (supportedCount === 0) {
    const errMsg = `未找到支持 ${source} 平台的自定义源，请联系管理员配置或启用相关源`
    if (onProgress) await onProgress({ name: '系统', status: 'fail', message: errMsg })
    throw new Error(errMsg)
  }

  // 逻辑分歧：
  // 1. 如果只有一个源支持 -> 重试 3 次
  // 2. 如果有多个源支持 -> 每个源试一次 (轮询)

  const attempts: any[] = []

  if (supportedCount === 1) {
    const api = candidates[0]
    const maxRetries = 3

    for (let i = 0; i < maxRetries; i++) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      try {
        console.log(
          `[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (第 ${i + 1}/${maxRetries} 次, Owner: ${api.info.owner})`,
        )

        const url = await api.callRequest(
          'musicUrl',
          source,
          {
            musicInfo: normalizedSongInfo,
            quality: quality,
            type: quality,
          },
          signal,
        )

        console.log(`[UserApi] ✓ ${api.info.name} 成功返回链接 (Owner: ${api.info.owner})`)
        const att = { name: api.info.name, status: 'success', message: `第 ${i + 1} 次尝试成功` }
        attempts.push(att)
        if (onProgress) await onProgress(att)
        return { url, type: quality, sourceName: api.info.name, attempts }
      } catch (error: any) {
        console.error(`[UserApi] ${api.info.name} 失败 (第 ${i + 1}/${maxRetries} 次):`, `音源日志：${error.message}`)
        lastError = error
        const att = {
          name: api.info.name,
          status: 'fail',
          message: `第 ${i + 1} 次尝试失败,音源日志：${error.message}`,
        }
        attempts.push(att)
        if (onProgress) await onProgress(att)
        if (isNonRetryableCustomSourceError(error)) break
        if (i < maxRetries - 1) {
          await sleepWithSignal(1000, signal)
        }
      }
    }
  } else {
    // 多个源，轮流尝试
    for (const api of candidates) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      try {
        console.log(`[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (Owner: ${api.info.owner})`)

        const url = await api.callRequest(
          'musicUrl',
          source,
          {
            musicInfo: normalizedSongInfo,
            quality: quality,
            type: quality,
          },
          signal,
        )

        console.log(`[UserApi] ✓ ${api.info.name} 成功返回链接 (Owner: ${api.info.owner})`)
        const att = { name: api.info.name, status: 'success' }
        attempts.push(att)
        if (onProgress) await onProgress(att)
        return { url, type: quality, sourceName: api.info.name, attempts }
      } catch (error: any) {
        console.error(`[UserApi] ${api.info.name} 失败:`, `音源日志：${error.message}`)
        lastError = error
        const att = { name: api.info.name, status: 'fail', message: `音源日志：${error.message}` }
        attempts.push(att)
        if (onProgress) await onProgress(att)
        continue
      }
    }
  }

  const detailMsg =
    supportedCount === 1
      ? `自定义源 [${candidates[0].info.name}] 解析失败`
      : `已尝试了 ${supportedCount} 个支持 ${source} 平台的源，但全部解析失败`

  const finalError: any = new Error(`${detailMsg} (音源日志: ${lastError?.message})`)
  finalError.attempts = attempts
  throw finalError
}

export function isSourceSupported(source: string, clientUsername?: string): boolean {
  // Retired built-in IDs are never reactivated through userApi. Custom APIs
  // must use their own ID so historical data cannot silently switch source.
  if (isRetiredOnlineSource(source)) return false
  const safeUsername =
    clientUsername && clientUsername !== 'default' && clientUsername !== 'open' && clientUsername !== '_open'
      ? assertSafePathSegment(clientUsername, 'username')
      : clientUsername
  const { userStates, userApiIds } = readUserSourceOverrides(getSourceRoot(), safeUsername)
  for (const [, api] of loadedApis) {
    if (!api.info.sources || !api.info.sources[source]) {
      continue
    }

    if (api.info.owner === 'open') {
      let isEnabled = api.info.enabled
      if (safeUsername && safeUsername !== 'default' && userStates[api.info.id]) {
        if (typeof userStates[api.info.id].enabled === 'boolean') {
          isEnabled = userStates[api.info.id].enabled
        }
      }
      if (!isEnabled || userApiIds.has(api.info.id)) continue
      return true
    }

    if (safeUsername && api.info.owner === safeUsername && api.info.enabled) {
      return true
    }
  }
  return false
}
