import { Router } from '../core'
import { handleDownloadProxy } from './mediaRelayService'

/** 注册音乐文件下载中继入口 */
export const createDownloadProxyRouter = (): Router => {
  const router = new Router()
  router.get('/api/music/download', handleDownloadProxy)
  return router
}
