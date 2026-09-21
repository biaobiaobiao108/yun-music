import { create } from 'zustand'
import { playerApi, type PlaylistIconKey, type UserListData, type UserPlaylist } from '../api'
import { invalidateRequestCache, isAbortError } from '../data/request'
import { buildSongMatchSet, normalizeSongForList, sameSong, songListId, songKey, songMatchSetHas, type Song } from '../types'

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
  createList: (name: string, icon?: PlaylistIconKey) => Promise<UserPlaylist>
  toggleRemotePlaylist: (detail: { id: string; source: string; name: string; image?: string }, songs: Song[]) => Promise<boolean>
  renameList: (listId: string, name: string) => Promise<void>
  deleteList: (listId: string) => Promise<void>
  reset: () => void
  invalidate: () => void
}

const emptyData: UserListData = { defaultList: [], loveList: [], userList: [] }

const ensureLibraryHydrated = async (
  get: () => LibraryState,
): Promise<UserListData> => {
  const current = get()
  if (current.loadedAt === 0 || current.loading) {
    await current.hydrate({ force: true })
  }
  const next = get()
  if (next.loadedAt === 0) throw new Error(next.error || '歌单数据尚未加载完成，请稍后重试')
  return next.data
}

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
    await playerApi.addToList(listId, [normalizeSongForList(song)])
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
  createList: async (name, icon = 'music') => {
    const data = await ensureLibraryHydrated(get)
    const list: UserPlaylist = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      icon,
      list: [],
    }
    await playerApi.saveListData({ ...data, userList: [...(data.userList ?? []), list] })
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
    return list
  },
  toggleRemotePlaylist: async (detail, songs) => {
    const data = await ensureLibraryHydrated(get)
    const source = String(detail.source || '').trim() || 'wy'
    const sourceListId = String(detail.id)
    const existing = (data.userList ?? []).find(list => String(list.source || '') === source && String(list.sourceListId ?? '') === sourceListId)
    if (existing) {
      await playerApi.saveListData({ ...data, userList: (data.userList ?? []).filter(list => String(list.id) !== String(existing.id)) })
      invalidateRequestCache('library:lists')
      await get().hydrate({ force: true })
      return false
    }
    const list: UserPlaylist = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: detail.name || '在线歌单',
      source,
      sourceListId,
      img: detail.image,
      list: songs.map(normalizeSongForList),
    }
    await playerApi.saveListData({ ...data, userList: [...(data.userList ?? []), list] })
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
    return true
  },
  renameList: async (listId, name) => {
    const data = await ensureLibraryHydrated(get)
    const userList = (data.userList ?? []).map(list => String(list.id) === String(listId) ? { ...list, name } : list)
    await playerApi.saveListData({ ...data, userList })
    invalidateRequestCache('library:lists')
    await get().hydrate({ force: true })
  },
  deleteList: async listId => {
    const data = await ensureLibraryHydrated(get)
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

export function playlistContainsSong(list: UserPlaylist | undefined, song: Song): boolean {
  return Boolean(list?.list?.some(item => sameSong(item, song)))
}

let cachedLoveListRef: Song[] | null = null
let cachedLoveMatchSet: Set<string> = new Set()

export function selectLoveMatchSet(state: LibraryState): Set<string> {
  const loveList = state.data.loveList ?? []
  if (loveList === cachedLoveListRef) {
    return cachedLoveMatchSet
  }
  cachedLoveListRef = loveList
  cachedLoveMatchSet = buildSongMatchSet(loveList)
  return cachedLoveMatchSet
}

export function isSongInLoveList(state: LibraryState, song: Song | null | undefined): boolean {
  return songMatchSetHas(selectLoveMatchSet(state), song)
}

