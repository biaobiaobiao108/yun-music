export function readJson<T>(storage: Storage | null, key: string, fallback: T): T {
  if (!storage) return fallback
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeJson(storage: Storage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be disabled or full. Runtime state remains usable in memory.
  }
}

export function readString(storage: Storage | null, key: string, fallback = ''): string {
  try {
    return storage?.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function writeString(storage: Storage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Best effort compatibility with the old browser storage contract.
  }
}

export function removeStorageKey(storage: Storage | null, key: string): void {
  try {
    storage?.removeItem(key)
  } catch {
    // Ignore unavailable storage.
  }
}
