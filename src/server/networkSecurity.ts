import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isIP, type LookupFunction } from 'node:net'
import { acquireBufferedRequestBudget, type BufferedRequestLease } from './resourceBudget'

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
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff')
  )
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

  const normalized = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
  // RFC 5180's 2001:2::/48 benchmarking prefix is another synthetic DNS
  // answer used by some desktop proxy resolvers alongside 198.18.0.0/15.
  if (/^2001:2:(?::|0(?::|$))/.test(normalized)) return true
  if (normalized.startsWith('fdfe:dcba:9876:')) return true

  // Some resolvers encode the same RFC 2544 fake IPv4 address as
  // `::ffff:0:c612:56` instead of the usual `::ffff:c612:56`. Decode both
  // forms so a synthetic IPv6 companion does not make an otherwise valid
  // public hostname look like a real private-network target.
  const mapped = normalized.match(/^::ffff:(?:0:)?([\da-f]{1,4}):([\da-f]{1,4})$/)
  if (!mapped) return false
  const high = parseInt(mapped[1], 16)
  const low = parseInt(mapped[2], 16)
  return isSyntheticDnsAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
}

export const isPrivateAddress = (value: string): boolean => {
  if (isIP(value) === 4) return isPrivateIpv4(value)
  return isPrivateIpv6(value)
}

/** True when a global outbound proxy is configured, i.e. fake-ip DNS is in play. */
const isOutboundProxyConfigured = (): boolean => {
  const config = global.lx?.config as unknown as Record<string, unknown> | undefined
  return Boolean(config?.['proxy.all.enabled']) && Boolean(String(config?.['proxy.all.address'] || '').trim())
}

const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === 'local'
}

export type SafeRemoteHttpUrl = URL & {
  lookup: LookupFunction
  /** Proxy may resolve the target only for literal IPs or synthetic fake-IP DNS. */
  proxyTargetResolutionSafe?: boolean
}

export interface SafeRemoteFetchOptions extends Omit<RequestInit, 'redirect'> {
  /** Caller may hold this through parsing/callback dispatch to avoid nested reservations. */
  budgetLease?: BufferedRequestLease
  /** Bun 原生 fetch 的代理扩展；配置代理时由调用方显式传入。 */
  proxy?: string
  /** 限制响应体大小，避免远端响应造成内存放大。 */
  maxBytes?: number
  /** 只需要状态与响应头时关闭连接并丢弃响应体。 */
  discardResponseBody?: boolean
  /** 仅在调用方没有提供 signal 时生效。 */
  timeoutMs?: number
}

const DEFAULT_REMOTE_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_REMOTE_RESPONSE_BYTES = 50 * 1024 * 1024
const REMOTE_DNS_TIMEOUT_MS = 5_000
const MAX_REMOTE_ADDRESS_ATTEMPTS = 8
const RETRYABLE_CONNECTION_ERRORS = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
])

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

const pinnedLookup =
  (hostname: string, addresses: readonly ResolvedRemoteAddress[]): LookupFunction =>
  (requestedHostname, options, callback) => {
    const family = Number(options.family) || 0
    const candidates = addresses.filter(address => !family || address.family === family)
    if (requestedHostname !== hostname || candidates.length === 0) {
      callback(new Error('No validated address for requested host'), '', 0)
      return
    }
    if (options.all) callback(null, candidates)
    else callback(null, candidates[0].address, candidates[0].family)
  }

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
  if (body instanceof ReadableStream) {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('Unsupported remote request body')
}

const responseBody = (body: Uint8Array): BodyInit => body as unknown as BodyInit

const hasNoResponseBody = (method: string, status: number): boolean =>
  method.toUpperCase() === 'HEAD' || [204, 205, 304].includes(status)

const responseDecoders = (encoding: string | undefined): Transform[] => {
  const codings = (encoding || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  return codings.reverse().flatMap(coding => {
    if (coding === 'identity') return []
    if (coding === 'gzip' || coding === 'x-gzip') return [createGunzip()]
    if (coding === 'deflate') return [createInflate()]
    if (coding === 'br') return [createBrotliDecompress()]
    throw new Error(`Unsupported remote content encoding: ${coding}`)
  })
}

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
  return Buffer.concat(chunks)
}

