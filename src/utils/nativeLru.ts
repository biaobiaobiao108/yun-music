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

  constructor(options: NativeLruCacheOptions) {
    this.max = Math.max(1, Math.floor(options.max))
    this.ttl = Math.max(0, options.ttl ?? 0)
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
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  keys(): IterableIterator<K> {
    this.removeExpired()
    return this.entries.keys()
  }
}
