import crypto from 'crypto'
import { indexManager } from './cacheIndex'
import { normalizeCacheUsername } from './cachePaths'

export const CACHE_NAMING_PATTERNS = {
  STANDARD: 'standard', // {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
  SIMPLE: 'simple', // {Name} - {Singer} - {Quality} - {Album}
}

let currentNamingPattern = CACHE_NAMING_PATTERNS.SIMPLE

export const normalizeNamingPattern = (pattern: unknown) =>
  pattern === CACHE_NAMING_PATTERNS.STANDARD ? CACHE_NAMING_PATTERNS.STANDARD : CACHE_NAMING_PATTERNS.SIMPLE

export const setNamingPattern = (pattern: unknown) => {
  currentNamingPattern = normalizeNamingPattern(pattern)
  return currentNamingPattern
}

export const getNamingPattern = () => currentNamingPattern

export const normalizeSongIdValue = (value: unknown, source: string) => {
  const id = String(value || '').trim()
  if (!id) return ''
  const normalizedSource = String(source || 'unknown').trim() || 'unknown'
  if (normalizedSource === 'unknown' || id.startsWith(`${normalizedSource}_`)) return id
  return `${normalizedSource}_${id}`
}

export const normalizeSongId = (songInfo: any): string => {
  const id = String(songInfo?.songmid || songInfo?.songId || songInfo?.id || '')
  const source = String(songInfo?.source || songInfo?.meta?.source || 'unknown')
  return normalizeSongIdValue(id, source)
}

export const getSongIdCandidates = (songInfo: any): string[] => {
  if (!songInfo || typeof songInfo !== 'object') return []

  const source = String(songInfo.source || songInfo.meta?.source || 'unknown').trim() || 'unknown'
  const candidates: string[] = []
  const add = (value: unknown, valueSource = source) => {
    const normalized = normalizeSongIdValue(value, valueSource)
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized)
  }
  const addLegacyAlias = (value: unknown, valueSource = source) => {
    const raw = String(value || '').trim()
    if (!raw || valueSource === 'unknown' || raw.startsWith(`${valueSource}_`)) return
    if (!candidates.includes(raw)) candidates.push(raw)
  }

  // Canonical source-prefixed IDs avoid collisions when provider IDs contain underscores.
  add(normalizeSongId(songInfo), 'unknown')
  add(songInfo.songmid)
  addLegacyAlias(songInfo.songmid)
  add(songInfo.songId)
  addLegacyAlias(songInfo.songId)
  add(songInfo.id)
  addLegacyAlias(songInfo.id)

  const meta = songInfo.meta
  if (meta && typeof meta === 'object') {
    const metaSource = String(meta.source || source).trim() || source
    add(meta.songmid, metaSource)
    addLegacyAlias(meta.songmid, metaSource)
    add(meta.songId, metaSource)
    addLegacyAlias(meta.songId, metaSource)
    add(meta.id, metaSource)
    addLegacyAlias(meta.id, metaSource)
  }

  return candidates
}

export const extractSongMetadata = (songInfo: any) => {
  const meta = songInfo.meta || {}
  const id = normalizeSongId(songInfo)
  return {
    id: id,
    name: songInfo.name || meta.songName || 'Unknown',
    singer: songInfo.singer || meta.singerName || 'Unknown',
    albumName: songInfo.albumName || meta.albumName || '',
    albumId: String(songInfo.albumId || meta.albumId || ''),
    img: songInfo.img || meta.picUrl || '',
    interval: songInfo.interval || meta.interval || '',
    source: songInfo.source || 'unknown',
  }
}

// Leave room within Linux's 255-byte component limit for the staging file's
// PID, timestamp, random token and extension (at most 55 additional bytes).
const CACHE_BASENAME_MAX_BYTES = 200

export const truncateFilenameUtf8 = (value: string, maxBytes: number): string => {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

export const getFileName = (songInfo: any, quality?: string, isOnlyDownload?: boolean, username?: string) => {
  const sanitizeFilename = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

  const id = normalizeSongId(songInfo)
  const source = songInfo.source || 'unknown'
  const q = quality || songInfo.quality || 'unknown'
  const nameStr = sanitizeFilename(songInfo.name || 'Unknown')
  const singerStr = sanitizeFilename(songInfo.singer || 'Unknown')
  const albumValue = songInfo.albumName || songInfo.meta?.albumName || 'Unknown Album'
  const albumStr = sanitizeFilename(albumValue)

  let baseName = ''
  if (currentNamingPattern === CACHE_NAMING_PATTERNS.SIMPLE) {
    baseName = `${nameStr} - ${singerStr} - ${sanitizeFilename(q)} - ${albumStr}`
  } else {
    baseName = `${nameStr}_-_${singerStr}_-_${sanitizeFilename(source)}_-_${sanitizeFilename(id)}_-_${sanitizeFilename(q)}`
  }

  const identityName = baseName
  const shortenName = () => {
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify([source, id, identityName]))
      .digest('hex')
      .slice(0, 16)
    const suffix = `_-_${truncateFilenameUtf8(sanitizeFilename(q), 32)}_-_${hash}`
    return truncateFilenameUtf8(identityName, CACHE_BASENAME_MAX_BYTES - Buffer.byteLength(suffix, 'utf8')) + suffix
  }
  if (Buffer.byteLength(baseName, 'utf8') > CACHE_BASENAME_MAX_BYTES) return shortenName()

  // Only the simple pattern needs collision handling; the standard pattern
  // already includes the provider and song ID.
  if (username && currentNamingPattern !== CACHE_NAMING_PATTERNS.STANDARD) {
    const folder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
    const normalizedUsername = normalizeCacheUsername(username)
    const existingItems = indexManager.getAll(normalizedUsername, folder)

    const normalizedName = nameStr.toLowerCase()
    const normalizedSinger = singerStr.toLowerCase()
    const normalizedQuality = sanitizeFilename(q).toLowerCase()
    const normalizedAlbum = albumStr.toLowerCase()

    const conflict = existingItems.find(item => {
      const itemAlbumValue = item.albumName || 'Unknown Album'
      return (
        sanitizeFilename(item.name || 'Unknown').toLowerCase() === normalizedName &&
        sanitizeFilename(item.singer || 'Unknown').toLowerCase() === normalizedSinger &&
        sanitizeFilename(item.quality || 'unknown').toLowerCase() === normalizedQuality &&
        sanitizeFilename(itemAlbumValue).toLowerCase() === normalizedAlbum &&
        normalizeSongId(item) !== id
      )
    })

    if (conflict) {
      baseName += ` (${sanitizeFilename(id || source || 'duplicate')})`
    }
  }

  if (Buffer.byteLength(baseName, 'utf8') > CACHE_BASENAME_MAX_BYTES) return shortenName()
  return baseName
}
