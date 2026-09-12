import crypto from 'node:crypto'
import { Router, type HttpContext } from '../core'
import {
  verifyAdminAuth,
  createAdminSession,
  removeAdminSession,
  ADMIN_SESSION_COOKIE_NAME,
  checkPlayerAuthSession,
  createPlayerSession,
  removePlayerSession,
  SESSION_COOKIE_NAME,
  PLAYER_SESSION_TTL,
  USER_SESSION_COOKIE_NAME,
  USER_SESSION_TTL,
  clearLoginFailures,
  isLoginRateLimited,
  recordLoginFailure,
  safeStringEqual,
  getCookieValue,
  type HeaderSource,
} from '../auth'
import { loginLog } from '@/utils/log4js'
import { getDb } from '@/database'
import { verifyUserPassword } from '@/user/data'

/** Web 用户会话只允许通过 HttpOnly Cookie 使用。 */
export const userSessions = new Map<string, { username: string; createdAt: number }>()
const MAX_USER_SESSIONS = 10_000

const hashUserSession = (sessionId: string): string => crypto.createHash('sha256').update(sessionId).digest('hex')

const deletePersistedUserSession = (sessionId: string): void => {
  getDb().run('DELETE FROM user_sessions WHERE session_hash = ?', [hashUserSession(sessionId)])
}

const pruneUserSessions = (now = Date.now()): void => {
  for (const [sessionId, session] of userSessions) {
    if (now - session.createdAt > USER_SESSION_TTL || !isActiveUser(session.username)) {
      userSessions.delete(sessionId)
      deletePersistedUserSession(sessionId)
    }
  }
  getDb().run('DELETE FROM user_sessions WHERE created_at <= ?', [now - USER_SESSION_TTL])
  while (userSessions.size > MAX_USER_SESSIONS) userSessions.delete(userSessions.keys().next().value!)
}

const issueUserSession = (username: string): string => {
  pruneUserSessions()
  const sessionId = crypto.randomBytes(32).toString('hex')
  const createdAt = Date.now()
  userSessions.set(sessionId, { username, createdAt })
  getDb().run(
    'INSERT OR REPLACE INTO user_sessions (session_hash, user_name, created_at) VALUES (?, ?, ?)',
    [hashUserSession(sessionId), username, createdAt]
  )
  return sessionId
}

const isActiveUser = (username: string): boolean => global.lx.config.users.some(user => user.name === username)

/** 撤销某个用户的全部浏览器会话。 */
export const revokeUserAuth = (username: string): void => {
  getDb().run('DELETE FROM user_sessions WHERE user_name = ?', [username])
  for (const [sessionId, session] of userSessions) {
    if (session.username === username) userSessions.delete(sessionId)
  }
}

/** 验证 Web 用户的 HttpOnly 会话，不再接受密码、Token 或用户名请求头。 */
export const verifyUserAuth = (ctx: HttpContext | HeaderSource): string | null => {
  pruneUserSessions()
  const sessionId = getCookieValue(ctx, USER_SESSION_COOKIE_NAME)
  if (!sessionId) return null

  const cached = userSessions.get(sessionId)
  if (cached && Date.now() - cached.createdAt <= USER_SESSION_TTL) {
    return isActiveUser(cached.username) ? cached.username : null
  }

  if (cached) {
    userSessions.delete(sessionId)
    deletePersistedUserSession(sessionId)
  }

  const persisted = getDb().query<{ user_name: string; created_at: number }, [string]>(
    'SELECT user_name, created_at FROM user_sessions WHERE session_hash = ?'
  ).get(hashUserSession(sessionId))
  if (!persisted || Date.now() - persisted.created_at > USER_SESSION_TTL || !isActiveUser(persisted.user_name)) {
    deletePersistedUserSession(sessionId)
    return null
  }
  userSessions.set(sessionId, { username: persisted.user_name, createdAt: persisted.created_at })
  return persisted.user_name
}

