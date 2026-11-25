// These endpoints only need compact song metadata and pagination fields.
export const MAX_MUSIC_JSON_BODY_BYTES = 512 * 1024
const SONG_LIST_HOSTS: Record<string, ReadonlySet<string>> = {
  wy: new Set(['music.163.com']),
  tx: new Set(['y.qq.com', 'i.y.qq.com']),
}

/**
 * 只从数字 ID 或官方歌单链接提取 ID，不访问用户提供的原始链接。
 * 旧版 SDK 会对无法识别的链接发起请求，路由层必须先完成这一层收敛。
 */
export const normalizeSongListId = (source: string, rawId: string): string | null => {
  const input = String(rawId || '').trim()
  if (!input || input.length > 512) return null
  if (/^\d+$/.test(input)) return input

  const allowedHosts = SONG_LIST_HOSTS[source]
  if (!allowedHosts) return null

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  if (!allowedHosts.has(parsed.hostname.toLowerCase())) return null

  const candidates = [
    parsed.searchParams.get('id'),
    parsed.pathname.match(/\/playlist\/(\d+)/i)?.[1],
    parsed.hash.match(/[?&]id=(\d+)/i)?.[1],
  ]
  return candidates.find(candidate => Boolean(candidate && /^\d+$/.test(candidate))) || null
}

export const boundedInt = (value: string | null, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}
