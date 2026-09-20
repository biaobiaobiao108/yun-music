import { create } from 'zustand'
import { playerApi, parseLyric, persistLegacySettings, readLegacySettings, type CommentItem } from './api'
import type { PlayerConfig, SearchType, UserListData } from './api'
import { readJson, readString, writeJson, writeString } from '../../../shared/src/storage'
import type { DrawerName, LyricLine, PlayMode, PlayerDetail, PlayerTab, Song } from './types'
import { songKey } from './types'

export const DEFAULT_SETTINGS = {
  defaultEntry: 'favorites',
  preferredQuality: 'flac',
  defaultDownloadTarget: 'server',
  defaultDownloadQuality: 'flac',
  enablePublicSources: true,
  downloadConcurrency: 3,
  hotSearchLimit: 20,
  lyricFontSize: 1.25,
  lyricFontFamily: '',
  autoResume: true,
  showSidebarSongInfo: false,
  enableCrossfade: true,
  keepScreenAwake: true,
  enableKeyboardShortcuts: true,
  showLyricTranslation: true,
  showLyricRoma: false,
  enableAutoSwitchSource: true,
  enableAutoDegradeQuality: true,
  enablePreloader: true,
  showFooterVisualizer: true,
  enableSoundEffects: false,
  soundEffectsPreset: 'flat',
  soundEffectsGain: 1,
  enableLyricGlow: true,
  playerBackground: 'blur',
  saveAccountSettingsToFile: true,
  serverCacheLocation: 'root',
  serverCacheNamingPattern: 'simple',
  switchPlaylistOnSearchPlay: true,
  switchPlaylistOnSongListPlay: true,
  ...({
    enableOnlyDownloadMode: true,
    enableServerCache: true,
    enableServerLyricCache: true,
    embedLyricToFile: true,
    enableLyricCache: true,
    enableSongUrlCache: true,
    preferServerCache: true,
  }),
} as const

type WidenSetting<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T
export type PlayerSettings = { [K in keyof typeof DEFAULT_SETTINGS]: WidenSetting<(typeof DEFAULT_SETTINGS)[K]> } & Record<string, unknown>

type AuthState = {
  config: PlayerConfig | null
  playerAuthRequired: boolean
  playerAuthenticated: boolean
  userName: string | null
  userAuthenticated: boolean
  checking: boolean
  error: string
  hydrate: () => Promise<void>
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  userLogin: (username: string, password: string) => Promise<void>
  userLogout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  config: null,
  playerAuthRequired: false,
  playerAuthenticated: false,
  userName: readString(typeof localStorage === 'undefined' ? null : localStorage, 'lx_user_name') || null,
  userAuthenticated: false,
  checking: true,
  error: '',
  hydrate: async () => {
    set({ checking: true, error: '' })
    try {
      const config = await playerApi.config()
      const [playerSession, userSession] = await Promise.all([playerApi.verify(), playerApi.userVerify()])
      const authenticatedUserName = userSession.valid ? (userSession.username || get().userName) : null
      set({ config, playerAuthRequired: Boolean(config['player.enableAuth']), playerAuthenticated: !config['player.enableAuth'] || playerSession.valid, userAuthenticated: userSession.valid, userName: authenticatedUserName, checking: false })
      writeString(localStorage, 'lx_user_name', authenticatedUserName || '')
    } catch (error) {
      set({ checking: false, error: error instanceof Error ? error.message : '初始化失败，请刷新重试' })
    }
  },
  login: async (password) => { await playerApi.login(password); set({ playerAuthenticated: true, error: '' }) },
  logout: async () => { await playerApi.logout(); set({ playerAuthenticated: false }) },
  userLogin: async (username, password) => { const result = await playerApi.userLogin(username, password); writeString(localStorage, 'lx_user_name', result.username); set({ userName: result.username, userAuthenticated: true }) },
  userLogout: async () => { await playerApi.userLogout(); writeString(localStorage, 'lx_user_name', ''); set({ userName: null, userAuthenticated: false }) },
}))

