import { useEffect, useRef } from 'react'

type RealtimeRefreshOptions = {
  enabled: boolean
  intervalMs: number
  refresh: () => Promise<void> | void
}

/**
 * Run a lightweight, serialized refresh loop while a view is visible.
 *
 * A timeout is scheduled only after the previous refresh settles, so a slow
 * request cannot create a pile-up of overlapping polls. Hidden browser tabs
 * pause the loop and refresh immediately when they become visible again.
 */
export function useRealtimePoll({ enabled, intervalMs, refresh }: RealtimeRefreshOptions): void {
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let running = false
    let timer: number | undefined

    const clearTimer = () => {
      if (timer === undefined) return
      window.clearTimeout(timer)
      timer = undefined
    }

    const schedule = () => {
      if (disposed || document.visibilityState !== 'visible') return
      clearTimer()
      timer = window.setTimeout(() => {
        timer = undefined
        void run()
      }, intervalMs)
    }

    const run = async () => {
      if (disposed || running || document.visibilityState !== 'visible') return
      running = true
      try {
        await refreshRef.current()
      } finally {
        running = false
        schedule()
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        clearTimer()
        return
      }
      void run()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    void run()
    return () => {
      disposed = true
      clearTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [enabled, intervalMs])
}
