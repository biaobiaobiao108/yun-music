export const GENERIC_ERROR_MESSAGE = '请求失败，请稍后重试'
export const SESSION_EXPIRED_MESSAGE = '登录状态已过期，请重新登录'

function hasChinese(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}

export function resolveApiError(status: number, rawBody: string): string {
  const body = rawBody.trim()
  if (body) {
    let candidate: unknown = body
    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        const parsed = JSON.parse(body) as { message?: unknown; error?: unknown }
        candidate = parsed?.message ?? parsed?.error
      } catch {
        candidate = null
      }
    }
    if (typeof candidate === 'string' && hasChinese(candidate) && candidate.trim()) return candidate.trim()
  }
  if (status === 401) return SESSION_EXPIRED_MESSAGE
  if (status === 403) return '没有权限执行此操作'
  if (status === 404) return '请求的内容不存在'
  if (status === 429) return '请求过于频繁，请稍后重试'
  return GENERIC_ERROR_MESSAGE
}

export async function requestJson<T>(input: RequestInfo | URL, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(input, {
    ...init,
    credentials: init.credentials ?? 'same-origin',
    headers,
  })
  if (!response.ok) {
    throw new Error(resolveApiError(response.status, await response.text().catch(() => '')))
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

export async function requestBlob(input: RequestInfo | URL, init: RequestInit = {}): Promise<Blob> {
  const response = await fetch(input, { ...init, credentials: init.credentials ?? 'same-origin' })
  if (!response.ok) throw new Error(resolveApiError(response.status, await response.text().catch(() => '')))
  return response.blob()
}
