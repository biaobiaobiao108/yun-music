import fs from 'fs'
import { getDb } from '@/database'
import { NativeLruCache } from '@/utils/nativeLru'
import { memoryCacheBudgets } from './resourceBudget'

// Define the two possible cache roots
export const CACHE_ROOTS = {
  DATA: 'data', // inside global.lx.dataPath (application data)
  ROOT: 'root', // relative to process.cwd() (local instance storage)
}

export let currentCacheLocation = CACHE_ROOTS.ROOT

export const getCacheLocations = () => [
  currentCacheLocation,
  currentCacheLocation === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA,
]

// --- Cache Index Manager ---
const CACHE_INDEX_MEMORY_TTL_MS = 1_000
const CACHE_INDEX_MEMORY_MAX = 4_096

export interface CacheItem {
  id: string
  songmid?: string
  name: string
  singer: string
  albumName: string
  albumId?: string
  img?: string
  interval?: string
  source: string
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
  quality: string
  filename: string
  folder: string // 'cache' or 'music'
  subPath?: string // [New] Relative path within the folder (e.g. 'Pop/2024')
  mtime: number
  size: number
  /** External lyric file size, kept outside the hot JSON aggregation path. */
  lyricSize?: number
  lyricFilename?: string
  ext: string
  hasCover?: boolean
  coverType?: 'embedded' | 'cached' | 'remote' | 'none'
  hasLyric?: boolean
  hasEmbedLyric?: boolean
  audioContainer?: string
  metadataWritable?: boolean
  metadataError?: string
  embedLyricError?: string
  coverCheckedVersion?: number
  coverCheckedMtime?: number
  coverCheckedSize?: number
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
  /** 最近一次真正开始播放的时间；未播放过的旧索引没有此字段。 */
  lastPlayedAt?: number
}

export type CacheFolder = 'cache' | 'music'

export type CachePageRequest = {
  folder: CacheFolder
  page: number
  query: string
  sort: string
}

export interface CacheStatsSummary {
  cache: { totalSize: number; fileCount: number }
  music: { totalSize: number; fileCount: number }
  totalSize: number
  fileCount: number
}

export interface RemoveCacheFileResult {
  deleted: boolean
  folder?: CacheFolder
}

export interface DownloadProvenance {
  requestedSource?: string
  downloadSource?: string
  sourceName?: string
  /** Private queue key so equal songs from separate users/tasks never share live progress. */
  progressKey?: string
}

class CacheIndexManager {
  private readonly itemCache = new NativeLruCache<string, { item: CacheItem | null }>({
    max: CACHE_INDEX_MEMORY_MAX / 2,
    ttl: CACHE_INDEX_MEMORY_TTL_MS,
    maxBytes: Math.floor(memoryCacheBudgets.index / 4),
  })
  private readonly listCache = new NativeLruCache<string, { items: CacheItem[] }>({
    max: CACHE_INDEX_MEMORY_MAX / 2,
    ttl: CACHE_INDEX_MEMORY_TTL_MS,
    maxBytes: Math.floor((memoryCacheBudgets.index * 3) / 4),
  })

  getMemoryStats() {
    return { items: this.itemCache.getStats(), lists: this.listCache.getStats() }
  }

  resetMemory(): void {
    this.invalidateMemoryCache()
    invalidateCacheFileAvailability()
  }

  findByMetadata(username: string, location: string, quality: string, name: string, singer: string) {
    return getDb()
      .query<{ data: string; lyric_size: number }, [string, string, string, string, string]>(
        `
      SELECT data, lyric_size FROM cache_index
      WHERE location = ? AND user_name = ? AND quality = ? AND name_key = ? AND singer_key = ?
      ORDER BY folder, song_id
    `,
      )
      .all(location, username, quality, name.toLowerCase(), singer.toLowerCase())
      .map(row => this.parseItem(row.data, row.lyric_size))
      .filter((item): item is CacheItem => item !== null)
  }

