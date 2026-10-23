import { afterEach, expect, spyOn, test } from 'bun:test'
import { loadPlaylistSongs, playerApi } from '../frontend/player/src/react/api'
import { clearRequestCache } from '../frontend/player/src/react/data/request'

const mockFetch = (handler: (input: RequestInfo | URL) => Promise<Response>): typeof fetch =>
  Object.assign(handler, { preconnect: () => Promise.resolve() })

afterEach(() => clearRequestCache())

test('playlist detail requests an explicit page and keeps the server total', async () => {
  const urls: URL[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    mockFetch(async input => {
      urls.push(new URL(String(input), 'http://localhost'))
      return Response.json({ list: [{ songmid: '51' }], page: 2, limit: 50, total: 120 })
    }),
  )
  try {
    const result = await playerApi.songListDetail('wy', '123', undefined, undefined, 2)
    expect(urls[0]?.searchParams.get('page')).toBe('2')
    expect(urls[0]?.searchParams.get('limit')).toBe('50')
    expect(result.total).toBe(120)
    expect(result.list[0]?.songmid).toBe('51')
  } finally {
    fetch.mockRestore()
  }
})

test.each(['wy', 'tx'])('collecting a %s playlist reads all pages in source order', async source => {
  const pages: number[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    mockFetch(async input => {
      const url = new URL(String(input), 'http://localhost')
      const page = Number(url.searchParams.get('page'))
      const limit = Number(url.searchParams.get('limit'))
      pages.push(page)
      const start = (page - 1) * limit
      const list = Array.from({ length: Math.min(limit, 120 - start) }, (_, index) => ({
        source,
        songmid: String(start + index + 1),
      }))
      return Response.json({ list, total: 120, page, limit })
    }),
  )
  try {
    const songs = await loadPlaylistSongs(source, '123')
    expect(pages).toEqual([1, 2])
    expect(songs.map(song => song.songmid)).toEqual(Array.from({ length: 120 }, (_, index) => String(index + 1)))
  } finally {
    fetch.mockRestore()
  }
})

test('collecting rejects an incomplete playlist instead of accepting a partial copy', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ list: [], page: 1, limit: 100, total: 120 }),
  )
  try {
    await expect(loadPlaylistSongs('wy', '123')).rejects.toThrow('歌单未能完整加载')
  } finally {
    fetch.mockRestore()
  }
})

test('cancelling collection stops before requesting the next playlist page', async () => {
  const controller = new AbortController()
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    mockFetch(async () => {
      controller.abort()
      return Response.json({ list: [{ songmid: '1' }], page: 1, limit: 100, total: 120 })
    }),
  )
  try {
    await expect(loadPlaylistSongs('wy', '123', controller.signal)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    fetch.mockRestore()
  }
})
