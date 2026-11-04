import { afterEach, describe, expect, test } from 'bun:test'
import { clearLoginFailures, reserveLoginAttempt } from '@/server/auth'
import { closeDb, initDatabase } from '@/database'

describe('login attempt budget', () => {
  afterEach(() => closeDb())

  test('reserves an attempt atomically and clears on success', () => {
    closeDb()
    initDatabase(':memory:')
    const ip = '198.51.100.10'
    for (let attempt = 0; attempt < 10; attempt++) expect(reserveLoginAttempt(ip)).toBe(true)
    expect(reserveLoginAttempt(ip)).toBe(false)
    expect(reserveLoginAttempt('198.51.100.11')).toBe(true)

    clearLoginFailures(ip)
    expect(reserveLoginAttempt(ip)).toBe(true)
  })

  test('keeps authentication domains in separate budgets', () => {
    closeDb()
    initDatabase(':memory:')
    const ip = '198.51.100.20'
    for (let attempt = 0; attempt < 10; attempt++) expect(reserveLoginAttempt(ip, 'user')).toBe(true)
    expect(reserveLoginAttempt(ip, 'user')).toBe(false)
    expect(reserveLoginAttempt(ip, 'player')).toBe(true)
    expect(reserveLoginAttempt(ip)).toBe(true)
  })
})
