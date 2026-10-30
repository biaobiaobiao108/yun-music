export type SeekHold = {
  target: number
  issuedAt: number
  /** Last moment the element gave evidence it was still repositioning. */
  refreshedAt: number
  /** Previous element reading, used to detect a frozen (stale) clock. */
  lastReading: number | null
}

/** Grace kept after the element stops giving any sign of repositioning. */
export const SEEK_HOLD_MS = 700
/** Absolute cap, so a failed or stuck seek can never anchor the clock forever. */
export const SEEK_HOLD_MAX_MS = 3000
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

export function beginSeek(target: number, now: number): SeekHold {
  return { target, issuedAt: now, refreshedAt: now, lastReading: null }
}

/** True once the element reports a position close enough to the requested one. */
export function isSeekSettled(reading: number | null, hold: SeekHold | null): boolean {
  if (!hold) return true
  if (reading === null) return false
  return Math.abs(reading - hold.target) <= SEEK_SETTLE_SECONDS
}

/**
 * WebKit keeps reporting the pre-seek position for a few frames and can leave
 * `seeking` set long after playback resumed, so the requested target outranks
 * the element reading until the decoder catches up.
 *
 * The hold is extended while the element still reports `seeking` *or* keeps
 * returning the same frozen reading, which removes the "jump back to the old
 * line, then forward again" flicker of a flat deadline. `SEEK_HOLD_MAX_MS`
 * still bounds it, so a seek that never lands degrades to the element reading
 * instead of freezing the caller.
 */
export function resolveMediaClock(
  reading: number | null,
  hold: SeekHold | null,
  now: number,
  seeking = false,
): { position: number | null; hold: SeekHold | null } {
  if (!hold) return { position: reading, hold: null }
  if (isSeekSettled(reading, hold)) return { position: reading, hold: null }
  if (now - hold.issuedAt >= SEEK_HOLD_MAX_MS) return { position: reading, hold: null }
  if (reading === null) return { position: hold.target, hold }
  // Still repositioning: the element says so, or its clock has not moved at all.
  if (seeking || reading === hold.lastReading) {
    return { position: hold.target, hold: { ...hold, refreshedAt: now, lastReading: reading } }
  }
  // The element is moving again but has not reached the target: mask it for the
  // grace window, then trust the element so playback never runs ahead of a lie.
  if (now - hold.refreshedAt >= SEEK_HOLD_MS) return { position: reading, hold: null }
  return { position: hold.target, hold: { ...hold, lastReading: reading } }
}
