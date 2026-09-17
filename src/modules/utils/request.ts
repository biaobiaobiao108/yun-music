import httpModule from 'node:http'
import httpsModule from 'node:https'
import { debugRequest } from './env'
import { requestMsg } from './message'
import { bHh } from './musicSdk/options'

const httpsRxp = /^https:/
const defaultHeaders: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

export interface HttpOptions extends Record<string, any> {
  method?: string
  headers?: Record<string, any>
  body?: any
  form?: any
  formData?: any
  format?: string
  timeout?: number
  /** Maximum response size retained in memory for one upstream API call. */
  maxBytes?: number
  json?: boolean
  jsonpCallback?: string
}

export interface HttpPromiseObject<T = any> {
  isCancelled: boolean
  cancelHttp: () => void
  promise: Promise<T>
  requestObj?: AbortController | null
  cancelFn?: ((reason?: any) => void) | null
}

type ResponseLike = {
  statusCode: number
  statusMessage: string
  headers: Record<string, string>
  raw: Buffer
}

type FetchResponse = ResponseLike & { body: any }

const hasHeader = (headers: Record<string, string>, name: string): boolean => (
  Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())
)

const isBodyObject = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' &&
  !(value instanceof ArrayBuffer) &&
  !(value instanceof Uint8Array) &&
  !(value instanceof Blob) &&
  !(value instanceof URLSearchParams) &&
  !(value instanceof FormData)
)

const toFormBody = (value: Record<string, unknown>): URLSearchParams => {
  const params = new URLSearchParams()
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      for (const nested of item) params.append(key, String(nested ?? ''))
    } else {
      params.append(key, String(item ?? ''))
    }
  }
  return params
}

const parseProxy = (proxyAddress: string | undefined): URL | undefined => {
  if (!proxyAddress) return undefined
  try {
    return new URL(proxyAddress)
  } catch {
    return undefined
  }
}

const getConfiguredProxy = (url: string): string | undefined => {
  const config = global.lx?.config || {}
  if (config['proxy.all.enabled'] && config['proxy.all.address']) {
    return String(config['proxy.all.address'])
  }

  // Bun's fetch handles HTTP(S)_PROXY and NO_PROXY itself. We only inspect an
  // environment proxy here when it is SOCKS, because that needs the retained
  // compatibility agent below.
  const envKey = httpsRxp.test(url) ? 'HTTPS_PROXY' : 'HTTP_PROXY'
  const envProxy = process.env[envKey]
  return parseProxy(envProxy)?.protocol.startsWith('socks') ? envProxy : undefined
}

const collectHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => { result[key.toLowerCase()] = value })
  return result
}

const parseBody = (raw: Buffer): any => {
  const text = raw.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const createResponse = (statusCode: number, statusMessage: string, headers: Record<string, string>, raw: Buffer): FetchResponse => ({
  statusCode,
  statusMessage,
  headers,
  raw,
  body: parseBody(raw),
})

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_ALLOWED_RESPONSE_BYTES = 50 * 1024 * 1024

const normalizeMaxResponseBytes = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_ALLOWED_RESPONSE_BYTES)
    : DEFAULT_MAX_RESPONSE_BYTES
}

const normalizeTimeout = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), 5 * 60 * 1000)
    : 15_000
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
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

