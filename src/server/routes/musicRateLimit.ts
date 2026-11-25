import type { Middleware } from '../core'
import { createTokenBucketLimiter } from '../core/rateLimiter'

const MUSIC_REQUEST_WINDOW = 60 * 1000
/**
 * 平均约 4 rps：正常听歌、翻歌单、搜索都在这个量级以内，而持续爬取上游
 * 源站仍然会被挡住。用令牌桶而不是固定窗口，避免整分钟操作在窗口边界被
 * 判成"两次突发"。
 */
const MUSIC_REQUEST_LIMIT = 240
const MUSIC_REQUEST_BUCKET_LIMIT = 10_000

/**
 * 媒体流有自己的预算（请求数 / 字节数 / 并发槽），而 Safari 播放 FLAC 时
 * 一次拖动就会打出一串 Range 请求。把它们再计入普通接口配额，会让"拖进度条"
 * 直接变成 429 并中断播放，所以在这里豁免。
 */
const MUSIC_RATE_LIMIT_EXEMPT_PATHS = new Set(['/api/music/download'])
const MUSIC_RATE_LIMIT_EXEMPT_PREFIXES = ['/api/music/cache/file/', '/api/music/cache/events']

export const isMusicRateLimitExempt = (pathname: string): boolean =>
  MUSIC_RATE_LIMIT_EXEMPT_PATHS.has(pathname) ||
  MUSIC_RATE_LIMIT_EXEMPT_PREFIXES.some(prefix => pathname.startsWith(prefix))

export const createMusicRateLimitMiddleware = (
  limiter = createTokenBucketLimiter({
    limit: MUSIC_REQUEST_LIMIT,
    windowMs: MUSIC_REQUEST_WINDOW,
    maxClients: MUSIC_REQUEST_BUCKET_LIMIT,
  }),
): Middleware => {
  return async (ctx, next) => {
    if (isMusicRateLimitExempt(ctx.pathname)) return next()
    const verdict = limiter.consume(ctx.remoteAddress || 'unknown')
    if (!verdict.allowed) return ctx.fail(429, '请求过于频繁，请稍后重试', { retryAfter: verdict.retryAfter })
    return next()
  }
}

export const musicRateLimitMiddleware = createMusicRateLimitMiddleware()
