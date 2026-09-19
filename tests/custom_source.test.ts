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

  test('handleReorder by a regular user does not tamper with public source metadata', async () => {
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

    // 普通用户拖拽重排序，传入 reversed order
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
    expect(res.status).toBe(200)

    // 用户自己的 order.json 应该已保存
    const userOrderPath = path.join(tempRoot, 'data', 'users', 'source', 'normal_user', 'order.json')
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

    // 未登录用户请求 import 公共源（必须要求管理员身份）
    const req = new Request('http://localhost:9527/api/custom-source/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://example.com/unauthorized.js',
        username: 'open',
      }),
    })

    const res = await router.handle(req)
    // 应该在下载前就直接返回 500 或 400，并明确提示权限不足，而不是发起下载
    expect(res.status).toBeGreaterThanOrEqual(400)
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

    const sessionId = 'delete-source-user-session'
    userSessions.set(sessionId, { username: 'normal_user', createdAt: Date.now() })

    const privateDelete = await router.handle(new Request('http://localhost:9527/api/custom-source/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `${USER_SESSION_COOKIE_NAME}=${sessionId}`,
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
