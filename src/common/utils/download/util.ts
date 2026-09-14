export const STATUS = {
  idle: 'IDLE',
  init: 'INIT',
  running: 'RUNNING',
  paused: 'PAUSED',
  stopped: 'STOPPED',
  completed: 'COMPLETED',
  error: 'ERROR',
  failed: 'FAILED',
} as const

export const getRequestProxy = (_url: string, proxy?: { host: string, port: number }) => {
  if (!proxy) return undefined
  return `http://${proxy.host}:${proxy.port}`
}
