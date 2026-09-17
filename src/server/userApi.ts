import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'node:vm'

import * as crypto from 'crypto'

import { assertSafeRemoteHttpUrl, fetchSafeRemote } from './networkSecurity'
import { assertSafePathSegment, resolveInside } from '@/utils/pathSecurity'
import { isRetiredOnlineSource, UnsupportedSourceError } from '@/common/musicSources'

function writeJsonFileAtomic(filePath: string, value: unknown): void {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    try {
        fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf-8')
        fs.renameSync(tempPath, filePath)
    } finally {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath) } catch { }
        }
    }
}

// 彻底切断与沙箱上下文的联系
function decontextify(obj: any): any {
    if (obj === null || obj === undefined) return obj

    // 非对象直接返回
    if (typeof obj !== 'object') return obj

    // 处理 Buffer (极其重要：使用 Uint8Array 中转以切断 Proxy 链)
    try {
        if (Buffer.isBuffer(obj) || obj instanceof Uint8Array || (obj && obj.constructor && obj.constructor.name === 'Buffer')) {
            return Buffer.from(Uint8Array.from(obj as any))
        }
    } catch (e) { }

    // Rebuild multipart bodies on the host side so a sandbox-owned FormData
    // object (and its prototype chain) never crosses into the network layer.
    try {
        const isFormData = (typeof FormData !== 'undefined' && obj instanceof FormData)
            || obj?.constructor?.name === 'FormData'
        if (isFormData && typeof obj.entries === 'function') {
            const formData = new FormData()
            for (const [key, value] of obj.entries()) {
                if (value && typeof value === 'object' && (value instanceof Blob || ['Blob', 'File'].includes(value.constructor?.name))) {
                    formData.append(String(key), value as Blob, String((value as any).name || 'blob'))
                } else {
                    formData.append(String(key), String(value ?? ''))
                }
            }
            return formData
        }
    } catch (e) { }

    // 处理数组
    if (Array.isArray(obj)) {
        try {
            return obj.map(item => decontextify(item))
        } catch (e) {
            return []
        }
    }

    // 处理 Error (增加对沙箱内 Error 的识别)
    if (obj instanceof Error || (obj && obj.constructor && obj.constructor.name === 'Error')) {
        const err = new Error(obj.message)
        err.stack = obj.stack
        return err
    }

    // 处理普通对象 (预防 Proxy Traps)
    try {
        const newObj: any = {}
        const keys = Object.keys(obj)
        for (const key of keys) {
            try {
                newObj[key] = decontextify(obj[key])
            } catch (e) { }
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
const apiStatus = new Map<string, { status: 'success' | 'failed', error?: string }>()

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

function createLxRequest(
    registerCleanup?: CleanupRegistration,
    registerPendingRequest?: PendingRequestRegistration,
    invokeSandboxCallback?: SandboxCallbackInvoker,
    isDisposed?: () => boolean,
) {
    return (url: string, options: any, callback: Function) => {
        if (typeof callback !== 'function') return () => { }
        const dispatchCallback = (...args: any[]) => {
            try {
                const result = invokeSandboxCallback
                    ? invokeSandboxCallback(callback, args.map(decontextify))
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
            return () => { }
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
            fetchBody = typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)
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
                return () => { }
            }
        } catch (error) {
            dispatchCallback(decontextify(error), null, null)
            return () => { }
        }

        const timeoutMs = typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, 60000) : 60000
        const controller = new AbortController()
        let timer: any = null
        let completed = false
        let aborted = false

        const abort = () => {
            if (aborted || completed) return
            aborted = true
            try { controller.abort() } catch { }
        }

        const unregister = registerCleanup ? registerCleanup(abort) : () => { }
        const unregisterPendingRequest = registerPendingRequest ? registerPendingRequest(abort) : () => { }

        const start = async () => {
            try {
                const safeUrl = await assertSafeRemoteHttpUrl(url)
                if (aborted) return

                timer = setTimeout(() => {
                    abort()
                }, timeoutMs)

                const normalizedMethod = String(method || 'get').toUpperCase()
                const config = global.lx?.config || {}
                const proxy = config['proxy.all.enabled'] && config['proxy.all.address']
                    ? String(config['proxy.all.address'])
                    : undefined
                const resp = await fetchSafeRemote(safeUrl, {
                    method: normalizedMethod,
                    headers: fetchHeaders,
                    body: ['GET', 'HEAD'].includes(normalizedMethod) ? undefined : fetchBody,
                    signal: controller.signal,
                    timeoutMs,
                    maxBytes: 5 * 1024 * 1024,
                    proxy,
                })
                if (timer) clearTimeout(timer)

                const rawBuffer = Buffer.from(await resp.arrayBuffer())

                completed = true
                unregister()
                unregisterPendingRequest()

                const responseText = rawBuffer.toString('utf8')
                let parsedBody: any = responseText
                try {
                    parsedBody = JSON.parse(responseText)
                } catch { }

                const headersObj: Record<string, string> = {}
                resp.headers.forEach((val, key) => {
                    headersObj[key.toLowerCase()] = val
                })

                const safeResp: any = {
                    statusCode: resp.status,
                    statusMessage: resp.statusText,
                    headers: decontextify(headersObj),
                    body: decontextify(parsedBody),
                    raw: rawBuffer,
                }

                dispatchCallback(null, safeResp, safeResp.body)
            } catch (error: any) {
                if (timer) clearTimeout(timer)
                completed = true
                unregister()
                unregisterPendingRequest()
                dispatchCallback(decontextify(error), null, null)
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
export async function loadUserApi(apiInfo: UserApiInfo): Promise<any> {
    // 从脚本中提取元数据
    const metadata = extractMetadata(apiInfo.script)
    const fullApiInfo = { ...apiInfo, ...metadata }

    // 创建事件处理映射
    const eventHandlers = new Map<string, Function>()
    const unloadHandlers = new Set<Function>()
    const cleanupHandlers = new Set<() => void>()
    const timeoutHandles = new Set<ReturnType<typeof setTimeout>>()
    const intervalHandles = new Set<ReturnType<typeof setInterval>>()
    const pendingRequestAborts = new Set<() => void>()
    let registeredSources: any = {}
    let disposed = false
    let vmContext: vm.Context | null = null
    let callbackScript: vm.Script | null = null
    let sandbox: any = null

    const invokeSandboxCallback = (handler: Function, args: any[] = []): unknown => {
        if (!vmContext || !callbackScript || !sandbox) return undefined
        sandbox.__lxCallbackHandler = handler
        sandbox.__lxCallbackArgs = args
        try {
            return callbackScript.runInContext(vmContext, {
                timeout: USER_API_SYNC_TIMEOUT_MS,
                displayErrors: true,
            })
        } finally {
            delete sandbox.__lxCallbackHandler
            delete sandbox.__lxCallbackArgs
        }
    }

    const registerCleanup = (cleanup: () => void) => {
        cleanupHandlers.add(cleanup)
        return () => cleanupHandlers.delete(cleanup)
    }
    const runTimerCallback = (handler: (...args: any[]) => void, args: any[]): void => {
        try {
            const result = invokeSandboxCallback(handler, args)
            if (result && typeof (result as any).then === 'function') {
                void Promise.resolve(result).catch(error => {
                    console.warn(`[UserApi-${fullApiInfo.name}] timer callback failed:`, error?.message || error)
                })
            }
        } catch (error: any) {
            console.warn(`[UserApi-${fullApiInfo.name}] timer callback failed:`, error?.message || error)
        }
    }
    const trackedSetTimeout = (handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (disposed) throw new Error('自定义源已卸载')
        if (timeoutHandles.size + intervalHandles.size >= MAX_USER_API_TIMERS) {
            throw new Error('自定义源定时器数量超过限制')
        }
        let timer: ReturnType<typeof setTimeout>
        timer = setTimeout(() => {
            timeoutHandles.delete(timer)
            runTimerCallback(handler, args)
        }, normalizeUserApiTimerDelay(delay))
        timer.unref?.()
        timeoutHandles.add(timer)
        return timer
    }
    const trackedClearTimeout = (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer)
        timeoutHandles.delete(timer)
    }
    const trackedSetInterval = (handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        if (disposed) throw new Error('自定义源已卸载')
        if (timeoutHandles.size + intervalHandles.size >= MAX_USER_API_TIMERS) {
            throw new Error('自定义源定时器数量超过限制')
        }
        const timer = setInterval(() => runTimerCallback(handler, args), Math.max(10, normalizeUserApiTimerDelay(delay, 10)))
        timer.unref?.()
        intervalHandles.add(timer)
        return timer
    }
    const trackedClearInterval = (timer: ReturnType<typeof setInterval>) => {
        clearInterval(timer)
        intervalHandles.delete(timer)
    }

    const dispose = async () => {
        if (disposed) return
        disposed = true
        // Stop background activity before invoking user-provided unload hooks;
        // otherwise a stuck hook can keep timers and network requests alive.
        for (const timer of timeoutHandles) clearTimeout(timer)
        for (const timer of intervalHandles) clearInterval(timer)
        for (const abort of pendingRequestAborts) {
            try { abort() } catch { }
        }
        timeoutHandles.clear()
        intervalHandles.clear()
        pendingRequestAborts.clear()
        for (const handler of unloadHandlers) {
            let unloadTimeout: ReturnType<typeof setTimeout> | null = null
            try {
                await Promise.race([
                    Promise.resolve(invokeSandboxCallback(handler)),
                    new Promise<never>((_, reject) => {
                        unloadTimeout = setTimeout(() => reject(new Error('自定义源卸载处理超时')), USER_API_UNLOAD_TIMEOUT_MS)
                        unloadTimeout.unref?.()
                    }),
                ])
            } catch (error: any) {
                console.warn(`[UserApi-${fullApiInfo.name}] unload handler failed:`, error?.message || error)
            } finally {
                if (unloadTimeout) clearTimeout(unloadTimeout)
            }
        }
        unloadHandlers.clear()
        for (const cleanup of cleanupHandlers) {
            try { cleanup() } catch { }
        }
        cleanupHandlers.clear()
        eventHandlers.clear()
    }

    // ========== 关键修改：提前创建 initPromise ==========
    let initResolve: (() => void) | null = null
    let initReject: ((err: Error) => void) | null = null
    const initPromise = new Promise<void>((resolve, reject) => {
        initResolve = resolve
        initReject = reject
    })
    // ==================================================

    // lx 环境数据准备
    const lxDataInside = {
        version: '2.0.0',
        env: 'desktop',
        platform: 'web',
        currentScriptInfo: {
            name: fullApiInfo.name,
            description: fullApiInfo.description,
            version: fullApiInfo.version,
            author: fullApiInfo.author,
            homepage: fullApiInfo.homepage,
            rawScript: fullApiInfo.script,
        },
        EVENT_NAMES: {
            request: 'request',
            inited: 'inited',
            updateAlert: 'updateAlert'
        }
    }

    // 构建 lx 工具集
    const lxUtils = {
        buffer: {
            from: (d: any, e: any) => Buffer.from(decontextify(d), decontextify(e)),
            bufToString: (b: any, f: any) => Buffer.isBuffer(b) ? b.toString(f) : Buffer.from(b, 'binary').toString(f)
        },
        crypto: {
            md5: (str: string) => crypto.createHash('md5').update((decontextify(str) || '') as any).digest('hex'),
            aesEncrypt: (buffer: any, mode: string, key: any, iv: any) => {
                const dKey = decontextify(key)
                const dIv = decontextify(iv)
                const dBuffer = decontextify(buffer)
                const algorithm = `aes-${(dKey as any).length * 8}-${mode}`
                const cipher = crypto.createCipheriv(algorithm as any, dKey as any, dIv as any)
                return Buffer.concat([cipher.update(dBuffer as any) as any, cipher.final() as any])
            },
            rsaEncrypt: (buffer: any, key: any) => crypto.publicEncrypt(decontextify(key) as any, decontextify(buffer) as any),
            randomBytes: (size: number) => crypto.randomBytes(size),
        },
        zlib: {
            inflate: async (buffer: any) => {
                const u8 = decontextify(buffer)
                return Buffer.from(Bun.inflateSync(u8))
            },
            deflate: async (buffer: any) => {
                const u8 = decontextify(buffer)
                return Buffer.from(Bun.deflateSync(u8))
            },
        }
    }

    // 核心 lx 对象
    const lxObject = {
        ...lxDataInside,
        utils: lxUtils,
        request: createLxRequest(registerCleanup, (abort) => {
            pendingRequestAborts.add(abort)
            return () => pendingRequestAborts.delete(abort)
        }, invokeSandboxCallback, () => disposed),
        send: (eventName: string, data: any) => {
            const dData = decontextify(data)
            // console.log(`[UserApi-${fullApiInfo.name}] send:`, eventName)
            if (eventName === 'inited') {
                if (dData && dData.sources) {
                    registeredSources = dData.sources
                    console.log(`[UserApi-${fullApiInfo.name}] Registered sources:`, Object.keys(registeredSources).join(', '))
                }
                if (initResolve) initResolve()
            } else if (eventName === 'updateAlert') {
                const error = new Error(`发现新版本,需要更新: ${JSON.stringify(dData)}`)
                if (initReject) initReject(error)
            }
        },
        on: (eventName: string, handler: Function) => {
            if (disposed) throw new Error('自定义源已卸载')
            // console.log(`[UserApi-${fullApiInfo.name}] on:`, eventName)
            if (eventName === 'request') {
                eventHandlers.set(eventName, handler)
            } else if (eventName === 'unload') {
                if (typeof handler !== 'function') throw new Error('自定义源 unload 处理器格式无效')
                if (!unloadHandlers.has(handler) && unloadHandlers.size >= MAX_USER_API_UNLOAD_HANDLERS) {
                    throw new Error('自定义源 unload 处理器数量超过限制')
                }
                unloadHandlers.add(handler)
            }
        }
    }

    // 完整沙箱环境
    sandbox = {
        console: {
            log: (...args: any[]) => console.log(`[CustomSource:${fullApiInfo.name}]`, ...args.map(decontextify)),
            info: (...args: any[]) => console.info(`[CustomSource:${fullApiInfo.name}]`, ...args.map(decontextify)),
            warn: (...args: any[]) => console.warn(`[CustomSource:${fullApiInfo.name}]`, ...args.map(decontextify)),
            error: (...args: any[]) => console.error(`[CustomSource:${fullApiInfo.name}]`, ...args.map(decontextify)),
            debug: () => { },
        },
        setTimeout: trackedSetTimeout,
        clearTimeout: trackedClearTimeout,
        setInterval: trackedSetInterval,
        clearInterval: trackedClearInterval,
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        process: {
            nextTick: (fn: Function, ...args: any[]) => trackedSetTimeout(() => fn(...args), 0),
            env: { NODE_ENV: process.env.NODE_ENV || 'production' }
        },
        lx: lxObject,
        // 关键：适配混淆脚本对全局变量的引用
        global: null,
        window: null,
        globalThis: null,
        atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
        // Do not expose the host crypto module or other native capabilities.
        crypto: undefined,
    }
    sandbox.global = sandbox
    sandbox.window = sandbox
    sandbox.globalThis = sandbox

    try {
        vmContext = vm.createContext(sandbox, {
            name: `custom-source:${fullApiInfo.name}`,
            codeGeneration: { strings: false, wasm: false },
        })
        callbackScript = new vm.Script('__lxCallbackHandler(...__lxCallbackArgs)', {
            filename: `${fullApiInfo.name || apiInfo.id || 'custom-source'}:callback`,
        })
        const script = new vm.Script(apiInfo.script, {
            filename: `${fullApiInfo.name || apiInfo.id || 'custom-source'}.js`,
        })
        await script.runInContext(vmContext, { timeout: 10000, displayErrors: true })
        const requestScript = new vm.Script('__lxRequestHandler(__lxRequestInput)', {
            filename: `${fullApiInfo.name || apiInfo.id || 'custom-source'}:request`,
        })
        const activeVmContext = vmContext
        if (!activeVmContext) throw new Error('自定义源沙箱初始化失败')

        // 等待脚本调用 lx.send('inited')（最多等待 3 秒）
        let initTimeout: ReturnType<typeof setTimeout> | null = null
        try {
            await Promise.race([
                initPromise,
                new Promise((_, reject) => {
                    initTimeout = setTimeout(() => reject(new Error('初始化超时，请确保脚本调用了 lx.send("inited", ...)')), 3000)
                })
            ])
        } finally {
            if (initTimeout) clearTimeout(initTimeout)
        }

        // 保存加载 of the API
        const apiInstance = {
            info: { ...fullApiInfo, sources: registeredSources },
            handlers: eventHandlers,
            dispose,
            callRequest: async (action: string, source: string, info: any) => {
                let abortRequestsStartedByCall: (() => void) | undefined
                try {
                    if (disposed) throw new Error(`源 ${fullApiInfo.name} 已卸载`)
                    const handler = eventHandlers.get('request')
                    if (!handler) throw new Error(`源 ${fullApiInfo.name} 未注册 request 处理器`)

                    const requestsBeforeCall = new Set(pendingRequestAborts)
                    abortRequestsStartedByCall = () => {
                        for (const abort of pendingRequestAborts) {
                            if (requestsBeforeCall.has(abort)) continue
                            try { abort() } catch { }
                        }
                    }

                    // 始终将请求参数作为 JSON 数据重新构造，避免把宿主原型链传入脚本上下文。
                    const serializedInput = JSON.stringify({ action, source, info })
                    const inputData = vm.runInContext(`JSON.parse(${JSON.stringify(serializedInput)})`, activeVmContext)

                    // Run the synchronous part inside vm's interruptible
                    // execution path; direct host calls would allow an
                    // uploaded source to block the entire Bun event loop.
                    sandbox.__lxRequestHandler = handler
                    sandbox.__lxRequestInput = inputData
                    let handlerResult: unknown
                    try {
                        handlerResult = requestScript.runInContext(activeVmContext, {
                            timeout: USER_API_SYNC_TIMEOUT_MS,
                            displayErrors: true,
                        })
                    } finally {
                        delete sandbox.__lxRequestHandler
                        delete sandbox.__lxRequestInput
                    }

                    let requestTimeout: ReturnType<typeof setTimeout> | undefined
                    try {
                        const result = await Promise.race([
                            Promise.resolve(handlerResult),
                            new Promise<never>((_, reject) => {
                                requestTimeout = setTimeout(() => {
                                    abortRequestsStartedByCall?.()
                                    reject(new Error('自定义源请求超时'))
                                }, USER_API_REQUEST_TIMEOUT_MS)
                                requestTimeout.unref?.()
                            }),
                        ])
                        return decontextify(result)
                    } finally {
                        if (requestTimeout) clearTimeout(requestTimeout)
                    }
                } catch (e: any) {
                    if (/Script execution timed out after 5000ms/.test(String(e?.message || ''))) {
                        abortRequestsStartedByCall?.()
                        throw new Error('自定义源同步处理超时')
                    }
                    console.error(`[UserApi-${fullApiInfo.name}] callRequest Error:`, e.message)
                    throw e
                }
            }
        }

        if (apiInfo.persist !== false) {
            loadedApis.set(`${fullApiInfo.owner}_${apiInfo.id}`, apiInstance)
        }
        console.log(`[UserApi] ✓ 成功加载: ${fullApiInfo.name} v${fullApiInfo.version} (Owner: ${fullApiInfo.owner})`)
        console.log(`[UserApi]   支持源: ${Object.keys(registeredSources).join(', ')}`)
        return { success: true, apiInstance, error: null }
    } catch (error: any) {
        await dispose()
        console.error(`[UserApi] ✗ 加载失败 ${fullApiInfo.name}:`, error.message)
        if (error.stack) {
            console.error(`[UserApi] [Stack] ${fullApiInfo.name}:`, error.stack)
        }
        return { success: false, apiInstance: null, error: error.message }
    }
}

// 调用自定义源的 getMusicUrl
export async function callUserApiGetMusicUrl(
    source: string,
    songInfo: any,
    quality: string,
    clientUsername?: string,
    onProgress?: (attempt: any) => Promise<void> | void,
    enableAutoSwitchApiSource?: boolean
): Promise<{ url: string, type: string, sourceName?: string, attempts?: any[] }> {
    if (isRetiredOnlineSource(source)) {
        throw new UnsupportedSourceError(source)
    }
    if (clientUsername && clientUsername !== 'default' && clientUsername !== 'open' && clientUsername !== '_open') {
        clientUsername = assertSafePathSegment(clientUsername, 'username')
    }
    // 标准化 songInfo 格式：将 meta 中的字段提升到顶层
    const normalizedSongInfo = { ...songInfo }
    if (songInfo.meta) {
        // 将 meta 中的所有字段展开到顶层
        Object.assign(normalizedSongInfo, songInfo.meta)

        // ========== 通用字段映射 ==========
        // songId -> songmid (通用)
        if (songInfo.meta.songId && !normalizedSongInfo.songmid) {
            normalizedSongInfo.songmid = songInfo.meta.songId
        }

        // 图片字段统一
        if (songInfo.meta.picUrl && !normalizedSongInfo.img) {
            normalizedSongInfo.img = songInfo.meta.picUrl
        }

        // 音质信息
        if (songInfo.meta.qualitys && !normalizedSongInfo.types) {
            normalizedSongInfo.types = songInfo.meta.qualitys
        }
        if (songInfo.meta._qualitys && !normalizedSongInfo._types) {
            normalizedSongInfo._types = songInfo.meta._qualitys
        }

        // ========== 各平台特有字段 ==========
        if (songInfo.meta.albumId && !normalizedSongInfo.albumId) {
            normalizedSongInfo.albumId = songInfo.meta.albumId
        }

        // QQ音乐 (tx): strMediaMid, albumMid
        if (songInfo.meta.strMediaMid && !normalizedSongInfo.strMediaMid) {
            normalizedSongInfo.strMediaMid = songInfo.meta.strMediaMid
        }
        if (songInfo.meta.albumMid && !normalizedSongInfo.albumMid) {
            normalizedSongInfo.albumMid = songInfo.meta.albumMid
        }

        // 不再删除 meta 对象，以免有些严谨的脚本报错（许多脚本会读取 info.meta）
        // delete normalizedSongInfo.meta
    }

    // ========== 顶层字段兜底映射 ==========
    if (!normalizedSongInfo.hash && songInfo.hash) {
        normalizedSongInfo.hash = songInfo.hash
    }
    if (!normalizedSongInfo.copyrightId && songInfo.copyrightId) {
        normalizedSongInfo.copyrightId = songInfo.copyrightId
    }
    if (!normalizedSongInfo.strMediaMid && songInfo.strMediaMid) {
        normalizedSongInfo.strMediaMid = songInfo.strMediaMid
    }
    if (!normalizedSongInfo.albumMid && songInfo.albumMid) {
        normalizedSongInfo.albumMid = songInfo.albumMid
    }
    if (!normalizedSongInfo.albumId && songInfo.albumId) {
        normalizedSongInfo.albumId = songInfo.albumId
    }
    if (!normalizedSongInfo.lrcUrl && songInfo.lrcUrl) {
        normalizedSongInfo.lrcUrl = songInfo.lrcUrl
    }
    if (!normalizedSongInfo.mrcUrl && songInfo.mrcUrl) {
        normalizedSongInfo.mrcUrl = songInfo.mrcUrl
    }
    if (!normalizedSongInfo.trcUrl && songInfo.trcUrl) {
        normalizedSongInfo.trcUrl = songInfo.trcUrl
    }
    if (typeof normalizedSongInfo.hash === 'string' && !normalizedSongInfo.hash) {
        delete normalizedSongInfo.hash
    }

    let supportedCount = 0;
    let lastError: Error | null = null;
    const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
    const sourceRoot = path.join(dataPath, 'users', 'source')

    // 查找支持该 source 的 API
    // 收集所有支持该 source 的 API，并根据权限过滤
    let candidates: any[] = []
    const userApiIds = new Set<string>()

    // 读取当前用户的公开源状态覆盖（启用/禁用）以及私有源 ID 集合
    let userStates: Record<string, any> = {}
    if (clientUsername && clientUsername !== 'default') {
        const userPath = resolveInside(sourceRoot, clientUsername)
        const statesPath = path.join(userPath, 'states.json')
        const metaPath = path.join(userPath, 'sources.json')

        if (fs.existsSync(statesPath)) {
            try { userStates = JSON.parse(fs.readFileSync(statesPath, 'utf-8')) } catch (e) { }
        }
        // 预收集私有源 ID（用于屏蔽同名公开源）
        if (fs.existsSync(metaPath)) {
            try {
                const userSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
                for (const s of userSources) userApiIds.add(s.id)
            } catch (e) { }
        }
    }

    // 按 loadedApis 收集所有可用候选源（权限过滤，不强制任何顺序）
    for (const [apiId, api] of loadedApis) {
        if (!api.info.sources || !api.info.sources[source]) continue

        if (api.info.owner === 'open') {
            // 计算公开源对当前用户的有效启用状态
            let isEnabled = api.info.enabled
            if (clientUsername && clientUsername !== 'default' && userStates[api.info.id]) {
                if (typeof userStates[api.info.id].enabled === 'boolean') {
                    isEnabled = userStates[api.info.id].enabled
                }
            }
            if (!isEnabled) continue
            if (userApiIds.has(api.info.id)) continue  // 被同名私有版本覆盖，跳过
            candidates.push(api)
        } else if (clientUsername && api.info.owner === clientUsername) {
            if (!api.info.enabled) continue
            candidates.push(api)
            userApiIds.add(api.info.id) // 兜底：确保后续不重复添加公开同名源
        }
    }

    // === 实时按 order.json 对候选列表排序 ===
    // 不依赖 loadedApis 的 Map 插入顺序（部分 reload 后顺序会乱），
    // 每次解析都直接读 order.json，无需重启服务器即可生效
    if (candidates.length > 1) {
        const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
        let orderData: string[] = []

        // 优先读用户自己的排序（admin/order.json），再回退到公开源排序（_open/order.json）
        const orderCandidates = clientUsername && clientUsername !== 'default'
            ? [
                resolveInside(sourceRoot, clientUsername, 'order.json'),
                resolveInside(sourceRoot, '_open', 'order.json')
              ]
            : [resolveInside(sourceRoot, '_open', 'order.json')]

        for (const orderPath of orderCandidates) {
            if (fs.existsSync(orderPath)) {
                try {
                    orderData = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
                    if (orderData.length > 0) break
                } catch (e) { }
            }
        }

        if (orderData.length > 0) {
            const idToIndex = new Map(orderData.map((id, i) => [id, i]))
            candidates.sort((a: any, b: any) => {
                const ia = idToIndex.has(a.info.id) ? idToIndex.get(a.info.id)! : 999999
                const ib = idToIndex.has(b.info.id) ? idToIndex.get(b.info.id)! : 999999
                return ia - ib
            })
        }
    }
    // =========================================

    if (enableAutoSwitchApiSource === false && candidates.length > 1) {
        candidates = [candidates[0]]
    }

    supportedCount = candidates.length

    if (supportedCount === 0) {
        const errMsg = `未找到支持 ${source} 平台的自定义源，请在设置中添加或启用相关源`
        if (onProgress) await onProgress({ name: '系统', status: 'fail', message: errMsg })
        throw new Error(errMsg)
    }

    // 逻辑分歧：
    // 1. 如果只有一个源支持 -> 重试 3 次
    // 2. 如果有多个源支持 -> 每个源试一次 (轮询)

    const attempts: any[] = []

    if (supportedCount === 1) {
        const api = candidates[0]
        const maxRetries = 3

        for (let i = 0; i < maxRetries; i++) {
            try {
                console.log(`[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (第 ${i + 1}/${maxRetries} 次, Owner: ${api.info.owner})`)

                const url = await api.callRequest('musicUrl', source, {
                    musicInfo: normalizedSongInfo,
                    quality: quality,
                    type: quality
                })

                console.log(`[UserApi] ✓ ${api.info.name} 成功返回链接 (Owner: ${api.info.owner})`)
                const att = { name: api.info.name, status: 'success', message: `第 ${i + 1} 次尝试成功` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                return { url, type: quality, sourceName: api.info.name, attempts }
            } catch (error: any) {
                console.error(`[UserApi] ${api.info.name} 失败 (第 ${i + 1}/${maxRetries} 次):`, `音源日志：${error.message}`)
                lastError = error
                const att = { name: api.info.name, status: 'fail', message: `第 ${i + 1} 次尝试失败,音源日志：${error.message}` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                // 如果不是最后一次尝试，等待一小会儿
                if (i < maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000))
                }
            }
        }
    } else {
        // 多个源，轮流尝试
        for (const api of candidates) {
            try {
                console.log(`[UserApi] 尝试 ${api.info.name} 获取 ${source} 音乐链接 (Owner: ${api.info.owner})`)

                const url = await api.callRequest('musicUrl', source, {
                    musicInfo: normalizedSongInfo,
                    quality: quality,
                    type: quality
                })

                console.log(`[UserApi] ✓ ${api.info.name} 成功返回链接 (Owner: ${api.info.owner})`)
                const att = { name: api.info.name, status: 'success' }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                return { url, type: quality, sourceName: api.info.name, attempts }
            } catch (error: any) {
                console.error(`[UserApi] ${api.info.name} 失败:`, `音源日志：${error.message}`)
                lastError = error
                const att = { name: api.info.name, status: 'fail', message: `音源日志：${error.message}` }
                attempts.push(att)
                if (onProgress) await onProgress(att)
                continue
            }
        }
    }

    const detailMsg = supportedCount === 1
        ? `自定义源 [${candidates[0].info.name}] 解析失败`
        : `已尝试了 ${supportedCount} 个支持 ${source} 平台的源，但全部解析失败`

    const finalError: any = new Error(`${detailMsg} (音源日志: ${lastError?.message})`)
    finalError.attempts = attempts
    throw finalError
}

// 辅助函数：加载指定目录下的源
async function loadSourcesFromDir(dirPath: string, owner: string, stats: { loadedCount: number }) {
    const metaPath = path.join(dirPath, 'sources.json')
    if (!fs.existsSync(metaPath)) {
        return
    }

    try {
        let sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        let needsSave = false

        // === 按 order.json 排序，确保 loadedApis 插入顺序 = 用户配置的优先级顺序 ===
        const orderPath = path.join(dirPath, 'order.json')
        if (fs.existsSync(orderPath)) {
            try {
                const order: string[] = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
                if (order.length > 0) {
                    const idToIndex = new Map(order.map((id, i) => [id, i]))
                    sources = [...sources].sort((a: any, b: any) => {
                        const ia = idToIndex.has(a.id) ? idToIndex.get(a.id)! : 999999
                        const ib = idToIndex.has(b.id) ? idToIndex.get(b.id)! : 999999
                        return ia - ib
                    })
                }
            } catch (e) { }
        }
        // =========================================================================

        for (const source of sources) {
            if (!source.enabled) {
                console.log(`[UserApi] [${owner}] 跳过已禁用: ${source.name}`)
                apiStatus.delete(`${owner}_${source.id}`)
                continue
            }

            let scriptId: string
            try {
                scriptId = assertSafePathSegment(source.id, 'source id')
            } catch {
                console.warn(`[UserApi] [${owner}] 跳过非法源 ID`)
                continue
            }
            const scriptPath = resolveInside(dirPath, scriptId)
            if (!fs.existsSync(scriptPath)) {
                console.warn(`[UserApi] [${owner}] 脚本文件未找到: ${source.id}`)
                continue
            }

            try {
                const script = fs.readFileSync(scriptPath, 'utf-8')
                const metadata = extractMetadata(script)

                const result = await loadUserApi({
                    id: source.id,
                    name: metadata.name || source.name,
                    description: metadata.description || '',
                    version: metadata.version || 1,
                    author: metadata.author || '',
                    homepage: metadata.homepage || '',
                    script,
                    sources: {},
                    enabled: source.enabled, // 传递原本的开关状态
                    owner: owner // 设置 owner
                })

                if (result.success) {
                    stats.loadedCount++
                    apiStatus.set(`${owner}_${source.id}`, { status: 'success' })

                    // [Self-Healing] 检查并修复 supportedSources
                    const runtimeSources = Object.keys(result.apiInstance.info.sources).sort();
                    const storedSources = (source.supportedSources || []).sort();

                    if (JSON.stringify(runtimeSources) !== JSON.stringify(storedSources)) {
                        console.log(`[UserApi] [Fix] [${owner}] 更新源 ${source.name} 的支持列表: ${JSON.stringify(storedSources)} -> ${JSON.stringify(runtimeSources)}`);
                        source.supportedSources = runtimeSources;
                        if (metadata.version && source.version !== metadata.version) source.version = metadata.version;
                        if (metadata.author && source.author !== metadata.author) source.author = metadata.author;
                        if (metadata.description && source.description !== metadata.description) source.description = metadata.description;
                        if (metadata.homepage && source.homepage !== metadata.homepage) source.homepage = metadata.homepage;
                        needsSave = true;
                    }
                } else {
                    console.error(`[UserApi] [${owner}] 加载 ${metadata.name || source.name} 失败: ${result.error}`)
                    apiStatus.set(`${owner}_${source.id}`, { status: 'failed', error: result.error })
                }
            } catch (error: any) {
                console.error(`[UserApi] [${owner}] 加载 ${source.name} 失败:`, error.message)
                apiStatus.set(`${owner}_${source.id}`, { status: 'failed', error: error.message })
            }
        }

        if (needsSave) {
            // Write back using the original (file-order) sources array to avoid overwriting sources.json ordering
            const originalSources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            const updatedMap = new Map(sources.map((s: any) => [s.id, s]))
            const merged = originalSources.map((s: any) => updatedMap.get(s.id) || s)
            writeJsonFileAtomic(metaPath, merged)
            console.log(`[UserApi] [${owner}] 已更新 sources.json 元数据`);
        }
    } catch (error: any) {
        console.error(`[UserApi] [${owner}] 读取 sources.json 失败:`, error.message)
    }
}

// 文件监控相关
let fsWatcher: fs.FSWatcher | null = null
const lastReloadMap = new Map<string, number>() // 记录每个用户的最后加载时间
let reloadChain: Promise<void> = Promise.resolve()

const disposeLoadedApis = async (owner?: string) => {
    const entries = Array.from(loadedApis.entries()).filter(([, api]) => !owner || api.info.owner === owner)
    for (const [key, api] of entries) {
        try { await api.dispose?.() } catch (error: any) {
            console.warn(`[UserApi] 清理旧源失败 (${key}):`, error?.message || error)
        }
        loadedApis.delete(key)
    }
}

const clearReloadRelatedCaches = async (owner?: string) => {
    try {
        const { clearServerSourceMatchCache } = await import('./services/musicResolver')
        clearServerSourceMatchCache(owner)
    } catch (error: any) {
        console.warn('[UserApi] 清理音源匹配缓存失败:', error?.message || error)
    }
}

// 启动文件监控
function startWatcher(sourceRoot: string) {
    if (fsWatcher) return

    console.log(`[UserApi] 启动源文件监控: ${sourceRoot}`)
    const debounceMap = new Map<string, NodeJS.Timeout>()

    try {
        // Warning: recursive option for fs.watch is generally supported on Windows/macOS but not Linux
        // For better cross-platform support, chokidar would be preferred, but using fs.watch as requested/minimal dependency
        fsWatcher = fs.watch(sourceRoot, { recursive: true }, (eventType, filename) => {
            if (!filename) return

            // 仅关注 .js 和 sources.json 文件的变化
            if (!filename.endsWith('.js') && !filename.endsWith('sources.json')) {
                return
            }

            // 解析用户名 (目录名)
            // filename on Windows might be "username\file.js"
            const parts = (filename as string).split(path.sep)
            let username = parts[0]

            // 如果是 _open 目录，对应 'open' 用户
            if (username === '_open') {
                username = 'open'
            }

            // 简单的防抖处理
            if (debounceMap.has(username)) {
                clearTimeout(debounceMap.get(username)!)
            }

            debounceMap.set(username, setTimeout(() => {
                debounceMap.delete(username)
                // 检查是否是最近刚手动加载过 (避免面板上传造成的重复加载)
                // 阈值设为 3000ms，假设手动上传触发的 reload 会在这个时间内完成
                const lastReload = lastReloadMap.get(username) || 0
                if (Date.now() - lastReload < 3000) {
                    console.log(`[UserApi] [Watcher] 忽略近期更新的文件变动 (视为手动上传): ${filename}`)
                    return
                }
                lastReloadMap.delete(username)

                console.log(`[UserApi] [Watcher] 检测到文件变动 (${eventType}): ${filename} -> 重新加载 ${username}`)
                initUserApis(username).catch(err => {
                    console.error(`[UserApi] [Watcher] 重新加载失败:`, err)
                })
            }, 2000)) // 2秒防抖，等待文件写入完成
        })

        // 进程退出时关闭监听
        process.on('exit', () => {
            if (fsWatcher) fsWatcher.close()
        })
    } catch (e) {
        console.error('[UserApi] 启动文件监控失败:', e)
    }
}

// 从文件系统加载所有已启用的自定义源
// 路径变更：DATA_PATH/users/source/{username} 和 DATA_PATH/users/source/_open
async function initUserApisInternal(targetUser?: string) {
    if (targetUser && targetUser !== 'open') assertSafePathSegment(targetUser, 'username')
    const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
    const sourceRoot = path.join(dataPath, 'users', 'source')
    const stats = { loadedCount: 0 }

    // 更新最后加载时间
    if (targetUser) {
        lastReloadMap.set(targetUser, Date.now())
    } else {
        // 全局加载
    }

    console.log(`[UserApi] ========================================`)

    // 如果根目录不存在，无需加载
    if (!fs.existsSync(sourceRoot)) {
        await disposeLoadedApis(targetUser)
        await clearReloadRelatedCaches(targetUser)
        if (!targetUser) apiStatus.clear()
        console.log(`[UserApi] Source root directory not found: ${sourceRoot}`)
        console.log(`[UserApi] ========================================`)
        return
    }

    // 尝试启动监控 (只会在第一次调用且无 watcher 时启动)
    if (!fsWatcher) {
        startWatcher(sourceRoot)
    }

    if (targetUser) {
        console.log(`[UserApi] 重新加载用户源: ${targetUser}`)
        // 清理该用户的旧源和状态
        await disposeLoadedApis(targetUser)
        await clearReloadRelatedCaches(targetUser)
        for (const key of apiStatus.keys()) {
            if (key.startsWith(`${targetUser}_`)) {
                apiStatus.delete(key)
            }
        }

        // 加载该用户的源
        let dirName = targetUser

        // 特殊处理：如果是 'open'，对应目录是 '_open'
        if (targetUser === 'open') {
            dirName = '_open'
        }

        const userSourceDir = resolveInside(sourceRoot, dirName)
        if (fs.existsSync(userSourceDir)) {
            await loadSourcesFromDir(userSourceDir, targetUser, stats)
        }

    } else {
        console.log(`[UserApi] 初始化所有自定义源...`)
        await disposeLoadedApis()
        await clearReloadRelatedCaches()
        apiStatus.clear()
        lastReloadMap.clear()

        // 扫描 sourceRoot 下的所有子目录
        try {
            const entries = fs.readdirSync(sourceRoot, { withFileTypes: true })
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    let owner = entry.name
                    // 如果目录是 _open，owner 为 'open'
                    if (entry.name === '_open') {
                        owner = 'open'
                    }

                    const dirPath = resolveInside(sourceRoot, entry.name)
                    await loadSourcesFromDir(dirPath, owner, stats)
                }
            }
        } catch (error: any) {
            console.error('[UserApi] 扫描源目录失败:', error.message)
        }
    }

    console.log(`[UserApi] 本次加载: ${stats.loadedCount} 个源`)
    console.log(`[UserApi] 当前总计: ${loadedApis.size} 个源`)
    console.log(`[UserApi] ========================================`)
}

export function initUserApis(targetUser?: string) {
    const nextReload = reloadChain.then(() => initUserApisInternal(targetUser))
    reloadChain = nextReload.catch(() => { })
    return nextReload
}

// 获取所有已加载的 API
export function getLoadedApis() {
    return Array.from(loadedApis.values()).map(api => api.info)
}

// 检查某个源是否被支持
// clientUsername: 调用者的用户名。如果未提供，则只能检查 open 源
export function isSourceSupported(source: string, clientUsername?: string): boolean {
    // Retired built-in IDs are never reactivated through userApi. Custom APIs
    // must use their own ID so historical data cannot silently switch source.
    if (isRetiredOnlineSource(source)) return false
    for (const [apiId, api] of loadedApis) {
        if (!api.info.enabled || !api.info.sources || !api.info.sources[source]) {
            continue
        }

        // 权限检查
        if (api.info.owner === 'open' || (clientUsername && api.info.owner === clientUsername)) {
            return true
        }
    }
    return false
}
