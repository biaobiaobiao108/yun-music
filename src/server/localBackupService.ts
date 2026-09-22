import * as archiver from 'archiver'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabaseSnapshot, getDb, restoreDatabaseSnapshot } from '@/database'

const safeBackupName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '-')
let backupInProgress = false

export const MAX_LOCAL_BACKUP_BYTES = 100 * 1024 * 1024
const MAX_LOCAL_BACKUP_ENTRIES = 20_000
const MAX_LOCAL_BACKUP_EXTRACTED_BYTES = 512 * 1024 * 1024
const MAX_UNZIP_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_LOCAL_BACKUP_CONFIG_BYTES = 1 * 1024 * 1024

type ArchiveTool = 'unzip' | 'tar'

const detectArchiveTool = (): ArchiveTool => {
  for (const [tool, args] of [
    ['unzip', ['-v']],
    ['tar', ['--version']],
  ] as const) {
    try {
      const result = Bun.spawnSync([tool, ...args])
      if (result.exitCode === 0) return tool
    } catch {
      // Try the next platform-provided archive utility.
    }
  }
  throw new Error('服务器缺少 unzip 或 tar，无法读取备份压缩包')
}

const readLimitedStream = async (stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> => {
  if (!stream) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      total += chunk.byteLength
      if (total > maxBytes) throw new Error('备份工具输出超出限制')
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

const runArchiveCommand = async (args: string[], maxOutputBytes = MAX_UNZIP_OUTPUT_BYTES): Promise<string> => {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const stdoutPromise = readLimitedStream(child.stdout, maxOutputBytes)
  const stderrPromise = readLimitedStream(child.stderr, Math.min(maxOutputBytes, 512 * 1024))
  const settled = await Promise.allSettled([stdoutPromise, stderrPromise, child.exited])
  const stdoutResult = settled[0]
  const stderrResult = settled[1]
  const exitResult = settled[2]
  if (stdoutResult.status === 'rejected') {
    if (!child.killed) child.kill('SIGKILL')
    await child.exited.catch(() => 1)
    throw stdoutResult.reason
  }
  if (stderrResult.status === 'rejected') {
    if (!child.killed) child.kill('SIGKILL')
    await child.exited.catch(() => 1)
    throw stderrResult.reason
  }
  if (exitResult.status === 'rejected') throw exitResult.reason
  const stdout = new TextDecoder().decode(stdoutResult.value)
  const stderr = new TextDecoder().decode(stderrResult.value)
  if (exitResult.value !== 0) {
    throw new Error(stderr.trim().slice(0, 512) || '备份压缩包无法读取')
  }
  return stdout
}

const isAllowedBackupEntry = (rawName: string): boolean => {
  const name = rawName.replaceAll('\\', '/').trim()
  if (!name || name.startsWith('/') || name.includes('\u0000')) return false
  const withoutTrailingSlash = name.endsWith('/') ? name.slice(0, -1) : name
  if (!withoutTrailingSlash) return true
  const segments = withoutTrailingSlash.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false
  return withoutTrailingSlash === 'config.js'
    || withoutTrailingSlash === 'database'
    || withoutTrailingSlash === 'database/yun-yin.db'
    || withoutTrailingSlash === 'users'
    || withoutTrailingSlash.startsWith('users/')
}

const validateBackupEntries = (listing: string): string[] => {
  const rawEntries = listing.split(/\r?\n/).filter(entry => entry.trim())
  const entries = rawEntries.map(entry => entry.trim())
  if (entries.length === 0 || entries.length > MAX_LOCAL_BACKUP_ENTRIES) {
    throw new Error('备份文件条目数量超出限制')
  }
  const seen = new Set<string>()
  for (let index = 0; index < entries.length; index++) {
    const rawEntry = rawEntries[index]
    const entry = entries[index]
    if (rawEntry !== entry || entry.includes('\\') || entry.includes('*') || entry.includes('?') || /[\[\]]/.test(entry)) {
      throw new Error('备份文件包含不允许的路径')
    }
    if (Buffer.byteLength(entry, 'utf8') > 1024) throw new Error('备份文件路径过长')
    const normalized = entry
    if (!isAllowedBackupEntry(normalized)) throw new Error('备份文件包含不允许的路径')
    const key = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
    if (seen.has(key)) throw new Error('备份文件包含重复条目')
    seen.add(key)
  }
  return entries
}

const validateBackupEntryTypes = (listing: string): void => {
  // Info-ZIP exposes Unix symlinks as lrwxrwxrwx. We extract entries one by
  // one below, but rejecting them explicitly also prevents restoring a
  // symlink as an unexpected regular file.
  if (listing.split(/\r?\n/).some(line => /^\s*l[-rwx]{9}\s/.test(line))) {
    throw new Error('备份文件不允许包含符号链接')
  }
}

const waitForDrain = (output: fs.WriteStream): Promise<void> => new Promise((resolve, reject) => {
  const cleanup = () => {
    output.removeListener('drain', onDrain)
    output.removeListener('error', onError)
  }
  const onDrain = () => { cleanup(); resolve() }
  const onError = (error: Error) => { cleanup(); reject(error) }
  output.once('drain', onDrain)
  output.once('error', onError)
})

const finishWrite = (output: fs.WriteStream): Promise<void> => new Promise((resolve, reject) => {
  const onFinish = () => { cleanup(); resolve() }
  const onError = (error: Error) => { cleanup(); reject(error) }
  const cleanup = () => {
    output.removeListener('finish', onFinish)
    output.removeListener('error', onError)
  }
  output.once('finish', onFinish)
  output.once('error', onError)
  output.end()
})

const extractBackupEntry = async (
  archiveTool: ArchiveTool,
  archivePath: string,
  entry: string,
  destination: string,
  maxBytes: number,
): Promise<number> => {
  const command = archiveTool === 'unzip'
    ? ['unzip', '-p', archivePath, entry]
    : ['tar', '-xOf', archivePath, entry]
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const stderrPromise = readLimitedStream(child.stderr, 512 * 1024)
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  let outputError: Error | null = null
  const onOutputError = (error: Error) => {
    outputError ||= error
    if (!child.killed) child.kill('SIGKILL')
  }
  output.on('error', onOutputError)
  const reader = child.stdout?.getReader()
  let total = 0
  try {
    if (!reader) throw new Error('备份文件无法读取')
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      total += chunk.byteLength
      if (total > maxBytes) {
        if (!child.killed) child.kill('SIGKILL')
        throw new Error('备份解压后的数据量超出限制')
      }
      if (outputError) throw outputError
      if (!output.write(Buffer.from(chunk))) await waitForDrain(output)
    }
    reader.releaseLock()
    if (outputError) throw outputError
    await finishWrite(output)
    if (outputError) throw outputError
    const [stderrBytes, exitCode] = await Promise.all([stderrPromise, child.exited])
    if (exitCode !== 0) {
      throw new Error(new TextDecoder().decode(stderrBytes).trim().slice(0, 512) || '备份条目无法读取')
    }
    return total
  } catch (error) {
    try { reader?.releaseLock() } catch { }
    if (!child.killed) child.kill('SIGKILL')
    await Promise.allSettled([stderrPromise, child.exited])
    output.destroy()
    try { fs.unlinkSync(destination) } catch { }
    throw error
  } finally {
    output.removeListener('error', onOutputError)
  }
}

const extractBackupEntries = async (
  archiveTool: ArchiveTool,
  archivePath: string,
  extractDir: string,
  entries: string[],
): Promise<void> => {
  let extractedBytes = 0
  const root = path.resolve(extractDir)
  for (const entry of entries) {
    const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry
    if (!normalized) continue
    const destination = path.resolve(root, ...normalized.split('/'))
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
      throw new Error('备份文件包含不允许的路径')
    }
    if (entry.endsWith('/')) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
      continue
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    extractedBytes += await extractBackupEntry(
      archiveTool,
      archivePath,
      entry,
      destination,
      MAX_LOCAL_BACKUP_EXTRACTED_BYTES - extractedBytes,
    )
    if (extractedBytes > MAX_LOCAL_BACKUP_EXTRACTED_BYTES) {
      throw new Error('备份解压后的数据量超出限制')
    }
  }
}