type SettingsState = { settings: PlayerSettings; setSetting: (key: string, value: unknown) => void; hydrate: () => Promise<void> }
export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: readLegacySettings(DEFAULT_SETTINGS) as PlayerSettings,
  setSetting: (key, value) => { const settings = { ...get().settings, [key]: value } as PlayerSettings; set({ settings }); persistLegacySettings(settings); applyAppearance(settings); void playerApi.saveSettings({ [key]: value }).catch(() => undefined) },
  hydrate: async () => { const local = readLegacySettings(DEFAULT_SETTINGS) as PlayerSettings; set({ settings: local }); applyAppearance(local); usePlaybackStore.setState({ quality: String(local.preferredQuality || 'flac') }); try { const remote = await playerApi.settings(); if (remote && typeof remote === 'object') { const settings = { ...local, ...remote } as PlayerSettings; set({ settings }); persistLegacySettings(settings); applyAppearance(settings); usePlaybackStore.setState({ quality: String(settings.preferredQuality || 'flac') }) } } catch { /* public mode can legitimately reject private settings */ } },
}))

function applyAppearance(settings: Record<string, unknown>) {
  const appearance = String(settings.appearance || settings.theme || 'system')
  if (appearance === 'dark' || appearance === 'light') document.documentElement.dataset.appearance = appearance
  else delete document.documentElement.dataset.appearance
  const theme = String(settings.themeColor || settings.colorTheme || 'netease')
  if (theme) document.documentElement.dataset.theme = theme
}

type PlayerNavigation = { tab: PlayerTab; detail: PlayerDetail | null }
let playerNavigation: ((navigation: PlayerNavigation) => void) | null = null
export function connectPlayerNavigation(navigate: (navigation: PlayerNavigation) => void): () => void {
  playerNavigation = navigate
  return () => { if (playerNavigation === navigate) playerNavigation = null }
}
export function connectPlayerTabNavigation(navigate: (tab: PlayerTab) => void): () => void {
  return connectPlayerNavigation(({ tab }) => navigate(tab))
}

type UiState = { tab: PlayerTab; detail: PlayerDetail | null; sidebarOpen: boolean; drawer: DrawerName; dialog: 'login' | 'userLogin' | 'createList' | 'sleep' | 'lyrics' | 'comments' | null; immersiveLyrics: boolean; notice: string; setTab: (tab: PlayerTab) => void; setDetail: (detail: PlayerDetail | null) => void; setTabFromHistory: (tab: PlayerTab, detail?: PlayerDetail | null) => void; toggleSidebar: () => void; closeSidebar: () => void; setDrawer: (drawer: DrawerName) => void; setDialog: (dialog: UiState['dialog']) => void; setImmersiveLyrics: (open: boolean) => void; notify: (notice: string) => void; clearNotice: () => void }
export const usePlayerUiStore = create<UiState>((set, get) => ({
  tab: 'search', detail: null, sidebarOpen: false, drawer: null, dialog: null, immersiveLyrics: false, notice: '',
  setTab: (tab) => {
    if (get().tab === tab) return
    set({ tab, detail: null, sidebarOpen: false })
    if (playerNavigation) playerNavigation({ tab, detail: null })
    else if (typeof window !== 'undefined') window.history.pushState({ tab }, '', `#${tab}`)
  },
  setDetail: detail => { set({ detail }); if (playerNavigation) playerNavigation({ tab: get().tab, detail }); else if (typeof window !== 'undefined') window.history.pushState({ tab: get().tab, detail }, '', `#${get().tab}`) },
  setTabFromHistory: (tab, detail = null) => set({ tab, detail, sidebarOpen: false }),
  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
  closeSidebar: () => set({ sidebarOpen: false }),
  setDrawer: (drawer) => set({ drawer }),
  setDialog: (dialog) => set({ dialog }),
  setImmersiveLyrics: (open) => set({ immersiveLyrics: open }),
  notify: (notice) => set({ notice }),
  clearNotice: () => set({ notice: '' }),
}))