const fetchViaBunProxy = async (safeUrl: SafeRemoteHttpUrl, options: SafeRemoteFetchOptions): Promise<Response> => {
  const { proxy, signal: inputSignal, discardResponseBody, ...requestInit } = options
  const maxBytes = normalizeRemoteResponseLimit(options.maxBytes)
  const timeoutMs = normalizeRemoteTimeout(options.timeoutMs)
  const signal = inputSignal || AbortSignal.timeout(timeoutMs)
  const response = await fetch(safeUrl.href, {
    ...requestInit,
    signal,
    redirect: 'manual',
    proxy,
  } as RequestInit & { proxy: string })
  if (discardResponseBody) {
    await response.body?.cancel()
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  }
  const noBody = hasNoResponseBody(options.method || 'GET', response.status)
  const body = noBody ? null : await readResponseBody(response, maxBytes)
  const headers = new Headers(response.headers)
  if (!noBody) {
    headers.delete('content-length')
    // Bun fetch has already decompressed its response stream.
    headers.delete('content-encoding')
  }
  return new Response(body ? responseBody(body) : null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * 使用已验证的 DNS 地址发起远程请求。
 *
 * Bun fetch 目前没有 Node `lookup` 等价的连接级钉扎参数。普通域名交给
 * 代理会让代理自行解析，绕开这里验证过的地址，因此启用代理时对此类
 * 请求明确失败；代理只用于公网 IP 字面量和 fake-IP DNS。未配置代理时
 * 直连使用 node:http(s) 与固定 DNS 地址。所有响应都经过统一的字节上限处理。
 */
const fetchSafeRemoteTransport = async (
  safeUrl: SafeRemoteHttpUrl,
  options: SafeRemoteFetchOptions = {},
): Promise<Response> => {
  if (options.proxy) {
    if (safeUrl.proxyTargetResolutionSafe !== true) {
      throw new Error('全局代理无法安全地重新解析该域名；请使用 fake-IP DNS 或关闭全局代理')
    }
    return fetchViaBunProxy(safeUrl, options)
  }

  const hostname = safeUrl.hostname.replace(/^\[|\]$/g, '')
  const method = String(options.method || 'GET').toUpperCase()
  let lookups = [safeUrl.lookup]
  if (method === 'GET' || method === 'HEAD') {
    // Read the validated DNS snapshot, never resolve again during failover.
    const addresses = await new Promise<ResolvedRemoteAddress[]>((resolve, reject) => {
      safeUrl.lookup(hostname, { all: true }, (error, address, family) => {
        if (error) reject(error)
        else resolve(typeof address === 'string' ? [{ address, family: Number(family) }] : address)
      })
    })
    const unique = new Map(addresses.map(address => [`${address.family}:${address.address}`, address]))
    lookups = [...unique.values()]
      .slice(0, MAX_REMOTE_ADDRESS_ATTEMPTS)
      .map(address => pinnedLookup(hostname, [address]))
    if (lookups.length === 0) throw new Error('No validated address for requested host')
  }

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted()
    let receivedHeaders = false
    try {
      return await fetchPinnedRemote(safeUrl, options, lookups[attempt], () => {
        receivedHeaders = true
      })
    } catch (error) {
      // A response, even an HTTP error, means the request reached the server.
      // Only replay safe reads that failed before headers, within the original
      // request's signal/deadline and buffered-response reservation.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (
        options.signal?.aborted ||
        receivedHeaders ||
        attempt + 1 >= lookups.length ||
        !code ||
        !RETRYABLE_CONNECTION_ERRORS.has(code)
      )
        throw error
    }
  }
}

