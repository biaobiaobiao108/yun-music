

import fs from 'fs'
import type { Stats } from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import { PassThrough } from 'stream'
import { buildLyrics, parseLyrics } from '../utils/lrcTool'
import { formatPlayTime } from '../common/utils/common'
import { getDb } from '@/database'
import { assertSafePathSegment, isPathInside, resolveInside } from '@/utils/pathSecurity'
import { assertSafeRemoteHttpUrl, type SafeRemoteHttpUrl } from './networkSecurity'
import { LRUCache } from 'lru-cache'

type MusicTagNative = {
    MusicTagger: new () => any
    MetaPicture: new (mime: string, data: Uint8Array, type: string) => any
}

let musicTagNative: MusicTagNative | null = null
const getMusicTagNative = (): MusicTagNative => {
    if (!musicTagNative) musicTagNative = require('music-tag-native') as MusicTagNative
    return musicTagNative
}

// --- Cache Naming Patterns ---
export const CACHE_NAMING_PATTERNS = {
    STANDARD: 'standard',       // {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
    SIMPLE: 'simple'            // {Name} - {Singer} - {Quality} - {Album}
}

let currentNamingPattern = CACHE_NAMING_PATTERNS.SIMPLE

export const normalizeNamingPattern = (pattern: unknown) => (
    pattern === CACHE_NAMING_PATTERNS.STANDARD
        ? CACHE_NAMING_PATTERNS.STANDARD
        : CACHE_NAMING_PATTERNS.SIMPLE
)

export const setNamingPattern = (pattern: unknown) => {
    currentNamingPattern = normalizeNamingPattern(pattern)
    return currentNamingPattern
}

// Define the two possible cache roots
export const CACHE_ROOTS = {
    DATA: 'data', // inside global.lx.dataPath (application data)
    ROOT: 'root'  // relative to process.cwd() (local instance storage)
}

let currentCacheLocation = CACHE_ROOTS.ROOT
const CACHE_LIST_SYNC_TTL = 30 * 1000
const cacheListSyncState = new LRUCache<string, { lastSync: number, pending?: Promise<void> }>({
    max: 2048,
    ttl: 10 * 60 * 1000,
})

const getCacheLocations = () => [
    currentCacheLocation,
    currentCacheLocation === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA,
]

// Helper to get actual directory path
// [Unified Enhancement] Cache Progress Tracker
export const cacheProgress: Map<string, { progress: number; status: string; total?: number; received?: number; speed?: number; updatedAt?: number; errorMsg?: string }> = new Map()
const CACHE_PROGRESS_TTL = 30 * 1000
const CACHE_PROGRESS_ACTIVE_TTL = 10 * 60 * 1000
const CACHE_PROGRESS_MAX_ENTRIES = 4096
let cacheProgressCleanupTimer: ReturnType<typeof setTimeout> | null = null

export const cleanupExpiredCacheProgress = (now = Date.now()) => {
    const expiredBefore = now - CACHE_PROGRESS_TTL
    let removed = 0
    for (const [key, progress] of cacheProgress) {
        const updatedAt = progress.updatedAt || 0
        const terminal = ['error', 'finished', 'exists'].includes(progress.status)
        const expiry = terminal ? expiredBefore : now - CACHE_PROGRESS_ACTIVE_TTL
        if (updatedAt > 0 && updatedAt <= expiry) {
            cacheProgress.delete(key)
            removed++
        }
    }
    if (cacheProgress.size === 0 && cacheProgressCleanupTimer) {
        clearTimeout(cacheProgressCleanupTimer)
        cacheProgressCleanupTimer = null
    }
    return removed
}

const scheduleCacheProgressCleanup = () => {
    if (cacheProgressCleanupTimer || cacheProgress.size === 0) return
    cacheProgressCleanupTimer = setTimeout(() => {
        cacheProgressCleanupTimer = null
        cleanupExpiredCacheProgress()
        if (cacheProgress.size > 0) scheduleCacheProgressCleanup()
    }, CACHE_PROGRESS_TTL)
    ;(cacheProgressCleanupTimer as any)?.unref?.()
}

export const setCacheProgress = (
    key: string,
    progress: { progress: number; status: string; total?: number; received?: number; speed?: number; updatedAt?: number; errorMsg?: string },
) => {
    cacheProgress.set(key, { ...progress, updatedAt: progress.updatedAt || Date.now() })
    while (cacheProgress.size > CACHE_PROGRESS_MAX_ENTRIES) {
        let oldestKey: string | undefined
        let oldestUpdatedAt = Number.POSITIVE_INFINITY
        for (const [candidateKey, candidate] of cacheProgress) {
            const updatedAt = candidate.updatedAt || 0
            if (updatedAt < oldestUpdatedAt) {
                oldestUpdatedAt = updatedAt
                oldestKey = candidateKey
            }
        }
        if (oldestKey === undefined) break
        cacheProgress.delete(oldestKey)
    }
    scheduleCacheProgressCleanup()
}

const CACHE_POST_PROCESS_CONCURRENCY = 1
const CACHE_MEMORY_GC_THRESHOLD = 256 * 1024 * 1024
const CACHE_MEMORY_GC_INTERVAL = 30 * 1000
let cachePostProcessActive = 0
let lastForcedCacheGcAt = 0
let lastCacheMemoryLogAt = 0
type CachePostProcessWaiter = {
    resolve: () => void
    reject: (error: Error) => void
    signal?: AbortSignal
    abortHandler?: () => void
}
const cachePostProcessWaiters: CachePostProcessWaiter[] = []

const cleanupCachePostProcessWaiter = (waiter: CachePostProcessWaiter) => {
    if (waiter.signal && waiter.abortHandler) waiter.signal.removeEventListener('abort', waiter.abortHandler)
}

const releaseCachePostProcess = () => {
    cachePostProcessActive = Math.max(0, cachePostProcessActive - 1)
    while (cachePostProcessWaiters.length > 0) {
        const waiter = cachePostProcessWaiters.shift()!
        cleanupCachePostProcessWaiter(waiter)
        if (waiter.signal?.aborted) {
            waiter.reject(new Error('Aborted'))
            continue
        }
        cachePostProcessActive += 1
        waiter.resolve()
        return
    }
}

const acquireCachePostProcess = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new Error('Aborted'))
    if (cachePostProcessActive < CACHE_POST_PROCESS_CONCURRENCY) {
        cachePostProcessActive += 1
        return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
        const waiter: CachePostProcessWaiter = { resolve, reject, signal }
        waiter.abortHandler = () => {
            const index = cachePostProcessWaiters.indexOf(waiter)
            if (index !== -1) cachePostProcessWaiters.splice(index, 1)
            cleanupCachePostProcessWaiter(waiter)
            reject(new Error('Aborted'))
        }
        signal?.addEventListener('abort', waiter.abortHandler, { once: true })
        cachePostProcessWaiters.push(waiter)
    })
}

const getCacheMemoryUsage = () => {
    const memory = process.memoryUsage()
    return {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
    }
}