type CommentState = { song: Song | null; type: 'hot' | 'new'; page: number; total: number; maxPage: number; items: CommentItem[]; loading: boolean; error: string; load: (song: Song | null, type?: 'hot' | 'new', page?: number) => Promise<void>; setType: (type: 'hot' | 'new') => void; next: () => void; previous: () => void }
let commentController: AbortController | null = null
function normalizeComments(payload: unknown): { items: CommentItem[]; total: number; maxPage: number } {
  if (Array.isArray(payload)) return { items: payload as CommentItem[], total: payload.length, maxPage: 1 }
  if (!payload || typeof payload !== 'object') return { items: [], total: 0, maxPage: 1 }
  const record = payload as Record<string, unknown>
  const items = (['comments', 'list', 'data', 'hotComments', 'newComments'].map(key => record[key]).find(value => Array.isArray(value)) ?? []) as CommentItem[]
  const total = Math.max(items.length, Number(record.total ?? record.totalCount ?? record.commentCount ?? 0) || 0)
  const maxPage = Math.max(1, Number(record.maxPage ?? record.totalPages ?? Math.ceil(total / 20)) || 1)
  return { items, total, maxPage }
}
export const useCommentStore = create<CommentState>((set, get) => ({
  song: null, type: 'hot', page: 1, total: 0, maxPage: 1, items: [], loading: false, error: '',
  load: async (song, type = get().type, page = 1) => {
    if (!song) { set({ song: null, items: [], total: 0, maxPage: 1, page, loading: false, error: '' }); return }
    commentController?.abort(); const controller = new AbortController(); commentController = controller; set({ song, type, page, loading: true, error: '' })
    try { const result = normalizeComments(await playerApi.comments(song, type, page, 20, controller.signal)); if (!controller.signal.aborted) set({ items: result.items, total: result.total, maxPage: result.maxPage }) } catch (error) { if (!controller.signal.aborted && (error as DOMException)?.name !== 'AbortError') set({ items: [], error: error instanceof Error ? error.message : '评论加载失败' }) } finally { if (commentController === controller) { commentController = null; set({ loading: false }) } }
  },
  setType: type => { set({ type, page: 1 }); const song = get().song; if (song) void get().load(song, type, 1) },
  next: () => { const state = get(); if (state.song && state.page < state.maxPage) void state.load(state.song, state.type, state.page + 1) },
  previous: () => { const state = get(); if (state.song && state.page > 1) void state.load(state.song, state.type, state.page - 1) },
}))

type SleepTimerState = { deadline: number | null; remaining: number; setTimer: (minutes: number) => void; cancelTimer: () => void; tick: () => void }
export const useSleepTimerStore = create<SleepTimerState>((set, get) => ({
  deadline: null,
  remaining: 0,
  setTimer: (minutes) => { const safeMinutes = Math.min(24 * 60, Math.max(1, Math.round(minutes))); set({ deadline: Date.now() + safeMinutes * 60_000, remaining: safeMinutes * 60 }) },
  cancelTimer: () => set({ deadline: null, remaining: 0 }),
  tick: () => {
    const deadline = get().deadline
    if (!deadline) return
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    if (remaining > 0) set({ remaining })
    else { pauseCommand(); usePlaybackStore.setState({ isPlaying: false }); set({ deadline: null, remaining: 0 }) }
  },
}))

let searchController: AbortController | null = null
type SearchState = { query: string; source: string; type: SearchType; page: number; results: Song[]; loading: boolean; error: string; tips: string[]; hot: unknown[]; search: (query?: string, page?: number) => Promise<void>; setQuery: (query: string) => void; setType: (type: SearchType) => void; loadHot: () => Promise<void> }
export const useSearchStore = create<SearchState>((set, get) => ({
  query: '', source: 'wy', type: 'song', page: 1, results: [], loading: false, error: '', tips: [], hot: [],
  setQuery: (query) => set({ query }), setType: (type) => set({ type, page: 1 }),
  search: async (query = get().query, page = 1) => {
    if (!query.trim()) { set({ results: [], error: '请输入搜索内容' }); return }
    searchController?.abort(); const controller = new AbortController(); searchController = controller; set({ query, page, loading: true, error: '' })
    try { const results = await playerApi.search(query, get().source, get().type, page, controller.signal); if (!controller.signal.aborted) set({ results: Array.isArray(results) ? results : [] }) } catch (error) { if (!controller.signal.aborted && (error as DOMException)?.name !== 'AbortError') set({ error: error instanceof Error ? error.message : '搜索失败，请稍后重试' }) } finally { if (searchController === controller) { searchController = null; set({ loading: false }) } }
  },
  loadHot: async () => { try { set({ hot: await playerApi.hotSearch(get().source) }) } catch { set({ hot: [] }) } },
}))

