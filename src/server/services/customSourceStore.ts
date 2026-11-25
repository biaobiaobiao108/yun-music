import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getUserSourceDir } from '@/user/sourceStorage'

const sourceMutationTails = new Map<string, Promise<void>>()

export async function withSourceMutationLock<T>(owner: string, operation: () => Promise<T>): Promise<T> {
  const previous = sourceMutationTails.get(owner) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  sourceMutationTails.set(owner, current)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (sourceMutationTails.get(owner) === current) sourceMutationTails.delete(owner)
  }
}

export async function withSourceMutationLocks<T>(owners: string[], operation: () => Promise<T>): Promise<T> {
  const uniqueOwners = [...new Set(owners)].sort()
  const acquire = async (index: number): Promise<T> => {
    if (index >= uniqueOwners.length) return operation()
    return withSourceMutationLock(uniqueOwners[index], () => acquire(index + 1))
  }
  return acquire(0)
}

export function writeTextFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tempPath, content, 'utf-8')
    fs.renameSync(tempPath, filePath)
  } finally {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath)
      } catch {}
    }
  }
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, JSON.stringify(value, null, 2))
}

export function getSourceDir(username?: string) {
  return getUserSourceDir(username)
}

export function generateId(name?: string, fallbackFilename?: string): string {
  let input = name || fallbackFilename || 'source'

  // 尝试解码，防止输入已经是 URL 编码的状态
  try {
    input = decodeURIComponent(input)
  } catch {
    // 忽略解码错误（例如包含不合法的 % 字符）
  }

  // 如果是路径，只取最后一部分
  let base = path.basename(input)
  if (base.toLowerCase().endsWith('.js')) base = base.slice(0, -3)
  const clean = base.replace(/[\\/:*?"<>|]/g, '_').trim()
  return `${clean || 'source'}.js`
}

export function restoreFile(filePath: string, original: string | null): void {
  if (original === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return
  }
  writeTextFileAtomic(filePath, original)
}

export function readOptionalText(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null
}

export function removeSourceFromOrder(orderPath: string, sourceId: string): void {
  if (!fs.existsSync(orderPath)) return
  const order = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
  if (!Array.isArray(order)) throw new Error('源排序数据格式无效')
  writeJsonFileAtomic(
    orderPath,
    order.filter(id => id !== sourceId),
  )
}
