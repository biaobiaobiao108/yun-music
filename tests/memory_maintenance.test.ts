import { expect, spyOn, test } from 'bun:test'
import { createMemoryMaintenance, parseProcessSwapBytes } from '@/server/memoryMaintenance'

test('parses Linux process swap without treating file cache as process allocations', () => {
  expect(parseProcessSwapBytes('VmRSS:\t41212 kB\nVmSwap:\t282660 kB\nThreads:\t12\n')).toBe(282660 * 1024)
  expect(parseProcessSwapBytes('VmRSS:\t41212 kB\n')).toBe(0)
})

test('coalesces deferred collection, includes swapped pages and enforces the cooldown', async () => {
  const mib = 1024 * 1024
  let snapshot = { rss: 40 * mib, heapUsed: 20 * mib, external: 10 * mib, swap: 280 * mib, footprint: 320 * mib }
  let collections = 0
  let samples = 0
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const maintenance = createMemoryMaintenance({
    delayMs: 5,
    intervalMs: 100,
    sample: () => { samples++; return snapshot },
    collect: () => {
      collections++
      snapshot = { ...snapshot, swap: 0, footprint: snapshot.rss }
    },
  })
  try {
    for (let i = 0; i < 20; i++) maintenance.schedule('completed transfer')
    expect(collections).toBe(0)
    await Bun.sleep(15)
    expect(collections).toBe(1)
    expect(samples).toBe(2)
    snapshot = { ...snapshot, swap: 280 * mib, footprint: 320 * mib }
    maintenance.schedule('next transfer')
    await Bun.sleep(15)
    expect(collections).toBe(1)
    maintenance.cancel()
    await Bun.sleep(100)
    expect(collections).toBe(1)
  } finally {
    maintenance.cancel()
    log.mockRestore()
  }
})

test('leaves a low-memory process alone after completed streaming work', async () => {
  const maintenance = createMemoryMaintenance({
    delayMs: 5,
    sample: () => ({ rss: 40, swap: 0, footprint: 40, heapUsed: 20, external: 5 }),
    collect: () => { throw new Error('Unexpected collection') },
  })
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    maintenance.schedule('small response')
    await Bun.sleep(15)
    expect(warning).not.toHaveBeenCalled()
  } finally {
    maintenance.cancel()
    warning.mockRestore()
  }
})
