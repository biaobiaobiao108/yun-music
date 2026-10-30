export type RateLimitVerdict = { allowed: boolean; retryAfter: number }

export type TokenBucketLimiter = {
  /** 消耗一个额度；`now` 可注入，便于测试时间推进 */
  consume: (key: string, now?: number) => RateLimitVerdict
  size: () => number
  reset: () => void
}

export type TokenBucketOptions = {
  /** 窗口内允许的请求数，同时也是桶容量（允许同等规模的突发） */
  limit: number
  windowMs: number
  /** 键（客户端）数量上限，超出后按最久未使用淘汰 */
  maxClients?: number
}

type Bucket = { tokens: number; updatedAt: number }

/**
 * 连续补充的令牌桶。
 *
 * 相比固定窗口，这里没有"窗口边界双倍突发"的问题，也不会因为一次 60 秒
 * 的集中操作把人钉死在 429 上：只要平均速率降下来，额度会平滑恢复。
 */
export function createTokenBucketLimiter({
  limit,
  windowMs,
  maxClients = 10_000,
}: TokenBucketOptions): TokenBucketLimiter {
  const capacity = Math.max(1, Math.floor(limit))
  const window = Math.max(1, Math.floor(windowMs))
  const clients = Math.max(1, Math.floor(maxClients))
  const perSecond = capacity / (window / 1000)
  const buckets = new Map<string, Bucket>()

  const refill = (bucket: Bucket, now: number): Bucket => {
    const elapsed = Math.max(0, now - bucket.updatedAt)
    return { tokens: Math.min(capacity, bucket.tokens + (elapsed * capacity) / window), updatedAt: now }
  }

  const store = (key: string, bucket: Bucket) => {
    // 重新插入以刷新 LRU 顺序，淘汰时才不会误伤活跃客户端。
    buckets.delete(key)
    buckets.set(key, bucket)
    while (buckets.size > clients) {
      const oldest = buckets.keys().next().value
      if (!oldest) break
      buckets.delete(oldest)
    }
  }

  return {
    consume(key, now = Date.now()) {
      const previous = buckets.get(key)
      const bucket = previous ? refill(previous, now) : { tokens: capacity, updatedAt: now }
      if (bucket.tokens < 1) {
        store(key, bucket)
        return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / perSecond)) }
      }
      bucket.tokens -= 1
      store(key, bucket)
      return { allowed: true, retryAfter: 0 }
    },
    size: () => buckets.size,
    reset: () => buckets.clear(),
  }
}
