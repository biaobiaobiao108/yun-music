import { describe, test, expect, beforeEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createStaticRouter, isPathInside } from '@/server/routes/static'
import { Router } from '@/server/core'

describe('Static Routing & Frontend Serving (routes/static.ts)', () => {
  const publicDir = path.join(process.cwd(), 'public')

  beforeEach(() => {
    (global as any).lx = {
      dataPath: publicDir,
      staticPath: publicDir,
      config: {
        'player.path': '/music',
        'admin.path': '',
        'player.enableAuth': false,
        port: 9527,
      },
    }
  })

  test('isPathInside prevents directory traversal attacks', () => {
    expect(isPathInside(path.join(publicDir, 'app.js'), publicDir)).toBe(true)
    expect(isPathInside(path.join(publicDir, 'music/index.html'), publicDir)).toBe(true)
    expect(isPathInside(path.join(publicDir, '../config.js'), publicDir)).toBe(false)
    expect(isPathInside('/etc/passwd', publicDir)).toBe(false)
  })

  test('GET /js/config.js returns dynamic runtime configuration', async () => {
    const router = new Router()
    router.mount('/', createStaticRouter())

    const req = new Request('http://localhost:9527/js/config.js')
    const res = await router.handle(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('javascript')
    const text = await res.text()
    expect(text).toContain('window.CONFIG =')
    expect(text).toContain('"port": 9527')
    expect(text).toContain('"version": "v2.0.0"')
    expect(text).toMatch(/"buildHash":\s*"[a-f0-9]{7}"/)
  })

  test('Serves static files and handles ETag/304 caching', async () => {
    const router = new Router()
    router.mount('/', createStaticRouter())

    // First request
    const adminEntry = fs.readdirSync(publicDir).find(name => /^app-[a-z0-9]+\.js$/i.test(name))
    expect(adminEntry).toBeTruthy()
    const req1 = new Request(`http://localhost:9527/${adminEntry}`)
    const res1 = await router.handle(req1)
    if (res1.status === 200) {
      expect(res1.headers.get('Cache-Control')).toContain('immutable')
      const etag = res1.headers.get('ETag')
      expect(etag).toBeTruthy()

      // Conditional request
      const req2 = new Request(`http://localhost:9527/${adminEntry}`, {
        headers: {
          'if-none-match': etag!,
        },
      })
      const res2 = await router.handle(req2)
      expect(res2.status).toBe(304)
    }

    const html = await router.handle(new Request('http://localhost:9527/'))
    expect(html.headers.get('Cache-Control')).toContain('no-cache')
    const head = await router.handle(new Request(`http://localhost:9527/${adminEntry}`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(await head.arrayBuffer()).toHaveLength(0)
  })

  test('Player auth redirects to login when enabled and unauthenticated', async () => {
    (global as any).lx.config['player.enableAuth'] = true

    const router = new Router()
    router.mount('/', createStaticRouter())

    const req = new Request('http://localhost:9527/music/')
    const res = await router.handle(req)

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/music/login')
  })

  test('Public player assets bypass player auth', async () => {
    (global as any).lx.config['player.enableAuth'] = true

    const router = new Router()
    router.mount('/', createStaticRouter())

    const req = new Request('http://localhost:9527/music/manifest.json')
    const res = await router.handle(req)
    // Should not redirect to login, either 200 or 404
    expect(res.status).not.toBe(302)
  })

  test('GET / serves index.html for default admin path', async () => {
    const router = new Router()
    router.mount('/', createStaticRouter())

    const req = new Request('http://localhost:9527/')
    const res = await router.handle(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  test('does not serve runtime database files from the static root', async () => {
    const router = new Router()
    router.mount('/', createStaticRouter())

    const database = await router.handle(new Request('http://localhost:9527/yun-yin.db'))
    const wal = await router.handle(new Request('http://localhost:9527/yun-yin.db-wal'))

    expect(database.status).toBe(404)
    expect(wal.status).toBe(404)
  })

  test('RootRouter with corsMiddleware handles unhandled routes with null fallback gracefully', async () => {
    const { createRootRouter } = await import('@/server/routes')
    const rootRouter = createRootRouter().setNotFound(() => null)

    const req = new Request('http://localhost:9527/api/unhandled-custom-non-existent')
    const res = await rootRouter.handle(req)
    // Should return null (fallback to legacy server handler) without throwing TypeError
    expect(res).toBeNull()
  })

  test('Removed admin file manager does not remove player cache routes', async () => {
    const { createRootRouter } = await import('@/server/routes')
    const rootRouter = createRootRouter().setNotFound(() => null)

    const filePage = await rootRouter.handle(new Request('http://localhost:9527/filemanager.html'))
    expect(filePage.status).toBe(404)

    const elFinder = await rootRouter.handle(new Request('http://localhost:9527/api/elfinder/connector?cmd=open'))
    expect(elFinder).toBeNull()

    const legacyFiles = await rootRouter.handle(new Request('http://localhost:9527/api/files'))
    expect(legacyFiles).toBeNull()

    const cacheStats = await rootRouter.handle(new Request('http://localhost:9527/api/music/cache/stats'))
    expect(cacheStats).not.toBeNull()
    expect(cacheStats.status).not.toBe(404)
  })
})
