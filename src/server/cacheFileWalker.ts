import fs from 'node:fs'
import path from 'node:path'
import { resolveInsideAsync } from '@/utils/pathSecurity'

/** Walk a cache tree without retaining every path in memory. */
export async function* walkCacheFilesAsync(root: string): AsyncGenerator<string> {
  const pendingDirectories = [root]

  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop()!
    let directory: fs.Dir

    try {
      const safeDirectoryPath = await resolveInsideAsync(root, path.relative(root, directoryPath))
      directory = await fs.promises.opendir(safeDirectoryPath)
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error(`[cacheFileWalker] error opening ${directoryPath}:`, error)
      continue
    }

    try {
      for await (const entry of directory) {
        if (entry.isSymbolicLink()) continue

        const fullPath = path.join(directoryPath, entry.name)
        try {
          const safePath = await resolveInsideAsync(root, path.relative(root, fullPath))
          if (entry.isDirectory()) pendingDirectories.push(safePath)
          else if (entry.isFile()) yield safePath
        } catch (error: any) {
          if (error?.code !== 'ENOENT') {
            console.warn(`[cacheFileWalker] skipped path outside cache root: ${fullPath}`)
          }
        }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') console.error(`[cacheFileWalker] error reading ${directoryPath}:`, error)
    }
  }
}
