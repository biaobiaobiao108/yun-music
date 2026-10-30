import { describe, expect, spyOn, test } from 'bun:test'
import dns from 'node:dns/promises'
import http from 'node:http'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import {
  assertSafeRemoteHttpUrl,
  createSafeRemoteProxyAgent,
  fetchSafeRemote,
  type SafeRemoteHttpUrl,
} from '@/server/networkSecurity'
import { createCacheRouter } from '@/server/routes/cache'
import { issueDownloadToken } from '@/server/downloadToken'

describe('Outbound URL network boundaries', () => {
  test.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[fc00::1]',
    '[fe80::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[0:0:0:0:0:FFFF:7F00:1]',
    '[::ffff:10.0.0.1]',
    '[::ffff:192.168.1.1]',
    '[::ffff:169.254.169.254]',
  ])('rejects private address %s', async host => {
    await expect(assertSafeRemoteHttpUrl(`http://${host}/audio`)).rejects.toThrow('Private network URL is not allowed')
  })

  test.each(['8.8.8.8', '[2001:4860:4860::8888]', '[::ffff:8.8.8.8]'])('allows public literal %s', async host => {
    expect((await assertSafeRemoteHttpUrl(`https://${host}/audio`)).protocol).toBe('https:')
  })

  test('rejects mapped private DNS results, including dotted and expanded forms', async () => {
    const lookup = spyOn(dns, 'lookup')
    try {
      for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:c0a8:101']) {
        lookup.mockResolvedValue([
          { address: '8.8.8.8', family: 4 },
          { address, family: 6 },
        ] as any)
        await expect(assertSafeRemoteHttpUrl('https://example.com/audio')).rejects.toThrow(
          'Private network URL is not allowed',
        )
      }
    } finally {
      lookup.mockRestore()
    }
  })

  test('retains hostname-based synthetic DNS support while rejecting private or literal targets', async () => {
    const previousLx = global.lx
    const lookup = spyOn(dns, 'lookup')
    // Fake-ip answers are only meaningful when an outbound proxy is configured.
    global.lx = {
      config: { 'proxy.all.enabled': true, 'proxy.all.address': 'http://proxy.example.com:7890' },
    } as typeof global.lx
    try {
      lookup.mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as any)
      expect((await assertSafeRemoteHttpUrl('https://example.com/audio')).hostname).toBe('example.com')
      await expect(assertSafeRemoteHttpUrl('http://198.18.0.1/audio')).rejects.toThrow(
        'Private network URL is not allowed',
      )
      lookup.mockResolvedValue([{ address: 'fdfe:dcba:9876::1', family: 6 }] as any)
      expect((await assertSafeRemoteHttpUrl('https://example.com/audio')).hostname).toBe('example.com')
      lookup.mockResolvedValue([
        { address: '198.18.0.34', family: 4 },
        { address: '2001:2::21', family: 6 },
      ] as any)
      expect((await assertSafeRemoteHttpUrl('https://example.com/audio')).hostname).toBe('example.com')

      lookup.mockResolvedValue([
        { address: '198.18.0.1', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ] as any)
      await expect(assertSafeRemoteHttpUrl('https://example.com/audio')).rejects.toThrow(
        'Private network URL is not allowed',
      )

      lookup.mockResolvedValue([
        { address: '::ffff:0:c612:56', family: 6 },
        { address: '198.18.0.86', family: 4 },
      ] as any)
      const syntheticUrl = await assertSafeRemoteHttpUrl('https://example.com/audio')
      const connectedAddress = await new Promise<string>((resolve, reject) =>
        syntheticUrl.lookup('example.com', {}, (error, address) => {
          if (error) {
            reject(error)
          } else if (typeof address === 'string') {
            resolve(address)
          } else {
            reject(new Error('Expected a single DNS address'))
          }
        }),
      )
      expect(connectedAddress).toBe('198.18.0.86')
    } finally {
      lookup.mockRestore()
      global.lx = previousLx
    }
  })

  test('rejects fake-ip DNS answers when no outbound proxy is configured', async () => {
    const previousLx = global.lx
    const lookup = spyOn(dns, 'lookup')
    global.lx = { config: { 'proxy.all.enabled': false } } as typeof global.lx
    try {
      lookup.mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as any)
      await expect(assertSafeRemoteHttpUrl('https://example.com/audio')).rejects.toThrow(
        'Private network URL is not allowed',
      )
    } finally {
      lookup.mockRestore()
      global.lx = previousLx
    }
  })

  test('anonymous download proxy blocks mapped loopback before opening an outbound request', async () => {
    const previousLx = global.lx
    global.lx = { config: {} } as typeof global.lx
    const request = spyOn(http, 'request').mockImplementation(() => {
      throw new Error('Unexpected outbound request')
    })
    try {
      const router = createCacheRouter()
      const target = 'http://[::ffff:127.0.0.1]:9527/'
      const response = await router.handle(
        new Request(
          `http://localhost/api/music/download?url=${encodeURIComponent(target)}&token=${issueDownloadToken(target)}`,
        ),
      )
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(request).not.toHaveBeenCalled()
    } finally {
      request.mockRestore()
      global.lx = previousLx
    }
  })

  test('anonymous download proxy requires a signed URL', async () => {
    const previousLx = global.lx
    global.lx = { config: {} } as typeof global.lx
    const request = spyOn(http, 'request').mockImplementation(() => {
      throw new Error('Unexpected outbound request')
    })
    try {
      const router = createCacheRouter()
      const target = 'http://example.com/audio'
      const response = await router.handle(
        new Request(`http://localhost/api/music/download?url=${encodeURIComponent(target)}`),
      )
      expect(response.status).toBe(403)
      expect(request).not.toHaveBeenCalled()
    } finally {
      request.mockRestore()
      global.lx = previousLx
    }
  })

  test('anonymous download proxy applies a sustained per-client request budget', async () => {
    const previousLx = global.lx
    global.lx = { config: {} } as typeof global.lx
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const router = createCacheRouter()
      const remoteAddress = '203.0.113.247'
      const target = 'http://127.0.0.1/audio'
      const url = `http://localhost/api/music/download?url=${encodeURIComponent(target)}&token=${issueDownloadToken(target)}`
      // 中继的请求额度是 1200 条/10 分钟（连续补充），这里跑满一个桶即可。
      let limited = false
      for (let attempt = 0; attempt < 1_500; attempt += 1) {
        const response = await router.handle(new Request(url), { remoteAddress })
        if (response.status === 429) {
          limited = true
          break
        }
      }
      expect(limited).toBe(true)
    } finally {
      errorLog.mockRestore()
      global.lx = previousLx
    }
  })

  test('connection lookup retains validated addresses even after DNS changes', async () => {
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any)
    try {
      const url = await assertSafeRemoteHttpUrl('https://example.com/audio')
      lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any)
      const resolveConnection = (hostname: string, options: any) =>
        new Promise((resolve, reject) => {
          url.lookup(hostname, options, (error, address, family) =>
            error ? reject(error) : resolve({ address, family }),
          )
        })
      expect(await resolveConnection('example.com', { all: true })).toEqual({
        address: [{ address: '8.8.8.8', family: 4 }],
        family: undefined,
      })
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
    const previousLx = global.lx
    global.lx = { config: {} } as typeof global.lx
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as any)
    let options: any
    const request = spyOn(http, 'request').mockImplementation((_url, requestOptions) => {
      options = requestOptions
      throw new Error('Transport intercepted by test')
    })
    try {
      const target = 'http://example.com/audio'
      await createCacheRouter().handle(
        new Request(
          `http://localhost/api/music/download?url=${encodeURIComponent(target)}&token=${issueDownloadToken(target)}`,
        ),
      )
      expect(options.agent).toMatchObject({ keepAlive: true, maxSockets: 8 })
      const connectedAddress = await new Promise(resolve =>
        options.lookup('example.com', {}, (_error: any, address: string) => resolve(address)),
      )
      expect(connectedAddress).toBe('8.8.8.8')
    } finally {
      request.mockRestore()
      lookup.mockRestore()
      global.lx = previousLx
    }
  })

  test('download proxy sends approved fake-IP targets through the configured proxy', async () => {
    const previousLx = global.lx
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as any)
    let options: any
    const request = spyOn(http, 'request').mockImplementation((_url, requestOptions) => {
      options = requestOptions
      throw new Error('Transport intercepted by test')
    })
    global.lx = {
      config: { 'proxy.all.enabled': true, 'proxy.all.address': 'http://proxy.example:7890' },
    } as typeof global.lx
    try {
      const target = 'http://example.com/audio'
      await createCacheRouter().handle(
        new Request(
          `http://localhost/api/music/download?url=${encodeURIComponent(target)}&token=${issueDownloadToken(target)}`,
        ),
      )
      expect(options.agent).toBeInstanceOf(HttpProxyAgent)
      expect(options.lookup).toBeUndefined()
    } finally {
      global.lx = previousLx
      request.mockRestore()
      lookup.mockRestore()
    }
  })

  test('creates secure and remote-DNS proxy agents for their target protocols', () => {
    const previousLx = global.lx
    const safeUrl = (rawUrl: string) =>
      Object.assign(new URL(rawUrl), {
        lookup: (() => undefined) as any,
        proxyTargetResolutionSafe: true,
      }) as SafeRemoteHttpUrl
    try {
      global.lx = {
        config: { 'proxy.all.enabled': true, 'proxy.all.address': 'http://proxy.example:7890' },
      } as typeof global.lx
      const httpsAgent = createSafeRemoteProxyAgent(safeUrl('https://example.com/audio'))
      expect(httpsAgent).toBeInstanceOf(HttpsProxyAgent)
      httpsAgent?.destroy()

      global.lx.config['proxy.all.address'] = 'socks5://proxy.example:1080'
      const socksAgent = createSafeRemoteProxyAgent(safeUrl('https://example.com/audio'))
      expect(socksAgent).toBeInstanceOf(SocksProxyAgent)
      expect((socksAgent as SocksProxyAgent).shouldLookup).toBe(false)
      socksAgent?.destroy()
    } finally {
      global.lx = previousLx
    }
  })
})

