import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDb } from '@/database'

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-yin-auth-test-'))

// Initialize global.lx before importing modules that depend on it at top-level
;(global as any).lx = {
  dataPath: testDataDir,
  config: {
    'frontend.password': 'secure123',
    'user.enablePath': false,
  },
}

const { verifyAdminAuth, createAdminSession, ADMIN_SESSION_COOKIE_NAME } = await import('../src/server/auth')

describe('Admin Authentication Security (verifyAdminAuth)', () => {
  beforeEach(() => {
    (global as any).lx.config['frontend.password'] = 'secure123'
  })

  it('should allow access when a valid HttpOnly session cookie is present', () => {
    const session = createAdminSession()
    const mockReq = {
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=${session}` },
    } as any

    expect(verifyAdminAuth(mockReq)).toBe(true)
  })

  it('should deny access when cookie is missing', () => {
    const mockReq = {
      headers: {},
    } as any

    expect(verifyAdminAuth(mockReq)).toBe(false)
  })

  it('should deny access when the session cookie is unknown', () => {
    const mockReq = {
      headers: { cookie: `${ADMIN_SESSION_COOKIE_NAME}=unknown` },
    } as any

    expect(verifyAdminAuth(mockReq)).toBe(false)
  })

  it('should deny access when configured password is empty or not set (prevents empty bypass)', () => {
    (global as any).lx.config['frontend.password'] = ''
    const mockReq1 = {
      headers: { 'x-frontend-auth': '' },
    } as any
    expect(verifyAdminAuth(mockReq1)).toBe(false)

    delete (global as any).lx.config['frontend.password']
    const mockReq2 = {
      headers: {},
    } as any
    expect(verifyAdminAuth(mockReq2)).toBe(false)
  })

  it('should reject query-string and legacy header authentication', () => {
    const urlWithAuth = new URL('http://localhost:9527/api/admin?auth=secure123')
    const mockReq = {
      headers: { 'x-frontend-auth': 'secure123' },
    } as any

    expect(verifyAdminAuth(mockReq)).toBe(false)
    expect(verifyAdminAuth({ headers: {} } as any)).toBe(false)
    expect(verifyAdminAuth({ headers: { cookie: urlWithAuth.searchParams.toString() } } as any)).toBe(false)
  })

  afterAll(() => {
    closeDb()
    try { fs.rmSync(testDataDir, { recursive: true, force: true }) } catch { }
  })
})
