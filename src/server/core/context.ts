import path from 'node:path'
import { isIP } from 'node:net'

export interface ContextOptions {
  remoteAddress?: string
}

const firstHeaderValue = (value: string | null): string | null => {
  const first = value?.split(',')[0]?.trim()
  return first || null
}

const forwardedParameter = (header: string | null, name: string): string | null => {
  const firstEntry = firstHeaderValue(header)
  if (!firstEntry) return null
  const match = firstEntry.match(new RegExp(`(?:^|;)\\s*${name}=\\s*(?:"([^"]+)"|([^;\\s]+))`, 'i'))
  return (match?.[1] || match?.[2] || '').trim() || null
}

/**
 * 计算浏览器实际看到的请求 origin。
 *
 * TLS 通常在反向代理处终止，Bun 收到的连接本身仍然是 HTTP；
 * 因此需要使用标准转发头还原公网协议与主机，避免把同站请求误判成跨域。
 * 代理必须覆盖这些请求头，而不是把客户端传入值继续透传到后端。
 */
const normalizeAddress = (value: string): string => value.replace(/^\[|\]$/g, '').toLowerCase()

const normalizeForwardedAddress = (value: string | undefined): string | null => {
  if (!value) return null
  let candidate = value.trim()
  if (candidate.startsWith('"') && candidate.endsWith('"')) {
    candidate = candidate.slice(1, -1).trim()
  }
  const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) candidate = bracketed[1]
  else {
    const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
    if (ipv4WithPort) candidate = ipv4WithPort[1]
  }
  const normalized = normalizeAddress(candidate)
  return isIP(normalized) > 0 ? normalized : null
}

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Validate configuration values that are later passed to Headers.get(). */
export const isValidHttpHeaderName = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= 256 && HTTP_TOKEN_PATTERN.test(value)
)

/** Normalize a trusted-proxy allowlist and reject non-IP entries early. */
export const normalizeTrustedProxyAddresses = (value: unknown): string[] => {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : value == null
        ? ['127.0.0.1', '::1']
        : null
  if (!values) throw new Error('可信代理地址格式无效')

  const normalized = [...new Set(values
    .map(item => String(item).trim())
    .filter(Boolean)
    .map(normalizeAddress))]
  if (normalized.some(address => isIP(address) === 0)) throw new Error('可信代理地址必须是 IP 地址')
  return normalized
}

const isTrustedProxyAddress = (socketAddress: string): boolean => {
  if (!global.lx?.config?.['proxy.enabled']) return false
  const configured = global.lx?.config?.['proxy.trustedAddresses']
  if (!Array.isArray(configured) || configured.length === 0) return false
  const normalizedSocket = normalizeAddress(socketAddress)
  return configured.some(address => normalizeAddress(String(address)) === normalizedSocket)
}

export const resolveRequestOrigin = (request: Request, internalUrl: URL, trustForwardedHeaders = false): string => {
  if (!trustForwardedHeaders) return internalUrl.origin

  const forwardedProtocol = firstHeaderValue(request.headers.get('x-forwarded-proto'))
    || forwardedParameter(request.headers.get('forwarded'), 'proto')
  const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'))
    || forwardedParameter(request.headers.get('forwarded'), 'host')
    || firstHeaderValue(request.headers.get('host'))

  const externalUrl = new URL(internalUrl.href)
  if (forwardedProtocol === 'http' || forwardedProtocol === 'https') {
    externalUrl.protocol = `${forwardedProtocol}:`
  }

  if (forwardedHost) {
    try {
      const hostUrl = new URL(`${externalUrl.protocol}//${forwardedHost}`)
      if (!hostUrl.username && !hostUrl.password && hostUrl.pathname === '/') {
        externalUrl.hostname = hostUrl.hostname
        externalUrl.port = hostUrl.port
      }
    } catch {
      // Ignore malformed forwarding headers and keep Bun's internal origin.
    }
  }

  return externalUrl.origin
}

