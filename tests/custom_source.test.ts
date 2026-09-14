import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession, USER_SESSION_COOKIE_NAME } from '@/server/auth'
import { userSessions } from '@/server/routes/auth'
import { createCustomSourceRouter } from '@/server/routes/customSource'

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
})
