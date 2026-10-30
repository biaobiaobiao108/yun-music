import { describe, expect, it } from 'bun:test'
import {
  beginSeek,
  isSeekSettled,
  readMediaClock,
  resolveMediaClock,
  SEEK_HOLD_MAX_MS,
  SEEK_HOLD_MS,
} from '../frontend/player/src/react/media_clock'

describe('media clock reading', () => {
  it('rejects values that would poison every later read', () => {
    expect(readMediaClock({ currentTime: Number.NaN })).toBeNull()
    expect(readMediaClock({ currentTime: Number.POSITIVE_INFINITY })).toBeNull()
    expect(readMediaClock({ currentTime: -3 })).toBe(0)
    expect(readMediaClock({ currentTime: 12.5 })).toBe(12.5)
  })
})

describe('seek hold', () => {
  const T0 = 1_000
  const hold = beginSeek(70, T0)

  it('keeps the requested target while the element still reports the old position', () => {
    const resolved = resolveMediaClock(10, hold, T0 + 50, true)
    expect(resolved.position).toBe(70)
    expect(resolved.hold).not.toBeNull()
  })

  it('hands control back once the element reaches the target', () => {
    expect(resolveMediaClock(70.2, hold, T0 + 50, true)).toEqual({ position: 70.2, hold: null })
    expect(isSeekSettled(70.2, hold)).toBe(true)
    expect(isSeekSettled(10, hold)).toBe(false)
  })

  it('extends the hold while the element still reports seeking', () => {
    // Almost at the absolute cap but the decoder still says it is repositioning:
    // the clock must not flicker back to the pre-seek position.
    const resolved = resolveMediaClock(10, hold, T0 + SEEK_HOLD_MAX_MS - 100, true)
    expect(resolved.position).toBe(70)
    expect(resolved.hold?.refreshedAt).toBe(T0 + SEEK_HOLD_MAX_MS - 100)
  })

  it('extends the hold while the reading is frozen, even without the seeking flag', () => {
    const first = resolveMediaClock(10, hold, T0 + 100, false)
    expect(first.position).toBe(70)
    const later = resolveMediaClock(10, first.hold, T0 + SEEK_HOLD_MAX_MS - 100, false)
    expect(later.position).toBe(70)
    expect(later.hold).not.toBeNull()
  })

  it('degrades to the element reading at the hard cap', () => {
    expect(resolveMediaClock(10, hold, T0 + SEEK_HOLD_MAX_MS, true)).toEqual({ position: 10, hold: null })
  })

  it('publishes a moving reading after the grace window', () => {
    const first = resolveMediaClock(10, hold, T0 + 100, false)
    expect(first.position).toBe(70)
    // The clock moved away from the target but has not arrived: masked for the
    // grace window, then trusted so the lyrics never run ahead of the audio.
    expect(resolveMediaClock(20, first.hold, T0 + SEEK_HOLD_MS - 1, false).position).toBe(70)
    expect(resolveMediaClock(20, first.hold, T0 + SEEK_HOLD_MS, false)).toEqual({
      position: 20,
      hold: null,
    })
  })

  it('never fabricates a position without a reading', () => {
    expect(resolveMediaClock(null, hold, T0 + 50, true)).toEqual({ position: 70, hold })
    expect(resolveMediaClock(null, hold, T0 + SEEK_HOLD_MAX_MS, true)).toEqual({ position: null, hold: null })
    expect(resolveMediaClock(null, null, T0 + 50)).toEqual({ position: null, hold: null })
    expect(resolveMediaClock(42, null, T0 + 50)).toEqual({ position: 42, hold: null })
  })
})
