import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import musicSdk, { getBuiltinSource } from '../src/modules/utils/musicSdk'
import { callUserApiGetMusicUrl, isSourceSupported } from '../src/server/userApi'
import {
  BUILTIN_ONLINE_SOURCES,
  DEFAULT_ONLINE_SOURCES,
  RETIRED_ONLINE_SOURCES,
  UnsupportedSourceError,
  assertBuiltinOnlineSource,
  isRetiredOnlineSource,
  normalizeOnlineSources,
} from '../src/common/musicSources'

const projectRoot = path.resolve(import.meta.dir, '..')

describe('retained music SDK', () => {
  it('exposes only the wy and tx built-in sources', () => {
    expect(musicSdk.sources.map(source => source.id)).toEqual([...BUILTIN_ONLINE_SOURCES].reverse())
    expect(getBuiltinSource('wy')).toBe(musicSdk.wy)
    expect(getBuiltinSource('tx')).toBe(musicSdk.tx)
    expect(getBuiltinSource('custom-source')).toBeUndefined()
  })

  it('keeps source defaults valid and filters retired values', () => {
    expect(normalizeOnlineSources(`${RETIRED_ONLINE_SOURCES[0]},wy,wy,unknown,tx`)).toEqual(['wy', 'tx'])
    expect(normalizeOnlineSources(`${RETIRED_ONLINE_SOURCES[0]},unknown`)).toEqual([...DEFAULT_ONLINE_SOURCES])
    expect(isRetiredOnlineSource(RETIRED_ONLINE_SOURCES[0])).toBe(true)
    expect(() => assertBuiltinOnlineSource(RETIRED_ONLINE_SOURCES[0])).toThrow(UnsupportedSourceError)
  })

  it('has no deleted built-in SDK implementation on disk', () => {
    for (const source of RETIRED_ONLINE_SOURCES) {
      expect(existsSync(path.join(projectRoot, 'src/modules/utils/musicSdk', source))).toBe(false)
    }
    expect(existsSync(path.join(projectRoot, 'src/modules/utils/musicSdk', 'x' + 'm.js'))).toBe(false)
    expect(existsSync(path.join(projectRoot, 'src/modules/utils/musicSdk', RETIRED_ONLINE_SOURCES[0], 'vendors', ['inf', 'Sign.min.js'].join('')))).toBe(false)
  })

  it('keeps the retained platform method surface available', () => {
    for (const source of [musicSdk.wy, musicSdk.tx]) {
      expect(typeof source.musicSearch?.search).toBe('function')
      expect(typeof source.getLyric).toBe('function')
      expect(typeof source.getMusicUrl).toBe('function')
    }
  })

  it('does not request arbitrary playlist links during ID parsing', async () => {
    const previousFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('', { status: 500 })
    }) as typeof fetch
    try {
      await expect(musicSdk.wy.songList.getListDetail('http://127.0.0.1:9527/internal')).rejects.toThrow('recognized playlist links')
      await expect(musicSdk.tx.songList.getListDetail('http://127.0.0.1:9527/internal')).rejects.toThrow('recognized playlist links')
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('rejects retired IDs before consulting custom userApi sources', async () => {
    const retiredSource = RETIRED_ONLINE_SOURCES[0]
    expect(isSourceSupported(retiredSource, 'open')).toBe(false)
    await expect(callUserApiGetMusicUrl(retiredSource, { source: retiredSource }, '128k')).rejects.toBeInstanceOf(UnsupportedSourceError)
  })
})
