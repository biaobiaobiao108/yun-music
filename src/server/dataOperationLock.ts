type DataOperation = 'account-change' | 'backup'

let activeOperation: DataOperation | null = null

/** Coordinate account directory changes with backup snapshots in this single-process server. */
export const tryAcquireDataOperation = (operation: DataOperation): boolean => {
  if (activeOperation !== null) return false
  activeOperation = operation
  return true
}

export const releaseDataOperation = (operation: DataOperation): void => {
  if (activeOperation === operation) activeOperation = null
}