const formatMemoryMiB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MiB`

const reportCacheMemory = (stage: string, force = false) => {
    const now = Date.now()
    const memory = getCacheMemoryUsage()
    if (!force && now - lastCacheMemoryLogAt < CACHE_MEMORY_GC_INTERVAL && memory.rss < CACHE_MEMORY_GC_THRESHOLD) return
    lastCacheMemoryLogAt = now
    console.log(`[FileCache][Memory] ${stage}: rss=${formatMemoryMiB(memory.rss)}, heap=${formatMemoryMiB(memory.heapUsed)}, external=${formatMemoryMiB(memory.external)}, postProcess=${cachePostProcessActive}, waiting=${cachePostProcessWaiters.length}`)
}

const maybeCollectCacheMemory = (stage: string) => {
    const now = Date.now()
    const before = getCacheMemoryUsage()
    if (before.rss < CACHE_MEMORY_GC_THRESHOLD || now - lastForcedCacheGcAt < CACHE_MEMORY_GC_INTERVAL) {
        reportCacheMemory(stage)
        return
    }
    if (typeof Bun === 'undefined' || typeof Bun.gc !== 'function') {
        reportCacheMemory(`${stage} (gc unavailable)`, true)
        return
    }

    lastForcedCacheGcAt = now
    try {
        Bun.gc(true)
    } catch (error: any) {
        console.warn(`[FileCache][Memory] Full GC failed: ${error?.message || error}`)
    }
    const after = getCacheMemoryUsage()
    reportCacheMemory(`${stage} gc ${formatMemoryMiB(before.rss)} -> ${formatMemoryMiB(after.rss)}`, true)
}

export const withCachePostProcess = async <T>(signal: AbortSignal | undefined, stage: string, callback: () => Promise<T>): Promise<T> => {
    await acquireCachePostProcess(signal)
    try {
        if (signal?.aborted) throw new Error('Aborted')
        reportCacheMemory(`${stage} start`)
        return await callback()
    } finally {
        releaseCachePostProcess()
        maybeCollectCacheMemory(`${stage} end`)
    }
}

export const getCachePostProcessStats = () => ({
    active: cachePostProcessActive,
    waiting: cachePostProcessWaiters.length,
})

// [新增] 歌词获取钩子：由 server.ts 在启动时注入，避免 fileCache 直接依赖 musicSdk
// 调用时会通过 /api/music/lyric 接口逻辑（先查本地 .lrc 缓存，再去源站）获取歌词文本
type LyricFetcher = (songInfo: any) => Promise<string | null>
let _lyricFetcher: LyricFetcher | null = null
export const setLyricFetcher = (fn: LyricFetcher) => { _lyricFetcher = fn }

export const getCacheDir = (username?: string, isOnlyDownload?: boolean, location?: string) => {
    const folderName = isOnlyDownload ? 'music' : 'cache'
    const loc = location || currentCacheLocation
    let baseDir = ''
    if (loc === CACHE_ROOTS.DATA) {
        baseDir = path.join(global.lx.dataPath, folderName)
    } else {
        baseDir = path.join(process.cwd(), folderName)
    }

    // [New] Segment cache by username
    const userDirName = (username && username !== '_open' && username !== 'default') ? assertSafePathSegment(username, 'username') : '_open'

    const fullPath = path.join(baseDir, userDirName)
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true })
    }
    if (!isPathInside(fs.realpathSync.native(baseDir), fs.realpathSync.native(fullPath))) {
        throw new Error('Cache directory escapes allowed root')
    }
    return fullPath
}

export const getCoverCacheDir = (username: string) => {
    const baseDir = path.join(process.cwd(), 'cover_cache')
    const userDirName = (username && username !== '_open' && username !== 'default') ? assertSafePathSegment(username, 'username') : '_open'
    const fullPath = path.join(baseDir, userDirName)
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true })
    }
    if (!isPathInside(fs.realpathSync.native(baseDir), fs.realpathSync.native(fullPath))) {
        throw new Error('Cover cache directory escapes allowed root')
    }
    return fullPath
}

// --- Cache Index Manager ---
export interface CacheItem {
    id: string
    songmid?: string
    name: string
    singer: string
    album: string
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

export interface RemoveCacheFileResult {
    deleted: boolean
    folder?: CacheFolder
}

export interface DownloadProvenance {
    requestedSource?: string
    downloadSource?: string
    sourceName?: string
}

class CacheIndexManager {
    load(username: string, folder: 'cache' | 'music', location?: string): Map<string, CacheItem> {
        const loc = location || currentCacheLocation
        const map = new Map<string, CacheItem>()
        try {
            const db = getDb()
            const rows = db.query<{ song_id: string; quality: string; data: string }, [string, string, string]>(
                'SELECT song_id, quality, data FROM cache_index WHERE location = ? AND user_name = ? AND folder = ?'
            ).all(loc, username, folder)

            for (const row of rows) {
                try {
                    const item = JSON.parse(row.data) as CacheItem
                    map.set(`${row.song_id}_${row.quality}`, item)
                } catch {
                    // skip corrupted json
                }
            }
        } catch (e) {
            console.error(`[CacheIndex] Failed to load from SQLite for ${username}:${folder}:`, e)
        }
        return map
    }

    save(username: string, folder: 'cache' | 'music', location?: string) {
        // In SQLite mode, update() directly persists records, so save() is a no-op kept for API compatibility.
    }

    get(username: string, songId: string, folder: 'cache' | 'music', quality?: string, exact: boolean = false, location?: string): CacheItem | undefined {
        const loc = location || currentCacheLocation
        try {
            const db = getDb()

            if (quality) {
                const row = db.query<{ data: string }, [string, string, string, string, string]>(
                    'SELECT data FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? AND quality = ?'
                ).get(loc, username, folder, songId, quality)
                if (row) {
                    try { return JSON.parse(row.data) as CacheItem } catch {}
                }
                if (exact) return undefined
            }

            // Fallback: 非精确模式下获取同 ID 的任意质量
            const row = db.query<{ data: string }, [string, string, string, string]>(
                'SELECT data FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? LIMIT 1'
            ).get(loc, username, folder, songId)
            if (row) {
                try { return JSON.parse(row.data) as CacheItem } catch {}
            }
        } catch (e) {
            console.error(`[CacheIndex] Failed to get cache item for ${username}:${songId}:`, e)
        }
        return undefined
    }

    update(username: string, item: CacheItem, folder: 'cache' | 'music', location?: string) {
        const loc = location || currentCacheLocation
        const quality = item.quality || 'unknown'
        try {
            const db = getDb()
            db.run(
                'INSERT OR REPLACE INTO cache_index (location, user_name, folder, song_id, quality, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [loc, username, folder, item.id, quality, JSON.stringify(item), Date.now()]
            )
        } catch (e) {
            console.error(`[CacheIndex] Failed to update cache item for ${username}:${item.id}:`, e)
        }
    }

    remove(username: string, songId: string, folder: 'cache' | 'music', quality?: string, location?: string): boolean {
        const loc = location || currentCacheLocation
        try {
            const db = getDb()
            if (quality) {
                const res = db.run(
                    'DELETE FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ? AND quality = ?',
                    [loc, username, folder, songId, quality]
                )
                return (res.changes ?? 0) > 0
            }
            const res = db.run(
                'DELETE FROM cache_index WHERE location = ? AND user_name = ? AND folder = ? AND song_id = ?',
                [loc, username, folder, songId]
            )
            return (res.changes ?? 0) > 0
        } catch (e) {
            console.error(`[CacheIndex] Failed to remove cache item for ${username}:${songId}:`, e)
            return false
        }
    }

    clear(username: string, folder: 'cache' | 'music', location?: string): number {
        const loc = location || currentCacheLocation
        try {
            const db = getDb()
            const result = db.run(
                'DELETE FROM cache_index WHERE location = ? AND user_name = ? AND folder = ?',
                [loc, username, folder],
            )
            return result.changes ?? 0
        } catch (e) {
            console.error(`[CacheIndex] Failed to clear cache index for ${username}:${folder}:`, e)
            return 0
        }
    }

    getAll(username: string, folder: 'cache' | 'music', location?: string): CacheItem[] {
        const loc = location || currentCacheLocation
        try {
            const db = getDb()
            const rows = db.query<{ data: string }, [string, string, string]>(
                'SELECT data FROM cache_index WHERE location = ? AND user_name = ? AND folder = ?'
            ).all(loc, username, folder)

            const list: CacheItem[] = []
            for (const r of rows) {
                try {
                    list.push(JSON.parse(r.data) as CacheItem)
                } catch {}
            }
            return list
        } catch (e) {
            console.error(`[CacheIndex] Failed to getAll cache items for ${username}:${folder}:`, e)
            return []
        }
    }

    discard(username: string, folder: 'cache' | 'music', location?: string) {
        // No-op for SQLite since queries are directly executed against the database
    }
}

export const indexManager = new CacheIndexManager()

const COVER_CHECK_VERSION = 5

const getCoverCacheHash = (filename: string, stats?: Stats) => {
    const version = stats ? `${stats.size}:${stats.mtimeMs}` : ''
    return crypto.createHash('md5').update(`${filename}:${version}`).digest('hex')
}

const getCoverCachePaths = (filename: string, username: string, stats?: Stats) => {
    const hash = getCoverCacheHash(filename, stats)
    const coverCacheDir = getCoverCacheDir(username)
    return {
        binPath: path.join(coverCacheDir, `${hash}.bin`),
        mimePath: path.join(coverCacheDir, `${hash}.mime`),
    }
}

const getLegacyCoverCachePaths = (filename: string, username: string, stats?: Stats) => {
    const hash = getCoverCacheHash(filename, stats)
    const userDirName = (username && username !== '_open' && username !== 'default') ? assertSafePathSegment(username, 'username') : '_open'
    const coverCacheDir = path.join(global.lx.dataPath, 'cover_cache', userDirName)
    return {
        binPath: path.join(coverCacheDir, `${hash}.bin`),
        mimePath: path.join(coverCacheDir, `${hash}.mime`),
    }
}

const detectImageMime = (data: Buffer | Uint8Array) => {
    const buffer = Buffer.from(data)
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif'
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
    return null
}

const readCoverCache = (filename: string, username: string, stats?: Stats) => {
    const candidates = [getCoverCachePaths(filename, username, stats), getLegacyCoverCachePaths(filename, username, stats)]
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate.binPath) || !fs.existsSync(candidate.mimePath)) continue
            const data = fs.readFileSync(candidate.binPath)
            const detectedMime = detectImageMime(data)
            if (!detectedMime) continue
            const storedMime = fs.readFileSync(candidate.mimePath, 'utf8').trim()
            const persistent = getCoverCachePaths(filename, username, stats)
            if (candidate.binPath !== persistent.binPath) {
                fs.copyFileSync(candidate.binPath, persistent.binPath)
                fs.writeFileSync(persistent.mimePath, detectedMime || storedMime || 'image/jpeg')
            }
            return { data, mime: detectedMime || storedMime || 'image/jpeg' }
        } catch (e) { }
    }
    return null
}

const hasCachedCover = (filename: string, username: string, stats?: Stats) => {
    return !!readCoverCache(filename, username, stats)
}

const writeCoverCache = (filename: string, username: string, data: Buffer | Uint8Array, mime: string, stats?: Stats) => {
    const coverData = Buffer.from(data)
    const detectedMime = detectImageMime(coverData)
    if (!detectedMime) return false
    const { binPath, mimePath } = getCoverCachePaths(filename, username, stats)
    fs.writeFileSync(binPath, coverData)
    fs.writeFileSync(mimePath, detectedMime || mime || 'image/jpeg')
    return true
}

export const resolveCacheRelativePath = (dir: string, filename: string) => {
    try {
        return resolveInside(dir, filename)
    } catch {
        return null
    }
}

const isUsableCacheFile = (filePath: string | null) => {
    if (!filePath) return false
    try {
        const stats = fs.statSync(filePath)
        return stats.isFile() && stats.size > 0
    } catch {
        return false
    }
}

type CompanionLyricFile = {
    filename: string
    path: string
}

/**
 * Resolve the lyric file next to an audio file. Older downloads can contain
 * an upper-case extension, so the lookup is intentionally case-insensitive.
 */
const findCompanionLyricFile = (root: string, audioFilename: string): CompanionLyricFile | null => {
    const normalizedAudioFilename = String(audioFilename || '').replace(/\\/g, '/')
    const extension = path.extname(normalizedAudioFilename)
    if (!extension) return null

    const baseFilename = normalizedAudioFilename.slice(0, -extension.length)
    const expectedName = `${path.basename(baseFilename)}.lrc`.toLowerCase()
    const parentRelativePath = path.dirname(baseFilename).replace(/\\/g, '/')
    const parentPath = resolveCacheRelativePath(root, parentRelativePath === '.' ? '' : parentRelativePath)
    if (!parentPath || !fs.existsSync(parentPath)) return null

    try {
        const entry = fs.readdirSync(parentPath, { withFileTypes: true }).find(candidate => (
            candidate.isFile() && candidate.name.toLowerCase() === expectedName
        ))
        if (entry) {
            const filename = path.join(parentRelativePath === '.' ? '' : parentRelativePath, entry.name).replace(/\\/g, '/')
            const lyricPath = resolveCacheRelativePath(root, filename)
            return lyricPath ? { filename, path: lyricPath } : null
        }

        const exactFilename = `${baseFilename}.lrc`
        const exactPath = resolveCacheRelativePath(root, exactFilename)
        return exactPath && fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()
            ? { filename: exactFilename, path: exactPath }
            : null
    } catch {
        return null
    }
}

export const resolveCompanionLyricFilename = (root: string, audioFilename: string) => (
    findCompanionLyricFile(root, audioFilename)?.filename
)

const invalidateCacheListSync = (username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    cacheListSyncState.delete(`${currentCacheLocation}:${normalizedUsername}`)
}

const reconcileCacheItemFromDisk = (
    username: string,
    folder: 'cache' | 'music',
    item: CacheItem,
    filePath: string,
    stats?: Stats,
) => {
    if (!fs.existsSync(filePath)) return false

    let actualStats: Stats
    try {
        actualStats = stats || fs.statSync(filePath)
        if (!actualStats.isFile()) return false
    } catch {
        return false
    }

    const root = getCacheDir(username, folder === 'music')
    const lyricFile = findCompanionLyricFile(root, item.filename)
    const hasLyric = !!lyricFile
    const hasEmbeddedCover = readEmbeddedCoverState(filePath)
    const hasExternalCover = !hasEmbeddedCover && hasCachedCover(item.filename, username, actualStats)
    const coverType: CacheItem['coverType'] = hasEmbeddedCover
        ? 'embedded'
        : hasExternalCover
            ? 'cached'
            : hasUsableRemoteCover(item.img)
                ? 'remote'
                : 'none'
    const hasCover = coverType !== 'none'
    const nextLyricFilename = lyricFile?.filename

    const changed = item.hasLyric !== hasLyric ||
        item.lyricFilename !== nextLyricFilename ||
        item.hasCover !== hasCover ||
        item.coverType !== coverType ||
        item.size !== actualStats.size ||
        item.mtime !== actualStats.mtimeMs ||
        item.coverCheckedVersion !== COVER_CHECK_VERSION ||
        item.coverCheckedMtime !== actualStats.mtimeMs ||
        item.coverCheckedSize !== actualStats.size

    if (!changed) return false

    item.hasLyric = hasLyric
    item.lyricFilename = nextLyricFilename
    item.hasCover = hasCover
    item.coverType = coverType
    item.size = actualStats.size
    item.mtime = actualStats.mtimeMs
    item.coverCheckedVersion = COVER_CHECK_VERSION
    item.coverCheckedMtime = actualStats.mtimeMs
    item.coverCheckedSize = actualStats.size
    indexManager.update(username, item, folder)
    invalidateCacheListSync(username)
    return true
}

const hasValidPictureData = (picture: any) => {
    if (!picture || !picture.data) return false
    try {
        return !!detectImageMime(Buffer.from(picture.data))
    } catch (e) {
        return false
    }
}

const hasValidEmbeddedCover = (pictures: any) => {
    return Array.isArray(pictures) && pictures.some(hasValidPictureData)
}

const isPlaceholderCoverUrl = (url: any) => {
    return typeof url === 'string' && /\/T002R\d+x\d+M000\.jpg(?:$|\?)/.test(url)
}

const hasUsableRemoteCover = (url: any) => typeof url === 'string' && /^https?:\/\//i.test(url) && !isPlaceholderCoverUrl(url)

const detectAudioContainer = (filePath: string) => {
    try {
        const fd = fs.openSync(filePath, 'r')
        const buffer = Buffer.alloc(16)
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
        fs.closeSync(fd)
        const head = buffer.subarray(0, bytesRead)
        if (head.subarray(0, 3).toString('ascii') === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'mp3'
        if (head.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
        if (head.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
        if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
        if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4'
        if (head.subarray(0, 4).toString('ascii') === 'MAC ') return 'ape'
        if (head[0] === 0x7b) return 'encrypted'
        return 'unknown'
    } catch (e) {
        return 'unknown'
    }
}

const getMetadataUnsupportedMessage = (container: string) => (
    container === 'encrypted'
        ? '音频为加密或非标准容器，无法写入封面和歌词标签'
        : '当前音频容器不支持写入封面和歌词标签'
)

export const getAudioMetadataUnsupportedStatus = (filePath: string) => {
    const audioContainer = detectAudioContainer(filePath)
    return {
        audioContainer,
        metadataWritable: false,
        error: getMetadataUnsupportedMessage(audioContainer),
    }
}

const readEmbeddedCoverState = (filePath: string) => {
    let tagger: any
    try {
        tagger = new (getMusicTagNative().MusicTagger)()
        tagger.loadPath(filePath)
        return hasValidEmbeddedCover(tagger.pictures)
    } catch (e) {
        return false
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
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
    } catch (e: any) {
        return {
            success: false,
            hasEmbedLyric: false,
            audioContainer,
            metadataWritable: false,
            error: getMetadataUnsupportedMessage(audioContainer),
        }
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
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
    } catch (e: any) {
        return {
            success: false,
            hasEmbedLyric: false,
            audioContainer,
            metadataWritable: false,
            error: getMetadataUnsupportedMessage(audioContainer),
        }
    } finally {
        try { if (verifyTagger) verifyTagger.dispose() } catch (e) { }
    }
}

// Ensure directory exists
const ensureDir = (username?: string, isOnlyDownload?: boolean) => {
    const dir = getCacheDir(username, isOnlyDownload)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
    return dir
}

// Safe rename: try rename, fall back to copy+unlink if rename fails (cross-device, permissions, etc.)
const safeRenameSync = (src: string, dst: string) => {
    try {
        fs.renameSync(src, dst)
        return true
    } catch (err) {
        try {
            fs.copyFileSync(src, dst)
            fs.unlinkSync(src)
            return true
        } catch (err2) {
            throw err // keep original error context
        }
    }
}

/**
 * 规范化歌曲 ID：确保带上 source 前缀，与索引中的 Key 保持一致
 */
export const normalizeSongId = (songInfo: any): string => {
    let id = String(songInfo.songmid || songInfo.songId || songInfo.id || '')
    const source = songInfo.source || 'unknown'
    if (id && !id.includes('_') && source !== 'unknown') {
        id = `${source}_${id}`
    }
    return id
}

/**
 * Extract rich metadata from Lx songInfo object
 */
const extractSongMetadata = (songInfo: any) => {
    const meta = songInfo.meta || {}
    const id = normalizeSongId(songInfo)
    return {
        id: id,
        name: songInfo.name || meta.songName || 'Unknown',
        singer: songInfo.singer || meta.singerName || 'Unknown',
        album: songInfo.albumName || meta.albumName ||
            (typeof songInfo.album === 'string' ? songInfo.album : songInfo.album?.name) || '',
        albumId: String(songInfo.albumId || meta.albumId || ''),
        img: songInfo.img || meta.picUrl || '',
        interval: songInfo.interval || meta.interval || '',
        source: songInfo.source || 'unknown'
    }
}

/**
 * Detect quality tag from bitrate and file metadata
 */
const detectQualityFromBitrate = (bitrate: number | undefined, ext: string, tagger?: any): LX.Quality => {
    const nativeQuality = String(tagger?.quality || '').toLowerCase()
    const isLossless = ext === '.flac' || ext === '.wav' || ext === '.ape' || nativeQuality === 'sq' || nativeQuality === 'hires'
    const br = bitrate || 0 // Already in kbps from music-tag-native

    if (isLossless) {
        const bitDepth = tagger?.bitDepth || 16
        const sampleRate = tagger?.sampleRate || 44100

        if (br > 4500 || sampleRate > 96000) return 'master' as LX.Quality
        if (br > 1000 || bitDepth > 16 || sampleRate > 48000) return 'flac24bit'
        return 'flac'
    }

    // Lossy formats (mp3, m4a, etc.)
    if (br >= 240) return '320k'
    if (br >= 170) return '192k'
    return '128k'
}

const losslessQualitySet = new Set(['flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'ape', 'wav'])

const isClearlyLossyAudio = (container: string, tagger?: any) => {
    const nativeQuality = String(tagger?.quality || '').toLowerCase()
    return nativeQuality === 'hq' || container === 'mp3' || container === 'ogg'
}

const resolveInspectedQuality = (requestedQuality: string | undefined, detectedQuality: string, container: string, tagger?: any) => {
    if (isClearlyLossyAudio(container, tagger)) return detectedQuality
    if (requestedQuality && losslessQualitySet.has(requestedQuality)) return requestedQuality
    return detectedQuality
}

const needsQualityCorrection = (quality: string | undefined, container: string) => (
    !!quality && losslessQualitySet.has(quality) && (container === 'mp3' || container === 'ogg')
)

const inspectAudioFile = (filePath: string, requestedQuality?: string) => {
    const audioContainer = detectAudioContainer(filePath)
    const ext = audioContainer === 'unknown' || audioContainer === 'encrypted'
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
    } catch (e) {
        const detectedQuality = detectQualityFromBitrate(undefined, ext)
        return {
            audioContainer,
            extension: ext,
            quality: needsQualityCorrection(requestedQuality, audioContainer) ? detectedQuality : (requestedQuality || detectedQuality),
            bitrate: undefined,
            sampleRate: undefined,
            bitDepth: undefined,
        }
    } finally {
        try { if (tagger) tagger.dispose() } catch (e) { }
    }
}

export const detectDownloadSource = (rawUrl: string, fallbackSource?: string) => {
    let value = String(rawUrl || '').toLowerCase()
    try { value = decodeURIComponent(value) } catch (e) { }

    const sourcePatterns: Array<[string, RegExp]> = [
        ['wy', /(?:^|[./])(?:music\.126\.net|music\.163\.com|163yun\.com)(?:[/:?]|$)/],
        ['tx', /(?:^|[./])(?:qqmusic\.qq\.com|music\.tc\.qq\.com|stream\.qqmusic\.qq\.com)(?:[/:?]|$)/],
    ]
    for (const [source, pattern] of sourcePatterns) {
        if (pattern.test(value)) return source
    }
    return fallbackSource || undefined
}

// Generate consistent filename based on pattern with collision handling
const getFileName = (songInfo: any, quality?: string, isOnlyDownload?: boolean, username?: string) => {
    const sanitizeFilename = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

    const id = normalizeSongId(songInfo)
    const source = songInfo.source || 'unknown'
    const q = quality || songInfo.quality || 'unknown'
    const nameStr = sanitizeFilename(songInfo.name || 'Unknown')
    const singerStr = sanitizeFilename(songInfo.singer || 'Unknown')
    const albumValue = songInfo.albumName || songInfo.meta?.albumName ||
        (typeof songInfo.album === 'string' ? songInfo.album : songInfo.album?.name) ||
        'Unknown Album'
    const albumStr = sanitizeFilename(albumValue)

    let baseName = ''
    if (currentNamingPattern === CACHE_NAMING_PATTERNS.SIMPLE) {
        baseName = `${nameStr} - ${singerStr} - ${sanitizeFilename(q)} - ${albumStr}`
    } else {
        // Default/Standard: {Name}_-_{Singer}_-_{Source}_-_{ID}_-_{Quality}
        baseName = `${nameStr}_-_${singerStr}_-_${sanitizeFilename(source)}_-_${sanitizeFilename(id)}_-_${sanitizeFilename(q)}`
    }

    // --- Collision Handling ---
    // Only apply suffix logic if we have a username and it's not the standard pattern (which is already unique)
    if (username && currentNamingPattern !== CACHE_NAMING_PATTERNS.STANDARD) {
        const folder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const existingItems = indexManager.getAll(normalizedUsername, folder)

        const normalizedName = nameStr.toLowerCase()
        const normalizedSinger = singerStr.toLowerCase()
        const normalizedQuality = sanitizeFilename(q).toLowerCase()
        const normalizedAlbum = albumStr.toLowerCase()

        // The album is part of the simple filename, so different album editions do not collide.
        const conflict = existingItems.find(item => {
            const itemAlbumValue = item.album || 'Unknown Album'
            return sanitizeFilename(item.name || 'Unknown').toLowerCase() === normalizedName &&
                sanitizeFilename(item.singer || 'Unknown').toLowerCase() === normalizedSinger &&
                sanitizeFilename(item.quality || 'unknown').toLowerCase() === normalizedQuality &&
                sanitizeFilename(itemAlbumValue).toLowerCase() === normalizedAlbum &&
                normalizeSongId(item) !== id
        })

        if (conflict) {
            // The normalized ID already includes the source prefix when needed.
            baseName += ` (${sanitizeFilename(id || source || 'duplicate')})`
        }
    }

    if (baseName.length > 200) baseName = baseName.substring(0, 200)
    return baseName
}

// Helper to sanitize for URL/Path
const sanitize = (str: any) => String(str || '').replace(/[\\/:*?"<>|]/g, '_')

// --- Public APIs ---

/**
 * Sync disk files with index database
 */
export const syncCacheIndex = async (username?: string, roots: Array<'cache' | 'music'> = ['cache', 'music']) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const extensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']

    for (const folder of roots) {
        const index = indexManager.load(normalizedUsername, folder)

        const existingKeysInIndex = new Set(index.keys())
        const foundKeysOnDisk = new Set<string>()

        // Pre-build a filename to Item map within this folder for fast lookup
        const filenameToItemMap = new Map<string, { key: string, item: CacheItem }>()
        for (const [key, item] of index.entries()) {
            filenameToItemMap.set(item.filename, { key, item })
        }
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue

        // [Unified Enhancement] Recursive file walker (asynchronous)
        const getAllFilesAsync = async (dirPath: string, base: string = dirPath): Promise<string[]> => {
            const acc: string[] = []
            try {
                const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false)
                if (!exists) return acc
                const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
                for (const entry of entries) {
                    if (entry.isSymbolicLink()) continue
                    const fullPath = path.join(dirPath, entry.name)
                    if (entry.isDirectory()) {
                        const subFiles = await getAllFilesAsync(fullPath, base)
                        acc.push(...subFiles)
                    } else {
                        acc.push(path.relative(base, fullPath).replace(/\\/g, '/'))
                    }
                }
            } catch (e) {
                console.error(`[fileCache] error walking path: ${dirPath}`, e)
            }
            return acc
        }

        const files = await getAllFilesAsync(dir)
        for (const file of files) {
            if (file === 'cache_index.json' || file === 'music_index.json') continue
            const ext = path.extname(file).toLowerCase()
            if (!extensions.includes(ext)) continue

            const filePath = resolveCacheRelativePath(dir, file)
            if (!filePath) continue
            const stats = await fs.promises.lstat(filePath)
            if (stats.isSymbolicLink() || !stats.isFile()) continue

            // Try to find if this file is already known in index by its filename
            let existingEntry = filenameToItemMap.get(file)
            let existing = existingEntry?.item
            let oldKey = existingEntry?.key
            const originalItemId = existing?.id
            const originalItemQuality = existing?.quality
            let itemChanged = false

            let songId = existing?.id || ''
            let songName = existing?.name || ''
            let singer = existing?.singer || ''
            let source = existing?.source || ''
            let quality = existing?.quality || ''
            let album = existing?.album || ''
            let hasCover = existing?.hasCover || false

            // subPath calculation: the directory part of the relative path
            const subPath = path.dirname(file) === '.' ? '' : path.dirname(file).replace(/\\/g, '/')
            const fileNameOnly = path.basename(file)

            const nameWithoutExt = path.basename(fileNameOnly, ext)

            if (!existing) {
                // Not found by filename, try to parse from standard format
                const segments = nameWithoutExt.split('_-_')
                if (segments.length >= 5) {
                    songName = segments[0]
                    singer = segments[1]
                    source = segments[2]
                    songId = segments[3]
                    quality = segments[4]
                } else {
                    // Try simple pattern: Name - Singer - Quality - Album
                    const segmentsShort = nameWithoutExt.split(' - ')
                    if (segmentsShort.length >= 2) {
                        songName = segmentsShort[0]
                        singer = segmentsShort[1]
                        quality = segmentsShort[2] || 'unknown'
                        album = segmentsShort.slice(3).join(' - ')
                        songId = nameWithoutExt // Fallback ID for unknown files
                    } else {
                        // Fallback for completely unknown filenames (e.g. download_4.mp3)
                        songId = nameWithoutExt
                        source = 'unknown'
                        quality = 'unknown'
                    }
                }
            }

            if (!songId) continue
            // Normalize ID
            const normalizedId = songId.includes('_') ? songId : `${source || 'unknown'}_${songId}`

            // Always check for a companion lyric file. Use the actual filename
            // so legacy `.LRC` files and nested download folders are repaired too.
            const companionLyric = findCompanionLyricFile(dir, file)
            const lrcFile = companionLyric?.filename
            const hasLyricOnDisk = !!companionLyric

            let finalQuality = quality || 'unknown'

            const needsCoverCheck = !existing ||
                existing.coverCheckedVersion !== COVER_CHECK_VERSION ||
                existing.coverCheckedMtime !== stats.mtimeMs ||
                existing.coverCheckedSize !== stats.size ||
                existing.hasCover === undefined ||
                (existing.coverType === 'cached' && !hasCachedCover(file, normalizedUsername, stats))
            const currentAudioContainer = existing?.audioContainer || detectAudioContainer(filePath)
            const qualityCorrectionNeeded = !!existing && needsQualityCorrection(existing.quality, currentAudioContainer)

            // Update or add to index if anything changed (size, mtime, lyric status, or cover status)
            if (!existing || existing.size !== stats.size || existing.hasLyric !== hasLyricOnDisk || existing.lyricFilename !== lrcFile || existing.subPath !== subPath || needsCoverCheck || !existing.interval || existing.quality === 'unknown' || !existing.bitrate || qualityCorrectionNeeded) {
                itemChanged = true
                if (existing) {
                    existing.size = stats.size
                    existing.mtime = stats.mtimeMs
                    existing.hasLyric = hasLyricOnDisk
                    existing.lyricFilename = lrcFile

                    if (existing.subPath !== subPath) {
                        existing.subPath = subPath
                    }

                    if (needsCoverCheck) {
                        const hasEmbeddedCover = readEmbeddedCoverState(filePath)
                        const hasExternalCover = !hasEmbeddedCover && hasCachedCover(file, normalizedUsername, stats)
                        const coverType: CacheItem['coverType'] = hasEmbeddedCover
                            ? 'embedded'
                            : hasExternalCover
                                ? 'cached'
                                : hasUsableRemoteCover(existing.img)
                                    ? 'remote'
                                    : 'none'
                        const actualHasCover = coverType !== 'none'
                        existing.hasCover = actualHasCover
                        existing.coverType = coverType
                        existing.coverCheckedVersion = COVER_CHECK_VERSION
                        existing.coverCheckedMtime = stats.mtimeMs
                        existing.coverCheckedSize = stats.size
                    }

                    // If interval or quality/bitrate is missing/unknown, or hasEmbedLyric not yet detected, try to extract it
                    if (!existing.interval || existing.quality === 'unknown' || !existing.bitrate || existing.hasEmbedLyric === undefined || existing.metadataWritable === undefined || qualityCorrectionNeeded) {
                        let tagger: any
                        try {
                            tagger = new (getMusicTagNative().MusicTagger)()
                            tagger.loadPath(filePath)
                            const dur = tagger.duration
                            if (dur && !existing.interval) existing.interval = formatPlayTime(dur / 1000)
                            existing.bitrate = tagger.bitRate
                            existing.sampleRate = tagger.sampleRate
                            existing.bitDepth = tagger.bitDepth
                            if (!existing.quality || existing.quality === 'unknown' || qualityCorrectionNeeded) {
                                const detectedQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)
                                existing.quality = resolveInspectedQuality(existing.quality, detectedQuality, currentAudioContainer, tagger)
                            }
                            // [新增] 检测是否已嵌入歌词 USLT 标签
                            if (existing.hasEmbedLyric === undefined) {
                                const lyricsInTag = tagger.lyrics
                                existing.hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                            }
                            existing.audioContainer = currentAudioContainer
                            existing.metadataWritable = true
                            existing.metadataError = undefined
                        } catch (e: any) {
                            existing.audioContainer = currentAudioContainer
                            existing.metadataWritable = false
                            existing.metadataError = getMetadataUnsupportedMessage(existing.audioContainer)
                            existing.hasEmbedLyric = false
                        } finally {
                            try { if (tagger) tagger.dispose() } catch (e) { }
                        }
                    }
                    finalQuality = existing.quality
                } else {
                    // (New file logic remains same but uses hasLyricOnDisk)
                    let interval = ''
                    let bitrate: number | undefined
                    let sampleRate: number | undefined
                    let bitDepth: number | undefined
                    let hasEmbedLyric = false
                    let metadataWritable = false
                    let metadataError: string | undefined
                    const audioContainer = detectAudioContainer(filePath)

                    try {
                        const tagger = new (getMusicTagNative().MusicTagger)()
                        tagger.loadPath(filePath)
                        if (tagger.title && !songName) songName = tagger.title
                        if (tagger.artist && !singer) singer = tagger.artist
                        if (tagger.album && !album) album = tagger.album
                        if (hasValidEmbeddedCover(tagger.pictures)) hasCover = true

                        const dur = tagger.duration
                        interval = dur ? formatPlayTime(dur / 1000) : ''

                        bitrate = tagger.bitRate
                        sampleRate = tagger.sampleRate
                        bitDepth = tagger.bitDepth
                        finalQuality = detectQualityFromBitrate(tagger.bitRate, ext, tagger)

                        // [新增] 检测是否已嵌入歌词 USLT 标签
                        const lyricsInTag = tagger.lyrics
                        hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                        metadataWritable = true

                        tagger.dispose()
                    } catch (e: any) {
                        metadataError = getMetadataUnsupportedMessage(audioContainer)
                    }
                    const hasExternalCover = !hasCover && hasCachedCover(file, normalizedUsername, stats)
                    if (hasExternalCover) hasCover = true
                    const coverType: CacheItem['coverType'] = hasCover && !hasExternalCover
                        ? 'embedded'
                        : hasExternalCover
                            ? 'cached'
                            : 'none'
                    hasCover = coverType !== 'none'

                    const item: CacheItem = {
                        id: normalizedId,
                        songmid: normalizedId,
                        name: songName || nameWithoutExt || 'Unknown',
                        singer: singer || 'Unknown',
                        album: album || '',
                        albumId: '',
                        img: '',
                        interval: interval,
                        source: source || 'unknown',
                        quality: finalQuality as any,
                        filename: file,
                        folder: folder as any,
                        subPath,
                        mtime: stats.mtimeMs,
                        size: stats.size,
                        lyricFilename: lrcFile,
                        ext: ext.replace('.', ''),
                        hasCover: hasCover,
                        coverType,
                        hasLyric: hasLyricOnDisk,
                        hasEmbedLyric,
                        audioContainer,
                        metadataWritable,
                        metadataError,
                        coverCheckedVersion: COVER_CHECK_VERSION,
                        coverCheckedMtime: stats.mtimeMs,
                        coverCheckedSize: stats.size,
                        bitrate: bitrate,
                        sampleRate: sampleRate,
                        bitDepth: bitDepth
                    }
                    existing = item
                }
            }

            const compositeKey = `${normalizedId}_${finalQuality || 'unknown'}`
            foundKeysOnDisk.add(compositeKey)

            if (oldKey && oldKey !== compositeKey) {
                index.delete(oldKey)
                index.set(compositeKey, existing!)
            } else if (!oldKey) {
                index.set(compositeKey, existing!)
            }

            // The SQLite-backed index does not persist the in-memory Map from
            // `load()`. Write each changed item explicitly so disk discovery
            // repairs lyric/cover flags in the actual database.
            if (itemChanged && existing) {
                if (oldKey && oldKey !== compositeKey && originalItemId && originalItemQuality) {
                    indexManager.remove(normalizedUsername, originalItemId, folder, originalItemQuality)
                }
                indexManager.update(normalizedUsername, existing, folder)
            }

            // Yield control back to Node.js event loop
            await new Promise(resolve => setImmediate(resolve))
        }

        // Remove deleted files from index
        for (const key of existingKeysInIndex) {
            if (!foundKeysOnDisk.has(key)) {
                const staleItem = index.get(key)
                if (staleItem) {
                    indexManager.remove(normalizedUsername, staleItem.id, folder, staleItem.quality)
                }
                index.delete(key)
            }
        }
    }

    const syncKey = `${currentCacheLocation}:${normalizedUsername}`
    const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
    syncState.lastSync = Date.now()
    cacheListSyncState.set(syncKey, syncState)
}

/**
 * Get detailed cache list for a user (indexed)
 */
export const getCacheList = async (username?: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    // Keep indexed metadata aligned with disk. This also repairs stale hasCover values
    // from older indexes where the cover endpoint may already return 404.
    const syncKey = `${currentCacheLocation}:${normalizedUsername}`
    const syncState = cacheListSyncState.get(syncKey) || { lastSync: 0 }
    // SQLite is the source of truth for metadata. Legacy JSON index files must
    // not suppress a disk reconciliation after a migration or manual edit.
    const shouldSync = Date.now() - syncState.lastSync > CACHE_LIST_SYNC_TTL

    if (shouldSync) {
        if (!syncState.pending) {
            syncState.pending = syncCacheIndex(normalizedUsername)
                .then(() => { syncState.lastSync = Date.now() })
                .finally(() => { syncState.pending = undefined })
            cacheListSyncState.set(syncKey, syncState)
        }
        await syncState.pending
    }

    const cacheItems = indexManager.getAll(normalizedUsername, 'cache')
    const musicItems = indexManager.getAll(normalizedUsername, 'music')
    const items = [...cacheItems, ...musicItems]

    return items.map(item => ({
        ...item,
        songInfo: {
            id: item.id,
            songmid: item.songmid || item.id,
            name: item.name,
            singer: item.singer,
            source: item.source,
            quality: item.quality,
            albumName: item.album,
            albumId: item.albumId,
            img: item.img,
            interval: item.interval,
            type: item.quality, // Compatibility
            types: {} // To be filled if needed
        },
        hasLyric: item.hasLyric || !!item.lyricFilename
    }))
}

/**
 * Batch rename existing files to the current naming pattern
 */
export const batchRenameCacheFiles = async (username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const folders: Array<'cache' | 'music'> = ['cache', 'music']

    let successCount = 0
    let failCount = 0
    let skipCount = 0

    for (const folder of folders) {
        const items = indexManager.getAll(normalizedUsername, folder)

        for (const item of items) {
            const songInfo = {
                id: item.id,
                songmid: item.songmid || item.id,
                name: item.name,
                singer: item.singer,
                source: item.source,
                quality: item.quality,
                albumName: item.album,
                albumId: item.albumId,
                img: item.img,
                interval: item.interval
            }

            const newBaseName = getFileName(songInfo, item.quality, folder === 'music', normalizedUsername)
            const newFilename = `${newBaseName}.${item.ext}`

            if (newFilename === item.filename) {
                skipCount++
                continue
            }

            const dir = getCacheDir(normalizedUsername, folder === 'music')
            const oldPath = resolveCacheRelativePath(dir, item.filename)
            const newPath = resolveCacheRelativePath(dir, newFilename)
            if (!oldPath || !newPath) {
                failCount++
                continue
            }

            try {
                if (fs.existsSync(oldPath)) {
                    if (!fs.existsSync(newPath)) {
                        const oldStats = fs.statSync(oldPath)
                        const externalCover = readCoverCache(item.filename, normalizedUsername, oldStats)
                        fs.renameSync(oldPath, newPath)

                        if (item.lyricFilename) {
                            const oldLrcPath = resolveCacheRelativePath(dir, item.lyricFilename)
                            const newLrcFilename = `${newBaseName}.lrc`
                            const newLrcPath = resolveCacheRelativePath(dir, newLrcFilename)
                            if (oldLrcPath && newLrcPath && fs.existsSync(oldLrcPath)) {
                                fs.renameSync(oldLrcPath, newLrcPath)
                                item.lyricFilename = newLrcFilename
                            }
                        }

                        item.filename = newFilename
                        if (externalCover) {
                            writeCoverCache(newFilename, normalizedUsername, externalCover.data, externalCover.mime, fs.statSync(newPath))
                            item.coverType = 'cached'
                            item.hasCover = true
                        }
                        indexManager.update(normalizedUsername, item, folder)
                        successCount++
                    } else {
                        failCount++
                    }
                } else {
                    failCount++
                }
            } catch (e) {
                console.error(`[FileCache] Failed to rename ${item.filename} in ${folder}:`, e)
                failCount++
            }
        }

    }

    return { success: true, successCount, failCount, skipCount }
}

/**
 * Batch update ID3 metadata (title, artist, album, cover) from index to physical files
 */
export const batchUpdateMetadata = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    let successCount = 0
    let failCount = 0

    const allItems = [
        ...indexManager.getAll(normalizedUsername, 'cache'),
        ...indexManager.getAll(normalizedUsername, 'music')
    ]

    for (const filename of filenames) {
        const item = allItems.find(i => i.filename === filename)
        if (!item) {
            failCount++
            continue
        }

        const dir = getCacheDir(normalizedUsername, item.folder === 'music')
        const filePath = resolveCacheRelativePath(dir, item.filename)

        if (!filePath || !fs.existsSync(filePath)) {
            failCount++
            continue
        }

        try {
            let imageBuffer: Buffer | undefined
            let imageMime = 'image/jpeg'
            const imageUrl = item.img
            if (typeof imageUrl === 'string' && hasUsableRemoteCover(imageUrl)) {
                const remoteCover = await downloadCoverImage(imageUrl)
                if (remoteCover) {
                    imageBuffer = remoteCover.data
                    imageMime = remoteCover.mime
                }
            }

            let tagger: any
            let taggerError: any
            try {
                tagger = new (getMusicTagNative().MusicTagger)()
                tagger.loadPath(filePath)
                tagger.title = item.name || 'Unknown'
                tagger.artist = item.singer || 'Unknown'
                if (item.album) tagger.album = item.album
                if (imageBuffer && imageBuffer.length > 0) {
                    tagger.pictures = [new (getMusicTagNative().MetaPicture)(imageMime, new Uint8Array(imageBuffer), 'Cover')]
                }
                tagger.save()
            } catch (e) {
                taggerError = e
            } finally {
                try { if (tagger) tagger.dispose() } catch (e) { }
            }

            const stats = fs.statSync(filePath)
            const hasEmbeddedCover = readEmbeddedCoverState(filePath)
            let hasCover = hasEmbeddedCover || hasCachedCover(item.filename, normalizedUsername, stats)
            if (!hasCover && imageBuffer?.length) {
                hasCover = writeCoverCache(item.filename, normalizedUsername, imageBuffer, imageMime, stats)
                if (taggerError) {
                    console.warn(`[FileCache] Audio tags are unavailable for ${filename}; using external cover cache`)
                }
            }
            if (taggerError && !hasCover) throw taggerError
            item.hasCover = hasCover
            item.coverType = hasEmbeddedCover ? 'embedded' : hasCover ? 'cached' : hasUsableRemoteCover(item.img) ? 'remote' : 'none'
            item.metadataWritable = !taggerError
            item.audioContainer = detectAudioContainer(filePath)
            item.metadataError = taggerError ? getMetadataUnsupportedMessage(item.audioContainer) : undefined
            item.coverCheckedVersion = COVER_CHECK_VERSION
            item.coverCheckedMtime = stats.mtimeMs
            item.coverCheckedSize = stats.size
            item.mtime = stats.mtimeMs
            item.size = stats.size

            indexManager.update(normalizedUsername, item, item.folder as 'cache' | 'music')
            successCount++
        } catch (e) {
            console.error(`[FileCache] Failed to update metadata for ${filename}:`, e)
            failCount++
        }
    }

    return { successCount, failCount }
}

/**
 * Link an unindexed local file to a specific online song identity
 */
export const linkLocalFile = async (oldFilename: string, songInfo: any, username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    // Find the item in all possible folders
    const allItems = [
        ...indexManager.getAll(normalizedUsername, 'cache'),
        ...indexManager.getAll(normalizedUsername, 'music')
    ]
    const item = allItems.find(i => i.filename === oldFilename)
    if (!item) throw new Error('File not found in index')

    const folder = item.folder as 'cache' | 'music'
    const dir = getCacheDir(normalizedUsername, folder === 'music')
    const oldPath = resolveCacheRelativePath(dir, item.filename)
    if (!oldPath || !fs.existsSync(oldPath)) throw new Error('Physical file not found')

    // Prepare new metadata from songInfo
    const metadata = extractSongMetadata(songInfo)
    const newId = metadata.id
    const quality = item.quality || 'unknown'
    const ext = item.ext ? `.${item.ext}` : path.extname(oldFilename)

    // Generate new filename based on pattern (preserving subPath)
    const newBaseName = getFileName(songInfo, quality, folder === 'music', normalizedUsername)
    const subPath = item.subPath || ''
    const newFilename = subPath ? path.join(subPath, newBaseName + ext).replace(/\\/g, '/') : newBaseName + ext
    const newPath = resolveCacheRelativePath(dir, newFilename)
    if (!newPath) throw new Error('Invalid target filename')

    // Check collision
    if (newFilename !== oldFilename && fs.existsSync(newPath)) {
        throw new Error('Target filename already exists on disk')
    }

    // 1. Rename physical file
    if (newFilename !== oldFilename) {
        fs.renameSync(oldPath, newPath)
        // Also rename lyrics if exists
        if (item.lyricFilename) {
            const oldLrcPath = resolveCacheRelativePath(dir, item.lyricFilename)
            const newLrcFilename = subPath ? path.join(subPath, newBaseName + '.lrc').replace(/\\/g, '/') : newBaseName + '.lrc'
            const newLrcPath = resolveCacheRelativePath(dir, newLrcFilename)
            if (oldLrcPath && newLrcPath && fs.existsSync(oldLrcPath)) {
                fs.renameSync(oldLrcPath, newLrcPath)
                item.lyricFilename = newLrcFilename
            }
        }
    }

    // 2. Update Index
    // Remove old entry (keyed by old ID and quality)
    indexManager.remove(normalizedUsername, item.id, folder, item.quality)

    // Update item properties
    item.id = newId
    item.songmid = newId
    item.name = metadata.name
    item.singer = metadata.singer
    item.album = metadata.album
    item.albumId = metadata.albumId
    item.img = metadata.img
    item.source = metadata.source
    item.filename = newFilename
    item.mtime = Date.now()

    // Add back to index with new identity
    indexManager.update(normalizedUsername, item, folder)

    // 3. Post-link processing: Update ID3 tags and cover
    await batchUpdateMetadata([newFilename], normalizedUsername)

    return {
        success: true,
        filename: newFilename,
        id: newId,
        metadata
    }
}


export const downloadCoverImage = async (imageUrl: string, redirects = 0): Promise<{ data: Buffer; mime: string } | null> => {
    if (!hasUsableRemoteCover(imageUrl) || redirects > 3) return null
    let safeUrl: SafeRemoteHttpUrl
    try {
        safeUrl = await assertSafeRemoteHttpUrl(imageUrl)
    } catch {
        return null
    }
    return await new Promise((resolve) => {
        const client = safeUrl.protocol === 'https:' ? https : http
        const req = client.get(safeUrl, { lookup: safeUrl.lookup, agent: false }, response => {
            const statusCode = response.statusCode || 500
            if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
                response.resume()
                const redirectedUrl = new URL(response.headers.location, safeUrl).toString()
                void downloadCoverImage(redirectedUrl, redirects + 1).then(resolve)
                return
            }
            if (statusCode >= 400) {
                response.resume()
                resolve(null)
                return
            }
            const maxBytes = 10 * 1024 * 1024
            if (Number(response.headers['content-length'] || 0) > maxBytes) {
                response.resume()
                resolve(null)
                return
            }
            const chunks: Buffer[] = []
            let received = 0
            response.on('data', chunk => {
                const buffer = Buffer.from(chunk)
                received += buffer.length
                if (received <= maxBytes) chunks.push(buffer)
                else response.destroy()
            })
            response.on('end', () => {
                if (received > maxBytes) {
                    resolve(null)
                    return
                }
                const data = Buffer.concat(chunks)
                const mime = detectImageMime(data)
                resolve(mime ? { data, mime } : null)
            })
            response.on('error', () => resolve(null))
        })
        req.on('error', () => resolve(null))
        req.setTimeout(10000, () => {
            req.destroy()
            resolve(null)
        })
    })
}

const setIndexCoverState = (filename: string, username: string, coverType: CacheItem['coverType'], stats?: Stats, location?: string, requestedFolder?: CacheFolder) => {
    const folders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['cache', 'music']
    for (const folder of folders) {
        const item = indexManager.getAll(username, folder, location).find(candidate => candidate.filename === filename)
        if (!item) continue
        item.coverType = coverType
        item.hasCover = coverType !== 'none'
        item.coverCheckedVersion = COVER_CHECK_VERSION
        if (stats) {
            item.coverCheckedMtime = stats.mtimeMs
            item.coverCheckedSize = stats.size
        }
        indexManager.update(username, item, folder, location)
        return item
    }
    return null
}

/**
 * Get cover image for a cached file
 */
export const getCacheCover = async (filename: string, username?: string, requestedFolder?: CacheFolder) => {
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') return null
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    const locations = [
        currentCacheLocation,
        currentCacheLocation === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA
    ]
    const roots: Array<CacheFolder> = requestedFolder ? [requestedFolder] : ['cache', 'music']

    for (const loc of locations) {
        for (const folder of roots) {
            const dir = getCacheDir(normalizedUsername, folder === 'music', loc)
            const filePath = resolveCacheRelativePath(dir, filename) // [Fix] Allow subfolders safely

            if (filePath && fs.existsSync(filePath)) {
                let stats: Stats | undefined
                try {
                    stats = fs.statSync(filePath)
                    const cachedCover = readCoverCache(filename, normalizedUsername, stats)
                    if (cachedCover) {
                        setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc, folder)
                        return cachedCover
                    }
                } catch (e) {
                    console.error(`[Cache] Error reading cover cache for: ${filename}`, e)
                }

                let tagger: any
                try {
                    tagger = new (getMusicTagNative().MusicTagger)()
                    tagger.loadPath(filePath)
                    const pics = tagger.pictures
                    const pic = Array.isArray(pics) ? pics.find(hasValidPictureData) : null
                    if (pic) {
                        const mime = pic.mimeType || 'image/jpeg'
                        const data = Buffer.from(pic.data)
                        writeCoverCache(filename, normalizedUsername, data, mime, stats)
                        setIndexCoverState(filename, normalizedUsername, 'embedded', stats, loc, folder)
                        return { data, mime: detectImageMime(data) || mime }
                    }
                } catch (e) {
                    // console.error(`[Cache] Error reading tags for cover: ${filename}`, e)
                } finally {
                    try { if (tagger) tagger.dispose() } catch (e) { }
                }

                const item = roots
                    .flatMap(folderName => indexManager.getAll(normalizedUsername, folderName, loc))
                    .find(candidate => candidate.filename === filename)
                if (item && hasUsableRemoteCover(item.img)) {
                    const remoteCover = await downloadCoverImage(item.img!)
                    if (remoteCover && writeCoverCache(filename, normalizedUsername, remoteCover.data, remoteCover.mime, stats)) {
                        setIndexCoverState(filename, normalizedUsername, 'cached', stats, loc, folder)
                        return remoteCover
                    }
                }

                setIndexCoverState(filename, normalizedUsername, 'none', stats, loc, folder)
            }
        }
    }
    return null
}

/**
 * Remove a specific cache file
 */
export const removeCacheFile = (filename: string, username?: string, requestedFolder?: CacheFolder): RemoveCacheFileResult => {
    if (!filename || typeof filename !== 'string') throw new Error('Invalid filename')
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') throw new Error('Invalid folder')

    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const candidateFolders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['cache', 'music']
    const matches = getCacheLocations().flatMap(location => candidateFolders.map(folder => {
        const dir = getCacheDir(normalizedUsername, folder === 'music', location)
        const filePath = resolveCacheRelativePath(dir, filename)
        return filePath && fs.existsSync(filePath) ? { folder, dir, filePath, location } : null
    })).filter((entry): entry is { folder: CacheFolder; dir: string; filePath: string; location: string } => entry !== null)

    // Older clients only sent a filename. Keep that format safe when the file has
    // a unique location, but never guess if cache and download both contain it.
    if (!requestedFolder && matches.length > 1) {
        throw new Error(`Ambiguous file location for ${filename}; folder is required`)
    }
    if (matches.length === 0) return { deleted: false }

    const { folder, dir, filePath, location } = matches[0]
    let coverCacheHash = ''
    try {
        coverCacheHash = getCoverCacheHash(filename, fs.statSync(filePath))
    } catch (e) { }

    try {
        fs.unlinkSync(filePath)
    } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e
    }
    console.log(`[FileCache] Deleted from ${folder}: ${filename}`)

    const ext = path.extname(filename)
    if (ext !== '.lrc') {
        const baseWithoutExt = filename.substring(0, filename.length - ext.length)
        const lrcPath = resolveCacheRelativePath(dir, baseWithoutExt + '.lrc')
        if (lrcPath && fs.existsSync(lrcPath)) {
            try {
                fs.unlinkSync(lrcPath)
            } catch (e: any) {
                if (e?.code !== 'ENOENT') throw e
            }
        }
    }

    const items = indexManager.getAll(normalizedUsername, folder, location)
    const item = items.find(i => i.filename === filename)
    if (item) indexManager.remove(normalizedUsername, item.id, folder, item.quality, location)

    // Cover cache is shared by filename. Preserve it while the same relative file
    // still exists in the other root so deleting cache does not affect downloads.
    const otherFolder: CacheFolder = folder === 'cache' ? 'music' : 'cache'
    const hasCounterpart = getCacheLocations().some(otherLocation => {
        const otherDir = getCacheDir(normalizedUsername, otherFolder === 'music', otherLocation)
        const otherPath = resolveCacheRelativePath(otherDir, filename)
        return !!otherPath && fs.existsSync(otherPath)
    })
    if (!hasCounterpart) {
        try {
            const coverCacheDir = getCoverCacheDir(normalizedUsername)
            const hashes = [coverCacheHash, crypto.createHash('md5').update(filename).digest('hex')].filter(Boolean)
            for (const hash of hashes) {
                const binPath = path.join(coverCacheDir, `${hash}.bin`)
                const mimePath = path.join(coverCacheDir, `${hash}.mime`)
                if (fs.existsSync(binPath)) fs.unlinkSync(binPath)
                if (fs.existsSync(mimePath)) fs.unlinkSync(mimePath)
            }
        } catch (e) { }
    }

    return { deleted: true, folder }
}

/**
 * 记录缓存文件最近一次开始播放的时间。
 *
 * 播放器只会在 audio.play() 成功后调用此方法，因此预读、搜索命中或
 * 单纯打开缓存管理页面都不会把歌曲误判为“最近播放”。
 */
export const markCachePlayback = (filename: string, username?: string, requestedFolder?: CacheFolder, requestedLocation?: string): boolean => {
    if (!filename || typeof filename !== 'string') return false
    if (requestedFolder && requestedFolder !== 'cache' && requestedFolder !== 'music') return false
    if (requestedLocation && requestedLocation !== CACHE_ROOTS.DATA && requestedLocation !== CACHE_ROOTS.ROOT) return false

    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const candidateFolders: CacheFolder[] = requestedFolder ? [requestedFolder] : ['cache', 'music']
    const candidateLocations = requestedLocation ? [requestedLocation] : getCacheLocations()
    const matches = candidateLocations.flatMap(location => candidateFolders.map(folder => {
        const dir = getCacheDir(normalizedUsername, folder === 'music', location)
        const filePath = resolveCacheRelativePath(dir, filename)
        return filePath && fs.existsSync(filePath) ? { folder, filePath, location } : null
    })).filter((entry): entry is { folder: CacheFolder; filePath: string; location: string } => entry !== null)

    // 播放器始终会传 folder；未传时不在 cache/music 同名文件之间猜测。
    if (!requestedFolder && matches.length !== 1) return false
    if (matches.length === 0) return false

    const { folder, location } = matches[0]
    const item = indexManager.getAll(normalizedUsername, folder, location).find(candidate => candidate.filename === filename)
    if (!item) return false

    item.lastPlayedAt = Date.now()
    indexManager.update(normalizedUsername, item, folder, location)
    return true
}

export const setCacheLocation = (location: string) => {
    if (location === CACHE_ROOTS.DATA || location === CACHE_ROOTS.ROOT) {
        currentCacheLocation = location
        console.log(`[FileCache] Base cache location set to: ${location}`)
    }
}

export const getCacheLocation = () => currentCacheLocation

export const checkCache = (songInfo: any, username?: string, isLyricCheck: boolean = false) => {
    try {
        const id = normalizeSongId(songInfo)
        const quality = songInfo.quality || 'unknown'
        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

        // 1. Search by exact ID and Quality (Primary Check)
        // exactQuality=true 时：精确匹配，不允许 fallback 到不同音质
        const useExact = !!songInfo.exactQuality
        const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']
        for (const location of getCacheLocations()) {
            for (const folder of folderTypes) {
                const cached = indexManager.get(normalizedUsername, id, folder, quality, useExact, location)
                if (cached) {
                    // 二次校验：exactQuality 模式下确保音质匹配
                    if (useExact && quality && cached.quality !== quality) continue
                    const dir = getCacheDir(normalizedUsername, folder === 'music', location)
                    const fileName = isLyricCheck ? cached.lyricFilename : cached.filename
                    if (!fileName) continue
                    const filePath = resolveCacheRelativePath(dir, fileName)
                    if (isUsableCacheFile(filePath)) {
                        return {
                            exists: true,
                            path: filePath,
                            filename: fileName,
                            foundIn: normalizedUsername,
                            quality: cached.quality,
                            folder: folder,
                            location,
                            url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                        }
                    } else {
                        // Stale index entry, cleanup only in the location that was checked.
                        if (!isLyricCheck) indexManager.remove(normalizedUsername, id, folder, cached.quality, location)
                    }
                }
            }
        }

        // 2. Search for Naming Collisions (Same Name + Singer + Quality, but different ID)
        for (const location of getCacheLocations()) {
            const allItems = [
                ...indexManager.getAll(normalizedUsername, 'cache', location),
                ...indexManager.getAll(normalizedUsername, 'music', location)
            ]

            const collision = allItems.find(item =>
                item.id !== id && // 排除当前正在查询的 ID 本身
                item.name.toLowerCase() === String(songInfo.name || '').toLowerCase() &&
                item.singer.toLowerCase() === String(songInfo.singer || '').toLowerCase() &&
                item.quality === quality &&
                (!isLyricCheck || item.hasLyric)
            )

            if (collision) {
                const collisionDir = getCacheDir(normalizedUsername, collision.folder === 'music', location)
                const collisionFileName = (isLyricCheck ? collision.lyricFilename : collision.filename) || ''
                const collisionFilePath = collisionFileName ? resolveCacheRelativePath(collisionDir, collisionFileName) : null
                if (collisionFileName && isUsableCacheFile(collisionFilePath)) {
                    return {
                        exists: true,
                        isCollision: true,
                        collisionSource: collision.source,
                        collisionSongmid: collision.songmid,
                        filename: collisionFileName,
                        path: collisionFilePath,
                        url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(collisionFileName)}?folder=${collision.folder}`,
                        quality: collision.quality,
                        foundIn: normalizedUsername,
                        folder: collision.folder,
                        location,
                    }
                }
            }
        }

        // 3. Fallback for non-exact (only if requested)
        if (!songInfo.exactQuality && !isLyricCheck) {
            for (const location of getCacheLocations()) {
                for (const folder of folderTypes) {
                    const cachedAny = indexManager.get(normalizedUsername, id, folder, undefined, false, location)
                    if (cachedAny) {
                        const dir = getCacheDir(normalizedUsername, folder === 'music', location)
                        const fileName = cachedAny.filename
                        const filePath = resolveCacheRelativePath(dir, fileName)
                        if (isUsableCacheFile(filePath)) {
                            return {
                                exists: true,
                                path: filePath,
                                filename: fileName,
                                foundIn: normalizedUsername,
                                quality: cachedAny.quality,
                                folder: folder,
                                location,
                                url: `/api/music/cache/file/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(fileName)}?folder=${folder}`
                            }
                        }
                    }
                }
            }
        }

    } catch (e) {
        console.error('[FileCache] checkCache error:', e)
    }

    return { exists: false }
}