const requestThroughSocks = async (
  url: string,
  options: RequestInit,
  proxyAddress: string,
  controller: AbortController,
  maxBytes: number,
): Promise<FetchResponse> => {
  const { SocksProxyAgent } = await import('socks-proxy-agent')
  const target = new URL(url)
  const agent = new SocksProxyAgent(proxyAddress)
  const requestModule = target.protocol === 'https:' ? httpsModule : httpModule
  const headers: Record<string, string> = {}
  new Headers(options.headers).forEach((value, key) => { headers[key] = value })

  return await new Promise<FetchResponse>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      controller.signal.removeEventListener('abort', abort)
      callback()
    }
    const fail = (error: unknown) => finish(() => reject(error))
    const request = requestModule.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers,
      agent,
    }, response => {
      const declaredLength = Number(response.headers['content-length'] || 0)
      if (declaredLength > maxBytes) {
        response.resume()
        request.destroy()
        fail(new Error('Remote response is too large'))
        return
      }
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', chunk => {
        const buffer = Buffer.from(chunk)
        received += buffer.byteLength
        if (received > maxBytes) {
          response.destroy()
          request.destroy()
          fail(new Error('Remote response is too large'))
          return
        }
        chunks.push(buffer)
      })
      response.on('end', () => finish(() => resolve(createResponse(
          response.statusCode || 0,
          response.statusMessage || '',
          Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')])),
          Buffer.concat(chunks),
        ))))
      response.on('aborted', () => fail(new Error('Remote response aborted')))
      response.on('error', fail)
    })

    const abort = () => {
      request.destroy(new Error(requestMsg.cancelRequest))
      fail(new Error(requestMsg.cancelRequest))
    }
    if (controller.signal.aborted) abort()
    else controller.signal.addEventListener('abort', abort, { once: true })
    request.on('error', fail)

    if (options.body != null) {
      const body = options.body instanceof URLSearchParams
        ? options.body.toString()
        : options.body instanceof Uint8Array
          ? Buffer.from(options.body)
          : options.body
      request.write(body)
    }
    request.end()
  })
}

const fetchResponse = async (
  url: string,
  options: RequestInit,
  controller: AbortController,
  maxBytes: number,
): Promise<FetchResponse> => {
  const proxy = parseProxy(getConfiguredProxy(url))
  if (proxy && proxy.protocol.startsWith('socks')) {
    return requestThroughSocks(url, options, proxy.href, controller, maxBytes)
  }

  const fetchOptions: RequestInit & { proxy?: string } = { ...options }
  if (proxy && (proxy.protocol === 'http:' || proxy.protocol === 'https:')) {
    fetchOptions.proxy = proxy.href
  }
  const response = await fetch(url, fetchOptions)
  return createResponse(response.status, response.statusText, collectHeaders(response.headers), await readResponseBody(response, maxBytes))
}

const buildBody = (options: HttpOptions, headers: Record<string, string>): BodyInit | undefined => {
  if (options.form != null) {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    return toFormBody(options.form)
  }
  if (options.formData != null) {
    if (options.formData instanceof FormData) return options.formData
    return toFormBody(options.formData)
  }

  const body = options.body ?? options.data
  if (body == null) return undefined
  if (isBodyObject(body)) {
    if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json'
    return JSON.stringify(body)
  }
  return body as BodyInit
}

