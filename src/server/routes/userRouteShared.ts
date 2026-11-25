import type { HttpContext } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import { assertSafePathSegment } from '@/utils/pathSecurity'

let accountChangeInProgress = false

export const beginAccountChange = (): void => {
  accountChangeInProgress = true
}

export const endAccountChange = (): void => {
  accountChangeInProgress = false
}

export const isAccountChangeInProgress = (): boolean => accountChangeInProgress

export const MAX_USER_SETTING_BODY_BYTES = 2 * 1024 * 1024

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** 辅助获取请求的目标用户空间名称 */
export const resolveTargetUsername = (ctx: HttpContext, _requireAuth = true): string | null => {
  const config = (global.lx?.config ?? {}) as any
  const reqUsername = ctx.query.get('user') || ''
  const isAdmin = verifyAdminAuth(ctx.request)
  const tokenUser = verifyUserAuth(ctx)

  const canAccessOpen =
    config['user.enablePublicFavorites'] && (config['user.enablePublicNonAdminAccess'] || isAdmin || !!tokenUser)

  if (reqUsername === 'default' || reqUsername === 'open' || reqUsername === '_open') {
    if (canAccessOpen) return '_open'
    return null
  }

  if (!reqUsername) return tokenUser || (canAccessOpen ? '_open' : null)
  if (isAdmin) {
    try {
      return assertSafePathSegment(reqUsername, 'user name')
    } catch {
      return null
    }
  }
  return tokenUser && tokenUser === reqUsername ? tokenUser : null
}

export const rejectUnavailableDataWrite = (ctx: HttpContext, username: string): Response | null => {
  if (isAccountChangeInProgress()) return ctx.fail(409, '账户数据正在迁移或删除，请稍后重试')
  if (username === '_open') return null
  if (global.lx.config.users.some(user => user.name === username)) return null
  return ctx.fail(409, '账户已变更，请刷新页面后重试')
}