describe('Bounded remote response transport', () => {
  const withServer = async (handler: http.RequestListener, run: (url: SafeRemoteHttpUrl) => Promise<void>) => {
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
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    }
  }

  test.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('decodes %s JSON and removes compressed metadata', async (encoding, compress) => {
    const payload = JSON.stringify({ songs: [{ name: '中文歌曲' }] })
    const compressed = compress(Buffer.from(payload))
    await withServer(
      (_request, response) => {
        response.writeHead(200, {
          'content-encoding': encoding,
          'content-length': compressed.byteLength,
          'content-type': 'application/json',
        })
        response.end(compressed)
      },
      async url => {
        const response = await fetchSafeRemote(url)
        expect(await response.json()).toEqual(JSON.parse(payload))
        expect(response.headers.has('content-encoding')).toBe(false)
        expect(response.headers.has('content-length')).toBe(false)
      },
    )
  })

  test('rejects decompression expansion beyond the limit', async () => {
    const compressed = gzipSync(Buffer.alloc(1024 * 1024, 'a'))
    expect(compressed.byteLength).toBeLessThan(2048)
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.byteLength })
        response.end(compressed)
      },
      async url => {
        await expect(fetchSafeRemote(url, { maxBytes: 2048 })).rejects.toThrow('Remote response is too large')
      },
    )
  })

  test('rejects malformed compressed data', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-encoding': 'gzip' })
        response.end('invalid gzip')
      },
      async url => {
        await expect(fetchSafeRemote(url)).rejects.toThrow()
      },
    )
  })

  test('HEAD preserves resource length even when it exceeds the body limit', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-length': 100 * 1024 * 1024, 'content-encoding': 'gzip' })
        response.end()
      },
      async url => {
        const response = await fetchSafeRemote(url, { method: 'HEAD', maxBytes: 1024 })
        expect(response.body).toBeNull()
        expect(response.headers.get('content-length')).toBe(String(100 * 1024 * 1024))
        expect(response.headers.get('content-encoding')).toBe('gzip')
      },
    )
  })

  test('discardResponseBody returns redirect headers without reading the upstream body', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(302, {
          location: '/cdn/audio',
          'content-length': '1048576',
        })
        response.flushHeaders()
      },
      async url => {
        const response = await fetchSafeRemote(url, { method: 'GET', maxBytes: 16, discardResponseBody: true })
        expect(response.status).toBe(302)
        expect(response.headers.get('location')).toBe('/cdn/audio')
        expect(response.headers.get('content-length')).toBe('1048576')
        expect(response.body).toBeNull()
      },
    )
  })

  test.each([204, 205, 304])('returns status %s without constructing a forbidden body', async status => {
    await withServer(
      (_request, response) => {
        response.writeHead(status)
        response.end()
      },
      async url => {
        const response = await fetchSafeRemote(url)
        expect(response.status).toBe(status)
        expect(response.body).toBeNull()
      },
    )
  })

  test('proxy HEAD and no-content statuses preserve null bodies', async () => {
    let proxyStatusIndex = 0
    await withServer(
      (_request, response) => {
        const status = [200, 204, 205, 304][proxyStatusIndex++]!
        response.writeHead(status, status === 200 ? { 'content-length': '104857600' } : {})
        response.end()
      },
      async serverUrl => {
        proxyStatusIndex = 0
        const target = Object.assign(new URL('http://remote.example/'), {
          lookup: serverUrl.lookup,
          proxyTargetResolutionSafe: true,
        }) as SafeRemoteHttpUrl
        const proxy = `http://127.0.0.1:${new URL(serverUrl).port}`
        const head = await fetchSafeRemote(target, { method: 'HEAD', maxBytes: 1024, proxy })
        expect(head.body).toBeNull()
        expect(head.headers.get('content-length')).toBe('104857600')
        for (const status of [204, 205, 304]) {
          const response = await fetchSafeRemote(target, { proxy })
          expect(response.status).toBe(status)
          expect(response.body).toBeNull()
        }
      },
    )
  })

  test('uses the configured global proxy for safe buffered requests by default', async () => {
    const previousLx = global.lx
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '198.18.0.1', family: 4 }] as any)
    let requestedTarget = ''
    global.lx = {
      config: { 'proxy.all.enabled': true, 'proxy.all.address': '' },
    } as typeof global.lx
    await withServer(
      (request, response) => {
        requestedTarget = request.url || ''
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('proxied')
      },
      async serverUrl => {
        try {
          global.lx.config['proxy.all.address'] = `http://127.0.0.1:${new URL(serverUrl).port}`
          const safeUrl = await assertSafeRemoteHttpUrl('http://remote.example/resource')
          const response = await fetchSafeRemote(safeUrl, { maxBytes: 32 })
          expect(await response.text()).toBe('proxied')
          expect(requestedTarget).toBe('http://remote.example/resource')
        } finally {
          global.lx = previousLx
          lookup.mockRestore()
        }
      },
    )
  })
})