const scanExtractedTree = (root: string): void => {
  let fileCount = 0
  let totalBytes = 0
  const directories = [root]
  while (directories.length > 0) {
    const directory = directories.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('备份文件不允许包含符号链接')
      if (entry.isDirectory()) {
        directories.push(fullPath)
        continue
      }
      if (!entry.isFile()) throw new Error('备份文件包含不支持的文件类型')
      fileCount++
      if (fileCount > MAX_LOCAL_BACKUP_ENTRIES) throw new Error('备份文件条目数量超出限制')
      totalBytes += fs.statSync(fullPath).size
      if (totalBytes > MAX_LOCAL_BACKUP_EXTRACTED_BYTES) throw new Error('备份解压后的数据量超出限制')
    }
  }
}

const parseBackupConfig = (configPath: string): Record<string, unknown> => {
  if (!fs.existsSync(configPath)) return {}
  const configSize = fs.statSync(configPath).size
  if (configSize > MAX_LOCAL_BACKUP_CONFIG_BYTES) throw new Error('备份配置文件过大')
  const source = fs.readFileSync(configPath, 'utf8').trim()
  const prefix = 'module.exports ='
  if (!source.startsWith(prefix)) throw new Error('备份配置格式不兼容')
  const json = source.slice(prefix.length).trim().replace(/;\s*$/, '').trim()
  const parsed = JSON.parse(json)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('备份配置格式不兼容')
  return parsed as Record<string, unknown>
}

