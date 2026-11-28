import { assertSafeRemoteHttpUrl, fetchSafeRemote } from '../../networkSecurity'
import { acquireBufferedRequestBudget } from '../../resourceBudget'
export function decontextify(obj: any, seen = new WeakMap<object, any>()): any {
  if (obj === null || obj === undefined) return obj

  // 非对象直接返回
  if (typeof obj !== 'object') return obj
  if (seen.has(obj)) return seen.get(obj)

  // 处理 Buffer (极其重要：使用 Uint8Array 中转以切断 Proxy 链)
  try {
    if (
      Buffer.isBuffer(obj) ||
      obj instanceof Uint8Array ||
      (obj && obj.constructor && obj.constructor.name === 'Buffer')
    ) {
      const bytes = Uint8Array.from(obj as any)
      const copy = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      seen.set(obj, copy)
      return copy
    }
  } catch (e) {}

  // Rebuild multipart bodies on the host side so a sandbox-owned FormData
  // object (and its prototype chain) never crosses into the network layer.
  try {
    const isFormData =
      (typeof FormData !== 'undefined' && obj instanceof FormData) || obj?.constructor?.name === 'FormData'
    if (isFormData && typeof obj.entries === 'function') {
      const formData = new FormData()
      seen.set(obj, formData)
      for (const [key, value] of obj.entries()) {
        if (
          value &&
          typeof value === 'object' &&
          (value instanceof Blob || ['Blob', 'File'].includes(value.constructor?.name))
        ) {
          formData.append(String(key), value as Blob, String((value as any).name || 'blob'))
        } else {
          formData.append(String(key), String(value ?? ''))
        }
      }
      return formData
    }
  } catch (e) {}

  // 处理数组
  if (Array.isArray(obj)) {
    try {
      const copy: any[] = []
      seen.set(obj, copy)
      for (const item of obj) copy.push(decontextify(item, seen))
      return copy
    } catch (e) {
      return []
    }
  }

  // 处理 Error (增加对沙箱内 Error 的识别)
  if (obj instanceof Error || (obj && obj.constructor && obj.constructor.name === 'Error')) {
    const err = new Error(obj.message)
    err.stack = obj.stack
    seen.set(obj, err)
    return err
  }

  // 处理普通对象 (预防 Proxy Traps)
  try {
    const newObj: any = {}
    seen.set(obj, newObj)
    const keys = Object.keys(obj)
    for (const key of keys) {
      try {
        newObj[key] = decontextify(obj[key], seen)
      } catch (e) {}
    }
    return newObj
  } catch (e) {
    try {
      const str = JSON.stringify(obj)
      return str ? JSON.parse(str) : String(obj)
    } catch (e2) {
      return String(obj)
    }
  }
}

// 用户API信息接口
interface UserApiInfo {
  id: string
  name: string
  description: string
  version: number | string
  author: string
  homepage: string
  script: string
  sources: Record<string, any>
  enabled: boolean
  owner: string // 'open' or username
  persist?: boolean
}

// 加载的 API 实例
const loadedApis = new Map<string, any>()
const USER_API_SYNC_TIMEOUT_MS = 5_000
const USER_API_REQUEST_TIMEOUT_MS = 60_000
const USER_API_UNLOAD_TIMEOUT_MS = 10_000
const MAX_USER_API_TIMERS = 256
const MAX_USER_API_TIMER_DELAY_MS = 24 * 60 * 60 * 1000
const MAX_USER_API_UNLOAD_HANDLERS = 64

const normalizeUserApiTimerDelay = (delay: unknown, fallback = 0): number => {
  try {
    const parsed = Number(delay)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(Math.max(Math.floor(parsed), 0), MAX_USER_API_TIMER_DELAY_MS)
  } catch {
    return fallback
  }
}

// API 初始化状态追踪 map<id, status>
const apiStatus = new Map<string, { status: 'success' | 'failed'; error?: string }>()

export function getApiStatus(owner: string, id: string) {
  return apiStatus.get(`${owner}_${id}`)
}

