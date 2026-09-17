import { verifyAdminAuth } from './auth'
import { type HttpContext } from './core'
import { verifyUserAuth } from './routes/auth'

/**
 * 判断请求是否可以读取公共本地音乐空间 (_open)。
 * 配置开启时允许匿名访问；否则仅允许已登录用户或管理员访问。
 */
export const canReadPublicLocalMusic = (
  ctx: HttpContext,
  verifiedUsername?: string | null,
  isAdmin?: boolean,
): boolean => {
  if (global.lx?.config?.['user.enablePublicNonAdminLocalMusic'] === true) return true
  const username = verifiedUsername === undefined ? verifyUserAuth(ctx) : verifiedUsername
  const admin = isAdmin === undefined ? verifyAdminAuth(ctx.request) : isAdmin
  return Boolean(username) || admin
}
