import fs from 'fs'

/** Move one file without ever replacing an existing destination. */
export const moveFileNoOverwriteSync = (src: string, dst: string) => {
  try {
    // A hard link is an atomic create-if-absent operation on the same
    // volume, unlike renameSync which replaces an existing destination.
    fs.linkSync(src, dst)
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new Error('目标文件已存在')
    // Cross-device moves and filesystems without hard-link support still
    // use the exclusive flag, which also guarantees no replacement.
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL)
    } catch (copyError: any) {
      if (copyError?.code === 'EEXIST') throw new Error('目标文件已存在')
      throw error
    }
  }

  try {
    fs.unlinkSync(src)
  } catch (error) {
    try {
      fs.unlinkSync(dst)
    } catch {}
    throw error
  }
}

/** Install a fully written staging file without replacing existing user data. */
export const linkFileWithoutOverwrite = (
  sourcePath: string,
  targetPath: string,
  callback: (error: NodeJS.ErrnoException | null) => void,
): void => {
  const copyFallback = () => {
    try {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      fs.unlinkSync(sourcePath)
      callback(null)
    } catch (copyError: any) {
      if (copyError?.code !== 'EEXIST') {
        try {
          fs.unlinkSync(targetPath)
        } catch {}
      }
      callback(copyError)
    }
  }

  fs.link(sourcePath, targetPath, error => {
    if (error) {
      if (error.code === 'EXDEV' || error.code === 'EINVAL') {
        copyFallback()
        return
      }
      callback(error)
      return
    }
    fs.unlink(sourcePath, unlinkError => {
      if (!unlinkError) {
        callback(null)
        return
      }
      fs.unlink(targetPath, cleanupError => {
        if (cleanupError) console.error('[FileCache] Failed to roll back staged file link:', cleanupError)
        callback(unlinkError)
      })
    })
  })
}
