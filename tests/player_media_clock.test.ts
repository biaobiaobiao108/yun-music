import { describe, expect, it } from 'bun:test'
import { readMediaClock, resolveMediaClock, SEEK_HOLD_MS } from '../frontend/player/src/react/media_clock'

describe('media clock reading', () => {
  it('rejects values that would poison every later read', () => {
    expect(readMediaClock({ currentTime: Number.NaN })).toBeNull()
    expect(readMediaClock({ currentTime: Number.POSITIVE_INFINITY })).toBeNull()
    expect(readMediaClock({ currentTime: -3 })).toBe(0)
    expect(readMediaClock({ currentTime: 12.5 })).toBe(12.5)
  })
})

describe('seek hold', () => {
  const hold = { target: 70, issuedAt: 1_000 }

  it('keeps the requested target while the element still reports the old position', () => {
    expect(resolveMediaClock(10, hold, 1_050)).toEqual({ position: 70, hold })
  })

  it('hands control back once the element reaches the target', () => {
    expect(resolveMediaClock(70.2, hold, 1_050)).toEqual({ position: 70.2, hold: null })
  })

  it('expires so a stuck seek cannot freeze the clock', () => {
    expect(resolveMediaClock(10, hold, 1_000 + SEEK_HOLD_MS)).toEqual({ position: 10, hold: null })
  })

  it('never fabricates a position without a reading', () => {
    expect(resolveMediaClock(null, hold, 1_050)).toEqual({ position: null, hold: null })
    expect(resolveMediaClock(null, null, 1_050)).toEqual({ position: null, hold: null })
    expect(resolveMediaClock(42, null, 1_050)).toEqual({ position: 42, hold: null })
  })
})
