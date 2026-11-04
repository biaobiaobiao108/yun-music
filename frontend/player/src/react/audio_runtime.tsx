import { useEffect, useRef, useState } from 'react'
import { playerApi } from './api'
import {
  connectAudioCommands,
  useAuthStore,
  useCacheStore,
  usePlaybackStore,
  usePlayerUiStore,
  useRecentStore,
  useSettingsStore,
} from './store'
import { songAlbum, songArtist, songImage, songKey, songTitle, type Song } from './types'
import { safeImageUrl } from '../../../shared/src/runtime'
import { emitPlaybackService } from './playback_service'
import { buildPlaybackUrl, normalizeCachePlaybackUrl, parseCachePlaybackUrl } from './media_url'
import { beginSeek, isSeekSettled, readMediaClock, resolveMediaClock, type SeekHold } from './media_clock'
import { getSessionGeneration } from './session'
import { clearPlayerPerformanceMark, markPlayerPerformance, measurePlayerPerformance } from './performance'

const QUALITY_FALLBACKS = ['hires', 'flac', '320k', '128k']
type SongUrlResult = {
  url: string
  quality?: string
  type?: string
  sourceName?: string
  fromCache?: boolean
  downloadToken?: string
}
type PendingSongUrlRequest = {
  promise: Promise<SongUrlResult>
  controller: AbortController
  consumers: number
  settled: boolean
}

type CachedSongUrl = { result: SongUrlResult; expiresAt: number }
const prefetchedUrls = new Map<string, CachedSongUrl>()
const pendingSongUrlRequests = new Map<string, PendingSongUrlRequest>()
const SONG_URL_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHED_SONG_URLS = 16
const CROSSFADE_DURATION_MS = 300
/** Store/React publish cadence for playback progress; shared by events and the timer. */
const PROGRESS_EMIT_INTERVAL_MS = 200
let songUrlCacheGeneration = getSessionGeneration()

type ScreenWakeLockSentinel = {
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void, options?: AddEventListenerOptions | boolean) => void
}
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<ScreenWakeLockSentinel> }
}

function songUrlPerformanceName(key: string): string {
  return `yun-music:url:${encodeURIComponent(key).slice(0, 160)}`
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function isSameMediaSource(currentSrc: string, targetUrl: string): boolean {
  if (!currentSrc || !targetUrl) return false
  if (currentSrc === targetUrl) return true
  try {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    return new URL(currentSrc, origin).href === new URL(targetUrl, origin).href
  } catch {
    return false
  }
}

function setMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
  if (!('mediaSession' in navigator)) return
  try {
    if (navigator.mediaSession.playbackState !== state) navigator.mediaSession.playbackState = state
  } catch {
    /* media session may be unavailable in this context */
  }
}

function syncMediaSessionMetadata(song: Song | null): void {
  if (!('mediaSession' in navigator)) return
  if (!song) {
    navigator.mediaSession.metadata = null
    setMediaSessionPlaybackState('none')
    try {
      navigator.mediaSession.setPositionState?.()
    } catch {}
    return
  }
  const artwork = safeImageUrl(songImage(song))
  const title = songTitle(song)
  const artist = songArtist(song)
  const album = songAlbum(song)
  try {
    const artworkUrl = new URL(artwork, document.baseURI).href
    const current = navigator.mediaSession.metadata
    if (
      current?.title === title &&
      current.artist === artist &&
      current.album === album &&
      current.artwork[0]?.src === artworkUrl
    )
      return
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork: [
        { src: artworkUrl, sizes: '512x512' },
        { src: artworkUrl, sizes: '256x256' },
        { src: artworkUrl, sizes: '128x128' },
      ],
    })
  } catch {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
    })
  }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function joinSongUrlRequest(entry: PendingSongUrlRequest, signal?: AbortSignal): Promise<SongUrlResult> {
  entry.consumers += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    entry.consumers -= 1
    if (!entry.settled && entry.consumers <= 0) entry.controller.abort()
  }
  return withAbort(entry.promise, signal).finally(release)
}

function songUrlCacheKey(song: Song, quality: string): string {
  const generation = getSessionGeneration()
  if (generation !== songUrlCacheGeneration) {
    prefetchedUrls.clear()
    for (const entry of pendingSongUrlRequests.values()) entry.controller.abort()
    pendingSongUrlRequests.clear()
    songUrlCacheGeneration = generation
  }
  return `${generation}:${songKey(song)}:${quality}`
}

function requestSongUrl(
  song: Song,
  quality: string,
  enableAutoSwitchSource: boolean,
  signal?: AbortSignal,
  priority: 'high' | 'low' = 'high',
  refresh = false,
): Promise<SongUrlResult> {
  const key = songUrlCacheKey(song, quality)
  if (signal?.aborted) return Promise.reject(abortError())
  if (refresh) prefetchedUrls.delete(key)
  const cached = prefetchedUrls.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    prefetchedUrls.delete(key)
    prefetchedUrls.set(key, cached)
    return Promise.resolve(cached.result)
  }
  if (cached) prefetchedUrls.delete(key)
  const pending = pendingSongUrlRequests.get(key)
  if (pending && !pending.controller.signal.aborted) return joinSongUrlRequest(pending, signal)

  const performanceName = songUrlPerformanceName(key)
  markPlayerPerformance(`${performanceName}:start`)
  const controller = new AbortController()
  let entry: PendingSongUrlRequest
  const request = playerApi
    .songUrl(song, quality, controller.signal, enableAutoSwitchSource, priority)
    .then(
      result => {
        markPlayerPerformance(`${performanceName}:end`)
        measurePlayerPerformance(
          `yun-music:url:${encodeURIComponent(key).slice(0, 160)}`,
          `${performanceName}:start`,
          `${performanceName}:end`,
        )
        if (result.url) {
          const now = Date.now()
          for (const [cachedKey, cachedUrl] of prefetchedUrls) {
            if (cachedUrl.expiresAt <= now) prefetchedUrls.delete(cachedKey)
          }
          prefetchedUrls.delete(key)
          prefetchedUrls.set(key, { result, expiresAt: now + SONG_URL_CACHE_TTL_MS })
          while (prefetchedUrls.size > MAX_CACHED_SONG_URLS) {
            const oldestKey = prefetchedUrls.keys().next().value
            if (oldestKey === undefined) break
            prefetchedUrls.delete(oldestKey)
          }
        }
        return result
      },
      error => {
        markPlayerPerformance(`${performanceName}:end`)
        measurePlayerPerformance(
          `yun-music:url:${encodeURIComponent(key).slice(0, 160)}`,
          `${performanceName}:start`,
          `${performanceName}:end`,
        )
        throw error
      },
    )
    .finally(() => {
      entry.settled = true
      if (pendingSongUrlRequests.get(key) === entry) pendingSongUrlRequests.delete(key)
    })
  entry = { promise: request, controller, consumers: 0, settled: false }
  pendingSongUrlRequests.set(key, entry)
  return joinSongUrlRequest(entry, signal)
}

