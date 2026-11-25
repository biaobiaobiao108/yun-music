import type { HttpContext } from '../core'

/** 音乐解析进度 SSE 专属通道: requestId -> Controller */
const musicProgressControllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
const musicProgressTimers = new Map<string, ReturnType<typeof setTimeout>>()
const musicProgressHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
const musicProgressClientIps = new Map<string, string>()
const musicProgressIpCounts = new Map<string, number>()
const MUSIC_PROGRESS_TTL = 10 * 60 * 1000
const MAX_MUSIC_PROGRESS_CHANNELS = 2_048
const MAX_MUSIC_PROGRESS_CHANNELS_PER_IP = 32
const MUSIC_PROGRESS_HEARTBEAT = 15 * 1000

const cleanupMusicProgress = (reqId: string, controller?: ReadableStreamDefaultController<Uint8Array>) => {
  if (controller && musicProgressControllers.get(reqId) !== controller) return
  musicProgressControllers.delete(reqId)
  const timer = musicProgressTimers.get(reqId)
  if (timer) clearTimeout(timer)
  musicProgressTimers.delete(reqId)
  const heartbeat = musicProgressHeartbeatTimers.get(reqId)
  if (heartbeat) clearInterval(heartbeat)
  musicProgressHeartbeatTimers.delete(reqId)
  const clientIp = musicProgressClientIps.get(reqId)
  if (clientIp) {
    const nextCount = (musicProgressIpCounts.get(clientIp) || 1) - 1
    if (nextCount > 0) musicProgressIpCounts.set(clientIp, nextCount)
    else musicProgressIpCounts.delete(clientIp)
  }
  musicProgressClientIps.delete(reqId)
}

export const handleMusicProgress = (ctx: HttpContext): Response => {
  const rawReqId = ctx.query.get('reqId')?.trim() || ''
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(rawReqId)) return ctx.fail(400, '进度请求标识格式无效')
  const reqId = rawReqId

  const clientIp = ctx.remoteAddress || 'unknown'
  const previous = musicProgressControllers.get(reqId)
  if (previous) {
    try {
      previous.close()
    } catch {}
    cleanupMusicProgress(reqId, previous)
  }
  if ((musicProgressIpCounts.get(clientIp) || 0) >= MAX_MUSIC_PROGRESS_CHANNELS_PER_IP) {
    return ctx.fail(429, '该客户端的进度连接数过多，请稍后重试', { retryAfter: 15 })
  }

  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      controller.enqueue(encoder.encode('retry: 3000\n\n'))
      while (musicProgressControllers.size >= MAX_MUSIC_PROGRESS_CHANNELS) {
        const oldestReqId = musicProgressControllers.keys().next().value
        if (!oldestReqId) break
        const oldest = musicProgressControllers.get(oldestReqId)
        try {
          oldest?.close()
        } catch {}
        cleanupMusicProgress(oldestReqId, oldest)
      }
      musicProgressControllers.set(reqId, controller)
      musicProgressClientIps.set(reqId, clientIp)
      musicProgressIpCounts.set(clientIp, (musicProgressIpCounts.get(clientIp) || 0) + 1)
      musicProgressHeartbeatTimers.set(
        reqId,
        setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'))
          } catch {
            try {
              controller.close()
            } catch {}
            cleanupMusicProgress(reqId, controller)
          }
        }, MUSIC_PROGRESS_HEARTBEAT),
      )
      musicProgressTimers.set(
        reqId,
        setTimeout(() => {
          try {
            controller.close()
          } catch {}
          cleanupMusicProgress(reqId, controller)
        }, MUSIC_PROGRESS_TTL),
      )
      ;(musicProgressHeartbeatTimers.get(reqId) as any)?.unref?.()
      ;(musicProgressTimers.get(reqId) as any)?.unref?.()
    },
    cancel() {
      cleanupMusicProgress(reqId, streamController || undefined)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

export const sendMusicProgress = (reqId: string, payload: unknown): boolean => {
  const controller = musicProgressControllers.get(reqId)
  if (!controller) return false
  try {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
    return true
  } catch {
    cleanupMusicProgress(reqId, controller)
    return false
  }
}
