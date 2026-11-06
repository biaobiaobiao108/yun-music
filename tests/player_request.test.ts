import { afterEach, describe, expect, test } from 'bun:test'
import { requestJson, setUnauthorizedHandler } from '../frontend/player/src/react/data/request'
import { setSessionScope } from '../frontend/player/src/react/session'

describe('player request unauthorized handling', () => {
  afterEach(() => setUnauthorizedHandler(null))

  test('notifies the auth hook only for 401 responses', async () => {
    const seen: string[] = []
    setUnauthorizedHandler(pathname => seen.push(pathname))
    const fetcher = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch

    await expect(requestJson('/api/music/url', { fetcher })).rejects.toThrow()
    expect(seen).toEqual(['/api/music/url'])

    await expect(
      requestJson('/api/music/url', {
        fetcher: (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow()
    expect(seen).toEqual(['/api/music/url'])
  })

  test('deduplicated reads still surface a 401', async () => {
    const seen: string[] = []
    setUnauthorizedHandler(pathname => seen.push(pathname))
    const fetcher = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const options = { fetcher, cacheKey: 'unauthorized-test', cacheTtlMs: 1000 }

    await expect(requestJson('/api/music/lyric', options)).rejects.toThrow()
    await expect(requestJson('/api/music/lyric', options)).rejects.toThrow()
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]).toBe('/api/music/lyric')
  })

  test('ignores a 401 from an earlier account session', async () => {
    const seen: string[] = []
    setUnauthorizedHandler(pathname => seen.push(pathname))
    setSessionScope('old-account')
    let respond!: (response: Response) => void
    const fetcher = (() =>
      new Promise<Response>(resolve => {
        respond = resolve
      })) as unknown as typeof fetch
    const pending = requestJson('/api/user/settings', { fetcher })
    setSessionScope('new-account')
    respond(new Response('{}', { status: 401 }))
    await expect(pending).rejects.toThrow()
    expect(seen).toEqual([])
    setSessionScope(null)
  })
})