const cookie = (name: string, value: string, maxAge: number, secure: boolean): string => (
  `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
)

const loginRateLimitedResponse = (ctx: HttpContext): Response => ctx.fail(429, '登录失败次数过多，已暂时限制登录，请 15 分钟后再试', {
  retryAfter: 15 * 60,
})

const configuredUsers = (): LX.Config['users'] => global.lx.config.users ?? []

/** 注册 Web 播放器、后台和 Web 用户认证路由。 */
export const createAuthRouter = (): Router => {
  const router = new Router()

  router.get('/api/music/config', (ctx) => {
    const config = global.lx.config
    return ctx.json({
      'player.enableAuth': config['player.enableAuth'] || false,
      'user.enablePublicRestriction': config['user.enablePublicRestriction'] || false,
      'user.enablePublicFavorites': config['user.enablePublicFavorites'] || false,
      'user.enablePublicNonAdminAccess': config['user.enablePublicNonAdminAccess'] || false,
      'user.enablePublicNonAdminLocalMusic': config['user.enablePublicNonAdminLocalMusic'] || false,
    }, 200, { 'Cache-Control': 'no-cache' })
  })

  router.post('/api/admin/verify', async (ctx) => {
    try {
      const ip = ctx.remoteAddress || 'unknown'
      if (isLoginRateLimited(ip)) return loginRateLimitedResponse(ctx)
      const { password } = await ctx.bodyJson<{ password?: string }>()
      if (!safeStringEqual(password, global.lx.config['frontend.password'])) {
        recordLoginFailure(ip)
        loginLog.warn(`Admin login failed from ${ctx.remoteAddress}`)
        return ctx.fail(401, '管理员密码错误')
      }
      clearLoginFailures(ip)
      const sessionId = createAdminSession()
      loginLog.info(`Admin login success from ${ctx.remoteAddress}`)
      return ctx.json({ success: true }, 200, { 'Set-Cookie': cookie(ADMIN_SESSION_COOKIE_NAME, sessionId, 8 * 60 * 60, ctx.isSecure) })
    } catch {
      return ctx.fail(400, '请求格式错误，请刷新页面后重试')
    }
  })

  router.post('/api/login', async (ctx) => {
    try {
      const ip = ctx.remoteAddress || 'unknown'
      if (isLoginRateLimited(ip)) return loginRateLimitedResponse(ctx)
      const { password } = await ctx.bodyJson<{ password?: string }>()
      if (!safeStringEqual(password, global.lx.config['frontend.password'])) {
        recordLoginFailure(ip)
        loginLog.warn(`Admin login failed from ${ctx.remoteAddress}`)
        return ctx.fail(401, '管理员密码错误')
      }
      clearLoginFailures(ip)
      const sessionId = createAdminSession()
      loginLog.info(`Admin login success from ${ctx.remoteAddress}`)
      return ctx.json({ success: true }, 200, { 'Set-Cookie': cookie(ADMIN_SESSION_COOKIE_NAME, sessionId, 8 * 60 * 60, ctx.isSecure) })
    } catch {
      return ctx.fail(400, '请求格式错误，请刷新页面后重试')
    }
  })

  router.post('/api/logout', (ctx) => {
    const sessionId = ctx.cookies[ADMIN_SESSION_COOKIE_NAME]
    if (sessionId) removeAdminSession(sessionId)
    return ctx.json({ success: true }, 200, { 'Set-Cookie': cookie(ADMIN_SESSION_COOKIE_NAME, '', 0, ctx.isSecure) })
  })

  router.post('/api/user/login', async (ctx) => {
    try {
      const ip = ctx.remoteAddress || 'unknown'
      if (isLoginRateLimited(ip)) return loginRateLimitedResponse(ctx)
      const { username, password } = await ctx.bodyJson<{ username?: string; password?: string }>()
      const user = configuredUsers().find(item => {
        if (item.name !== username) return false
        const row = getDb().query<{ password_hash: string }, [string]>('SELECT password_hash FROM users WHERE name = ?').get(item.name)
        return verifyUserPassword(row?.password_hash || item.passwordHash, password)
      })
      if (!user) {
        recordLoginFailure(ip)
        loginLog.warn(`User login failed: ${username || '[unknown]'} from ${ctx.remoteAddress}`)
        return ctx.fail(401, '用户名或密码错误')
      }
      clearLoginFailures(ip)
      const sessionId = issueUserSession(user.name)
      loginLog.info(`User login success: ${user.name} from ${ctx.remoteAddress}`)
      return ctx.json({ success: true, username: user.name }, 200, { 'Set-Cookie': cookie(USER_SESSION_COOKIE_NAME, sessionId, USER_SESSION_TTL / 1000, ctx.isSecure) })
    } catch {
      return ctx.fail(400, '请求格式错误，请刷新页面后重试')
    }
  })

  router.post('/api/user/logout', (ctx) => {
    const sessionId = ctx.cookies[USER_SESSION_COOKIE_NAME]
    if (sessionId) {
      userSessions.delete(sessionId)
      deletePersistedUserSession(sessionId)
    }
    return ctx.json({ success: true }, 200, { 'Set-Cookie': cookie(USER_SESSION_COOKIE_NAME, '', 0, ctx.isSecure) })
  })

  router.get('/api/music/auth/verify', (ctx) => ctx.json({ valid: checkPlayerAuthSession(ctx.cookies) }))

  router.post('/api/music/auth', async (ctx) => {
    try {
      const ip = ctx.remoteAddress || 'unknown'
      if (isLoginRateLimited(ip)) return loginRateLimitedResponse(ctx)
      const { password } = await ctx.bodyJson<{ password?: string }>()
      const configuredPassword = global.lx.config['player.password']
      if (!safeStringEqual(password, configuredPassword)) {
        recordLoginFailure(ip)
        loginLog.warn(`Player login failed from ${ctx.remoteAddress}`)
        return ctx.fail(401, '播放器密码错误，请重新输入')
      }
      clearLoginFailures(ip)
      const sessionId = createPlayerSession()
      loginLog.info(`Player login success from ${ctx.remoteAddress}`)
      return ctx.json({ success: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE_NAME, sessionId, PLAYER_SESSION_TTL / 1000, ctx.isSecure) })
    } catch {
      return ctx.fail(400, '请求格式错误，请刷新页面后重试')
    }
  })

  router.post('/api/music/auth/logout', (ctx) => {
    const sessionId = ctx.cookies[SESSION_COOKIE_NAME]
    if (sessionId) removePlayerSession(sessionId)
    return ctx.json({ success: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE_NAME, '', 0, ctx.isSecure) })
  })

  router.get('/api/user/auth/verify', (ctx) => {
    const username = verifyUserAuth(ctx)
    return ctx.json({ valid: Boolean(username), username })
  })

  return router
}
