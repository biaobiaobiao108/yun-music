import { getCacheLocations, indexManager, isUsableCacheFile } from './cacheIndex'
import type { CacheFolder } from './cacheIndex'
import { getSongIdCandidates, normalizeSongId } from './cacheNaming'
import { getCacheDir, normalizeCacheUsername, resolveCacheRelativePath } from './cachePaths'
import { isCacheEntryProcessing } from './cacheProgress'

type CacheCheckOptions = {
  // cacheProgress is process-global and is retained for legacy/browser
  // progress reporting. Callers that already have a user-scoped task state
  // can opt out of using it as a cache availability gate.
  ignoreActiveProgress?: boolean
  /** Prefer a target folder when both cache and music contain the song. */
  preferredFolder?: CacheFolder
}

export const checkCache = (
  songInfo: any,
  username?: string,
  isLyricCheck: boolean = false,
  options: CacheCheckOptions = {},
) => {
  try {
    const ids = getSongIdCandidates(songInfo)
    const id = ids[0] || normalizeSongId(songInfo)
    const requestedSource = String(songInfo.source || songInfo.meta?.source || 'unknown')
      .trim()
      .toLowerCase()
    const quality = songInfo.quality || 'unknown'
    const normalizedUsername = normalizeCacheUsername(username)
    const candidateUsernames = normalizedUsername === '_open' ? ['_open'] : [normalizedUsername, '_open']
    const isProcessing = (songId: string, cachedQuality?: string, owner?: string) =>
      !options.ignoreActiveProgress && isCacheEntryProcessing(songId, cachedQuality, owner)

    for (const targetUser of candidateUsernames) {
      // 1. Search by exact ID and Quality (Primary Check)
      // exactQuality=true 时：精确匹配，不允许 fallback 到不同音质
      const useExact = !!songInfo.exactQuality
      const folderTypes: Array<'cache' | 'music'> = options.preferredFolder
        ? [options.preferredFolder, options.preferredFolder === 'cache' ? 'music' : 'cache']
        : ['cache', 'music']
      for (const location of getCacheLocations()) {
        for (const folder of folderTypes) {
          for (const candidateId of ids) {
            const cached = indexManager.get(targetUser, candidateId, folder, quality, useExact, location)
            if (cached) {
              // Legacy indexes used an unprefixed raw ID whenever it contained
              // an underscore. Only accept that alias from the same provider.
              if (
                candidateId !== id &&
                requestedSource !== 'unknown' &&
                String(cached.source || 'unknown')
                  .trim()
                  .toLowerCase() !== requestedSource
              )
                continue
              // 二次校验：exactQuality 模式下确保音质匹配
              if (useExact && quality && cached.quality !== quality) continue
              // 下载完成后还可能进入标签、封面和歌词后处理阶段。此时索引已经
              // 指向最终文件，但文件仍可能被 tagger 原地修改；对外隐藏该条目，
              // 避免播放器读到半成品后误触发换源/降级。
              if (isProcessing(cached.id, cached.quality, targetUser)) continue
              const dir = getCacheDir(targetUser, folder === 'music', location, false)
              const fileName = isLyricCheck ? cached.lyricFilename : cached.filename
              if (!fileName) continue
              const filePath = resolveCacheRelativePath(dir, fileName)
              if (isUsableCacheFile(filePath)) {
                return {
                  exists: true,
                  path: filePath,
                  filename: fileName,
                  foundIn: targetUser,
                  quality: cached.quality,
                  folder: folder,
                  location,
                  url: `/api/music/cache/file/${encodeURIComponent(targetUser)}/${encodeURIComponent(fileName)}?folder=${folder}&location=${encodeURIComponent(location)}`,
                }
              } else {
                // Stale index entry, cleanup only in the location that was checked.
                if (!isLyricCheck) indexManager.remove(targetUser, cached.id, folder, cached.quality, location)
              }
            }
          }
        }
      }

      // 2. Search for Naming Collisions (Same Name + Singer + Quality, but different ID)
      for (const location of getCacheLocations()) {
        const allItems = [
          ...indexManager.getAll(targetUser, 'cache', location),
          ...indexManager.getAll(targetUser, 'music', location),
        ]

        const collision = allItems.find(
          item =>
            !ids.includes(item.id) && // 排除当前正在查询的所有 ID 变体
            item.name.toLowerCase() === String(songInfo.name || '').toLowerCase() &&
            item.singer.toLowerCase() === String(songInfo.singer || '').toLowerCase() &&
            item.quality === quality &&
            (!isLyricCheck || item.hasLyric),
        )

        if (collision) {
          if (isProcessing(collision.id, collision.quality, targetUser)) continue
          const collisionDir = getCacheDir(targetUser, collision.folder === 'music', location, false)
          const collisionFileName = (isLyricCheck ? collision.lyricFilename : collision.filename) || ''
          const collisionFilePath = collisionFileName ? resolveCacheRelativePath(collisionDir, collisionFileName) : null
          if (collisionFileName && isUsableCacheFile(collisionFilePath)) {
            const requestedSource = String(songInfo.source || songInfo.meta?.source || '')
              .trim()
              .toLowerCase()
            const cachedSource = String(collision.source || '')
              .trim()
              .toLowerCase()
            const sameAlbum =
              Boolean(songInfo.albumName || songInfo.meta?.albumName) &&
              Boolean(collision.albumName) &&
              String(songInfo.albumName || songInfo.meta?.albumName || '')
                .trim()
                .toLowerCase() === String(collision.albumName).trim().toLowerCase()
            const parseDuration = (value: unknown) => {
              const text = String(value || '').trim()
              if (!text) return 0
              if (text.includes(':')) {
                const parts = text.split(':').map(Number)
                if (parts.every(Number.isFinite)) return parts.reduce((total, part) => total * 60 + part, 0)
              }
              const seconds = Number(text)
              return Number.isFinite(seconds) ? seconds : 0
            }
            const requestedDuration = parseDuration(songInfo.interval || songInfo.meta?.interval)
            const cachedDuration = parseDuration(collision.interval)
            const sameDuration =
              requestedDuration > 0 && cachedDuration > 0 && Math.abs(requestedDuration - cachedDuration) <= 3
            const sameSourceMetadata =
              requestedSource && cachedSource && requestedSource === cachedSource && (sameAlbum || sameDuration)

            return {
              exists: true,
              isCollision: !sameSourceMetadata,
              matchedBy: sameSourceMetadata ? 'metadata' : 'name_singer_quality',
              collisionSource: collision.source,
              collisionSongmid: collision.songmid,
              filename: collisionFileName,
              path: collisionFilePath,
              url: `/api/music/cache/file/${encodeURIComponent(targetUser)}/${encodeURIComponent(collisionFileName)}?folder=${collision.folder}&location=${encodeURIComponent(location)}`,
              quality: collision.quality,
              foundIn: targetUser,
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
            for (const candidateId of ids) {
              const cachedAny = indexManager.get(targetUser, candidateId, folder, undefined, false, location)
              if (cachedAny) {
                if (isProcessing(cachedAny.id, cachedAny.quality, targetUser)) continue
                const dir = getCacheDir(targetUser, folder === 'music', location, false)
                const fileName = cachedAny.filename
                const filePath = resolveCacheRelativePath(dir, fileName)
                if (isUsableCacheFile(filePath)) {
                  return {
                    exists: true,
                    path: filePath,
                    filename: fileName,
                    foundIn: targetUser,
                    quality: cachedAny.quality,
                    folder: folder,
                    location,
                    url: `/api/music/cache/file/${encodeURIComponent(targetUser)}/${encodeURIComponent(fileName)}?folder=${folder}&location=${encodeURIComponent(location)}`,
                  }
                }
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
