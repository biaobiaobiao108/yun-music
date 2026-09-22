import type { Middleware } from './router'
import { accessLog } from '@/utils/log4js'

export * from './context'
export * from './router'

/** 默认同源策略与跨域预检中间件 */
export const corsMiddleware: Middleware = async (ctx, next) => {
  const origin = ctx.headers.get('origin')
  if (origin && origin !== ctx.requestOrigin) {
    return ctx.fail(403, '跨域请求被拒绝')
  }

  if (ctx.method === 'OPTIONS') {
    const headers: HeadersInit = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Request-ID',
      'Vary': 'Origin',
    }
    if (origin) headers['Access-Control-Allow-Origin'] = origin
    return new Response(null, {
      status: 204,
      headers,
    })
  }

  const response = await next()
  if (!response || !(response instanceof Response)) {
    return response
  }

  const headers = new Headers(response.headers)
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    withVary(headers, 'Origin')
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 为所有响应补充统一的请求追踪与浏览器安全策略。 */
export const securityHeadersMiddleware: Middleware = async (ctx, next) => {
  const response = await next()
  if (!(response instanceof Response)) return response

  const headers = new Headers(response.headers)
  headers.set('X-Request-ID', ctx.requestId)
  headers.set('X-Content-Type-Options', headers.get('X-Content-Type-Options') || 'nosniff')
  headers.set('Referrer-Policy', headers.get('Referrer-Policy') || 'strict-origin-when-cross-origin')
  headers.set('Permissions-Policy', headers.get('Permissions-Policy') || 'camera=(), microphone=(), geolocation=()')
  headers.set('X-Frame-Options', headers.get('X-Frame-Options') || 'DENY')
  headers.set('Content-Security-Policy', headers.get('Content-Security-Policy') || [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https: wss:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
  ].join('; '))

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 访问日志中间件 */
export const accessLogMiddleware: Middleware = async (ctx, next) => {
  accessLog.info(`${ctx.method} ${ctx.pathname} from ${ctx.remoteAddress}`)
  return await next()
}

/** 值得压缩的响应类型（文本类） */
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|manifest\+json)|image\/svg\+xml)/i
const COMPRESS_MIN_BYTES = 1024
const COMPRESS_MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** 已压缩结果缓存上限：key 为 ETag + 编码，用于避免重复压缩同一静态资源 */
const COMPRESS_CACHE_MAX_ENTRIES = 32
const COMPRESS_CACHE_MAX_BYTES = 32 * 1024 * 1024
const compressedCache = new Map<string, Uint8Array>()
let compressedCacheBytes = 0

/** Uint8Array 在运行时可作为 BodyInit，但 TS 的类型定义要求显式转换 */
const asBody = (data: Uint8Array): BodyInit => data as unknown as BodyInit

const readCompressedCache = (key: string): Uint8Array | null => {
  const hit = compressedCache.get(key)
  if (!hit) return null
  // LRU：命中后重新插入，保证热点资源留在缓存里
  compressedCache.delete(key)
  compressedCache.set(key, hit)
  return hit
}

const writeCompressedCache = (key: string, value: Uint8Array): void => {
  const previous = compressedCache.get(key)
  if (previous) compressedCacheBytes -= previous.byteLength
  compressedCache.set(key, value)
  compressedCacheBytes += value.byteLength
  while (compressedCache.size > COMPRESS_CACHE_MAX_ENTRIES || compressedCacheBytes > COMPRESS_CACHE_MAX_BYTES) {
    const oldest = compressedCache.keys().next().value
    if (oldest === undefined) break
    compressedCacheBytes -= compressedCache.get(oldest)?.byteLength ?? 0
    compressedCache.delete(oldest)
  }
}

const withVary = (headers: Headers, value: string): void => {
  const current = headers.get('vary')
  if (!current) headers.set('vary', value)
  else if (!current.split(',').map(item => item.trim().toLowerCase()).includes(value.toLowerCase())) {
    headers.set('vary', `${current}, ${value}`)
  }
}

/**
 * 响应压缩中间件：客户端声明支持 gzip 时，对文本类响应启用 gzip。
 * 静态资源带稳定 ETag，压缩结果按 ETag 缓存，避免每次请求重复压缩。
 */
export const compressionMiddleware: Middleware = async (ctx, next) => {
  const response = await next()
  if (!(response instanceof Response)) return response
  if (ctx.method === 'HEAD' || response.status === 204 || response.status === 206 || response.status === 304) return response
  if (!ctx.headers.get('accept-encoding')?.toLowerCase().includes('gzip')) return response
  if (response.headers.get('content-encoding') || ctx.headers.get('range')) return response

  const contentType = response.headers.get('content-type') || ''
  if (!COMPRESSIBLE_TYPE.test(contentType)) return response
  if (!response.body || typeof CompressionStream !== 'function') return response

  const etag = response.headers.get('etag')
  const cacheKey = etag ? `${etag}|gzip` : ''
  if (cacheKey) {
    const cached = readCompressedCache(cacheKey)
    if (cached) {
      const headers = new Headers(response.headers)
      headers.set('content-encoding', 'gzip')
      headers.set('content-length', String(cached.byteLength))
      withVary(headers, 'Accept-Encoding')
      return new Response(asBody(cached), { status: response.status, statusText: response.statusText, headers })
    }
  }

  const declaredLengthText = response.headers.get('content-length')
  const declaredLength = declaredLengthText === null ? null : Number(declaredLengthText)
  const canBuffer = declaredLength !== null
    && Number.isInteger(declaredLength)
    && declaredLength >= 0
    && declaredLength <= COMPRESS_MAX_BUFFER_BYTES

  // Responses without a trustworthy bounded length (for example large JSON
  // exports) must remain streaming. Buffering an attacker-controlled body
  // here would defeat the request-size limits enforced by individual routes.
  if (!canBuffer) {
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.set('content-encoding', 'gzip')
    withVary(headers, 'Accept-Encoding')
    return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  const body = new Uint8Array(await response.arrayBuffer())
  const headerForRebuild = new Headers(response.headers)
  withVary(headerForRebuild, 'Accept-Encoding')
  if (body.byteLength < COMPRESS_MIN_BYTES) {
    return new Response(asBody(body), { status: response.status, statusText: response.statusText, headers: headerForRebuild })
  }

  const compressed = Bun.gzipSync(body)
  if (compressed.byteLength >= body.byteLength) {
    return new Response(asBody(body), { status: response.status, statusText: response.statusText, headers: headerForRebuild })
  }
  if (cacheKey) writeCompressedCache(cacheKey, compressed)

  headerForRebuild.set('content-encoding', 'gzip')
  headerForRebuild.set('content-length', String(compressed.byteLength))
  return new Response(asBody(compressed), { status: response.status, statusText: response.statusText, headers: headerForRebuild })
}
