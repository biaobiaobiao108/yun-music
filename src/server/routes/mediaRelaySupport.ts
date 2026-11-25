import http from 'node:http'
import https from 'node:https'
import { tryAcquireMediaStream } from '../resourceBudget'

// Reuse a small, bounded set of upstream sockets for the media relay. The
// relay still validates every target URL and keeps the per-client concurrency
// limits below; keep-alive only removes avoidable TCP/TLS handshakes between
// adjacent tracks from the same host.
const upstreamHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxSockets: 8,
  maxFreeSockets: 4,
  timeout: 30_000,
})
const upstreamHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxSockets: 8,
  maxFreeSockets: 4,
  maxCachedSessions: 100,
  timeout: 30_000,
})

export const getUpstreamAgent = (protocol: string): http.Agent | https.Agent =>
  protocol === 'https:' ? upstreamHttpsAgent : upstreamHttpAgent

export const INFERRED_AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
}

type RelayRedirectCacheEntry = {
  finalUrl: string
  expiresAt: number
}
const relayRedirectCache = new Map<string, RelayRedirectCacheEntry>()
const RELAY_REDIRECT_CACHE_TTL_MS = 60_000
const MAX_RELAY_REDIRECT_CACHE_ENTRIES = 256

/** Record a resolved upstream redirect and evict oldest entries beyond the LRU cap. */
export const cacheRelayRedirect = (originalUrl: string, finalUrl: string): void => {
  if (relayRedirectCache.has(originalUrl)) {
    relayRedirectCache.delete(originalUrl)
  }
  relayRedirectCache.set(originalUrl, {
    finalUrl,
    expiresAt: Date.now() + RELAY_REDIRECT_CACHE_TTL_MS,
  })
  while (relayRedirectCache.size > MAX_RELAY_REDIRECT_CACHE_ENTRIES) {
    const oldest = relayRedirectCache.keys().next().value
    if (!oldest) break
    relayRedirectCache.delete(oldest)
  }
}

export const getCachedRelayRedirect = (originalUrl: string): string | null => {
  const cached = relayRedirectCache.get(originalUrl)
  if (!cached) return null
  if (cached.expiresAt > Date.now()) return cached.finalUrl
  relayRedirectCache.delete(originalUrl)
  return null
}

export const removeRelayRedirect = (originalUrl: string): void => {
  relayRedirectCache.delete(originalUrl)
}

/** 客户端离开页面或取消媒体请求时，Node 会以 AbortError 结束中继请求。
 * 这是正常的连接生命周期，不应按服务端故障写入 error 日志。 */
export const isExpectedDownloadAbort = (error: unknown, signal?: AbortSignal): boolean => {
  if (signal?.aborted) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR'
}

export const isOpaqueBrowserProgressId = (id: string): boolean => /^(?:dl|server)_[A-Za-z0-9_-]{20,128}$/.test(id)

// Safari/WebKit 对同源媒体会并发多条连接（HTTP/1.1 每主机 6 条），播放 FLAC
// 时拖动进度条又会重开连接；并发额度若低于浏览器的连接池，第 5 条请求就会拿到
// 429，表现为拖动后停播。这里给出高于连接池的余量，全局预算继续兜底。
const DOWNLOAD_PROXY_MAX_ACTIVE_PER_IP = 8
const DOWNLOAD_PROXY_MAX_TAGGING_PER_IP = 3
const DOWNLOAD_PROXY_MAX_ACTIVE_GLOBAL = 64
const DOWNLOAD_PROXY_BUDGET_WINDOW_MS = 10 * 60 * 1000
// 播放一首 FLAC 会产生多条 Range 请求，拖动一次通常是 1~2 条。240 条/10 分钟
// （平均 0.4 条/秒）会先于字节额度耗尽，把正常的连续拖动判成异常流量。
const DOWNLOAD_PROXY_MAX_REQUESTS_PER_IP = 1_200
const DOWNLOAD_PROXY_MAX_REQUESTS_GLOBAL = 4_800
const DOWNLOAD_PROXY_MAX_BYTES_PER_IP = 2 * 1024 * 1024 * 1024
const DOWNLOAD_PROXY_MAX_BYTES_GLOBAL = 8 * 1024 * 1024 * 1024
const DOWNLOAD_PROXY_MAX_BUDGET_CLIENTS = 10_000
const downloadProxyActiveByIp = new Map<string, number>()
const downloadProxyTaggingByIp = new Map<string, number>()
type DownloadProxyBudgetBucket = { tokens: number; updatedAt: number }
const downloadProxyRequestBudgetByIp = new Map<string, DownloadProxyBudgetBucket>()
const downloadProxyByteBudgetByIp = new Map<string, DownloadProxyBudgetBucket>()
let downloadProxyGlobalActive = 0
let downloadProxyGlobalRequestBudget: DownloadProxyBudgetBucket = {
  tokens: DOWNLOAD_PROXY_MAX_REQUESTS_GLOBAL,
  updatedAt: Date.now(),
}
let downloadProxyGlobalByteBudget: DownloadProxyBudgetBucket = {
  tokens: DOWNLOAD_PROXY_MAX_BYTES_GLOBAL,
  updatedAt: Date.now(),
}

