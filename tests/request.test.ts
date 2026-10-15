import { afterEach, describe, expect, test } from 'bun:test'
import { httpFetch } from '@/modules/utils/request'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Upstream request wrapper', () => {
  test('HEAD metadata does not consume the resource body budget', async () => {
    globalThis.fetch = Object.assign(async () => new Response(null, {
      headers: { 'content-length': String(100 * 1024 * 1024) },
    }), { preconnect: originalFetch.preconnect })
    const response = await httpFetch('https://example.test/audio', { method: 'HEAD' }).promise
    expect(response.raw.byteLength).toBe(0)
    expect(response.headers['content-length']).toBe(String(100 * 1024 * 1024))
  })
  test('rejects the public promise when an upstream request fails', async () => {
    globalThis.fetch = Object.assign(async () => {
      throw new Error('upstream failed')
    }, { preconnect: originalFetch.preconnect })

    await expect(httpFetch('https://example.test/failure').promise).rejects.toThrow('upstream failed')
  })

  test('bounds upstream response bodies before retaining them in memory', async () => {
    globalThis.fetch = Object.assign(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), {
      status: 200,
      headers: { 'content-length': '5' },
    }), { preconnect: originalFetch.preconnect })

    await expect(httpFetch('https://example.test/large', { maxBytes: 4 }).promise)
      .rejects.toThrow('Remote response is too large')
  })
})
