import { useEffect, useRef, useState } from 'react'
import { playerApi, type CacheTask } from '../api'

type CacheEventsOptions = {
  enabled: boolean
  user?: string
  onQueue?: (tasks: CacheTask[]) => void
  onCache?: () => void
}

type CacheEventPayload = {
  tasks?: CacheTask[]
}

const readPayload = (event: Event): CacheEventPayload => {
  const data = (event as MessageEvent<string>).data
  if (typeof data !== 'string' || !data) return {}
  try {
    const value = JSON.parse(data) as CacheEventPayload
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** Subscribe to server-side queue/file changes and report connection state. */
export function useCacheEvents({ enabled, user, onQueue, onCache }: CacheEventsOptions): boolean {
  const handlersRef = useRef({ onQueue, onCache })
  handlersRef.current = { onQueue, onCache }
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setConnected(false)
      return
    }

    let disposed = false
    setConnected(false)
    const source = new EventSource(playerApi.cacheEventsUrl(user))
    source.onopen = () => {
      if (!disposed) setConnected(true)
    }
    source.onerror = () => {
      if (!disposed) setConnected(false)
    }
    source.addEventListener('queue', event => {
      const tasks = readPayload(event).tasks
      if (!disposed && Array.isArray(tasks)) handlersRef.current.onQueue?.(tasks)
    })
    source.addEventListener('cache', () => {
      if (!disposed) handlersRef.current.onCache?.()
    })

    return () => {
      disposed = true
      source.close()
    }
  }, [enabled, user])

  return connected
}
