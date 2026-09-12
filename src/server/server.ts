import type { Server } from 'bun'
import { createRootRouter } from './routes'
import { initMusicServices } from './services/musicService'
import { serverStatus, getServerStatus } from './state'
import { getAddress } from '@/utils/tools'
import { startupLog } from '@/utils/log4js'

let bunServerInstance: Server<Record<string, never>> | null = null

/**
 * 现代全栈 Bun 原生极简 HTTP 组装入口。
 */
const startHttp = async (port = 9527, bindIp = '127.0.0.1'): Promise<void> => {
  const rootRouter = createRootRouter()
  bunServerInstance = Bun.serve({
    port,
    hostname: bindIp,
    maxRequestBodySize: 1024 * 1024 * 100, // 100MB 支持大文件与源文件上传
    async fetch(req, server) {
      const remoteAddress = server.requestIP(req)?.address || '127.0.0.1'
      const webRes = await rootRouter.handle(req, { remoteAddress })
      if (webRes instanceof Response) return webRes

      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    },
  })

  startupLog.info(`Listening on ${bindIp} port ${bunServerInstance.port}`)
}

export const startServer = async (port: number, ip: string): Promise<void> => {
  startupLog.info(`Starting 云音 in ${process.env.NODE_ENV === 'production' ? 'production' : 'development'}`)
  await initMusicServices()
  try {
    await startHttp(port, ip)
    serverStatus.status = true
    serverStatus.message = ''
    serverStatus.address = ip === '0.0.0.0' ? getAddress() : [ip]
  } catch (err: any) {
    console.error('[StartServer Fatal]:', err)
    serverStatus.status = false
    serverStatus.message = err.message
    serverStatus.address = []
    throw err
  }
}

export const stopServer = async (closeActiveConnections = false): Promise<void> => {
  if (bunServerInstance) {
    startupLog.info('Stopping HTTP server...')
    bunServerInstance.stop(closeActiveConnections)
    bunServerInstance = null
    serverStatus.status = false
    serverStatus.message = 'Server stopped'
    serverStatus.address = []
  }
}

export const getStatus = () => getServerStatus()
