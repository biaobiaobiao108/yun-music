import { describe, test, expect, beforeEach } from 'bun:test'

;(global as any).lx = {
  dataPath: 'd:\\test_data',
  userPath: 'd:\\test_users',
  config: {
    'frontend.password': 'admin_secret',
    users: [{ name: 'test_u', password: 'pwd' }],
    serverName: 'LX Server Test',
  },
}

const { createSystemRouter } = await import('@/server/routes/system')

describe('System Routes (routes/system.ts)', () => {
  beforeEach(() => {
    const lxGlobal = (global as any).lx;
    lxGlobal.config['frontend.password'] = 'admin_secret';
  })

  test('GET /api/stats requires admin auth', async () => {
    const router = createSystemRouter()

    // No auth
    const req1 = new Request('http://localhost:9527/api/stats')
    const res1 = await router.handle(req1)
    expect(res1.status).toBe(401)

    // With admin auth
    const req2 = new Request('http://localhost:9527/api/stats', {
      headers: { 'x-frontend-auth': 'admin_secret' },
    })
    const res2 = await router.handle(req2)
    expect(res2.status).toBe(200)
    const json = await res2.json()
    expect(json.users).toBe(1)
    expect(json.uptime).toBeGreaterThanOrEqual(0)
  })

  test('GET /api/config returns full configuration for admin', async () => {
    const router = createSystemRouter()

    const req = new Request('http://localhost:9527/api/config', {
      headers: { 'x-frontend-auth': 'admin_secret' },
    })
    const res = await router.handle(req)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.serverName).toBe('LX Server Test')
  })

  test('removed external protocol endpoints are unavailable', async () => {
    const router = createSystemRouter()
    const res = await router.handle(new Request('http://localhost:9527/api/webdav/logs', {
      headers: { 'x-frontend-auth': 'admin_secret' },
    }))
    expect(res.status).toBe(404)
  })
})
