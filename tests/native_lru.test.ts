import { expect, test } from 'bun:test'
import { NativeLruCache } from '@/utils/nativeLru'

// Inspect retained storage without get()/keys(), which themselves expire entries.
const retainedSize = (cache: NativeLruCache<string, object>) => (
  cache as unknown as { entries: Map<string, unknown> }
).entries.size

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
