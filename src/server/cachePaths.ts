import fs from 'fs'
import path from 'path'
import { assertSafePathSegment, isPathInside, resolveInside } from '@/utils/pathSecurity'
import { CACHE_ROOTS, currentCacheLocation } from './cacheIndex'

export const getRootPath = (): string => (global.lx as any)?.appPath || (global.lx as any)?.rootPath || process.cwd()

export const assertCachePathInside = (baseDir: string, fullPath: string, message: string): void => {
  const resolvedBaseLexical = path.resolve(baseDir)
  const resolvedFullLexical = path.resolve(fullPath)
  if (!isPathInside(resolvedBaseLexical, resolvedFullLexical)) {
    throw new Error(message)
  }

  // The account directory is a direct child of the cache base. Reject it
  // when it is a symlink: resolving it inside the shared base is not enough,
  // because it may point at another account's directory.
  try {
    if (fs.lstatSync(resolvedFullLexical).isSymbolicLink()) throw new Error(message)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  // When the user directory does not exist yet, compare the nearest existing
  // ancestor with the real base directory. This keeps the symlink boundary
  // check while avoiding the macOS /var -> /private/var false positive.
  if (!fs.existsSync(baseDir)) return
  const resolvedBase = fs.realpathSync.native(baseDir)
  let probe = fullPath
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  const resolvedProbe = fs.realpathSync.native(probe)
  if (!isPathInside(resolvedBase, resolvedProbe)) {
    throw new Error(message)
  }
}

const RESERVED_CACHE_USER_ALIASES = new Set(['default', 'open', '_open'])

export const normalizeCacheUsername = (username?: string): string => {
  if (username === undefined || username === '') return '_open'
  const normalized = assertSafePathSegment(username, 'username')
  if (normalized !== '_open' && RESERVED_CACHE_USER_ALIASES.has(normalized.toLowerCase())) {
    throw new Error('系统保留用户名不能作为私有缓存用户')
  }
  return normalized
}

export const getCacheDir = (username?: string, isOnlyDownload?: boolean, location?: string, create = true) => {
  const folderName = isOnlyDownload ? 'music' : 'cache'
  const loc = location || currentCacheLocation
  let baseDir = ''
  if (loc === CACHE_ROOTS.DATA) {
    const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
    baseDir = path.join(dataPath, folderName)
  } else {
    baseDir = path.join(getRootPath(), folderName)
  }

  const userDirName = normalizeCacheUsername(username)
  const fullPath = path.join(baseDir, userDirName)
  if (create && !fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true, mode: 0o700 })
  }
  assertCachePathInside(baseDir, fullPath, 'Cache directory escapes allowed root')
  return fullPath
}

export const ensureCacheDir = (username?: string, isOnlyDownload?: boolean) => {
  const dir = getCacheDir(username, isOnlyDownload)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

export const resolveCacheRelativePath = (dir: string, filename: string) => {
  try {
    return resolveInside(dir, filename)
  } catch {
    return null
  }
}

export const pathExists = (targetPath: string): boolean => {
  try {
    fs.lstatSync(targetPath)
    return true
  } catch (error: any) {
    return error?.code !== 'ENOENT'
  }
}
