import { describe, expect, it } from 'bun:test'
import { clearRequestCache } from '../frontend/player/src/react/data/request'
import type { CacheTask } from '../frontend/player/src/react/api'
import { useCacheStore } from '../frontend/player/src/react/store/cache'
import { usePlayerUiStore } from '../frontend/player/src/react/store/ui'

type RecordedRequest = { path: string; method: string; body: Record<string, unknown> }

function installCacheApi(initialTasks: CacheTask[]) {
  const tasks = initialTasks.map(task => ({ ...task }))
  const requests: RecordedRequest[] = []
  const failPaths = new Set<string>()
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname
    const method = String(init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requests.push({ path, method, body })
    if (failPaths.has(path)) return new Response(JSON.stringify({ message: '模拟请求失败' }), { status: 503 })

    if (method === 'POST' && path === '/api/music/cache/stop') {
      const id = String(body.queueId || '')
      for (const task of tasks) {
        if ((body.all === true || task.id === id) && ['waiting', 'downloading', 'tagging'].includes(String(task.status))) {
          task.status = 'paused'
          task.errorMsg = '已暂停'
        }
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    if (method === 'POST' && path === '/api/music/cache/queue/resume') {
      const id = String(body.id || '')
      for (const task of tasks) {
        if ((body.all === true || task.id === id) && ['paused', 'error'].includes(String(task.status))) {
          task.status = 'waiting'
          task.errorMsg = ''
        }
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    if (method === 'POST' && path === '/api/music/cache/queue/remove') {
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        const task = tasks[index]
        if (body.id && task?.id === body.id || body.completed === true && ['finished', 'exists'].includes(String(task?.status)) || body.all === true) tasks.splice(index, 1)
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }

    if (path === '/api/music/cache/queue') return new Response(JSON.stringify({ success: true, data: tasks.map(task => ({ ...task })) }), { status: 200 })
    if (path === '/api/music/cache/stats') return new Response(JSON.stringify({ success: true, data: { cacheSize: 1024, musicSize: 2048 } }), { status: 200 })
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }) as typeof fetch
  return { tasks, requests, failPaths }
}

async function withCacheApi<T>(initialTasks: CacheTask[], run: (api: ReturnType<typeof installCacheApi>) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  clearRequestCache()
  useCacheStore.getState().reset()
  usePlayerUiStore.setState({ notice: null })
  const api = installCacheApi(initialTasks)
  try {
    return await run(api)
  } finally {
    globalThis.fetch = originalFetch
    clearRequestCache()
    useCacheStore.getState().reset()
    usePlayerUiStore.setState({ notice: null })
  }
}

describe('React player download queue controls', () => {
  it('pauses, resumes, retries and removes tasks through the existing queue API', async () => {
    await withCacheApi([
      { id: 'active', status: 'downloading', progress: 42 },
      { id: 'paused', status: 'paused' },
      { id: 'failed', status: 'error', errorMsg: '源站暂不可用' },
      { id: 'finished', status: 'finished' },
      { id: 'already-finished', status: 'exists' },
    ], async api => {
      await useCacheStore.getState().load({ force: true })
      expect(await useCacheStore.getState().pauseTask('active')).toBe(true)
      expect(useCacheStore.getState().tasks.find(task => task.id === 'active')?.status).toBe('paused')
      expect(await useCacheStore.getState().resumeTask('paused')).toBe(true)
      expect(await useCacheStore.getState().resumeTask('failed')).toBe(true)
      expect(useCacheStore.getState().tasks.map(task => [task.id, task.status])).toEqual([
        ['active', 'paused'],
        ['paused', 'waiting'],
        ['failed', 'waiting'],
        ['finished', 'finished'],
        ['already-finished', 'exists'],
      ])
      expect(await useCacheStore.getState().remove('finished')).toBe(true)
      expect(useCacheStore.getState().tasks.some(task => task.id === 'finished')).toBe(false)
      expect(await useCacheStore.getState().removeCompleted()).toBe(true)
      expect(useCacheStore.getState().tasks.some(task => task.id === 'already-finished')).toBe(false)

      const commands = api.requests.filter(request => request.method === 'POST')
      expect(commands).toEqual([
        { path: '/api/music/cache/stop', method: 'POST', body: { queueId: 'active', all: false } },
        { path: '/api/music/cache/queue/resume', method: 'POST', body: { id: 'paused', all: false } },
        { path: '/api/music/cache/queue/resume', method: 'POST', body: { id: 'failed', all: false } },
        { path: '/api/music/cache/queue/remove', method: 'POST', body: { id: 'finished' } },
        { path: '/api/music/cache/queue/remove', method: 'POST', body: { all: false, completed: true } },
      ])
      expect(useCacheStore.getState().pendingTaskActions).toEqual({})
    })
  })

  it('supports batch pause and continue, including retrying failed tasks', async () => {
    await withCacheApi([
      { id: 'waiting', status: 'waiting' },
      { id: 'downloading', status: 'downloading' },
      { id: 'paused', status: 'paused' },
      { id: 'failed', status: 'error', errorMsg: '失败原因' },
    ], async api => {
      await useCacheStore.getState().load({ force: true })
      expect(await useCacheStore.getState().pauseAll()).toBe(true)
      expect(useCacheStore.getState().tasks.filter(task => task.status === 'paused')).toHaveLength(3)
      expect(useCacheStore.getState().tasks.find(task => task.id === 'failed')?.status).toBe('error')
      expect(await useCacheStore.getState().resumeAll()).toBe(true)
      expect(useCacheStore.getState().tasks.every(task => task.status === 'waiting')).toBe(true)
      expect(api.requests.filter(request => request.method === 'POST')).toEqual([
        { path: '/api/music/cache/stop', method: 'POST', body: { all: true } },
        { path: '/api/music/cache/queue/resume', method: 'POST', body: { all: true } },
      ])
      expect(useCacheStore.getState().pendingBatchAction).toBeNull()
    })
  })

  it('reports operation failures and retains existing tasks when a background refresh fails', async () => {
    await withCacheApi([{ id: 'active', status: 'downloading' }], async api => {
      await useCacheStore.getState().load({ force: true })
      const previousTasks = useCacheStore.getState().tasks
      const previousLoadedAt = useCacheStore.getState().loadedAt

      api.failPaths.add('/api/music/cache/queue')
      await useCacheStore.getState().load({ force: true })
      expect(useCacheStore.getState()).toMatchObject({ tasks: previousTasks, loadedAt: previousLoadedAt, loading: false })
      expect(useCacheStore.getState().error).toBeTruthy()

      api.failPaths.delete('/api/music/cache/queue')
      api.failPaths.add('/api/music/cache/stop')
      expect(await useCacheStore.getState().pauseTask('active')).toBe(false)
      expect(usePlayerUiStore.getState().notice).toMatchObject({ kind: 'error' })
      expect(useCacheStore.getState().pendingTaskActions).toEqual({})
    })
  })

  it('distinguishes first-load failure from a successfully loaded empty queue', async () => {
    await withCacheApi([], async api => {
      api.failPaths.add('/api/music/cache/queue')
      api.failPaths.add('/api/music/cache/stats')
      await useCacheStore.getState().load({ force: true })
      expect(useCacheStore.getState()).toMatchObject({ tasks: [], loadedAt: 0, loading: false })
      expect(useCacheStore.getState().error).toBeTruthy()

      api.failPaths.clear()
      await useCacheStore.getState().load({ force: true })
      expect(useCacheStore.getState()).toMatchObject({ tasks: [], loading: false, error: '' })
      expect(useCacheStore.getState().loadedAt).toBeGreaterThan(0)
    })
  })
})
