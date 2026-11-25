import { Router } from '../core'
import { createDownloadProxyRouter } from './mediaRelay'
import { createCacheMediaRouter } from './cacheMediaRoutes'
import { createCacheQueueRouter } from './cacheQueueRoutes'
import { createCacheStorageRouter } from './cacheStorageRoutes'
import { createCacheTagRouter } from './cacheTagRoutes'

/** 注册本地音乐缓存、下载队列、文件分发与标签处理路由 */
export const createCacheRouter = (): Router => {
  const router = new Router()
  router.mount('/', createCacheStorageRouter())
  router.mount('/', createCacheQueueRouter())
  router.mount('/', createCacheTagRouter())
  router.mount('/', createCacheMediaRouter())
  router.mount('/', createDownloadProxyRouter())
  return router
}
