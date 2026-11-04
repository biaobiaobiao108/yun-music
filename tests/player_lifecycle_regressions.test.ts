import { describe, expect, it, spyOn } from 'bun:test'
import {
  connectAudioCommands,
  readPlaybackPosition,
  usePlaybackStore,
} from '../frontend/player/src/react/store/playback'
import { useSleepTimerStore } from '../frontend/player/src/react/store/sleep'

describe('playback sleep deadline', () => {
  it('pauses at its deadline without mounting a dialog and respects cancellation', () => {
    const originalSetTimeout = globalThis.setTimeout
    let expire: (() => void) | undefined
    let now = 1000
    let pauses = 0
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      expire = callback
      return originalSetTimeout(() => undefined, 60_000)
    }) as typeof setTimeout)
    const date = spyOn(Date, 'now').mockImplementation(() => now)
    const initialPlayback = usePlaybackStore.getState()
    connectAudioCommands({
      play: () => undefined,
      pause: () => {
        pauses += 1
      },
      seek: () => undefined,
      volume: () => undefined,
    })
    try {
      usePlaybackStore.setState({ isPlaying: true })
      useSleepTimerStore.getState().setTimer(1)
      expect(expire).toBeDefined()
      now += 60_000
      expire?.()
      expect(pauses).toBe(1)
      expect(usePlaybackStore.getState().isPlaying).toBe(false)
      expect(useSleepTimerStore.getState().deadline).toBeNull()

      useSleepTimerStore.getState().setTimer(1)
      useSleepTimerStore.getState().cancelTimer()
      now += 60_000
      expire?.()
      expect(pauses).toBe(1)
    } finally {
      useSleepTimerStore.getState().cancelTimer()
      timeout.mockRestore()
      date.mockRestore()
      usePlaybackStore.setState(initialPlayback)
      connectAudioCommands({
        play: () => undefined,
        pause: () => undefined,
        seek: () => undefined,
        volume: () => undefined,
      })
    }
  })
})

describe('seek before metadata', () => {
  it('ignores seeks without a known duration and clamps to the duration', () => {
    const initialPlayback = usePlaybackStore.getState()
    try {
      usePlaybackStore.setState({ currentTime: 5, duration: 0 })
      usePlaybackStore.getState().seek(10)
      expect(usePlaybackStore.getState().currentTime).toBe(5)

      usePlaybackStore.setState({ duration: 100 })
      usePlaybackStore.getState().seek(120)
      expect(usePlaybackStore.getState().currentTime).toBe(100)
    } finally {
      usePlaybackStore.setState(initialPlayback)
    }
  })
})

describe('lyric playback clock', () => {
  it('uses confirmed media time instead of elapsed wall time', () => {
    const initialPlayback = usePlaybackStore.getState()
    let mediaTime = 10
    const requests: number[] = []
    const disconnect = connectAudioCommands({
      play: () => undefined,
      pause: () => undefined,
      seek: time => requests.push(time),
      volume: () => undefined,
      position: () => mediaTime,
    })
    try {
      usePlaybackStore.setState({
        currentSong: { source: 'wy', songmid: 'media-clock-test' },
        isPlaying: true,
        currentTime: 10,
        duration: 120,
      })
      usePlaybackStore.getState().seek(70)
      expect(readPlaybackPosition()).toBe(10)
      // Late progress from before the seek cannot move the lyric clock.
      usePlaybackStore.getState().setProgress(10.2)
      mediaTime = 70
      expect(readPlaybackPosition()).toBe(70)
      expect(readPlaybackPosition()).toBe(70)
      mediaTime = 70.5
      expect(readPlaybackPosition()).toBe(70.5)
      usePlaybackStore.getState().seek(3)
      mediaTime = 3
      usePlaybackStore.getState().setPlaying(false)
      expect(readPlaybackPosition()).toBe(3)
      usePlaybackStore.getState().seek(Number.NaN)
      usePlaybackStore.getState().seek(Number.POSITIVE_INFINITY)
      usePlaybackStore.getState().seek(-5)
      usePlaybackStore.getState().seek(200)
      expect(requests).toEqual([70, 3, 0, 120])
    } finally {
      disconnect()
      usePlaybackStore.setState(initialPlayback)
    }
  })

  it('falls back to the stored progress when no media clock is connected', () => {
    const initialPlayback = usePlaybackStore.getState()
    const disconnect = connectAudioCommands({
      play: () => undefined,
      pause: () => undefined,
      seek: () => undefined,
      volume: () => undefined,
    })
    try {
      usePlaybackStore.setState({
        currentSong: { source: 'wy', songmid: 'clock-test' },
        isPlaying: true,
        currentTime: 10,
        duration: 120,
      })
      expect(readPlaybackPosition()).toBe(10)
      usePlaybackStore.getState().setProgress(70.15, 120)
      expect(readPlaybackPosition()).toBe(70.15)
      usePlaybackStore.setState({ currentSong: null })
      expect(readPlaybackPosition()).toBeNull()
    } finally {
      disconnect()
      usePlaybackStore.setState(initialPlayback)
    }
  })
})

describe('playback switch priming and crossfade state', () => {
  it('reports wasPlaying false when switching while paused or idle', () => {
    const initialPlayback = usePlaybackStore.getState()
    const primeCalls: Array<{ wasPlaying?: boolean } | undefined> = []
    const disconnect = connectAudioCommands({
      play: () => undefined,
      pause: () => undefined,
      seek: () => undefined,
      volume: () => undefined,
      prime: options => primeCalls.push(options),
    })
    try {
      usePlaybackStore.setState({
        currentSong: { source: 'wy', songmid: 'song-1' },
        isPlaying: false,
      })
      usePlaybackStore.getState().playSong({ source: 'wy', songmid: 'song-2' })
      expect(primeCalls).toHaveLength(1)
      expect(primeCalls[0]?.wasPlaying).toBe(false)
    } finally {
      disconnect()
      usePlaybackStore.setState(initialPlayback)
    }
  })

  it('reports wasPlaying true when switching while actively playing', () => {
    const initialPlayback = usePlaybackStore.getState()
    const primeCalls: Array<{ wasPlaying?: boolean } | undefined> = []
    const disconnect = connectAudioCommands({
      play: () => undefined,
      pause: () => undefined,
      seek: () => undefined,
      volume: () => undefined,
      prime: options => primeCalls.push(options),
    })
    try {
      usePlaybackStore.setState({
        currentSong: { source: 'wy', songmid: 'song-1' },
        isPlaying: true,
      })
      usePlaybackStore.getState().playSong({ source: 'wy', songmid: 'song-2' })
      expect(primeCalls).toHaveLength(1)
      expect(primeCalls[0]?.wasPlaying).toBe(true)
    } finally {
      disconnect()
      usePlaybackStore.setState(initialPlayback)
    }
  })
})
