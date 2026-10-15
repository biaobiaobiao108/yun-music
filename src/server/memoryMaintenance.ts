import fs from 'node:fs'

export const MEMORY_PRESSURE_BYTES = 256 * 1024 * 1024
const MEMORY_CHECK_INTERVAL_MS = 30_000

export const parseProcessSwapBytes = (status: string): number => {
  const value = /^VmSwap:\s+(\d+)\s+kB$/m.exec(status)?.[1]
  return value ? Number(value) * 1024 : 0
}

/** RSS alone misses anonymous pages already moved into NAS swap/zswap. */
export const getProcessMemorySnapshot = () => {
  const { rss, heapUsed, external } = process.memoryUsage()
  let swap = 0
  if (process.platform === 'linux') {
    try { swap = parseProcessSwapBytes(fs.readFileSync('/proc/self/status', 'utf8')) } catch { }
  }
  return { rss, heapUsed, external, swap, footprint: rss + swap }
}

type MemorySnapshot = ReturnType<typeof getProcessMemorySnapshot>

export const createMemoryMaintenance = (options: {
  sample?: () => MemorySnapshot
  collect?: () => void
  intervalMs?: number
  delayMs?: number
} = {}) => {
  const sample = options.sample || getProcessMemorySnapshot
  const collect = options.collect || (() => Bun.gc(true))
  const intervalMs = options.intervalMs ?? MEMORY_CHECK_INTERVAL_MS
  const delayMs = options.delayMs ?? 1000
  let lastCheck = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    schedule(stage: string): void {
      if (timer) return
      // Run after completed response/task callbacks have released their buffers.
      // Bursts of chunks and downloads share one check, including on idle exit.
      timer = setTimeout(() => {
        timer = null
        lastCheck = Date.now()
        const before = sample()
        if (before.footprint < MEMORY_PRESSURE_BYTES) return
        try {
          collect()
          const after = sample()
          const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
          console.log(`[Memory] ${stage}: gc rss=${mib(before.rss)}->${mib(after.rss)}MiB swap=${mib(before.swap)}->${mib(after.swap)}MiB heap=${mib(before.heapUsed)}->${mib(after.heapUsed)}MiB external=${mib(before.external)}->${mib(after.external)}MiB`)
        } catch (error) {
          console.warn('[Memory] Deferred collection failed:', error)
        }
      }, Math.max(delayMs, intervalMs - (Date.now() - lastCheck)))
      timer.unref?.()
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export const memoryMaintenance = createMemoryMaintenance()
