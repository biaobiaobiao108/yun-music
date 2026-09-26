import fs from 'node:fs'
import path from 'node:path'

const isMissingPathError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Validate a value that will be used as one filesystem path segment. */
export const assertSafePathSegment = (value: unknown, label = 'path segment'): string => {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..') {
    throw new Error(`Invalid ${label}`)
  }
  if (value.length > 128 || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  if (value.includes('/') || value.includes('\\') || path.isAbsolute(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

export const isPathInside = (root: string, target: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Resolve a path and also protect against symlink escapes where possible. */
export const resolveInside = (root: string, ...parts: string[]): string => {
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, ...parts)
  if (!isPathInside(resolvedRoot, candidate)) throw new Error('Path escapes allowed directory')

  const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync.native(resolvedRoot) : resolvedRoot
  // Resolve the nearest existing ancestor. Checking only the direct parent
  // misses a symlink when multiple child directories do not exist yet.
  let probe = candidate
  while (probe !== resolvedRoot) {
    try {
      const realProbe = fs.realpathSync.native(probe)
      if (!isPathInside(realRoot, realProbe)) throw new Error('Path escapes allowed directory')
      return candidate
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  return candidate
}

/** Async counterpart for read-only request paths; avoids blocking the event loop on realpath checks. */
export const resolveInsideAsync = async (root: string, ...parts: string[]): Promise<string> => {
  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, ...parts)
  if (!isPathInside(resolvedRoot, candidate)) throw new Error('Path escapes allowed directory')

  let realRoot = resolvedRoot
  try {
    realRoot = await fs.promises.realpath(resolvedRoot)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }

  // If the target does not exist yet, validate the nearest existing ancestor.
  // Stop at the lexical root so callers can still create a previously missing root.
  let probe = candidate
  while (probe !== resolvedRoot) {
    try {
      const realProbe = await fs.promises.realpath(probe)
      if (!isPathInside(realRoot, realProbe)) throw new Error('Path escapes allowed directory')
      return candidate
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }

  return candidate
}
