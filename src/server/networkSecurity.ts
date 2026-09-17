import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'

const ipv4ToNumber = (value: string): number | null => {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null
  const nums = parts.map(Number)
  if (nums.some(num => num > 255)) return null
  return (((nums[0] * 256 + nums[1]) * 256 + nums[2]) * 256 + nums[3]) >>> 0
}

const isPrivateIpv4 = (value: string): boolean => {
  const number = ipv4ToNumber(value)
  if (number == null) return false
  const ranges: Array<[number, number]> = [
    [0x00000000, 0x00ffffff], // current network / "this" host
    [0x0a000000, 0x0affffff], // RFC1918
    [0x64400000, 0x647fffff], // carrier-grade NAT
    [0x7f000000, 0x7fffffff], // loopback
    [0xa9fe0000, 0xa9feffff], // link-local
    [0xac100000, 0xac1fffff], // RFC1918
    [0xc0000000, 0xc00000ff], // IETF protocol assignments
    [0xc0000200, 0xc00002ff], // TEST-NET-1
    [0xc0586300, 0xc05863ff], // 6to4 relay anycast
    [0xc0a80000, 0xc0a8ffff], // RFC1918
    [0xc6120000, 0xc613ffff], // benchmarking
    [0xc6336400, 0xc63364ff], // TEST-NET-2
    [0xcb007100, 0xcb0071ff], // TEST-NET-3
    [0xe0000000, 0xffffffff], // multicast and reserved
  ]
  return ranges.some(([start, end]) => number >= start && number <= end)
}

const isPrivateIpv6 = (value: string): boolean => {
  const address = value.replace(/^\[|\]$/g, '').split('%')[0]
  let normalized: string
  try {
    // Canonicalize expanded and dotted IPv4-mapped IPv6 forms alike.
    normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  } catch {
    return true
  }
  const mapped = normalized.match(/^::ffff:([\da-f]+):([\da-f]+)$/)
  if (mapped) {
    const high = parseInt(mapped[1], 16)
    const low = parseInt(mapped[2], 16)
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')
}

// Some desktop proxy clients use RFC 2544 benchmarking IPv4 addresses and a
// fixed ULA IPv6 prefix as synthetic DNS answers. They are not routable
// addresses of the requested host, but the proxy still needs to see the
// original hostname in order to route the request. Keep these values separate
// from real private addresses so normal DNS-rebinding protection remains in
// place for LAN and loopback targets.
const isSyntheticDnsAddress = (value: string): boolean => {
  const number = ipv4ToNumber(value)
  if (number != null) return number >= 0xc6120000 && number <= 0xc613ffff

  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  return normalized.startsWith('fdfe:dcba:9876:')
}

const isPrivateAddress = (value: string): boolean => {
  if (isIP(value) === 4) return isPrivateIpv4(value)
  return isPrivateIpv6(value)
}

const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === 'local'
}

export type SafeRemoteHttpUrl = URL & { lookup: LookupFunction }

export interface SafeRemoteFetchOptions extends Omit<RequestInit, 'redirect'> {
  /** Bun 原生 fetch 的代理扩展；配置代理时由调用方显式传入。 */
  proxy?: string
  /** 限制响应体大小，避免远端响应造成内存放大。 */
  maxBytes?: number
  /** 仅在调用方没有提供 signal 时生效。 */
  timeoutMs?: number
}

const DEFAULT_REMOTE_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_REMOTE_RESPONSE_BYTES = 50 * 1024 * 1024
const REMOTE_DNS_TIMEOUT_MS = 5_000

const normalizeRemoteResponseLimit = (value: unknown): number => {
  try {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REMOTE_RESPONSE_BYTES
    return Math.min(Math.floor(parsed), MAX_REMOTE_RESPONSE_BYTES)
  } catch {
    return DEFAULT_REMOTE_RESPONSE_BYTES
  }
}

const normalizeRemoteTimeout = (value: unknown): number => {
  try {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return 15_000
    return Math.min(Math.floor(parsed), 5 * 60 * 1000)
  } catch {
    return 15_000
  }
}

type ResolvedRemoteAddress = { address: string; family: number }

const lookupRemoteAddresses = async (hostname: string): Promise<ResolvedRemoteAddress[]> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Remote DNS lookup timed out')), REMOTE_DNS_TIMEOUT_MS)
        timeoutHandle.unref?.()
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

const responseHeaderEntries = (headers: http.IncomingHttpHeaders): Headers => {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item)
    } else if (value !== undefined) {
      result.set(name, String(value))
    }
  }
  return result
}

const bodyToBuffer = async (body: BodyInit | null | undefined): Promise<Buffer | undefined> => {
  if (body == null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body))
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer())
  throw new Error('Unsupported remote request body')
}

const responseBody = (body: Uint8Array): BodyInit => body as unknown as BodyInit

