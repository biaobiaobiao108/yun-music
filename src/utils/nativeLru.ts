export interface NativeLruCacheOptions<K = unknown, V = unknown> {
  max: number
  ttl?: number
  maxBytes?: number
  sizeCalculation?: (value: V, key: K) => number
}

interface CacheEntry<V> {
  value: V
  expiresAt: number
  bytes: number
}

/** Conservative retained-data estimate, without allocating a serialized copy. */
export const estimateCacheBytes = (value: unknown, limit = Number.POSITIVE_INFINITY): number => {
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  let bytes = 0
  while (pending.length && bytes <= limit) {
    const item = pending.pop()
    if (typeof item === 'string') { bytes += 24 + item.length * 2; continue }
    if (item === null || typeof item !== 'object') { bytes += 8; continue }
    if (seen.has(item)) continue
    seen.add(item)
    if (item instanceof Promise) return Number.POSITIVE_INFINITY
    if (ArrayBuffer.isView(item)) { bytes += 64 + item.buffer.byteLength; continue }
    if (item instanceof ArrayBuffer) { bytes += 64 + item.byteLength; continue }
    bytes += 64
    if (Array.isArray(item)) {
      bytes += item.length * 8
      if (bytes > limit) break
      for (const child of item) pending.push(child)
    } else if (item instanceof Map) {
      bytes += item.size * 32
      if (bytes > limit) break
      for (const [key, child] of item) pending.push(key, child)
    } else if (item instanceof Set) {
      bytes += item.size * 16
      if (bytes > limit) break
      for (const child of item) pending.push(child)
    } else {
      for (const key of Object.keys(item)) {
        bytes += 16 + key.length * 2
        pending.push((item as Record<string, unknown>)[key])
      }
    }
  }
  return bytes
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
  private readonly maxBytes: number
  private readonly sizeCalculation: (value: V, key: K) => number
  private bytes = 0
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private nextExpiryAt = 0

  constructor(options: NativeLruCacheOptions<K, V>) {
    this.max = Number.isFinite(options.max) ? Math.max(1, Math.floor(options.max)) : 1
    this.ttl = Number.isFinite(options.ttl) ? Math.max(0, options.ttl ?? 0) : 0
    this.maxBytes = options.maxBytes === undefined || options.maxBytes === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY : Number.isFinite(options.maxBytes) ? Math.max(0, Math.floor(options.maxBytes)) : 0
    this.sizeCalculation = options.sizeCalculation || (value => estimateCacheBytes(value, this.maxBytes))
  }

  private remove(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.bytes -= entry.bytes
    return this.entries.delete(key)
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
      if (this.isExpired(entry)) this.remove(key)
    }
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.isExpired(entry)) {
      this.remove(key)
      return undefined
    }

    // Map preserves insertion order, so delete + set moves the hit to MRU.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): this {
    this.remove(key)
    const valueBytes = this.maxBytes === Number.POSITIVE_INFINITY ? 0 : this.sizeCalculation(value, key)
    const bytes = this.maxBytes === Number.POSITIVE_INFINITY ? 0
      : 64 + estimateCacheBytes(key, this.maxBytes) + valueBytes
    if (!Number.isFinite(bytes) || valueBytes < 0 || bytes > this.maxBytes) {
      this.scheduleExpiry()
      return this
    }
    this.entries.set(key, {
      value,
      expiresAt: this.ttl > 0 ? Date.now() + this.ttl : Number.POSITIVE_INFINITY,
      bytes,
    })
    this.bytes += bytes

    while (this.entries.size > this.max || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.remove(oldest)
    }
    this.scheduleExpiry()
    return this
  }

  has(key: K): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    if (this.isExpired(entry)) {
      this.remove(key)
      return false
    }
    return true
  }

  delete(key: K): boolean {
    const deleted = this.remove(key)
    if (deleted) this.scheduleExpiry()
    return deleted
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
    this.scheduleExpiry()
  }

  keys(): IterableIterator<K> {
    this.removeExpired()
    return this.entries.keys()
  }

  getStats() {
    this.removeExpired()
    return { entries: this.entries.size, bytes: this.bytes, maxEntries: this.max, maxBytes: this.maxBytes }
  }
}
