import { Router } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as customSourceHandlers from '../customSourceHandlers'

/** 注册自定义音源管理路由 */
export const createCustomSourceRouter = (): Router => {
  const router = new Router()

  // 1. 源脚本校验（公共源必须管理员鉴权，私有源必须匹配当前用户）
  router.post('/api/custom-source/validate', (ctx) => {
    return customSourceHandlers.handleValidate(ctx)
  })

  // 通用中间件：若启用了公开受限模式，管理操作必须登录或管理员鉴权
  router.use('/api/custom-source/*', async (ctx, next) => {
    if (ctx.pathname === '/api/custom-source/validate') return await next()
    const config = (global.lx?.config ?? {}) as any
    if (config['user.enablePublicRestriction']) {
      const isAdmin = verifyAdminAuth(ctx.request)
      const user = verifyUserAuth(ctx)
      if (!isAdmin && !user) {
        return ctx.json({ success: false, error: '当前系统已开启访问限制，管理操作请登录后重试。' }, 403)
      }
    }
    return await next()
  })

  // 2. 导入与上传
  router.post('/api/custom-source/import', (ctx) => {
    return customSourceHandlers.handleImport(ctx)
  })

  router.post('/api/custom-source/upload', (ctx) => {
    return customSourceHandlers.handleUpload(ctx)
  })

  // 3. 列表查询
  router.get('/api/custom-source/list', (ctx) => {
    const requested = ctx.query.get('username') || ''
    const isAdmin = verifyAdminAuth(ctx.request)
    const currentUser = verifyUserAuth(ctx)
    let username = 'default'
    if (requested && requested !== 'default' && requested !== 'open' && requested !== '_open') {
      if (!isAdmin && currentUser !== requested) return ctx.json({ success: false, error: '无权查看其他用户的自定义源' }, 403)
      username = requested
    } else if (currentUser) {
      username = currentUser
    }
    return customSourceHandlers.handleList(ctx, username)
  })

  // 4. 启用/禁用切换
  router.post('/api/custom-source/toggle', (ctx) => {
    return customSourceHandlers.handleToggle(ctx)
  })

  // 5. 删除
  router.post('/api/custom-source/delete', (ctx) => {
    return customSourceHandlers.handleDelete(ctx)
  })

  // 6. 重排序
  router.post('/api/custom-source/reorder', (ctx) => {
    return customSourceHandlers.handleReorder(ctx)
  })

  return router
}
