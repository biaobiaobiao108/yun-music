import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ADMIN_SESSION_COOKIE_NAME, checkAdminSession, checkPlayerAuthSession, createAdminSession, createPlayerSession, SESSION_COOKIE_NAME } from '@/server/auth'
import { hashPassword, isPasswordHash } from '@/utils/passwordHash'
import { closeDb } from '@/database'

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-yin-sys-test-'))
const testUserDir = path.join(testDataDir, 'users')

;(global as any).lx = {
  dataPath: testDataDir,
  userPath: testUserDir,
  config: {
    'frontend.password': 'admin_secret',
    users: [{ name: 'test_u', password: 'pwd' }],
    serverName: 'LX Server Test',
  },
}

const { createSystemRouter, reloadServerData } = await import('@/server/routes/system')

describe('System Routes (routes/system.ts)', () => {
  beforeEach(() => {
    const lxGlobal = (global as any).lx;
    lxGlobal.config['frontend.password'] = 'admin_secret';
    delete lxGlobal.config['frontend.passwordHash'];
    delete lxGlobal.config['player.passwordHash'];
    delete lxGlobal.config['player.password'];
    lxGlobal.config['player.enableAuth'] = false;
    lxGlobal.config['admin.path'] = '';
    lxGlobal.config['player.path'] = '/music';
  })

  test('GET /api/stats requires admin auth', async () => {
    const router = createSystemRouter()

    // No auth
    const req1 = new Request('http://localhost:9527/api/stats')
    const res1 = await router.handle(req1)
    expect(res1.status).toBe(401)

    // With admin auth
    const req2 = new Request('http://localhost:9527/api/stats', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}` },
    })
    const res2 = await router.handle(req2)
    expect(res2.status).toBe(200)
    const json = await res2.json()
    expect(json.users).toBe(1)
    expect(json.uptime).toBeGreaterThanOrEqual(0)
    expect(json.cacheStats).toBeDefined()
    expect(typeof json.cacheStats.cache.fileCount).toBe('number')
    expect(typeof json.cacheStats.cache.totalSize).toBe('number')
    expect(typeof json.cacheStats.music.fileCount).toBe('number')
    expect(typeof json.cacheStats.music.totalSize).toBe('number')
  })

  test('GET /api/config returns full configuration for admin', async () => {
    const router = createSystemRouter()

    const req = new Request('http://localhost:9527/api/config', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}` },
    })
    const res = await router.handle(req)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.serverName).toBe('LX Server Test')
  })

  test('POST /api/config requires admin auth', async () => {
    const router = createSystemRouter()
    const req = new Request('http://localhost:9527/api/config', {
      method: 'POST',
      body: JSON.stringify({ serverName: 'New Server' }),
    })
    const res = await router.handle(req)
    expect(res.status).toBe(401)
  })

  test('POST /api/config updates configuration and triggers saveConfig', async () => {
    let saveConfigCalled = false
    ;(global as any).lx.saveConfig = async () => {
      saveConfigCalled = true
    }
    const router = createSystemRouter()
    const req = new Request('http://localhost:9527/api/config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`,
      },
      body: JSON.stringify({
        serverName: 'Updated Server Name',
        'user.enablePath': true,
        'user.enableRoot': false,
      }),
    })
    const res = await router.handle(req)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)
    expect(saveConfigCalled).toBe(true)
    expect((global as any).lx.config.serverName).toBe('Updated Server Name')
  })

  test('POST /api/config rejects identical admin and player paths', async () => {
    const router = createSystemRouter()
    const req = new Request('http://localhost:9527/api/config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`,
      },
      body: JSON.stringify({
        'admin.path': '/music',
        'player.path': '/music',
      }),
    })
    const res = await router.handle(req)
    expect(res.status).toBe(422)
  })

  test('POST /api/config rejects overlapping admin and player path prefixes', async () => {
    const router = createSystemRouter()
    const req = new Request('http://localhost:9527/api/config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`,
      },
      body: JSON.stringify({
        'admin.path': '/app',
        'player.path': '/app/music',
      }),
    })
    const res = await router.handle(req)
    expect(res.status).toBe(422)
  })

  test('POST /api/config stores admin and player passwords as hashes', async () => {
    const router = createSystemRouter()
    const adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`
    const playerCookie = `${SESSION_COOKIE_NAME}=${createPlayerSession()}`
    const req = new Request('http://localhost:9527/api/config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        'frontend.password': 'new-admin-secret',
        'player.enableAuth': true,
        'player.password': 'new-player-secret',
      }),
    })
    const res = await router.handle(req)
    expect(res.status).toBe(200)
    const config = (global as any).lx.config
    expect(isPasswordHash(config['frontend.passwordHash'])).toBe(true)
    expect(isPasswordHash(config['player.passwordHash'])).toBe(true)
    expect(config['frontend.password']).toBeUndefined()
    expect(config['player.password']).toBeUndefined()
    expect(checkAdminSession(new Request('http://localhost/api/status', { headers: { cookie: adminCookie } }))).toBe(false)
    expect(checkPlayerAuthSession({ [SESSION_COOKIE_NAME]: playerCookie.split('=')[1] })).toBe(false)
  })

  test('restored player password hashes satisfy the enabled-auth validation', async () => {
    const passwordHash = hashPassword('restored-player-secret')
    const previousConfigPath = process.env.CONFIG_PATH
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-music-system-route-test-'))
    const configPath = path.join(tempRoot, 'config.js')
    fs.writeFileSync(configPath, `module.exports = ${JSON.stringify({ 'player.enableAuth': true, 'player.passwordHash': passwordHash })}\n`)
    process.env.CONFIG_PATH = configPath
    try {
      await reloadServerData()
      expect((global as any).lx.config['player.enableAuth']).toBe(true)
      expect((global as any).lx.config['player.passwordHash']).toBe(passwordHash)
    } finally {
      process.env.CONFIG_PATH = previousConfigPath
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('removed external protocol endpoints are unavailable', async () => {
    const router = createSystemRouter()
    const res = await router.handle(new Request('http://localhost:9527/api/webdav/logs', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}` },
    }))
    expect(res.status).toBe(404)
  })

  afterAll(() => {
    closeDb()
    try { fs.rmSync(testDataDir, { recursive: true, force: true }) } catch { }
  })
})
