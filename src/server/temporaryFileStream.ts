import fs from 'node:fs'

/** Read only when the consumer asks, and remove the temporary file on every exit path. */
export const temporaryFileStream = (filePath: string): ReadableStream<Uint8Array> => {
  const reader = Bun.file(filePath).stream().getReader()
  let cancelled = false
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    reader.releaseLock()
    try {
      fs.unlinkSync(filePath)
    } catch {}
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (cancelled) return
          if (done) {
            controller.close()
            cleanup()
          } else controller.enqueue(value)
        } catch (error) {
          if (!cancelled) controller.error(error)
          cleanup()
        }
      },
      async cancel(reason) {
        cancelled = true
        try {
          await reader.cancel(reason)
        } finally {
          cleanup()
        }
      },
    },
    { highWaterMark: 0 },
  )
}
