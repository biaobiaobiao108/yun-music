import { expect, spyOn, test } from 'bun:test'
import { createMemoryMaintenance, parseCgroupMemoryLimit, parseProcessSwapBytes, readContainerMemoryLimit, type MemorySnapshot } from '@/server/memoryMaintenance'

const mib = 1024 * 1024
const pressuredSnapshot = (): MemorySnapshot => ({ rss: 300 * mib, heapUsed: 60 * mib, external: 20 * mib, swap: 0, footprint: 300 * mib })

test('recognizes finite cgroup limits and ignores unlimited or malformed values', () => {
  expect(parseCgroupMemoryLimit('134217728\n')).toBe(128 * mib)
  for (const value of ['max', '', '0', '-1', 'bad', '9223372036854771712']) expect(parseCgroupMemoryLimit(value)).toBeUndefined()
})

test('reads inherited cgroup v2 limits when the process leaf and mount root are unlimited', () => {
  const files = new Map([
    ['/proc/self/cgroup', '0::/system.slice/music.service/workers\n'],
    ['/sys/fs/cgroup/memory.max', 'max\n'],
    ['/sys/fs/cgroup/system.slice/memory.max', String(128 * mib)],
    ['/sys/fs/cgroup/system.slice/music.service/memory.max', String(192 * mib)],
    ['/sys/fs/cgroup/system.slice/music.service/workers/memory.max', 'max'],
  ])
  const reads: string[] = []
  const readText = (filename: string) => {
    reads.push(filename)
    const content = files.get(filename)
    if (content === undefined) throw new Error('ENOENT')
    return content
  }
  expect(readContainerMemoryLimit(readText)).toBe(128 * mib)
  expect(reads).toContain('/sys/fs/cgroup/system.slice/music.service/memory.max')
  expect(reads).toContain('/sys/fs/cgroup/system.slice/memory.max')
  expect(reads).not.toContain('/sys/fs/memory.max')
  files.set('/sys/fs/cgroup/system.slice/music.service/workers/memory.max', String(64 * mib))
  expect(readContainerMemoryLimit(readText)).toBe(64 * mib)
})

test('reads cgroup v1 ancestor limits and tolerates missing controller files', () => {
  const files = new Map([
    ['/proc/self/cgroup', '3:cpu,cpuacct:/unrelated\n4:memory:/docker/music/worker\n'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '9223372036854771712'],
    ['/sys/fs/cgroup/memory/docker/memory.limit_in_bytes', String(96 * mib)],
    ['/sys/fs/cgroup/memory/docker/music/worker/memory.limit_in_bytes', '9223372036854771712'],
  ])
  const readText = (filename: string) => {
    const content = files.get(filename)
    if (content === undefined) throw new Error('ENOENT')
    return content
  }
  expect(readContainerMemoryLimit(readText)).toBe(96 * mib)
  files.delete('/sys/fs/cgroup/memory/docker/memory.limit_in_bytes')
  expect(readContainerMemoryLimit(readText)).toBeUndefined()
})

test('parses Linux process swap without treating file cache as process allocations', () => {
  expect(parseProcessSwapBytes('VmRSS:\t41212 kB\nVmSwap:\t282660 kB\nThreads:\t12\n')).toBe(282660 * 1024)
  expect(parseProcessSwapBytes('VmRSS:\t41212 kB\n')).toBe(0)
})

test('coalesces deferred collection, includes swapped pages and enforces the cooldown', async () => {
  let snapshot = { rss: 40 * mib, heapUsed: 60 * mib, external: 10 * mib, swap: 280 * mib, footprint: 320 * mib }
  let collections = 0
  let samples = 0
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const maintenance = createMemoryMaintenance({
    delayMs: 5,
    intervalMs: 100,
    sample: () => { samples++; return snapshot },
    collect: () => {
      collections++
      snapshot = { ...snapshot, heapUsed: 20 * mib, swap: 0, footprint: snapshot.rss }
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

test('backs off low-yield GC up to five minutes and lets managed growth resume the base cadence', async () => {
  let now = 0
  let collections = 0
  let snapshot = pressuredSnapshot()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const maintenance = createMemoryMaintenance({
    delayMs: 1,
    now: () => now,
    sample: () => snapshot,
    collect: () => { collections++ },
  })
  const check = async (time: number) => { now = time; maintenance.schedule('idle'); await Bun.sleep(5) }
  try {
    await check(0)
    expect(collections).toBe(1)
    await check(30_000)
    expect(collections).toBe(1)
    await check(60_000)
    expect(collections).toBe(2)
    await check(120_000)
    expect(collections).toBe(2)
    await check(180_000)
    expect(collections).toBe(3)
    await check(420_000)
    expect(collections).toBe(4)
    await check(690_000)
    expect(collections).toBe(4)
    await check(720_000)
    expect(collections).toBe(5)
    snapshot = { ...snapshot, external: 60 * mib }
    await check(750_000)
    expect(collections).toBe(6)
  } finally {
    maintenance.cancel()
    log.mockRestore()
  }
})

test('resets the cooldown after useful collection even if RSS stays allocated', async () => {
  let now = 0
  let collections = 0
  let snapshot = pressuredSnapshot()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const maintenance = createMemoryMaintenance({
    delayMs: 1,
    now: () => now,
    sample: () => snapshot,
    collect: () => {
      collections++
      if (collections > 1) snapshot = { ...snapshot, heapUsed: 40 * mib }
    },
  })
  try {
    maintenance.schedule('first')
    await Bun.sleep(5)
    now = 60_000
    maintenance.schedule('useful')
    await Bun.sleep(5)
    now = 90_000
    maintenance.schedule('base cadence')
    await Bun.sleep(5)
    expect(collections).toBe(3)
  } finally {
    maintenance.cancel()
    log.mockRestore()
  }
})

test('defers collection until heavy work is idle and cancellation removes its retry', async () => {
  let busy = true
  let collections = 0
  let samples = 0
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const maintenance = createMemoryMaintenance({
    delayMs: 1,
    intervalMs: 2,
    sample: () => { samples++; return pressuredSnapshot() },
    collect: () => { collections++ },
  })
  maintenance.setBusyCheck(() => busy)
  try {
    maintenance.schedule('completed transfer')
    await Bun.sleep(8)
    expect(samples).toBe(0)
    expect(collections).toBe(0)
    busy = false
    await Bun.sleep(8)
    expect(collections).toBe(1)
    busy = true
    maintenance.schedule('another transfer')
    await Bun.sleep(5)
    maintenance.cancel()
    busy = false
    await Bun.sleep(8)
    expect(collections).toBe(1)
  } finally {
    maintenance.cancel()
    log.mockRestore()
  }
})

test('uses a container soft threshold without collecting for native-only RSS pressure', async () => {
  let snapshot = { ...pressuredSnapshot(), rss: 100 * mib, footprint: 100 * mib, pressureLimit: 90 * mib, containerMemoryLimit: 128 * mib }
  let collections = 0
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const maintenance = createMemoryMaintenance({
    delayMs: 1,
    intervalMs: 2,
    sample: () => snapshot,
    collect: () => { collections++ },
  })
  try {
    maintenance.schedule('container pressure')
    await Bun.sleep(5)
    expect(collections).toBe(1)
    snapshot = { ...snapshot, rss: 400 * mib, footprint: 400 * mib, heapUsed: 1 * mib, external: 1 * mib }
    maintenance.schedule('native allocation pressure')
    await Bun.sleep(5)
    expect(collections).toBe(1)
  } finally {
    maintenance.cancel()
    log.mockRestore()
  }
})
