import type { Song } from './types'

type PlaybackSettings = Record<string, unknown>

export type CacheFolder = 'cache' | 'music'

export type CachePlaybackReference = {
  filename: string
  folder: CacheFolder
  username?: string
}

const CACHE_FILE_PREFIX = '/api/music/cache/file/'

function browserOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin
}

/** Parse both public and private server-cache playback links. */
export function parseCachePlaybackUrl(rawUrl: unknown): CachePlaybackReference | null {
  const raw = String(rawUrl ?? '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw, browserOrigin())
    if (!parsed.pathname.startsWith(CACHE_FILE_PREFIX)) return null
    const target = parsed.pathname.slice(CACHE_FILE_PREFIX.length)
    if (!target) return null
    const segments = target.split('/').filter(Boolean)
    if (!segments.length || segments.length > 2) return null
    const username = segments.length === 2 ? decodeURIComponent(segments[0]) : undefined
    const encodedFilename = segments.length === 2 ? segments[1] : segments[0]
    const filename = decodeURIComponent(encodedFilename)
    if (!filename) return null
    const folder = parsed.searchParams.get('folder')
    return { filename, folder: folder === 'music' ? 'music' : 'cache', ...(username ? { username } : {}) }
  } catch {
    return null
  }
}

/** Build the same-origin cache route used by the player and download views. */
export function buildCachePlaybackUrl(reference: CachePlaybackReference): string {
  const username = String(reference.username ?? '').trim()
  const encodedFilename = encodeURIComponent(reference.filename)
  const target = username && username !== '_open' && username !== 'open' && username !== 'default'
    ? `${encodeURIComponent(username)}/${encodedFilename}`
    : encodedFilename
  return `${CACHE_FILE_PREFIX}${target}?folder=${encodeURIComponent(reference.folder)}`
}

/** Extract a remote source URL from a direct URL or the same-origin relay URL. */
export function extractRemotePlaybackUrl(rawUrl: unknown): string | undefined {
  const raw = String(rawUrl ?? '').trim()
  if (/^https?:\/\//i.test(raw)) return raw
  try {
    const parsed = new URL(raw, browserOrigin())
    if (parsed.pathname !== '/api/music/download') return undefined
    const value = parsed.searchParams.get('url')?.trim()
    return value && /^https?:\/\//i.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Migrate cache links written by the pre-React player to the private route. */
export function normalizeCachePlaybackUrl(rawUrl: unknown, username?: string | null): string {
  const url = String(rawUrl ?? '').trim()
  const targetUser = String(username ?? '').trim()
  if (!url || !targetUser || targetUser === '_open' || targetUser === 'open' || targetUser === 'default') return url
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
    const prefix = CACHE_FILE_PREFIX
    if (!parsed.pathname.startsWith(prefix)) return url
    const encodedTarget = parsed.pathname.slice(prefix.length)
    // New links already contain /<username>/<filename>. Old links contain
    // only the encoded filename, even when they point at private storage.
    if (!encodedTarget || encodedTarget.includes('/')) return url
    parsed.pathname = `${prefix}${encodeURIComponent(targetUser)}/${encodedTarget}`
    return url.startsWith('/') ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString()
  } catch {
    return url
  }
}

/**
 * Resolve a URL returned by a music source into a URL that the media element
 * can actually play in the browser.  Third-party music hosts frequently
 * reject browser requests (missing CORS headers, Referer checks, or expiring
 * redirects), while the server already provides a bounded same-origin relay.
 */
export function buildPlaybackUrl(
  rawUrl: unknown,
  song: Song,
  settings: PlaybackSettings = {},
  origin = typeof window === 'undefined' ? '' : window.location.origin,
): string {
  const url = String(rawUrl ?? '').trim()
  if (!url) throw new Error('音源未返回有效播放链接')
  if (!/^https?:\/\//i.test(url)) return url

  try {
    if (origin && new URL(url).origin === origin) return url
  } catch {
    throw new Error('音源返回了无效播放链接')
  }

  const customProxy = String(settings.customProxyUrl ?? '').trim()
  if (settings.enableCustomProxy === true && customProxy) {
    return customProxy.replace('{url}', url)
  }

  const filename = `${String(song.singer || 'unknown')} - ${String(song.name || 'download')}.mp3`
  const params = new URLSearchParams({ url, filename, inline: '1' })
  return `/api/music/download?${params.toString()}`
}