const refillDownloadProxyBucket = (
  bucket: DownloadProxyBudgetBucket | undefined,
  capacity: number,
  now: number,
): DownloadProxyBudgetBucket => {
  if (!bucket) return { tokens: capacity, updatedAt: now }
  const elapsed = Math.max(0, now - bucket.updatedAt)
  return {
    tokens: Math.min(capacity, bucket.tokens + (elapsed * capacity) / DOWNLOAD_PROXY_BUDGET_WINDOW_MS),
    updatedAt: now,
  }
}

const storeDownloadProxyBudgetBucket = (
  buckets: Map<string, DownloadProxyBudgetBucket>,
  key: string,
  bucket: DownloadProxyBudgetBucket,
): void => {
  // Refresh insertion order so bounded eviction removes the least recently used IP.
  buckets.delete(key)
  buckets.set(key, bucket)
  while (buckets.size > DOWNLOAD_PROXY_MAX_BUDGET_CLIENTS) {
    const oldest = buckets.keys().next().value
    if (!oldest) break
    buckets.delete(oldest)
  }
}

const consumeDownloadProxyRequestBudget = (ip: string): boolean => {
  const now = Date.now()
  const client = refillDownloadProxyBucket(
    downloadProxyRequestBudgetByIp.get(ip),
    DOWNLOAD_PROXY_MAX_REQUESTS_PER_IP,
    now,
  )
  const global = refillDownloadProxyBucket(downloadProxyGlobalRequestBudget, DOWNLOAD_PROXY_MAX_REQUESTS_GLOBAL, now)
  const allowed = client.tokens >= 1 && global.tokens >= 1
  if (allowed) {
    client.tokens -= 1
    global.tokens -= 1
  }
  storeDownloadProxyBudgetBucket(downloadProxyRequestBudgetByIp, ip, client)
  downloadProxyGlobalRequestBudget = global
  return allowed
}

export const consumeDownloadProxyBytes = (ip: string, byteCount: number): boolean => {
  if (!Number.isSafeInteger(byteCount) || byteCount <= 0) return byteCount === 0
  const now = Date.now()
  const client = refillDownloadProxyBucket(downloadProxyByteBudgetByIp.get(ip), DOWNLOAD_PROXY_MAX_BYTES_PER_IP, now)
  const global = refillDownloadProxyBucket(downloadProxyGlobalByteBudget, DOWNLOAD_PROXY_MAX_BYTES_GLOBAL, now)
  const allowed = client.tokens >= byteCount && global.tokens >= byteCount
  if (allowed) {
    client.tokens -= byteCount
    global.tokens -= byteCount
  }
  storeDownloadProxyBudgetBucket(downloadProxyByteBudgetByIp, ip, client)
  downloadProxyGlobalByteBudget = global
  return allowed
}

export const tryAcquireDownloadProxySlot = (ip: string, tagging: boolean): (() => void) | null => {
  const active = downloadProxyActiveByIp.get(ip) || 0
  const activeTagging = downloadProxyTaggingByIp.get(ip) || 0
  if (
    downloadProxyGlobalActive >= DOWNLOAD_PROXY_MAX_ACTIVE_GLOBAL ||
    active >= DOWNLOAD_PROXY_MAX_ACTIVE_PER_IP ||
    (tagging && activeTagging >= DOWNLOAD_PROXY_MAX_TAGGING_PER_IP)
  ) {
    return null
  }
  if (!consumeDownloadProxyRequestBudget(ip)) return null
  const releaseGlobalStream = tryAcquireMediaStream()
  if (!releaseGlobalStream) return null
  downloadProxyActiveByIp.set(ip, active + 1)
  downloadProxyGlobalActive += 1
  if (tagging) downloadProxyTaggingByIp.set(ip, activeTagging + 1)

  let released = false
  return () => {
    if (released) return
    released = true
    releaseGlobalStream()
    const nextActive = (downloadProxyActiveByIp.get(ip) || 1) - 1
    if (nextActive > 0) downloadProxyActiveByIp.set(ip, nextActive)
    else downloadProxyActiveByIp.delete(ip)
    downloadProxyGlobalActive = Math.max(0, downloadProxyGlobalActive - 1)
    if (tagging) {
      const nextTagging = (downloadProxyTaggingByIp.get(ip) || 1) - 1
      if (nextTagging > 0) downloadProxyTaggingByIp.set(ip, nextTagging)
      else downloadProxyTaggingByIp.delete(ip)
    }
  }
}
