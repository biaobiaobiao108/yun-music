import fs from 'node:fs'
import path from 'node:path'
import { assertSafePathSegment, resolveInside } from '@/utils/pathSecurity'

const RESERVED_ALIASES = new Set(['default', 'open', '_open'])

export const getSourceRoot = (): string =>
  path.join(global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data'), 'users', 'source')

export const getSourceDirName = (username?: string): string => {
  if (!username || RESERVED_ALIASES.has(username)) return '_open'
  return assertSafePathSegment(username, 'username')
}

export const getUserSourceDir = (username?: string): string =>
  resolveInside(getSourceRoot(), getSourceDirName(username))

export const moveUserSourceData = (oldName: string, newName: string): boolean => {
  const oldDir = getUserSourceDir(oldName)
  const newDir = getUserSourceDir(newName)
  if (!fs.existsSync(oldDir)) return false
  if (fs.existsSync(newDir)) throw new Error('目标用户的音源目录已存在')
  fs.mkdirSync(path.dirname(newDir), { recursive: true })
  fs.renameSync(oldDir, newDir)
  return true
}

export const removeUserSourceData = (username: string): void => {
  fs.rmSync(getUserSourceDir(username), { recursive: true, force: true })
}