const fetchData = async (
  url: string,
  method: string,
  { headers = {}, timeout = 15000, maxBytes, ...options }: HttpOptions,
  callback: (err: any, resp: FetchResponse | null, body: any) => void,
  controller = new AbortController(),
): Promise<FetchResponse> => {
  const requestHeaders: Record<string, string> = Object.assign({}, defaultHeaders, headers)
  if (requestHeaders[bHh]) {
    const path = url.replace(/^https?:\/\/[\w.:]+\//, '/')
    let s = Buffer.from(bHh, 'hex').toString()
    s = s.replace(s.substr(-1), '')
    s = Buffer.from(s, 'base64').toString()

    const v1 = '2050201'
    const v2 = '10'
    const v = v1.split('-')[0].split('.').map(n => (n.length < 3 ? n.padStart(3, '0') : n)).join('')
    const payload = Buffer.from(JSON.stringify(`${path}${v}`.match(/(?:\d\w)+/g), null, 1).concat(v)).toString('base64')
    requestHeaders[s] = `${Buffer.from(Bun.deflateSync(Buffer.from(payload))).toString('hex')}&${parseInt(v, 10)}${v2}`
    delete requestHeaders[bHh]
  }

  const normalizedMethod = String(method || 'get').toUpperCase()
  const body = ['GET', 'HEAD'].includes(normalizedMethod) ? undefined : buildBody(options, requestHeaders)
  const responseLimit = normalizeMaxResponseBytes(maxBytes)
  const timeoutMs = normalizeTimeout(timeout)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let callbackStarted = false
  try {
    timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
    timeoutHandle.unref?.()
    const response = await fetchResponse(url, {
      method: normalizedMethod,
      headers: requestHeaders,
      body,
      signal: controller.signal,
      redirect: 'follow',
    }, controller, responseLimit)
    callbackStarted = true
    callback(null, response, response.body)
    return response
  } catch (error) {
    if (!callbackStarted) callback(error, null, null)
    throw error
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

const buildHttpPromise = <T = any>(url: string, options: HttpOptions): HttpPromiseObject<T> => {
  const controller = new AbortController()
  const obj: HttpPromiseObject<T> = {
    isCancelled: false,
    requestObj: controller,
    cancelHttp: () => {
      if (obj.isCancelled) return
      obj.isCancelled = true
      controller.abort()
      if (obj.cancelFn) obj.cancelFn(new Error(requestMsg.cancelRequest))
      obj.cancelFn = null
      obj.requestObj = null
    },
    promise: Promise.resolve() as Promise<T>,
  }

  obj.promise = new Promise<T>((resolve, reject) => {
    obj.cancelFn = reject
    if (debugRequest) console.log(`\n---send request------${url}------------`)
    void fetchData(url, options.method || 'get', options, (err, _resp, body) => {
      if (debugRequest) console.log(`\n---response------${url}------------\n`, body)
      if (err) {
        reject(err)
        return
      }
      resolve(_resp as T)
    }, controller).catch(() => undefined).finally(() => {
      obj.requestObj = null
      obj.cancelFn = null
    })
  })
  return obj
}

export const httpFetch = <T = any>(url: string, options: HttpOptions = { method: 'get' }): HttpPromiseObject<T> => {
  const requestObj = buildHttpPromise<T>(url, options)
  requestObj.promise = requestObj.promise.catch((err: any) => {
    if (err?.message === 'socket hang up') return Promise.reject(new Error(requestMsg.unachievable))
    if (err?.name === 'AbortError') return Promise.reject(new Error(requestMsg.timeout))
    switch (err?.code) {
      case 'ETIMEDOUT':
      case 'ESOCKETTIMEDOUT':
        return Promise.reject(new Error(requestMsg.timeout))
      case 'ENOTFOUND':
        return Promise.reject(new Error(requestMsg.notConnectNetwork))
      default:
        return Promise.reject(err)
    }
  }) as Promise<T>
  return requestObj
}

export const cancelHttp = (requestObj: AbortController | { abort?: () => void } | null | undefined): void => {
  requestObj?.abort?.()
}

export const http = (url: string, options: any, cb?: (err: any, resp: any, body: any) => void): Promise<any> => {
  if (typeof options === 'function') {
    cb = options
    options = {}
  }
  options ||= {}
  if (options.method == null) options.method = 'get'
  if (debugRequest) console.log(`\n---send request------${url}------------`)
  return fetchData(url, options.method, options, (err, resp, body) => {
    if (debugRequest) console.log(`\n---response------${url}------------\n`, body)
    if (err && debugRequest) console.log(JSON.stringify(err))
    cb?.(err, resp, body)
  })
}

export const httpGet = (url: string, options: any, callback?: (err: any, resp: any, body: any) => void): Promise<any> => {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  options ||= {}
  return http(url, { ...options, method: 'get' }, callback)
}

export const httpPost = (url: string, data: any, options: any, callback?: (err: any, resp: any, body: any) => void): Promise<any> => {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  options ||= {}
  return http(url, { ...options, method: 'post', data }, callback)
}

export const http_jsonp = (url: string, options: any, callback?: (err: any, resp: any, body: any) => void): Promise<any> => {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  options ||= {}
  const jsonpCallback = 'jsonpCallback'
  const separator = url.includes('?') ? '&' : '?'
  const jsonpUrl = `${url}${separator}${options.jsonpCallback || 'callback'}=${jsonpCallback}`
  return http(jsonpUrl, { ...options, method: 'get' }, (err, resp, body) => {
    if (!err && typeof body === 'string') {
      try { body = JSON.parse(body.replace(new RegExp(`^${jsonpCallback}\\(({.*})\\)$`), '$1')) } catch { }
    }
    callback?.(err, resp, body)
  })
}

export const checkUrl = (url: string, options: HttpOptions = {}): Promise<void> => (
  fetchData(url, 'head', options, () => {}).then(resp => {
    if (resp.statusCode !== 200) throw new Error(resp.statusCode.toString() || 'Request failed')
  }).then(() => undefined)
)