/**
 * 在未配置可信代理地址时，为浏览器请求安全地兼容 HTTPS 反代。
 *
 * 浏览器会发送真实的 Origin，但不会允许网页脚本自行设置
 * X-Forwarded-Proto / X-Forwarded-Host。只有当反代头计算出的 origin
 * 与浏览器声明的 Origin 完全一致时才采用它；跨站 Origin 仍然走内部
 * origin，随后由 CORS 中间件拒绝。可信代理仍优先使用转发头，以兼容
 * 没有 Origin 的服务端请求和 Cookie 安全属性判断。
 */
const resolveContextRequestOrigin = (
  request: Request,
  internalUrl: URL,
  trustedProxy: boolean,
): string => {
  if (trustedProxy) return resolveRequestOrigin(request, internalUrl, true)

  const browserOrigin = request.headers.get('origin')
  if (!browserOrigin) return internalUrl.origin

  const forwardedOrigin = resolveRequestOrigin(request, internalUrl, true)
  return browserOrigin === forwardedOrigin ? forwardedOrigin : internalUrl.origin
}

/**
 * 面向用户的错误文案：保留服务端已写好的中文原因，
 * 英文/技术性异常（如 SDK、fs、fetch 抛出的原文）统一替换为中文兜底文案。
 */
export const toUserMessage = (err: unknown, fallback: string): string => {
  const raw = err instanceof Error ? err.message : (typeof err === 'string' ? err : '')
  return /[\u4e00-\u9fa5]/.test(raw) ? raw : fallback
}

export class HttpContext {
  readonly request: Request
  readonly url: URL
  readonly requestOrigin: string
  readonly isSecure: boolean
  readonly pathname: string
  readonly method: string
  readonly query: URLSearchParams
  readonly headers: Headers
  readonly state = new Map<string, unknown>()
  readonly params: Record<string, string> = {}
  readonly remoteAddress: string
  readonly requestId: string

  private _cookies: Record<string, string> | null = null

  constructor(request: Request, options?: ContextOptions) {
    this.request = request
    this.url = new URL(request.url)
    this.pathname = this.url.pathname
    this.method = request.method.toUpperCase()
    this.query = this.url.searchParams
    this.headers = request.headers
    const socketAddress = options?.remoteAddress || ''
    const trustedProxy = isTrustedProxyAddress(socketAddress)
    this.remoteAddress = this.resolveRemoteAddress(options?.remoteAddress)
    // Client IP forwarding still requires a configured trusted proxy socket.
    // Origin forwarding may additionally be accepted when it exactly matches
    // the browser Origin, so Docker reverse proxies work without fixed IPs.
    this.requestOrigin = resolveContextRequestOrigin(request, this.url, trustedProxy)
    this.isSecure = this.requestOrigin.startsWith('https://')
    const incomingRequestId = request.headers.get('x-request-id')?.trim() || ''
    this.requestId = /^[A-Za-z0-9._-]{1,64}$/.test(incomingRequestId)
      ? incomingRequestId
      : crypto.randomUUID()
  }

  /**
   * 解析客户端真实 IP。
   * 仅在显式开启并配置了可信代理时才采信转发头，否则一律使用套接字地址，
   * 避免反向代理后所有访客被合并成同一个 IP（会导致登录限流互相牵连）。
   */
  private resolveRemoteAddress(socketAddress?: string): string {
    if (global.lx?.config?.['proxy.enabled'] && isTrustedProxyAddress(socketAddress || '')) {
      const headerName = (global.lx.config['proxy.header'] || 'x-forwarded-for').toLowerCase()
      const forwarded = this.headers.get(headerName)
      if (forwarded) {
        const first = forwarded.split(',')[0]?.trim()
        const normalized = normalizeForwardedAddress(first)
        if (normalized) return normalized
      }
    }
    return socketAddress || '127.0.0.1'
  }

