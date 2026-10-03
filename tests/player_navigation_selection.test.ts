import { afterEach, describe, expect, it } from 'bun:test'
import { getSidebarActiveTab, parsePlayerHash, serializePlayerHash, VALID_PLAYER_TABS } from '../frontend/player/src/react/route_state'
import { usePlayerUiStore } from '../frontend/player/src/react/store/ui'

const initialUi = usePlayerUiStore.getState()
afterEach(() => usePlayerUiStore.setState(initialUi))

describe('Player sidebar selection', () => {
  it('opens the playlist collection separately from favorites and restores it from history', () => {
    const ui = usePlayerUiStore.getState()
    ui.openFavoriteList('playlist-1')
    ui.setTab('playlists')
    expect(usePlayerUiStore.getState()).toMatchObject({ tab: 'playlists', detail: null, favoriteListId: 'playlist-1' })
    const route = parsePlayerHash(serializePlayerHash({ tab: 'playlists' }))
    expect(route.tab).toBe('playlists')
    ui.setTab('library')
    ui.setTabFromHistory(route.tab)
    expect(usePlayerUiStore.getState().tab).toBe('playlists')
    ui.openFavoriteList('playlist-2')
    expect(usePlayerUiStore.getState()).toMatchObject({ tab: 'favorites', favoriteListId: 'playlist-2' })
    ui.openFavoriteList('love')
    expect(usePlayerUiStore.getState()).toMatchObject({ tab: 'favorites', favoriteListId: 'love' })
  })
  it('selects a custom playlist without selecting the love list, then switches back', () => {
    const ui = usePlayerUiStore.getState()
    ui.openFavoriteList('playlist-1')
    let state = usePlayerUiStore.getState()
    expect(state).toMatchObject({ tab: 'favorites', favoriteListId: 'playlist-1' })
    expect(getSidebarActiveTab(state.tab, state.favoriteListId)).toBeNull()
    ui.setTab('favorites')
    state = usePlayerUiStore.getState()
    expect(state.favoriteListId).toBe('love')
    expect(getSidebarActiveTab(state.tab, state.favoriteListId)).toBe('favorites')
  })

  it('keeps playlist selection distinct after opening a link or restoring history', () => {
    const route = parsePlayerHash('#favorites?listId=playlist-2')
    usePlayerUiStore.getState().setTabFromHistory(route.tab, null, route.listId)
    const state = usePlayerUiStore.getState()
    expect(getSidebarActiveTab(state.tab, state.favoriteListId)).toBeNull()
    expect(state.favoriteListId).toBe('playlist-2')
    usePlayerUiStore.getState().setTabFromHistory('favorites')
    expect(getSidebarActiveTab('favorites', usePlayerUiStore.getState().favoriteListId)).toBe('favorites')
  })

  it('selects charts separately from discovery and maps retired category links to discovery', () => {
    expect(getSidebarActiveTab('leaderboard')).toBe('leaderboard')
    expect(getSidebarActiveTab('songlist')).toBe('songlist')
    expect(getSidebarActiveTab('genres')).toBe('songlist')
    for (const tab of VALID_PLAYER_TABS.filter(tab => !['favorites', 'genres'].includes(tab))) {
      expect(getSidebarActiveTab(tab, 'playlist-1')).toBe(tab)
    }
  })
})