export function AudioRuntime() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const currentSong = usePlaybackStore(state => state.currentSong)
  const quality = usePlaybackStore(state => state.quality)
  const isPlaying = usePlaybackStore(state => state.isPlaying)
  const setPlaying = usePlaybackStore(state => state.setPlaying)
  const setResolvedUrl = usePlaybackStore(state => state.setResolvedUrl)
  const volume = usePlaybackStore(state => state.volume)
  const muted = usePlaybackStore(state => state.muted)
  const setQuality = usePlaybackStore(state => state.setQuality)
  const recordRecent = useRecentStore(state => state.record)
  const enqueueCache = useCacheStore(state => state.enqueue)
  const settings = useSettingsStore(state => state.settings)
  const userName = useAuthStore(state => state.userName)
  const [resolvedError, setResolvedError] = useState('')
  const notify = usePlayerUiStore(state => state.notify)
  const notifyPlayback = usePlayerUiStore(state => state.notifyPlayback)
  const songId = currentSong ? songKey(currentSong) : ''
  const recoveryAttempts = useRef(new Set<string>())
  const cacheQueued = useRef(new Set<string>())
  const historyRecordedKey = useRef('')
  const resolvedSongKey = useRef('')
  const resolvedPlayback = useRef<{
    songKey: string
    quality: string
    url: string
    fromCache: boolean
    sourceName?: string
  } | null>(null)
  const prefetchTriggeredKey = useRef('')
  const prefetchIdleHandle = useRef<number | null>(null)
  const prefetchController = useRef<AbortController | null>(null)
  const playbackStatusKey = useRef('')
  const lastProgressEmitAt = useRef(0)
  const confirmedAudioPosition = useRef(0)
  const pendingSeek = useRef<SeekHold | null>(null)
  const lastMediaSessionAt = useRef(0)
  const playbackTraceName = songId
    ? `yun-music:play:${encodeURIComponent(songId).slice(0, 120)}:${encodeURIComponent(quality)}`
    : ''
  const volumeTarget = useRef(muted ? 0 : volume)
  const fadeFactor = useRef(1)
  const volumeAnimation = useRef<{ cancel: () => void; finish: () => void } | null>(null)
  const crossfadeTransition = useRef<{ from: string; to: string } | null>(null)
  const crossfadeIncoming = useRef(false)
  const naturalFadeKey = useRef('')
  const naturalFadeNextSongKey = useRef('')
  const lastSwitchWasPlaying = useRef(false)
  volumeTarget.current = muted ? 0 : volume

  const syncAudioVolume = () => {
    const audio = audioRef.current
    if (audio) {
      try {
        audio.volume = Math.max(0, Math.min(1, volumeTarget.current * fadeFactor.current))
      } catch {
        // iOS Safari throws or ignores volume modification on HTMLMediaElement
      }
    }
  }

  const cancelVolumeAnimation = () => {
    const animation = volumeAnimation.current
    if (!animation) return
    volumeAnimation.current = null
    animation.cancel()
    animation.finish()
  }

  const animateVolumeFactor = (target: number, duration: number) =>
    new Promise<void>(resolve => {
      const audio = audioRef.current
      const isBackground = typeof document !== 'undefined' && document.hidden
      if (!audio || duration <= 0 || isBackground) {
        fadeFactor.current = target
        syncAudioVolume()
        resolve()
        return
      }
      cancelVolumeAnimation()
      const startFactor = fadeFactor.current
      const startTime = performance.now()
      const stepInterval = 20
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (volumeAnimation.current?.finish === finish) volumeAnimation.current = null
        resolve()
      }
      const cancel = () => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }
      const tick = () => {
        const now = performance.now()
        const progress = Math.min(1, Math.max(0, (now - startTime) / duration))
        fadeFactor.current = startFactor + (target - startFactor) * progress
        syncAudioVolume()
        if (progress >= 1) {
          fadeFactor.current = target
          syncAudioVolume()
          finish()
        } else if (volumeAnimation.current?.finish === finish) {
          timer = setTimeout(tick, stepInterval)
        }
      }
      volumeAnimation.current = { cancel, finish }
      timer = setTimeout(tick, stepInterval)
    })

  const cancelScheduledPrefetch = () => {
    prefetchController.current?.abort()
    prefetchController.current = null
    if (prefetchIdleHandle.current === null) return
    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void
    }
    if (idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(prefetchIdleHandle.current)
    else window.clearTimeout(prefetchIdleHandle.current)
    prefetchIdleHandle.current = null
  }

  /** Single reader for the lyric view, the footer and media session progress. */
  const samplePosition = (): number | null => {
    const audio = audioRef.current
    if (!audio || resolvedSongKey.current !== songId) return null
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) return null
    const resolved = resolveMediaClock(readMediaClock(audio), pendingSeek.current, Date.now(), audio.seeking)
    pendingSeek.current = resolved.hold
    if (resolved.position !== null) confirmedAudioPosition.current = resolved.position
    return confirmedAudioPosition.current
  }

  useEffect(() => {
    recoveryAttempts.current.clear()
    cacheQueued.current.clear()
    prefetchTriggeredKey.current = ''
    historyRecordedKey.current = ''
    playbackStatusKey.current = ''
  }, [userName])

  useEffect(() => {
    if (!settings.keepScreenAwake || !isPlaying) return
    let disposed = false
    let requesting = false
    let sentinel: ScreenWakeLockSentinel | null = null
    const wakeLock = (navigator as WakeLockNavigator).wakeLock
    if (!wakeLock) return

    const release = () => {
      const active = sentinel
      sentinel = null
      if (active) void active.release().catch(() => undefined)
    }
    const request = async () => {
      if (disposed || requesting || sentinel || document.visibilityState !== 'visible') return
      requesting = true
      try {
        const active = await wakeLock.request('screen')
        if (disposed || document.visibilityState !== 'visible') {
          void active.release().catch(() => undefined)
          return
        }
        sentinel = active
        active.addEventListener(
          'release',
          () => {
            if (sentinel === active) sentinel = null
          },
          { once: true },
        )
      } catch {
        // The browser or operating system may deny a screen wake lock.
      } finally {
        requesting = false
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void request()
      else release()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    void request()
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      release()
    }
  }, [isPlaying, settings.keepScreenAwake])

  const prefetchNext = () => {
    const state = usePlaybackStore.getState()
    const duration = state.duration
    if (
      !settings.enablePreloader ||
      !state.currentSong ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      state.currentTime / duration < 0.75
    )
      return
    if (state.queue.length <= 1) return
    const currentPlaybackKey = `${songKey(state.currentSong)}:${quality}`
    if (prefetchTriggeredKey.current === currentPlaybackKey) return
    const priorityNextIndex = state.priorityNextSongKey
      ? state.queue.findIndex(song => songKey(song) === state.priorityNextSongKey)
      : -1
    const randomNextIndex =
      state.mode === 'random' && state.randomNextSongKey
        ? state.queue.findIndex(song => songKey(song) === state.randomNextSongKey)
        : -1
    const queuedNextIndex = priorityNextIndex >= 0 ? priorityNextIndex : randomNextIndex
    const nextIndex =
      queuedNextIndex >= 0
        ? queuedNextIndex
        : state.mode === 'random'
          ? (state.queue.map((_, index) => index).filter(index => index !== state.currentIndex)[
              Math.floor(Math.random() * (state.queue.length - 1))
            ] ?? -1)
          : (state.currentIndex + 1) % state.queue.length
    const nextSong = state.queue[nextIndex]
    if (state.mode === 'random' && nextSong && queuedNextIndex < 0) {
      usePlaybackStore.getState().setRandomNextSongKey(songKey(nextSong))
    }
    if (!nextSong || nextIndex === state.currentIndex) return
    const key = songUrlCacheKey(nextSong, quality)
    const prefetchKey = `${currentPlaybackKey}:${songKey(nextSong)}`
    if (prefetchTriggeredKey.current === prefetchKey) return
    cancelScheduledPrefetch()
    prefetchTriggeredKey.current = prefetchKey
    if (nextSong.url) return
    const cachedUrl = prefetchedUrls.get(key)
    if (cachedUrl && cachedUrl.expiresAt > Date.now()) return
    if (cachedUrl) prefetchedUrls.delete(key)
    if (pendingSongUrlRequests.has(key)) return

    const isBackground = typeof document !== 'undefined' && document.hidden
    const runPrefetch = () => {
      prefetchIdleHandle.current = null
      const controller = new AbortController()
      prefetchController.current = controller
      void requestSongUrl(nextSong, quality, settings.enableAutoSwitchSource !== false, controller.signal, 'low')
        .catch(() => undefined)
        .finally(() => {
          if (prefetchController.current === controller) prefetchController.current = null
        })
    }
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }
    if (isBackground || !idleWindow.requestIdleCallback) {
      prefetchIdleHandle.current = window.setTimeout(runPrefetch, 0)
    } else {
      prefetchIdleHandle.current = idleWindow.requestIdleCallback(runPrefetch, { timeout: 1500 })
    }
  }

  useEffect(() => {
    historyRecordedKey.current = ''
    playbackStatusKey.current = ''
    lastProgressEmitAt.current = 0
    confirmedAudioPosition.current = 0
    pendingSeek.current = null
    lastMediaSessionAt.current = 0
    naturalFadeKey.current = ''
    cancelScheduledPrefetch()
    return cancelScheduledPrefetch
  }, [quality, songId])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    let retryCancelled = false
    let retryController: AbortController | null = null
    // Read settings at callback time so volume/setting changes do not tear down
    // and rebuild the whole audio pipeline (which also cancels URL retries).
    const getSettings = () => useSettingsStore.getState().settings
    const disconnectAudioCommands = connectAudioCommands({
      prime: options => {
        if (options?.song && resolvedSongKey.current === songKey(options.song)) {
          if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) audio.currentTime = 0
          void audio.play().catch(() => undefined)
          return
        }
        const audioPlaying = !audio.paused && !audio.ended
        // A natural outro has already reached `ended` by the time `next()`
        // primes the audio element. Preserve the intent to crossfade into the
        // selected next track even though the outgoing element is no longer
        // actively playing.
        const wasNaturalFade = Boolean(naturalFadeNextSongKey.current && options?.wasPlaying)
        const wasPlaying = Boolean(options ? options.wasPlaying && (audioPlaying || wasNaturalFade) : audioPlaying)
        lastSwitchWasPlaying.current = wasPlaying
        let immediateUrl = options?.immediateUrl
        if (!immediateUrl && options?.song) {
          const key = songUrlCacheKey(options.song, quality)
          const cached = prefetchedUrls.get(key)
          if (cached && cached.expiresAt > Date.now()) {
            immediateUrl = cached.result.url
          }
        }
        if (immediateUrl && options?.song) {
          try {
            audio.loop = false
            const targetUrl = buildPlaybackUrl(immediateUrl, options.song, getSettings())
            if (!isSameMediaSource(audio.currentSrc || audio.src, targetUrl)) audio.src = targetUrl
            const p = audio.play()
            if (p !== undefined) {
              p.catch(() => {})
            }
            return
          } catch {}
        }
      },
      play: () => {
        const selected = usePlaybackStore.getState().currentSong
        if (!selected || resolvedSongKey.current !== songKey(selected)) return
        const requestedSource = audio.currentSrc || audio.src
        if (!requestedSource) {
          setPlaying(false)
          notify('请选择歌曲后再播放')
          return
        }
        void audio.play().catch(error => {
          // A stale play() rejection must not stop a newer source selected by
          // the user. This is especially common when switching songs quickly.
          const activeSource = audio.currentSrc || audio.src
          if (
            !isSameMediaSource(activeSource, requestedSource) ||
            !usePlaybackStore.getState().isPlaying ||
            (error instanceof DOMException && error.name === 'AbortError')
          )
            return
          setPlaying(false)
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            notify('浏览器阻止了自动播放，请点击播放按钮')
          }
        })
      },
      pause: () => audio.pause(),
      position: () => samplePosition(),
      seek: time => {
        if (!Number.isFinite(time) || audio.readyState < HTMLMediaElement.HAVE_METADATA) return
        // A seek away from the outro must also cancel its in-flight volume fade.
        if (naturalFadeKey.current) {
          naturalFadeKey.current = ''
          naturalFadeNextSongKey.current = ''
          cancelVolumeAnimation()
          fadeFactor.current = 1
          syncAudioVolume()
        }
        const target = Math.max(0, Number.isFinite(audio.duration) ? Math.min(time, audio.duration) : time)
        // Safari reports the pre-seek position for a while after a jump and can
        // keep `seeking` set even when playback already resumed, so the target
        // itself anchors the clock until the decoder catches up.
        pendingSeek.current = beginSeek(target, Date.now())
        confirmedAudioPosition.current = target
        audio.currentTime = target
      },
      volume: next => {
        volumeTarget.current = next
        syncAudioVolume()
      },
    })
    syncAudioVolume()
    const onPlay = () => {
      const state = usePlaybackStore.getState()
      if (
        audio.paused ||
        resolvedSongKey.current !== songId ||
        !state.currentSong ||
        songKey(state.currentSong) !== songId
      )
        return
      if (!state.isPlaying) {
        audio.pause()
        return
      }
      if (currentSong) syncMediaSessionMetadata(currentSong)
      setMediaSessionPlaybackState('playing')
      emitPlaybackService({ type: 'play' })
      if (currentSong) {
        const playback = resolvedPlayback.current?.songKey === songId ? resolvedPlayback.current : null
        const playbackUrl = playback?.url || currentSong.url || ''
        const cacheReference = parseCachePlaybackUrl(playbackUrl)
        if (cacheReference) {
          void playerApi
            .cachePlayback({
              filename: cacheReference.filename,
              folder: cacheReference.folder,
              location: cacheReference.location,
              user: cacheReference.username || '_open',
            })
            .catch(() => undefined)
        }
        const status =
          cacheReference?.folder === 'music'
            ? { message: '下载播放', kind: 'success' as const, key: 'download' }
            : cacheReference?.folder === 'cache'
              ? { message: '命中缓存', kind: 'success' as const, key: 'cache' }
              : playback?.fromCache
                ? { message: '本地播放', kind: 'success' as const, key: 'local' }
                : {
                    message: playback?.sourceName ? `在线播放 · ${playback.sourceName}` : '在线播放',
                    kind: 'info' as const,
                    key: 'online',
                  }
        const statusKey = `${songId}:${quality}:${status.key}:${playback?.sourceName || ''}`
        if (playbackStatusKey.current !== statusKey) {
          playbackStatusKey.current = statusKey
          notifyPlayback(status.message, status.kind)
        }
      }
      const historyKey = `${songId}:${quality}`
      if (currentSong && historyRecordedKey.current !== historyKey) {
        historyRecordedKey.current = historyKey
        recordRecent(currentSong, quality)
      }
    }
    const onPlaying = () => {
      if (resolvedSongKey.current !== songId) return
      const state = usePlaybackStore.getState()
      if (audio.paused || !state.isPlaying || !state.currentSong || songKey(state.currentSong) !== songId) return
      if (getSettings().enableServerCache && currentSong) {
        const cacheKey = `${songKey(currentSong)}:${quality}`
        const playback = resolvedPlayback.current
        const cacheUrl =
          playback?.songKey === songKey(currentSong) &&
          playback.quality === quality &&
          playback.url &&
          !playback.fromCache
            ? playback.url
            : undefined
        if (!cacheQueued.current.has(cacheKey) && cacheUrl) {
          cacheQueued.current.add(cacheKey)
          // Reuse the URL that started playback. Resolving the source again
          // here would consume a second custom-source quota for the same song.
          void enqueueCache(currentSong, quality, cacheUrl, {
            cacheLyric: getSettings().enableServerLyricCache !== false,
            embedLyric: getSettings().embedLyricToFile !== false,
          }).catch(() => cacheQueued.current.delete(cacheKey))
        }
      }
      if (crossfadeIncoming.current) {
        crossfadeIncoming.current = false
        void animateVolumeFactor(1, CROSSFADE_DURATION_MS)
      }
      if (!playbackTraceName) return
      const endMark = `${playbackTraceName}:playing-end`
      markPlayerPerformance(endMark)
      measurePlayerPerformance(`${playbackTraceName}:playing`, `${playbackTraceName}:start`, endMark)
    }
    const onPause = () => {
      if (
        !audio.paused ||
        audio.ended ||
        resolvedSongKey.current !== songId ||
        songKey(usePlaybackStore.getState().currentSong ?? {}) !== songId
      )
        return
      setMediaSessionPlaybackState(currentSong ? 'paused' : 'none')
      emitPlaybackService({ type: 'pause' })
    }
    let crossfadeSelection: {
      queue: Song[]
      currentIndex: number
      mode: string
      priorityNextSongKey: string | null
      randomNextSongKey: string | null
      nextSong?: Song
    } | null = null
    const getCrossfadeNextSong = () => {
      let state = usePlaybackStore.getState()
      const cached = crossfadeSelection
      if (
        cached &&
        cached.queue === state.queue &&
        cached.currentIndex === state.currentIndex &&
        cached.mode === state.mode &&
        cached.priorityNextSongKey === state.priorityNextSongKey &&
        cached.randomNextSongKey === state.randomNextSongKey
      )
        return cached.nextSong

      let nextSong: Song | undefined
      const priorityNextSong = state.priorityNextSongKey
        ? state.queue.find(song => songKey(song) === state.priorityNextSongKey)
        : undefined
      const randomNextSong =
        state.mode === 'random' && state.randomNextSongKey
          ? state.queue.find(song => songKey(song) === state.randomNextSongKey)
          : undefined
      if (priorityNextSong || randomNextSong) {
        nextSong = priorityNextSong ?? randomNextSong
      } else if (state.mode !== 'single' && state.queue.length > 1) {
        const nextIndex =
          state.mode === 'random'
            ? (state.queue.map((_, index) => index).filter(index => index !== state.currentIndex)[
                Math.floor(Math.random() * (state.queue.length - 1))
              ] ?? -1)
            : (state.currentIndex + 1) % state.queue.length
        nextSong = state.queue[nextIndex]
        if (state.mode === 'random' && nextSong) {
          usePlaybackStore.getState().setRandomNextSongKey(songKey(nextSong))
          state = usePlaybackStore.getState()
        }
      }
      crossfadeSelection = {
        queue: state.queue,
        currentIndex: state.currentIndex,
        mode: state.mode,
        priorityNextSongKey: state.priorityNextSongKey,
        randomNextSongKey: state.randomNextSongKey,
        nextSong,
      }
      return nextSong
    }
    const onTime = () => {
      if (resolvedSongKey.current !== songId) return
      // `timeupdate` is unreliable on Safari while a FLAC decode is repositioning,
      // so the shared sampler owns the reading instead of the event.
      const currentTime = samplePosition() ?? 0
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      const isBackground = typeof document !== 'undefined' && document.hidden
      if (getSettings().enableCrossfade && duration > 0 && currentTime < duration && !isBackground) {
        const nextSong = getCrossfadeNextSong()
        const remaining = duration - currentTime
        if (nextSong && songKey(nextSong) !== songId && remaining <= CROSSFADE_DURATION_MS / 1000 && remaining > 0) {
          const fadeKey = `${songId}:${songKey(nextSong)}`
          if (naturalFadeKey.current !== fadeKey) {
            naturalFadeKey.current = fadeKey
            naturalFadeNextSongKey.current = songKey(nextSong)
            void animateVolumeFactor(0, Math.min(CROSSFADE_DURATION_MS, remaining * 1000))
          }
        } else if (
          naturalFadeKey.current &&
          (!nextSong || songKey(nextSong) === songId || remaining > CROSSFADE_DURATION_MS / 1000)
        ) {
          naturalFadeKey.current = ''
          naturalFadeNextSongKey.current = ''
          cancelVolumeAnimation()
          fadeFactor.current = 1
          syncAudioVolume()
        }
      }
      const now = Date.now()
      // Safari can dispatch timeupdate more often than the footer needs. Keep
      // the imperative audio element smooth while limiting store, React and
      // synchronous localStorage work to a modest update rate.
      if (now - lastProgressEmitAt.current >= PROGRESS_EMIT_INTERVAL_MS) {
        lastProgressEmitAt.current = now
        emitPlaybackService({ type: 'progress', currentTime, duration })
        prefetchNext()
      }
      if (
        currentSong &&
        'mediaSession' in navigator &&
        navigator.mediaSession.setPositionState &&
        Number.isFinite(duration) &&
        duration > 0 &&
        (now - lastMediaSessionAt.current >= 1000 || currentTime === 0)
      ) {
        lastMediaSessionAt.current = now
        try {
          const validDuration = Math.max(0.1, duration)
          const validPosition = Number.isFinite(currentTime) ? Math.max(0, Math.min(currentTime, validDuration)) : 0
          const rate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0 ? audio.playbackRate : 1
          navigator.mediaSession.setPositionState({
            duration: validDuration,
            playbackRate: rate,
            position: validPosition,
          })
        } catch {
          /* browser may reject transient media metadata */
        }
      }
    }
    const onSeeked = () => {
      if (resolvedSongKey.current !== songId) return
      // The decoder has committed, so its reading is authoritative again. The
      // seeked event must always publish, otherwise a seek that Safari reports
      // while `seeking` is still set would be dropped entirely.
      const reading = readMediaClock(audio)
      // WebKit also fires `seeked` while still handing back the pre-seek
      // position. Publishing that would snap the lyrics back for one frame, so
      // keep the target anchor until the sampler sees the decoder arrive.
      const hold = pendingSeek.current
      const keepAnchor = hold !== null && !isSeekSettled(reading, hold)
      // `seeked` itself is fresh evidence of a repositioning, so the grace window
      // restarts here; otherwise a late `seeked` would expire it immediately and
      // publish the stale reading anyway.
      pendingSeek.current = keepAnchor ? { ...hold, refreshedAt: Date.now(), lastReading: null } : null
      const currentTime = keepAnchor ? hold.target : (reading ?? confirmedAudioPosition.current)
      confirmedAudioPosition.current = currentTime
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      lastProgressEmitAt.current = Date.now()
      emitPlaybackService({ type: 'progress', currentTime, duration })
    }
    const onLoaded = () => {
      if (resolvedSongKey.current !== songId) return
      const state = usePlaybackStore.getState()
      const resumeTime = state.currentTime
      pendingSeek.current = null
      const currentTime = readMediaClock(audio) ?? 0
      confirmedAudioPosition.current = currentTime
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      if (playbackTraceName) {
        const endMark = `${playbackTraceName}:metadata-end`
        markPlayerPerformance(endMark)
        measurePlayerPerformance(`${playbackTraceName}:metadata`, `${playbackTraceName}:start`, endMark, false)
      }
      emitPlaybackService({ type: 'loaded', duration })
      const shouldResume =
        getSettings().autoResume &&
        duration > 0 &&
        resumeTime > 0 &&
        resumeTime < duration &&
        recoveryAttempts.current.has(`resume:${songId}`) === false
      if (shouldResume) {
        recoveryAttempts.current.add(`resume:${songId}`)
        if (Math.abs(currentTime - resumeTime) > 0.05) {
          // Wait for seeked before publishing the restored position. WebKit can
          // expose the requested time while the decoder is still seeking.
          pendingSeek.current = beginSeek(resumeTime, Date.now())
          audio.currentTime = resumeTime
          return
        }
      }
      emitPlaybackService({ type: 'progress', currentTime, duration })
    }
    const onEnded = () => {
      const state = usePlaybackStore.getState()
      if (
        !audio.ended ||
        !state.isPlaying ||
        !state.currentSong ||
        songKey(state.currentSong) !== songId ||
        resolvedSongKey.current !== songId
      )
        return
      if (state.mode === 'single' && !state.priorityNextSongKey) {
        cancelVolumeAnimation()
        naturalFadeKey.current = ''
        naturalFadeNextSongKey.current = ''
        fadeFactor.current = 1
        syncAudioVolume()
        audio.currentTime = 0
        void audio.play().catch(error => {
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            setPlaying(false)
            notify('浏览器阻止了自动播放，请点击播放按钮')
          }
        })
        return
      }
      const expectedNaturalFadeTarget = naturalFadeNextSongKey.current
      state.next()
      const nextSong = usePlaybackStore.getState().currentSong
      const nextSongKey = nextSong ? songKey(nextSong) : ''
      if (expectedNaturalFadeTarget && expectedNaturalFadeTarget !== nextSongKey) {
        // The queue may have changed during the outro. Do not carry an old
        // fade target into a different song and leave its volume ramp behind.
        naturalFadeKey.current = ''
        naturalFadeNextSongKey.current = ''
        cancelVolumeAnimation()
        fadeFactor.current = 1
        syncAudioVolume()
      }
    }
    const reportPlaybackError = () => {
      if (getSettings().enableAutoDegradeQuality && currentSong && !currentSong.url) {
        const currentQualityIndex = QUALITY_FALLBACKS.indexOf(quality)
        const nextQuality = currentQualityIndex >= 0 ? QUALITY_FALLBACKS[currentQualityIndex + 1] : undefined
        const attemptKey = `${songId}:${quality}`
        if (nextQuality && !recoveryAttempts.current.has(attemptKey)) {
          recoveryAttempts.current.add(attemptKey)
          setQuality(nextQuality)
          notify(`当前音质播放失败，已自动切换到 ${nextQuality}`)
          return
        }
      }
      const message = '播放失败，请尝试切换音质或音源'
      if (playbackTraceName) clearPlayerPerformanceMark(`${playbackTraceName}:start`)
      emitPlaybackService({ type: 'error', message })
      setResolvedError(message)
      notify(message)
    }
    const onError = () => {
      const selected = usePlaybackStore.getState().currentSong
      if (!audio.error || !selected || songKey(selected) !== songId || resolvedSongKey.current !== songId) return
      const activePlayback = resolvedPlayback.current
      const refreshKey = `url-refresh:${songId}:${quality}`
      if (
        currentSong &&
        activePlayback?.songKey === songId &&
        activePlayback.quality === quality &&
        !activePlayback.fromCache &&
        !parseCachePlaybackUrl(activePlayback.url) &&
        !recoveryAttempts.current.has(refreshKey)
      ) {
        recoveryAttempts.current.add(refreshKey)
        prefetchedUrls.delete(songUrlCacheKey(currentSong, quality))
        retryController?.abort()
        retryController = new AbortController()
        const signal = retryController.signal
        setResolvedError('')
        notifyPlayback('刷新播放链接')
        void requestSongUrl(currentSong, quality, getSettings().enableAutoSwitchSource !== false, signal, 'high', true)
          .then(async result => {
            const state = usePlaybackStore.getState()
            if (
              retryCancelled ||
              signal.aborted ||
              audioRef.current !== audio ||
              !state.currentSong ||
              songKey(state.currentSong) !== songId ||
              state.quality !== quality
            )
              return
            resolvedPlayback.current = {
              songKey: songId,
              quality,
              url: result.url,
              fromCache: Boolean(result.fromCache) || /\/api\/music\/cache\/file\//.test(result.url),
              sourceName: result.sourceName,
            }
            setResolvedUrl(result.url)
            const targetPlaybackUrl = buildPlaybackUrl(
              result.url,
              currentSong,
              settings,
              undefined,
              result.downloadToken,
            )
            if (!isSameMediaSource(audio.currentSrc || audio.src, targetPlaybackUrl)) {
              audio.src = targetPlaybackUrl
            }
            if (!parseCachePlaybackUrl(result.url) && !result.fromCache) {
              notifyPlayback(result.sourceName ? `连接 · ${result.sourceName}` : '连接在线音源')
            }
            if (state.isPlaying) await audio.play()
          })
          .catch(error => {
            if (retryCancelled || signal.aborted) return
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
              setPlaying(false)
              notify('歌曲已就绪，请点击播放按钮继续')
              return
            }
            reportPlaybackError()
          })
        return
      }
      reportPlaybackError()
    }
    audio.addEventListener('play', onPlay)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('seeked', onSeeked)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      disconnectAudioCommands()
      retryCancelled = true
      retryController?.abort()
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('seeked', onSeeked)
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [
    enqueueCache,
    notify,
    notifyPlayback,
    playbackTraceName,
    quality,
    recordRecent,
    setPlaying,
    setQuality,
    setResolvedUrl,
    songId,
    userName,
  ])

  useEffect(() => {
    if (!volumeAnimation.current) syncAudioVolume()
  }, [muted, volume])

  // Safari can throttle or skip `timeupdate` around a FLAC seek, which froze the
  // footer and the scrolling lyrics until the next event arrived. A 200ms timer
  // matches the publish cadence exactly, so it costs one wake-up per update
  // instead of one per display frame.
  useEffect(() => {
    if (!isPlaying) return
    const tick = () => {
      const audio = audioRef.current
      if (!audio || resolvedSongKey.current !== songId) return
      const now = Date.now()
      if (now - lastProgressEmitAt.current < PROGRESS_EMIT_INTERVAL_MS) return
      const position = samplePosition()
      if (position === null) return
      lastProgressEmitAt.current = now
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
      emitPlaybackService({ type: 'progress', currentTime: position, duration })
    }
    const timer = window.setInterval(tick, PROGRESS_EMIT_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [isPlaying, songId])

  useEffect(() => {
    if (settings.enableCrossfade || (!crossfadeTransition.current && !naturalFadeKey.current)) return
    cancelVolumeAnimation()
    naturalFadeKey.current = ''
    naturalFadeNextSongKey.current = ''
    const hadTransition = Boolean(crossfadeTransition.current)
    crossfadeTransition.current = null
    crossfadeIncoming.current = false
    fadeFactor.current = 1
    syncAudioVolume()
    const audio = audioRef.current
    if (audio && hadTransition) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
  }, [settings.enableCrossfade])

  useEffect(() => {
    const handleVisibility = () => {
      if (typeof document === 'undefined') return
      if (!document.hidden) {
        const state = usePlaybackStore.getState()
        if (state.isPlaying && !crossfadeTransition.current && fadeFactor.current < 1) {
          cancelVolumeAnimation()
          crossfadeIncoming.current = false
          naturalFadeKey.current = ''
          naturalFadeNextSongKey.current = ''
          fadeFactor.current = 1
          syncAudioVolume()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pageshow', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pageshow', handleVisibility)
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !currentSong || !songId) return
    let cancelled = false
    const controller = new AbortController()
    const isCurrentSelection = () => {
      const state = usePlaybackStore.getState()
      return Boolean(state.currentSong && songKey(state.currentSong) === songId && state.quality === quality)
    }
    setResolvedError('')
    if (playbackTraceName) markPlayerPerformance(`${playbackTraceName}:start`)
    const storedCacheUrl =
      typeof currentSong.url === 'string' && currentSong.url ? normalizeCachePlaybackUrl(currentSong.url, userName) : ''
    const hasStoredCacheUrl = Boolean(storedCacheUrl && parseCachePlaybackUrl(storedCacheUrl))
    if (!hasStoredCacheUrl) notifyPlayback('检查缓存')
    void (async () => {
      try {
        const prefetchKey = songUrlCacheKey(currentSong, quality)
        const result = hasStoredCacheUrl
          ? { url: storedCacheUrl, fromCache: true, sourceName: '本地缓存' }
          : await requestSongUrl(currentSong, quality, settings.enableAutoSwitchSource !== false, controller.signal)
        if (cancelled || controller.signal.aborted || !isCurrentSelection()) return
        const transition = crossfadeTransition.current
        const crossfadeEnabled = Boolean(useSettingsStore.getState().settings.enableCrossfade)
        const isBackground = typeof document !== 'undefined' && document.hidden
        const state = usePlaybackStore.getState()
        const canCrossfade =
          crossfadeEnabled &&
          state.isPlaying &&
          !isBackground &&
          !audio.paused &&
          !audio.ended &&
          fadeFactor.current > 0
        const completedNaturalFade = naturalFadeNextSongKey.current === songId
        if (completedNaturalFade) naturalFadeKey.current = ''
        if (transition?.to === songId && (canCrossfade || completedNaturalFade)) {
          if (crossfadeEnabled && state.isPlaying && !isBackground) {
            if (completedNaturalFade || audio.paused || audio.ended || fadeFactor.current <= 0) fadeFactor.current = 0
            else await animateVolumeFactor(0, CROSSFADE_DURATION_MS)
            if (cancelled || controller.signal.aborted || !isCurrentSelection()) return
            const latestState = usePlaybackStore.getState()
            if (
              crossfadeTransition.current?.to === songId &&
              useSettingsStore.getState().settings.enableCrossfade &&
              latestState.isPlaying
            ) {
              audio.pause()
              crossfadeTransition.current = null
              crossfadeIncoming.current = true
              fadeFactor.current = 0
              naturalFadeNextSongKey.current = ''
            } else {
              cancelVolumeAnimation()
              crossfadeTransition.current = null
              crossfadeIncoming.current = false
              fadeFactor.current = 1
              naturalFadeNextSongKey.current = ''
            }
          } else {
            cancelVolumeAnimation()
            if (transition?.to === songId && !isBackground) audio.pause()
            crossfadeTransition.current = null
            crossfadeIncoming.current = false
            fadeFactor.current = 1
            naturalFadeNextSongKey.current = ''
          }
        } else {
          crossfadeIncoming.current = false
          fadeFactor.current = 1
          naturalFadeKey.current = ''
          naturalFadeNextSongKey.current = ''
        }
        syncAudioVolume()
        prefetchedUrls.delete(prefetchKey)
        resolvedPlayback.current = {
          songKey: songId,
          quality,
          url: result.url,
          fromCache: Boolean(result.fromCache) || /\/api\/music\/cache\/file\//.test(result.url),
          sourceName: result.sourceName,
        }
        setResolvedUrl(result.url)
        resolvedSongKey.current = songId
        audio.loop = false
        const targetPlaybackUrl = buildPlaybackUrl(result.url, currentSong, settings, undefined, result.downloadToken)
        if (!isSameMediaSource(audio.currentSrc || audio.src, targetPlaybackUrl)) {
          audio.src = targetPlaybackUrl
        }
        if (!parseCachePlaybackUrl(result.url) && !result.fromCache) {
          notifyPlayback(result.sourceName ? `连接 · ${result.sourceName}` : '连接在线音源')
        }
        if (usePlaybackStore.getState().isPlaying && audio.paused) {
          try {
            await audio.play()
          } catch (error) {
            if (
              cancelled ||
              !usePlaybackStore.getState().isPlaying ||
              (error instanceof DOMException && error.name === 'AbortError')
            )
              return
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
              setPlaying(false)
              notify('歌曲已就绪，请点击播放按钮继续')
              return
            }
            throw error
          }
        }
      } catch (error) {
        if (cancelled || !isCurrentSelection()) return
        if (crossfadeTransition.current?.to === songId) {
          cancelVolumeAnimation()
          crossfadeTransition.current = null
          crossfadeIncoming.current = false
          fadeFactor.current = 1
          syncAudioVolume()
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
          resolvedSongKey.current = ''
        }
        setResolvedUrl(null)
        setPlaying(false)
        setResolvedError(error instanceof Error ? error.message : '歌曲解析失败')
        notify(error instanceof Error ? error.message : '歌曲解析失败')
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      if (playbackTraceName) clearPlayerPerformanceMark(`${playbackTraceName}:start`)
      const state = usePlaybackStore.getState()
      const selectedSongKey = state.currentSong ? songKey(state.currentSong) : ''
      const transition = crossfadeTransition.current
      const crossfadeEnabled = Boolean(useSettingsStore.getState().settings.enableCrossfade)
      const preserveTransition = Boolean(
        crossfadeEnabled && state.isPlaying && selectedSongKey === songId && transition?.to === songId,
      )
      const wasPlayingBeforeSwitch = lastSwitchWasPlaying.current
      lastSwitchWasPlaying.current = false
      const startTransition = Boolean(
        crossfadeEnabled &&
        state.isPlaying &&
        wasPlayingBeforeSwitch &&
        selectedSongKey &&
        selectedSongKey !== songId &&
        (resolvedSongKey.current === songId || transition),
      )
      if (startTransition) {
        crossfadeTransition.current = { from: transition?.from || songId, to: selectedSongKey }
        crossfadeIncoming.current = false
      }
      const playbackUrl = resolvedPlayback.current?.songKey === songId ? resolvedPlayback.current.url : null
      if (resolvedSongKey.current === songId) resolvedSongKey.current = ''
      if (resolvedPlayback.current?.songKey === songId) resolvedPlayback.current = null
      if (playbackUrl && usePlaybackStore.getState().resolvedUrl === playbackUrl) setResolvedUrl(null)
      if (!startTransition && !preserveTransition) {
        cancelVolumeAnimation()
        crossfadeTransition.current = null
        crossfadeIncoming.current = false
        fadeFactor.current = 1
        syncAudioVolume()
        audio.pause()
        if (!selectedSongKey || !state.isPlaying) {
          audio.removeAttribute('src')
          audio.load()
        }
      }
    }
  }, [
    notify,
    notifyPlayback,
    playbackTraceName,
    quality,
    setPlaying,
    setResolvedUrl,
    settings.enableAutoSwitchSource,
    settings.enableCustomProxy,
    settings.customProxyUrl,
    songId,
    userName,
  ])

  useEffect(() => {
    const audio = audioRef.current
    const state = usePlaybackStore.getState()
    if (!audio || !state.currentSong || !state.isPlaying || resolvedSongKey.current !== songKey(state.currentSong)) {
      if (audio && !state.isPlaying) {
        audio.pause()
        if (naturalFadeKey.current) {
          naturalFadeKey.current = ''
          naturalFadeNextSongKey.current = ''
          cancelVolumeAnimation()
          fadeFactor.current = 1
          syncAudioVolume()
        }
        if (crossfadeTransition.current) {
          cancelVolumeAnimation()
          crossfadeTransition.current = null
          crossfadeIncoming.current = false
          fadeFactor.current = 1
          syncAudioVolume()
          audio.removeAttribute('src')
          audio.load()
        }
      }
      return
    }
    const requestedSource = audio.currentSrc || audio.src
    void audio.play().catch(error => {
      if (
        !isSameMediaSource(audio.currentSrc || audio.src, requestedSource) ||
        !usePlaybackStore.getState().isPlaying ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        return
      setPlaying(false)
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        notify('浏览器阻止了自动播放，请点击播放按钮')
    })
  }, [isPlaying, notify, setPlaying])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const mediaSession = navigator.mediaSession
    const setActionHandler = (
      action: MediaSessionAction,
      handler: ((details: MediaSessionActionDetails) => void) | null,
    ) => {
      try {
        mediaSession.setActionHandler?.(action, handler)
      } catch {
        /* action is not supported by this browser */
      }
    }
    const actions: MediaSessionAction[] = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'stop']
    setActionHandler('play', () => {
      const state = usePlaybackStore.getState()
      if (!state.isPlaying) state.toggle()
    })
    setActionHandler('pause', () => {
      const state = usePlaybackStore.getState()
      if (state.isPlaying) state.toggle()
    })
    setActionHandler('stop', () => {
      const state = usePlaybackStore.getState()
      if (state.isPlaying) state.toggle()
    })
    setActionHandler('seekto', (details: any) => {
      if (typeof details?.seekTime === 'number' && Number.isFinite(details.seekTime)) {
        usePlaybackStore.getState().seek(details.seekTime)
      }
    })
    const registerTrackActions = () => {
      setActionHandler('seekbackward', null)
      setActionHandler('seekforward', null)
      setActionHandler('previoustrack', () => usePlaybackStore.getState().previous())
      setActionHandler('nexttrack', () => usePlaybackStore.getState().next())
    }
    // Safari can publish its default seek commands when playback becomes active.
    const audio = audioRef.current
    audio?.addEventListener('playing', registerTrackActions)
    registerTrackActions()
    return () => {
      audio?.removeEventListener('playing', registerTrackActions)
      actions.forEach(action => setActionHandler(action, null))
      setActionHandler('seekbackward', null)
      setActionHandler('seekforward', null)
    }
  }, [])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    syncMediaSessionMetadata(currentSong)
    if (currentSong) setMediaSessionPlaybackState(usePlaybackStore.getState().isPlaying ? 'playing' : 'paused')
  }, [currentSong])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const refresh = () => {
      const audio = audioRef.current
      const song = usePlaybackStore.getState().currentSong
      if (song && audio && !audio.paused) {
        syncMediaSessionMetadata(song)
        setMediaSessionPlaybackState('playing')
      }
    }
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('pageshow', refresh)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('pageshow', refresh)
    }
  }, [])
  return (
    <>
      <audio ref={audioRef} preload="metadata" aria-label="音乐播放器" />
      {resolvedError && (
        <span className="sr-only" role="alert">
          {resolvedError}
        </span>
      )}
    </>
  )
}