const createBackupConfig = (): string => {
  const config: Record<string, any> = { ...(global.lx.config || {}), users: [] }
  // Backups may be copied outside the host; never package reusable secrets.
  delete config['frontend.password']
  delete config['frontend.passwordHash']
  delete config['player.password']
  delete config['player.passwordHash']
  const proxyAddress = config['proxy.all.address']
  if (typeof proxyAddress === 'string' && proxyAddress) {
    try {
      const url = new URL(proxyAddress)
      url.username = ''
      url.password = ''
      // Proxy credentials are also commonly placed in query parameters or
      // fragments; neither should leave the host in a portable backup.
      url.search = ''
      url.hash = ''
      config['proxy.all.address'] = url.toString()
    } catch {
      delete config['proxy.all.address']
    }
  }
  return `module.exports = ${JSON.stringify(config, null, 2)}\n`
}

/**
 * 创建仅供管理员下载的本地备份。
 * 备份包含 SQLite 一致性快照、运行时配置和用户业务文件，不包含媒体缓存与日志。
 */
export const createLocalBackup = async (): Promise<string> => {
  if (backupInProgress) throw new Error('备份任务正在进行中，请稍后重试')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-local-backup-'))
  backupInProgress = true
  const databasePath = path.join(tempDir, 'yun-yin.db')
  const archiveName = `yun-yin-backup-${safeBackupName(timestamp)}.zip`
  const archivePath = path.join(global.lx.dataPath, archiveName)

  try {
    createDatabaseSnapshot(databasePath)

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
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

      const backupConfigPath = path.join(tempDir, 'config.js')
      fs.writeFileSync(backupConfigPath, createBackupConfig(), { mode: 0o600 })
      archive.file(backupConfigPath, { name: 'config.js' })

      if (fs.existsSync(global.lx.userPath)) archive.directory(global.lx.userPath, 'users')

      void archive.finalize().catch(fail)
    })

    return archiveName
  } catch (error) {
    if (fs.existsSync(archivePath)) fs.rmSync(archivePath, { force: true })
    throw error
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
    backupInProgress = false
  }
}

