import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setSessionScope, scopedStorageKey } from '../frontend/player/src/react/session'
import { useRecentStore } from '../frontend/player/src/react/store/recent'

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() {
    return this.data.size
  }
  clear() {
    this.data.clear()
  }
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
}

const originalFetch = globalThis.fetch
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('recent playback synchronization', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
    setSessionScope('recent-test')
    useRecentStore.getState().reset()
  })
  afterEach(() => {
    useRecentStore.getState().reset()
    setSessionScope(null)
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })

  test('preserves server order even when cached timestamps disagree', async () => {
    globalThis.fetch = (async () =>
      json({
        revision: 10,
        items: [
          { id: 'new', source: 'wy', playedAt: 1 },
          { id: 'old', source: 'wy', playedAt: 9999999999999 },
        ],
      })) as unknown as typeof fetch
    await useRecentStore.getState().hydrate()
    expect(useRecentStore.getState().items.map(song => song.id)).toEqual(['new', 'old'])
  })

  test('accepts a confirmed lower revision after a database restore', async () => {
    localStorage.setItem(
      scopedStorageKey('play_history_snapshot'),
      JSON.stringify({ revision: 100, items: [{ id: 'old-cache', source: 'wy' }] }),
    )
    let reads = 0
    globalThis.fetch = (async () => {
      reads++
      return json({ revision: 10, items: [{ id: 'restored', source: 'wy', playedAt: 10 }] })
    }) as unknown as typeof fetch
    await useRecentStore.getState().hydrate()
    expect(reads).toBe(2)
    expect(useRecentStore.getState().items.map(song => song.id)).toEqual(['restored'])
  })

  test('does not import old browser settings, playback state or history', async () => {
    const song = { id: 'old', source: 'wy', name: 'Old', playedAt: 123 }
    localStorage.setItem('play_history', JSON.stringify([song]))
    localStorage.setItem('lx_settings', JSON.stringify({ preferredQuality: 'mp3' }))
    localStorage.setItem('lx_playback_state', JSON.stringify({ currentSong: song }))
    setSessionScope('no-old-history')
    expect(localStorage.getItem(scopedStorageKey('play_history'))).toBeNull()
    expect(localStorage.getItem(scopedStorageKey('lx_settings'))).toBeNull()
    expect(localStorage.getItem(scopedStorageKey('lx_playback_state'))).toBeNull()
    localStorage.setItem(scopedStorageKey('play_history_pending'), JSON.stringify([{ key: 'wy:old', playedAt: 123 }]))
    globalThis.fetch = (async () => json({ revision: 1, items: [] })) as unknown as typeof fetch
    await useRecentStore.getState().hydrate()
    expect(useRecentStore.getState().items).toEqual([])
    const events = [...Array(localStorage.length)]
      .map((_, i) => localStorage.key(i))
      .filter(key => key?.startsWith(scopedStorageKey('play_history_event') + ':'))
    expect(events).toEqual([])
  })

  test('ignores an old read arriving after a successful playback upload', async () => {
    let finishRead!: (response: Response) => void
    const delayedRead = new Promise<Response>(resolve => {
      finishRead = resolve
    })
    let posted = false
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted = true
        return json({ revision: 20, items: [{ id: 'played', source: 'wy', playedAt: 20 }] })
      }
      return delayedRead
    }) as unknown as typeof fetch
    const read = useRecentStore.getState().hydrate()
    useRecentStore.getState().record({ id: 'played', source: 'wy', name: 'Played' })
    await Bun.sleep(950)
    expect(posted).toBe(true)
    finishRead(json({ revision: 10, items: [{ id: 'old', source: 'wy', playedAt: 10 }] }))
    await read
    expect(useRecentStore.getState().items.map(song => song.id)).toEqual(['played'])
    expect(
      [...Array(localStorage.length)]
        .map((_, i) => localStorage.key(i))
        .filter(key => key?.startsWith(scopedStorageKey('play_history_event') + ':')),
    ).toEqual([])
  })

  test('keeps failed events and retries them on a later refresh', async () => {
    let uploads = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        uploads++
        if (uploads === 1) return json({ message: 'offline' }, 503)
        return json({ revision: 20, items: [{ id: 'pending', source: 'wy', playedAt: 20 }] })
      }
      return json({ revision: 10, items: [] })
    }) as unknown as typeof fetch
    useRecentStore.getState().record({ id: 'pending', source: 'wy', name: 'Pending' })
    await Bun.sleep(950)
    expect(uploads).toBe(1)
    expect(
      [...Array(localStorage.length)].some((_, i) =>
        localStorage.key(i)?.startsWith(scopedStorageKey('play_history_event') + ':'),
      ),
    ).toBe(true)
    await useRecentStore.getState().hydrate()
    await Bun.sleep(950)
    expect(uploads).toBe(2)
    expect(useRecentStore.getState().items.map(song => song.id)).toEqual(['pending'])
  })
})
