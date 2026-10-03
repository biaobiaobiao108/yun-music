import { describe, expect, test } from 'bun:test'
import { HttpContext } from '@/server/core/context'

describe('HTTP request body buffering budget', () => {
  test('allows concurrent small chunked JSON requests under their route caps', async () => {
    const encoder = new TextEncoder()
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const requests = Array.from({ length: 8 }, (_, index) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controllers[index] = controller },
      })
      const request = new Request('http://localhost/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit)
      return new HttpContext(request).bodyJson<{ index: number }>()
    })

    for (const [index, controller] of controllers.entries()) {
      controller.enqueue(encoder.encode(JSON.stringify({ index })))
      controller.close()
    }

    expect(await Promise.all(requests)).toEqual(Array.from({ length: 8 }, (_, index) => ({ index })))
  })
})