/**
 * 校验并恢复本地全量备份。
 * ZIP 只允许包含本服务生成的 database/config/users 路径；媒体缓存不在
 * 备份范围内，因此恢复后清空 cache_index，避免索引指向不存在的旧文件。
 */
export interface LocalBackupRestoreOptions {
  /** Run while the restored database/files are installed; a thrown error rolls everything back. */
  onRestored?: (config: Record<string, unknown>) => void | Promise<void>
}

export const restoreLocalBackup = async (
  archiveData: Uint8Array,
  options: LocalBackupRestoreOptions = {},
): Promise<Record<string, unknown>> => {
  if (archiveData.byteLength === 0 || archiveData.byteLength > MAX_LOCAL_BACKUP_BYTES) {
    throw new Error('备份文件大小超出限制')
  }

  if (backupInProgress) throw new Error('备份任务正在进行中，请稍后重试')
  backupInProgress = true
  let tempDir = ''
  let previousDbPath = ''
  let previousUsersPath = ''
  let previousUsersMoved = false
  let restoredUsersInstalled = false
  let databaseRestored = false

  try {
    tempDir = fs.mkdtempSync(path.join(global.lx.dataPath, '.lx-backup-'))
    const archivePath = path.join(tempDir, 'upload.zip')
    const extractDir = path.join(tempDir, 'extracted')
    previousDbPath = path.join(tempDir, 'previous.db')
    previousUsersPath = path.join(tempDir, 'previous-users')
    fs.writeFileSync(archivePath, archiveData, { mode: 0o600 })
    const archiveTool = detectArchiveTool()
    const entriesListing = archiveTool === 'unzip'
      ? await runArchiveCommand(['unzip', '-Z1', archivePath])
      : await runArchiveCommand(['tar', '-tf', archivePath])
    const detailedListing = archiveTool === 'unzip'
      ? await runArchiveCommand(['unzip', '-Z', '-l', archivePath])
      : await runArchiveCommand(['tar', '-tvf', archivePath])
    const entries = validateBackupEntries(entriesListing)
    validateBackupEntryTypes(detailedListing)
    fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 })
    await extractBackupEntries(archiveTool, archivePath, extractDir, entries)
    scanExtractedTree(extractDir)

    const databasePath = path.join(extractDir, 'database', 'yun-yin.db')
    if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
      throw new Error('备份缺少数据库快照')
    }
    const restoredConfig = parseBackupConfig(path.join(extractDir, 'config.js'))

    createDatabaseSnapshot(previousDbPath)
    if (fs.existsSync(global.lx.userPath)) {
      fs.renameSync(global.lx.userPath, previousUsersPath)
      previousUsersMoved = true
    }

    const restoredUsersPath = path.join(extractDir, 'users')
    if (fs.existsSync(restoredUsersPath)) fs.renameSync(restoredUsersPath, global.lx.userPath)
    else fs.mkdirSync(global.lx.userPath, { recursive: true, mode: 0o700 })
    restoredUsersInstalled = true

    restoreDatabaseSnapshot(databasePath)
    databaseRestored = true
    getDb().run('DELETE FROM cache_index')
    await options.onRestored?.(restoredConfig)
    return restoredConfig
  } catch (error) {
    if (databaseRestored && fs.existsSync(previousDbPath)) {
      try { restoreDatabaseSnapshot(previousDbPath) } catch (rollbackError) {
        console.error('[Backup] 数据库恢复回滚失败:', rollbackError)
      }
    }
    if (restoredUsersInstalled && fs.existsSync(global.lx.userPath)) {
      try { fs.rmSync(global.lx.userPath, { recursive: true, force: true }) } catch { }
    }
    if (previousUsersMoved && fs.existsSync(previousUsersPath)) {
      try { fs.renameSync(previousUsersPath, global.lx.userPath) } catch (rollbackError) {
        console.error('[Backup] 用户目录恢复回滚失败:', rollbackError)
      }
    }
    throw error
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    backupInProgress = false
  }
}