type LyricCacheResult =
    | { exists: true; path: string; content: any; filename: string }
    | { exists: false }

export const checkLyricCache = (songInfo: any, username?: string): LyricCacheResult => {
    const id = normalizeSongId(songInfo)
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'

    const readLyricForIndexedItem = (folder: 'cache' | 'music', item: CacheItem): Exclude<LyricCacheResult, { exists: false }> | null => {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        const audioPath = resolveCacheRelativePath(dir, item.filename)
        if (!audioPath || !fs.existsSync(audioPath)) return null

        const companion = findCompanionLyricFile(dir, item.filename)
        const indexedLyricPath = item.lyricFilename
            ? resolveCacheRelativePath(dir, item.lyricFilename)
            : null
        const lyricFile = indexedLyricPath && fs.existsSync(indexedLyricPath)
            ? { filename: item.lyricFilename!, path: indexedLyricPath }
            : companion
        if (!lyricFile || !fs.existsSync(lyricFile.path)) return null

        try {
            const content = parseLyrics(fs.readFileSync(lyricFile.path, 'utf-8'))
            if (item.hasLyric !== true || item.lyricFilename !== lyricFile.filename) {
                item.hasLyric = true
                item.lyricFilename = lyricFile.filename
                indexManager.update(normalizedUsername, item, folder)
                invalidateCacheListSync(normalizedUsername)
            }
            return {
                exists: true,
                path: lyricFile.path,
                content,
                filename: lyricFile.filename,
            }
        } catch {
            return null
        }
    }

    // Check every indexed quality first. A download can finish with a quality
    // different from the requested one, and an old index may still say that
    // the lyric is missing even though the companion file is already present.
    const folderTypes: Array<'cache' | 'music'> = ['cache', 'music']
    for (const folder of folderTypes) {
        const candidates = indexManager.getAll(normalizedUsername, folder)
            .filter(item => item.id === id || normalizeSongId(item) === id)
            .sort((a, b) => {
                const requestedQuality = String(songInfo.quality || '')
                if (!requestedQuality) return 0
                return (a.quality === requestedQuality ? -1 : 0) - (b.quality === requestedQuality ? -1 : 0)
            })
        for (const item of candidates) {
            const lyric = readLyricForIndexedItem(folder, item)
            if (lyric) return lyric
        }
    }

    // [Fix] Index-based name+singer fallback for the simple naming pattern
    // When the lrc filename does not contain a song ID, match by name + singer from the index
    if (songInfo.name && songInfo.singer) {
        const targetName = String(songInfo.name).toLowerCase()
        const targetSinger = String(songInfo.singer).toLowerCase()
        for (const folder of folderTypes) {
            const allItems = indexManager.getAll(normalizedUsername, folder)
            const matchedItems = allItems.filter(item =>
                item.name.toLowerCase() === targetName &&
                item.singer.toLowerCase() === targetSinger
            )
            for (const matched of matchedItems) {
                const lyric = readLyricForIndexedItem(folder, matched)
                if (lyric) return lyric
            }
        }
    }

    // Physical scan fallback (for standard naming pattern: Name_-_Singer_-_Source_-_ID_-_Quality)
    const roots = ['cache', 'music']
    const basePaths = roots.map(folder => getCacheDir(normalizedUsername, folder === 'music'))

    // [Fix] Recursively search for lyrics if not in index
    const getAllLrcFiles = (dirPath: string, acc: string[] = []) => {
        if (!fs.existsSync(dirPath)) return acc
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue
            const fullPath = path.join(dirPath, entry.name)
            if (entry.isDirectory()) {
                getAllLrcFiles(fullPath, acc)
            } else if (entry.name.endsWith('.lrc')) {
                acc.push(fullPath)
            }
        }
        return acc
    }

    const cleanId = (sid: string) => String(sid || '').replace(/^(tx|wy)_/, '')
    const targetCleanId = cleanId(id)

    for (const dirPath of basePaths) {
        const lrcFiles = getAllLrcFiles(dirPath)
        for (const filePath of lrcFiles) {
            const file = path.basename(filePath)
            const fileNameWithoutExt = file.substring(0, file.lastIndexOf('.'))
            const segments = fileNameWithoutExt.split('_-_')
            if (segments.length >= 2) {
                const fileId = segments[segments.length - 2]
                const fileCleanId = cleanId(fileId)
                if (fileId === id || fileCleanId === id || fileId === targetCleanId || fileCleanId === targetCleanId) {
                    return {
                        exists: true,
                        path: filePath,
                        content: parseLyrics(fs.readFileSync(filePath, 'utf-8')),
                        filename: path.relative(dirPath, filePath).replace(/\\/g, '/')
                    }
                }
            }
        }
    }

    return { exists: false }
}

