import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as archiver from 'archiver'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { closeDb, createDatabaseSnapshot, getDb, initDatabase } from '@/database'
import {
  createLocalBackup,
  detectArchiveTool,
  LocalBackupTooLargeError,
  MAX_LOCAL_BACKUP_BYTES,
  restoreLocalBackup,
} from '@/server/localBackupService'
import { getUserDirname, syncUsersToDatabase } from '@/user'
import { createSystemRouter } from '@/server/routes/system'
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession } from '@/server/auth'
import { enqueue, removeUser } from '@/server/serverDownloadQueue'
import * as downloadQueue from '@/server/serverDownloadQueue'

const createZip = async (
  entries: Array<{ name: string; content?: string; sourcePath?: string }>,
): Promise<Uint8Array> => {
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

describe('backup archive reader detection', () => {
  test('uses unzip when it can list the supplied ZIP', async () => {
    const calls: string[][] = []
    const result = await detectArchiveTool('/backup.zip', async args => {
      calls.push(args)
      if (args[0] === 'unzip') return 'database/yun-yin.db\n'
      throw new Error('tar should not be needed')
    })

    expect(result).toEqual({ tool: 'unzip', entries: 'database/yun-yin.db\n' })
    expect(calls).toEqual([['unzip', '-Z1', '/backup.zip']])
  })

  test('keeps the ZIP-capable tar fallback used on macOS', async () => {
    const calls: string[][] = []
    const result = await detectArchiveTool('/backup.zip', async args => {
      calls.push(args)
      if (args[0] === 'unzip') throw new Error('unzip is unavailable')
      if (args[0] === 'tar' && args[1] === '-tf') return 'database/yun-yin.db\n'
      throw new Error('unexpected archive command')
    })

    expect(result).toEqual({ tool: 'tar', entries: 'database/yun-yin.db\n' })
    expect(calls).toEqual([
      ['unzip', '-Z1', '/backup.zip'],
      ['tar', '-tf', '/backup.zip'],
    ])
  })

  for (const tarFlavor of ['GNU tar', 'BusyBox tar']) {
    test(`does not mistake ${tarFlavor} version availability for ZIP support`, async () => {
      const calls: string[][] = []
      const runner = async (args: string[]) => {
        calls.push(args)
        if (args[0] === 'unzip') throw new Error('unzip is unavailable')
        if (args[0] === 'tar' && args[1] === '--version') return tarFlavor
        if (args[0] === 'tar' && args[1] === '-tf') throw new Error('not a ZIP archive')
        throw new Error('unexpected archive command')
      }

      await expect(detectArchiveTool('/backup.zip', runner)).rejects.toThrow('可读取 ZIP 备份')
      expect(calls).toEqual([
        ['unzip', '-Z1', '/backup.zip'],
        ['tar', '-tf', '/backup.zip'],
      ])
    })
  }
})

describe('Local backup restore', () => {
  let tempDir = ''
  let dbPath = ''
  let previousLx: typeof global.lx

  beforeEach(async () => {
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
    await syncUsersToDatabase(global.lx.config.users)
  })

  afterEach(() => {
    closeDb()
    global.lx = previousLx
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('restores database and user files while dropping media cache index', async () => {
    const backupDbPath = path.join(tempDir, 'backup-source.db')
    createDatabaseSnapshot(backupDbPath)
    getDb().run(
      'INSERT INTO cache_index (location, user_name, folder, song_id, quality, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['root', 'backup-user', 'cache', 'cached-song', '320k', '{}', Date.now()],
    )
    const archive = await createZip([
      { name: 'database/yun-yin.db', sourcePath: backupDbPath },
      { name: 'config.js', content: 'module.exports = {"serverName":"restored"}\n' },
      { name: `users/${getUserDirname('backup-user')}/marker.txt`, content: 'restored' },
    ])

    const restoredConfig = await restoreLocalBackup(archive)

    expect(restoredConfig).toEqual({ serverName: 'restored' })
    expect(fs.readFileSync(path.join(global.lx.userPath, getUserDirname('backup-user'), 'marker.txt'), 'utf8')).toBe(
      'restored',
    )
    expect(fs.existsSync(path.join(global.lx.userPath, 'old.txt'))).toBe(false)
    expect(getDb().query('SELECT * FROM cache_index').all()).toEqual([])
  })

  test('rejects archive entries that escape the backup root', async () => {
    const archive = await createZip([{ name: '../outside.txt', content: 'nope' }])

    await expect(restoreLocalBackup(archive)).rejects.toThrow('备份文件包含不允许的路径')
    expect(fs.existsSync(path.join(tempDir, 'outside.txt'))).toBe(false)
  })

  test('failed backup configuration persistence restores the original runtime accounts and database', async () => {
    const backupDbPath = path.join(tempDir, 'backup-source.db')
    createDatabaseSnapshot(backupDbPath)
    const archive = await createZip([
      { name: 'database/yun-yin.db', sourcePath: backupDbPath },
      { name: 'config.js', content: 'module.exports = {"serverName":"restored"}\n' },
    ])
    global.lx.config.users = [
      {
        name: 'current-user',
        password: 'current-secret',
        maxSnapshotNum: 3,
        dataPath: path.join(global.lx.userPath, getUserDirname('current-user')),
      },
    ]
    await syncUsersToDatabase(global.lx.config.users, { removeMissing: true })
    const originalUsers = structuredClone(global.lx.config.users)
    let saveAttempts = 0
    global.lx.saveConfig = async () => {
      if (++saveAttempts === 1) {
        // The failure must happen after the restored database has been loaded
        // into memory, so the two account lists actually differ at this point.
        expect(global.lx.config.users.map(user => user.name)).toEqual(['backup-user'])
        throw new Error('simulated config write failure')
      }
    }
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`
    const upload = new FormData()
    upload.append('backup', new Blob([Buffer.from(archive)], { type: 'application/zip' }), 'backup.zip')

    const response = await createSystemRouter().handle(
      new Request('http://localhost/api/backup/upload', {
        method: 'POST',
        headers: { cookie },
        body: upload,
      }),
    )

    expect(response.status).toBe(400)
    expect(saveAttempts).toBe(2)
    expect(global.lx.config.users).toEqual(originalUsers)
    expect(getDb().query('SELECT name FROM users').all()).toEqual([{ name: 'current-user' }])
    expect(fs.readFileSync(path.join(global.lx.userPath, 'old.txt'), 'utf8')).toBe('old')
  })

  test('generated archives stay within the restore limit and can be restored', async () => {
    const archiveName = await createLocalBackup()
    const archivePath = path.join(tempDir, archiveName)
    const archiveBytes = fs.readFileSync(archivePath)

    expect(archiveBytes.byteLength).toBeLessThanOrEqual(MAX_LOCAL_BACKUP_BYTES)
    await expect(restoreLocalBackup(new Uint8Array(archiveBytes))).resolves.toBeDefined()
    fs.rmSync(archivePath, { force: true })
  })

  test('rejects an oversized generated archive and removes the partial ZIP', async () => {
    await expect(createLocalBackup(1)).rejects.toBeInstanceOf(LocalBackupTooLargeError)

    expect(fs.readdirSync(tempDir).filter(name => name.startsWith('yun-yin-backup-'))).toEqual([])
  })

  test('releases the queue suspension and data lock when backup temp directory creation fails', async () => {
    const makeTempDir = spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw new Error('simulated temporary directory failure')
    })
    try {
      await expect(createLocalBackup()).rejects.toThrow('simulated temporary directory failure')
    } finally {
      makeTempDir.mockRestore()
    }

    expect(() => enqueue('backup-failure-user', [{ songInfo: { id: 'after-failure' } }])).not.toThrow()
    await removeUser('backup-failure-user')
    await expect(createLocalBackup()).resolves.toMatch(/^yun-yin-backup-/)
  })

  test('releases the queue suspension and data lock when queue draining fails', async () => {
    const suspend = spyOn(downloadQueue, 'suspendAll').mockImplementationOnce(async () => {
      throw new Error('simulated queue drain failure')
    })
    try {
      await expect(createLocalBackup()).rejects.toThrow('simulated queue drain failure')
    } finally {
      suspend.mockRestore()
    }

    expect(() => enqueue('backup-drain-failure-user', [{ songInfo: { id: 'after-failure' } }])).not.toThrow()
    await removeUser('backup-drain-failure-user')
    await expect(createLocalBackup()).resolves.toMatch(/^yun-yin-backup-/)
  })

  test('restore releases the queue suspension and data lock when queue draining fails', async () => {
    const suspend = spyOn(downloadQueue, 'suspendAll').mockImplementationOnce(async () => {
      throw new Error('simulated restore queue drain failure')
    })
    try {
      await expect(restoreLocalBackup(new Uint8Array([1]))).rejects.toThrow('simulated restore queue drain failure')
    } finally {
      suspend.mockRestore()
    }

    expect(() => enqueue('restore-drain-failure-user', [{ songInfo: { id: 'after-failure' } }])).not.toThrow()
    await removeUser('restore-drain-failure-user')
    await expect(createLocalBackup()).resolves.toMatch(/^yun-yin-backup-/)
  })
})
