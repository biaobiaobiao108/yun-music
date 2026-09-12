import * as archiver from 'archiver'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabaseSnapshot } from '@/database'

const safeBackupName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '-')

/**
 * 创建仅供管理员下载的本地备份。
 * 备份包含 SQLite 一致性快照、运行时配置和用户业务文件，不包含媒体缓存与日志。
 */
export const createLocalBackup = async (): Promise<string> => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-local-backup-'))
  const databasePath = path.join(tempDir, 'yun-yin.db')
  const archiveName = `yun-yin-backup-${safeBackupName(timestamp)}.zip`
  const archivePath = path.join(global.lx.dataPath, archiveName)

  try {
    createDatabaseSnapshot(databasePath)

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(archivePath, { flags: 'wx' })
      const archive = new archiver.ZipArchive({ zlib: { level: 9 } })
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }

      output.on('close', () => {
        if (settled) return
        settled = true
        resolve()
      })
      output.on('error', fail)
      archive.on('error', fail)
      archive.pipe(output)
      archive.file(databasePath, { name: 'database/yun-yin.db' })

      const configPath = process.env.CONFIG_PATH || path.join(global.lx.dataPath, 'config.js')
      if (fs.existsSync(configPath)) archive.file(configPath, { name: 'config.js' })

      if (fs.existsSync(global.lx.userPath)) archive.directory(global.lx.userPath, 'users')

      void archive.finalize().catch(fail)
    })

    return archiveName
  } catch (error) {
    if (fs.existsSync(archivePath)) fs.rmSync(archivePath, { force: true })
    throw error
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
