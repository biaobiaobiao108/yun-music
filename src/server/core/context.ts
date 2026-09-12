import path from 'node:path'

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
export const resolveRequestOrigin = (request: Request, internalUrl: URL): string => {
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
    this.requestOrigin = resolveRequestOrigin(request, this.url)
    this.isSecure = this.requestOrigin.startsWith('https://')
    this.pathname = this.url.pathname
    this.method = request.method.toUpperCase()
    this.query = this.url.searchParams
    this.headers = request.headers
    this.remoteAddress = this.resolveRemoteAddress(options?.remoteAddress)
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
    if (global.lx?.config?.['proxy.enabled']) {
      const headerName = (global.lx.config['proxy.header'] || 'x-forwarded-for').toLowerCase()
      const forwarded = this.headers.get(headerName)
      if (forwarded) {
        const first = forwarded.split(',')[0]?.trim()
        if (first) return first
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
  async bodyJson<T = unknown>(): Promise<T> {
    try {
      return JSON.parse(await this.readBodyText()) as T
    } catch {
      throw new Error('Invalid JSON body')
    }
  }

  /** 解析纯文本请求体 */
  async bodyText(): Promise<string> {
    return this.readBodyText()
  }

  private async readBodyText(maxBytes = 20 * 1024 * 1024): Promise<string> {
    const declaredLength = Number(this.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error('Request body is too large')
    }

    if (!this.request.body) return ''
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
    return new TextDecoder().decode(bytes)
  }

  /** 原生 FormData 解析 (用于大文件/表单上传，零第三方依赖) */
  async formData(): Promise<FormData> {
    return await this.request.formData()
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
