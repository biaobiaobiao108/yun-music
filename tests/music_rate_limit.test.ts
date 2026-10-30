import { describe, expect, test } from 'bun:test'
import { Router } from '@/server/core'
import { createTokenBucketLimiter } from '@/server/core/rateLimiter'
import { createMusicRateLimitMiddleware, isMusicRateLimitExempt } from '@/server/routes/music'

describe('token bucket limiter', () => {
  test('allows a full burst, then reports how long to wait', () => {
    const limiter = createTokenBucketLimiter({ limit: 3, windowMs: 60_000 })
    const now = 1_000
    expect(limiter.consume('ip', now).allowed).toBe(true)
    expect(limiter.consume('ip', now).allowed).toBe(true)
    expect(limiter.consume('ip', now).allowed).toBe(true)
    const denied = limiter.consume('ip', now)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1)
  })

  test('refills continuously, so a window boundary is not a cliff', () => {
    const limiter = createTokenBucketLimiter({ limit: 4, windowMs: 1_000 })
    const now = 1_000
    for (let i = 0; i < 4; i++) expect(limiter.consume('ip', now).allowed).toBe(true)
    expect(limiter.consume('ip', now).allowed).toBe(false)
    // 250ms 后正好补回一个额度，而不是等到整秒后才整体重置。
    expect(limiter.consume('ip', now + 250).allowed).toBe(true)
    expect(limiter.consume('ip', now + 250).allowed).toBe(false)
    expect(limiter.consume('ip', now + 1_000).allowed).toBe(true)
  })

  test('isolates clients and evicts the least recently used one', () => {
    const limiter = createTokenBucketLimiter({ limit: 1, windowMs: 60_000, maxClients: 2 })
    expect(limiter.consume('a', 1_000).allowed).toBe(true)
    expect(limiter.consume('b', 1_000).allowed).toBe(true)
    expect(limiter.consume('a', 1_000).allowed).toBe(false)
    expect(limiter.consume('c', 1_000).allowed).toBe(true)
    expect(limiter.size()).toBe(2)
    // `b` 是最久未使用的键，被淘汰后重新拥有完整额度。
    expect(limiter.consume('b', 1_000).allowed).toBe(true)
  })
})

describe('music API rate limit', () => {
  test('exempts media streaming routes but not the API surface', () => {
    expect(isMusicRateLimitExempt('/api/music/download')).toBe(true)
    expect(isMusicRateLimitExempt('/api/music/cache/file/song.flac')).toBe(true)
    expect(isMusicRateLimitExempt('/api/music/cache/file/user/song.flac')).toBe(true)
    expect(isMusicRateLimitExempt('/api/music/cache/events')).toBe(true)
    expect(isMusicRateLimitExempt('/api/music/search')).toBe(false)
    expect(isMusicRateLimitExempt('/api/music/cache/queue')).toBe(false)
    expect(isMusicRateLimitExempt('/api/music/downloads')).toBe(false)
  })

  test('playback range requests do not spend the API quota', async () => {
    const limiter = createTokenBucketLimiter({ limit: 2, windowMs: 60_000 })
    const router = new Router()
    router.use('/api/music', createMusicRateLimitMiddleware(limiter))
    router.get('/api/music/download', ctx => ctx.json({ ok: true }))
    router.get('/api/music/cache/file/*', ctx => ctx.json({ ok: true }))
    router.get('/api/music/search', ctx => ctx.json({ ok: true }))

    const options = { remoteAddress: '203.0.113.9' }
    // 一次拖动就是几条 Range 请求：这些必须始终放行。
    for (let i = 0; i < 6; i++) {
      const res = await router.handle(new Request('http://localhost/api/music/download?url=x'), options)
      expect(res.status).toBe(200)
    }
    for (let i = 0; i < 6; i++) {
      const res = await router.handle(new Request('http://localhost/api/music/cache/file/song.flac'), options)
      expect(res.status).toBe(200)
    }

    expect((await router.handle(new Request('http://localhost/api/music/search?name=a'), options)).status).toBe(200)
    expect((await router.handle(new Request('http://localhost/api/music/search?name=b'), options)).status).toBe(200)
    const throttled = await router.handle(new Request('http://localhost/api/music/search?name=c'), options)
    expect(throttled.status).toBe(429)
    const payload = (await throttled.json()) as { retryAfter?: number }
    expect(payload.retryAfter).toBeGreaterThanOrEqual(1)
  })
})
