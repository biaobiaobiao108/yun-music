import * as fs from 'node:fs'
import * as path from 'node:path'
import { isRetiredOnlineSource, UnsupportedSourceError } from '@/common/musicSources'
import { assertSafePathSegment, resolveInside } from '@/utils/pathSecurity'
import { loadedApis } from './registry'
export async function callUserApiGetMusicUrl(
  source: string,
  songInfo: any,
  quality: string,
  clientUsername?: string,
  onProgress?: (attempt: any) => Promise<void> | void,
  enableAutoSwitchApiSource?: boolean,
): Promise<{ url: string; type: string; sourceName?: string; attempts?: any[] }> {
  if (isRetiredOnlineSource(source)) {
    throw new UnsupportedSourceError(source)
  }
  if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open' && clientUsername !== '_open') {
    clientUsername = assertSafePathSegment(clientUsername, 'username')
  }
  // 标准化 songInfo 格式：将 meta 中的字段提升到顶层
  const normalizedSongInfo = { ...songInfo }
  if (songInfo.meta) {
    // 将 meta 中的所有字段展开到顶层
    Object.assign(normalizedSongInfo, songInfo.meta)

    // ========== 通用字段映射 ==========
    // songId -> songmid (通用)
    if (songInfo.meta.songId && !normalizedSongInfo.songmid) {
      normalizedSongInfo.songmid = songInfo.meta.songId
    }

    // 图片字段统一
    if (songInfo.meta.picUrl && !normalizedSongInfo.img) {
      normalizedSongInfo.img = songInfo.meta.picUrl
    }

    // 音质信息
    if (songInfo.meta.qualitys && !normalizedSongInfo.types) {
      normalizedSongInfo.types = songInfo.meta.qualitys
    }
    if (songInfo.meta._qualitys && !normalizedSongInfo._types) {
      normalizedSongInfo._types = songInfo.meta._qualitys
    }

    // ========== 各平台特有字段 ==========
    if (songInfo.meta.albumId && !normalizedSongInfo.albumId) {
      normalizedSongInfo.albumId = songInfo.meta.albumId
    }

    // QQ音乐 (tx): strMediaMid, albumMid
    if (songInfo.meta.strMediaMid && !normalizedSongInfo.strMediaMid) {
      normalizedSongInfo.strMediaMid = songInfo.meta.strMediaMid
    }
    if (songInfo.meta.albumMid && !normalizedSongInfo.albumMid) {
      normalizedSongInfo.albumMid = songInfo.meta.albumMid
    }

    // 不再删除 meta 对象，以免有些严谨的脚本报错（许多脚本会读取 info.meta）
    // delete normalizedSongInfo.meta
  }

  // ========== 顶层字段兜底映射 ==========
  if (!normalizedSongInfo.hash && songInfo.hash) {
    normalizedSongInfo.hash = songInfo.hash
  }
  if (!normalizedSongInfo.copyrightId && songInfo.copyrightId) {
    normalizedSongInfo.copyrightId = songInfo.copyrightId
  }
  if (!normalizedSongInfo.strMediaMid && songInfo.strMediaMid) {
    normalizedSongInfo.strMediaMid = songInfo.strMediaMid
  }
  if (!normalizedSongInfo.albumMid && songInfo.albumMid) {
    normalizedSongInfo.albumMid = songInfo.albumMid
  }
  if (!normalizedSongInfo.albumId && songInfo.albumId) {
    normalizedSongInfo.albumId = songInfo.albumId
  }
  if (!normalizedSongInfo.lrcUrl && songInfo.lrcUrl) {
    normalizedSongInfo.lrcUrl = songInfo.lrcUrl
  }
  if (!normalizedSongInfo.mrcUrl && songInfo.mrcUrl) {
    normalizedSongInfo.mrcUrl = songInfo.mrcUrl
  }
  if (!normalizedSongInfo.trcUrl && songInfo.trcUrl) {
    normalizedSongInfo.trcUrl = songInfo.trcUrl
  }
  if (typeof normalizedSongInfo.hash === 'string' && !normalizedSongInfo.hash) {
    delete normalizedSongInfo.hash
  }

  let supportedCount = 0
  let lastError: Error | null = null
  const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
  const sourceRoot = path.join(dataPath, 'users', 'source')

  // 查找支持该 source 的 API
  // 收集所有支持该 source 的 API，并根据权限过滤
  let candidates: any[] = []
  const userApiIds = new Set<string>()

  // 读取当前用户的公开源状态覆盖（启用/禁用）以及私有源 ID 集合
  let userStates: Record<string, any> = {}
  if (clientUsername && clientUsername !== 'default') {
    const userPath = resolveInside(sourceRoot, clientUsername)
    const statesPath = path.join(userPath, 'states.json')
    const metaPath = path.join(userPath, 'sources.json')

    if (fs.existsSync(statesPath)) {
      try {
        userStates = JSON.parse(fs.readFileSync(statesPath, 'utf-8'))
      } catch (e) {}
    }
    // 预收集私有源 ID（用于屏蔽同名公开源）
    if (fs.existsSync(metaPath)) {
      try {
        const userSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        for (const s of userSources) userApiIds.add(s.id)
      } catch (e) {}
    }
  }

  // 按 loadedApis 收集所有可用候选源（权限过滤，不强制任何顺序）
  for (const [apiId, api] of loadedApis) {
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

  // === 实时按 order.json 对候选列表排序 ===
  // 不依赖 loadedApis 的 Map 插入顺序（部分 reload 后顺序会乱），
  // 每次解析都直接读 order.json，无需重启服务器即可生效
  if (candidates.length > 1) {
    const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
    let orderData: string[] = []

    // 优先读用户自己的排序（admin/order.json），再回退到公开源排序（_open/order.json）
    const orderCandidates =
      clientUsername && clientUsername !== 'default'
        ? [resolveInside(sourceRoot, clientUsername, 'order.json'), resolveInside(sourceRoot, '_open', 'order.json')]
        : [resolveInside(sourceRoot, '_open', 'order.json')]

    for (const orderPath of orderCandidates) {
      if (fs.existsSync(orderPath)) {
        try {
          orderData = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
          if (orderData.length > 0) break
        } catch (e) {}
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
      try {
        console.log(
          `[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (第 ${i + 1}/${maxRetries} 次, Owner: ${api.info.owner})`,
        )

        const url = await api.callRequest('musicUrl', source, {
          musicInfo: normalizedSongInfo,
          quality: quality,
          type: quality,
        })

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
        // 如果不是最后一次尝试，等待一小会儿
        if (i < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
  } else {
    // 多个源，轮流尝试
    for (const api of candidates) {
      try {
        console.log(`[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (Owner: ${api.info.owner})`)

        const url = await api.callRequest('musicUrl', source, {
          musicInfo: normalizedSongInfo,
          quality: quality,
          type: quality,
        })

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
  for (const [apiId, api] of loadedApis) {
    if (!api.info.enabled || !api.info.sources || !api.info.sources[source]) {
      continue
    }

    // 权限检查
    if (api.info.owner === 'open' || (clientUsername && api.info.owner === clientUsername)) {
      return true
    }
  }
  return false
}
