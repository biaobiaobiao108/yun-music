import { describe, expect, it, spyOn } from 'bun:test'
import { readFileSync } from 'fs'
import { runInNewContext } from 'vm'
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

describe('service worker cache ownership', () => {
  for (const [app, prefix, otherPrefix] of [
    ['admin', 'yun-yin-admin-react-', 'yun-yin-web-react-'],
    ['player', 'yun-yin-web-react-', 'yun-yin-admin-react-'],
  ]) {
    it(`${app} activation removes only its own stale caches`, async () => {
      const source = readFileSync(new URL(`../frontend/${app}/src/sw.js`, import.meta.url), 'utf8')
      const currentCaches = [...source.matchAll(/const (?:CACHE_NAME|VERSIONED_ASSET_CACHE) = '([^']+)'/g)].map(
        match => match[1]!,
      )
      const otherCaches = [`${otherPrefix}old`, `${otherPrefix}assets-old`, 'another-app-cache']
      const staleCaches = [`${prefix}old`, `${prefix}assets-old`]
      const removed: string[] = []
      let activate: ((event: { waitUntil: (promise: Promise<unknown>) => void }) => void) | undefined
      runInNewContext(source, {
        self: {
          addEventListener: (name: string, listener: typeof activate) => {
            if (name === 'activate') activate = listener
          },
          clients: { claim: () => undefined },
        },
        caches: {
          keys: async () => [...currentCaches, ...otherCaches, ...staleCaches],
          delete: async (name: string) => {
            removed.push(name)
            return true
          },
        },
        console: { log: () => undefined },
      })
      expect(activate).toBeDefined()
      let completion: Promise<unknown> | undefined
      activate?.({
        waitUntil: promise => {
          completion = promise
        },
      })
      await completion
      expect(removed.sort()).toEqual(staleCaches.sort())
    })
  }
})
