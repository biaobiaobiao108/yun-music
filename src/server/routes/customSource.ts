import { Router } from '../core'
import { verifyAdminAuth } from '../auth'
import { verifyUserAuth } from './auth'
import * as customSourceHandlers from '../customSourceHandlers'

/** 注册自定义音源管理路由 */
export const createCustomSourceRouter = (): Router => {
  const router = new Router()

  // 1. 源脚本校验（自定义源现在统一由管理员管理）
  router.post('/api/custom-source/validate', (ctx) => {
    return customSourceHandlers.handleValidate(ctx)
  })

  // 自定义源的写入、校验和状态管理均属于后台管理能力。列表查询仍然
  // 保留给播放器使用，以便服务端按当前用户返回公共/专属源。
  router.use('/api/custom-source/*', async (ctx, next) => {
    if (ctx.pathname !== '/api/custom-source/list' && !verifyAdminAuth(ctx.request)) {
      return ctx.json({ success: false, error: '管理员权限不足：自定义源仅允许管理员管理。' }, 403)
    }
    const config = (global.lx?.config ?? {}) as any
    if (config['user.enablePublicRestriction']) {
      const isAdmin = verifyAdminAuth(ctx.request)
      const user = verifyUserAuth(ctx)
      if (ctx.pathname === '/api/custom-source/list' && !isAdmin && !user) {
        return ctx.json({ success: false, error: '当前系统已开启访问限制，请登录后重试。' }, 403)
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
    if (requested === 'open' || requested === '_open') {
      // 管理后台按作用域查询公共源时必须只返回公共源，即使请求同时
      // 携带了播放器用户会话，也不能把账户专属源混入当前作用域。
      username = 'default'
    } else if (requested && requested !== 'default') {
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

  // 7. 管理员在公共源和账户专属源之间转移归属
  router.post('/api/custom-source/assign', (ctx) => {
    return customSourceHandlers.handleAssign(ctx)
  })

  return router
}