type LibraryState = { data: UserListData; loading: boolean; error: string; hydrate: () => Promise<void>; addSong: (listId: string, song: Song) => Promise<void>; removeSong: (listId: string, song: Song) => Promise<void>; createList: (name: string) => Promise<void>; renameList: (listId: string, name: string) => Promise<void>; deleteList: (listId: string) => Promise<void> }
export const useLibraryStore = create<LibraryState>((set, get) => ({
  data: { defaultList: [], loveList: [], userList: [] }, loading: false, error: '',
  hydrate: async () => { set({ loading: true }); try { set({ data: await playerApi.listData(), error: '' }) } catch (error) { set({ error: error instanceof Error ? error.message : '歌单加载失败' }) } finally { set({ loading: false }) } },
  addSong: async (listId, song) => { await playerApi.addToList(listId, [song]); await get().hydrate() },
  removeSong: async (listId, song) => { await playerApi.removeFromList(listId, [String(song.songmid ?? song.id)]); await get().hydrate() },
  createList: async (name) => { const data = get().data; const list = { id: `list_${Date.now()}`, name, list: [] }; await playerApi.saveListData({ ...data, userList: [...(data.userList ?? []), list] }); await get().hydrate() },
  renameList: async (listId, name) => { const data = get().data; const userList = (data.userList ?? []).map(list => String(list.id) === String(listId) ? { ...list, name } : list); await playerApi.saveListData({ ...data, userList }); await get().hydrate() },
  deleteList: async (listId) => { const data = get().data; await playerApi.saveListData({ ...data, userList: (data.userList ?? []).filter(list => String(list.id) !== String(listId)) }); await get().hydrate() },
}))

type PlaybackState = { queue: Song[]; currentIndex: number; currentSong: Song | null; isPlaying: boolean; currentTime: number; duration: number; volume: number; muted: boolean; mode: PlayMode; quality: string; resolving: boolean; error: string; playSong: (song: Song, queue?: Song[], index?: number) => void; toggle: () => void; setPlaying: (isPlaying: boolean) => void; setProgress: (time: number, duration?: number) => void; setVolume: (volume: number) => void; toggleMute: () => void; setMode: (mode: PlayMode) => void; setQuality: (quality: string) => void; seek: (time: number) => void; next: () => void; previous: () => void; enqueue: (songs: Song[]) => void; removeFromQueue: (index: number) => void; hydrate: () => void }

let playCommand: () => void = () => undefined
let pauseCommand: () => void = () => undefined
let seekCommand: (time: number) => void = () => undefined
let volumeCommand: (volume: number) => void = () => undefined
let lastPlaybackPersistAt = 0
export function connectAudioCommands(commands: { play: () => void; pause: () => void; seek: (time: number) => void; volume: (volume: number) => void }) { playCommand = commands.play; pauseCommand = commands.pause; seekCommand = commands.seek; volumeCommand = commands.volume }

