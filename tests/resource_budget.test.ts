import { expect, spyOn, test } from 'bun:test'
import { ResourceBudget, acquireBufferedRequestBudget, getResourceBudgetStats, getWorkloadLimits, memoryCacheBudgets, tryAcquireDownloadSlot, tryAcquireMediaStream } from '@/server/resourceBudget'
import { httpFetch } from '@/modules/utils/request'

test('workload and cache ceilings tighten for small container memory limits', () => {
  const mib = 1024 * 1024
  const large = getWorkloadLimits(1024 * mib)
  const small = getWorkloadLimits(128 * mib)
  expect(large).toMatchObject({ bufferedBytes: 64 * mib, cacheBytes: 32 * mib, downloads: 4, mediaStreams: 8 })
  expect(small).toMatchObject({ bufferedBytes: 32 * mib, cacheBytes: 16 * mib, downloads: 2, mediaStreams: 4 })
  expect(Object.values(memoryCacheBudgets).reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(32 * mib)
})

test('shared admission bounds bytes and waiting work, cancels FIFO waiters and releases once', async () => {
  const pool = new ResourceBudget({ maxActive: 2, maxBytes: 10, maxWaiting: 2, waitMs: 1000 })
  const first = await pool.acquire(8)
  const controller = new AbortController()
  const cancelled = pool.acquire(4, controller.signal).catch(error => error)
  const next = pool.acquire(2)
  await expect(pool.acquire(1)).rejects.toThrow('队列已满')
  controller.abort()
  expect(await cancelled).toBeInstanceOf(Error)
  const second = await next
  expect(pool.getStats()).toMatchObject({ active: 2, reservedBytes: 10, waiting: 0 })
  first(); first(); second()
  expect(pool.getStats()).toMatchObject({ active: 0, reservedBytes: 0, waiting: 0 })
})

test('admission timeouts remove waiters and invalid oversized work cannot block the queue', async () => {
  const pool = new ResourceBudget({ maxActive: 1, maxBytes: 4, maxWaiting: 1, waitMs: 5 })
  await expect(pool.acquire(5)).rejects.toThrow('超过')
  const release = await pool.acquire(4)
  const waiting = pool.acquire(1).catch(error => error)
  await Bun.sleep(15)
  expect((await waiting).message).toContain('超时')
  expect(pool.getStats().waiting).toBe(0)
  release()
  const reused = await pool.acquire(4)
  reused()
  expect(pool.getStats().reservedBytes).toBe(0)
})

test('SDK cancellation while waiting for the global byte budget never starts an upstream request', async () => {
  const hold = await acquireBufferedRequestBudget(Number.MAX_SAFE_INTEGER)
  const original = globalThis.fetch
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response('{}'), { preconnect: original.preconnect }))
  try {
    const operation = httpFetch('https://example.test/budget')
    const rejected = operation.promise.catch(error => error)
    await Promise.resolve()
    expect(getResourceBudgetStats().buffered.waiting).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    operation.cancelHttp()
    expect(await rejected).toBeInstanceOf(Error)
    await Bun.sleep(0)
    expect(getResourceBudgetStats().buffered.waiting).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    hold.release()
    fetch.mockRestore()
  }
  expect(getResourceBudgetStats().buffered.active).toBe(0)
})

test('global media slots are shared by relays and downloads and downloads have a global ceiling', () => {
  const releases: Array<() => void> = []
  try {
    const limit = getResourceBudgetStats().downloads.maxActive
    for (let index = 0; index < limit; index++) {
      const release = tryAcquireDownloadSlot()
      expect(release).not.toBeNull()
      releases.push(release!)
    }
    expect(tryAcquireDownloadSlot()).toBeNull()
    while (true) {
      const release = tryAcquireMediaStream()
      if (!release) break
      releases.push(release)
    }
    expect(getResourceBudgetStats().media.active).toBe(getResourceBudgetStats().media.maxActive)
    expect(tryAcquireMediaStream()).toBeNull()
  } finally {
    for (const release of releases) { release(); release() }
  }
  expect(getResourceBudgetStats().downloads.active).toBe(0)
  expect(getResourceBudgetStats().media.active).toBe(0)
})