  /** Cookie 延迟解析 */
  get cookies(): Record<string, string> {
    if (this._cookies) return this._cookies
    const cookieHeader = this.headers.get('cookie')
    if (!cookieHeader) {
      this._cookies = {}
      return this._cookies
    }
    const parsed: Record<string, string> = {}
    for (const item of cookieHeader.split(';')) {
      const [key, ...rest] = item.trim().split('=')
      if (key) {
        try {
          parsed[key.trim()] = decodeURIComponent(rest.join('='))
        } catch {
          parsed[key.trim()] = rest.join('=')
        }
      }
    }
    this._cookies = parsed
    return this._cookies
  }

  /** 解析 JSON 请求体 */
  async bodyJson<T = unknown>(maxBytes = 20 * 1024 * 1024): Promise<T> {
    const body = await this.readBodyText(maxBytes)
    try {
      return JSON.parse(body) as T
    } catch {
      throw new Error('Invalid JSON body')
    }
  }

  /** 解析纯文本请求体 */
  async bodyText(maxBytes = 20 * 1024 * 1024): Promise<string> {
    return this.readBodyText(maxBytes)
  }

  private async readBodyText(maxBytes = 20 * 1024 * 1024): Promise<string> {
    return new TextDecoder().decode(await this.readBodyBytes(maxBytes))
  }

  private async readBodyBytes(maxBytes = 20 * 1024 * 1024): Promise<Uint8Array> {
    const declaredLength = Number(this.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error('Request body is too large')
    }

    if (!this.request.body) return new Uint8Array()
    const reader = this.request.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
        total += chunk.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new Error('Request body is too large')
        }
        chunks.push(chunk)
      }
    } finally {
      reader.releaseLock()
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  }

  /** 原生 FormData 解析 (用于大文件/表单上传，零第三方依赖) */
  async formData(maxBytes = 20 * 1024 * 1024): Promise<FormData> {
    // Request.formData() does not expose a size limit. Buffer the request
    // through the same bounded reader first, then let the platform parse the
    // already-bounded multipart payload.
    const bytes = await this.readBodyBytes(maxBytes)
    const headers = new Headers(this.headers)
    headers.delete('content-length')
    return await new Request(this.request.url, {
      method: this.method,
      headers,
      body: bytes as unknown as BodyInit,
    }).formData()
  }

  /** 构造 JSON 响应 */
  json(data: unknown, status = 200, headers?: HeadersInit): Response {
    return Response.json(data, {
      status,
      headers,
    })
  }

  /**
   * 构造统一的业务错误响应。
   * 形状固定为 { code, message, success: false }：code 与 HTTP 状态码一致，
   * message 为可直接展示给用户的中文文案。
   */
  fail(status: number, message: string, extra?: Record<string, unknown>): Response {
    return this.json({ code: status, message, success: false, ...extra }, status)
  }

  /** 构造文本响应 */
  text(content: string, status = 200, headers?: HeadersInit): Response {
    return new Response(content, {
      status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...headers,
      },
    })
  }

  /** 构造 HTML 响应 */
  html(content: string, status = 200, headers?: HeadersInit): Response {
    return new Response(content, {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...headers,
      },
    })
  }

  /** 构造重定向响应 */
  redirect(url: string, status: 301 | 302 | 307 | 308 = 302): Response {
    return new Response(null, {
      status,
      headers: {
        Location: url,
      },
    })
  }

  /**
   * 基于 Bun.file 原生零拷贝分发静态文件或音频流
   * 自动支持 HTTP 206 Partial Content (Range requests) 与 mime 类型识别
   */
  file(filePath: string, options?: { status?: number; headers?: HeadersInit }): Response {
    const bunFile = Bun.file(path.resolve(filePath))
    return new Response(bunFile, {
      status: options?.status ?? 200,
      headers: options?.headers,
    })
  }

  /** 构造空响应 (如 204 No Content) */
  empty(status = 204, headers?: HeadersInit): Response {
    return new Response(null, {
      status,
      headers,
    })
  }
}
