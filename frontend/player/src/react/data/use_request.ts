import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbortError } from './request'

export type RequestResourceState<T> = {
  data: T
  loading: boolean
  refreshing: boolean
  error: string
}

export type RequestLoader<T> = (signal: AbortSignal, options: { force: boolean }) => Promise<T>

export function useRequestResource<T>(
  loader: RequestLoader<T>,
  dependencies: readonly unknown[],
  options: { enabled?: boolean; initialData: T },
): RequestResourceState<T> & { reload: () => Promise<void>; cancel: () => void } {
  const enabled = options.enabled ?? true
  const controllerRef = useRef<AbortController | null>(null)
  const initialDataRef = useRef(options.initialData)
  const initialData = initialDataRef.current
  const [state, setState] = useState<RequestResourceState<T>>({ data: initialData, loading: enabled, refreshing: false, error: '' })

  const run = useCallback(async (force: boolean) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setState(current => ({ ...current, loading: true, refreshing: current.data !== initialData, error: '' }))
    try {
      const data = await loader(controller.signal, { force })
      if (!controller.signal.aborted) setState({ data, loading: false, refreshing: false, error: '' })
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error)) setState(current => ({ ...current, loading: false, refreshing: false, error: error instanceof Error ? error.message : '请求失败，请稍后重试' }))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [initialData, loader])

  useEffect(() => {
    if (!enabled) return () => undefined
    void run(false)
    return () => controllerRef.current?.abort()
  }, [enabled, run, ...dependencies])

  const reload = useCallback(() => run(true), [run])
  const cancel = useCallback(() => controllerRef.current?.abort(), [])
  return { ...state, reload, cancel }
}
