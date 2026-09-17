import path from 'node:path'
import fs from 'node:fs'
import { Router, type HttpContext } from '../core'
import { checkPlayerAuthSession } from '../auth'
import { resolveInsideAsync } from '@/utils/pathSecurity'

/** 防目录穿越检查：确保目标路径在安全根目录内 */
export const isPathInside = (child: string, parent: string): boolean => {
  const resolvedParent = path.resolve(parent)
  const resolvedChild = path.resolve(child)
  if (resolvedChild === resolvedParent) return true
  const withSep = resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep
  return resolvedChild.startsWith(withSep)
}

/** 静态目录只允许发布前端资产，禁止数据库、配置、日志和隐藏文件外泄。 */
const isSensitiveStaticPath = (staticRoot: string, filePath: string): boolean => {
  const relative = path.relative(staticRoot, filePath).replaceAll('\\', '/')
  if (!relative || relative.startsWith('../') || relative === '..') return true
  if (relative.split('/').some(part => part.startsWith('.'))) return true
  return /(?:^|\/)(?:config\.js|.*\.(?:db(?:[-.].*)?|sqlite(?:3)?|wal|shm|log|key|pem))$/i.test(relative)
}

/** 基于 Bun.file 原生零拷贝分发静态文件 */
export const serveStaticFile = async (ctx: HttpContext, filePath: string): Promise<Response | null> => {
  const staticRoot = global.lx?.staticPath ?? path.join(process.cwd(), 'public')
  let safeFilePath: string
  try { safeFilePath = await resolveInsideAsync(staticRoot, filePath) } catch { return ctx.fail(403, '没有权限执行该操作') }
  if (isSensitiveStaticPath(staticRoot, safeFilePath)) return ctx.fail(404, '资源不存在')

  let stats: fs.Stats
  try {
    stats = await fs.promises.stat(safeFilePath)
  } catch {
    return null
  }
  if (!stats.isFile()) return null

  const bunFile = Bun.file(safeFilePath)
  const size = stats.size
  // BunFile.lastModified is millisecond precision truncated to an integer;
  // retain that format so existing validators remain stable.
  const mtime = Math.trunc(stats.mtimeMs)
  const etag = `W/"${size}-${mtime}"`
  const lastModified = new Date(mtime).toUTCString()
  const normalizedPath = safeFilePath.replaceAll('\\', '/')
  const isImmutableAsset = /(?:^|\/)(?:chunks\/)?[^/]*-[a-z0-9]{8,}\.[a-z0-9]+$/i.test(normalizedPath)
  const cacheControl = isImmutableAsset
    ? 'public, max-age=31536000, immutable'
    : 'no-cache, no-store, must-revalidate'
  const responseHeaders = {
    'Content-Type': bunFile.type || 'application/octet-stream',
    'Content-Length': String(size),
    'ETag': etag,
    'Last-Modified': lastModified,
    'Cache-Control': cacheControl,
    ...(isImmutableAsset ? {} : { Pragma: 'no-cache', Expires: '0' }),
  }

  // 304 缓存协商
  const ifNoneMatch = ctx.headers.get('if-none-match')
  const ifModifiedSince = ctx.headers.get('if-modified-since')
  if (ifNoneMatch === etag || (ifModifiedSince && ifModifiedSince === lastModified)) {
    return new Response(null, { status: 304, headers: responseHeaders })
  }

  if (ctx.method === 'HEAD') return new Response(null, { status: 200, headers: responseHeaders })

  return new Response(bunFile, {
    status: 200,
    headers: responseHeaders,
  })
}

