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

export const pauseDataRequests = async (): Promise<() => void> => {
  apiPaused = true
  let resolver: (() => void) | undefined
  if (apiRequests > 0) {
    await new Promise<void>(resolve => {
      resolver = resolve
      drainResolvers.add(resolve)
    })
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
