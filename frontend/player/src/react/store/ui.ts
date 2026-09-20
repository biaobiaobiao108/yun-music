import { create } from 'zustand'
import { emitPlayerNavigation } from '../route_state'
import type { DrawerName, PlayerDetail, PlayerTab, Song } from '../types'

export type DialogName = 'login' | 'userLogin' | 'createList' | 'addToList' | 'sleep' | 'lyrics' | 'comments' | null

export type UiState = {
  tab: PlayerTab
  detail: PlayerDetail | null
  favoriteListId: string
  sidebarOpen: boolean
  drawer: DrawerName
  dialog: DialogName
  playlistSong: Song | null
  immersiveLyrics: boolean
  notice: string
  setTab: (tab: PlayerTab) => void
  setDetail: (detail: PlayerDetail | null) => void
  openLibraryDetail: (tab: 'albums' | 'artists', detail: PlayerDetail) => void
  setFavoriteListId: (listId: string) => void
  openFavoriteList: (listId: string) => void
  setTabFromHistory: (tab: PlayerTab, detail?: PlayerDetail | null, listId?: string) => void
  toggleSidebar: () => void
  closeSidebar: () => void
  setDrawer: (drawer: DrawerName) => void
  setDialog: (dialog: DialogName) => void
  openAddToList: (song: Song) => void
  closeAddToList: () => void
  closeOverlays: () => void
  setImmersiveLyrics: (open: boolean) => void
  notify: (notice: string) => void
  clearNotice: () => void
}

export const usePlayerUiStore = create<UiState>((set, get) => ({
  tab: 'home',
  detail: null,
  favoriteListId: 'love',
  sidebarOpen: false,
  drawer: null,
  dialog: null,
  playlistSong: null,
  immersiveLyrics: false,
  notice: '',
  setTab: tab => {
    const state = get()
    const listId = tab === 'favorites' ? 'love' : undefined
    if (state.tab === tab && !state.detail && (tab !== 'favorites' || state.favoriteListId === 'love')) return
    set({ tab, detail: null, favoriteListId: tab === 'favorites' ? 'love' : state.favoriteListId, sidebarOpen: false })
    emitPlayerNavigation({ tab, detail: null, listId })
  },
  setDetail: detail => {
    set({ detail })
    emitPlayerNavigation({ tab: get().tab, detail, listId: get().tab === 'favorites' ? get().favoriteListId : undefined })
  },
  openLibraryDetail: (tab, detail) => {
    set({ tab, detail, sidebarOpen: false })
    emitPlayerNavigation({ tab, detail })
  },
  setFavoriteListId: favoriteListId => set({ favoriteListId: String(favoriteListId || 'love') }),
  openFavoriteList: favoriteListId => {
    const listId = String(favoriteListId || 'love')
    const state = get()
    if (state.tab === 'favorites' && state.favoriteListId === listId && !state.detail) return
    set({ tab: 'favorites', detail: null, favoriteListId: listId, sidebarOpen: false })
    emitPlayerNavigation({ tab: 'favorites', detail: null, listId })
  },
  setTabFromHistory: (tab, detail = null, favoriteListId = 'love') => set({
    tab,
    detail,
    favoriteListId: tab === 'favorites' ? String(favoriteListId || 'love') : get().favoriteListId,
    sidebarOpen: false,
  }),
  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
  closeSidebar: () => set({ sidebarOpen: false }),
  setDrawer: drawer => set({ drawer }),
  setDialog: dialog => set(dialog === null ? { dialog, playlistSong: null } : { dialog }),
  openAddToList: playlistSong => set({ playlistSong, dialog: 'addToList' }),
  closeAddToList: () => set({ playlistSong: null, dialog: null }),
  closeOverlays: () => set({ immersiveLyrics: false, dialog: null, drawer: null, sidebarOpen: false, playlistSong: null }),
  setImmersiveLyrics: open => set({ immersiveLyrics: open }),
  notify: notice => set({ notice }),
  clearNotice: () => set({ notice: '' }),
}))

export const getPlayerUiActions = () => usePlayerUiStore.getState()
