import { describe, test, expect } from 'bun:test'
import { Router, corsMiddleware, securityHeadersMiddleware, HttpContext } from '@/server/core'

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

  test('same-origin CORS policy and OPTIONS preflight', async () => {
    const router = new Router()
    router.use(corsMiddleware)
    router.get('/api/data', (ctx) => ctx.json({ ok: true }))

    // Preflight OPTIONS
    const optReq = new Request('http://localhost:9527/api/data', { method: 'OPTIONS' })
    const optRes = await router.handle(optReq)
    expect(optRes.status).toBe(204)
    expect(optRes.headers.get('Access-Control-Allow-Methods')).toContain('GET')

    // Actual GET
    const getReq = new Request('http://localhost:9527/api/data', { method: 'GET' })
    const getRes = await router.handle(getReq)
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('Access-Control-Allow-Origin')).toBeNull()

    const crossOrigin = await router.handle(new Request('http://localhost:9527/api/data', {
      headers: { Origin: 'https://attacker.example' },
    }))
    expect(crossOrigin.status).toBe(403)
  })

  test('same-origin CORS policy respects HTTPS reverse proxy headers', async () => {
    const router = new Router()
    router.use(corsMiddleware)
    router.get('/api/data', (ctx) => ctx.json({ ok: true }))

    const sameSiteThroughProxy = await router.handle(new Request('http://127.0.0.1:9527/api/data', {
      headers: {
        Host: 'music.example.com',
        Origin: 'https://music.example.com',
        'X-Forwarded-Proto': 'https',
      },
    }))
    expect(sameSiteThroughProxy.status).toBe(200)
    expect(sameSiteThroughProxy.headers.get('Access-Control-Allow-Origin')).toBe('https://music.example.com')

    const differentSiteThroughProxy = await router.handle(new Request('http://127.0.0.1:9527/api/data', {
      headers: {
        Host: 'music.example.com',
        Origin: 'https://attacker.example',
        'X-Forwarded-Proto': 'https',
      },
    }))
    expect(differentSiteThroughProxy.status).toBe(403)

    const forwardedHeader = await router.handle(new Request('http://127.0.0.1:9527/api/data', {
      headers: {
        Host: 'music.example.com',
        Origin: 'https://music.example.com',
        Forwarded: 'for=192.0.2.10;proto=https;host=music.example.com',
      },
    }))
    expect(forwardedHeader.status).toBe(200)
  })

  test('security middleware adds request tracing and browser policy headers', async () => {
    const router = new Router()
    router.use(securityHeadersMiddleware)
    router.get('/healthz', (ctx) => ctx.json({ ok: true }))

    const res = await router.handle(new Request('http://localhost:9527/healthz'))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Request-ID')).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
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

  test('Prefix middleware with wildcards correctly intercepts matching subpaths', async () => {
    const router = new Router()
    let intercepted = false

    router.use('/api/custom-source/*', async (ctx, next) => {
      intercepted = true
      return ctx.fail(403, '访问受限')
    })
    router.post('/api/custom-source/import', (ctx) => ctx.json({ ok: true }))
    router.get('/api/other/endpoint', (ctx) => ctx.json({ ok: true }))

    // 匹配 /api/custom-source/* 的请求应被中间件拦截
    const resBlocked = await router.handle(new Request('http://localhost:9527/api/custom-source/import', { method: 'POST' }))
    expect(resBlocked.status).toBe(403)
    expect(intercepted).toBe(true)

    // 不匹配的请求不应被中间件拦截
    intercepted = false
    const resPass = await router.handle(new Request('http://localhost:9527/api/other/endpoint'))
    expect(resPass.status).toBe(200)
    expect(intercepted).toBe(false)
  })
})

