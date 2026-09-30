import { describe, expect, spyOn, test } from 'bun:test'
import dns from 'node:dns/promises'
import http from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { assertSafeRemoteHttpUrl, fetchSafeRemote, type SafeRemoteHttpUrl } from '@/server/networkSecurity'
import { createCacheRouter } from '@/server/routes/cache'

describe('Outbound URL network boundaries', () => {
  test.each([
    '127.0.0.1', '10.0.0.1', '169.254.169.254',
    '[::1]', '[0:0:0:0:0:0:0:1]', '[fc00::1]', '[fe80::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:FFFF:7F00:1]',
    '[::ffff:10.0.0.1]', '[::ffff:192.168.1.1]', '[::ffff:169.254.169.254]',
  ])('rejects private address %s', async (host) => {
    await expect(assertSafeRemoteHttpUrl(`http://${host}/audio`)).rejects.toThrow('Private network URL is not allowed')
  })

  test.each(['8.8.8.8', '[2001:4860:4860::8888]', '[::ffff:8.8.8.8]'])('allows public literal %s', async (host) => {
    expect((await assertSafeRemoteHttpUrl(`https://${host}/audio`)).protocol).toBe('https:')
  })

  test('rejects mapped private DNS results, including dotted and expanded forms', async () => {
    const lookup = spyOn(dns, 'lookup')
    try {
      for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:c0a8:101']) {
        lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address, family: 6 }] as any)
        await expect(assertSafeRemoteHttpUrl('https://example.com/audio')).rejects.toThrow('Private network URL is not allowed')
      }
    } finally {
      lookup.mockRestore()
    }
  })

  test('retains hostname-based synthetic DNS support while rejecting private or literal targets', async () => {
    const lookup = spyOn(dns, 'lookup')
    try {
      lookup.mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as any)
      expect((await assertSafeRemoteHttpUrl('https://example.com/audio')).hostname).toBe('example.com')
      await expect(assertSafeRemoteHttpUrl('http://198.18.0.1/audio')).rejects.toThrow('Private network URL is not allowed')
      lookup.mockResolvedValue([{ address: 'fdfe:dcba:9876::1', family: 6 }] as any)
      expect((await assertSafeRemoteHttpUrl('https://example.com/audio')).hostname).toBe('example.com')
      lookup.mockResolvedValue([
        { address: '198.18.0.34', family: 4 },
        { address: '2001:2::21', family: 6 },
      ] as any)
      expect((await assertSafeRemoteHttpUrl('https://example.com/audio')).hostname).toBe('example.com')

      lookup.mockResolvedValue([{ address: '198.18.0.1', family: 4 }, { address: '192.168.1.1', family: 4 }] as any)
      await expect(assertSafeRemoteHttpUrl('https://example.com/audio')).rejects.toThrow('Private network URL is not allowed')

      lookup.mockResolvedValue([
        { address: '::ffff:0:c612:56', family: 6 },
        { address: '198.18.0.86', family: 4 },
      ] as any)
      const syntheticUrl = await assertSafeRemoteHttpUrl('https://example.com/audio')
      const connectedAddress = await new Promise(resolve => syntheticUrl.lookup(
        'example.com',
        {},
        (_error: any, address: string) => resolve(address),
      ))
      expect(connectedAddress).toBe('198.18.0.86')
    } finally {
      lookup.mockRestore()
    }
  })

  test('anonymous download proxy blocks mapped loopback before opening an outbound request', async () => {
    const request = spyOn(http, 'request').mockImplementation(() => { throw new Error('Unexpected outbound request') })
    try {
      const router = createCacheRouter()
      const response = await router.handle(new Request('http://localhost/api/music/download?url='
        + encodeURIComponent('http://[::ffff:127.0.0.1]:9527/')))
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(request).not.toHaveBeenCalled()
    } finally {
      request.mockRestore()
    }
  })

  test('connection lookup retains validated addresses even after DNS changes', async () => {
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any)
    try {
      const url = await assertSafeRemoteHttpUrl('https://example.com/audio')
      lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any)
      const resolveConnection = (hostname: string, options: any) => new Promise((resolve, reject) => {
        url.lookup(hostname, options, (error, address, family) => error ? reject(error) : resolve({ address, family }))
      })
      expect(await resolveConnection('example.com', { all: true })).toEqual({ address: [{ address: '8.8.8.8', family: 4 }], family: undefined })
      expect(await resolveConnection('example.com', { family: 4 })).toEqual({ address: '8.8.8.8', family: 4 })
      await expect(resolveConnection('another.example', {})).rejects.toThrow('No validated address')
      await expect(resolveConnection('example.com', { family: 6 })).rejects.toThrow('No validated address')
      expect(lookup).toHaveBeenCalledTimes(1)
      expect(url.hostname).toBe('example.com')
    } finally {
      lookup.mockRestore()
    }
  })

  test('download proxy passes the pinned lookup to the transport', async () => {
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any)
    let options: any
    const request = spyOn(http, 'request').mockImplementation((_url, requestOptions) => {
      options = requestOptions
      throw new Error('Transport intercepted by test')
    })
    try {
      await createCacheRouter().handle(new Request('http://localhost/api/music/download?url=http%3A%2F%2Fexample.com%2Faudio'))
      expect(options.agent).toMatchObject({ keepAlive: true, maxSockets: 8 })
      const connectedAddress = await new Promise(resolve => options.lookup('example.com', {}, (_error: any, address: string) => resolve(address)))
      expect(connectedAddress).toBe('8.8.8.8')
    } finally {
      request.mockRestore()
      lookup.mockRestore()
    }
  })
})


