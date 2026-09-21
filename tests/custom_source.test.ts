import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession, USER_SESSION_COOKIE_NAME } from '@/server/auth'
import { userSessions } from '@/server/routes/auth'
import { createCustomSourceRouter } from '@/server/routes/customSource'
import * as networkSecurity from '@/server/networkSecurity'
import { closeDb } from '@/database'

describe('Custom Source Security and Isolation', () => {
  let tempRoot: string
  let prevGlobalLx: any

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-custom-source-test-'))
    prevGlobalLx = (global as any).lx
    ;(global as any).lx = {
      dataPath: path.join(tempRoot, 'data'),
      config: {
        'frontend.password': 'admin_secret',
        'user.enablePublicRestriction': false,
        users: [{ name: 'normal_user', password: 'pwd' }],
      },
    }
  })

  afterEach(() => {
    closeDb()
    ;(global as any).lx = prevGlobalLx
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch { }
  })

  test('custom source mutations require admin and admin reorder does not tamper with public metadata', async () => {
    const router = createCustomSourceRouter()
    const openDir = path.join(tempRoot, 'data', 'users', 'source', '_open')
    fs.mkdirSync(openDir, { recursive: true })

    const initialOpenSources = [
      { id: 'source_a.js', name: 'Source A' },
      { id: 'source_b.js', name: 'Source B' },
    ]
    fs.writeFileSync(path.join(openDir, 'sources.json'), JSON.stringify(initialOpenSources, null, 2))
    fs.writeFileSync(path.join(openDir, 'order.json'), JSON.stringify(['source_a.js', 'source_b.js'], null, 2))

    // 模拟普通用户 session
    const sessionId = 'user_session_token_123'
    userSessions.set(sessionId, { username: 'normal_user', createdAt: Date.now() })

    // 普通用户不能再写入排序文件，且请求应在文件操作前被拒绝。
    const req = new Request('http://localhost:9527/api/custom-source/reorder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `${USER_SESSION_COOKIE_NAME}=${sessionId}`,
      },
      body: JSON.stringify({
        username: 'normal_user',
        sourceIds: ['source_b.js', 'source_a.js'],
      }),
    })

    const res = await router.handle(req)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('管理员权限不足')

    const userOrderPath = path.join(tempRoot, 'data', 'users', 'source', 'normal_user', 'order.json')
    expect(fs.existsSync(userOrderPath)).toBe(false)

    // 管理员可以管理账户专属作用域。
    const adminReq = new Request('http://localhost:9527/api/custom-source/reorder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`,
      },
      body: JSON.stringify({
        username: 'normal_user',
        sourceIds: ['source_b.js', 'source_a.js'],
      }),
    })
    const adminRes = await router.handle(adminReq)
    expect(adminRes.status).toBe(200)
    expect(fs.existsSync(userOrderPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(userOrderPath, 'utf-8'))).toEqual(['source_b.js', 'source_a.js'])

    // 公共源的 sources.json 与 order.json 严禁被篡改！
    const currentOpenSources = JSON.parse(fs.readFileSync(path.join(openDir, 'sources.json'), 'utf-8'))
    expect(currentOpenSources).toEqual(initialOpenSources)

    const currentOpenOrder = JSON.parse(fs.readFileSync(path.join(openDir, 'order.json'), 'utf-8'))
    expect(currentOpenOrder).toEqual(['source_a.js', 'source_b.js'])
  })

  test('handleImport rejects unauthorized user before initiating external network download', async () => {
    const router = createCustomSourceRouter()

    // 未登录用户请求 import 公共源时，必须在下载前直接拒绝。
    const req = new Request('http://localhost:9527/api/custom-source/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/unauthorized.js',
        username: 'open',
      }),
    })

    const res = await router.handle(req)
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toContain('管理员权限不足')
  })

  test('handleImport uses Bun native download and enforces 5MB size limit', async () => {
    const router = createCustomSourceRouter()
    const adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any)
    const remoteFetch = spyOn(networkSecurity, 'fetchSafeRemote').mockRejectedValue(new Error('Remote response is too large'))

    try {
      const req = new Request('http://localhost:9527/api/custom-source/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: adminCookie,
        },
        body: JSON.stringify({
          url: 'https://example.com/oversized-script.js',
          username: 'open',
        }),
      })

      const res = await router.handle(req)
      const json = await res.json()
      expect(json.success).toBe(false)
      expect(json.error).toContain('Remote script is too large')
    } finally {
      remoteFetch.mockRestore()
      lookup.mockRestore()
    }
  })

  test('router middleware blocks anonymous access when user.enablePublicRestriction is true', async () => {
    ;(global as any).lx.config['user.enablePublicRestriction'] = true
    const router = createCustomSourceRouter()

    const req = new Request('http://localhost:9527/api/custom-source/list', {
      method: 'GET',
    })

    const res = await router.handle(req)
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toContain('当前系统已开启访问限制')
  })

  test('player list keeps public enabled state and includes assigned private sources', async () => {
    const router = createCustomSourceRouter()
    const openDir = path.join(tempRoot, 'data', 'users', 'source', '_open')
    const userDir = path.join(tempRoot, 'data', 'users', 'source', 'normal_user')
    fs.mkdirSync(openDir, { recursive: true })
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(path.join(openDir, 'sources.json'), JSON.stringify([{ id: 'public.js', name: 'Public', enabled: true }]))
    fs.writeFileSync(path.join(openDir, 'states.json'), JSON.stringify({ 'public.js': { enabled: false } }))
    fs.writeFileSync(path.join(userDir, 'sources.json'), JSON.stringify([{ id: 'private.js', name: 'Private', enabled: true }]))

    const sessionId = 'source-list-user-session'
    userSessions.set(sessionId, { username: 'normal_user', createdAt: Date.now() })
    const response = await router.handle(new Request('http://localhost:9527/api/custom-source/list?username=normal_user', {
      headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${sessionId}` },
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { id: 'public.js', name: 'Public', enabled: true, owner: 'open', isPublic: true },
      { id: 'private.js', name: 'Private', enabled: true, owner: 'normal_user', isPublic: false },
    ])
  })

  test('source lists never expose imported remote URLs from persisted metadata', async () => {
    const router = createCustomSourceRouter()
    const openDir = path.join(tempRoot, 'data', 'users', 'source', '_open')
    fs.mkdirSync(openDir, { recursive: true })
    fs.writeFileSync(path.join(openDir, 'sources.json'), JSON.stringify([{
      id: 'imported.js',
      name: 'Imported',
      enabled: false,
      sourceUrl: 'https://example.com/source.js?token=do-not-leak',
    }]))

    const response = await router.handle(new Request('http://localhost:9527/api/custom-source/list'))
    expect(response.status).toBe(200)
    const body = await response.json() as Array<Record<string, unknown>>
    expect(body[0]).not.toHaveProperty('sourceUrl')
    expect(JSON.stringify(body)).not.toContain('do-not-leak')
  })

  test('admin scope queries keep public and private source lists isolated', async () => {
    const router = createCustomSourceRouter()
    const openDir = path.join(tempRoot, 'data', 'users', 'source', '_open')
    const userDir = path.join(tempRoot, 'data', 'users', 'source', 'normal_user')
    fs.mkdirSync(openDir, { recursive: true })
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(path.join(openDir, 'sources.json'), JSON.stringify([{ id: 'public.js', name: 'Public', enabled: true }]))
    fs.writeFileSync(path.join(userDir, 'sources.json'), JSON.stringify([{ id: 'private.js', name: 'Private', enabled: true }]))

    const userSession = 'admin-scope-user-session'
    userSessions.set(userSession, { username: 'normal_user', createdAt: Date.now() })
    const cookie = `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}; ${USER_SESSION_COOKIE_NAME}=${userSession}`
    const response = await router.handle(new Request('http://localhost:9527/api/custom-source/list?username=open', {
      headers: { cookie },
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { id: 'public.js', name: 'Public', enabled: true, owner: 'open', isPublic: true },
    ])
  })

  test('handleDelete removes the explicitly requested owner when public and private IDs overlap', async () => {
    const router = createCustomSourceRouter()
    const sourceId = 'shared-source.js'
    const openDir = path.join(tempRoot, 'data', 'users', 'source', '_open')
    const userDir = path.join(tempRoot, 'data', 'users', 'source', 'normal_user')
    const metadata = {
      id: sourceId,
      name: 'Shared Source',
      enabled: false,
    }

    fs.mkdirSync(openDir, { recursive: true })
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(path.join(openDir, sourceId), '// public source')
    fs.writeFileSync(path.join(userDir, sourceId), '// private source')
    fs.writeFileSync(path.join(openDir, 'sources.json'), JSON.stringify([metadata]))
    fs.writeFileSync(path.join(userDir, 'sources.json'), JSON.stringify([metadata]))
    fs.writeFileSync(path.join(userDir, 'order.json'), JSON.stringify([sourceId]))
    fs.writeFileSync(path.join(userDir, 'states.json'), JSON.stringify({ [sourceId]: { enabled: true } }))

    const privateDelete = await router.handle(new Request('http://localhost:9527/api/custom-source/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`,
      },
      body: JSON.stringify({
        username: 'normal_user',
        sourceId,
        owner: 'normal_user',
      }),
    }))

    expect(privateDelete.status).toBe(200)
    expect(await privateDelete.json()).toEqual({ success: true, id: sourceId, owner: 'normal_user' })
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'sources.json'), 'utf-8'))).toEqual([])
    expect(fs.existsSync(path.join(userDir, sourceId))).toBe(false)
    expect(fs.existsSync(path.join(openDir, sourceId))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'order.json'), 'utf-8'))).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'states.json'), 'utf-8'))).toEqual({})

    const stalePrivateDelete = await router.handle(new Request('http://localhost:9527/api/custom-source/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`,
      },
      body: JSON.stringify({
        username: 'normal_user',
        sourceId,
        owner: 'normal_user',
      }),
    }))

    expect(stalePrivateDelete.status).toBe(500)
    expect(await stalePrivateDelete.text()).toContain('源不存在')
    expect(fs.existsSync(path.join(openDir, sourceId))).toBe(true)

    const adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`
    const publicDelete = await router.handle(new Request('http://localhost:9527/api/custom-source/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        username: 'normal_user',
        sourceId,
        owner: 'open',
      }),
    }))

    expect(publicDelete.status).toBe(200)
    expect(await publicDelete.json()).toEqual({ success: true, id: sourceId, owner: 'open' })
    expect(fs.existsSync(path.join(openDir, sourceId))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(openDir, 'sources.json'), 'utf-8'))).toEqual([])
  })

  test('admin can move a source between scopes and rejects target collisions', async () => {
    const router = createCustomSourceRouter()
    const adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${createAdminSession()}`
    const sourceId = 'movable-source.js'
    const openDir = path.join(tempRoot, 'data', 'users', 'source', '_open')
    const userDir = path.join(tempRoot, 'data', 'users', 'source', 'normal_user')
    const script = `
      lx.on('request', () => null)
      lx.send('inited', { status: true, sources: { wy: 'wy' } })
    `
    fs.mkdirSync(openDir, { recursive: true })
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(path.join(openDir, sourceId), script)
    fs.writeFileSync(path.join(openDir, 'sources.json'), JSON.stringify([{ id: sourceId, name: 'Movable', enabled: false }]))
    fs.writeFileSync(path.join(openDir, 'order.json'), JSON.stringify([sourceId]))
    fs.writeFileSync(path.join(openDir, 'states.json'), JSON.stringify({ [sourceId]: { enabled: true } }))

    const moved = await router.handle(new Request('http://localhost:9527/api/custom-source/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ id: sourceId, fromOwner: 'open', toOwner: 'normal_user' }),
    }))
    expect(moved.status).toBe(200)
    expect(await moved.json()).toMatchObject({ success: true, id: sourceId, fromOwner: 'open', toOwner: 'normal_user' })
    expect(fs.existsSync(path.join(openDir, sourceId))).toBe(false)
    expect(fs.existsSync(path.join(userDir, sourceId))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(openDir, 'sources.json'), 'utf-8'))).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(userDir, 'sources.json'), 'utf-8'))).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(path.join(openDir, 'states.json'), 'utf-8'))).toEqual({})

    const collisionId = 'collision-source.js'
    fs.writeFileSync(path.join(userDir, collisionId), script)
    fs.writeFileSync(path.join(userDir, 'sources.json'), JSON.stringify([
      ...JSON.parse(fs.readFileSync(path.join(userDir, 'sources.json'), 'utf-8')),
      { id: collisionId, name: 'Collision', enabled: false },
    ]))
    fs.writeFileSync(path.join(openDir, collisionId), script)
    fs.writeFileSync(path.join(openDir, 'sources.json'), JSON.stringify([{ id: collisionId, name: 'Collision source', enabled: false }]))

    const collision = await router.handle(new Request('http://localhost:9527/api/custom-source/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ id: collisionId, fromOwner: 'open', toOwner: 'normal_user' }),
    }))
    expect(collision.status).toBe(500)
    expect(await collision.text()).toContain('目标作用域已存在同名音源')
    expect(fs.existsSync(path.join(openDir, collisionId))).toBe(true)
  })

  test('all custom source write endpoints reject a regular user before touching files', async () => {
    const router = createCustomSourceRouter()
    const sessionId = 'regular-source-write-session'
    userSessions.set(sessionId, { username: 'normal_user', createdAt: Date.now() })
    const cookie = `${USER_SESSION_COOKIE_NAME}=${sessionId}`
    const requests = [
      ['/api/custom-source/validate', { script: 'lx.send("inited", { sources: {} })', username: 'normal_user' }],
      ['/api/custom-source/upload', { filename: 'blocked.js', content: 'blocked', username: 'normal_user' }],
      ['/api/custom-source/toggle', { id: 'blocked.js', enabled: true, username: 'normal_user' }],
      ['/api/custom-source/delete', { id: 'blocked.js', sourceOwner: 'normal_user' }],
      ['/api/custom-source/reorder', { username: 'normal_user', sourceIds: [] }],
      ['/api/custom-source/assign', { id: 'blocked.js', fromOwner: 'open', toOwner: 'normal_user' }],
    ] as const

    for (const [pathname, body] of requests) {
      const response = await router.handle(new Request(`http://localhost:9527${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      }))
      expect(response.status).toBe(403)
      expect((await response.json()).error).toContain('管理员权限不足')
    }
  })

  test('sandbox lx.request dispatches request via native fetch and delivers parsed JSON', async () => {
    const { loadUserApi } = await import('@/server/userApi')
    const lookup = spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any)
    const remoteFetch = spyOn(networkSecurity, 'fetchSafeRemote').mockResolvedValue(new Response(JSON.stringify({ code: 0, message: 'hello from test' }), {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom-Header': 'lx-music',
      },
    }))
    try {
      let capturedResp: any = null
      let capturedBody: any = null

      const script = `
        lx.on('request', ({ action, source, info }) => {
          return new Promise((resolve, reject) => {
            lx.request(info.url, { method: 'get' }, (err, resp, body) => {
              if (err) reject(err)
              else resolve({ resp, body })
            })
          })
        })
        lx.send('inited', { status: true, sources: {} })
      `

      const { success, apiInstance: api } = await loadUserApi({
        id: 'test_req_source.js',
        name: 'Test Request Source',
        description: 'Testing lx.request',
        version: 1,
        author: 'Tester',
        homepage: '',
        script,
        sources: {},
        enabled: true,
      })

      expect(success).toBe(true)
      expect(api).toBeDefined()

      const result = await api!.callRequest('test', 'test_src', { url: 'https://api.example.com/data' })
      expect(result.resp.statusCode).toBe(200)
      expect(result.resp.statusMessage).toBe('OK')
      expect(result.resp.headers['x-custom-header']).toBe('lx-music')
      expect(result.body).toEqual({ code: 0, message: 'hello from test' })
    } finally {
      remoteFetch.mockRestore()
      lookup.mockRestore()
    }
  })

  test('interrupts synchronous request handlers that never yield', async () => {
    const { loadUserApi } = await import('@/server/userApi')
    const { success, apiInstance } = await loadUserApi({
      id: 'test_timeout_source.js',
      name: 'Test Timeout Source',
      description: 'Testing synchronous VM interruption',
      version: 1,
      author: 'Tester',
      homepage: '',
      script: `
        lx.on('request', () => { while (true) {} })
        lx.send('inited', { status: true, sources: {} })
      `,
      sources: {},
      enabled: true,
      persist: false,
    })

    expect(success).toBe(true)
    try {
      await expect(apiInstance.callRequest('getMusicUrl', 'test', {})).rejects.toThrow('自定义源同步处理超时')
    } finally {
      await apiInstance.dispose()
    }
  }, 8_000)
})
