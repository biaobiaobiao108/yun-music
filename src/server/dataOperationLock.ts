type DataOperation = 'account-change' | 'backup'

let activeOperation: DataOperation | null = null
let apiRequests = 0
let apiPaused = false
const drainResolvers = new Set<() => void>()

export const beginDataRequest = (): boolean => {
  if (apiPaused) return false
  apiRequests++
  return true
}

export const endDataRequest = (): void => {
  if (apiRequests > 0) apiRequests--
  if (apiRequests === 0 && drainResolvers.size > 0) {
    for (const resolve of drainResolvers) resolve()
    drainResolvers.clear()
  }
}

export const pauseDataRequests = async (timeoutMs = 15_000): Promise<() => void> => {
  apiPaused = true
  let resolver: (() => void) | undefined
  if (apiRequests > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        resolver = resolve
        drainResolvers.add(resolve)
        timer = setTimeout(() => {
          drainResolvers.delete(resolve)
          apiPaused = false
          reject(new Error('等待进行中的请求超时，请稍后重试'))
        }, timeoutMs)
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return () => {
    if (resolver) drainResolvers.delete(resolver)
    apiPaused = false
  }
}

/** Coordinate account directory changes with database copies used by backups in this single-process server. */
export const tryAcquireDataOperation = (operation: DataOperation): boolean => {
  if (activeOperation !== null) return false
  activeOperation = operation
  return true
}

export const releaseDataOperation = (operation: DataOperation): void => {
  if (activeOperation === operation) activeOperation = null
}