describe('Bounded remote response transport', () => {
  const withServer = async (
    handler: http.RequestListener,
    run: (url: SafeRemoteHttpUrl) => Promise<void>,
  ) => {
    const server = http.createServer(handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as import('node:net').AddressInfo
    // Bypass URL validation only in this transport fixture; production uses
    // assertSafeRemoteHttpUrl to supply the pinned lookup.
    const url = Object.assign(new URL(`http://remote.example:${address.port}/`), {
      lookup: ((_hostname: string, options: any, callback: any) => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
        else callback(null, '127.0.0.1', 4)
      }) as import('node:net').LookupFunction,
    })
    try {
      await run(url)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    }
  }

  test.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
  ] as const)('decodes %s JSON and removes compressed metadata', async (encoding, compress) => {
    const payload = JSON.stringify({ songs: [{ name: '中文歌曲' }] })
    const compressed = compress(Buffer.from(payload))
    await withServer((_request, response) => {
      response.writeHead(200, {
        'content-encoding': encoding,
        'content-length': compressed.byteLength,
        'content-type': 'application/json',
      })
      response.end(compressed)
    }, async url => {
      const response = await fetchSafeRemote(url)
      expect(await response.json()).toEqual(JSON.parse(payload))
      expect(response.headers.has('content-encoding')).toBe(false)
      expect(response.headers.has('content-length')).toBe(false)
    })
  })

  test('rejects decompression expansion beyond the limit', async () => {
    const compressed = gzipSync(Buffer.alloc(1024 * 1024, 'a'))
    expect(compressed.byteLength).toBeLessThan(2048)
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.byteLength })
      response.end(compressed)
    }, async url => {
      await expect(fetchSafeRemote(url, { maxBytes: 2048 })).rejects.toThrow('Remote response is too large')
    })
  })

  test('rejects malformed compressed data', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' })
      response.end('invalid gzip')
    }, async url => {
      await expect(fetchSafeRemote(url)).rejects.toThrow()
    })
  })

  test('HEAD preserves resource length even when it exceeds the body limit', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-length': 100 * 1024 * 1024, 'content-encoding': 'gzip' })
      response.end()
    }, async url => {
      const response = await fetchSafeRemote(url, { method: 'HEAD', maxBytes: 1024 })
      expect(response.body).toBeNull()
      expect(response.headers.get('content-length')).toBe(String(100 * 1024 * 1024))
      expect(response.headers.get('content-encoding')).toBe('gzip')
    })
  })

  test.each([204, 205, 304])('returns status %s without constructing a forbidden body', async status => {
    await withServer((_request, response) => {
      response.writeHead(status)
      response.end()
    }, async url => {
      const response = await fetchSafeRemote(url)
      expect(response.status).toBe(status)
      expect(response.body).toBeNull()
    })
  })

  test('proxy HEAD and no-content statuses preserve null bodies', async () => {
    const fetchMock = spyOn(globalThis, 'fetch')
    try {
      const url = new URL('https://remote.example/') as SafeRemoteHttpUrl
      fetchMock.mockResolvedValue(new Response(null, { headers: { 'content-length': '104857600' } }))
      const head = await fetchSafeRemote(url, { method: 'HEAD', maxBytes: 1024, proxy: 'http://proxy.example' })
      expect(head.body).toBeNull()
      expect(head.headers.get('content-length')).toBe('104857600')
      for (const status of [204, 205, 304]) {
        fetchMock.mockResolvedValue(new Response(null, { status }))
        const response = await fetchSafeRemote(url, { proxy: 'http://proxy.example' })
        expect(response.status).toBe(status)
        expect(response.body).toBeNull()
      }
    } finally {
      fetchMock.mockRestore()
    }
  })
})