// 从脚本注释中提取元数据
export function extractMetadata(script: string): Partial<UserApiInfo> {
  const meta: any = {}

  // 匹配 JSDoc 风格的注释 (支持 /*! 和 /**)
  const commentMatch = script.match(/\/\*[*!]([\s\S]*?)\*\//)
  if (commentMatch) {
    const comment = commentMatch[1]

    // @name
    const nameMatch = comment.match(/@name\s+(.+)/)
    if (nameMatch) meta.name = nameMatch[1].trim()

    // @description
    const descMatch = comment.match(/@description\s+(.+)/)
    if (descMatch) meta.description = descMatch[1].trim()

    // @version
    const verMatch = comment.match(/@version\s+(.+)/)
    if (verMatch) meta.version = verMatch[1].trim()

    // @author
    const authorMatch = comment.match(/@author\s+(.+)/)
    if (authorMatch) meta.author = authorMatch[1].trim()

    // @repository or @homepage
    const repoMatch = comment.match(/@(?:repository|homepage)\s+(.+)/)
    if (repoMatch) meta.homepage = repoMatch[1].trim()
  }

  return meta
}

// 创建 lx.request 包装器（基于 Bun 原生 fetch）
type CleanupRegistration = (cleanup: () => void) => () => void
type PendingRequestRegistration = (abort: () => void) => () => void
type SandboxCallbackInvoker = (handler: Function, args?: any[]) => unknown

export function createLxRequest(
  registerCleanup?: CleanupRegistration,
  registerPendingRequest?: PendingRequestRegistration,
  invokeSandboxCallback?: SandboxCallbackInvoker,
  isDisposed?: () => boolean,
) {
  return (url: string, options: any, callback: Function) => {
    if (typeof callback !== 'function') return () => {}
    const dispatchCallback = (...args: any[]) => {
      try {
        const result = invokeSandboxCallback
          ? invokeSandboxCallback(callback, decontextify(args))
          : callback.call(null, ...args)
        if (result && typeof (result as any).then === 'function') {
          void Promise.resolve(result).catch(error => {
            console.warn('[UserApi] request callback failed:', error?.message || error)
          })
        }
      } catch (error: any) {
        console.warn('[UserApi] request callback failed:', error?.message || error)
      }
    }
    if (isDisposed?.()) {
      dispatchCallback(new Error('自定义源已卸载'), null, null)
      return () => {}
    }
    const safeOptions = decontextify(options || {})
    const { method = 'get', timeout, headers, body, form, formData } = safeOptions

    let fetchBody: any = undefined
    const fetchHeaders: Record<string, string> = {}
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (v != null) fetchHeaders[k] = String(v)
      }
    }

    if (body != null) {
      fetchBody =
        typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)
          ? JSON.stringify(body)
          : body
      const hasContentType = Object.keys(fetchHeaders).some(k => k.toLowerCase() === 'content-type')
      if (typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) && !hasContentType) {
        fetchHeaders['Content-Type'] = 'application/json'
      }
    } else if (form) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(form)) {
        params.append(k, String(v ?? ''))
      }
      fetchBody = params
    } else if (formData) {
      fetchBody = formData
    }

    try {
      const bodyBytes = Buffer.isBuffer(fetchBody)
        ? fetchBody.length
        : typeof fetchBody === 'string'
          ? Buffer.byteLength(fetchBody, 'utf8')
          : 0
      if (bodyBytes > 5 * 1024 * 1024) {
        dispatchCallback(new Error('Request body is too large'), null, null)
        return () => {}
      }
    } catch (error) {
      dispatchCallback(decontextify(error), null, null)
      return () => {}
    }

    const timeoutMs = typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60000) : 60000
    const controller = new AbortController()
    let timer: any = null
    let completed = false
    let aborted = false

    const abort = () => {
      if (aborted || completed) return
      aborted = true
      try {
        controller.abort()
      } catch {}
    }

    const unregister = registerCleanup ? registerCleanup(abort) : () => {}
    const unregisterPendingRequest = registerPendingRequest ? registerPendingRequest(abort) : () => {}

    const start = async () => {
      let budgetLease: Awaited<ReturnType<typeof acquireBufferedRequestBudget>> | undefined
      try {
        budgetLease = await acquireBufferedRequestBudget(5 * 1024 * 1024, controller.signal)
        const safeUrl = await assertSafeRemoteHttpUrl(url)
        if (aborted) return

        timer = setTimeout(() => {
          abort()
        }, timeoutMs)

        const normalizedMethod = String(method || 'get').toUpperCase()
        const resp = await fetchSafeRemote(safeUrl, {
          method: normalizedMethod,
          headers: fetchHeaders,
          body: ['GET', 'HEAD'].includes(normalizedMethod) ? undefined : fetchBody,
          signal: controller.signal,
          timeoutMs,
          maxBytes: budgetLease.maxBytes,
          budgetLease,
        })

        const rawBuffer = Buffer.from(await resp.arrayBuffer())
        if (timer) {
          clearTimeout(timer)
          timer = null
        }

        completed = true

        const responseText = rawBuffer.toString('utf8')
        let parsedBody: any = responseText
        try {
          parsedBody = JSON.parse(responseText)
        } catch {}

        const headersObj: Record<string, string> = {}
        resp.headers.forEach((val, key) => {
          headersObj[key.toLowerCase()] = val
        })

        const safeResp: any = {
          statusCode: resp.status,
          statusMessage: resp.statusText,
          headers: headersObj,
          body: parsedBody,
          raw: rawBuffer,
        }

        dispatchCallback(null, safeResp, safeResp.body)
      } catch (error: any) {
        completed = true
        dispatchCallback(decontextify(error), null, null)
      } finally {
        if (timer) clearTimeout(timer)
        completed = true
        unregister()
        unregisterPendingRequest()
        budgetLease?.release()
      }
    }

    void start()

    return () => {
      unregister()
      unregisterPendingRequest()
      abort()
    }
  }
}

// 加载自定义源脚本
