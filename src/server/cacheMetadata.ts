import fs from 'fs'
import path from 'path'
import { getMusicTagNative } from './musicTagNative'

export const detectImageMime = (data: Buffer | Uint8Array) => {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
  return null
}

export const hasValidPictureData = (picture: any) => {
  try {
    const data = picture?.data
    return !!data && !!detectImageMime(data)
  } catch {
    return false
  }
}

export const hasValidEmbeddedCover = (pictures: any) => {
  return Array.isArray(pictures) && pictures.some(hasValidPictureData)
}

export const isPlaceholderCoverUrl = (url: any) =>
  typeof url === 'string' && /\/T002R\d+x\d+M000\.jpg(?:$|\?)/.test(url)

export const hasUsableRemoteCover = (url: any) =>
  typeof url === 'string' && /^https?:\/\//i.test(url) && !isPlaceholderCoverUrl(url)

export const detectAudioContainer = (filePath: string) => {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(16)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    fs.closeSync(fd)
    const head = buffer.subarray(0, bytesRead)
    if (
      head.subarray(0, 3).toString('ascii') === 'ID3' ||
      (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
    )
      return 'mp3'
    if (head.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
    if (head.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE')
      return 'wav'
    if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4'
    if (head.subarray(0, 4).toString('ascii') === 'MAC ') return 'ape'
    if (head[0] === 0x7b) return 'encrypted'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export const getMetadataUnsupportedMessage = (container: string) =>
  container === 'encrypted' ? '音频为加密或非标准容器，无法写入封面和歌词标签' : '当前音频容器不支持写入封面和歌词标签'

export const getAudioMetadataUnsupportedStatus = (filePath: string) => {
  const audioContainer = detectAudioContainer(filePath)
  return {
    audioContainer,
    metadataWritable: false,
    error: getMetadataUnsupportedMessage(audioContainer),
  }
}

export const readEmbeddedCoverState = (filePath: string) => {
  let tagger: any
  try {
    tagger = new (getMusicTagNative().MusicTagger)()
    tagger.loadPath(filePath)
    return hasValidEmbeddedCover(tagger.pictures)
  } catch {
    return false
  } finally {
    try {
      if (tagger) tagger.dispose()
    } catch {}
  }
}

export const embedLyricsIntoFile = (filePath: string, lyricText: string) => {
  const audioContainer = detectAudioContainer(filePath)
  let tagger: any
  try {
    tagger = new (getMusicTagNative().MusicTagger)()
    tagger.loadPath(filePath)
    tagger.lyrics = lyricText
    tagger.save()
  } catch {
    return {
      success: false,
      hasEmbedLyric: false,
      audioContainer,
      metadataWritable: false,
      error: getMetadataUnsupportedMessage(audioContainer),
    }
  } finally {
    try {
      if (tagger) tagger.dispose()
    } catch {}
  }

  let verifyTagger: any
  try {
    verifyTagger = new (getMusicTagNative().MusicTagger)()
    verifyTagger.loadPath(filePath)
    const embeddedLyrics = verifyTagger.lyrics
    const hasEmbedLyric = !!(embeddedLyrics && embeddedLyrics.trim().length > 10)
    return {
      success: hasEmbedLyric,
      hasEmbedLyric,
      audioContainer,
      metadataWritable: true,
      error: hasEmbedLyric ? undefined : '歌词标签写入后校验失败，已保留外置歌词文件',
    }
  } catch {
    return {
      success: false,
      hasEmbedLyric: false,
      audioContainer,
      metadataWritable: false,
      error: getMetadataUnsupportedMessage(audioContainer),
    }
  } finally {
    try {
      if (verifyTagger) verifyTagger.dispose()
    } catch {}
  }
}

export const detectQualityFromBitrate = (bitrate: number | undefined, ext: string, tagger?: any): LX.Quality => {
  const nativeQuality = String(tagger?.quality || '').toLowerCase()
  const isLossless =
    ext === '.flac' || ext === '.wav' || ext === '.ape' || nativeQuality === 'sq' || nativeQuality === 'hires'
  const br = bitrate || 0

  if (isLossless) {
    const bitDepth = tagger?.bitDepth || 16
    const sampleRate = tagger?.sampleRate || 44100

    if (br > 4500 || sampleRate > 96000) return 'master' as LX.Quality
    if (br > 1000 || bitDepth > 16 || sampleRate > 48000) return 'flac24bit'
    return 'flac'
  }

  if (br >= 240) return '320k'
  if (br >= 170) return '192k'
  return '128k'
}

const losslessQualitySet = new Set(['flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'ape', 'wav'])

const isClearlyLossyAudio = (container: string, tagger?: any) => {
  const nativeQuality = String(tagger?.quality || '').toLowerCase()
  return nativeQuality === 'hq' || container === 'mp3' || container === 'ogg'
}

export const resolveInspectedQuality = (
  requestedQuality: string | undefined,
  detectedQuality: string,
  container: string,
  tagger?: any,
) => {
  if (isClearlyLossyAudio(container, tagger)) return detectedQuality
  if (requestedQuality && losslessQualitySet.has(requestedQuality)) return requestedQuality
  return detectedQuality
}

export const needsQualityCorrection = (quality: string | undefined, container: string) =>
  !!quality && losslessQualitySet.has(quality) && (container === 'mp3' || container === 'ogg')

export const inspectAudioFile = (filePath: string, requestedQuality?: string) => {
  const audioContainer = detectAudioContainer(filePath)
  const ext =
    audioContainer === 'unknown' || audioContainer === 'encrypted'
      ? path.extname(filePath).toLowerCase()
      : `.${audioContainer === 'mp4' ? 'm4a' : audioContainer}`
  let tagger: any
  try {
    tagger = new (getMusicTagNative().MusicTagger)()
    tagger.loadPath(filePath)
    const bitrate = Number(tagger.bitRate) || undefined
    const detectedQuality = detectQualityFromBitrate(bitrate, ext, tagger)
    return {
      audioContainer,
      extension: ext,
      quality: resolveInspectedQuality(requestedQuality, detectedQuality, audioContainer, tagger),
      bitrate,
      sampleRate: Number(tagger.sampleRate) || undefined,
      bitDepth: Number(tagger.bitDepth) || undefined,
    }
  } catch {
    const detectedQuality = detectQualityFromBitrate(undefined, ext)
    return {
      audioContainer,
      extension: ext,
      quality: needsQualityCorrection(requestedQuality, audioContainer)
        ? detectedQuality
        : requestedQuality || detectedQuality,
      bitrate: undefined,
      sampleRate: undefined,
      bitDepth: undefined,
    }
  } finally {
    try {
      if (tagger) tagger.dispose()
    } catch {}
  }
}

export const detectDownloadSource = (rawUrl: string, fallbackSource?: string) => {
  let value = String(rawUrl || '').toLowerCase()
  try {
    value = decodeURIComponent(value)
  } catch {}

  const sourcePatterns: Array<[string, RegExp]> = [
    ['wy', /(?:^|[./])(?:music\.126\.net|music\.163\.com|163yun\.com)(?:[/:?]|$)/],
    ['tx', /(?:^|[./])(?:qqmusic\.qq\.com|music\.tc\.qq\.com|stream\.qqmusic\.qq\.com)(?:[/:?]|$)/],
  ]
  for (const [source, pattern] of sourcePatterns) {
    if (pattern.test(value)) return source
  }
  return fallbackSource || undefined
}
