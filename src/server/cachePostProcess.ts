import { memoryMaintenance } from './memoryMaintenance'

const CACHE_POST_PROCESS_CONCURRENCY = 1
const CACHE_MEMORY_GC_THRESHOLD = 256 * 1024 * 1024
const CACHE_MEMORY_GC_INTERVAL = 30 * 1000
let cachePostProcessActive = 0
let lastCacheMemoryLogAt = 0
type CachePostProcessWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abortHandler?: () => void
}
const cachePostProcessWaiters: CachePostProcessWaiter[] = []

const cleanupCachePostProcessWaiter = (waiter: CachePostProcessWaiter) => {
  if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener('abort', waiter.abortHandler)
}

const releaseCachePostProcess = () => {
  cachePostProcessActive = Math.max(0, cachePostProcessActive - 1)
  while (cachePostProcessWaiters.length > 0) {
    const waiter = cachePostProcessWaiters.shift()!
    cleanupCachePostProcessWaiter(waiter)
    if (waiter.signal?.aborted) {
      waiter.reject(new Error('Aborted'))
      continue
    }
    cachePostProcessActive += 1
    waiter.resolve()
    return
  }
}

const acquireCachePostProcess = (signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(new Error('Aborted'))
  if (cachePostProcessActive < CACHE_POST_PROCESS_CONCURRENCY) {
    cachePostProcessActive += 1
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const waiter: CachePostProcessWaiter = { resolve, reject, signal }
    waiter.abortHandler = () => {
      const index = cachePostProcessWaiters.indexOf(waiter)
      if (index !== -1) cachePostProcessWaiters.splice(index, 1)
      cleanupCachePostProcessWaiter(waiter)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', waiter.abortHandler, { once: true })
    cachePostProcessWaiters.push(waiter)
  })
}

const getCacheMemoryUsage = () => {
  const memory = process.memoryUsage()
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
  }
}

const formatMemoryMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MiB`

const reportCacheMemory = (stage: string, force = false) => {
  const now = Date.now()
  const memory = getCacheMemoryUsage()
  if (!force && now - lastCacheMemoryLogAt < CACHE_MEMORY_GC_INTERVAL && memory.rss < CACHE_MEMORY_GC_THRESHOLD) return
  lastCacheMemoryLogAt = now
  console.log(
    `[FileCache][Memory] ${stage}: rss=${formatMemoryMiB(memory.rss)}, heap=${formatMemoryMiB(memory.heapUsed)}, external=${formatMemoryMiB(memory.external)}, postProcess=${cachePostProcessActive}, waiting=${cachePostProcessWaiters.length}`,
  )
}

const maybeCollectCacheMemory = (stage: string) => {
  memoryMaintenance.schedule(stage)
  reportCacheMemory(stage)
}

export const beginCachePostProcess = async (signal: AbortSignal | undefined, stage: string): Promise<() => void> => {
  await acquireCachePostProcess(signal)
  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseCachePostProcess()
    maybeCollectCacheMemory(`${stage} end`)
  }
  if (signal?.aborted) {
    release()
    throw new Error('Aborted')
  }
  reportCacheMemory(`${stage} start`)
  return release
}

export const withCachePostProcess = async <T>(
  signal: AbortSignal | undefined,
  stage: string,
  callback: () => Promise<T>,
): Promise<T> => {
  const release = await beginCachePostProcess(signal, stage)
  try {
    return await callback()
  } finally {
    release()
  }
}

export const getCachePostProcessStats = () => ({
  active: cachePostProcessActive,
  waiting: cachePostProcessWaiters.length,
})
