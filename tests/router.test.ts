import { describe, test, expect } from 'bun:test'
import { Router, corsMiddleware, HttpContext } from '@/server/core'

describe('Core Router & HttpContext', () => {
  test('Exact route match and JSON response', async () => {
    const router = new Router()
    router.get('/api/ping', (ctx) => ctx.json({ msg: 'pong' }))

    const req = new Request('http://localhost:9527/api/ping', { method: 'GET' })
    const res = await router.handle(req)

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ msg: 'pong' })
  })

  test('Prefix route matching with wildcards', async () => {
    const router = new Router()
    router.get('/music/*', (ctx) => ctx.text(`Path: ${ctx.pathname}`))

    const req = new Request('http://localhost:9527/music/assets/style.css')
    const res = await router.handle(req)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Path: /music/assets/style.css')
  })

  test('Subrouter mounting with prefix', async () => {
    const apiRouter = new Router()
    apiRouter.get('/user/info', (ctx) => ctx.json({ name: 'test_user' }))
    apiRouter.post('/user/update', (ctx) => ctx.json({ success: true }))

    const rootRouter = new Router()
    rootRouter.mount('/api/v1', apiRouter)

    const reqGet = new Request('http://localhost:9527/api/v1/user/info')
    const resGet = await rootRouter.handle(reqGet)
    expect(resGet.status).toBe(200)
    expect(await resGet.json()).toEqual({ name: 'test_user' })

    const reqPost = new Request('http://localhost:9527/api/v1/user/update', { method: 'POST' })
    const resPost = await rootRouter.handle(reqPost)
    expect(resPost.status).toBe(200)
    expect(await resPost.json()).toEqual({ success: true })
  })

  test('Middleware onion execution flow', async () => {
    const router = new Router()
    const trail: string[] = []

    router.use(async (ctx, next) => {
      trail.push('m1_start')
      const res = await next()
      trail.push('m1_end')
      return res
    })

    router.use(async (ctx, next) => {
      trail.push('m2_start')
      const res = await next()
      trail.push('m2_end')
      return res
    })

    router.get('/test', (ctx) => {
      trail.push('handler')
      return ctx.text('ok')
    })

    const req = new Request('http://localhost:9527/test')
    const res = await router.handle(req)
    expect(res.status).toBe(200)
    expect(trail).toEqual(['m1_start', 'm2_start', 'handler', 'm2_end', 'm1_end'])
  })

  test('CORS middleware and OPTIONS preflight', async () => {
    const router = new Router()
    router.use(corsMiddleware)
    router.get('/api/data', (ctx) => ctx.json({ ok: true }))

    // Preflight OPTIONS
    const optReq = new Request('http://localhost:9527/api/data', { method: 'OPTIONS' })
    const optRes = await router.handle(optReq)
    expect(optRes.status).toBe(204)
    expect(optRes.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(optRes.headers.get('Access-Control-Allow-Methods')).toContain('GET')

    // Actual GET
    const getReq = new Request('http://localhost:9527/api/data', { method: 'GET' })
    const getRes = await router.handle(getReq)
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('Context cookie and query parsing', async () => {
    const router = new Router()
    router.get('/query-test', (ctx) => {
      return ctx.json({
        q: ctx.query.get('q'),
        session: ctx.cookies['session_id'],
      })
    })

    const req = new Request('http://localhost:9527/query-test?q=bun', {
      headers: {
        cookie: 'session_id=abc123xyz; theme=dark',
      },
    })
    const res = await router.handle(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      q: 'bun',
      session: 'abc123xyz',
    })
  })

  test('404 Not Found fallback', async () => {
    const router = new Router()
    const req = new Request('http://localhost:9527/non-existent')
    const res = await router.handle(req)
    expect(res.status).toBe(404)
    const data = await res.json()
    expect(data.code).toBe(404)
  })

  test('stopServer is exported and gracefully handles unstarted or running state', async () => {
    const { stopServer, getStatus } = await import('@/server')
    expect(typeof stopServer).toBe('function')
    await expect(stopServer(true)).resolves.toBeUndefined()
    const status = getStatus()
    expect(status.status).toBe(false)
  })
})
