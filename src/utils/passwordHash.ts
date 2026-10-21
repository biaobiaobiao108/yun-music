import crypto from 'node:crypto'

export const PASSWORD_HASH_PREFIX = 'scrypt$'
export const PASSWORD_HASH_PATTERN = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i

// Login traffic from different IPs shares this process-wide limit. Keeping a
// small FIFO queue absorbs ordinary bursts while putting a hard bound on work
// waiting for the native scrypt pool.
export const PASSWORD_HASH_MAX_CONCURRENT = 2
export const PASSWORD_HASH_MAX_QUEUED = 32

export class PasswordHashCapacityError extends Error {
  constructor() {
    super('密码计算服务繁忙')
    this.name = 'PasswordHashCapacityError'
  }
}

type ScryptJob = { start: () => void }
let activeScryptJobs = 0
const queuedScryptJobs: ScryptJob[] = []

const runScrypt = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  const start = () => {
    activeScryptJobs++
    const finish = () => {
      activeScryptJobs--
      queuedScryptJobs.shift()?.start()
    }

    try {
      crypto.scrypt(password, salt, 64, (error, key) => {
        if (error) reject(error)
        else resolve(Buffer.from(key))
        finish()
      })
    } catch (error) {
      reject(error)
      finish()
    }
  }

  if (activeScryptJobs < PASSWORD_HASH_MAX_CONCURRENT) {
    start()
    return
  }
  if (queuedScryptJobs.length >= PASSWORD_HASH_MAX_QUEUED) {
    reject(new PasswordHashCapacityError())
    return
  }
  queuedScryptJobs.push({ start })
})

/** 使用原生异步 scrypt 保存密码，避免密码计算阻塞服务事件循环。 */
export const hashPassword = async (password: string): Promise<string> => {
  if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
    throw new Error('密码长度必须在 1 到 1024 个字符之间')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const digest = (await runScrypt(password, salt)).toString('hex')
  return `${PASSWORD_HASH_PREFIX}${salt}$${digest}`
}

export const isPasswordHash = (value: unknown): value is string => (
  typeof value === 'string' && PASSWORD_HASH_PATTERN.test(value)
)

export const verifyPasswordHash = async (passwordHash: string | undefined, password: unknown): Promise<boolean> => {
  if (!isPasswordHash(passwordHash) || typeof password !== 'string' || password.length > 1024) return false
  const [, salt, expectedHex] = passwordHash.split('$')
  try {
    const actual = await runScrypt(password, salt)
    const expected = Buffer.from(expectedHex, 'hex')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch (error) {
    if (error instanceof PasswordHashCapacityError) throw error
    return false
  }
}
