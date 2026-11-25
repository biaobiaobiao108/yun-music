import { Router } from '../core'
import { createMusicCatalogRouter } from './musicCatalogRoutes'
import { createMusicLookupRouter } from './musicLookupRoutes'
import { createMusicLyricRouter } from './musicLyricRoutes'
import { createMusicPlaybackRouter } from './musicPlaybackRoutes'
import { musicRateLimitMiddleware } from './musicRateLimit'

/** 注册在线音乐检索、解析与播放元数据路由 */
export const createMusicRouter = (): Router => {
  const router = new Router()
  router.use('/api/music', musicRateLimitMiddleware)
  router.mount('/', createMusicLookupRouter())
  router.mount('/', createMusicPlaybackRouter())
  router.mount('/', createMusicLyricRouter())
  router.mount('/', createMusicCatalogRouter())
  return router
}
