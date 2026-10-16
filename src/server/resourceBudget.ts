import { getContainerMemoryLimit, memoryMaintenance } from './memoryMaintenance'

const MiB = 1024 * 1024

export const getWorkloadLimits = (containerLimit = getContainerMemoryLimit()) => {
  const smallContainer = containerLimit !== undefined && containerLimit <= 256 * MiB
  return {
    bufferedBytes: Math.max(8 * MiB, Math.min(64 * MiB, (containerLimit ?? 256 * MiB) / 4)),
    bufferedRequests: smallContainer ? 2 : 4,
    downloads: smallContainer ? 2 : 4,
    mediaStreams: smallContainer ? 4 : 8,
    pendingRequests: 32,
    cacheBytes: Math.max(2 * MiB, Math.min(32 * MiB, (containerLimit ?? 256 * MiB) / 8)),
  }
}

type Release = () => void
type Waiter = {
  bytes: number
  resolve: (release: Release) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  abort?: () => void
  timer?: ReturnType<typeof setTimeout>
}

/** Admission estimates bound overlapping work; these are not an RSS hard limit. */
export class ResourceBudget {
  private active = 0
  private bytes = 0
  private readonly waiting: Waiter[] = []

  constructor(private readonly limits: { maxActive: number; maxBytes: number; maxWaiting: number; waitMs?: number }) {}

  getStats() {
    return { active: this.active, reservedBytes: this.bytes, waiting: this.waiting.length,
      maxActive: this.limits.maxActive, maxBytes: this.limits.maxBytes, maxWaiting: this.limits.maxWaiting }
  }

  private fits(bytes: number) {
    return this.active < this.limits.maxActive && this.bytes + bytes <= this.limits.maxBytes
  }

  private reserve(bytes: number): Release {
    this.active++
    this.bytes += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.bytes -= bytes
      this.drain()
    }
  }

  tryAcquire(bytes = 1): Release | null {
    if (!Number.isFinite(bytes) || bytes <= 0 || this.waiting.length || !this.fits(bytes)) return null
    return this.reserve(bytes)
  }

  private detach(waiter: Waiter) {
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort)
  }

  private drain() {
    while (this.waiting.length && this.fits(this.waiting[0].bytes)) {
      const waiter = this.waiting.shift()!
      this.detach(waiter)
      waiter.resolve(this.reserve(waiter.bytes))
    }
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(new Error('请求已取消'))
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > this.limits.maxBytes) {
      return Promise.reject(new Error('请求超过服务器缓冲预算'))
    }
    const available = this.tryAcquire(bytes)
    if (available) return Promise.resolve(available)
    if (this.waiting.length >= this.limits.maxWaiting) return Promise.reject(new Error('服务器请求队列已满，请稍后重试'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { bytes, resolve, reject, signal }
      const fail = (message: string) => {
        const index = this.waiting.indexOf(waiter)
        if (index < 0) return
        this.waiting.splice(index, 1)
        this.detach(waiter)
        reject(new Error(message))
        this.drain()
      }
      waiter.abort = () => fail('请求已取消')
      this.waiting.push(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      waiter.timer = setTimeout(() => fail('服务器繁忙，等待请求预算超时'), this.limits.waitMs ?? 15_000)
      waiter.timer.unref?.()
    })
  }
}

const limits = getWorkloadLimits()
const cacheUnit = Math.floor(limits.cacheBytes / 8)
export const memoryCacheBudgets = { sourceMatch: cacheUnit * 2, singers: cacheUnit, general: cacheUnit,
  index: cacheUnit * 2, compressed: cacheUnit * 2 }
const bufferedRequests = new ResourceBudget({ maxActive: limits.bufferedRequests, maxBytes: limits.bufferedBytes, maxWaiting: limits.pendingRequests })
const mediaStreams = new ResourceBudget({ maxActive: limits.mediaStreams, maxBytes: limits.mediaStreams, maxWaiting: 0 })
let activeDownloads = 0
const mediaAvailabilityListeners = new Set<() => void>()

export interface BufferedRequestLease {
  /** Tightened for small containers; enforced by both upstream transports. */
  maxBytes: number
  release: Release
}

export const acquireBufferedRequestBudget = async (maxBytes: number, signal?: AbortSignal): Promise<BufferedRequestLease> => {
  // Reserve room for chunks, concatenated bytes and parsed/string data.
  const allowed = Math.max(1, Math.min(Math.floor(maxBytes), Math.floor(limits.bufferedBytes / 3)))
  const release = await bufferedRequests.acquire(allowed * 3, signal)
  return { maxBytes: allowed, release: () => { release(); memoryMaintenance.schedule('buffered request end') } }
}

export const onMediaBudgetAvailable = (listener: () => void) => {
  mediaAvailabilityListeners.add(listener)
  return () => { mediaAvailabilityListeners.delete(listener) }
}

export const tryAcquireMediaStream = (): Release | null => {
  const release = mediaStreams.tryAcquire()
  if (!release) return null
  let released = false
  return () => {
    if (released) return
    released = true
    release()
    for (const listener of mediaAvailabilityListeners) {
      try { listener() } catch (err) { console.error('[ResourceBudget] listener error:', err) }
    }
  }
}

export const tryAcquireDownloadSlot = (): Release | null => {
  if (activeDownloads >= limits.downloads) return null
  const release = tryAcquireMediaStream()
  if (!release) return null
  activeDownloads++
  let released = false
  return () => {
    if (released) return
    released = true
    activeDownloads--
    release()
  }
}

export const getResourceBudgetStats = () => ({ buffered: bufferedRequests.getStats(), media: mediaStreams.getStats(),
  downloads: { active: activeDownloads, maxActive: limits.downloads }, cacheLimits: memoryCacheBudgets })

export const isResourceBudgetBusy = () => bufferedRequests.getStats().active > 0 || mediaStreams.getStats().active > 0