const readResponseBody = async (response: Response, maxBytes: number): Promise<Buffer> => {
  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > maxBytes) {
    await response.body?.cancel()
    throw new Error('Remote response is too large')
  }

  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel('Remote response is too large')
        throw new Error('Remote response is too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

const fetchViaBunProxy = async (
  safeUrl: SafeRemoteHttpUrl,
  options: SafeRemoteFetchOptions,
): Promise<Response> => {
  const { proxy, signal: inputSignal, ...requestInit } = options
  const maxBytes = normalizeRemoteResponseLimit(options.maxBytes)
  const timeoutMs = normalizeRemoteTimeout(options.timeoutMs)
  const signal = inputSignal || AbortSignal.timeout(timeoutMs)
  const response = await fetch(safeUrl.href, {
    ...requestInit,
    signal,
    redirect: 'manual',
    proxy,
  } as RequestInit & { proxy: string })
  const body = await readResponseBody(response, maxBytes)
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(responseBody(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * 使用已验证的 DNS 地址发起远程请求。
 *
 * Bun fetch 目前没有 Node `lookup` 等价的连接级钉扎参数，因此直连请求
 * 使用 node:http(s)；只有显式配置了 Bun 代理时才交给 Bun fetch，由代理
 * 负责解析原始主机名。所有响应都经过统一的字节上限处理。
 */
export const fetchSafeRemote = async (
  safeUrl: SafeRemoteHttpUrl,
  options: SafeRemoteFetchOptions = {},
): Promise<Response> => {
  if (options.proxy) return fetchViaBunProxy(safeUrl, options)

  const {
    method = 'GET',
    headers: inputHeaders,
    body: inputBody,
    signal,
  } = options
  const maxBytes = normalizeRemoteResponseLimit(options.maxBytes)
  const timeoutMs = normalizeRemoteTimeout(options.timeoutMs)
  const normalizedMethod = String(method).toUpperCase()
  const requestHostname = safeUrl.hostname.replace(/^\[|\]$/g, '')
  const formDataRequest = !['GET', 'HEAD'].includes(normalizedMethod)
    && typeof FormData !== 'undefined' && inputBody instanceof FormData
    ? new Request('http://remote.invalid/', { method: normalizedMethod, body: inputBody })
    : null
  const body = ['GET', 'HEAD'].includes(normalizedMethod)
    ? undefined
    : formDataRequest
      ? Buffer.from(await formDataRequest.arrayBuffer())
      : await bodyToBuffer(inputBody)
  const requestHeaders = new Headers(inputHeaders)
  if (body && formDataRequest && !requestHeaders.has('content-type')) {
    const contentType = formDataRequest.headers.get('content-type')
    if (contentType) requestHeaders.set('content-type', contentType)
  }
  if (body && !requestHeaders.has('content-length')) requestHeaders.set('content-length', String(body.byteLength))

  const requestModule = safeUrl.protocol === 'https:' ? https : http
  return await new Promise<Response>((resolve, reject) => {
    let settled = false
    let response: http.IncomingMessage | null = null

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      callback()
    }

    const fail = (error: unknown): void => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }

    const onAbort = (): void => {
      request?.destroy(new Error('Remote request aborted'))
      response?.destroy()
      fail(new Error('Remote request aborted'))
    }

    const request = requestModule.request({
      protocol: safeUrl.protocol,
      hostname: requestHostname,
      port: safeUrl.port || undefined,
      path: `${safeUrl.pathname}${safeUrl.search}`,
      method: normalizedMethod,
      headers: Object.fromEntries(requestHeaders.entries()),
      lookup: safeUrl.lookup,
      agent: false,
    }, (incomingResponse) => {
      response = incomingResponse
      const declaredLength = Number(incomingResponse.headers['content-length'] || 0)
      if (declaredLength > maxBytes) {
        incomingResponse.resume()
        fail(new Error('Remote response is too large'))
        request.destroy()
        return
      }

      const chunks: Buffer[] = []
      let received = 0
      incomingResponse.on('data', (chunk: Buffer | Uint8Array | string) => {
        const buffer = Buffer.from(chunk)
        received += buffer.byteLength
        if (received > maxBytes) {
          incomingResponse.destroy()
          fail(new Error('Remote response is too large'))
          return
        }
        chunks.push(buffer)
      })
      incomingResponse.on('aborted', () => fail(new Error('Remote response aborted')))
      incomingResponse.on('error', fail)
      incomingResponse.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks)
        const headers = responseHeaderEntries(incomingResponse.headers)
        headers.delete('content-length')
        finish(() => resolve(new Response(responseBody(bodyBuffer), {
          status: incomingResponse.statusCode || 0,
          statusText: incomingResponse.statusMessage || '',
          headers,
        })))
      })
    })

    request.on('error', fail)
    request.setTimeout(Math.max(1, timeoutMs), () => {
      request.destroy(new Error('Remote request timed out'))
      fail(new Error('Remote request timed out'))
    })
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    request.end(body)
  })
}

/** Validate once and pin the connection to these addresses, keeping Host/TLS hostname intact. */
export const assertSafeRemoteHttpUrl = async (rawUrl: string): Promise<SafeRemoteHttpUrl> => {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    throw new Error('Invalid remote URL')
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Invalid remote URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs are allowed')
  }
  if (isBlockedHostname(url.hostname)) throw new Error('Private network URL is not allowed')

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const hostnameIsIpLiteral = isIP(hostname) !== 0
  const addresses = await lookupRemoteAddresses(hostname)
  const hasPrivateAddress = addresses.some(address => isPrivateAddress(address.address))
  const onlySyntheticAddresses = !hostnameIsIpLiteral
    && addresses.length > 0
    && addresses.every(address => isSyntheticDnsAddress(address.address))
  if (addresses.length === 0 || (hasPrivateAddress && !onlySyntheticAddresses)) {
    throw new Error('Private network URL is not allowed')
  }
  const lookup: LookupFunction = (requestedHostname, options, callback) => {
    const family = Number(options.family) || 0
    const candidates = addresses.filter(address => !family || address.family === family)
    if (requestedHostname !== hostname || candidates.length === 0) {
      callback(new Error('No validated address for requested host'), '', 0)
      return
    }
    if (options.all) callback(null, candidates)
    else callback(null, candidates[0].address, candidates[0].family)
  }
  return Object.assign(url, { lookup })
}
