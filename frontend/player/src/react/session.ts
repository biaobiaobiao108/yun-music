let sessionScope = 'guest'
let sessionGeneration = 0
const LEGACY_SCOPED_STORAGE_KEYS = ['lx_settings', 'lx_playback_state', 'play_history'] as const
const SCOPED_STORAGE_MIGRATION_KEY = 'yun-music:scoped-storage-migration:v1'

function normalizeSessionScope(username: unknown): string {
  const value = typeof username === 'string' ? username.trim() : ''
  return value ? `user:${value}` : 'guest'
}

function migrateLegacyStorage(scope: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    // Scope the marker as well: the first anonymous visit must not consume the
    // one-time migration before the user logs in.
    const markerKey = `${SCOPED_STORAGE_MIGRATION_KEY}:${scope}`
    if (localStorage.getItem(markerKey)) return
    for (const baseKey of LEGACY_SCOPED_STORAGE_KEYS) {
      const legacyValue = localStorage.getItem(baseKey)
      const scopedKey = `${baseKey}:${encodeURIComponent(scope)}`
      if (legacyValue !== null && localStorage.getItem(scopedKey) === null) {
        localStorage.setItem(scopedKey, legacyValue)
      }
    }
    localStorage.setItem(markerKey, '1')
  } catch {
    // Retry on the next session transition if storage is temporarily unavailable or full.
  }
}

/**
 * The player keeps a small amount of convenience state in localStorage.
 * Scope those keys to the verified user so a logout/login transition cannot
 * reuse the previous account's playlist, history, or settings.
 */
export function setSessionScope(username: string | null | undefined): boolean {
  const nextScope = normalizeSessionScope(username)
  migrateLegacyStorage(nextScope)
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
