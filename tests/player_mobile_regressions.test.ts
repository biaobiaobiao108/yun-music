import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { playerApi } from '../frontend/player/src/react/api'
import { navigateToSongEntity } from '../frontend/player/src/react/song_details'
import { usePlayerUiStore, useRecentStore } from '../frontend/player/src/react/store'
import type { Song } from '../frontend/player/src/react/types'

const initialUi = usePlayerUiStore.getState()
const initialRecent = useRecentStore.getState()
const songs: Song[] = [
  { id: 'a', songmid: 'a', name: '歌曲甲', singer: '歌手', albumName: '同一张专辑', source: 'wy', artistId: 'artist-a', albumId: 'album-a' },
  { id: 'b', songmid: 'b', name: '歌曲乙', singer: '歌手', albumName: '同一张专辑', source: 'wy' },
]

afterEach(() => {
  usePlayerUiStore.setState(initialUi)
  useRecentStore.setState(initialRecent)
})

describe('Mobile player regressions', () => {
  it('closes immersive lyrics when navigating directly to an artist or album', async () => {
    for (const kind of ['artist', 'album'] as const) {
      usePlayerUiStore.setState({ immersiveLyrics: true })
      await navigateToSongEntity(songs[0]!, kind)
      expect(usePlayerUiStore.getState()).toMatchObject({ immersiveLyrics: false, detail: { kind } })
    }
  })

  it('closes immersive lyrics after resolving a missing entity id', async () => {
    const search = spyOn(playerApi, 'search').mockResolvedValue([{ id: 'resolved-artist', name: '歌手', source: 'wy' }])
    try {
      usePlayerUiStore.setState({ immersiveLyrics: true })
      await navigateToSongEntity(songs[1]!, 'artist')
      expect(usePlayerUiStore.getState()).toMatchObject({ immersiveLyrics: false, detail: { id: 'resolved-artist', kind: 'artist' } })
    } finally {
      search.mockRestore()
    }
  })
})
