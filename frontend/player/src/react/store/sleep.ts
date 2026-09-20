import { create } from 'zustand'
import { pausePlaybackCommand, usePlaybackStore } from './playback'

export type SleepTimerState = { deadline: number | null; remaining: number; setTimer: (minutes: number) => void; cancelTimer: () => void; tick: () => void }

export const useSleepTimerStore = create<SleepTimerState>((set, get) => ({
  deadline: null,
  remaining: 0,
  setTimer: minutes => {
    const safeMinutes = Math.min(24 * 60, Math.max(1, Math.round(minutes)))
    set({ deadline: Date.now() + safeMinutes * 60_000, remaining: safeMinutes * 60 })
  },
  cancelTimer: () => set({ deadline: null, remaining: 0 }),
  tick: () => {
    const deadline = get().deadline
    if (!deadline) return
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    if (remaining > 0) set({ remaining })
    else {
      pausePlaybackCommand()
      usePlaybackStore.getState().setPlaying(false)
      set({ deadline: null, remaining: 0 })
    }
  },
}))
