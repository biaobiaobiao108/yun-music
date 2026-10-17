import type { Server } from 'bun'
import { createRootRouter } from './routes'
import { initMusicServices } from './services/musicService'
import { serverStatus, getServerStatus } from './state'
import { getAddress } from '@/utils/tools'
import { startupLog } from '@/utils/log4js'
import { memoryMaintenance } from './memoryMaintenance'

let bunServerInstance: Server<Record<string, never>> | null = null

/**
 * 现代全栈 Bun 原生极简 HTTP 组装入口。
 */
const startHttp = async (port = 9527, bindIp = '127.0.0.1'): Promise<void> => {
  const rootRouter = createRootRouter()
  // Behind TLS-terminating reverse proxies the session cookie only gets
  // `Secure` when X-Forwarded-Proto arrives (see HttpContext.isSecure) and the
  // proxy address is trusted. Warn once instead of silently downgrading.
  const exposed = bindIp === '0.0.0.0' || bindIp === '::'
  const trustedProxies = (global.lx?.config?.['proxy.trustedAddresses'] as string[] | undefined) ?? []
  if (exposed && trustedProxies.length === 0) {
    startupLog.warn(
      'BIND_IP 暴露在所有网卡上，但没有配置 proxy.trustedAddresses：' +
      '反向代理的 X-Forwarded-Proto/X-Forwarded-For 会被忽略，HTTPS 部署下 Cookie 将不带 Secure、限流也按代理 IP 统计。',
    )
  }
  bunServerInstance = Bun.serve({
    port,
    hostname: bindIp,
    maxRequestBodySize: 1024 * 1024 * 100, // 100MB 支持大文件与源文件上传
    // SSE progress channels send a heartbeat every 15 seconds; keep the
    // connection alive beyond Bun's 10-second default idle timeout.
    idleTimeout: 60,
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
  startupLog.info(`Starting 云鹿音乐 in ${process.env.NODE_ENV === 'production' ? 'production' : 'development'}`)
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
  memoryMaintenance.cancel()
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
