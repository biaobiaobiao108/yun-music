import fs from 'node:fs'
import http from 'node:http'
import { Readable, Transform, pipeline } from 'node:stream'
import { memoryMaintenance } from '../memoryMaintenance'

/** Own the slot through downstream consumption, including small prefetched responses. */
const completeWhenConsumed = (
  stream: ReadableStream<Uint8Array>,
  onFinished: () => void,
): ReadableStream<Uint8Array> => {
  const reader = stream.getReader()
  let finished = false
  let cancelled = false
  const finish = () => {
    if (finished) return
    finished = true
    reader.releaseLock()
    onFinished()
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (cancelled) return
          if (done) {
            controller.close()
            finish()
          } else controller.enqueue(value)
        } catch (error) {
          if (!cancelled) controller.error(error)
          finish()
        }
      },
      async cancel(reason) {
        cancelled = true
        try {
          await reader.cancel(reason)
        } finally {
          finish()
        }
      },
    },
    { highWaterMark: 0 },
  )
}

/** Read tagged files on downstream demand and release resources only after the file handle closes. */
export const createTempFileResponseStream = (tempPath: string, onFinished: () => void): ReadableStream => {
  const source = fs.createReadStream(tempPath, { highWaterMark: 64 * 1024 })
  let closed = false
  let consumed = false
  let finished = false
  const finish = () => {
    if (!closed || !consumed || finished) return
    finished = true
    onFinished()
    memoryMaintenance.schedule('tagged media response end')
  }
  source.once('error', () => {
    consumed = true
  })
  source.once('close', () => {
    closed = true
    finish()
  })
  const stream = Readable.toWeb(source, {
    strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
  }) as unknown as ReadableStream<Uint8Array>
  return completeWhenConsumed(stream, () => {
    consumed = true
    finish()
  })
}

/** Keep upstream buffers bounded by downstream demand; cancellation tears down the whole pipeline. */
export const createProxyResponseStream = (
  source: Readable,
  request: http.ClientRequest,
  maxBytes: number,
  onFinished?: () => void,
  consumeBytes?: (byteCount: number) => boolean,
): ReadableStream => {
  let received = 0
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    onFinished?.()
    memoryMaintenance.schedule('media relay end')
  }
  const limited = new Transform({
    highWaterMark: 64 * 1024,
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > maxBytes) callback(new Error('Remote file is too large'))
      else if (consumeBytes && !consumeBytes(chunk.byteLength))
        callback(new Error('Download relay bandwidth budget exceeded'))
      else callback(null, chunk)
    },
  })
  const stream = Readable.toWeb(limited, {
    strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength },
  }) as unknown as ReadableStream
  pipeline(source, limited, error => {
    if (error) {
      request.destroy()
      finish()
    }
  })
  return completeWhenConsumed(stream, finish)
}
