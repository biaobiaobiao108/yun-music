import fs from 'node:fs'

const MAX_LOG_TAIL_BYTES = 4 * 1024 * 1024

export const readLogTail = async (filePath: string, lineLimit: number): Promise<string[]> => {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    let offset = stats.size
    let bytesReadTotal = 0
    let newlineCount = 0
    const chunks: Buffer[] = []

    while (offset > 0 && bytesReadTotal < MAX_LOG_TAIL_BYTES) {
      const chunkSize = Math.min(64 * 1024, offset, MAX_LOG_TAIL_BYTES - bytesReadTotal)
      offset -= chunkSize
      const chunk = Buffer.allocUnsafe(chunkSize)
      const result = await handle.read(chunk, 0, chunkSize, offset)
      const actualChunk = chunk.subarray(0, result.bytesRead)
      chunks.unshift(actualChunk)
      bytesReadTotal += result.bytesRead
      for (const byte of actualChunk) if (byte === 10) newlineCount += 1
      if (newlineCount >= lineLimit) break
    }

    const content = Buffer.concat(chunks).toString('utf8')
    return content.split('\n').filter(Boolean).slice(-lineLimit)
  } finally {
    await handle.close()
  }
}