/** 创建静态文件与前端托管路由 */
export const createStaticRouter = (): Router => {
  const router = new Router()

  // 1. 动态前端运行时配置注入 (/js/config.js)
  router.get('/js/config.js', async (ctx) => {
    const staticRoot = global.lx?.staticPath ?? path.join(process.cwd(), 'public')
    const staticConfigPath = path.join(staticRoot, 'js', 'config.js')
    let version = 'v2.0.0'
    let buildHash = 'unknown'
    try {
      const staticConfigFile = Bun.file(staticConfigPath)
      if (await staticConfigFile.exists()) {
        const content = await staticConfigFile.text()
        const matchVersion = content.match(/version:\s*['"]([^'"]+)['"]/)
        if (matchVersion) version = matchVersion[1]
        const matchHash = content.match(/buildHash:\s*['"]([^'"]+)['"]/)
        if (matchHash) buildHash = matchHash[1]
      }
    } catch { }

    const config = (global.lx?.config ?? {}) as any
    const frontendConfig = {
      version,
      buildHash,
      serverName: config.serverName,
      disableTelemetry: config.disableTelemetry || false,
      'proxy.enabled': config['proxy.enabled'],
      'user.enablePath': config['user.enablePath'],
      'user.enableRoot': config['user.enableRoot'],
      'user.enablePublicRestriction': config['user.enablePublicRestriction'] || false,
      'user.enableLoginCacheRestriction': config['user.enableLoginCacheRestriction'] || false,
      'user.enableCacheSizeLimit': config['user.enableCacheSizeLimit'] || false,
      'user.cacheSizeLimit': config['user.cacheSizeLimit'] || 2000,
      maxSnapshotNum: config.maxSnapshotNum,
      'list.addMusicLocationType': config['list.addMusicLocationType'],
      'player.enableAuth': config['player.enableAuth'] || false,
      port: config.port,
      bindIP: config.bindIP,
      'admin.path': config['admin.path'] ?? '',
      'player.path': config['player.path'] ?? '/music',
    }

    const configJs = `window.CONFIG = ${JSON.stringify(frontendConfig, null, 2)};`
    return new Response(configJs, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    })
  })

  // 2. 通用静态资源分发与管理后台 / 播放器路径路由处理器
  router.all('/*', async (ctx) => {
    // 忽略 API 请求，交由后续 API 路由处理
    if (ctx.pathname.startsWith('/api/') || ctx.pathname.startsWith('/rest/')) {
      return null
    }

    const config = (global.lx?.config ?? {}) as any
    const staticRoot = global.lx?.staticPath ?? path.join(process.cwd(), 'public')
    const playerPath = config['player.path'] ?? '/music'
    const adminPath = config['admin.path'] ?? ''

    // (A) 管理后台路径映射
    const effectiveAdminPath = adminPath || '/'
    const isAdminRequest = (ctx.pathname === effectiveAdminPath ||
      ctx.pathname === `${effectiveAdminPath}/` ||
      ctx.pathname === `${effectiveAdminPath}/index.html` ||
      (effectiveAdminPath !== '/' && (ctx.pathname.startsWith(`${effectiveAdminPath}/`) || ctx.pathname === effectiveAdminPath)))

    if (isAdminRequest) {
      if (effectiveAdminPath !== '/' && ctx.pathname === effectiveAdminPath) {
        return ctx.redirect(`${ctx.pathname}/`, 301)
      }
      const subPath = effectiveAdminPath === '/' ? ctx.pathname : ctx.pathname.slice(effectiveAdminPath.length)
      const targetRel = (subPath === '/' || subPath === '' || subPath === '/index.html' || subPath === 'index.html')
        ? 'index.html'
        : (subPath.startsWith('/') ? subPath.slice(1) : subPath)
      const filePath = path.join(staticRoot, targetRel)
      const res = await serveStaticFile(ctx, filePath)
      if (res) return res
    }

    // (B) Web 网页播放器映射
    const isPlayerRequest = (playerPath === '/' || playerPath === '')
      ? (ctx.pathname === '/' || (adminPath === '' || (ctx.pathname !== adminPath && !ctx.pathname.startsWith(`${adminPath}/`))))
      : (ctx.pathname.startsWith(`${playerPath}/`) || ctx.pathname === playerPath)

    const isLegacyPlayerAsset = playerPath !== '/music' && (
      ctx.pathname.startsWith('/music/assets/') ||
      ctx.pathname.startsWith('/music/css/') ||
      ctx.pathname.startsWith('/music/js/') ||
      ctx.pathname.startsWith('/music/fonts/') ||
      ctx.pathname.startsWith('/music/img/') ||
      ctx.pathname === '/music/manifest.json' ||
      ctx.pathname === '/music/sw.js'
    )

    if (isPlayerRequest || isLegacyPlayerAsset) {
      const activePrefix = isPlayerRequest ? playerPath : '/music'
      const normalizedPrefix = (activePrefix === '/' || activePrefix === '') ? '' : activePrefix.replace(/\/+$/, '')

      const isLoginPage = ctx.pathname === `${normalizedPrefix}/login` || ctx.pathname === `${normalizedPrefix}/login.html`
      const isPublicAsset = ctx.pathname.startsWith(`${normalizedPrefix}/assets/`) ||
        ctx.pathname.startsWith(`${normalizedPrefix}/css/`) ||
        ctx.pathname.startsWith(`${normalizedPrefix}/js/`) ||
        ctx.pathname.startsWith(`${normalizedPrefix}/fonts/`) ||
        ctx.pathname.startsWith(`${normalizedPrefix}/img/`) ||
        ctx.pathname === `${normalizedPrefix}/manifest.json` ||
        ctx.pathname === `${normalizedPrefix}/sw.js` ||
        isLegacyPlayerAsset

      // 播放器鉴权检查
      if (!isLoginPage && !isPublicAsset && config['player.enableAuth']) {
        if (!checkPlayerAuthSession(ctx.cookies)) {
          return ctx.redirect(`${normalizedPrefix}/login`, 302)
        }
      }

      if (ctx.pathname === activePrefix && activePrefix !== '/') {
        return ctx.redirect(`${ctx.pathname}/`, 301)
      }

      const subPath = ctx.pathname.slice(normalizedPrefix.length)
      let targetPath = ''
      if (subPath === '/' || subPath === '') {
        targetPath = 'music/index.html'
      } else if (isLoginPage) {
        targetPath = 'music/login.html'
      } else {
        if ((activePrefix === '/' || activePrefix === '') && subPath.startsWith('/music/')) {
          targetPath = subPath.slice(1)
        } else {
          targetPath = path.posix.join('music', subPath.startsWith('/') ? subPath.slice(1) : subPath)
        }
      }

      const filePath = path.join(staticRoot, targetPath)
      const res = await serveStaticFile(ctx, filePath)
      if (res) return res
    }

    // (C) 默认根静态文件回退 (例如 favicon.ico)
    const generalFilePath = path.join(staticRoot, ctx.pathname.startsWith('/') ? ctx.pathname.slice(1) : ctx.pathname)
    const res = await serveStaticFile(ctx, generalFilePath)
    if (res) return res

    return ctx.fail(404, '资源不存在')
  })

  return router
}
