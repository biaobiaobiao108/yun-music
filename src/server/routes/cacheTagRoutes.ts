import fs from 'node:fs'
import path from 'node:path'
import { Router } from '../core'
import { toUserMessage } from '../core/context'
import { getMusicTagNative } from '../musicTagNative'
import { identifyLocalSong } from '../utils/identify'
import * as fileCache from '../fileCache'
import { getCacheRequestUsername, resolveCacheTarget } from './cacheRouteShared'

export const createCacheTagRouter = (): Router => {
  const router = new Router()

  router.post('/api/music/cache/updateMetadata', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filenames } = await ctx.bodyJson<{ filenames?: string[] | string }>()
      if (!filenames) return ctx.fail(400, '缺少必要参数：filenames')
      const fileList = Array.isArray(filenames) ? filenames : [filenames]
      if (fileList.length > 500) return ctx.fail(400, '单次最多处理 500 个文件')
      const result = await fileCache.batchUpdateMetadata(fileList, target.username)
      return ctx.json({ success: true, ...result })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '更新歌曲元数据失败，请稍后重试'))
    }
  })

  router.post('/api/music/cache/embedLyric', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error
    const username = target.username

    try {
      const { filenames } = await ctx.bodyJson<{ filenames?: string[] }>()
      if (!filenames || !Array.isArray(filenames)) throw new Error('Missing filenames')
      if (filenames.length > 500) throw new Error('Too many files')

      let successCount = 0
      let skippedCount = 0
      let failCount = 0
      const details: any[] = []

      for (const filename of filenames) {
        let filePath = ''
        let folder: 'cache' | 'music' = 'cache'
        let location = fileCache.getCacheLocation()

        search: for (const candidateLocation of fileCache.getCacheLocations()) {
          for (const f of ['cache', 'music'] as const) {
            const dir = fileCache.getCacheDir(username, f === 'music', candidateLocation)
            const candidate = fileCache.resolveCacheRelativePath(dir, filename)
            if (!candidate) continue
            if (fs.existsSync(candidate)) {
              filePath = candidate
              folder = f
              location = candidateLocation
              break search
            }
          }
        }

        if (!filePath) {
          details.push({ filename, status: 'fail', reason: '文件不存在' })
          failCount++
          continue
        }

        try {
          const indexItem = fileCache.getIndexItemByFilename(filename, username, location) as any
          if (indexItem?.metadataWritable === false) {
            details.push({
              filename,
              status: 'fail',
              reason:
                indexItem.embedLyricError ||
                indexItem.metadataError ||
                '当前音频容器不支持嵌入歌词，外置歌词文件仍可正常使用',
            })
            failCount++
            continue
          }

          let existingLyrics = ''
          try {
            existingLyrics = await fileCache.withCachePostProcess(undefined, 'check existing lyrics', async () => {
              let checkTagger: any
              try {
                checkTagger = new (getMusicTagNative().MusicTagger)()
                checkTagger.loadPath(filePath)
                return checkTagger.lyrics || ''
              } finally {
                try {
                  if (checkTagger) checkTagger.dispose()
                } catch {}
              }
            })
          } catch (checkError: any) {
            const unsupportedStatus = fileCache.getAudioMetadataUnsupportedStatus(filePath)
            fileCache.setIndexEmbedLyric(
              filename,
              username,
              false,
              {
                audioContainer: unsupportedStatus.audioContainer,
                metadataWritable: false,
                metadataError: unsupportedStatus.error,
                embedLyricError: unsupportedStatus.error,
              },
              location,
            )
            details.push({
              filename,
              status: 'fail',
              reason: unsupportedStatus.error || '当前音频容器不支持嵌入歌词，外置歌词文件仍可正常使用',
            })
            failCount++
            continue
          }

          if (existingLyrics && existingLyrics.trim().length > 10) {
            details.push({ filename, status: 'skipped', reason: '已有歌词标签' })
            skippedCount++
            continue
          }

          const songInfo = indexItem
          const ext = path.extname(filename)
          const baseName = filename.slice(0, filename.length - ext.length)
          const lrcFilename = baseName + '.lrc'
          const dir = fileCache.getCacheDir(username, folder === 'music', location)
          const lrcPath = fileCache.resolveCacheRelativePath(dir, lrcFilename)

          let lyricText: string | null = null

          if (lrcPath && fs.existsSync(lrcPath)) {
            lyricText = fs.readFileSync(lrcPath, 'utf8')
            console.log(`[EmbedLyric] Using local .lrc for: ${filename}`)
          } else if (songInfo && songInfo.source && songInfo.source !== 'unknown') {
            const lyricFetcherFn = fileCache.getLyricFetcher()
            if (lyricFetcherFn) {
              lyricText = await lyricFetcherFn(songInfo)
            }
            if (lyricText) {
              console.log(`[EmbedLyric] Fetched lyric from SDK for: ${filename}`)
            }
          }

          if (!lyricText) {
            details.push({ filename, status: 'fail', reason: '无法获取歌词' })
            failCount++
            continue
          }

          const embedResult = await fileCache.withCachePostProcess(undefined, 'embed lyric file', async () => {
            return fileCache.embedLyricsIntoFile(filePath, lyricText)
          })
          fileCache.setIndexEmbedLyric(
            filename,
            username,
            embedResult.hasEmbedLyric,
            {
              audioContainer: embedResult.audioContainer,
              metadataWritable: embedResult.metadataWritable,
              metadataError: embedResult.metadataWritable ? undefined : embedResult.error,
              embedLyricError: embedResult.error,
            },
            location,
          )
          if (!embedResult.success) {
            details.push({
              filename,
              status: 'fail',
              reason: embedResult.error || '歌词标签写入后校验失败，外置歌词文件仍可正常使用',
            })
            failCount++
            continue
          }

          details.push({ filename, status: 'success' })
          successCount++
          console.log(`[EmbedLyric] Embedded lyric for: ${filename}`)
        } catch (itemErr: any) {
          details.push({ filename, status: 'fail', reason: itemErr.message || '未知错误' })
          failCount++
        }
      }

      return ctx.json({ success: true, successCount, skippedCount, failCount, details })
    } catch (e: any) {
      return ctx.fail(400, toUserMessage(e, '请求参数不合法'))
    }
  })

  router.post('/api/music/cache/link', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filename, songInfo, location } = await ctx.bodyJson<{
        filename?: string
        songInfo?: any
        location?: string
      }>()
      if (!filename || !songInfo) return ctx.fail(400, '缺少必要参数：filename、songInfo')
      const result = await fileCache.linkLocalFile(filename, songInfo, target.username, location)
      return ctx.json(result)
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '关联本地文件失败，请稍后重试'))
    }
  })

  router.post('/api/music/identify', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { filename, folder, location } = await ctx.bodyJson<{
        filename?: string
        folder?: 'cache' | 'music'
        location?: string
      }>()
      if (!filename) return ctx.fail(400, '缺少必要参数：filename')
      if (location && !fileCache.getCacheLocations().includes(location)) throw new Error('缓存位置不合法')
      const paths = (location ? [location] : fileCache.getCacheLocations())
        .map(loc => {
          const dir = fileCache.getCacheDir(target.username, folder === 'music', loc)
          return fileCache.resolveCacheRelativePath(dir, filename)
        })
        .filter((candidate): candidate is string => !!candidate && fs.existsSync(candidate))
      const uniquePaths = [...new Set(paths)]
      if (uniquePaths.length === 0) throw new Error(`文件不存在：${filename}`)
      if (uniquePaths.length > 1) throw new Error('文件存在多个位置，请指定缓存位置')
      const filePath = uniquePaths[0]!
      const results = await identifyLocalSong(filePath)
      return ctx.json({ success: true, results })
    } catch (e: any) {
      return ctx.fail(500, toUserMessage(e, '识别歌曲失败，请稍后重试'))
    }
  })

  router.get('/api/music/cache/lyric', async ctx => {
    const source = ctx.query.get('source')
    const songmid = ctx.query.get('songmid') || ctx.query.get('songId') || ctx.query.get('id')
    const songId = ctx.query.get('songId') || ctx.query.get('id')

    const username = getCacheRequestUsername(ctx)
    if (!username) return ctx.fail(401, '登录状态已失效，请重新登录')

    if (!source || (!songmid && !songId)) return ctx.fail(400, '缺少必要参数：source、songmid')

    const name = ctx.query.get('name') || ''
    const singer = ctx.query.get('singer') || ''
    const result = await fileCache.checkLyricCache({ source, songmid, id: songId, name, singer }, username)
    if (result.exists) {
      return ctx.json({ success: true, data: result.content })
    }
    return ctx.fail(404, '缓存中未找到该内容')
  })

  router.post('/api/music/cache/lyric', async ctx => {
    const target = resolveCacheTarget(ctx, { publicWrite: true })
    if (!target.ok) return target.error

    try {
      const { songInfo, lyricsObj, enableOnlyDownloadMode } = await ctx.bodyJson<{
        songInfo?: any
        lyricsObj?: any
        enableOnlyDownloadMode?: boolean
      }>()
      const username = target.username

      if (!songInfo || !lyricsObj) return ctx.fail(400, '缺少必要参数')

      const success = fileCache.saveLyricCache(songInfo, lyricsObj, username, !!enableOnlyDownloadMode)
      return ctx.json({ success })
    } catch {
      return ctx.fail(500, '服务器内部错误，请稍后重试')
    }
  })

  return router
}
