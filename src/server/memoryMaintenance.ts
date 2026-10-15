import fs from 'node:fs'
import path from 'node:path'

export const MEMORY_PRESSURE_BYTES = 256 * 1024 * 1024
const MEMORY_CHECK_INTERVAL_MS = 30_000
const MAX_GC_INTERVAL_MS = 5 * 60_000
const MIB = 1024 * 1024

export const parseProcessSwapBytes = (status: string): number => {
  const value = /^VmSwap:\s+(\d+)\s+kB$/m.exec(status)?.[1]
  return value ? Number(value) * 1024 : 0
}

export const parseCgroupMemoryLimit = (value: string): number | undefined => {
  if (!/^\d+$/.test(value.trim())) return undefined
  const limit = Number(value.trim())
  // v1 uses an enormous sentinel for unlimited memory; v2 uses "max".
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
}

let containerLimitCheckedAt = Number.NEGATIVE_INFINITY
let cachedContainerLimit: number | undefined

/** Read the tightest inherited cgroup limit, with injectable filesystem access. */
export const readContainerMemoryLimit = (readText: (filename: string) => string): number | undefined => {
  const candidates = new Set(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'])
  try {
    for (const line of readText('/proc/self/cgroup').split('\n')) {
      const match = /^\d+:([^:]*):(\/.*)$/.exec(line)
      if (!match) continue
      const root = match[1] === '' ? '/sys/fs/cgroup' : match[1]!.split(',').includes('memory') ? '/sys/fs/cgroup/memory' : null
      if (!root) continue
      let directory = path.posix.resolve(root, `.${match[2]}`)
      if (directory !== root && !directory.startsWith(`${root}/`)) continue
      const filename = match[1] === '' ? 'memory.max' : 'memory.limit_in_bytes'
      while (true) {
        candidates.add(path.posix.join(directory, filename))
        if (directory === root) break
        directory = path.posix.dirname(directory)
      }
    }
  } catch { }
  const limits: number[] = []
  for (const filename of candidates) {
    try {
      const limit = parseCgroupMemoryLimit(readText(filename))
      if (limit !== undefined) limits.push(limit)
    } catch { }
  }
  return limits.length ? Math.min(...limits) : undefined
}

/** Optional container hard limit, distinct from process RSS or swap usage. */
export const getContainerMemoryLimit = (): number | undefined => {
  if (process.platform !== 'linux') return undefined
  const now = Date.now()
  if (now - containerLimitCheckedAt < MEMORY_CHECK_INTERVAL_MS) return cachedContainerLimit
  containerLimitCheckedAt = now
  cachedContainerLimit = readContainerMemoryLimit(filename => fs.readFileSync(filename, 'utf8'))
  return cachedContainerLimit
}

export type MemorySnapshot = {
  rss: number
  heapUsed: number
  external: number
  swap: number
  /** Resident plus swapped process pages: an estimate, not physical usage. */
  footprint: number
  /** GC soft threshold; this is not a container memory limit. */
  pressureLimit?: number
  containerMemoryLimit?: number
}

/** RSS alone misses anonymous pages already moved into NAS swap/zswap. */
export const getProcessMemorySnapshot = (): MemorySnapshot => {
  const { rss, heapUsed, external } = process.memoryUsage()
  let swap = 0
  if (process.platform === 'linux') {
    try { swap = parseProcessSwapBytes(fs.readFileSync('/proc/self/status', 'utf8')) } catch { }
  }
  const containerMemoryLimit = getContainerMemoryLimit()
  const pressureLimit = containerMemoryLimit === undefined ? MEMORY_PRESSURE_BYTES : Math.min(MEMORY_PRESSURE_BYTES, containerMemoryLimit * .7)
  return { rss, heapUsed, external, swap, footprint: rss + swap, pressureLimit, containerMemoryLimit }
}

export const createMemoryMaintenance = (options: {
  sample?: () => MemorySnapshot
  collect?: () => void
  intervalMs?: number
  delayMs?: number
  maxIntervalMs?: number
  isBusy?: () => boolean
  now?: () => number
} = {}) => {
  const sample = options.sample || getProcessMemorySnapshot
  const collect = options.collect || (() => Bun.gc(true))
  const intervalMs = options.intervalMs ?? MEMORY_CHECK_INTERVAL_MS
  const delayMs = options.delayMs ?? 1000
  const maxIntervalMs = Math.max(intervalMs, options.maxIntervalMs ?? MAX_GC_INTERVAL_MS)
  const now = options.now ?? Date.now
  let isBusy = options.isBusy ?? (() => false)
  let lastCheck = Number.NEGATIVE_INFINITY
  let lastCollection = Number.NEGATIVE_INFINITY
  let cooldownMs = intervalMs
  let afterCollectionBytes: number | undefined
  let timer: ReturnType<typeof setTimeout> | null = null

  const arm = (stage: string, waitMs: number): void => {
    timer = setTimeout(() => {
      timer = null
      if (isBusy()) {
        // Keep one unreferenced retry; active native work should finish first.
        arm(stage, Math.max(delayMs, Math.min(intervalMs, 1000)))
        return
      }
      lastCheck = now()
      try {
        const before = sample()
        const limit = before.pressureLimit ?? MEMORY_PRESSURE_BYTES
        const managedBytes = before.heapUsed + before.external
        const minManagedBytes = Math.min(32 * MIB, limit * .125)
        // footprint can expose swapped process pages on NAS hosts, but it is
        // only an advisory signal. Native allocations alone do not justify GC.
        if (Math.max(before.rss, before.footprint) < limit || managedBytes < minManagedBytes) return
        const growing = afterCollectionBytes !== undefined && managedBytes - afterCollectionBytes >= Math.max(16 * MIB, afterCollectionBytes * .25)
        if (now() - lastCollection < (growing ? intervalMs : cooldownMs)) return
        collect()
        lastCollection = now()
        const after = sample()
        afterCollectionBytes = after.heapUsed + after.external
        const reclaimed = Math.max(0, managedBytes - afterCollectionBytes)
        const useful = reclaimed >= 8 * MIB || reclaimed >= managedBytes * .05
        cooldownMs = useful ? intervalMs : Math.min(maxIntervalMs, cooldownMs * 2)
        const mib = (bytes: number) => (bytes / MIB).toFixed(1)
        console.log(`[Memory] ${stage}: gc rss=${mib(before.rss)}->${mib(after.rss)}MiB swap=${mib(before.swap)}->${mib(after.swap)}MiB heap=${mib(before.heapUsed)}->${mib(after.heapUsed)}MiB external=${mib(before.external)}->${mib(after.external)}MiB reclaimed=${mib(reclaimed)}MiB cooldown=${cooldownMs}ms`)
      } catch (error) {
        lastCollection = now()
        cooldownMs = Math.min(maxIntervalMs, cooldownMs * 2)
        console.warn('[Memory] Deferred collection failed:', error)
      }
    }, waitMs)
    timer.unref?.()
  }

  return {
    schedule(stage: string): void {
      if (timer) return
      // Run after completed response/task callbacks have released their buffers.
      // Bursts of chunks and downloads share one check, including on idle exit.
      arm(stage, Math.max(delayMs, intervalMs - (now() - lastCheck)))
    },
    setBusyCheck(check: () => boolean): void { isBusy = check },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export const memoryMaintenance = createMemoryMaintenance()
