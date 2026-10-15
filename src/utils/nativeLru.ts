export interface NativeLruCacheOptions {
  max: number
  ttl?: number
}

interface CacheEntry<V> {
  value: V
  expiresAt: number
}

/**
 * Small runtime-only LRU cache backed by the native Map implementation.
 *
 * The project only needs bounded in-memory caches, so keeping the
 * implementation local avoids a dependency without changing those semantics:
 * reads refresh recency, TTL is absolute unless the entry is replaced, and
 * the oldest entry is evicted when max is exceeded.
 */
export class NativeLruCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>()
  private readonly max: number
  private readonly ttl: number
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private nextExpiryAt = 0

  constructor(options: NativeLruCacheOptions) {
    this.max = Number.isFinite(options.max) ? Math.max(1, Math.floor(options.max)) : 1
    this.ttl = Number.isFinite(options.ttl) ? Math.max(0, options.ttl ?? 0) : 0
  }

  /** One unref'ed timer per cache releases cold entries even without another lookup. */
  private scheduleExpiry(): void {
    let earliest = Number.POSITIVE_INFINITY
    if (this.ttl > 0) {
      for (const entry of this.entries.values()) earliest = Math.min(earliest, entry.expiresAt)
    }
    if (this.expiryTimer && earliest === this.nextExpiryAt) return
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    this.nextExpiryAt = 0
    if (!Number.isFinite(earliest)) return
    this.nextExpiryAt = earliest
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined
      this.nextExpiryAt = 0
      this.removeExpired()
      this.scheduleExpiry()
    }, Math.min(2_147_483_647, Math.max(1, earliest - Date.now())))
    this.expiryTimer.unref?.()
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    return this.ttl > 0 && entry.expiresAt <= Date.now()
  }

  private removeExpired(): void {
    if (this.ttl <= 0) return
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) this.entries.delete(key)
    }
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.isExpired(entry)) {
      this.entries.delete(key)
      return undefined
    }

    // Map preserves insertion order, so delete + set moves the hit to MRU.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): this {
    this.entries.delete(key)
    this.entries.set(key, {
      value,
      expiresAt: this.ttl > 0 ? Date.now() + this.ttl : Number.POSITIVE_INFINITY,
    })

    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.scheduleExpiry()
    return this
  }

  has(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    if (this.isExpired(entry)) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  delete(key: K): boolean {
    const deleted = this.entries.delete(key)
    if (deleted) this.scheduleExpiry()
    return deleted
  }

  clear(): void {
    this.entries.clear()
    this.scheduleExpiry()
  }

  keys(): IterableIterator<K> {
    this.removeExpired()
    return this.entries.keys()
  }
}