const fetchPinnedRemote = async (
  safeUrl: SafeRemoteHttpUrl,
  options: SafeRemoteFetchOptions,
  lookup: LookupFunction,
  onHeaders: () => void,
): Promise<Response> => {
  const { method = 'GET', headers: inputHeaders, body: inputBody, signal, discardResponseBody } = options
  const maxBytes = normalizeRemoteResponseLimit(options.maxBytes)
  const timeoutMs = normalizeRemoteTimeout(options.timeoutMs)
  const normalizedMethod = String(method).toUpperCase()
  const requestHostname = safeUrl.hostname.replace(/^\[|\]$/g, '')
  const formDataRequest =
    !['GET', 'HEAD'].includes(normalizedMethod) && typeof FormData !== 'undefined' && inputBody instanceof FormData
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
      finish(() => {
        response?.destroy()
        request.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    }

    const onAbort = (): void => {
      request?.destroy(new Error('Remote request aborted'))
      response?.destroy()
      fail(new Error('Remote request aborted'))
    }

    const request = requestModule.request(
      {
        protocol: safeUrl.protocol,
        hostname: requestHostname,
        port: safeUrl.port || undefined,
        path: `${safeUrl.pathname}${safeUrl.search}`,
        method: normalizedMethod,
        headers: Object.fromEntries(requestHeaders.entries()),
        lookup,
        agent: false,
      },
      incomingResponse => {
        response = incomingResponse
        onHeaders()
        const status = incomingResponse.statusCode || 0
        const headers = responseHeaderEntries(incomingResponse.headers)
        if (discardResponseBody || hasNoResponseBody(normalizedMethod, status)) {
          incomingResponse.destroy()
          finish(() =>
            resolve(
              new Response(null, {
                status,
                statusText: incomingResponse.statusMessage || '',
                headers,
              }),
            ),
          )
          return
        }
        const declaredLength = Number(incomingResponse.headers['content-length'] || 0)
        if (declaredLength > maxBytes) {
          fail(new Error('Remote response is too large'))
          incomingResponse.destroy()
          request.destroy()
          return
        }

        let decoders: Transform[]
        try {
          decoders = responseDecoders(incomingResponse.headers['content-encoding'])
        } catch (error) {
          fail(error)
          incomingResponse.destroy()
          request.destroy()
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        let decodedBytes = 0
        const wireLimit = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.byteLength
            callback(received > maxBytes ? new Error('Remote response is too large') : null, chunk)
          },
        })
        const collector = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            decodedBytes += chunk.byteLength
            if (decodedBytes > maxBytes) {
              callback(new Error('Remote response is too large'))
              return
            }
            chunks.push(chunk)
            callback()
          },
        })
        // Stream decompression enforces both wire and decoded limits without first
        // materializing an unbounded expanded response in memory.
        void pipeline([incomingResponse, wireLimit, ...decoders, collector])
          .then(() => {
            headers.delete('content-length')
            if (decoders.length) headers.delete('content-encoding')
            finish(() =>
              resolve(
                new Response(responseBody(Buffer.concat(chunks)), {
                  status,
                  statusText: incomingResponse.statusMessage || '',
                  headers,
                }),
              ),
            )
          })
          .catch(fail)
      },
    )

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

export const fetchSafeRemote = async (
  safeUrl: SafeRemoteHttpUrl,
  options: SafeRemoteFetchOptions = {},
): Promise<Response> => {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(normalizeRemoteTimeout(options.timeoutMs))])
    : AbortSignal.timeout(normalizeRemoteTimeout(options.timeoutMs))
  const { budgetLease: supplied, ...transportOptions } = options
  const noBody = options.discardResponseBody || String(options.method || 'GET').toUpperCase() === 'HEAD'
  const lease =
    supplied ||
    (await acquireBufferedRequestBudget(noBody ? 1024 : normalizeRemoteResponseLimit(options.maxBytes), signal))
  try {
    signal.throwIfAborted()
    return await fetchSafeRemoteTransport(safeUrl, {
      ...transportOptions,
      signal,
      maxBytes: Math.min(normalizeRemoteResponseLimit(options.maxBytes), lease.maxBytes),
    })
  } finally {
    if (!supplied) lease.release()
  }
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
  const hasPrivateAddress = addresses.some(
    address => isPrivateAddress(address.address) || isSyntheticDnsAddress(address.address),
  )
  // Fake-ip answers (198.18/15 & friends) only make sense when the connection
  // is handed to a configured proxy, which then resolves the real host. In
  // direct mode nothing routes those prefixes, so accepting them was pure
  // filter bypass.
  const onlySyntheticAddresses =
    isOutboundProxyConfigured() &&
    !hostnameIsIpLiteral &&
    addresses.length > 0 &&
    addresses.every(address => isSyntheticDnsAddress(address.address))
  if (addresses.length === 0 || (hasPrivateAddress && !onlySyntheticAddresses)) {
    throw new Error('Private network URL is not allowed')
  }
  const validatedAddresses = onlySyntheticAddresses
    ? [...addresses].sort((left, right) => Number(right.family === 4) - Number(left.family === 4))
    : addresses
  return Object.assign(url, {
    lookup: pinnedLookup(hostname, validatedAddresses),
    // With a real hostname, Bun's proxy transport would resolve it independently
    // and could reach a private address even though local DNS returned a public
    // one. Keep fake-IP compatibility: the configured proxy must resolve the
    // original hostname because the synthetic address is not the target.
    proxyTargetResolutionSafe: hostnameIsIpLiteral || onlySyntheticAddresses,
  })
}
