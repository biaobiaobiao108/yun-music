import { create } from 'zustand'
import { pausePlaybackCommand, usePlaybackStore } from './playback'

export type SleepTimerState = { deadline: number | null; remaining: number; setTimer: (minutes: number) => void; cancelTimer: () => void; tick: () => void }

let stopTimer: ReturnType<typeof setTimeout> | null = null
/** setTimeout clamps anything larger than this to 1ms in the browser. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

function clearStopTimer(): void {
  if (stopTimer !== null) clearTimeout(stopTimer)
  stopTimer = null
}

function armStopTimer(callback: () => void, delayMs: number): void {
  clearStopTimer()
  stopTimer = setTimeout(callback, Math.min(Math.max(1, delayMs), MAX_TIMEOUT_MS))
}

export const useSleepTimerStore = create<SleepTimerState>((set, get) => ({
  deadline: null,
  remaining: 0,
  setTimer: minutes => {
    if (!Number.isFinite(minutes)) return
    const safeMinutes = Math.min(24 * 60, Math.max(1, Math.round(minutes)))
    set({ deadline: Date.now() + safeMinutes * 60_000, remaining: safeMinutes * 60 })
    // The deadline belongs to playback, independently of the timer dialog.
    armStopTimer(() => get().tick(), safeMinutes * 60_000)
  },
  cancelTimer: () => { clearStopTimer(); set({ deadline: null, remaining: 0 }) },
  tick: () => {
    const deadline = get().deadline
    if (!deadline) return
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    if (remaining > 0) {
      set({ remaining })
      // Browsers can fire timers early (clock adjustments, background
      // throttling). Re-arm instead of silently losing the deadline.
      armStopTimer(() => useSleepTimerStore.getState().tick(), remaining * 1000)
    } else {
      clearStopTimer()
      pausePlaybackCommand()
      usePlaybackStore.getState().setPlaying(false)
      set({ deadline: null, remaining: 0 })
    }
  },
}))