export const saveLyricCache = (songInfo: any, lyricsObj: any, username?: string, isOnlyDownload?: boolean) => {
    try {
        let baseName = ''
        let quality = songInfo.quality || 'unknown'
        let dir = ''

        const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
        const id = normalizeSongId(songInfo)
        const preferredFolders: Array<'cache' | 'music'> = isOnlyDownload ? ['music', 'cache'] : ['cache', 'music']
        let audioResult: any = { exists: false }
        for (const folder of preferredFolders) {
            const cached = indexManager.get(normalizedUsername, id, folder, songInfo.quality, false)
            if (!cached?.filename) continue
            const root = getCacheDir(normalizedUsername, folder === 'music')
            const filePath = resolveCacheRelativePath(root, cached.filename)
            if (filePath && fs.existsSync(filePath)) {
                audioResult = {
                    exists: true,
                    path: filePath,
                    quality: cached.quality,
                    folder,
                    filename: cached.filename
                }
                break
            }
        }

        if (audioResult.exists && audioResult.path) {
            // If audio exists, save lyric in the same folder
            dir = path.dirname(audioResult.path)
            quality = audioResult.quality || quality
            baseName = path.basename(audioResult.path, path.extname(audioResult.path))
        } else {
            // Audio not found with requested quality, try finding any cached audio for this song
            for (const folder of preferredFolders) {
                const cachedAny = indexManager.get(normalizedUsername, id, folder)
                if (!cachedAny?.filename) continue
                const root = getCacheDir(normalizedUsername, folder === 'music')
                const filePath = resolveCacheRelativePath(root, cachedAny.filename)
                if (filePath && fs.existsSync(filePath)) {
                    audioResult = {
                        exists: true,
                        path: filePath,
                        quality: cachedAny.quality,
                        folder,
                        filename: cachedAny.filename
                    }
                    dir = path.dirname(filePath)
                    quality = cachedAny.quality || quality
                    baseName = path.basename(filePath, path.extname(filePath))
                    break
                }
            }

            if (!audioResult.exists) {
                // Audio not found, fallback to target dir
                dir = ensureDir(username, isOnlyDownload)
                if (songInfo.quality && songInfo.quality !== 'unknown') {
                    baseName = getFileName(songInfo, songInfo.quality, isOnlyDownload, username)
                } else {
                    baseName = getFileName(songInfo, 'unknown', isOnlyDownload, username)
                }
            }
        }

        const lyricFile = baseName + '.lrc'
        const finalPath = resolveCacheRelativePath(dir, lyricFile)
        if (!finalPath) throw new Error('Invalid lyric cache path')

        const formattedLrc = buildLyrics(lyricsObj)
        if (!formattedLrc) {
            console.log(`[FileCache] Empty lyrics for ${baseName}, skip saving.`)
            return false
        }

        fs.writeFileSync(finalPath, formattedLrc, { encoding: 'utf-8' })
        console.log(`[FileCache] Lyric cached saved to: ${finalPath}`)

        // If saving with a concrete quality, clean up any leftover 'unknown' lyric file for the same song
        if (quality && quality !== 'unknown') {
            try {
                const unknownBaseName = getFileName(songInfo, 'unknown', isOnlyDownload, username)
                const unknownLyricPath = resolveCacheRelativePath(dir, unknownBaseName + '.lrc')
                if (unknownLyricPath && unknownLyricPath !== finalPath && fs.existsSync(unknownLyricPath)) {
                    fs.unlinkSync(unknownLyricPath)
                    console.log(`[FileCache] Cleaned up obsolete unknown lyric: ${unknownLyricPath}`)
                }
            } catch (_) { }
        }

        // Update the exact indexed audio item when the audio file is already
        // present. Lyrics can also be cached before the audio download starts,
        // in which case audioResult.path is intentionally absent and there is
        // no index row to update. Do not pass that undefined path to
        // path.relative(): Node reports it as “The \"to\" property must be of
        // type string”, even though the lyric file was written successfully.
        if (audioResult.exists && typeof audioResult.path === 'string' && audioResult.folder) {
            try {
                // Prefer the item that owns the resolved audio path because an
                // older task may have used a different source-prefixed ID or
                // an automatically downgraded quality.
                const foldersToUpdate: Array<'cache' | 'music'> = [audioResult.folder, ...(isOnlyDownload ? ['music', 'cache'] : ['cache', 'music'])]
                    .filter((folder, index, folders): folder is 'cache' | 'music' => folders.indexOf(folder) === index)
                for (const folder of foldersToUpdate) {
                    const root = getCacheDir(normalizedUsername, folder === 'music')
                    const relativeAudioPath = path.relative(root, audioResult.path).replace(/\\/g, '/')
                    const existing = indexManager.getAll(normalizedUsername, folder).find(candidate => (
                        candidate.filename === relativeAudioPath ||
                        (candidate.id === id && candidate.quality === quality)
                    ))
                    if (existing) {
                        existing.lyricFilename = path.relative(root, finalPath).replace(/\\/g, '/')
                        existing.hasLyric = true
                        indexManager.update(normalizedUsername, existing, folder)
                        invalidateCacheListSync(normalizedUsername)
                        break
                    }
                }
            } catch (err: any) {
                // The lyric file is already durable. An index repair failure
                // must not turn a successful lyric save into a false failure.
                console.warn(`[FileCache] Lyric cache index update failed: ${err?.message || err}`)
            }
        }
        void checkAndCleanupCache(username)
        return true
    } catch (err: any) {
        console.error(`[FileCache] Lyric cache save failed: ${err.message}`)
        return false
    }
}

