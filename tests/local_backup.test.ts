import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as archiver from 'archiver'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { closeDb, createDatabaseSnapshot, getDb, initDatabase } from '@/database'
import { restoreLocalBackup } from '@/server/localBackupService'
import { getUserDirname, syncUsersToDatabase } from '@/user'

const createZip = async (entries: Array<{ name: string; content?: string; sourcePath?: string }>): Promise<Uint8Array> => {
  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const finished = new Promise<void>((resolve, reject) => {
    output.once('end', resolve)
    output.once('error', reject)
  })
  const archive = new archiver.ZipArchive()
  archive.on('error', rejectArchive)
  function rejectArchive(error: Error): void {
    output.destroy(error)
  }
  archive.pipe(output)
  for (const entry of entries) {
    if (entry.sourcePath) archive.file(entry.sourcePath, { name: entry.name })
    else archive.append(entry.content || '', { name: entry.name })
  }
  void archive.finalize().catch(rejectArchive)
  await finished
  return Buffer.concat(chunks)
}

describe('Local backup restore', () => {
  let tempDir = ''
  let dbPath = ''
  let previousLx: typeof global.lx

  beforeEach(() => {
    previousLx = global.lx
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-local-backup-test-'))
    dbPath = path.join(tempDir, 'yun-yin.db')
    closeDb()
    initDatabase(dbPath)
    global.lx = {
      dataPath: tempDir,
      userPath: path.join(tempDir, 'users'),
      config: {
        users: [{ name: 'backup-user', password: 'secret' }],
        'frontend.password': 'admin-secret',
      },
    } as typeof global.lx
    fs.mkdirSync(global.lx.userPath, { recursive: true })
    fs.writeFileSync(path.join(global.lx.userPath, 'old.txt'), 'old')
    syncUsersToDatabase(global.lx.config.users)
  })

  afterEach(() => {
    closeDb()
    global.lx = previousLx
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('restores database and user files while dropping media cache index', async () => {
    const backupDbPath = path.join(tempDir, 'backup-source.db')
    createDatabaseSnapshot(backupDbPath)
    getDb().run('INSERT INTO cache_index (location, user_name, folder, song_id, quality, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['root', 'backup-user', 'cache', 'cached-song', '320k', '{}', Date.now()])
    const archive = await createZip([
      { name: 'database/yun-yin.db', sourcePath: backupDbPath },
      { name: 'config.js', content: 'module.exports = {"serverName":"restored"}\n' },
      { name: `users/${getUserDirname('backup-user')}/marker.txt`, content: 'restored' },
    ])

    const restoredConfig = await restoreLocalBackup(archive)

    expect(restoredConfig).toEqual({ serverName: 'restored' })
    expect(fs.readFileSync(path.join(global.lx.userPath, getUserDirname('backup-user'), 'marker.txt'), 'utf8')).toBe('restored')
    expect(fs.existsSync(path.join(global.lx.userPath, 'old.txt'))).toBe(false)
    expect(getDb().query('SELECT * FROM cache_index').all()).toEqual([])
  })

  test('rejects archive entries that escape the backup root', async () => {
    const archive = await createZip([{ name: '../outside.txt', content: 'nope' }])

    await expect(restoreLocalBackup(archive)).rejects.toThrow('备份文件包含不允许的路径')
    expect(fs.existsSync(path.join(tempDir, 'outside.txt'))).toBe(false)
  })
})
