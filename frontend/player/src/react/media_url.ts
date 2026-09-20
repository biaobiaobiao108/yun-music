import type { Song } from './types'

type PlaybackSettings = Record<string, unknown>

/** Migrate cache links written by the pre-React player to the private route. */
export function normalizeCachePlaybackUrl(rawUrl: unknown, username?: string | null): string {
  const url = String(rawUrl ?? '').trim()
  const targetUser = String(username ?? '').trim()
  if (!url || !targetUser || targetUser === '_open' || targetUser === 'open' || targetUser === 'default') return url
  try {
    const parsed = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
    const prefix = '/api/music/cache/file/'
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
