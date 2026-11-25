import { assertSafeRemoteHttpUrl, fetchSafeRemote, type SafeRemoteHttpUrl } from '../networkSecurity'

/** 格式化字节大小 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, index)).toFixed(2)} ${units[index]}`
}

const parseContentLength = (headers: Headers): number | null => {
  const range = headers.get('content-range')
  const total = range?.match(/\/(\d+)$/)?.[1]
  if (total) {
    const parsed = Number(total)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }

  const length = Number(headers.get('content-length'))
  if (Number.isFinite(length) && length > 0) return length

  return null
}

const AUDIO_SIZE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_AUDIO_SIZE_REDIRECTS = 5

const fetchAudioSizeProbe = async (initialUrl: SafeRemoteHttpUrl, method: 'HEAD' | 'GET'): Promise<Response> => {
  let currentUrl = initialUrl
  for (let redirectCount = 0; redirectCount <= MAX_AUDIO_SIZE_REDIRECTS; redirectCount += 1) {
    const response = await fetchSafeRemote(currentUrl, {
      method,
      timeoutMs: 8000,
      // The probe only needs response headers; close the upstream body as soon
      // as the status and headers arrive, including for redirect responses.
      maxBytes: 1024,
      discardResponseBody: true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: currentUrl.origin,
        ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}),
      },
    })
    if (!AUDIO_SIZE_REDIRECT_STATUSES.has(response.status)) return response

    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error('Audio size probe redirect is missing a location')
    if (redirectCount === MAX_AUDIO_SIZE_REDIRECTS) {
      throw new Error('Audio size probe exceeded the redirect limit')
    }

    // Redirect targets are untrusted input. Resolve relative locations against
    // the current hop and repeat the public-address validation before each fetch.
    const redirectUrl = new URL(location, currentUrl)
    currentUrl = await assertSafeRemoteHttpUrl(redirectUrl.href)
  }
  throw new Error('Audio size probe exceeded the redirect limit')
}

export const getAudioRemoteSize = async (audioUrl: string): Promise<number | null> => {
  if (!/^https?:\/\//i.test(audioUrl)) return null

  let safeUrl: SafeRemoteHttpUrl
  try {
    safeUrl = await assertSafeRemoteHttpUrl(audioUrl)
  } catch {
    return null
  }
  try {
    const resp = await fetchAudioSizeProbe(safeUrl, 'HEAD')
    const size = parseContentLength(resp.headers)
    if (size) return size
    await resp.body?.cancel()
  } catch (e: any) {
    console.warn(`[QualitySize] HEAD failed: ${e.message}`)
  }

  try {
    const resp = await fetchAudioSizeProbe(safeUrl, 'GET')
    const size = parseContentLength(resp.headers)
    await resp.body?.cancel()
    return size
  } catch (e: any) {
    console.warn(`[QualitySize] Range probe failed: ${e.message}`)
  }

  return null
}
