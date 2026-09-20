export type RuntimeConfig = Record<string, unknown> & {
  'player.enableAuth'?: boolean
  'player.path'?: string
  'admin.path'?: string
  buildHash?: string
}

declare global {
  interface Window {
    CONFIG?: RuntimeConfig
  }
}

export function runtimeConfig(): RuntimeConfig {
  return window.CONFIG ?? {}
}

export function assetUrl(path: string): string {
  if (/^(?:https?:|data:|blob:|\/)/i.test(path)) return path
  const base = document.querySelector('base')?.href
  return new URL(path, base || window.location.href).toString()
}

export function safeImageUrl(value: unknown, fallback = '/music/assets/yun-yin.png'): string {
  const source = (() => {
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      for (const key of ['url', 'src', 'picUrl', 'img', 'cover', 'picture', 'avatar']) {
        const candidate = record[key]
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      }
    }
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  })()
  if (!source) return fallback
  if (source.startsWith('/') || source.startsWith('./')) return source
  if (/^(?:blob:|data:image\/)/i.test(source)) return source
  try {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href
    const parsed = new URL(source, base)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (parsed.protocol === 'http:' && typeof window !== 'undefined' && parsed.origin !== window.location.origin) parsed.protocol = 'https:'
      return parsed.href
    }
  } catch {
    // Invalid remote image URLs use the local placeholder below.
  }
  return fallback
}

export function formatDuration(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return '00:00'
  const totalSeconds = Math.floor(numeric > 1000 ? numeric / 1000 : numeric)
  return `${Math.floor(totalSeconds / 60).toString().padStart(2, '0')}:${(totalSeconds % 60).toString().padStart(2, '0')}`
}

export function formatBytes(value: unknown): string {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

export function formatDate(value: unknown): string {
  const date = new Date(typeof value === 'number' ? value : String(value ?? ''))
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}
