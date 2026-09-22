import crypto from 'node:crypto'

export const PASSWORD_HASH_PREFIX = 'scrypt$'
export const PASSWORD_HASH_PATTERN = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i

/** 使用 Node/Bun 原生 scrypt 保存密码，避免凭据以明文持久化。 */
export const hashPassword = (password: string): string => {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    throw new Error('密码长度必须在 1 到 1024 个字符之间')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const digest = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${PASSWORD_HASH_PREFIX}${salt}$${digest}`
}

export const isPasswordHash = (value: unknown): value is string => (
  typeof value === 'string' && PASSWORD_HASH_PATTERN.test(value)
)

export const verifyPasswordHash = (passwordHash: string | undefined, password: unknown): boolean => {
  if (!isPasswordHash(passwordHash) || typeof password !== 'string' || password.length > 1024) return false
  const [, salt, expectedHex] = passwordHash.split('$')
  try {
    const actual = crypto.scryptSync(password, salt, 64)
    const expected = Buffer.from(expectedHex, 'hex')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
