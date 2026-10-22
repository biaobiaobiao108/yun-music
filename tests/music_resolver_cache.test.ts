import { expect, spyOn, test } from 'bun:test'
import * as sdk from '@/modules/utils/musicSdk'
import * as userApi from '@/server/userApi'
import {
  clearServerSourceMatchCache,
  findServerSourceMatches,
  getSourceMatchCacheStats,
} from '@/server/services/musicResolver'

test('source matching charges settled arrays and bypasses caching oversized results', async () => {
  let calls = 0
  const song = { source: 'wy', name: 'Match Song', singer: 'Singer' }
  const oversizedStringLength = Math.floor(getSourceMatchCacheStats().results.maxBytes / 2) + 1
  const supported = spyOn(userApi, 'isSourceSupported').mockReturnValue(true)
  const source = spyOn(sdk, 'getBuiltinSource').mockReturnValue({
    musicSearch: {
      search: async () => {
        calls++
        return { list: [{ ...song, payload: 'x'.repeat(oversizedStringLength) }] }
      },
    },
  } as any)
  clearServerSourceMatchCache()
  try {
    expect((await findServerSourceMatches(song, 'cache-user')).length).toBe(1)
    expect(getSourceMatchCacheStats().results.entries).toBe(0)
    expect(getSourceMatchCacheStats().pending.entries).toBe(0)
    await findServerSourceMatches(song, 'cache-user')
    expect(calls).toBe(2)
  } finally {
    clearServerSourceMatchCache()
    source.mockRestore()
    supported.mockRestore()
  }
})

test('pending matches deduplicate and invalidated completions cannot refill result caches', async () => {
  let finish!: (result: any) => void
  let calls = 0
  const song = { source: 'wy', name: 'Pending Song', singer: 'Singer' }
  const supported = spyOn(userApi, 'isSourceSupported').mockReturnValue(true)
  const source = spyOn(sdk, 'getBuiltinSource').mockReturnValue({
    musicSearch: {
      search: () => {
        calls++
        return new Promise(resolve => {
          finish = resolve
        })
      },
    },
  } as any)
  clearServerSourceMatchCache()
  try {
    const first = findServerSourceMatches(song, 'pending-user')
    const duplicate = findServerSourceMatches(song, 'pending-user')
    expect(calls).toBe(1)
    expect(getSourceMatchCacheStats().results.bytes).toBe(0)
    expect(getSourceMatchCacheStats().pending.entries).toBe(1)
    clearServerSourceMatchCache('pending-user')
    finish({ list: [{ ...song }] })
    await Promise.all([first, duplicate])
    expect(getSourceMatchCacheStats().results.entries).toBe(0)
    expect(getSourceMatchCacheStats().pending.entries).toBe(0)
    const next = findServerSourceMatches(song, 'pending-user')
    finish({ list: [{ ...song }] })
    await next
    expect(calls).toBe(2)
    expect(getSourceMatchCacheStats().results.entries).toBe(1)
    expect(getSourceMatchCacheStats().results.bytes).toBeGreaterThan(0)
    await findServerSourceMatches(song, 'pending-user')
    expect(calls).toBe(2)
  } finally {
    clearServerSourceMatchCache()
    source.mockRestore()
    supported.mockRestore()
  }
})

test('normalizeSongInfo converts numeric song id into string songmid', async () => {
  const { normalizeSongInfo } = await import('@/server/services/musicResolver')
  const normalized = normalizeSongInfo({
    source: 'wy',
    id: 12345678 as any,
    name: 'Numeric ID Song',
    singer: 'Singer',
  })
  expect(typeof normalized.songmid).toBe('string')
  expect(normalized.songmid).toBe('12345678')
  expect(normalized.songmid.startsWith('123')).toBe(true)
})