const ensureCachedLyrics = async (
    songInfo: any,
    quality: string | undefined,
    username: string | undefined,
    isOnlyDownload: boolean | undefined,
    audioPath: string,
    folder: 'cache' | 'music',
    shouldCacheLyric: boolean,
    shouldEmbedLyric: boolean,
) => {
    if ((!shouldCacheLyric && !shouldEmbedLyric) || !_lyricFetcher || !fs.existsSync(audioPath)) return

    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const id = normalizeSongId(songInfo)
    const resolvedQuality = quality || 'unknown'
    const relativeAudioPath = path.relative(getCacheDir(normalizedUsername, folder === 'music'), audioPath).replace(/\\/g, '/')
    const item = indexManager.get(normalizedUsername, id, folder, resolvedQuality, true)
        || indexManager.getAll(normalizedUsername, folder).find(candidate => candidate.filename === relativeAudioPath)
    const lyricPath = audioPath.substring(0, audioPath.length - path.extname(audioPath).length) + '.lrc'
    let hasCachedLyric = fs.existsSync(lyricPath)
    let hasEmbedLyric = item?.hasEmbedLyric === true
    let metadataWritable = item?.metadataWritable !== false
    let metadataError = item?.metadataError
    let embedLyricError = item?.embedLyricError
    const audioContainer = item?.audioContainer || detectAudioContainer(audioPath)

    if (shouldEmbedLyric && !hasEmbedLyric && metadataWritable) {
        let tagger: any
        try {
            tagger = new (getMusicTagNative().MusicTagger)()
            tagger.loadPath(audioPath)
            const lyricsInTag = tagger.lyrics
            hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
        } catch (e: any) {
            metadataWritable = false
            metadataError = getMetadataUnsupportedMessage(audioContainer)
            embedLyricError = metadataError
        } finally {
            try { if (tagger) tagger.dispose() } catch (e) { }
        }
    }

    const embedRequirementHandled = !shouldEmbedLyric || hasEmbedLyric || !metadataWritable
    if ((!shouldCacheLyric || hasCachedLyric) && embedRequirementHandled) {
        if (item && (item.hasLyric !== hasCachedLyric || item.hasEmbedLyric !== hasEmbedLyric || item.metadataWritable !== metadataWritable || item.embedLyricError !== embedLyricError)) {
            item.hasLyric = hasCachedLyric
            item.lyricFilename = hasCachedLyric
                ? path.relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath).replace(/\\/g, '/')
                : undefined
            item.hasEmbedLyric = hasEmbedLyric
            item.audioContainer = audioContainer
            item.metadataWritable = metadataWritable
            item.metadataError = metadataError
            item.embedLyricError = embedLyricError
            indexManager.update(normalizedUsername, item, folder)
        }
        return
    }

    try {
        const lyricText = await _lyricFetcher({ ...songInfo, quality: resolvedQuality })
        if (!lyricText) return

        if (shouldCacheLyric && !hasCachedLyric) {
            const lyricsObj = parseLyrics(lyricText)
            hasCachedLyric = saveLyricCache(
                { ...songInfo, quality: resolvedQuality },
                lyricsObj,
                username,
                isOnlyDownload,
            ) || fs.existsSync(lyricPath)
        }

        if (shouldEmbedLyric && !hasEmbedLyric && metadataWritable) {
            const embedResult = embedLyricsIntoFile(audioPath, lyricText)
            hasEmbedLyric = embedResult.hasEmbedLyric
            metadataWritable = embedResult.metadataWritable
            metadataError = embedResult.metadataWritable ? undefined : embedResult.error
            embedLyricError = embedResult.error
            if (embedResult.success) {
                console.log(`[FileCache] USLT lyric embedded for: ${songInfo.name || songInfo.title || path.basename(audioPath)}`)
            } else {
                console.warn(`[FileCache] Lyric tag unavailable for ${path.basename(audioPath)}: ${embedResult.error}`)
            }
        }

        const finalItem = indexManager.get(normalizedUsername, id, folder, resolvedQuality, true) || item
        if (finalItem) {
            if (shouldCacheLyric && hasCachedLyric) {
                finalItem.hasLyric = true
                finalItem.lyricFilename = path.relative(getCacheDir(normalizedUsername, folder === 'music'), lyricPath).replace(/\\/g, '/')
            }
            if (shouldEmbedLyric) {
                finalItem.hasEmbedLyric = hasEmbedLyric
                finalItem.audioContainer = audioContainer
                finalItem.metadataWritable = metadataWritable
                finalItem.metadataError = metadataError
                finalItem.embedLyricError = embedLyricError
            }
            indexManager.update(normalizedUsername, finalItem, folder)
        }
    } catch (err: any) {
        console.warn(`[FileCache] Failed to ensure lyrics for ${path.basename(audioPath)}: ${err?.message || err}`)
    }
}

