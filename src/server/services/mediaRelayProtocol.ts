import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { IncomingHttpHeaders } from 'node:http'
import { INFERRED_AUDIO_TYPES } from './mediaRelaySupport'

export const MAX_RELAY_AUDIO_BYTES = 500 * 1024 * 1024

const normalizeRemoteType = (remoteType: string) => {
  if (remoteType === 'audio/x-flac') return 'audio/flac'
  if (remoteType === 'audio/x-m4a') return 'audio/mp4'
  if (remoteType === 'audio/x-wav') return 'audio/wav'
  if (remoteType === 'audio/x-aac') return 'audio/aac'
  return remoteType
}

export const resolveRelayContentType = (rawRemoteType: string, requestedFilename: string | null, isInline: boolean) => {
  const remoteType = rawRemoteType.split(';')[0].trim().toLowerCase()
  const normalizedRemoteType = normalizeRemoteType(remoteType)
  let safeInlineType =
    /^(audio|video)\/[a-z0-9.+-]+$/.test(normalizedRemoteType) ||
    /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(normalizedRemoteType)
  let contentType = safeInlineType ? normalizedRemoteType : 'application/octet-stream'

  if (
    isInline &&
    !safeInlineType &&
    (!remoteType || remoteType === 'application/octet-stream' || remoteType === 'binary/octet-stream')
  ) {
    const ext = requestedFilename ? path.extname(requestedFilename).toLowerCase() : ''
    if (INFERRED_AUDIO_TYPES[ext]) {
      contentType = INFERRED_AUDIO_TYPES[ext]
      safeInlineType = true
    }
  }

  return { contentType, safeInlineType }
}

export const buildRelayResponseHeaders = (
  upstreamHeaders: IncomingHttpHeaders,
  options: {
    contentType: string
    safeInlineType: boolean
    filename: string
    isInline: boolean
  },
) => {
  const headers: Record<string, string> = {
    'Content-Type': options.contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  }

  if (upstreamHeaders['content-length']) headers['Content-Length'] = upstreamHeaders['content-length']
  if (upstreamHeaders['accept-ranges']) headers['Accept-Ranges'] = upstreamHeaders['accept-ranges']
  if (upstreamHeaders['content-range']) headers['Content-Range'] = upstreamHeaders['content-range']

  if (options.isInline && options.safeInlineType) {
    headers['X-Accel-Buffering'] = 'no'
    if (!headers['Accept-Ranges']) headers['Accept-Ranges'] = 'bytes'
  }

  if (!options.isInline || !options.safeInlineType) {
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(options.filename)}"`
  }

  return headers
}

const getTempAudioExtension = (filename: string) => {
  const requestedExt = path.extname(filename).toLowerCase()
  return ['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.aac', '.opus'].includes(requestedExt) ? requestedExt : '.mp3'
}

export const createTempAudioPath = (filename: string) =>
  path.join(
    os.tmpdir(),
    `lx_tag_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${getTempAudioExtension(filename)}`,
  )
