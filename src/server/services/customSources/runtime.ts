import { AsyncLocalStorage } from 'node:async_hooks'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { extractMetadata, type UserApiInfo } from './metadata'
import { createLxRequest, decontextify } from './request'
import { loadedApis } from './registry'

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
  const callRequestAbortsStorage = new AsyncLocalStorage<Set<() => void>>()
  let registeredSources: any = {}
  let disposed = false
  let vmContext: vm.Context | null = null
  let callbackScript: vm.Script | null = null
  let sandbox: any = null

  const invokeSandboxCallback = (handler: Function, args: any[] = []): unknown => {
    if (!vmContext || !callbackScript || !sandbox) return undefined
    const hasPrevHandler = Object.prototype.hasOwnProperty.call(sandbox, '__lxCallbackHandler')
    const prevHandler = sandbox.__lxCallbackHandler
    const hasPrevArgs = Object.prototype.hasOwnProperty.call(sandbox, '__lxCallbackArgs')
    const prevArgs = sandbox.__lxCallbackArgs
    sandbox.__lxCallbackHandler = handler
    sandbox.__lxCallbackArgs = args
    try {
      return callbackScript.runInContext(vmContext, {
        timeout: USER_API_SYNC_TIMEOUT_MS,
        displayErrors: true,
      })
    } finally {
      if (hasPrevHandler) sandbox.__lxCallbackHandler = prevHandler
      else delete sandbox.__lxCallbackHandler
      if (hasPrevArgs) sandbox.__lxCallbackArgs = prevArgs
      else delete sandbox.__lxCallbackArgs
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
    const timer = setInterval(
      () => runTimerCallback(handler, args),
      Math.max(10, normalizeUserApiTimerDelay(delay, 10)),
    )
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
      try {
        abort()
      } catch {}
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
      try {
        cleanup()
      } catch {}
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
      updateAlert: 'updateAlert',
    },
  }

  // 构建 lx 工具集
  const lxUtils = {
    buffer: {
      from: (d: any, e: any) => Buffer.from(decontextify(d), decontextify(e)),
      bufToString: (b: any, f: any) => (Buffer.isBuffer(b) ? b.toString(f) : Buffer.from(b, 'binary').toString(f)),
    },
    crypto: {
      md5: (str: string) =>
        crypto
          .createHash('md5')
          .update((decontextify(str) || '') as any)
          .digest('hex'),
      aesEncrypt: (buffer: any, mode: string, key: any, iv: any) => {
        const dKey = decontextify(key)
        const dIv = decontextify(iv)
        const dBuffer = decontextify(buffer)
        const algorithm = `aes-${(dKey as any).length * 8}-${mode}`
        const cipher = crypto.createCipheriv(algorithm as any, dKey as any, dIv as any)
        return Buffer.concat([cipher.update(dBuffer as any) as any, cipher.final() as any])
      },
      rsaEncrypt: (buffer: any, key: any) =>
        crypto.publicEncrypt(decontextify(key) as any, decontextify(buffer) as any),
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
    },
  }

  // 核心 lx 对象
  const lxObject = {
    ...lxDataInside,
    utils: lxUtils,
    request: createLxRequest(
      registerCleanup,
      abort => {
        pendingRequestAborts.add(abort)
        const scopedAborts = callRequestAbortsStorage.getStore()
        scopedAborts?.add(abort)
        return () => {
          pendingRequestAborts.delete(abort)
          scopedAborts?.delete(abort)
        }
      },
      invokeSandboxCallback,
      () => disposed,
    ),
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
    },
  }

  // SECURITY BOUNDARY, stated plainly: node:vm is NOT a security boundary.
  // Everything injected below (console, Buffer, timers, lx.*) is a host-realm
  // function, so a script can reach `globalThis.constructor` and run arbitrary
  // code as this process. codeGeneration.strings=false only blocks eval/new
  // Function *inside* the context. Loading a custom source therefore means
  // handing that script full control of the server; the container runs as a
  // non-root user (Dockerfile) purely to limit the damage. Do not add a new
  // native capability here expecting the context to hide it.
  sandbox = {
    console: {
      log: (...args: any[]) => console.log(`[CustomSource:${fullApiInfo.name}]`, ...decontextify(args)),
      info: (...args: any[]) => console.info(`[CustomSource:${fullApiInfo.name}]`, ...decontextify(args)),
      warn: (...args: any[]) => console.warn(`[CustomSource:${fullApiInfo.name}]`, ...decontextify(args)),
      error: (...args: any[]) => console.error(`[CustomSource:${fullApiInfo.name}]`, ...decontextify(args)),
      debug: () => {},
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
      env: { NODE_ENV: process.env.NODE_ENV || 'production' },
    },
    lx: lxObject,
    // 关键：适配混淆脚本对全局变量的引用
    global: null,
    window: null,
    globalThis: null,
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    // Nothing below is isolated: see the note above `sandbox`.
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
        }),
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
        const scopedAborts = new Set<() => void>()
        let abortRequestsStartedByCall: (() => void) | undefined
        try {
          if (disposed) throw new Error(`源 ${fullApiInfo.name} 已卸载`)
          const handler = eventHandlers.get('request')
          if (!handler) throw new Error(`源 ${fullApiInfo.name} 未注册 request 处理器`)

          abortRequestsStartedByCall = () => {
            for (const abort of scopedAborts) {
              try {
                abort()
              } catch {}
            }
          }

          // 始终将请求参数作为 JSON 数据重新构造，避免把宿主原型链传入脚本上下文。
          const serializedInput = JSON.stringify({ action, source, info })
          const inputData = vm.runInContext(`JSON.parse(${JSON.stringify(serializedInput)})`, activeVmContext)

          // Run the synchronous part inside vm's interruptible
          // execution path; direct host calls would allow an
          // uploaded source to block the entire Bun event loop.
          const handlerResult = callRequestAbortsStorage.run(scopedAborts, () => {
            const hasPrevHandler = Object.prototype.hasOwnProperty.call(sandbox, '__lxRequestHandler')
            const prevHandler = sandbox.__lxRequestHandler
            const hasPrevInput = Object.prototype.hasOwnProperty.call(sandbox, '__lxRequestInput')
            const prevInput = sandbox.__lxRequestInput
            sandbox.__lxRequestHandler = handler
            sandbox.__lxRequestInput = inputData
            try {
              return requestScript.runInContext(activeVmContext, {
                timeout: USER_API_SYNC_TIMEOUT_MS,
                displayErrors: true,
              })
            } finally {
              if (hasPrevHandler) sandbox.__lxRequestHandler = prevHandler
              else delete sandbox.__lxRequestHandler
              if (hasPrevInput) sandbox.__lxRequestInput = prevInput
              else delete sandbox.__lxRequestInput
            }
          })

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
      },
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
