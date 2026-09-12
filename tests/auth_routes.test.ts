import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { closeDb, initDatabase } from '@/database'
import { syncUsersToDatabase } from '@/user/data'

;(global as any).lx = {
  dataPath: 'd:\\test_data',
  userPath: 'd:\\test_users',
  config: {
    'frontend.password': 'admin123',
    'player.password': 'player456',
    'player.enableAuth': true,
    users: [{ name: 'test_user', password: 'password123' }],
  },
}

const { createAuthRouter, userSessions, verifyUserAuth } = await import('@/server/routes/auth')
const { PLAYER_SESSION_TTL, clearLoginFailures } = await import('@/server/auth')

describe('Web Cookie Authentication', () => {
  beforeEach(() => {
    closeDb()
    initDatabase(':memory:')
    const lxGlobal = (global as any).lx
    lxGlobal.config['frontend.password'] = 'admin123'
    lxGlobal.config['player.password'] = 'player456'
    lxGlobal.config.users = [{ name: 'test_user', password: 'password123' }]
    syncUsersToDatabase(lxGlobal.config.users)
    userSessions.clear()
  })

  afterEach(() => {
    clearLoginFailures('192.0.2.45')
    closeDb()
  })

  test('admin verification and login share their failure budget', async () => {
    const router = createAuthRouter()
    const ip = '192.0.2.45'
    const verify = (password: string) => router.handle(new Request('http://localhost/api/admin/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }), { remoteAddress: ip })
    for (let i = 0; i < 9; i++) expect((await verify('wrong')).status).toBe(401)
    expect((await verify('admin123')).status).toBe(200)
    for (let i = 0; i < 10; i++) expect((await verify('wrong')).status).toBe(401)
    expect((await verify('admin123')).status).toBe(429)
  })

  test('admin and player login issue HttpOnly SameSite cookies', async () => {
    const router = createAuthRouter()
    const admin = await router.handle(new Request('http://localhost/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'admin123' }),
    }))
    expect(admin.status).toBe(200)
    expect(admin.headers.get('set-cookie')).toContain('lx_admin_session=')
    expect(admin.headers.get('set-cookie')).toContain('HttpOnly')
    expect(admin.headers.get('set-cookie')).toContain('SameSite=Strict')

    const player = await router.handle(new Request('http://localhost/api/music/auth', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'player456' }),
    }))
    expect(player.status).toBe(200)
    expect(player.headers.get('set-cookie')).toContain('lx_player_session=')
    expect(player.headers.get('set-cookie')).toContain(`Max-Age=${PLAYER_SESSION_TTL / 1000}`)
  })

  test('HTTPS reverse proxy requests keep same-origin access and secure cookies', async () => {
    const router = createAuthRouter()
    const response = await router.handle(new Request('http://127.0.0.1:9527/api/login', {
      method: 'POST',
      headers: {
        Host: 'music.example.com',
        Origin: 'https://music.example.com',
        'X-Forwarded-Proto': 'https',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: 'admin123' }),
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('Secure')
  })

  test('user session survives in-memory cache loss and logout revokes it', async () => {
    const router = createAuthRouter()
    const login = await router.handle(new Request('http://localhost/api/user/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test_user', password: 'password123' }),
    }))
    expect(login.status).toBe(200)
    const cookie = login.headers.get('Set-Cookie')!.split(';', 1)[0]
    const sessionId = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
    userSessions.delete(sessionId)

    const verify = await router.handle(new Request('http://localhost/api/user/auth/verify', { headers: { cookie } }))
    expect(await verify.json()).toEqual({ valid: true, username: 'test_user' })
    expect(verifyUserAuth(new Request('http://localhost/api/user/auth/verify', { headers: { cookie } }))).toBe('test_user')

    const logout = await router.handle(new Request('http://localhost/api/user/logout', { method: 'POST', headers: { cookie } }))
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0')
    const afterLogout = await router.handle(new Request('http://localhost/api/user/auth/verify', { headers: { cookie } }))
    expect(await afterLogout.json()).toEqual({ valid: false, username: null })
  })

  test('legacy password, token headers and token query parameters are rejected', async () => {
    const router = createAuthRouter()
    const response = await router.handle(new Request('http://localhost/api/user/auth/verify?token=legacy', {
      headers: { 'x-user-name': 'test_user', 'x-user-password': 'password123' },
    }))
    expect(await response.json()).toEqual({ valid: false, username: null })
  })
})
