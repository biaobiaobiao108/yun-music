import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getDb } from '@/database'

/**
 * `/api/music/download` is a relay: it fetches whatever URL it is given and
 * streams it back. Without a token the endpoint is an open proxy for anyone who
 * can reach the instance (the player itself may be anonymous when
 * `player.enableAuth` is false).
 *
 * The token is minted when `/api/music/url` resolves a playable URL and signs
 * exactly that URL, so the relay can only fetch URLs this server just produced.
 * The secret lives in SQLite so tokens survive a restart. The TTL only bounds
 * how long a leaked token stays usable for that one URL; it must be generous
 * because the browser keeps sending range requests while a long track plays.
 */
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000
const SECRET_KEY = 'download_token_secret'

let cachedSecret: Buffer | null = null
let cachedFor: unknown = null
/** Used when no database is available (unit tests, early startup). */
const ephemeralSecret = randomBytes(32)

const getSecret = (): Buffer => {
  if (cachedSecret && cachedFor === null) return cachedSecret
  let db: ReturnType<typeof getDb>
  try {
    db = getDb()
  } catch {
    // A missing/unavailable database must not turn playback into a 500.
    cachedSecret = ephemeralSecret
    cachedFor = null
    return cachedSecret
  }
  if (cachedSecret && cachedFor === db) return cachedSecret
  const row = db.query<{ value: string }, [string]>('SELECT value FROM system_info WHERE key = ?').get(SECRET_KEY)
  if (row?.value && /^[a-f0-9]{64}$/i.test(row.value)) {
    cachedSecret = Buffer.from(row.value, 'hex')
    cachedFor = db
    return cachedSecret
  }
  const secret = randomBytes(32)
  db.run('INSERT OR REPLACE INTO system_info (key, value) VALUES (?, ?)', [SECRET_KEY, secret.toString('hex')])
  cachedSecret = secret
  cachedFor = db
  return secret
}

const sign = (url: string, expires: number): string => createHmac('sha256', getSecret())
  .update(`${expires}\n${url}`)
  .digest('base64url')

export const issueDownloadToken = (url: string): string => {
  const expires = Date.now() + TOKEN_TTL_MS
  return `${expires}.${sign(url, expires)}`
}

export const verifyDownloadToken = (url: string, token: unknown): boolean => {
  if (typeof token !== 'string' || token.length > 256) return false
  const separator = token.indexOf('.')
  if (separator <= 0) return false
  const expires = Number(token.slice(0, separator))
  if (!Number.isSafeInteger(expires) || expires < Date.now()) return false
  const provided = Buffer.from(token.slice(separator + 1))
  const expected = Buffer.from(sign(url, expires))
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