  getPage(usernames: string[], request: CachePageRequest) {
    const db = getDb()
    const pageSize = 100
    const scope = 'folder = ? AND user_name IN (SELECT value FROM json_each(?))'
    const scopeParams = [request.folder, JSON.stringify(usernames)]
    const { totals, filtered, page, rows } = db.transaction(() => {
      const totals = db
        .query<{ total: number; size: number }, string[]>(
          `SELECT COUNT(*) AS total, COALESCE(SUM(audio_size), 0) AS size FROM cache_index WHERE ${scope}`,
        )
        .get(...scopeParams)!
      const condition = request.query
        ? ` AND (instr(name_key, ?) OR instr(singer_key, ?) OR
          instr(lower(json_extract(data, '$.filename')), ?) OR instr(lower(json_extract(data, '$.source')), ?))`
        : ''
      const needle = request.query.toLowerCase()
      const filters = [...scopeParams, ...(request.query ? [needle, needle, needle, needle] : [])]
      const where = `${scope} AND json_valid(data)${condition}`
      const filtered = request.query
        ? db
            .query<{ count: number }, string[]>(`SELECT COUNT(*) AS count FROM cache_index WHERE ${where}`)
            .get(...filters)!.count
        : totals.total
      const page = Math.min(request.page, Math.max(0, Math.ceil(filtered / pageSize) - 1))
      const orders = new Map([
        ['name-asc', 'name_key ASC, '],
        ['name-desc', 'name_key DESC, '],
        ['size-desc', 'audio_size DESC, '],
        ['time-desc', "json_extract(data, '$.mtime') DESC, "],
      ])
      const order = orders.get(request.sort) ?? ''
      const rows = db
        .query<{ data: string; lyric_size: number; location: string; user_name: string }, Array<string | number>>(
          `
      SELECT data, lyric_size, location, user_name FROM cache_index WHERE ${where}
      ORDER BY ${order} user_name, location = ? DESC, location, song_id, quality
      LIMIT ? OFFSET ?
    `,
        )
        .all(...filters, currentCacheLocation, pageSize, page * pageSize)
      return { totals, filtered, page, rows }
    })()
    const data = rows.flatMap(row => {
      const item = this.parseItem(row.data, row.lyric_size)
      return item
        ? [
            {
              ...item,
              location: row.location,
              username: row.user_name === '_open' ? '公共曲库' : row.user_name,
              rawUsername: row.user_name,
            },
          ]
        : []
    })
    return { data, page, pageSize, filtered, ...totals }
  }

  private itemCacheKey(
    username: string,
    folder: 'cache' | 'music',
    songId: string,
    quality: string | undefined,
    exact: boolean,
    location: string,
  ): string {
    return `${location}\u0000${username}\u0000${folder}\u0000${songId}\u0000${quality || ''}\u0000${exact ? '1' : '0'}`
  }

  private listCacheKey(username: string, folder: 'cache' | 'music', location: string): string {
    return `${location}\u0000${username}\u0000${folder}`
  }

  private invalidateMemoryCache(username?: string, folder?: 'cache' | 'music', location?: string): void {
    if (!username && !folder && !location) {
      this.itemCache.clear()
      this.listCache.clear()
      return
    }
    if (username && folder && location) {
      this.listCache.delete(this.listCacheKey(username, folder, location))
    } else {
      for (const key of this.listCache.keys()) {
        const [keyLocation, keyUsername, keyFolder] = key.split('\u0000')
        if (
          (!location || keyLocation === location) &&
          (!username || keyUsername === username) &&
          (!folder || keyFolder === folder)
        ) {
          this.listCache.delete(key)
        }
      }
    }
    for (const key of this.itemCache.keys()) {
      const [keyLocation, keyUsername, keyFolder] = key.split('\u0000')
      if (
        (!location || keyLocation === location) &&
        (!username || keyUsername === username) &&
        (!folder || keyFolder === folder)
      ) {
        this.itemCache.delete(key)
      }
    }
  }

  private cacheItem(
    username: string,
    folder: 'cache' | 'music',
    songId: string,
    quality: string | undefined,
    exact: boolean,
    location: string,
    item: CacheItem | null,
  ): void {
    this.itemCache.set(this.itemCacheKey(username, folder, songId, quality, exact, location), { item })
  }

  private parseItem(data: string, lyricSize = 0): CacheItem | null {
    try {
      const item = JSON.parse(data) as CacheItem
      const normalizedLyricSize = Number(lyricSize)
      if (item.lyricSize === undefined && Number.isFinite(normalizedLyricSize) && normalizedLyricSize > 0) {
        item.lyricSize = Math.trunc(normalizedLyricSize)
      }
      return item
    } catch {
      return null
    }
  }

