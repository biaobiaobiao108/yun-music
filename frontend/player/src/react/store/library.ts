import { create } from 'zustand'
import { playerApi, type UserListData, type UserPlaylist } from '../api'
import { invalidateRequestCache, isAbortError } from '../data/request'
import { songListId, songKey, type Song } from '../types'

let libraryController: AbortController | null = null
let libraryRequestId = 0

export type LibraryState = {
  data: UserListData
  loading: boolean
  refreshing: boolean
  error: string
  loadedAt: number
  hydrate: (options?: { force?: boolean }) => Promise<void>
  addSong: (listId: string, song: Song) => Promise<void>
  removeSong: (listId: string, song: Song) => Promise<void>
  removeSongs: (listId: string, songs: Song[]) => Promise<void>
  createList: (name: string) => Promise<UserPlaylist>
  renameList: (listId: string, name: string) => Promise<void>
  deleteList: (listId: string) => Promise<void>
  reset: () => void
  invalidate: () => void
}

const emptyData: UserListData = { defaultList: [], loveList: [], userList: [] }

export const useLibraryStore = create<LibraryState>((set, get) => ({
  // Keep the initial state loading so a direct #favorites?listId=… route is
  // not mistaken for a deleted playlist before the first hydration finishes.
  data: emptyData,
  loading: true,
  refreshing: false,
  error: '',
  loadedAt: 0,
  hydrate: async (options = {}) => {
    const hadController = Boolean(libraryController)
    libraryController?.abort()
    const controller = new AbortController()
    libraryController = controller
    const requestId = ++libraryRequestId
    const force = options.force ?? hadController
    set({ loading: true, refreshing: get().loadedAt > 0, error: '' })
    try {
      const data = await playerApi.listData(undefined, controller.signal, {
        cacheKey: 'library:lists',
        cacheTtlMs: 30_000,
        force,
      })
      if (!controller.signal.aborted && requestId === libraryRequestId) set({ data: data || emptyData, error: '', loadedAt: Date.now() })
    } catch (error) {
      if (!controller.signal.aborted && requestId === libraryRequestId && !isAbortError(error)) {
        set({ error: error instanceof Error ? error.message : '歌单加载失败' })
      }
    } finally {
      if (libraryController === controller) {
        libraryController = null
        set({ loading: false, refreshing: false })
      }
    }
  },
  addSong: async (listId, song) => {
    await playerApi.addToList(listId, [song])
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
  },
  removeSong: async (listId, song) => { await get().removeSongs(listId, [song]) },
  removeSongs: async (listId, songs) => {
    const songIds = [...new Set(songs.map(songListId).filter(Boolean))]
    if (!songIds.length) return
    await playerApi.removeFromList(listId, songIds)
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
  },
  createList: async name => {
    const data = get().data
    const list: UserPlaylist = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      list: [],
    }
    await playerApi.saveListData({ ...data, userList: [...(data.userList ?? []), list] })
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
    return list
  },
  renameList: async (listId, name) => {
    const data = get().data
    const userList = (data.userList ?? []).map(list => String(list.id) === String(listId) ? { ...list, name } : list)
    await playerApi.saveListData({ ...data, userList })
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
  },
  deleteList: async listId => {
    const data = get().data
    await playerApi.saveListData({ ...data, userList: (data.userList ?? []).filter(list => String(list.id) !== String(listId)) })
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
  },
  reset: () => {
    libraryRequestId += 1
    libraryController?.abort()
    set({ data: emptyData, loading: false, refreshing: false, error: '', loadedAt: 0 })
  },
  invalidate: () => {
    libraryRequestId += 1
    libraryController?.abort()
    invalidateRequestCache('library:lists')
    set({ loadedAt: 0 })
  },
}))

export const selectUserLists = (state: LibraryState): UserPlaylist[] => state.data.userList ?? []
export const selectLoveList = (state: LibraryState): Song[] => state.data.loveList ?? []
export const selectLibraryData = (state: LibraryState): UserListData => state.data
export const selectLibraryStatus = (state: LibraryState) => ({ loading: state.loading, refreshing: state.refreshing, error: state.error })
export const selectPlaylist = (listId: string) => (state: LibraryState): UserPlaylist | undefined => selectUserLists(state).find(list => String(list.id) === String(listId))

export function playlistSongs(list: UserPlaylist | undefined): Song[] {
  return list?.list?.filter(song => Boolean(song && songKey(song))) ?? []
}
