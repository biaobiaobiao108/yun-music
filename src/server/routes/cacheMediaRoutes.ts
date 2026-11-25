import fs from 'node:fs'
import path from 'node:path'
import { Router } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as fileCache from '../fileCache'
import { resolveInsideAsync, assertSafePathSegment } from '@/utils/pathSecurity'
import { canReadPublicLocalMusic, isPublicLocalMusicAnonymous } from '../localMusicAccess'
import { noStoreFail } from './cacheRouteShared'

export const createCacheMediaRouter = (): Router => {
  const router = new Router()

  // 8. 分发缓存文件（基于 Bun.file 零拷贝高性能分发）
  router.get('/api/music/cache/file/*', async ctx => {
    const parts = ctx.pathname.replace('/api/music/cache/file/', '').split('/')
    let reqUsername = '_open'
    let filename = parts[0]
    try {
      if (parts.length > 1) {
        reqUsername = decodeURIComponent(parts[0])
        filename = parts.slice(1).join('/')
      }
    } catch {
      return ctx.fail(400, '文件路径不合法')
    }

    if (!filename) return ctx.fail(400, '缺少必要参数：filename')

    let username = '_open'
    const isPublic = !reqUsername || reqUsername === '_open' || reqUsername === 'default' || reqUsername === 'open'

    if (isPublic && !canReadPublicLocalMusic(ctx)) {
      return noStoreFail(ctx, 403, '您没有权限访问公共本地音乐，请联系管理员设置')
    }

    if (!isPublic) {
      const isAdmin = verifyAdminAuth(ctx.request)
      const tokenUser = verifyUserAuth(ctx)
      if (!isAdmin && !tokenUser) {
        return ctx.fail(401, '登录状态已失效，请重新登录')
      }
      if (!isAdmin && tokenUser !== reqUsername) {
        return ctx.fail(403, '无权访问其他用户的本地音乐')
      }
      username = reqUsername
    }

    let decodedFilename = filename
    try {
      decodedFilename = decodeURIComponent(filename)
    } catch {
      return ctx.fail(400, '文件路径不合法')
    }
    const normalizedUsername = username && username !== '_open' && username !== 'default' ? username : '_open'
    const requestedFolder = ctx.query.get('folder')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') {
      return ctx.fail(400, '目录类型不合法')
    }
    const requestedLocation = ctx.query.get('location')
    if (
      requestedLocation &&
      requestedLocation !== fileCache.CACHE_ROOTS.DATA &&
      requestedLocation !== fileCache.CACHE_ROOTS.ROOT
    ) {
      return ctx.fail(400, '缓存位置不合法')
    }
    const locations = requestedLocation
      ? [requestedLocation]
      : [
          fileCache.getCacheLocation(),
          fileCache.getCacheLocation() === fileCache.CACHE_ROOTS.DATA
            ? fileCache.CACHE_ROOTS.ROOT
            : fileCache.CACHE_ROOTS.DATA,
        ]
    const roots: Array<fileCache.CacheFolder> = requestedFolder
      ? [requestedFolder as fileCache.CacheFolder]
      : ['cache', 'music']
    const candidateUsernames =
      normalizedUsername !== '_open' && canReadPublicLocalMusic(ctx)
        ? [normalizedUsername, '_open']
        : [normalizedUsername]
    let filePath = ''
    let fileStats: fs.Stats | null = null

    for (const targetUser of candidateUsernames) {
      for (const loc of locations) {
        for (const folder of roots) {
          let dir: string
          try {
            dir = fileCache.getCacheDir(targetUser, folder === 'music', loc, false)
          } catch {
            return ctx.fail(400, '用户名不合法')
          }
          const safeFilename = decodedFilename.replace(/\\/g, '/')
          let checkPath: string
          try {
            checkPath = await resolveInsideAsync(dir, safeFilename)
          } catch {
            continue
          }
          try {
            fileStats = await fs.promises.stat(checkPath)
            filePath = checkPath
            break
          } catch {
            // The cache may disappear between index lookup and file delivery.
          }
        }
        if (filePath) break
      }
      if (filePath) break
    }

    if (!filePath || !fileStats || !fileStats.isFile() || fileStats.size <= 0) {
      return ctx.fail(404, '文件不存在')
    }

    const bunFile = Bun.file(filePath)
    const size = fileStats.size
    const mtime = fileStats.mtimeMs
    const etag = `"${size}-${mtime}"`
    const lastModified = new Date(mtime).toUTCString()

    const rangeHeader = ctx.headers.get('range')
    const ifRange = ctx.headers.get('if-range')
    const ifNoneMatch = ctx.headers.get('if-none-match')
    const ifModifiedSince = ctx.headers.get('if-modified-since')
    const cacheControl =
      normalizedUsername === '_open' && isPublicLocalMusicAnonymous() ? 'public, max-age=86400' : 'private, no-store'
    const unsatisfiableRangeResponse = () =>
      new Response(null, {
        status: 416,
        headers: {
          'Content-Range': `bytes */${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': '0',
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': cacheControl,
        },
      })
    // A media client may combine validators with a Range request. Return the
    // requested partial content in that case instead of a 304 response that
    // cannot satisfy the media element's byte-range demand.
    const isEtagMatch = (headerValue: string | null): boolean => {
      if (!headerValue) return false
      return headerValue.split(',').some(value => {
        const trimmed = value.trim()
        return trimmed === '*' || trimmed === etag || trimmed === `W/${etag}`
      })
    }
    if (!rangeHeader && (ifNoneMatch ? isEtagMatch(ifNoneMatch) : ifModifiedSince === lastModified)) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': cacheControl,
        },
      })
    }

    const ext = path.extname(filePath).toLowerCase()
    const inferredType =
      ext === '.flac'
        ? 'audio/flac'
        : ext === '.m4a'
          ? 'audio/mp4'
          : ext === '.wav'
            ? 'audio/wav'
            : ext === '.aac'
              ? 'audio/aac'
              : ext === '.mp3'
                ? 'audio/mpeg'
                : ext === '.ogg'
                  ? 'audio/ogg'
                  : ext === '.opus'
                    ? 'audio/opus'
                    : undefined
    const contentType =
      inferredType ||
      (bunFile.type === 'audio/x-flac'
        ? 'audio/flac'
        : bunFile.type === 'audio/x-m4a'
          ? 'audio/mp4'
          : bunFile.type === 'audio/x-wav'
            ? 'audio/wav'
            : bunFile.type === 'audio/x-aac'
              ? 'audio/aac'
              : bunFile.type || 'audio/mpeg')

    let ifRangeMismatch = false
    if (rangeHeader && ifRange) {
      const trimmed = ifRange.trim()
      if (trimmed.startsWith('"') || trimmed.startsWith('W/')) {
        ifRangeMismatch = trimmed !== etag
      } else {
        ifRangeMismatch = trimmed !== lastModified
      }
    }

    if (rangeHeader && !ifRangeMismatch) {
      const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/)
      if (match && (match[1] || match[2])) {
        let start: number
        let end: number

        if (!match[1]) {
          const suffixLength = Number.parseInt(match[2], 10)
          if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return unsatisfiableRangeResponse()
          }
          start = Math.max(0, size - suffixLength)
          end = size - 1
        } else {
          start = Number.parseInt(match[1], 10)
          end = match[2] ? Number.parseInt(match[2], 10) : size - 1
          if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
            return unsatisfiableRangeResponse()
          }
          end = Math.min(end, size - 1)
        }

        const chunk = bunFile.slice(start, end + 1)
        return new Response(chunk, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': contentType,
            'X-Accel-Buffering': 'no',
            ETag: etag,
            'Last-Modified': lastModified,
            'Cache-Control': cacheControl,
          },
        })
      }
    }

    return new Response(bunFile, {
      status: 200,
      headers: {
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'X-Accel-Buffering': 'no',
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
      },
    })
  })

  router.get('/api/music/cache/cover', async ctx => {
    const reqUsername = ctx.query.get('user') || ''
    const isPublicAlias = reqUsername === '_open' || reqUsername === 'default' || reqUsername === 'open'
    const verified = verifyUserAuth(ctx)
    const isAdmin = verifyAdminAuth(ctx.request)
    let username = verified || '_open'

    if (isPublicAlias) {
      username = '_open'
    } else if (reqUsername && isAdmin) {
      try {
        username = assertSafePathSegment(reqUsername, 'user name')
      } catch {
        return ctx.fail(400, '用户名不合法')
      }
    } else if (reqUsername && (!verified || verified !== reqUsername)) {
      return ctx.fail(401, '登录状态已失效，请重新登录')
    }

    if (username === '_open' && !canReadPublicLocalMusic(ctx, verified)) {
      return noStoreFail(ctx, 403, '您没有权限访问公共本地音乐，请联系管理员设置')
    }

    const filename = ctx.query.get('filename')
    if (!filename) return ctx.fail(400, '缺少必要参数：filename')
    const requestedFolder = ctx.query.get('folder')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') {
      return ctx.fail(400, '目录类型不合法')
    }

    const requestedLocation = ctx.query.get('location')
    if (
      requestedLocation &&
      requestedLocation !== fileCache.CACHE_ROOTS.DATA &&
      requestedLocation !== fileCache.CACHE_ROOTS.ROOT
    ) {
      return ctx.fail(400, '缓存位置不合法')
    }

    const folder = requestedFolder ? (requestedFolder as fileCache.CacheFolder) : undefined
    const cover = (await (requestedLocation
      ? fileCache.getCacheCover(filename, username, folder, requestedLocation)
      : folder
        ? fileCache.getCacheCover(filename, username, folder)
        : fileCache.getCacheCover(filename, username))) as any
    if (cover && cover.data) {
      return new Response(cover.data, {
        status: 200,
        headers: {
          'Content-Type': cover.mime || 'image/jpeg',
          'Cache-Control':
            username === '_open' && isPublicLocalMusicAnonymous() ? 'public, max-age=86400' : 'private, no-store',
        },
      })
    }
    return ctx.fail(404, '资源不存在')
  })

  return router
}
