import { afterEach, expect, spyOn, test } from 'bun:test'
import { logout } from '../frontend/admin/src/react/api'
import { useAdminStore } from '../frontend/admin/src/react/store'
import { playerApi } from '../frontend/player/src/react/api'
import { setSessionScope } from '../frontend/player/src/react/session'
import { useMediaLibraryStore } from '../frontend/player/src/react/store/media_library'
import type { Song } from '../frontend/player/src/react/types'

const existingArtist: Song = { id: 'existing-artist', source: 'wy', name: '既有歌手' }
const addedArtist: Song = { id: 'added-artist', source: 'wy', name: '新歌手' }
const existingAlbum: Song = { id: 'existing-album', source: 'wy', name: '既有专辑' }
const addedAlbum: Song = { id: 'added-album', source: 'wy', name: '新专辑' }

afterEach(() => {
  useMediaLibraryStore.getState().reset()
  useAdminStore.setState({ authenticated: false, checking: true, error: '', toast: '' })
  setSessionScope(null)
})

test.each([
  ['artist', 'libraryArtists', 'libraryAlbums', 'saveLibraryArtists', existingArtist, addedArtist, 'artists'],
  ['album', 'libraryAlbums', 'libraryArtists', 'saveLibraryAlbums', existingAlbum, addedAlbum, 'albums'],
] as const)(
  'waits for the initial %s library load before saving a toggle',
  async (_kind, primaryRead, otherRead, write, existing, added, stateKey) => {
    let finishPrimary: ((items: Song[]) => void) | undefined
    let finishOther: ((items: Song[]) => void) | undefined
    const primary = spyOn(playerApi, primaryRead).mockImplementation(
      () => new Promise(resolve => (finishPrimary = resolve)),
    )
    const other = spyOn(playerApi, otherRead).mockImplementation(() => new Promise(resolve => (finishOther = resolve)))
    const save = spyOn(playerApi, write).mockResolvedValue({ success: true })
    try {
      useMediaLibraryStore.getState().reset()
      const hydration = useMediaLibraryStore.getState().hydrate()
      const mutation = useMediaLibraryStore.getState().toggle(_kind, added)
      await Promise.resolve()
      expect(save).not.toHaveBeenCalled()

      finishPrimary!([existing])
      finishOther!([])
      await Promise.all([hydration, mutation])

      expect(save).toHaveBeenCalledTimes(1)
      expect(save.mock.calls[0]?.[0].map(item => item.id)).toContain(existing.id)
      expect(save.mock.calls[0]?.[0].map(item => item.id)).toContain(added.id)
      expect(useMediaLibraryStore.getState()[stateKey].map(item => item.id)).toContain(existing.id)
    } finally {
      primary.mockRestore()
      other.mockRestore()
      save.mockRestore()
    }
  },
)

test('does not save an empty media library when the initial load fails', async () => {
  const albums = spyOn(playerApi, 'libraryAlbums').mockRejectedValue(new Error('媒体库读取失败'))
  const artists = spyOn(playerApi, 'libraryArtists').mockRejectedValue(new Error('媒体库读取失败'))
  const save = spyOn(playerApi, 'saveLibraryArtists').mockResolvedValue({ success: true })
  try {
    useMediaLibraryStore.getState().reset()
    await expect(useMediaLibraryStore.getState().toggle('artist', addedArtist)).rejects.toThrow('媒体库读取失败')
    expect(save).not.toHaveBeenCalled()
    expect(useMediaLibraryStore.getState().artists).toEqual([])
  } finally {
    albums.mockRestore()
    artists.mockRestore()
    save.mockRestore()
  }
})

test('keeps the admin session active when the server logout request fails', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error('network unavailable')
    },
    { preconnect: () => Promise.resolve() },
  )
  useAdminStore.setState({ authenticated: true, checking: false, status: { users: 1 } })
  try {
    await expect(logout()).rejects.toThrow('network unavailable')
    await expect(useAdminStore.getState().signOut()).rejects.toThrow('network unavailable')
    expect(useAdminStore.getState().authenticated).toBe(true)
    expect(useAdminStore.getState().status).toEqual({ users: 1 })
  } finally {
    globalThis.fetch = originalFetch
  }
})
