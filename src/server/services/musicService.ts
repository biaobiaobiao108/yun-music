import fs from 'node:fs'
import path from 'node:path'
import musicSdk, { getBuiltinSource } from '@/modules/utils/musicSdk'
import { initUserApis } from '../userApi'
import * as fileCache from '../fileCache'
import * as serverDownloadQueue from '../serverDownloadQueue'
import { normalizeSongInfo, resolveServerSong } from './musicResolver'
import { getUserSpace } from '@/user'
import { File } from '@/constants'
import { buildLyrics } from '@/utils/lrcTool'
import { startupLog } from '@/utils/log4js'
import { getDb } from '@/database'

/**
 * 初始化服务端所有音乐子系统
 * 包括：SDK/自定义源、文件缓存设置、歌词嵌入钩子、持久化下载队列与重制队列
 */
export const initMusicServices = async (): Promise<void> => {
  // 1. 初始化文件缓存设置
  if (global.lx?.config) {
    if (global.lx.config.serverCacheLocation) {
      fileCache.setCacheLocation(global.lx.config.serverCacheLocation)
    }
    global.lx.config['cache.namingPattern'] = fileCache.setNamingPattern(global.lx.config['cache.namingPattern'])

    // SQLite is the source of truth for user settings. Apply the public
    // user's cache preferences before the initial index reconciliation so the
    // scan runs against the configured cache root.
    try {
      const db = getDb()
      let row = db.query<{ value: string }, [string, string]>(
        'SELECT value FROM user_settings WHERE user_name = ? AND key = ?',
      ).get('_open', 'settings')
      if (!row) {
        // One-time compatibility migration for installations that still have
        // the pre-SQLite settings file but no structured settings row yet.
        const legacyPath = path.join(getUserSpace('_open').dataManage.userDir, File.userSettingsJSON)
        if (fs.existsSync(legacyPath)) {
          const legacySettings = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
          db.run(
            'INSERT OR REPLACE INTO user_settings (user_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
            ['_open', 'settings', JSON.stringify(legacySettings), Date.now()],
          )
          row = { value: JSON.stringify(legacySettings) }
          startupLog.info('Migrated legacy _open settings.json to SQLite')
        }
      }
      if (row) {
        const savedSettings = JSON.parse(row.value) as Record<string, unknown>
        if (typeof savedSettings.serverCacheLocation === 'string') {
          fileCache.setCacheLocation(savedSettings.serverCacheLocation)
        }
        if (typeof savedSettings.serverCacheNamingPattern === 'string') {
          fileCache.setNamingPattern(savedSettings.serverCacheNamingPattern)
        }
      }
    } catch (err: any) {
      startupLog.warn('Failed to restore fileCache settings from SQLite:', err.message)
    }

    // 后台同步活跃用户的缓存索引
    if (global.lx.config.users) {
      for (const user of global.lx.config.users) {
        if (user.name) {
          void fileCache.syncCacheIndex(user.name)
        }
      }
    }
  }

  // 2. 注入歌词获取钩子：用于服务器缓存时自动嵌入 USLT 标签
  fileCache.setLyricFetcher(async (songInfo: any) => {
    try {
      const source = songInfo.source
      const sourceApi = source ? getBuiltinSource(source) : undefined
      if (!sourceApi?.getLyric) {
        return null
      }
      let songmid = String(songInfo.songmid || songInfo.id || songInfo.songId || '')
      const sourcePrefix = `${source}_`
      if (songmid.startsWith(sourcePrefix)) songmid = songmid.slice(sourcePrefix.length)
      if (!songmid) return null

      const requestObj = sourceApi.getLyric({
        songmid,
        name: songInfo.name || '',
        singer: songInfo.singer || '',
        hash: songInfo.hash || '',
        interval: songInfo.interval || '',
      })
      const result = await requestObj.promise
      if (!result) return null
      return typeof result === 'string' ? result : buildLyrics(result)
    } catch (e: any) {
      startupLog.warn(`[LyricFetcher] Failed for "${songInfo.name}":`, e.message || e)
      return null
    }
  })

  // 3. 初始化 Music SDK
  const proxyEnabled = global.lx?.config?.['proxy.all.enabled']
  const proxyAddress = global.lx?.config?.['proxy.all.address']
  startupLog.info(`Music SDK Proxy: ${proxyEnabled ? `Enabled (${proxyAddress})` : 'Disabled'}`)
  try {
    await musicSdk.init()
    startupLog.info('musicSdk initialized')
  } catch (err) {
    startupLog.error('musicSdk init failed:', err)
  }

  // 4. 初始化自定义用户源
  try {
    startupLog.info('Initializing custom user APIs...')
    await initUserApis()
    startupLog.info('Custom user APIs initialized')
  } catch (err: any) {
    startupLog.error('Failed to initialize user APIs:', err.message)
  }

  // 5. 绑定服务端后台下载队列解析器
  serverDownloadQueue.initialize(async (task) => {
    const songInfo = normalizeSongInfo(task.songInfo)
    const apiUsername = task.username === '_open' ? 'open' : task.username
    const resolved = await resolveServerSong(songInfo, task.requestedQuality, apiUsername, true)
    return {
      url: resolved.url,
      quality: resolved.quality,
      songInfo: resolved.songInfo,
      requestedSource: resolved.requestedSource,
      downloadSource: resolved.downloadSource,
      sourceName: resolved.sourceName,
    }
  })

}