  load(username: string, folder: 'cache' | 'music', location?: string): Map<string, CacheItem> {
    const loc = location || currentCacheLocation
    const map = new Map<string, CacheItem>()
    try {
      const db = getDb()
      const rows = db
        .query<{ song_id: string; quality: string; data: string; lyric_size: number }, [string, string, string]>(
          'SELECT song_id, quality, data, lyric_size FROM cache_index WHERE location = ? AND user_name = ? AND folder = ?',
        )
        .all(loc, username, folder)

      for (const row of rows) {
        const item = this.parseItem(row.data, row.lyric_size)
        if (item) map.set(`${row.song_id}_${row.quality}`, item)
      }
    } catch (e) {
      console.error(`[CacheIndex] Failed to load from SQLite for ${username}:${folder}:`, e)
    }
    return map
  }

  save(username: string, folder: 'cache' | 'music', location?: string) {
    // In SQLite mode, update() directly persists records, so save() is a no-op kept for API compatibility.
  }

  get(
    username: string,
    songId: string,
    folder: 'cache' | 'music',
    quality?: string,
    exact: boolean = false,
    location?: string,
  ): CacheItem | undefined {
    const loc = location || currentCacheLocation
    const key = this.itemCacheKey(username, folder, songId, quality, exact, loc)
    const cached = this.itemCache.get(key)
    if (cached) {
      return cached.item || undefined
    }
    this.itemCache.delete(key)
    let result: CacheItem | null = null
    try {
      const db = getDb()

      if (quality) {
        const row = db
          .query<{ data: string; lyric_size: number }, [string, string, string, string, string]>(
            'SELECT data, lyric_size FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? AND quality = ?',
          )
          .get(loc, username, folder, songId, quality)
        if (row) {
          result = this.parseItem(row.data, row.lyric_size)
        }
        if (result || exact) {
          this.cacheItem(username, folder, songId, quality, exact, loc, result)
          return result || undefined
        }
      }

      // Fallback: 非精确模式下获取同 ID 的任意质量
      const row = db
        .query<{ data: string; lyric_size: number }, [string, string, string, string]>(
          'SELECT data, lyric_size FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? LIMIT 1',
        )
        .get(loc, username, folder, songId)
      if (row) {
        result = this.parseItem(row.data, row.lyric_size)
      }
    } catch (e) {
      console.error(`[CacheIndex] Failed to get cache item for ${username}:${songId}:`, e)
    }
    this.cacheItem(username, folder, songId, quality, exact, loc, result)
    return result || undefined
  }

