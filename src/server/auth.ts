import crypto from 'node:crypto'
import { getDb } from '@/database'

export const SESSION_COOKIE_NAME = 'lx_player_session'
export const ADMIN_SESSION_COOKIE_NAME = 'lx_admin_session'
export const USER_SESSION_COOKIE_NAME = 'lx_user_session'
export const PLAYER_SESSION_TTL = 30 * 24 * 60 * 60 * 1000
export const USER_SESSION_TTL = 7 * 24 * 60 * 60 * 1000

export type HeaderSource = Request | { headers: Headers | Record<string, string | string[] | undefined> }

const getHeader = (source: HeaderSource, name: string): string | null => {
  if (source.headers instanceof Headers) return source.headers.get(name)
  const value = source.headers[name] ?? source.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

export const getCookieValue = (source: HeaderSource, name: string): string | null => {
  const cookieHeader = getHeader(source, 'cookie')
  if (!cookieHeader) return null
  const item = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))
  if (!item) return null
  try {
    return decodeURIComponent(item.slice(name.length + 1))
  } catch {
    return null
  }
}

export const safeStringEqual = (left: unknown, right: unknown): boolean => {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

const loginFailures = new Map<string, number[]>()
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const MAX_LOGIN_FAILURES = 10
const MAX_LOGIN_FAILURE_KEYS = 10_000

const pruneLoginFailures = (now = Date.now()): void => {
  for (const [ip, failures] of loginFailures) {
    const active = failures.filter(timestamp => now - timestamp < LOGIN_WINDOW_MS)
    if (active.length === 0) loginFailures.delete(ip)
    else loginFailures.set(ip, active)
  }
  while (loginFailures.size > MAX_LOGIN_FAILURE_KEYS) {
    const oldest = loginFailures.keys().next().value
    if (!oldest) break
    loginFailures.delete(oldest)
  }
}

export const isLoginRateLimited = (ip: string): boolean => {
  const now = Date.now()
  pruneLoginFailures(now)
  const failures = (loginFailures.get(ip) || []).filter(timestamp => now - timestamp < LOGIN_WINDOW_MS)
  loginFailures.set(ip, failures)
  return failures.length >= MAX_LOGIN_FAILURES
}

export const recordLoginFailure = (ip: string): void => {
  const now = Date.now()
  pruneLoginFailures(now)
  const failures = (loginFailures.get(ip) || []).filter(timestamp => now - timestamp < LOGIN_WINDOW_MS)
  failures.push(now)
  loginFailures.set(ip, failures)
  pruneLoginFailures(now)
}

export const clearLoginFailures = (ip: string): void => {
  loginFailures.delete(ip)
}

const playerSessions = new Map<string, { createdAt: number }>()
const adminSessions = new Map<string, number>()
const MAX_SESSIONS = 10_000
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000

const hashSession = (sessionId: string): string => new Bun.CryptoHasher('sha256').update(sessionId).digest('hex')

const prunePersistedSessions = (now = Date.now()): void => {
  try {
    const db = getDb()
    db.run('DELETE FROM player_sessions WHERE created_at <= ?', [now - PLAYER_SESSION_TTL])
    db.run('DELETE FROM user_sessions WHERE created_at <= ?', [now - USER_SESSION_TTL])
  } catch (error) {
    console.error('[Auth] 会话清理失败:', error instanceof Error ? error.message : 'unknown error')
  }
}

const prunePlayerSessions = (now = Date.now()): void => {
  for (const [sessionId, session] of playerSessions) {
    if (now - session.createdAt > PLAYER_SESSION_TTL) playerSessions.delete(sessionId)
  }
  prunePersistedSessions(now)
  while (playerSessions.size > MAX_SESSIONS) playerSessions.delete(playerSessions.keys().next().value!)
}

export const clearPlayerSessionCache = (): void => playerSessions.clear()

export const createPlayerSession = (): string => {
  prunePlayerSessions()
  const sessionId = crypto.randomBytes(32).toString('hex')
  const createdAt = Date.now()
  playerSessions.set(sessionId, { createdAt })
  getDb().run('INSERT OR REPLACE INTO player_sessions (session_hash, created_at) VALUES (?, ?)', [hashSession(sessionId), createdAt])
  return sessionId
}

export const removePlayerSession = (sessionId: string): void => {
  playerSessions.delete(sessionId)
  getDb().run('DELETE FROM player_sessions WHERE session_hash = ?', [hashSession(sessionId)])
}

export const checkPlayerAuthSession = (cookies: Record<string, string>): boolean => {
  if (!global.lx.config?.['player.enableAuth']) return true
  prunePlayerSessions()
  const sessionId = cookies[SESSION_COOKIE_NAME]
  if (!sessionId) return false
  const now = Date.now()
  const session = playerSessions.get(sessionId)
  if (session && now - session.createdAt <= PLAYER_SESSION_TTL) return true
  const persisted = getDb().query<{ created_at: number }, [string]>(
    'SELECT created_at FROM player_sessions WHERE session_hash = ?'
  ).get(hashSession(sessionId))
  if (!persisted || now - persisted.created_at > PLAYER_SESSION_TTL) {
    removePlayerSession(sessionId)
    return false
  }
  playerSessions.set(sessionId, { createdAt: persisted.created_at })
  return true
}

const pruneAdminSessions = (now = Date.now()): void => {
  for (const [sessionId, expiresAt] of adminSessions) {
    if (expiresAt <= now) adminSessions.delete(sessionId)
  }
  while (adminSessions.size > MAX_SESSIONS) adminSessions.delete(adminSessions.keys().next().value!)
}

export const createAdminSession = (): string => {
  pruneAdminSessions()
  const sessionId = crypto.randomBytes(32).toString('hex')
  adminSessions.set(sessionId, Date.now() + ADMIN_SESSION_TTL)
  return sessionId
}

export const removeAdminSession = (sessionId: string): void => {
  adminSessions.delete(sessionId)
}

export const checkAdminSession = (source: HeaderSource): boolean => {
  pruneAdminSessions()
  const sessionId = getCookieValue(source, ADMIN_SESSION_COOKIE_NAME)
  if (!sessionId) return false
  const expiresAt = adminSessions.get(sessionId)
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(sessionId)
    return false
  }
  return true
}

export const verifyAdminAuth = (source: HeaderSource): boolean => {
  const configuredPassword = global.lx.config?.['frontend.password']
  if (typeof configuredPassword !== 'string' || configuredPassword.trim() === '') return false
  return checkAdminSession(source)
}
