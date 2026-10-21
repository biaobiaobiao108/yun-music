import { expect, test } from 'bun:test'
import {
  hashPassword,
  isPasswordHash,
  PASSWORD_HASH_MAX_CONCURRENT,
  PASSWORD_HASH_MAX_QUEUED,
  PasswordHashCapacityError,
  verifyPasswordHash,
} from '@/utils/passwordHash'

test('password hashes asynchronously and verify without blocking the event loop', async () => {
  const hashPromise = hashPassword('async-password')
  const first = await Promise.race([
    hashPromise.then(() => 'hash'),
    new Promise<'timer'>(resolve => setTimeout(() => resolve('timer'), 0)),
  ])

  expect(first).toBe('timer')
  const passwordHash = await hashPromise
  expect(isPasswordHash(passwordHash)).toBe(true)
  expect(await verifyPasswordHash(passwordHash, 'async-password')).toBe(true)
  expect(await verifyPasswordHash(passwordHash, 'incorrect-password')).toBe(false)
})

test('scrypt work has a process-wide concurrency and queue bound', async () => {
  const jobCount = PASSWORD_HASH_MAX_CONCURRENT + PASSWORD_HASH_MAX_QUEUED + 1
  const results = await Promise.allSettled(
    Array.from({ length: jobCount }, (_, index) => hashPassword(`bounded-password-${index}`))
  )
  const rejected = results.filter(result => result.status === 'rejected')

  expect(rejected).toHaveLength(1)
  expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toBeInstanceOf(PasswordHashCapacityError)
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(jobCount - 1)
})