export const downloadAndCache = async (songInfo: any, url: string, quality?: string, username?: string, signal?: AbortSignal, isOnlyDownload?: boolean, shouldCacheLyric: boolean = true, shouldEmbedLyric: boolean = true, provenance: DownloadProvenance = {}) => {
    const safeUrl = await assertSafeRemoteHttpUrl(url)
    url = safeUrl.toString()
    const dir = ensureDir(username, isOnlyDownload)
    const baseName = getFileName(songInfo, quality, isOnlyDownload, username)
    const tempPath = path.join(dir, baseName + '.tmp')
    const songKey = normalizeSongId(songInfo) + '_' + (quality || 'unknown')
    const requestedSource = provenance.requestedSource || songInfo.requestedSource || songInfo.source || 'unknown'
    const downloadSource = detectDownloadSource(url, provenance.downloadSource || songInfo.downloadSource || songInfo.source)
    const sourceName = provenance.sourceName || songInfo.sourceName

    const result = checkCache({ ...songInfo, quality, exactQuality: true }, username, false)
    if (result.exists && !result.isCollision) {
        const targetFolder: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'
        if (result.folder === targetFolder && result.path) {
            const existingPath = result.path
            await withCachePostProcess(signal, 'existing cache', async () => {
                await ensureCachedLyrics(songInfo, quality || result.quality, username, isOnlyDownload, existingPath, targetFolder, shouldCacheLyric, shouldEmbedLyric)
                const existing = indexManager.getAll(normalizeCacheUsername(username), targetFolder)
                    .find(item => item.filename === result.filename)
                if (existing) reconcileCacheItemFromDisk(normalizeCacheUsername(username), targetFolder, existing, existingPath)
            })
            console.log(`[FileCache] Song already exists in ${targetFolder}, skipping download: ${result.filename}`)
            // 通知前端轮询：目标目录文件已存在，视为立即完成
            setCacheProgress(songKey, { progress: 100, status: 'exists' })
            return Promise.resolve()
        }

        if (isOnlyDownload && result.folder === 'cache' && result.path) {
            const sourcePath = result.path
            return await withCachePostProcess(signal, 'copy cache', async () => {
            const requestedOrCachedQuality = quality || result.quality || 'unknown'
            const inspection = inspectAudioFile(sourcePath, requestedOrCachedQuality)
            const actualQuality = inspection.quality || requestedOrCachedQuality
            const sourceExt = path.extname(result.filename || sourcePath) || '.mp3'
            const ext = inspection.extension || sourceExt
            const finalBaseName = getFileName(songInfo, actualQuality, isOnlyDownload, username)
            const finalPath = path.join(dir, finalBaseName + ext)
            if (!fs.existsSync(finalPath)) {
                fs.copyFileSync(sourcePath, finalPath)
            }

            const metadata = extractSongMetadata(songInfo)
            const id = metadata.id || String(songInfo.id || songInfo.songmid)
            const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
            const cachedItem = getIndexItemByFilename(result.filename, normalizedUsername)
            const actualDownloadSource = cachedItem?.downloadSource || downloadSource
            const actualSourceName = cachedItem?.sourceName || sourceName
            const stat = fs.statSync(finalPath)
            let hasCover = false
            let hasEmbedLyric = false
            let metadataWritable = false
            const audioContainer = inspection.audioContainer
            let tagger: any
            try {
                tagger = new (getMusicTagNative().MusicTagger)()
                tagger.loadPath(finalPath)
                hasCover = hasValidEmbeddedCover(tagger.pictures)
                const lyricsInTag = tagger.lyrics
                hasEmbedLyric = !!(lyricsInTag && lyricsInTag.trim().length > 10)
                metadataWritable = true
            } catch (e) { }
            finally {
                try { tagger?.dispose() } catch { }
            }

            let coverType: CacheItem['coverType'] = hasCover ? 'embedded' : 'none'
            if (!hasCover) {
                const sourceCover = await getCacheCover(result.filename, normalizedUsername)
                if (sourceCover?.data?.length && writeCoverCache(path.basename(finalPath), normalizedUsername, sourceCover.data, sourceCover.mime, stat)) {
                    hasCover = true
                    coverType = 'cached'
                } else if (hasUsableRemoteCover(metadata.img)) {
                    hasCover = true
                    coverType = 'remote'
                }
            }

            let lyricFilename: string | undefined
            const sourceLyricPath = sourcePath.substring(0, sourcePath.length - sourceExt.length) + '.lrc'
            if (shouldCacheLyric && fs.existsSync(sourceLyricPath)) {
                const targetLyricPath = path.join(dir, finalBaseName + '.lrc')
                fs.copyFileSync(sourceLyricPath, targetLyricPath)
                lyricFilename = path.basename(targetLyricPath)
            }

            indexManager.update(normalizedUsername, {
                id, songmid: id, name: metadata.name, singer: metadata.singer,
                album: metadata.album, albumId: metadata.albumId, img: metadata.img,
                interval: metadata.interval, source: metadata.source, requestedSource,
                downloadSource: actualDownloadSource, sourceName: actualSourceName,
                quality: actualQuality, filename: path.basename(finalPath),
                folder: 'music', mtime: Date.now(), size: stat.size,
                lyricFilename,
                ext: ext.replace('.', ''),
                hasCover,
                coverType,
                hasLyric: !!lyricFilename,
                hasEmbedLyric,
                audioContainer,
                bitrate: inspection.bitrate,
                sampleRate: inspection.sampleRate,
                bitDepth: inspection.bitDepth,
                metadataWritable,
                metadataError: metadataWritable ? undefined : getMetadataUnsupportedMessage(audioContainer)
            }, 'music')

            await ensureCachedLyrics(songInfo, actualQuality, username, true, finalPath, 'music', shouldCacheLyric, shouldEmbedLyric)
            const finalizedItem = indexManager.getAll(normalizedUsername, 'music')
                .find(item => item.filename === path.basename(finalPath))
            if (finalizedItem) reconcileCacheItemFromDisk(normalizedUsername, 'music', finalizedItem, finalPath)

            console.log(`[FileCache] Copied cached song to music folder: ${path.basename(finalPath)}`)
            setCacheProgress(songKey, { progress: 100, status: 'finished', total: stat.size, received: stat.size })
            return Promise.resolve()
            })
        }

        console.log(`[FileCache] Song already exists in ${result.folder}, skipping download: ${result.filename}`)
        setCacheProgress(songKey, { progress: 100, status: 'exists' })
        return Promise.resolve()
    }

    if (signal?.aborted) return
    console.log(`[FileCache] Starting download for: ${baseName}`)

    return new Promise<void>((resolve, reject) => {
        const protocol = safeUrl.protocol === 'https:' ? https : http
        let req: http.ClientRequest
        let activeResponse: http.IncomingMessage | null = null
        let fileStream: fs.WriteStream | null = null
        let settled = false

        const fail = (err: Error) => {
            if (settled) return
            const message = err.message || 'Download failed'
            setCacheProgress(songKey, { progress: 0, status: 'error', errorMsg: message })
            settle(() => reject(err))
        }

        const settle = (fn: () => void) => {
            if (settled) return
            settled = true
            if (signal) signal.removeEventListener('abort', abortHandler)
            activeResponse = null
            fileStream = null
            fn()
        }

        const abortHandler = () => {
            if (req) req.destroy()
            activeResponse?.destroy()
            fileStream?.destroy()
            if (fs.existsSync(tempPath)) fs.unlink(tempPath, () => { })
            cacheProgress.delete(songKey)
            settle(() => reject(new Error('Aborted')))
        }

        if (signal) signal.addEventListener('abort', abortHandler)

        const requestWithRedirect = (currentUrl: SafeRemoteHttpUrl, depth = 0) => {
            if (depth > 5) {
                fail(new Error('Too many redirects'))
                return
            }
            const currentProtocol = currentUrl.protocol === 'https:' ? https : http
            const options: https.RequestOptions = {
                lookup: currentUrl.lookup,
                agent: false,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': currentUrl.origin,
                },
            }
            req = currentProtocol.get(currentUrl, options, async (res) => {
                activeResponse = res
                if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume()
                    try {
                        let nextUrlStr = res.headers.location
                        if (!nextUrlStr.startsWith('http')) {
                            nextUrlStr = new URL(nextUrlStr, currentUrl).href
                        }
                        const safeNextUrl = await assertSafeRemoteHttpUrl(nextUrlStr)
                        requestWithRedirect(safeNextUrl, depth + 1)
                    } catch (e: any) {
                        fail(e)
                    }
                    return
                }

                if (res.statusCode !== 200) {
                    res.resume()
                    fs.unlink(tempPath, () => { })
                    fail(new Error(`Status: ${res.statusCode}`))
                    return
                }

                setCacheProgress(songKey, { progress: 0, status: 'downloading', total: 0, received: 0, speed: 0, updatedAt: Date.now() })
                const total = parseInt(res.headers['content-length'] || '0', 10)
                const maxAudioBytes = 500 * 1024 * 1024
                if (total > maxAudioBytes) {
                    res.resume()
                    fail(new Error('Audio file is too large'))
                    return
                }
            let received = 0
            let lastSpeedAt = Date.now()
            let lastSpeedBytes = 0
            let currentSpeed = 0
            const contentType = res.headers['content-type'] || ''
            let headerExt = '.mp3'
            if (contentType.includes('audio/flac')) headerExt = '.flac'
            else if (contentType.includes('audio/ogg')) headerExt = '.ogg'
            else if (contentType.includes('audio/x-m4a') || contentType.includes('audio/mp4')) headerExt = '.m4a'
            else if (contentType.includes('audio/wav')) headerExt = '.wav'

            const currentFileStream = fs.createWriteStream(tempPath)
            fileStream = currentFileStream
            let writeFinished = false
            res.on('data', (chunk) => {
                received += chunk.length
                if (received > maxAudioBytes) {
                    res.destroy(new Error('Audio file is too large'))
                    return
                }
                const now = Date.now()
                if (now - lastSpeedAt >= 1000) {
                    currentSpeed = Math.max(0, (received - lastSpeedBytes) / ((now - lastSpeedAt) / 1000))
                    lastSpeedAt = now
                    lastSpeedBytes = received
                }
                const progress = total > 0 ? Math.round((received / total) * 100) : 0
                setCacheProgress(songKey, { progress, status: 'downloading', total, received, speed: currentSpeed, updatedAt: now })
            })

            res.pipe(currentFileStream)
            currentFileStream.on('finish', () => { writeFinished = true })
            currentFileStream.on('close', async () => {
                if (settled) return
                if (!writeFinished) {
                    fs.unlink(tempPath, () => { })
                    fail(new Error('Download stream closed before write finished'))
                    return
                }
                if (total > 0 && received < total) {
                    fs.unlink(tempPath, () => { })
                    fail(new Error(`Download incomplete: ${received}/${total}`))
                    return
                }
                let releasePostProcess: (() => void) | null = null
                try {
                    await acquireCachePostProcess(signal)
                    releasePostProcess = () => {
                        if (!releasePostProcess) return
                        releasePostProcess = null
                        releaseCachePostProcess()
                        maybeCollectCacheMemory(`download ${baseName} end`)
                    }
                    if (signal?.aborted) {
                        releasePostProcess()
                        fs.unlink(tempPath, () => { })
                        fail(new Error('Aborted'))
                        return
                    }
                    reportCacheMemory(`download ${baseName} start`)
                setCacheProgress(songKey, { progress: 100, status: 'tagging', total, received, speed: 0, updatedAt: Date.now() })

                let ext = headerExt
                if (fs.existsSync(tempPath)) {
                    try {
                        const { fileTypeFromFile } = await import('file-type')
                        const type = await fileTypeFromFile(tempPath)
                        if (type) ext = `.${type.ext}`
                    } catch (e) { }
                }

                const inspection = inspectAudioFile(tempPath, quality)
                ext = inspection.extension || ext
                const actualQuality = inspection.quality || quality || 'unknown'
                const finalBaseName = getFileName(songInfo, actualQuality, isOnlyDownload, username)
                const finalPath = path.join(dir, finalBaseName + ext)
                fs.rename(tempPath, finalPath, async (err) => {
                    if (err) {
                        releasePostProcess?.()
                        fs.unlink(tempPath, () => { })
                        fail(err)
                        return
                    }

                    // The audio file has been promoted to its final path. Metadata,
                    // cover and lyric enrichment are best-effort and must not turn a
                    // successfully downloaded audio file into a failed task.
                    let imageBuffer: Buffer | undefined
                    let imageMime = 'image/jpeg'
                    try {

                    try {
                        const imageUrl = songInfo.img || (songInfo.meta && songInfo.meta.picUrl)
                        if (imageUrl && imageUrl.startsWith('http') && !isPlaceholderCoverUrl(imageUrl)) {
                            const safeImageUrl = await assertSafeRemoteHttpUrl(imageUrl)
                            const chunks: Buffer[] = []
                            const p = safeImageUrl.protocol === 'https:' ? https : http
                            try {
                                imageBuffer = await new Promise((resolveI, rejectI) => {
                                const imgReq = p.get(safeImageUrl, { lookup: safeImageUrl.lookup, agent: false, signal }, ires => {
                                    if (ires.statusCode && ires.statusCode >= 400) {
                                        ires.resume()
                                        rejectI(new Error(`Cover status: ${ires.statusCode}`))
                                        return
                                    }
                                    if (Number(ires.headers['content-length'] || 0) > 10 * 1024 * 1024) {
                                        ires.resume()
                                        rejectI(new Error('Cover is too large'))
                                        return
                                    }
                                    imageMime = String(ires.headers['content-type'] || 'image/jpeg').split(';')[0]
                                    let imageBytes = 0
                                    ires.on('data', c => {
                                        imageBytes += c.length
                                        if (imageBytes <= 10 * 1024 * 1024) chunks.push(c)
                                        else ires.destroy(new Error('Cover is too large'))
                                    })
                                    ires.on('end', () => resolveI(Buffer.concat(chunks)))
                                    ires.on('error', rejectI)
                                })
                                imgReq.on('error', rejectI)
                                imgReq.setTimeout(10000, () => {
                                    imgReq.destroy(new Error('Cover download timeout'))
                                })
                                })
                            } finally {
                                chunks.length = 0
                            }
                        }
                    } catch (e) { }

                    if (signal?.aborted) throw new Error('Aborted')

                    const metadata = extractSongMetadata(songInfo)
                    const id = metadata.id || String(songInfo.id || songInfo.songmid)
                    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
                    const folderType: 'cache' | 'music' = isOnlyDownload ? 'music' : 'cache'

                    indexManager.update(normalizedUsername, {
                        id, songmid: id, name: metadata.name, singer: metadata.singer,
                        album: metadata.album, albumId: metadata.albumId, img: metadata.img,
                        interval: metadata.interval, source: metadata.source, requestedSource,
                        downloadSource, sourceName,
                        quality: actualQuality, filename: finalBaseName + ext,
                        folder: folderType, mtime: Date.now(), size: received,
                        ext: ext.replace('.', ''), hasCover: false, hasLyric: false,
                        audioContainer: inspection.audioContainer,
                        bitrate: inspection.bitrate,
                        sampleRate: inspection.sampleRate,
                        bitDepth: inspection.bitDepth,
                    }, folderType)

                    let tagger: any
                    let metadataWritable = false
                    try {
                        tagger = new (getMusicTagNative().MusicTagger)()
                        tagger.loadPath(finalPath)
                        tagger.title = metadata.name
                        tagger.artist = metadata.singer
                        tagger.album = metadata.album
                        if (imageBuffer && imageBuffer.length > 0) tagger.pictures = [new (getMusicTagNative().MetaPicture)(imageMime, new Uint8Array(imageBuffer), 'Cover')]
                        tagger.save()
                        metadataWritable = true
                    } catch (e) {
                    } finally {
                        try { if (tagger) tagger.dispose() } catch (e) { }
                    }

                    const taggedStats = fs.statSync(finalPath)
                    let finalHasCover = readEmbeddedCoverState(finalPath)
                    if (!finalHasCover && imageBuffer?.length) {
                        finalHasCover = writeCoverCache(finalBaseName + ext, normalizedUsername, imageBuffer, imageMime, taggedStats)
                    }
                    imageBuffer = undefined
                    const taggedItem = indexManager.get(normalizedUsername, id, folderType, actualQuality)
                    if (taggedItem) {
                        taggedItem.coverType = readEmbeddedCoverState(finalPath)
                            ? 'embedded'
                            : finalHasCover
                                ? 'cached'
                                : hasUsableRemoteCover(metadata.img)
                                    ? 'remote'
                                    : 'none'
                        taggedItem.hasCover = taggedItem.coverType !== 'none'
                        taggedItem.audioContainer = inspection.audioContainer
                        taggedItem.metadataWritable = metadataWritable
                        taggedItem.metadataError = metadataWritable ? undefined : getMetadataUnsupportedMessage(taggedItem.audioContainer)
                        taggedItem.coverCheckedVersion = COVER_CHECK_VERSION
                        taggedItem.coverCheckedMtime = taggedStats.mtimeMs
                        taggedItem.coverCheckedSize = taggedStats.size
                        taggedItem.mtime = taggedStats.mtimeMs
                        taggedItem.size = taggedStats.size
                        indexManager.update(normalizedUsername, taggedItem, folderType)
                    }

                    if (signal?.aborted) throw new Error('Aborted')
                    await ensureCachedLyrics(songInfo, actualQuality, username, isOnlyDownload, finalPath, folderType, shouldCacheLyric, shouldEmbedLyric)
                    const finalizedItem = indexManager.getAll(normalizedUsername, folderType)
                        .find(item => item.filename === finalBaseName + ext)
                    if (finalizedItem) reconcileCacheItemFromDisk(normalizedUsername, folderType, finalizedItem, finalPath)
                    } catch (postProcessError: any) {
                        if (!signal?.aborted) {
                            console.warn(`[FileCache] Optional post-processing failed for ${path.basename(finalPath)}: ${postProcessError?.message || postProcessError}`)
                        }
                    } finally {
                        imageBuffer = undefined
                        releasePostProcess?.()
                        if (signal?.aborted) {
                            fail(new Error('Aborted'))
                            return
                        }
                        if (!fs.existsSync(finalPath)) {
                            fail(new Error('Downloaded file is missing after processing'))
                            return
                        }

                        setCacheProgress(songKey, { progress: 100, status: 'finished', total: total || received, received, speed: 0, updatedAt: Date.now() })
                        settle(() => { resolve(); void checkAndCleanupCache(username) })
                    }
                })
                } catch (error: any) {
                    releasePostProcess?.()
                    if (fs.existsSync(tempPath)) fs.unlink(tempPath, () => { })
                    fail(error instanceof Error ? error : new Error(String(error)))
                }
            })
            currentFileStream.on('error', (err) => { fs.unlink(tempPath, () => { }); fail(err) })
          })
          req.on('error', (err) => { fs.unlink(tempPath, () => { }); fail(err) })
          req.setTimeout(30000, () => {
              req.destroy(new Error('Download request timeout'))
          })
        }
        requestWithRedirect(safeUrl)
    })
}

