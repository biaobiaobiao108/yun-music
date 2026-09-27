import { create } from 'zustand'
import { readJson, readString, writeJson, writeString } from '../../../../shared/src/storage'
import { subscribePlaybackService, type PlaybackServiceEvent } from '../playback_service'
import { scopedStorageKey } from '../session'
import type { PlayMode, Song } from '../types'
import { songKey } from '../types'
import { browserStorage } from './shared'

export type PlaybackState = {
  queue: Song[]
  currentIndex: number
  currentSong: Song | null
  priorityNextSongKey: string | null
  hasHydrated: boolean
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  mode: PlayMode
  quality: string
  /** The exact source URL that resolved the current track, kept in memory for download reuse. */
  resolvedUrl: string | null
  resolving: boolean
  error: string
  playSong: (song: Song, queue?: Song[], index?: number) => void
  toggle: () => void
  setPlaying: (isPlaying: boolean) => void
  setProgress: (time: number, duration?: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  setMode: (mode: PlayMode) => void
  setQuality: (quality: string) => void
  setResolvedUrl: (url: string | null) => void
  setCurrentSongUrl: (url: string) => void
  seek: (time: number) => void
  next: () => void
  previous: () => void
  enqueue: (songs: Song[]) => void
  moveQueueItem: (fromIndex: number, toIndex: number) => void
  playNext: (song: Song) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  reset: () => void
  hydrate: () => void
}

let playCommand: () => void = () => undefined
let pauseCommand: () => void = () => undefined
let seekCommand: (time: number) => void = () => undefined
let volumeCommand: (volume: number) => void = () => undefined
let lastPlaybackPersistAt = 0
type PersistedPlaybackState = Pick<PlaybackState, 'currentSong' | 'currentIndex' | 'currentTime' | 'queue' | 'mode' | 'quality' | 'priorityNextSongKey'>
type PlaybackPersistHandle = number | ReturnType<typeof setTimeout>
let pendingPlaybackState: PersistedPlaybackState | null = null
let playbackPersistHandle: PlaybackPersistHandle | null = null

export function connectAudioCommands(commands: { play: () => void; pause: () => void; seek: (time: number) => void; volume: (volume: number) => void }): void {
  playCommand = commands.play
  pauseCommand = commands.pause
  seekCommand = commands.seek
  volumeCommand = commands.volume
}

export function pausePlaybackCommand(): void {
  pauseCommand()
}

const initialVolume = (() => {
  const value = Number(readString(browserStorage(), 'lx_volume', '0.8'))
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8
})()

function persistPlayback(state: PersistedPlaybackState): void {
  writeJson(browserStorage(), scopedStorageKey('lx_playback_state'), {
    song: state.currentSong,
    index: state.currentIndex,
    time: state.currentTime,
    playlist: state.queue.slice(0, 300),
    playMode: state.mode,
    quality: state.quality,
    priorityNextSongKey: state.priorityNextSongKey,
    timestamp: Date.now(),
  })
}

function cancelScheduledPlaybackPersist(): void {
  if (playbackPersistHandle === null) return
  const idleWindow = typeof window === 'undefined' ? null : window as Window & {
    cancelIdleCallback?: (handle: number) => void
  }
  if (idleWindow?.cancelIdleCallback && typeof playbackPersistHandle === 'number') {
    idleWindow.cancelIdleCallback(playbackPersistHandle)
  } else {
    clearTimeout(playbackPersistHandle as ReturnType<typeof setTimeout>)
  }
  playbackPersistHandle = null
}

function persistPlaybackNow(state: PersistedPlaybackState): void {
  cancelScheduledPlaybackPersist()
  pendingPlaybackState = null
  persistPlayback(state)
}

function schedulePlaybackPersist(state: PersistedPlaybackState): void {
  pendingPlaybackState = {
    ...state,
    // The queue is the largest part of this local snapshot. Keep the existing
    // resume contract while copying it only once per scheduled write.
    queue: state.queue.slice(0, 300),
  }
  if (playbackPersistHandle !== null) return

  const flush = () => {
    playbackPersistHandle = null
    const next = pendingPlaybackState
    pendingPlaybackState = null
    if (next) persistPlayback(next)
  }
  const idleWindow = typeof window === 'undefined' ? null : window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }
  playbackPersistHandle = idleWindow?.requestIdleCallback
    ? idleWindow.requestIdleCallback(flush, { timeout: 1200 })
    : setTimeout(flush, 180)
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  queue: [],
  currentIndex: -1,
  currentSong: null,
  priorityNextSongKey: null,
  hasHydrated: false,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: initialVolume,
  muted: initialVolume === 0,
  mode: (['list', 'single', 'random'] as PlayMode[]).includes(readString(browserStorage(), 'lx_play_mode', 'list') as PlayMode)
    ? readString(browserStorage(), 'lx_play_mode', 'list') as PlayMode
    : 'list',
  quality: 'flac',
  resolvedUrl: null,
  resolving: false,
  error: '',
  // Loading a new song is asynchronous. AudioRuntime owns the actual play
  // call after the new source is ready.
  playSong: (song, queue = get().queue, index = Math.max(0, queue.findIndex(item => songKey(item) === songKey(song)))) => {
    const nextQueue = queue.length ? queue : [song]
    const nextIndex = index >= 0 ? index : nextQueue.findIndex(item => songKey(item) === songKey(song))
    const state = get()
    const priorityNextSongKey = state.priorityNextSongKey === songKey(song) ? null : state.priorityNextSongKey
    const next = { currentSong: song, queue: nextQueue, currentIndex: nextIndex, currentTime: 0, isPlaying: true, resolvedUrl: null, error: '', priorityNextSongKey }
    set(next)
    persistPlaybackNow({ ...get(), ...next })
  },
  toggle: () => {
    if (get().isPlaying) {
      pauseCommand()
      set({ isPlaying: false })
      persistPlaybackNow(get())
    } else {
      playCommand()
      set({ isPlaying: true })
    }
  },
  setPlaying: isPlaying => {
    set({ isPlaying })
    if (!isPlaying) persistPlaybackNow(get())
  },
  setProgress: (currentTime, duration) => {
    set({ currentTime, ...(duration !== undefined ? { duration } : {}) })
    const now = Date.now()
    if (now - lastPlaybackPersistAt >= 5000) {
      lastPlaybackPersistAt = now
      schedulePlaybackPersist({ ...get(), currentTime })
    }
  },
  setVolume: volume => {
    const next = Math.min(1, Math.max(0, volume))
    writeString(browserStorage(), 'lx_volume', String(next))
    volumeCommand(next)
    set({ volume: next, muted: next === 0 })
  },
  toggleMute: () => {
    const state = get()
    if (!state.muted) {
      volumeCommand(0)
      set({ muted: true })
      return
    }
    const restored = state.volume > 0 ? state.volume : 0.8
    writeString(browserStorage(), 'lx_volume', String(restored))
    volumeCommand(restored)
    set({ volume: restored, muted: false })
  },
  setMode: mode => {
    writeString(browserStorage(), 'lx_play_mode', mode)
    set({ mode })
    persistPlaybackNow({ ...get(), mode })
  },
  setQuality: quality => {
    const next = String(quality || 'flac')
    set({ quality: next })
    persistPlaybackNow({ ...get(), quality: next })
  },
  setResolvedUrl: resolvedUrl => set({ resolvedUrl }),
  setCurrentSongUrl: url => {
    const state = get()
    if (!state.currentSong) return
    const currentKey = songKey(state.currentSong)
    const currentSong = { ...state.currentSong, url }
    const queue = state.queue.map(song => songKey(song) === currentKey ? { ...song, url } : song)
    set({ currentSong, queue })
    persistPlaybackNow({ ...state, currentSong, queue })
  },
  seek: time => {
    seekCommand(time)
    set({ currentTime: time })
  },
  next: () => {
    const { queue, currentIndex, mode, priorityNextSongKey } = get()
    if (!queue.length) return
    if (priorityNextSongKey) {
      const priorityIndex = queue.findIndex(song => songKey(song) === priorityNextSongKey)
      if (priorityIndex >= 0) {
        const prioritySong = queue[priorityIndex]
        if (prioritySong) get().playSong(prioritySong, queue, priorityIndex)
        return
      }
      set({ priorityNextSongKey: null })
    }
    const index = mode === 'random' ? Math.floor(Math.random() * queue.length) : (currentIndex + 1) % queue.length
    const song = queue[index]
    if (song) get().playSong(song, queue, index)
  },
  previous: () => {
    const { queue, currentIndex } = get()
    if (!queue.length) return
    const index = (currentIndex - 1 + queue.length) % queue.length
    get().playSong(queue[index], queue, index)
  },
  enqueue: songs => {
    const current = get().queue
    const queuedKeys = new Set(current.map(songKey))
    const additions = songs.filter(song => {
      const key = songKey(song)
      if (queuedKeys.has(key)) return false
      queuedKeys.add(key)
      return true
    })
    const queue = [...current, ...additions]
    set({ queue })
    persistPlaybackNow({ ...get(), queue })
  },
  moveQueueItem: (fromIndex, toIndex) => {
    const state = get()
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= state.queue.length || toIndex >= state.queue.length) return
    const queue = [...state.queue]
    const [song] = queue.splice(fromIndex, 1)
    if (!song) return
    queue.splice(toIndex, 0, song)
    const currentIndex = state.currentSong ? queue.findIndex(item => songKey(item) === songKey(state.currentSong as Song)) : -1
    const priorityNextSongKey = state.priorityNextSongKey && queue.some(item => songKey(item) === state.priorityNextSongKey)
      ? state.priorityNextSongKey
      : null
    set({ queue, currentIndex, priorityNextSongKey })
    persistPlaybackNow({ ...state, queue, currentIndex, priorityNextSongKey })
  },
  playNext: song => {
    const state = get()
    const key = songKey(song)
    if (!key || state.currentSong && songKey(state.currentSong) === key) return
    const existingIndex = state.queue.findIndex(item => songKey(item) === key)
    const queuedSong = existingIndex >= 0 ? state.queue[existingIndex] : song
    const queue = state.queue.filter(item => songKey(item) !== key)
    const currentKey = state.currentSong ? songKey(state.currentSong) : ''
    const currentIndexBeforeInsert = currentKey ? queue.findIndex(item => songKey(item) === currentKey) : -1
    const insertAt = currentIndexBeforeInsert >= 0 ? currentIndexBeforeInsert + 1 : 0
    queue.splice(insertAt, 0, queuedSong)
    if (currentIndexBeforeInsert < 0) {
      get().playSong(queuedSong, queue, insertAt)
      return
    }
    const currentIndex = queue.findIndex(item => songKey(item) === currentKey)
    const next = { ...state, queue, currentIndex, priorityNextSongKey: key }
    set({ queue, currentIndex, priorityNextSongKey: key })
    persistPlaybackNow(next)
  },
  removeFromQueue: index => {
    const state = get()
    if (index < 0 || index >= state.queue.length) return
    const removingCurrent = state.currentIndex === index
    const removedSongKey = songKey(state.queue[index] as Song)
    const queue = state.queue.filter((_, itemIndex) => itemIndex !== index)
    if (!queue.length) {
      pauseCommand()
      set({ queue: [], currentIndex: -1, currentSong: null, isPlaying: false, currentTime: 0, duration: 0, resolvedUrl: null, priorityNextSongKey: null })
      persistPlaybackNow({ ...state, queue: [], currentIndex: -1, currentSong: null, currentTime: 0, priorityNextSongKey: null })
      return
    }
    if (removingCurrent) {
      const nextIndex = Math.min(index, queue.length - 1)
      get().playSong(queue[nextIndex], queue, nextIndex)
      return
    }
    const currentIndex = state.currentIndex > index ? state.currentIndex - 1 : state.currentIndex
    const currentSong = currentIndex >= 0 ? queue[currentIndex] ?? null : null
    const priorityNextSongKey = state.priorityNextSongKey === removedSongKey ? null : state.priorityNextSongKey
    set({ queue, currentIndex, currentSong, priorityNextSongKey })
    persistPlaybackNow({ ...state, queue, currentIndex, currentSong, priorityNextSongKey })
  },
  clearQueue: () => {
    const state = get()
    if (!state.queue.length && !state.currentSong && !state.isPlaying && state.currentIndex < 0 && state.currentTime === 0 && state.duration === 0 && !state.resolvedUrl && !state.resolving && !state.error && !state.priorityNextSongKey) return
    pauseCommand()
    const cleared = {
      queue: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      resolvedUrl: null,
      resolving: false,
      error: '',
      priorityNextSongKey: null,
    }
    set(cleared)
    persistPlaybackNow({ ...state, ...cleared })
  },
  reset: () => {
    pauseCommand()
    cancelScheduledPlaybackPersist()
    pendingPlaybackState = null
    lastPlaybackPersistAt = 0
    set({
      queue: [],
      currentIndex: -1,
      currentSong: null,
      priorityNextSongKey: null,
      hasHydrated: false,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      mode: 'list',
      quality: 'flac',
      resolvedUrl: null,
      resolving: false,
      error: '',
    })
  },
  hydrate: () => {
    const saved = readJson<{ song?: Song; index?: number; time?: number; playlist?: Song[]; playMode?: PlayMode; quality?: string; priorityNextSongKey?: string | null }>(browserStorage(), scopedStorageKey('lx_playback_state'), {})
    const queue = Array.isArray(saved.playlist) ? saved.playlist : []
    const savedIndex = Number.isInteger(saved.index) ? Number(saved.index) : -1
    const matchingIndex = saved.song ? queue.findIndex(song => songKey(song) === songKey(saved.song as Song)) : -1
    const currentIndex = queue.length
      ? matchingIndex >= 0 ? matchingIndex : Math.min(Math.max(savedIndex, 0), queue.length - 1)
      : -1
    const currentSong = currentIndex >= 0 ? queue[currentIndex] ?? null : null
    const requestedNextKey = typeof saved.priorityNextSongKey === 'string' ? saved.priorityNextSongKey : null
    set({
      hasHydrated: true,
      currentSong,
      currentIndex,
      currentTime: currentSong && Number.isFinite(saved.time) ? Math.max(0, Number(saved.time)) : 0,
      queue,
      mode: saved.playMode ?? get().mode,
      quality: saved.quality ?? 'flac',
      priorityNextSongKey: requestedNextKey && queue.some(song => songKey(song) === requestedNextKey) ? requestedNextKey : null,
    })
  },
}))

export function connectPlaybackServiceStore(): () => void {
  return subscribePlaybackService((event: PlaybackServiceEvent) => {
    const state = usePlaybackStore.getState()
    if (event.type === 'play') state.setPlaying(true)
    else if (event.type === 'pause') state.setPlaying(false)
    else if (event.type === 'progress') state.setProgress(event.currentTime, event.duration)
    else if (event.type === 'loaded') usePlaybackStore.setState({ duration: event.duration })
    else if (event.type === 'error') usePlaybackStore.setState({ isPlaying: false, error: event.message })
  })
}
