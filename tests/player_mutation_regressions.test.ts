import { afterEach, expect, spyOn, test } from 'bun:test'
import { playerApi } from '../frontend/player/src/react/api'
import { getSessionGeneration, setSessionScope } from '../frontend/player/src/react/session'
import { usePlaybackStore } from '../frontend/player/src/react/store/playback'
import { useMediaLibraryStore } from '../frontend/player/src/react/store/media_library'
import type { Song } from '../frontend/player/src/react/types'

const first: Song = { id: 'first', source: 'wy', name: '第一项' }
const second: Song = { id: 'second', source: 'wy', name: '第二项' }

afterEach(() => {
  usePlaybackStore.getState().reset()
  useMediaLibraryStore.getState().reset()
  setSessionScope(null)
})

test('a completed download updates its original queue item after switching songs', () => {
  const generation = getSessionGeneration()
  const playback = usePlaybackStore.getState()
  playback.playSong(first, [first, second], 0)
  playback.playSong(second, [first, second], 1)
  playback.setSongUrl(first, '/api/music/cache/file/first.flac?folder=music', generation)
  const state = usePlaybackStore.getState()
  expect(state.currentSong).toBe(second)
  expect(state.queue[0]?.url).toContain('first.flac')
  expect(state.queue[1]?.url).toBeUndefined()
  playback.setSongUrl(second, '/second.flac', generation)
  expect(usePlaybackStore.getState().currentSong?.url).toBe('/second.flac')
})

test('download completion from a previous login cannot alter the new session queue', () => {
  setSessionScope('alice')
  const generation = getSessionGeneration()
  setSessionScope('bob')
  usePlaybackStore.getState().playSong(first, [first], 0)
  usePlaybackStore.getState().setSongUrl(first, '/alice-private.flac', generation)
  expect(usePlaybackStore.getState().currentSong?.url).toBeUndefined()
  expect(usePlaybackStore.getState().queue[0]?.url).toBeUndefined()
})

test.each(['album', 'artist'] as const)('serializes rapid %s saves so the latest collection persists', async kind => {
  const key = kind === 'album' ? 'albums' : 'artists'
  const method = kind === 'album' ? 'saveLibraryAlbums' : 'saveLibraryArtists'
  const writes: Array<{ items: Song[]; finish: () => void }> = []
  let persisted: Song[] = []
  const save = spyOn(playerApi, method).mockImplementation(
    items =>
      new Promise(resolve => {
        writes.push({
          items,
          finish: () => {
            persisted = items
            resolve({ success: true })
          },
        })
      }),
  )
  try {
    useMediaLibraryStore.getState().reset()
    const one = useMediaLibraryStore.getState().toggle(kind, first)
    const two = useMediaLibraryStore.getState().toggle(kind, second)
    await Promise.resolve()
    expect(writes).toHaveLength(1)
    expect(writes[0]?.items.map(item => item.id)).toEqual(['first'])
    writes[0]!.finish()
    await one
    await Promise.resolve()
    expect(writes).toHaveLength(2)
    expect(writes[1]?.items.map(item => item.id)).toEqual(['first', 'second'])
    writes[1]!.finish()
    await two
    expect(persisted.map(item => item.id)).toEqual(['first', 'second'])
    expect(useMediaLibraryStore.getState()[key]).toEqual(persisted)
  } finally {
    save.mockRestore()
  }
})

test('a failed media save rolls back before constructing the next queued save', async () => {
  const save = spyOn(playerApi, 'saveLibraryAlbums')
    .mockRejectedValueOnce(new Error('保存失败'))
    .mockResolvedValue({ success: true })
  try {
    const one = useMediaLibraryStore
      .getState()
      .toggle('album', first)
      .catch(error => error)
    const two = useMediaLibraryStore.getState().toggle('album', second)
    expect(await one).toBeInstanceOf(Error)
    await two
    expect(save.mock.calls[1]?.[0].map(item => item.id)).toEqual(['second'])
    expect(useMediaLibraryStore.getState().albums.map(item => item.id)).toEqual(['second'])
  } finally {
    save.mockRestore()
  }
})

test('reset discards queued media mutations from an old session', async () => {
  let finish: (() => void) | undefined
  const save = spyOn(playerApi, 'saveLibraryAlbums').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = () => resolve({ success: true })
      }),
  )
  try {
    const one = useMediaLibraryStore.getState().toggle('album', first)
    const two = useMediaLibraryStore
      .getState()
      .toggle('album', second)
      .catch(error => error)
    await Promise.resolve()
    useMediaLibraryStore.getState().reset()
    finish!()
    await one
    expect(await two).toBeInstanceOf(Error)
    expect(save).toHaveBeenCalledTimes(1)
    expect(useMediaLibraryStore.getState().albums).toEqual([])
  } finally {
    save.mockRestore()
  }
})