const normalizeCacheUsername = (username?: string) => (
    username && username !== '_open' && username !== 'default' ? username : '_open'
)

const resolveMusicPath = (root: string, relativePath: string) => {
    const resolvedRoot = path.resolve(root)
    const resolvedPath = path.resolve(root, relativePath)
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
        throw new Error('Invalid music file path')
    }
    return resolvedPath
}

const getAvailableRemasterTarget = (
    root: string,
    subPath: string,
    preferredBaseName: string,
    extension: string,
    oldAudioPath: string,
    oldLyricPath: string,
    needsLyric: boolean,
) => {
    for (let index = 0; index < 10000; index++) {
        const suffix = index === 0 ? '' : ` (${index + 1})`
        const baseName = preferredBaseName.substring(0, Math.max(1, 200 - suffix.length)) + suffix
        const audioFilename = path.join(subPath, baseName + extension).replace(/\\/g, '/').replace(/^\.\//, '')
        const lyricFilename = path.join(subPath, baseName + '.lrc').replace(/\\/g, '/').replace(/^\.\//, '')
        const audioPath = resolveMusicPath(root, audioFilename)
        const lyricPath = resolveMusicPath(root, lyricFilename)
        const audioConflict = audioPath !== oldAudioPath && fs.existsSync(audioPath)
        const lyricConflict = needsLyric && lyricPath !== oldLyricPath && fs.existsSync(lyricPath)
        if (!audioConflict && !lyricConflict) {
            return { audioFilename, lyricFilename, audioPath, lyricPath }
        }
    }
    throw new Error('无法生成不冲突的目标文件名')
}

export const getDownloadedMusicItems = async (username?: string) => {
    const normalizedUsername = normalizeCacheUsername(username)
    await syncCacheIndex(normalizedUsername, ['music'])
    return indexManager.getAll(normalizedUsername, 'music').map(item => ({ ...item }))
}

export const replaceDownloadedMusicItem = async (
    username: string,
    originalItem: CacheItem,
    songInfo: any,
    url: string,
    quality: string,
    signal?: AbortSignal,
) => {
    const normalizedUsername = normalizeCacheUsername(username)
    const root = getCacheDir(normalizedUsername, true)
    const currentItem = indexManager.get(normalizedUsername, originalItem.id, 'music', originalItem.quality, true)
    if (!currentItem || currentItem.filename !== originalItem.filename) {
        throw new Error('原文件已发生变化或已不存在')
    }
    if (quality === currentItem.quality) throw new Error('实际音质与原音质相同，无需替换')

    const oldAudioPath = resolveMusicPath(root, currentItem.filename)
    if (!fs.existsSync(oldAudioPath)) throw new Error('原文件已不存在')

    const stageId = crypto.randomBytes(12).toString('hex')
    const stageUsername = `.remaster-staging/${stageId}`
    const stageRoot = getCacheDir(stageUsername, true)
    const stageCoverRoot = getCoverCacheDir(stageUsername)
    const backupSuffix = `.remaster-${crypto.randomBytes(6).toString('hex')}.bak`
    const oldAudioBackup = oldAudioPath + backupSuffix
    let oldLyricPath = ''
    let oldLyricBackup = ''
    let targetAudioPath = ''
    let targetLyricPath = ''
    let replacementItem: CacheItem | null = null
    let backedUpOldAudio = false
    let backedUpOldLyric = false
    let installedNewAudio = false
    let installedNewLyric = false
    let updatedNewIndex = false
    let removedOldIndex = false

    try {
        await downloadAndCache(songInfo, url, quality, stageUsername, signal, true, true, true)
        if (signal?.aborted) throw new Error('Aborted')

        const stagedItems = indexManager.getAll(stageUsername, 'music')
        const targetId = normalizeSongId(songInfo)
        const downloadedItem = stagedItems.find(item => item.id === targetId) || stagedItems[0]
        if (!downloadedItem) throw new Error('新音质文件未写入暂存索引')

        const sourceAudioPath = resolveMusicPath(stageRoot, downloadedItem.filename)
        const sourceStats = fs.existsSync(sourceAudioPath) ? fs.statSync(sourceAudioPath) : null
        if (!sourceStats?.isFile() || sourceStats.size <= 0) throw new Error('新音质文件无效或为空')
        const stagedHasCover = readEmbeddedCoverState(sourceAudioPath)
        const originalCover = stagedHasCover
            ? null
            : ((await getCacheCover(downloadedItem.filename, stageUsername)) || (await getCacheCover(currentItem.filename, normalizedUsername)))

        oldLyricPath = currentItem.lyricFilename ? resolveMusicPath(root, currentItem.lyricFilename) : ''
        oldLyricBackup = oldLyricPath ? oldLyricPath + backupSuffix : ''
        const sourceLyricPath = downloadedItem.lyricFilename
            ? resolveMusicPath(stageRoot, downloadedItem.lyricFilename)
            : ''
        const targetSubPath = currentItem.subPath || ''
        const downloadedExtension = path.extname(downloadedItem.filename) || `.${downloadedItem.ext || 'mp3'}`
        const preferredBaseName = getFileName(songInfo, quality, true, normalizedUsername)
        const target = getAvailableRemasterTarget(
            root,
            targetSubPath,
            preferredBaseName,
            downloadedExtension,
            oldAudioPath,
            oldLyricPath,
            !!((sourceLyricPath && fs.existsSync(sourceLyricPath)) || (oldLyricPath && fs.existsSync(oldLyricPath))),
        )
        const targetFilename = target.audioFilename
        const targetLyricFilename = target.lyricFilename
        targetAudioPath = target.audioPath
        targetLyricPath = target.lyricPath

        fs.renameSync(oldAudioPath, oldAudioBackup)
        backedUpOldAudio = true
        if (oldLyricPath && fs.existsSync(oldLyricPath)) {
            fs.renameSync(oldLyricPath, oldLyricBackup)
            backedUpOldLyric = true
        }

        fs.mkdirSync(path.dirname(targetAudioPath), { recursive: true })
        safeRenameSync(sourceAudioPath, targetAudioPath)
        installedNewAudio = true

        let finalHasCover = readEmbeddedCoverState(targetAudioPath)
        if (!finalHasCover && originalCover?.data?.length) {
            let tagger: any
            try {
                tagger = new (getMusicTagNative().MusicTagger)()
                tagger.loadPath(targetAudioPath)
                tagger.pictures = [
                    new (getMusicTagNative().MetaPicture)(originalCover.mime || 'image/jpeg', new Uint8Array(originalCover.data), 'Cover'),
                ]
                tagger.save()
            } catch (e) {
                console.warn(`[FileCache] Unable to embed the original cover in ${targetFilename}; using external cover cache`)
            } finally {
                try { if (tagger) tagger.dispose() } catch (e) { }
            }
            finalHasCover = readEmbeddedCoverState(targetAudioPath)
        }

        let finalLyricFilename: string | undefined
        if (sourceLyricPath && fs.existsSync(sourceLyricPath)) {
            fs.mkdirSync(path.dirname(targetLyricPath), { recursive: true })
            if (sourceLyricPath !== targetLyricPath) {
                safeRenameSync(sourceLyricPath, targetLyricPath)
                installedNewLyric = true
            }
            finalLyricFilename = targetLyricFilename
        } else if (backedUpOldLyric && fs.existsSync(oldLyricBackup)) {
            fs.mkdirSync(path.dirname(targetLyricPath), { recursive: true })
            fs.copyFileSync(oldLyricBackup, targetLyricPath)
            installedNewLyric = true
            finalLyricFilename = targetLyricFilename
        }

        const finalStats = fs.statSync(targetAudioPath)
        if (!finalHasCover && originalCover?.data?.length) {
            finalHasCover = writeCoverCache(
                targetFilename,
                normalizedUsername,
                originalCover.data,
                originalCover.mime || 'image/jpeg',
                finalStats,
            )
        }
        replacementItem = {
            ...downloadedItem,
            id: currentItem.id,
            songmid: currentItem.songmid || currentItem.id,
            source: currentItem.source,
            filename: targetFilename,
            folder: 'music',
            subPath: targetSubPath,
            lyricFilename: finalLyricFilename,
            hasLyric: !!finalLyricFilename,
            hasCover: finalHasCover,
            coverType: readEmbeddedCoverState(targetAudioPath) ? 'embedded' : finalHasCover ? 'cached' : hasUsableRemoteCover(downloadedItem.img) ? 'remote' : 'none',
            coverCheckedVersion: COVER_CHECK_VERSION,
            coverCheckedMtime: finalStats.mtimeMs,
            coverCheckedSize: finalStats.size,
            mtime: finalStats.mtimeMs,
            size: finalStats.size,
        }
        replacementItem.hasCover = replacementItem.coverType !== 'none'
        indexManager.update(normalizedUsername, replacementItem, 'music')
        updatedNewIndex = true
        indexManager.remove(normalizedUsername, currentItem.id, 'music', currentItem.quality)
        removedOldIndex = true

        try {
            if (backedUpOldAudio && fs.existsSync(oldAudioBackup)) fs.unlinkSync(oldAudioBackup)
        } catch (cleanupError) {
            console.warn('[FileCache] Failed to remove remaster audio backup:', cleanupError)
        }
        try {
            if (backedUpOldLyric && fs.existsSync(oldLyricBackup)) fs.unlinkSync(oldLyricBackup)
        } catch (cleanupError) {
            console.warn('[FileCache] Failed to remove remaster lyric backup:', cleanupError)
        }
        return { ...replacementItem }
    } catch (err) {
        try {
            if (updatedNewIndex && replacementItem) {
                indexManager.remove(normalizedUsername, replacementItem.id, 'music', replacementItem.quality)
            }
            if (installedNewLyric && targetLyricPath && fs.existsSync(targetLyricPath)) fs.unlinkSync(targetLyricPath)
            if (installedNewAudio && targetAudioPath && fs.existsSync(targetAudioPath)) fs.unlinkSync(targetAudioPath)
            if (backedUpOldAudio && fs.existsSync(oldAudioBackup) && !fs.existsSync(oldAudioPath)) {
                fs.renameSync(oldAudioBackup, oldAudioPath)
            }
            if (backedUpOldLyric && fs.existsSync(oldLyricBackup) && !fs.existsSync(oldLyricPath)) {
                fs.renameSync(oldLyricBackup, oldLyricPath)
            }
            if (removedOldIndex || updatedNewIndex) {
                indexManager.update(normalizedUsername, currentItem, 'music')
            }
        } catch (rollbackError) {
            console.error('[FileCache] Failed to roll back remaster replacement:', rollbackError)
        }
        throw err
    } finally {
        indexManager.discard(stageUsername, 'music')
        try {
            if (fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true })
        } catch (cleanupError) {
            console.warn('[FileCache] Failed to clean remaster staging directory:', cleanupError)
        }
        try {
            if (fs.existsSync(stageCoverRoot)) fs.rmSync(stageCoverRoot, { recursive: true, force: true })
        } catch (cleanupError) {
            console.warn('[FileCache] Failed to clean remaster cover staging directory:', cleanupError)
        }
    }
}

// [新增] 根据文件名从索引中查找对应条目（跨 cache/music 两个目录）
export const getIndexItemByFilename = (filename: string, username: string) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of ['cache', 'music'] as const) {
        const items = indexManager.getAll(normalizedUsername, folder)
        const found = items.find((i: any) => i.filename === filename)
        if (found) return { ...found, folder }
    }
    return null
}

// [新增] 暴露 lyricFetcher 引用，供外部接口（如 embedLyric）使用
export const getLyricFetcher = () => _lyricFetcher

// [新增] 更新索引中指定文件的 hasEmbedLyric 状态（由 embedLyric 接口成功写入后调用）
export const setIndexEmbedLyric = (
    filename: string,
    username: string,
    value: boolean,
    metadata?: Pick<CacheItem, 'audioContainer' | 'metadataWritable' | 'metadataError' | 'embedLyricError'>,
) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of ['cache', 'music'] as const) {
        const items = indexManager.getAll(normalizedUsername, folder)
        const found = items.find((i: any) => i.filename === filename)
        if (found) {
            (found as any).hasEmbedLyric = value
            if (metadata) Object.assign(found, metadata)
            indexManager.update(normalizedUsername, found, folder)
            return true
        }
    }
    return false
}

export const getCacheStats = (username?: string) => {
    const roots = ['cache', 'music']
    const result: any = { cache: { totalSize: 0, fileCount: 0 }, music: { totalSize: 0, fileCount: 0 }, totalSize: 0, fileCount: 0 }
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const extensions = CACHE_SIZE_EXTENSIONS
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        const files = getCacheFilesRecursively(dir)
        for (const filePath of files) {
            const ext = path.extname(filePath).toLowerCase()
            if (extensions.has(ext)) {
                try {
                    const stats = fs.statSync(filePath)
                    result[folder].totalSize += stats.size
                    result.totalSize += stats.size
                    if (ext !== '.lrc') { result[folder].fileCount++; result.fileCount++ }
                } catch (e) { }
            }
        }
    }
    return result
}

const CACHE_SIZE_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.wav', '.lrc'])

const getCacheFilesRecursively = (root: string): string[] => {
    const files: string[] = []
    const visit = (dir: string) => {
        if (!fs.existsSync(dir)) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue
            const filePath = path.join(dir, entry.name)
            if (entry.isDirectory()) visit(filePath)
            else if (entry.isFile()) files.push(filePath)
        }
    }
    visit(root)
    return files
}

export const clearAllCache = (username?: string) => {
    const roots: CacheFolder[] = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        for (const filePath of getCacheFilesRecursively(dir)) {
            try {
                const stats = fs.statSync(filePath)
                fs.unlinkSync(filePath)
                deletedCount++; freedSize += stats.size
            } catch (e) { }
        }
        indexManager.clear(normalizedUsername, folder)
    }
    invalidateCacheListSync(normalizedUsername)
    return { deletedCount, freedSize }
}

