export type SeekHold = { target: number; issuedAt: number }

/** How long a jump target outranks the element's own reading. */
export const SEEK_HOLD_MS = 700
/** A reading this close to the target means the decoder has caught up. */
export const SEEK_SETTLE_SECONDS = 0.5

/**
 * WebKit returns NaN while it re-parses a stream, and a single raw value would
 * poison every later clock read because NaN survives Math.max.
 */
export function readMediaClock(element: { currentTime: number }): number | null {
  const value = element.currentTime
  return Number.isFinite(value) ? Math.max(0, value) : null
}

/**
 * WebKit keeps reporting the pre-seek position for a few frames and can leave
 * `seeking` set long after playback resumed, so the requested target outranks
 * the element reading until the decoder catches up. The hold is bounded so a
 * stuck seek can never freeze the caller.
 */
export function resolveMediaClock(
  reading: number | null,
  hold: SeekHold | null,
  now: number,
): { position: number | null; hold: SeekHold | null } {
  if (!hold || reading === null) return { position: reading, hold: null }
  if (Math.abs(reading - hold.target) <= SEEK_SETTLE_SECONDS || now - hold.issuedAt >= SEEK_HOLD_MS) {
    return { position: reading, hold: null }
  }
  return { position: hold.target, hold }
}