function persistPlayback(state: Pick<PlaybackState, 'currentSong' | 'currentIndex' | 'currentTime' | 'queue' | 'mode' | 'quality'>) {
  writeJson(localStorage, 'lx_playback_state', { song: state.currentSong, index: state.currentIndex, time: state.currentTime, playlist: state.queue.slice(0, 300), playMode: state.mode, quality: state.quality, timestamp: Date.now() })
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  queue: [], currentIndex: -1, currentSong: null, isPlaying: false, currentTime: 0, duration: 0, volume: (() => { const value = Number(localStorage.getItem('lx_volume') ?? 0.8); return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8 })(), muted: false, mode: (['list', 'single', 'random'] as PlayMode[]).includes(readString(localStorage, 'lx_play_mode', 'list') as PlayMode) ? readString(localStorage, 'lx_play_mode', 'list') as PlayMode : 'list', quality: 'flac', resolving: false, error: '',
  // Loading a new song is asynchronous. Calling audio.play() here would run
  // against the previous source, and its rejected promise could later switch
  // the newly selected song back to the paused state. AudioRuntime owns the
  // actual play call after the new source is ready.
  playSong: (song, queue = get().queue, index = Math.max(0, queue.findIndex(item => songKey(item) === songKey(song)))) => { const nextQueue = queue.length ? queue : [song]; const nextIndex = index >= 0 ? index : nextQueue.findIndex(item => songKey(item) === songKey(song)); const next = { currentSong: song, queue: nextQueue, currentIndex: nextIndex, currentTime: 0, isPlaying: true, error: '' }; set(next); persistPlayback({ ...get(), ...next }) },
  toggle: () => { if (get().isPlaying) { pauseCommand(); set({ isPlaying: false }) } else { playCommand(); set({ isPlaying: true }) } },
  setPlaying: (isPlaying) => set({ isPlaying }),
  setProgress: (currentTime, duration) => { set({ currentTime, ...(duration !== undefined ? { duration } : {}) }); if (Date.now() - lastPlaybackPersistAt >= 3000) { lastPlaybackPersistAt = Date.now(); persistPlayback({ ...get(), currentTime }) } },
  setVolume: (volume) => { const next = Math.min(1, Math.max(0, volume)); writeString(localStorage, 'lx_volume', String(next)); volumeCommand(next); set({ volume: next, muted: next === 0 }) },
  toggleMute: () => set(state => { const muted = !state.muted; volumeCommand(muted ? 0 : state.volume || 0.8); return { muted } }),
  setMode: (mode) => { writeString(localStorage, 'lx_play_mode', mode); set({ mode }); persistPlayback({ ...get(), mode }) },
  setQuality: (quality) => { const next = String(quality || 'flac'); set({ quality: next }); persistPlayback({ ...get(), quality: next }) },
  seek: (time) => { seekCommand(time); set({ currentTime: time }) },
  next: () => { const { queue, currentIndex, mode } = get(); if (!queue.length) return; const index = mode === 'random' ? Math.floor(Math.random() * queue.length) : (currentIndex + 1) % queue.length; const song = queue[index]; if (song) get().playSong(song, queue, index) },
  previous: () => { const { queue, currentIndex } = get(); if (!queue.length) return; const index = (currentIndex - 1 + queue.length) % queue.length; get().playSong(queue[index], queue, index) },
  enqueue: (songs) => { const next = { ...get(), queue: [...get().queue, ...songs.filter(song => !get().queue.some(item => songKey(item) === songKey(song)))] }; set({ queue: next.queue }); persistPlayback(next) },
  removeFromQueue: (index) => { const state = get(); const queue = state.queue.filter((_, itemIndex) => itemIndex !== index); const currentIndex = state.currentIndex > index ? state.currentIndex - 1 : state.currentIndex === index ? Math.min(index, queue.length - 1) : state.currentIndex; const currentSong = currentIndex >= 0 ? queue[currentIndex] ?? null : null; set({ queue, currentIndex, currentSong }); persistPlayback({ ...state, queue, currentIndex, currentSong }) },
  hydrate: () => { const saved = readJson<{ song?: Song; index?: number; time?: number; playlist?: Song[]; playMode?: PlayMode; quality?: string }>(localStorage, 'lx_playback_state', {}); if (saved.playlist?.length) set({ currentSong: saved.song ?? saved.playlist[saved.index ?? 0] ?? null, currentIndex: saved.index ?? 0, currentTime: saved.time ?? 0, queue: saved.playlist, mode: saved.playMode ?? get().mode, quality: saved.quality ?? 'flac' }) },
}))

type LyricState = { lines: LyricLine[]; loading: boolean; error: string; activeIndex: number; load: (song: Song | null) => Promise<void> }
let lyricController: AbortController | null = null
export const useLyricStore = create<LyricState>((set) => ({ lines: [], loading: false, error: '', activeIndex: -1, load: async (song) => { if (!song) { set({ lines: [], activeIndex: -1 }); return } lyricController?.abort(); const controller = new AbortController(); lyricController = controller; set({ loading: true, error: '' }); try { const payload = await playerApi.lyric(song, controller.signal); if (!controller.signal.aborted) set({ lines: parseLyric(payload), activeIndex: -1 }) } catch (error) { if (!controller.signal.aborted && (error as DOMException)?.name !== 'AbortError') set({ error: error instanceof Error ? error.message : '歌词加载失败' }) } finally { if (lyricController === controller) { lyricController = null; set({ loading: false }) } } } }))

type CacheState = { tasks: import('./api').CacheTask[]; stats: import('./api').CacheStats | null; loading: boolean; load: () => Promise<void>; enqueue: (song: Song, quality?: string, resolvedUrl?: string) => Promise<void>; remove: (id: string) => Promise<void> }
export const useCacheStore = create<CacheState>((set, get) => ({ tasks: [], stats: null, loading: false, load: async () => { set({ loading: true }); try { const [queue, stats] = await Promise.all([playerApi.cacheQueue(), playerApi.cacheStats()]); set({ tasks: queue.data ?? [], stats: stats.data ?? null }) } catch { /* cache is optional in public mode */ } finally { set({ loading: false }) } }, enqueue: async (song, quality = 'flac', resolvedUrl) => { const key = songKey(song); await playerApi.queueTasks([{ id: key, songInfo: song, quality, ...(resolvedUrl ? { resolvedUrl } : {}) }]); await get().load() }, remove: async (id) => { await playerApi.removeQueue(id); await get().load() } }))
