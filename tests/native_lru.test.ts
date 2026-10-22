import { expect, test } from 'bun:test'
import { NativeLruCache, estimateCacheBytes } from '@/utils/nativeLru'

// Inspect retained storage without get()/keys(), which themselves expire entries.
const retainedSize = (cache: NativeLruCache<string, object>) =>
  (cache as unknown as { entries: Map<string, unknown> }).entries.size

test('cold expired cache values are released without a subsequent lookup', async () => {
  const cache = new NativeLruCache<string, object>({ max: 2, ttl: 20 })
  cache.set('cold', { payload: new Uint8Array(1024) })
  expect(retainedSize(cache)).toBe(1)
  await Bun.sleep(50)
  expect(retainedSize(cache)).toBe(0)
})

test('replacement renews expiry, reads preserve absolute TTL, and capacity remains bounded', async () => {
  const cache = new NativeLruCache<string, object>({ max: 2, ttl: 60 })
  cache.set('a', {}).set('b', {}).set('c', {})
  expect(retainedSize(cache)).toBe(2)
  expect(cache.has('a')).toBe(false)
  await Bun.sleep(40)
  cache.get('b')
  cache.set('c', { renewed: true })
  await Bun.sleep(40)
  expect(retainedSize(cache)).toBe(1)
  expect(cache.get('c')).toEqual({ renewed: true })
  cache.clear()
  expect(retainedSize(cache)).toBe(0)
})

test('byte and entry budgets evict LRU values and reject an oversized replacement', () => {
  const cache = new NativeLruCache<string, string>({ max: 2, maxBytes: 400, sizeCalculation: value => value.length })
  cache.set('a', 'a'.repeat(100)).set('b', 'b'.repeat(100))
  cache.get('a')
  cache.set('c', 'c'.repeat(100))
  expect(cache.has('b')).toBe(false)
  expect(cache.has('a')).toBe(true)
  expect(cache.getStats().entries).toBe(2)
  expect(cache.getStats().bytes).toBeLessThanOrEqual(400)
  cache.set('a', 'x'.repeat(1000))
  expect(cache.has('a')).toBe(false)
  const retainedBytes = cache.getStats().bytes
  cache.set('c', 'tiny')
  expect(cache.getStats().bytes).toBeLessThan(retainedBytes)
  cache.delete('c')
  expect(cache.getStats().bytes).toBe(0)
  cache.set('d', 'small').clear()
  expect(cache.getStats().entries).toBe(0)
  expect(cache.getStats().bytes).toBe(0)
})

test('cold expiry releases charged bytes and failed size estimates cannot bypass the budget', async () => {
  const cache = new NativeLruCache<string, string>({ max: 10, maxBytes: 1024, ttl: 15 })
  cache.set('expiring', 'payload')
  expect(cache.getStats().bytes).toBeGreaterThan(0)
  await Bun.sleep(40)
  expect(cache.getStats().bytes).toBe(0)
  const invalid = new NativeLruCache<string, object>({ max: 10, maxBytes: Number.NaN })
  invalid.set('invalid', {})
  expect(invalid.getStats().entries).toBe(0)
})

test('estimation handles cycles, counts backing buffers and does not retain unresolved promises', () => {
  const cycle: any = { text: 'text' }
  cycle.self = cycle
  expect(Number.isFinite(estimateCacheBytes(cycle))).toBe(true)
  const backing = new ArrayBuffer(2048)
  expect(estimateCacheBytes(new Uint8Array(backing, 0, 1))).toBeGreaterThanOrEqual(2048)
  const cache = new NativeLruCache<string, unknown>({ max: 5, maxBytes: 1024 })
  cache.set('promise', Promise.resolve(new Uint8Array(4096)))
  expect(cache.has('promise')).toBe(false)
  cache.set('large', new Array(1_000_000))
  expect(cache.has('large')).toBe(false)
})
