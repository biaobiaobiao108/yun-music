import { Router, corsMiddleware, securityHeadersMiddleware, accessLogMiddleware, compressionMiddleware, type Middleware } from '../core'
import { verifyAdminAuth, checkPlayerAuthSession } from '../auth'
import { createAuthRouter } from './auth'
import { createSystemRouter } from './system'
import { createUserRouter } from './user'
import { createCustomSourceRouter } from './customSource'
import { createMusicRouter } from './music'
import { createCacheRouter } from './cache'
import { createStaticRouter } from './static'
import { getDb } from '@/database'

/** 播放器鉴权豁免：登录态自身的接口必须在未登录时也可访问 */
const PLAYER_AUTH_EXEMPT_PATHS = new Set([
  '/api/music/config',
  '/api/music/auth',
  '/api/music/auth/verify',
  '/api/music/auth/logout',
])

/**
 * 播放器访问密码保护中间件。
 * 仅开启 player.enableAuth 时生效，覆盖整个 /api/music/* 数据接口，
 * 避免出现「页面被密码挡住、接口仍可匿名调用」的情况。
 * 管理员会话 Cookie 始终放行。
 */
const playerApiAuthMiddleware: Middleware = async (ctx, next) => {
  if (!global.lx?.config?.['player.enableAuth']) return next()
  if (PLAYER_AUTH_EXEMPT_PATHS.has(ctx.pathname)) return next()
  if (checkPlayerAuthSession(ctx.cookies)) return next()
  if (verifyAdminAuth(ctx.request)) return next()
  return ctx.fail(401, '播放器登录状态已失效，请重新登录')
}

/**
 * 组装所有业务领域子路由，生成顶级全局路由器
 */
export const createRootRouter = (): Router => {
  const root = new Router()

  root.get('/healthz', (ctx) => ctx.json({ status: 'ok', requestId: ctx.requestId }))
  root.get('/readyz', (ctx) => {
    try {
      getDb().query('SELECT 1').get()
      return ctx.json({ status: 'ready', requestId: ctx.requestId })
    } catch {
      return ctx.json({ status: 'not_ready', requestId: ctx.requestId }, 503)
    }
  })

  // 已移除协议明确返回 410，避免旧客户端将 SPA fallback 误判为服务仍可用。
  for (const path of ['/hello/*', '/id/*', '/ah/*', '/rest/*', '/api/webdav/*']) {
    root.all(path, (ctx) => ctx.fail(410, '该外部协议已移除'))
  }

  // 全局中间件
  root.use(securityHeadersMiddleware)
  root.use(corsMiddleware)
  root.use(accessLogMiddleware)
  root.use(compressionMiddleware)

  // 1. Web 业务领域路由挂载
  root.mount('/', createAuthRouter())
  root.mount('/', createSystemRouter())
  root.mount('/', createUserRouter())
  root.mount('/', createCustomSourceRouter())
  root.mount('/', createMusicRouter())
  root.mount('/', createCacheRouter())

  // 2. 播放器数据接口鉴权
  root.use('/api/music', playerApiAuthMiddleware)

  // 3. 静态资源与前端托管（必须挂在最后，作为兜底匹配）
  root.mount('/', createStaticRouter())

  return root
}
