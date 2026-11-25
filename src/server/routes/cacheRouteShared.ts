import { NO_STORE_HEADERS, type HttpContext } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { canReadPublicLocalMusic } from '../localMusicAccess'

export const getCacheRequestUsername = (ctx: HttpContext): string | null => {
  const requested = ctx.query.get('user')?.trim() || ''
  const verified = verifyUserAuth(ctx)
  const isAdmin = verifyAdminAuth(ctx.request)
  const isPublicAlias = requested === 'default' || requested === 'open' || requested === '_open'
  // An omitted user means the current user's private storage. An explicit
  // public alias must remain public even when the browser also sends a
  // personal session cookie.
  if (!requested && verified) return verified
  if (!requested || isPublicAlias) {
    return canReadPublicLocalMusic(ctx, verified, isAdmin) ? '_open' : null
  }
  if (isAdmin) {
    try {
      return assertSafePathSegment(requested, 'user name')
    } catch {
      return null
    }
  }
  return verified === requested ? verified : null
}

export type CacheTargetResult = { ok: true; username: string } | { ok: false; error: Response }

/**
 * 解析缓存请求的目标用户空间。
 * 公共空间 (_open) 的破坏性写操作必须由管理员发起，
 * 否则任何匿名访客都能改写或清空多人共用的曲库。
 */
export const resolveCacheTarget = (ctx: HttpContext, options: { publicWrite?: boolean } = {}): CacheTargetResult => {
  const requested = ctx.query.get('user')?.trim() || ''
  const isPublicAlias = requested === 'default' || requested === 'open' || requested === '_open'
  const verified = verifyUserAuth(ctx)
  const isAdmin = verifyAdminAuth(ctx.request)

  // An omitted user means the authenticated user's private storage. An
  // explicit public alias means the shared _open storage, even when the
  // request also carries a personal session cookie.
  if (!requested && verified) return { ok: true, username: verified }

  if (!requested || isPublicAlias) {
    if (options.publicWrite && !isAdmin) {
      return { ok: false, error: ctx.fail(403, '权限不足：修改公共本地音乐库需要先验证管理员身份') }
    }
    return { ok: true, username: '_open' }
  }

  if (isAdmin) {
    try {
      return { ok: true, username: assertSafePathSegment(requested, 'user name') }
    } catch {
      return { ok: false, error: ctx.fail(400, '用户名不合法') }
    }
  }
  if (!verified) return { ok: false, error: ctx.fail(401, '登录状态已失效，请重新登录') }
  if (verified !== requested) return { ok: false, error: ctx.fail(403, '无权访问其他用户的本地音乐') }
  return { ok: true, username: verified }
}

export const noStoreFail = (ctx: HttpContext, status: number, message: string): Response =>
  ctx.fail(status, message, undefined, NO_STORE_HEADERS)
