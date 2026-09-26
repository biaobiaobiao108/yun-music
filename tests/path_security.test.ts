import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveInside } from '../src/utils/pathSecurity'

describe('Filesystem path boundary checks', () => {
  test('rejects a deep missing path beneath a symlink that escapes the root', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-yin-path-security-'))
    const root = path.join(tempRoot, 'root')
    const outside = path.join(tempRoot, 'outside')
    const link = path.join(root, 'link')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)

    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')

      expect(() => resolveInside(root, 'link', 'missing', 'child'))
        .toThrow('Path escapes allowed directory')
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test('allows a nested missing path whose existing ancestor stays inside the root', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-yin-path-security-'))
    const root = path.join(tempRoot, 'root')
    fs.mkdirSync(root)

    try {
      expect(resolveInside(root, 'nested', 'missing', 'child'))
        .toBe(path.join(root, 'nested', 'missing', 'child'))
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
