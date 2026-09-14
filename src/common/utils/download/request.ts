import { EventEmitter } from 'node:events'

export interface Options {
  method: 'get' | 'head' | 'delete' | 'patch' | 'post' | 'put'
  params?: Record<string, string>
  headers?: Record<string, string>
  timeout?: number
  proxy?: string
}

export type FetchIncomingMessage = EventEmitter & {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[] | undefined>
  complete: boolean
}

type FetchClientRequest = EventEmitter & {
  destroyed: boolean
  end: () => void
  destroy: (error?: Error) => void
}

const createResponse = (response: Response): FetchIncomingMessage => {
  const result = new EventEmitter() as FetchIncomingMessage
  result.statusCode = response.status
  result.statusMessage = response.statusText
  result.complete = false
  result.headers = {}
  response.headers.forEach((value, key) => { result.headers[key.toLowerCase()] = value })
  return result
}

const createRequest = (url: string, options: Options): FetchClientRequest => {
  const request = new EventEmitter() as FetchClientRequest
  const controller = new AbortController()
  request.destroyed = false

  request.destroy = (error?: Error) => {
    if (request.destroyed) return
    request.destroyed = true
    controller.abort()
    if (error) request.emit('error', error)
    request.emit('close')
  }

  request.end = () => {
    void (async () => {
      try {
        const target = new URL(url)
        for (const [key, value] of Object.entries(options.params || {})) target.searchParams.append(key, value)
        const fetchOptions: RequestInit & { proxy?: string } = {
          method: options.method.toUpperCase(),
          headers: options.headers,
          signal: controller.signal,
          redirect: 'manual',
        }
        if (options.proxy) fetchOptions.proxy = options.proxy

        const response = await fetch(target, fetchOptions)
        if (request.destroyed) return
        const incoming = createResponse(response)
        request.emit('response', incoming)
        if (!response.body) {
          incoming.complete = true
          incoming.emit('end')
          incoming.emit('close')
          return
        }

        try {
          for await (const chunk of response.body as any) {
            if (request.destroyed) return
            incoming.emit('data', Buffer.from(chunk))
          }
          incoming.complete = true
          incoming.emit('end')
          incoming.emit('close')
        } catch (error) {
          if (!request.destroyed) incoming.emit('error', error)
        }
      } catch (error) {
        if (!request.destroyed) request.emit('error', error)
      }
    })()
  }

  return request
}

export function request(url: string, _options: Partial<Options> = {}, callback?: (res: FetchIncomingMessage) => void) {
  const options: Options = { method: 'get', ..._options }
  const request = createRequest(url, options)
  if (callback) request.on('response', callback)
  if (options.timeout && options.timeout > 0) {
    const timeout = setTimeout(() => {
      if (!request.destroyed) request.destroy(new Error('Request timeout'))
    }, options.timeout)
    request.once('response', () => clearTimeout(timeout))
    request.once('close', () => clearTimeout(timeout))
  }
  return request
}
