import fs from 'node:fs'

export class MultipartUploadTooLargeError extends Error {}

const findBytes = (buffer: Uint8Array, pattern: Uint8Array): number => {
  if (!pattern.length || buffer.length < pattern.length) return -1
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).indexOf(Buffer.from(pattern))
}

const appendBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (!left.length) return right
  if (!right.length) return left
  const result = new Uint8Array(left.length + right.length)
  result.set(left)
  result.set(right, left.length)
  return result
}

/** Extract the first `backup` file part without buffering the multipart body. */
export const writeMultipartBackupToFile = async (
  stream: ReadableStream<Uint8Array>,
  boundary: string,
  destination: string,
  maxBytes: number,
): Promise<number> => {
  const marker = new TextEncoder().encode(`--${boundary}`)
  const separator = new TextEncoder().encode(`\r\n--${boundary}`)
  const headerTerminator = new Uint8Array([13, 10, 13, 10])
  const crlf = new Uint8Array([13, 10])
  const finalMarker = new Uint8Array([45, 45])
  const reader = stream.getReader()
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let state: 'start' | 'suffix' | 'headers' | 'body' | 'done' = 'start'
  let inBackupFile = false
  let backupFieldSeen = false
  let backupBytes = 0
  let fileHandle: fs.promises.FileHandle | undefined
  let failed = false

  const writePart = async (bytes: Uint8Array) => {
    if (!inBackupFile || !bytes.length) return
    backupBytes += bytes.length
    if (backupBytes > maxBytes) throw new MultipartUploadTooLargeError('备份文件大小不能超过 100 MB')
    if (!fileHandle) fileHandle = await fs.promises.open(destination, 'w')
    let offset = 0
    while (offset < bytes.length) {
      const result = await fileHandle.write(bytes, offset, bytes.length - offset)
      if (!result.bytesWritten) throw new Error('备份文件写入失败')
      offset += result.bytesWritten
    }
  }

  const processBuffer = async () => {
    let progressed = true
    while (progressed) {
      progressed = false
      if (state === 'start') {
        const index = findBytes(buffer, marker)
        if (index < 0) {
          if (buffer.length > marker.length - 1) buffer = buffer.slice(buffer.length - marker.length + 1)
          continue
        }
        buffer = buffer.slice(index + marker.length)
        state = 'suffix'
        progressed = true
      } else if (state === 'suffix') {
        if (buffer.length >= finalMarker.length && buffer[0] === 45 && buffer[1] === 45) {
          buffer = buffer.slice(2)
          state = 'done'
          progressed = true
        } else if (buffer.length >= crlf.length && buffer[0] === 13 && buffer[1] === 10) {
          buffer = buffer.slice(2)
          state = 'headers'
          progressed = true
        } else if (buffer.length >= 2) {
          throw new Error('multipart 备份格式无效')
        }
      } else if (state === 'headers') {
        const index = findBytes(buffer, headerTerminator)
        if (index < 0) {
          if (buffer.length > 16 * 1024) throw new Error('multipart 文件头过大')
          continue
        }
        const headers = new TextDecoder('latin1').decode(buffer.slice(0, index))
        buffer = buffer.slice(index + headerTerminator.length)
        const disposition = headers.split('\r\n').find(line => /^content-disposition\s*:/i.test(line)) || ''
        const name = disposition.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1]
        const hasFilename = /(?:^|;)\s*filename\s*=/i.test(disposition)
        inBackupFile = name === 'backup' && hasFilename && !backupFieldSeen
        if (name === 'backup') backupFieldSeen = true
        state = 'body'
        progressed = true
      } else if (state === 'body') {
        const index = findBytes(buffer, separator)
        if (index >= 0) {
          const suffixOffset = index + separator.length
          if (buffer.length < suffixOffset + 2) {
            await writePart(buffer.slice(0, index))
            buffer = buffer.slice(index)
          } else if (
            (buffer[suffixOffset] === 45 && buffer[suffixOffset + 1] === 45) ||
            (buffer[suffixOffset] === 13 && buffer[suffixOffset + 1] === 10)
          ) {
            await writePart(buffer.slice(0, index))
            buffer = buffer.slice(suffixOffset)
            inBackupFile = false
            state = 'suffix'
            progressed = true
          } else {
            // A zip may contain the boundary prefix as ordinary bytes. Only
            // treat it as framing when its required CRLF/closing suffix follows.
            await writePart(buffer.slice(0, index + 1))
            buffer = buffer.slice(index + 1)
            progressed = true
          }
        } else if (buffer.length >= separator.length) {
          const safeLength = buffer.length - separator.length + 1
          await writePart(buffer.slice(0, safeLength))
          buffer = buffer.slice(safeLength)
        }
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer = appendBytes(buffer, value)
      await processBuffer()
    }
    await processBuffer()
    if ((state as string) !== 'done') throw new Error('multipart 备份内容不完整')
    return backupBytes
  } catch (error) {
    failed = true
    try {
      await reader.cancel(error)
    } catch {}
    throw error
  } finally {
    reader.releaseLock()
    if (fileHandle) {
      await fileHandle.close()
      if (failed) await fs.promises.unlink(destination).catch(() => {})
    }
  }
}

export const readMultipartBoundary = (contentType: string): string | null => {
  const value = contentType
    .match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i)
    ?.slice(1)
    .find(Boolean)
  if (!value || value.length > 200 || /[\r\n]/.test(value)) return null
  return value
}