export const clearLyricCache = (username?: string) => {
    const roots: Array<'cache' | 'music'> = ['cache', 'music']
    let deletedCount = 0
    let freedSize = 0
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    for (const folder of roots) {
        const dir = getCacheDir(normalizedUsername, folder === 'music')
        if (!fs.existsSync(dir)) continue
        for (const filePath of getCacheFilesRecursively(dir)) {
            if (path.extname(filePath).toLowerCase() === '.lrc') {
                try {
                    const stats = fs.statSync(filePath)
                    fs.unlinkSync(filePath)
                    deletedCount++; freedSize += stats.size
                } catch (e) { }
            }
        }
        const items = indexManager.getAll(normalizedUsername, folder)
        items.forEach(item => {
            if (!item.hasLyric && !item.lyricFilename) return
            item.hasLyric = false
            item.lyricFilename = undefined
            indexManager.update(normalizedUsername, item, folder)
        })
    }
    invalidateCacheListSync(normalizedUsername)
    return { deletedCount, freedSize }
}

export const checkAndCleanupCache = async (username?: string) => {
    const config = (global as any).lx.config
    if (!config || !config['user.enableCacheSizeLimit']) return
    const stats = getCacheStats(username)
    const cacheSize = stats.cache?.totalSize ?? 0
    const limitBytes = (config['user.cacheSizeLimit'] || 2000) * 1024 * 1024
    if (cacheSize <= limitBytes) return

    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const dir = getCacheDir(normalizedUsername, false)
    if (!fs.existsSync(dir)) return

    type CleanupCandidate = {
        path: string
        size: number
        mtime: number
        lastPlayedAt: number
    }
    const allFiles: CleanupCandidate[] = []
    const indexedFiles = new Set<string>()
    const indexedItems = indexManager.getAll(normalizedUsername, 'cache')

    // 以歌曲为清理单元，把同名歌词一起计入大小，避免先删掉歌词、
    // 后删音频时出现索引状态和实际占用不一致。
    for (const item of indexedItems) {
        const audioPath = resolveCacheRelativePath(dir, item.filename)
        if (!audioPath || !fs.existsSync(audioPath)) continue
        if (!CACHE_SIZE_EXTENSIONS.has(path.extname(audioPath).toLowerCase())) continue

        const relatedPaths = [audioPath]
        const lyricFilename = item.lyricFilename || resolveCompanionLyricFilename(dir, item.filename)
        const lyricPath = lyricFilename ? resolveCacheRelativePath(dir, lyricFilename) : null
        if (lyricPath && fs.existsSync(lyricPath)) relatedPaths.push(lyricPath)

        let size = 0
        let mtime = Number.POSITIVE_INFINITY
        for (const relatedPath of relatedPaths) {
            try {
                const fileStat = fs.statSync(relatedPath)
                size += fileStat.size
                mtime = Math.min(mtime, fileStat.mtime.getTime())
                indexedFiles.add(relatedPath)
            } catch (e) { }
        }
        if (size > 0) {
            const lastPlayedAt = Number(item.lastPlayedAt)
            allFiles.push({
                path: audioPath,
                size,
                mtime: Number.isFinite(mtime) ? mtime : 0,
                // 旧缓存没有播放记录时按“从未播放”处理，优先清理；
                // 同为从未播放时再沿用 mtime 作为稳定的次级排序。
                lastPlayedAt: Number.isFinite(lastPlayedAt) && lastPlayedAt >= 0 ? lastPlayedAt : 0,
            })
        }
    }

    // 没有索引的历史文件也要纳入清理，并按从未播放处理。
    for (const filePath of getCacheFilesRecursively(dir)) {
        if (indexedFiles.has(filePath)) continue
        if (!CACHE_SIZE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue
        try {
            const fileStat = fs.statSync(filePath)
            allFiles.push({ path: filePath, size: fileStat.size, mtime: fileStat.mtime.getTime(), lastPlayedAt: 0 })
        } catch (e) { }
    }

    allFiles.sort((a, b) => a.lastPlayedAt - b.lastPlayedAt || a.mtime - b.mtime)
    let currentSize = cacheSize
    const targetSize = limitBytes * 0.95
    let deletedCount = 0
    for (const file of allFiles) {
        if (currentSize <= targetSize) break
        if (!fs.existsSync(file.path)) continue
        try {
            const relPath = path.relative(dir, file.path).replace(/\\/g, '/')
            const res = removeCacheFile(relPath, normalizedUsername, 'cache')
            if (res.deleted) {
                currentSize -= file.size
                deletedCount++
            }
        } catch (e) {
            try {
                fs.unlinkSync(file.path)
                currentSize -= file.size
                deletedCount++
            } catch (_) { }
        }
    }
    if (deletedCount > 0) {
        invalidateCacheListSync(normalizedUsername)
    }
    console.log(`[FileCache] Cleaned up ${deletedCount} least-recently-played cache entries for ${normalizedUsername}`)
}
/**
 * Switch files between 'cache' and 'music' folders
 */
export const switchFolder = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    let successCount = 0
    let failCount = 0

    const cacheIndex = indexManager.load(normalizedUsername, 'cache')
    const musicIndex = indexManager.load(normalizedUsername, 'music')

    const cacheDir = getCacheDir(normalizedUsername, false)
    const musicDir = getCacheDir(normalizedUsername, true)

    for (const filename of filenames) {
        let sourceFolder: 'cache' | 'music' | null = null
        let item: CacheItem | null = null
        let inMusic: CacheItem | undefined = undefined

        // Find which folder it belongs to
        const inCache = Array.from(cacheIndex.values()).find(i => i.filename === filename)
        if (inCache) {
            sourceFolder = 'cache'
            item = inCache
        } else {
            inMusic = Array.from(musicIndex.values()).find(i => i.filename === filename)
            if (inMusic) {
                sourceFolder = 'music'
                item = inMusic
            }
        }

        if (!sourceFolder || !item) {
            console.log(`[FileCache][DEBUG] switchFolder: not found in indexes`, { filename, inCache: !!inCache, inMusic: !!inMusic })
            failCount++
            continue
        }

        const targetFolder: 'cache' | 'music' = sourceFolder === 'cache' ? 'music' : 'cache'

        // [Constraint] Cannot move from music subfolder to cache
        if (sourceFolder === 'music' && item.subPath && item.subPath !== '') {
            console.log(`[FileCache] Move blocked: ${filename} is in a subfolder and cannot move to cache.`)
            failCount++
            continue
        }

        const sourceDir = sourceFolder === 'music' ? musicDir : cacheDir
        const targetDir = targetFolder === 'music' ? musicDir : cacheDir

        const sourcePath = resolveCacheRelativePath(sourceDir, filename)
        const targetPath = resolveCacheRelativePath(targetDir, filename)
        if (!sourcePath || !targetPath) {
            failCount++
            continue
        }

        try {
            console.log(`[FileCache][DEBUG] switchFolder start`, { filename, sourceFolder, targetFolder, sourcePath, targetPath })
            const srcExists = fs.existsSync(sourcePath)
            const tgtExists = fs.existsSync(targetPath)
            console.log(`[FileCache][DEBUG] existence`, { filename, srcExists, tgtExists })

            if (srcExists) {
                // Ensure target directory exists (including any nested subfolders)
                const targetPathDir = path.dirname(targetPath)
                if (!fs.existsSync(targetPathDir)) fs.mkdirSync(targetPathDir, { recursive: true })

                // Check collision in target folder
                if (fs.existsSync(targetPath)) {
                    console.log(`[FileCache] Move conflict: ${filename} already exists in ${targetFolder}, skipping.`)
                    failCount++
                    continue
                }

                // Move audio file
                try {
                    safeRenameSync(sourcePath, targetPath)
                    console.log(`[FileCache][DEBUG] moved audio`, { filename, sourcePath, targetPath })
                } catch (moveErr) {
                    const errMsg = moveErr instanceof Error ? moveErr.stack : String(moveErr)
                    console.error(`[FileCache][ERROR] move audio failed for ${filename}:`, errMsg)
                    failCount++
                    continue
                }

                // Move lyric file if exists
                if (item.lyricFilename) {
                    const sourceLrcPath = resolveCacheRelativePath(sourceDir, item.lyricFilename)
                    const targetLrcPath = resolveCacheRelativePath(targetDir, item.lyricFilename)
                    if (sourceLrcPath && targetLrcPath && fs.existsSync(sourceLrcPath)) {
                        const targetLrcDir = path.dirname(targetLrcPath)
                        if (!fs.existsSync(targetLrcDir)) fs.mkdirSync(targetLrcDir, { recursive: true })
                        if (fs.existsSync(targetLrcPath)) fs.unlinkSync(targetLrcPath)
                        try {
                            safeRenameSync(sourceLrcPath, targetLrcPath)
                            console.log(`[FileCache][DEBUG] moved lyric`, { filename, sourceLrcPath, targetLrcPath })
                        } catch (lrErr) {
                            const errMsg = lrErr instanceof Error ? lrErr.stack : String(lrErr)
                            console.error(`[FileCache][ERROR] move lyric failed for ${filename}:`, errMsg)
                        }
                    } else {
                        console.log(`[FileCache][DEBUG] lyric not found`, { filename, sourceLrcPath })
                    }
                }

                // Update Index
                const removed = indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality)
                console.log(`[FileCache][DEBUG] index remove result`, { filename, removed })
                item.folder = targetFolder
                indexManager.update(normalizedUsername, item, targetFolder)
                successCount++
            } else {
                console.log(`[FileCache][DEBUG] source missing`, { filename, sourcePath })
                failCount++
            }
        } catch (e) {
            const errMsg = e instanceof Error ? e.stack : String(e)
            console.error(`[FileCache] Failed to move ${filename}:`, errMsg)
            failCount++
        }
    }

    return { successCount, failCount }
}

export const switchBaseLocation = async (filenames: string[], username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    let successCount = 0
    let failCount = 0
    const sourceLoc = currentCacheLocation
    const targetLoc = sourceLoc === CACHE_ROOTS.DATA ? CACHE_ROOTS.ROOT : CACHE_ROOTS.DATA

    const folders: Array<'cache' | 'music'> = ['cache', 'music']

    // Helper to get dir for a specific location
    const getLocalDir = (folder: string, loc: string) => {
        return getCacheDir(normalizedUsername, folder === 'music', loc)
    }

    for (const filename of filenames) {
        let sourceFolder: 'cache' | 'music' | null = null
        let item: CacheItem | null = null

        // Find folder in SOURCE location
        for (const folder of folders) {
            const items = indexManager.getAll(normalizedUsername, folder, sourceLoc)
            const found = items.find(i => i.filename === filename)
            if (found) {
                sourceFolder = folder
                item = found
                break
            }
        }

        if (!sourceFolder || !item) {
            failCount++
            continue
        }

        const sourceDir = getLocalDir(sourceFolder, sourceLoc)
        const targetDir = getLocalDir(sourceFolder, targetLoc)

        const sourcePath = resolveCacheRelativePath(sourceDir, filename)
        const targetPath = resolveCacheRelativePath(targetDir, filename)
        if (!sourcePath || !targetPath) {
            failCount++
            continue
        }

        try {
            if (fs.existsSync(sourcePath)) {
                const targetPathDir = path.dirname(targetPath)
                if (!fs.existsSync(targetPathDir)) fs.mkdirSync(targetPathDir, { recursive: true })

                // Check collision in target location
                if (fs.existsSync(targetPath)) {
                    console.log(`[FileCache] Base move conflict: ${filename} already exists at ${targetLoc}, skipping.`)
                    failCount++
                    continue
                }

                // Move audio file
                safeRenameSync(sourcePath, targetPath)

                // Move lyrics
                if (item.lyricFilename) {
                    const sourceLrcPath = resolveCacheRelativePath(sourceDir, item.lyricFilename)
                    const targetLrcPath = resolveCacheRelativePath(targetDir, item.lyricFilename)
                    if (sourceLrcPath && targetLrcPath && fs.existsSync(sourceLrcPath)) {
                        const targetLrcDir = path.dirname(targetLrcPath)
                        if (!fs.existsSync(targetLrcDir)) fs.mkdirSync(targetLrcDir, { recursive: true })
                        if (fs.existsSync(targetLrcPath)) fs.unlinkSync(targetLrcPath)
                        safeRenameSync(sourceLrcPath, targetLrcPath)
                    }
                }

                // Update Indices
                indexManager.remove(normalizedUsername, item.id, sourceFolder, item.quality, sourceLoc)
                // item is now in the other location's index
                indexManager.update(normalizedUsername, item, sourceFolder, targetLoc)

                successCount++
            } else {
                failCount++
            }
        } catch (e) {
            console.error(`[FileCache] Failed to move ${filename} from ${sourceLoc} to ${targetLoc}:`, e)
            failCount++
        }
    }

    return { successCount, failCount, targetLoc }
}

/**
 * [New] Get all subdirectories in the music/cache folders
 */
export const getSubDirectories = (username: string | undefined, folder: 'cache' | 'music') => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const root = getCacheDir(normalizedUsername, folder === 'music')
    if (!fs.existsSync(root)) return []

    const dirs = new Set<string>()

    // 1. Get from index
    const items = indexManager.getAll(normalizedUsername, folder)
    items.forEach(item => { if (item.subPath) dirs.add(item.subPath) })

    // 2. Scan physical tree (to include empty folders)
    const scanDirs = (dirPath: string, base: string) => {
        if (!fs.existsSync(dirPath)) return
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const fullPath = path.join(dirPath, entry.name)
                dirs.add(path.relative(base, fullPath).replace(/\\/g, '/'))
                scanDirs(fullPath, base)
            }
        }
    }
    scanDirs(root, root)

    return Array.from(dirs).sort()
}

/**
 * [New] Create a subdirectory
 */
export const createSubDirectory = (username: string | undefined, folder: 'cache' | 'music', subPath: string) => {
    const root = getCacheDir(username, folder === 'music')
    if (typeof subPath !== 'string' || subPath.length > 512) throw new Error('Invalid subdirectory')
    const target = resolveInside(root, subPath)
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true })
        return true
    }
    return false
}

/**
 * [New] Categorize multiple files into a subdirectory
 */
export const categorizeFiles = async (filenames: string[], targetSubPath: string, username: string | undefined) => {
    const normalizedUsername = (username && username !== '_open' && username !== 'default') ? username : '_open'
    const folder = 'music' // Categorization is primarily for music folder
    const root = getCacheDir(normalizedUsername, true)
    if (!Array.isArray(filenames) || filenames.length > 500 || typeof targetSubPath !== 'string' || targetSubPath.length > 512) {
        throw new Error('Invalid categorize request')
    }
    const targetDir = resolveInside(root, targetSubPath)

    if (targetSubPath && !fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
    }

    const allItems = indexManager.getAll(normalizedUsername, folder)
    let successCount = 0
    let failCount = 0

    for (const filename of filenames) {
        const item = allItems.find(i => i.filename === filename)
        if (!item) {
            console.warn(`[FileCache] Categorize: item not found for ${filename}`)
            failCount++;
            continue
        }

        const oldPath = resolveInside(root, filename)
        const newFilename = targetSubPath ? path.join(targetSubPath, path.basename(filename)).replace(/\\/g, '/') : path.basename(filename)
        const newPath = resolveInside(root, newFilename)

        if (oldPath === newPath) { successCount++; continue }

        try {
            // Physically move file
            if (fs.existsSync(oldPath)) {
                safeRenameSync(oldPath, newPath)

                // Move lyrics if exist
                const ext = path.extname(filename)
                const oldLrcPath = oldPath.substring(0, oldPath.length - ext.length) + '.lrc'
                const newLrcPath = newPath.substring(0, newPath.length - ext.length) + '.lrc'
                if (fs.existsSync(oldLrcPath)) {
                    safeRenameSync(oldLrcPath, newLrcPath)
                }

                // Update index
                item.filename = newFilename
                item.subPath = targetSubPath
                if (item.lyricFilename) {
                    const musicExt = path.extname(newFilename)
                    const lrcExt = path.extname(item.lyricFilename) || '.lrc'
                    item.lyricFilename = newFilename.substring(0, newFilename.length - musicExt.length) + lrcExt
                }
                indexManager.update(normalizedUsername, item, folder)
            } else {
                failCount++
                continue
            }

            successCount++
        } catch (e: any) {
            console.error('[FileCache] Categorize failed for ' + filename + ':', e)
            failCount++
        }
    }

    return { successCount, failCount }
}