  update(username: string, item: CacheItem, folder: 'cache' | 'music', location?: string, throwOnError = false) {
    const loc = location || currentCacheLocation
    this.invalidateMemoryCache(username, folder, loc)
    invalidateCacheFileAvailability()
    const quality = item.quality || 'unknown'
    try {
      const db = getDb()
      const audioSize = Number(item.size)
      const lyricSize = Number(item.lyricSize)
      db.run(
        'INSERT OR REPLACE INTO cache_index (location, user_name, folder, song_id, quality, data, updated_at, audio_size, lyric_size, name_key, singer_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          loc,
          username,
          folder,
          item.id,
          quality,
          JSON.stringify(item),
          Date.now(),
          Number.isFinite(audioSize) && audioSize > 0 ? Math.trunc(audioSize) : 0,
          Number.isFinite(lyricSize) && lyricSize > 0 ? Math.trunc(lyricSize) : 0,
          String(item.name ?? '').toLowerCase(),
          String(item.singer ?? '').toLowerCase(),
        ],
      )
    } catch (e) {
      console.error(`[CacheIndex] Failed to update cache item for ${username}:${item.id}:`, e)
      if (throwOnError) throw e
    }
  }

  remove(username: string, songId: string, folder: 'cache' | 'music', quality?: string, location?: string): boolean {
    const loc = location || currentCacheLocation
    this.invalidateMemoryCache(username, folder, loc)
    invalidateCacheFileAvailability()
    try {
      const db = getDb()
      if (quality) {
        const res = db.run(
          'DELETE FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? AND quality = ?',
          [loc, username, folder, songId, quality],
        )
        return (res.changes ?? 0) > 0
      }
      const res = db.run(
        'DELETE FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ?',
        [loc, username, folder, songId],
      )
      return (res.changes ?? 0) > 0
    } catch (e) {
      console.error(`[CacheIndex] Failed to remove cache item for ${username}:${songId}:`, e)
      return false
    }
  }

  clear(username: string, folder: 'cache' | 'music', location?: string): number {
    const loc = location || currentCacheLocation
    this.invalidateMemoryCache(username, folder, loc)
    invalidateCacheFileAvailability()
    try {
      const db = getDb()
      const result = db.run('DELETE FROM cache_index WHERE location = ? AND user_name = ? AND folder = ?', [
        loc,
        username,
        folder,
      ])
      return result.changes ?? 0
    } catch (e) {
      console.error(`[CacheIndex] Failed to clear cache index for ${username}:${folder}:`, e)
      return 0
    }
  }

  getAll(username: string, folder: 'cache' | 'music', location?: string): CacheItem[] {
    const loc = location || currentCacheLocation
    const key = this.listCacheKey(username, folder, loc)
    const cached = this.listCache.get(key)
    if (cached) {
      return cached.items
    }
    this.listCache.delete(key)
    try {
      const db = getDb()
      const rows = db
        .query<{ data: string; lyric_size: number }, [string, string, string]>(
          'SELECT data, lyric_size FROM cache_index WHERE location = ? AND user_name = ? AND folder = ?',
        )
        .all(loc, username, folder)

      const list: CacheItem[] = []
      for (const row of rows) {
        const item = this.parseItem(row.data, row.lyric_size)
        if (item) list.push(item)
      }
      this.listCache.set(key, { items: list })
      return list
    } catch (e) {
      console.error(`[CacheIndex] Failed to getAll cache items for ${username}:${folder}:`, e)
      return []
    }
  }

  discard(username: string, folder: 'cache' | 'music', location?: string) {
    // No-op for SQLite since queries are directly executed against the database
  }

  getStats(username?: string): { stats: CacheStatsSummary; hasRows: boolean } {
    const stats: CacheStatsSummary = {
      cache: { totalSize: 0, fileCount: 0 },
      music: { totalSize: 0, fileCount: 0 },
      totalSize: 0,
      fileCount: 0,
    }
    try {
      const db = getDb()
      const rows = username
        ? db
            .query<{ folder: CacheFolder; total_size: number; file_count: number }, [string]>(
              'SELECT folder, COALESCE(SUM(audio_size + lyric_size), 0) AS total_size, COUNT(*) AS file_count FROM cache_index WHERE user_name = ? GROUP BY folder',
            )
            .all(username)
        : db
            .query<{ folder: CacheFolder; total_size: number; file_count: number }, []>(
              'SELECT folder, COALESCE(SUM(audio_size + lyric_size), 0) AS total_size, COUNT(*) AS file_count FROM cache_index GROUP BY folder',
            )
            .all()

      for (const row of rows) {
        if (row.folder !== 'cache' && row.folder !== 'music') continue
        const totalSize = Math.max(0, Number(row.total_size) || 0)
        const fileCount = Math.max(0, Number(row.file_count) || 0)
        stats[row.folder].totalSize += totalSize
        stats[row.folder].fileCount += fileCount
        stats.totalSize += totalSize
        stats.fileCount += fileCount
      }
      return { stats, hasRows: rows.length > 0 }
    } catch (error) {
      console.error(`[CacheIndex] Failed to aggregate cache stats${username ? ` for ${username}` : ''}:`, error)
      return { stats, hasRows: false }
    }
  }
}

export const indexManager = new CacheIndexManager()

const CACHE_FILE_AVAILABILITY_TTL_MS = 1_000
const CACHE_FILE_AVAILABILITY_MAX = 2_048
const cacheFileAvailability = new Map<string, { usable: boolean; expiresAt: number }>()

export function invalidateCacheFileAvailability(): void {
  cacheFileAvailability.clear()
}

export const isUsableCacheFile = (filePath: string | null) => {
  if (!filePath) return false
  const cached = cacheFileAvailability.get(filePath)
  if (cached && cached.expiresAt > Date.now()) {
    cacheFileAvailability.delete(filePath)
    cacheFileAvailability.set(filePath, cached)
    return cached.usable
  }
  cacheFileAvailability.delete(filePath)
  let usable = false
  try {
    const stats = fs.statSync(filePath)
    usable = stats.isFile() && stats.size > 0
  } catch {
    usable = false
  }
  cacheFileAvailability.set(filePath, { usable, expiresAt: Date.now() + CACHE_FILE_AVAILABILITY_TTL_MS })
  while (cacheFileAvailability.size > CACHE_FILE_AVAILABILITY_MAX) {
    const oldest = cacheFileAvailability.keys().next().value
    if (!oldest) break
    cacheFileAvailability.delete(oldest)
  }
  return usable
}

export const setCacheLocation = (location: string) => {
  if (location === CACHE_ROOTS.DATA || location === CACHE_ROOTS.ROOT) {
    currentCacheLocation = location
    console.log(`[FileCache] Base cache location set to: ${location}`)
  }
}

export const getCacheLocation = () => currentCacheLocation
