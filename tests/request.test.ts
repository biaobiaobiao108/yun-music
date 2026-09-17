import { afterEach, describe, expect, test } from 'bun:test'
import { httpFetch } from '@/modules/utils/request'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Upstream request wrapper', () => {
  test('rejects the public promise when an upstream request fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('upstream failed')
    }) as typeof fetch

    await expect(httpFetch('https://example.test/failure').promise).rejects.toThrow('upstream failed')
  })

  test('bounds upstream response bodies before retaining them in memory', async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      status: 200,
      headers: { 'content-length': '5' },
    })) as typeof fetch

    await expect(httpFetch('https://example.test/large', { maxBytes: 4 }).promise)
      .rejects.toThrow('Remote response is too large')
  })
})
