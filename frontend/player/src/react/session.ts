let sessionScope = 'guest'
let sessionGeneration = 0

function normalizeSessionScope(username: unknown): string {
  const value = typeof username === 'string' ? username.trim() : ''
  return value ? `user:${value}` : 'guest'
}

/**
 * The player keeps a small amount of convenience state in localStorage.
 * Scope those keys to the verified user so a logout/login transition cannot
 * reuse the previous account's playlist, history, or settings.
 */
export function setSessionScope(username: string | null | undefined): boolean {
  const nextScope = normalizeSessionScope(username)
  if (nextScope === sessionScope) return false
  sessionScope = nextScope
  sessionGeneration += 1
  return true
}

export function getSessionScope(): string {
  return sessionScope
}

export function getSessionGeneration(): number {
  return sessionGeneration
}

export function scopedStorageKey(baseKey: string): string {
  return `${baseKey}:${encodeURIComponent(sessionScope)}`
}
