import { expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { getFingerprint } from '@/server/utils/identify'

test('fingerprint extraction stays asynchronous and bounds child execution', async () => {
  const which = spyOn(Bun, 'which').mockReturnValue('fpcalc')
  let finish!: () => void
  const execute = spyOn(childProcess, 'execFile').mockImplementation(((file: any, args: any, options: any, callback: any): any => {
    expect(file).toBe('fpcalc')
    expect(args).toEqual(['-json', 'song with spaces.flac'])
    expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true })
    finish = () => callback(null, JSON.stringify({ fingerprint: 'fixture', duration: 180 }), '')
    return {}
  }) as typeof childProcess.execFile)
  try {
    let completed = false
    const operation = getFingerprint('song with spaces.flac').then(result => { completed = true; return result })
    await Promise.resolve()
    expect(completed).toBe(false)
    finish()
    expect(await operation).toEqual({ fingerprint: 'fixture', duration: 180 })
  } finally {
    execute.mockRestore()
    which.mockRestore()
  }
})

test('fingerprint extraction rejects timed out children and malformed results', async () => {
  const which = spyOn(Bun, 'which').mockReturnValue('fpcalc')
  let timeout = true
  const execute = spyOn(childProcess, 'execFile').mockImplementation(((_file: any, _args: any, _options: any, callback: any): any => {
    if (timeout) callback(Object.assign(new Error('killed'), { killed: true }), '', '')
    else callback(null, JSON.stringify({ fingerprint: '', duration: -1 }), '')
    return {}
  }) as typeof childProcess.execFile)
  try {
    await expect(getFingerprint('song.flac')).rejects.toThrow('音频指纹提取超时')
    timeout = false
    await expect(getFingerprint('song.flac')).rejects.toThrow('无效的音频指纹结果')
  } finally {
    execute.mockRestore()
    which.mockRestore()
  }
})
