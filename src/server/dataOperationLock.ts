type DataOperation = 'account-change' | 'backup'

let activeOperation: DataOperation | null = null
let apiRequests = 0
let apiPaused = false
let resolveDrain: (() => void) | undefined

export const beginDataRequest = (): boolean => {
  if (apiPaused) return false
  apiRequests++
  return true
}

export const endDataRequest = (): void => {
  apiRequests--
  if (apiRequests === 0) resolveDrain?.()
}

export const pauseDataRequests = async (): Promise<() => void> => {
  apiPaused = true
  if (apiRequests > 0)
    await new Promise<void>(resolve => {
      resolveDrain = resolve
    })
  return () => {
    resolveDrain = undefined
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
