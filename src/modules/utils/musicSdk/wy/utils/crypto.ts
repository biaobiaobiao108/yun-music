import { createCipheriv, createDecipheriv, publicEncrypt, randomBytes, createHash, constants } from 'node:crypto'

const iv = Buffer.from('0102030405060708')
const presetKey = Buffer.from('0CoJUm6Qyw8W8jud')
const linuxapiKey = Buffer.from('rFgB&h#%2?^eDg:Q')
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const publicKey =
  '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----'
const eapiKey = 'e82ckenh8dichen8'

const aesEncrypt = (buffer: Buffer, mode: string, key: Buffer, initializationVector: Buffer | null): Buffer => {
  const cipher = createCipheriv(mode as any, key, initializationVector)
  return Buffer.concat([cipher.update(buffer), cipher.final()])
}

const aesDecrypt = (cipherBuffer: Buffer, mode: string, key: Buffer, initializationVector: Buffer | null): Buffer => {
  const decipher = createDecipheriv(mode as any, key, initializationVector)
  return Buffer.concat([decipher.update(cipherBuffer), decipher.final()])
}

const rsaEncrypt = (buffer: Buffer, key: string): Buffer => {
  const padded = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])
  return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded)
}

export const weapi = (object: unknown): { params: string; encSecKey: string } => {
  const text = JSON.stringify(object) ?? ''
  const secretKey = Buffer.from(randomBytes(16).map((value: any) => base62.charAt(value % 62).charCodeAt(0)))
  const firstParams = aesEncrypt(Buffer.from(text), 'aes-128-cbc', presetKey, iv).toString('base64')
  return {
    params: aesEncrypt(Buffer.from(firstParams), 'aes-128-cbc', secretKey, iv).toString('base64'),
    encSecKey: rsaEncrypt(Buffer.from(secretKey).reverse(), publicKey).toString('hex'),
  }
}

export const linuxapi = (object: unknown): { eparams: string } => {
  const text = JSON.stringify(object) ?? ''
  return {
    eparams: aesEncrypt(Buffer.from(text), 'aes-128-ecb', linuxapiKey, null).toString('hex').toUpperCase(),
  }
}

export const eapi = (url: string, object: unknown): { params: string } => {
  const text = typeof object === 'string' ? object : (JSON.stringify(object) ?? '')
  const message = `nobody${url}use${text}md5forencrypt`
  const digest = createHash('md5').update(message).digest('hex')
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
  return {
    params: aesEncrypt(Buffer.from(data), 'aes-128-ecb', Buffer.from(eapiKey), null).toString('hex').toUpperCase(),
  }
}

export const eapiDecrypt = (cipherBuffer: Buffer): string =>
  aesDecrypt(cipherBuffer, 'aes-128-ecb', Buffer.from(eapiKey), null).toString()
