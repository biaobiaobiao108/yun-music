import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { temporaryFileStream } from '@/server/temporaryFileStream'

test('temporary downloads wait for a consumer and remove the file on completion or cancellation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-download-stream-'))
  try {
    const filePath = path.join(directory, 'backup.zip')
    fs.writeFileSync(filePath, 'backup bytes')
    const stream = temporaryFileStream(filePath)
    await Bun.sleep(10)
    // Eagerly draining the old stream deleted the file before any consumer read it.
    expect(fs.existsSync(filePath)).toBe(true)
    expect(await new Response(stream).text()).toBe('backup bytes')
    expect(fs.existsSync(filePath)).toBe(false)
    fs.writeFileSync(filePath, 'cancelled backup')
    await temporaryFileStream(filePath).cancel('download cancelled')
    expect(fs.existsSync(filePath)).toBe(false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
