import { Router } from '../core'
import { createUserAccountRouter } from './userAccountRoutes'
import { createUserLibraryRouter } from './userLibraryRoutes'
import { createUserSettingsRouter } from './userSettingsRoutes'

/** 注册用户账户、曲库、偏好与数据维护路由 */
export const createUserRouter = (): Router => {
  const router = new Router()
  router.mount('/', createUserAccountRouter())
  router.mount('/', createUserLibraryRouter())
  router.mount('/', createUserSettingsRouter())
  return router
}
