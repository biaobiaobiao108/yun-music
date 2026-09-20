export type PlaybackServiceEvent =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'progress'; currentTime: number; duration: number }
  | { type: 'loaded'; duration: number }
  | { type: 'error'; message: string }

type Listener = (event: PlaybackServiceEvent) => void
const listeners = new Set<Listener>()

/**
 * Typed boundary between the imperative HTMLAudioElement service and the
 * reactive playback store. Audio callbacks emit here; React never subscribes
 * to the element directly for high-frequency progress updates.
 */
export function subscribePlaybackService(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitPlaybackService(event: PlaybackServiceEvent): void {
  for (const listener of listeners) listener(event)
}
