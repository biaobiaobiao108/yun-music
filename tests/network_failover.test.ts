import { describe, expect, spyOn, test } from 'bun:test'
import dns from 'node:dns/promises'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { assertSafeRemoteHttpUrl, fetchSafeRemote, type SafeRemoteHttpUrl } from '@/server/networkSecurity'
import { getResourceBudgetStats } from '@/server/resourceBudget'

type MockRequest = EventEmitter & { destroyed: boolean; destroy: () => void }
type Attempt = { request: MockRequest; options: https.RequestOptions; respond: (response: any) => void; address: string }
const connectionError = (code = 'ECONNRESET') => Object.assign(new Error(code), { code })
const reply = (status = 200, content = '{"url":"https://cdn.example/audio.flac"}') => Object.assign(Readable.from([content]), {
  statusCode: status, statusMessage: 'OK', headers: { 'content-type': 'application/json' },
})

async function withTransport(
  addresses: Array<{ address: string; family: number }>,
  handle: (attempt: Attempt) => void,
  run: (url: SafeRemoteHttpUrl, visits: string[], requests: MockRequest[]) => Promise<void>,
) {
  const lookup = spyOn(dns, 'lookup').mockResolvedValue(addresses as any)
  const requests: MockRequest[] = []
  const visits: string[] = []
  const transport = spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, respond: (response: any) => void) => {
    const request = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() { this.destroyed = true; return this },
      setTimeout() { return this },
      end() {
        queueMicrotask(() => options.lookup!(String(options.hostname), { all: true }, (error, result) => {
          if (error) { request.emit('error', error); return }
          const address = typeof result === 'string' ? result : result[0].address
          visits.push(address)
          handle({ request, options, respond, address })
        }))
        return this
      },
    })
    requests.push(request)
    return request
  }) as any)
  try {
    const url = await assertSafeRemoteHttpUrl('https://source.example:8443/api/music/url?source=wy')
    // A second DNS lookup would now return loopback. Retry must use the snapshot.
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any)
    await run(url, visits, requests)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(getResourceBudgetStats().buffered).toMatchObject({ active: 0, reservedBytes: 0 })
  } finally {
    transport.mockRestore()
    lookup.mockRestore()
  }
}

const addresses = [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }]

describe('Validated address failover', () => {
  test.each(['GET', 'HEAD'])('%s switches to another validated address after a connection reset', async method => {
    let activeReservation = 0
    await withTransport(addresses, ({ request, options, respond, address }) => {
      expect(options).toMatchObject({ hostname: 'source.example', port: '8443', path: '/api/music/url?source=wy', method })
      expect(options.headers).toMatchObject({ 'x-source-client': 'player' })
      const budget = getResourceBudgetStats().buffered
      expect(budget.active).toBe(1)
      if (!activeReservation) activeReservation = budget.reservedBytes
      expect(budget.reservedBytes).toBe(activeReservation)
      if (address === '8.8.8.8') request.emit('error', connectionError())
      else respond(reply())
    }, async (url, visits, requests) => {
      const response = await fetchSafeRemote(url, { method, headers: { 'X-Source-Client': 'player' } })
      expect(response.status).toBe(200)
      if (method === 'GET') expect(await response.json()).toEqual({ url: 'https://cdn.example/audio.flac' })
      else expect(response.body).toBeNull()
      expect(visits).toEqual(addresses.map(item => item.address))
      expect(requests[0].destroyed).toBe(true)
    })
  })

  test('does not replay POST requests on another address', async () => {
    await withTransport(addresses, ({ request }) => request.emit('error', connectionError()), async (url, visits) => {
      await expect(fetchSafeRemote(url, { method: 'POST', body: '{}' })).rejects.toThrow('ECONNRESET')
      expect(visits).toEqual(['8.8.8.8'])
    })
  })

  test.each([401, 503])('does not switch addresses after HTTP %s', async status => {
    await withTransport(addresses, ({ respond }) => respond(reply(status)), async (url, visits) => {
      expect((await fetchSafeRemote(url)).status).toBe(status)
      expect(visits).toEqual(['8.8.8.8'])
    })
  })

  test('does not retry a reset after response headers', async () => {
    await withTransport(addresses, ({ respond }) => {
      const response = Object.assign(new Readable({ read() { this.destroy(connectionError()) } }), {
        statusCode: 200, headers: {},
      })
      respond(response)
    }, async (url, visits, requests) => {
      await expect(fetchSafeRemote(url)).rejects.toThrow('ECONNRESET')
      expect(visits).toEqual(['8.8.8.8'])
      expect(requests[0].destroyed).toBe(true)
    })
  })

  test('does not retry TLS validation failures', async () => {
    await withTransport(addresses, ({ request }) => request.emit('error', connectionError('CERT_HAS_EXPIRED')), async (url, visits) => {
      await expect(fetchSafeRemote(url)).rejects.toThrow('CERT_HAS_EXPIRED')
      expect(visits).toEqual(['8.8.8.8'])
    })
  })

  test('deduplicates candidates and caps failed connection attempts', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ address: `8.8.8.${index + 1}`, family: 4 }))
    await withTransport([...many, ...many], ({ request }) => request.emit('error', connectionError('ENETUNREACH')), async (url, visits, requests) => {
      await expect(fetchSafeRemote(url)).rejects.toThrow('ENETUNREACH')
      expect(visits).toEqual(many.slice(0, 8).map(item => item.address))
      expect(requests.every(request => request.destroyed)).toBe(true)
    })
  })

  test('an abort stops failover and releases the active reservation', async () => {
    const controller = new AbortController()
    await withTransport(addresses, ({ request }) => {
      request.emit('error', connectionError())
      controller.abort()
    }, async (url, visits, requests) => {
      await expect(fetchSafeRemote(url, { signal: controller.signal })).rejects.toThrow()
      expect(visits).toEqual(['8.8.8.8'])
      expect(requests[0].destroyed).toBe(true)
    })
  })

  test('the original deadline covers all attempts instead of restarting per address', async () => {
    await withTransport(addresses, ({ request, address }) => {
      if (address === '8.8.8.8') request.emit('error', connectionError())
      // Leave the second attempt hanging; only the shared deadline cancels it.
    }, async (url, visits, requests) => {
      await expect(fetchSafeRemote(url, { timeoutMs: 40 })).rejects.toThrow('Remote request aborted')
      expect(visits).toEqual(addresses.map(item => item.address))
      expect(requests.every(request => request.destroyed)).toBe(true)
    })
  })
})
