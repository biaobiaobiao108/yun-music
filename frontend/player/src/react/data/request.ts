import { resolveApiError } from '../../../../shared/src/http'
import { getSessionGeneration } from '../session'

export type RequestPolicy = {
  cacheKey?: string
  cacheTtlMs?: number
  force?: boolean
}

export type PlayerRequestInit = RequestInit & RequestPolicy & {
  fetcher?: typeof fetch
}

export class ApiRequestError extends Error {
  readonly status: number
  readonly endpoint: string
  readonly body: string

  constructor(message: string, status: number, endpoint: string, body = '') {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.endpoint = endpoint
    this.body = body
  }
}

type CacheEntry = { value: unknown; expiresAt: number }

const responseCache = new Map<string, CacheEntry>()
type PendingRequest = { promise: Promise<unknown>; controller: AbortController; consumers: number; settled: boolean }
const inFlight = new Map<string, PendingRequest>()

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(error && typeof error === 'object' && 'name' in error && (error as { name?: unknown }).name === 'AbortError')
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function joinPending<T>(entry: PendingRequest, signal?: AbortSignal): Promise<T> {
  entry.consumers += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    entry.consumers -= 1
    if (!entry.settled && entry.consumers <= 0) entry.controller.abort()
  }
  return withAbort(entry.promise as Promise<T>, signal).finally(release)
}

function cacheValue<T>(key: string, value: T, ttl: number): void {
  if (ttl <= 0) return
  responseCache.set(key, { value, expiresAt: Date.now() + ttl })
}

function readCached<T>(key: string): T | undefined {
  const entry = responseCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key)
    return undefined
  }
  return entry.value as T
}

/**
 * One request boundary for the React player.
 *
 * It provides the same JSON/error semantics for every API call, de-duplicates
 * concurrent reads with the same key, supports caller cancellation, and keeps
 * the cache deliberately memory-only so auth/session data never leaks into a
 * persistent browser store.
 */
export async function requestJson<T>(input: RequestInfo | URL, init: PlayerRequestInit = {}): Promise<T> {
  const { cacheKey, cacheTtlMs = 0, force = false, fetcher = fetch, ...requestInit } = init
  const requestCacheKey = cacheKey ? `${cacheKey}@${getSessionGeneration()}` : undefined
  if (requestInit.signal?.aborted) throw abortError()
  const cached = !force && requestCacheKey ? readCached<T>(requestCacheKey) : undefined
  if (cached !== undefined) return cached

  if (!force && requestCacheKey) {
    const pending = inFlight.get(requestCacheKey)
    if (pending) return joinPending<T>(pending, requestInit.signal ?? undefined)
  }

  const requestController = requestCacheKey ? new AbortController() : null
  const request = (async () => {
    const headers = new Headers(requestInit.headers)
    if (requestInit.body && !headers.has('Content-Type') && !(requestInit.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json')
    }
    const response = await fetcher(input, {
      ...requestInit,
      credentials: requestInit.credentials ?? 'same-origin',
      headers,
      ...(requestController ? { signal: requestController.signal } : {}),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new ApiRequestError(resolveApiError(response.status, body), response.status, String(input), body)
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  })()

  if (requestCacheKey) {
    const pending: PendingRequest = { promise: request, controller: requestController as AbortController, consumers: 0, settled: false }
    inFlight.set(requestCacheKey, pending)
    void request.then(value => cacheValue(requestCacheKey, value, cacheTtlMs), () => undefined).finally(() => {
      pending.settled = true
      if (inFlight.get(requestCacheKey) === pending) inFlight.delete(requestCacheKey)
    })
    return joinPending<T>(pending, requestInit.signal ?? undefined)
  }
  return withAbort(request, requestInit.signal ?? undefined)
}

export function invalidateRequestCache(keyOrPrefix?: string): void {
  if (!keyOrPrefix) {
    responseCache.clear()
    for (const [key, pending] of inFlight) {
      inFlight.delete(key)
      pending.controller.abort()
    }
    return
  }
  for (const key of responseCache.keys()) {
    if (key === keyOrPrefix || key.startsWith(keyOrPrefix)) responseCache.delete(key)
  }
  for (const [key, pending] of inFlight) {
    if (key === keyOrPrefix || key.startsWith(keyOrPrefix)) {
      inFlight.delete(key)
      pending.controller.abort()
    }
  }
}

export function clearRequestCache(): void {
  invalidateRequestCache()
}

export function requestCacheKeys(): string[] {
  return [...responseCache.keys()]
}

export function createRequestController(): { controller: AbortController; cancel: () => void } {
  const controller = new AbortController()
  return { controller, cancel: () => controller.abort() }
}
