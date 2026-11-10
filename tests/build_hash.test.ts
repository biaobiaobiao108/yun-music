import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('build metadata recovers an empty config and preserves existing version fields', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-build-hash-'))
  const script = path.join(directory, 'scripts', 'update-build-hash.js')
  const config = path.join(directory, 'public', 'js', 'config.js')
  try {
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.mkdirSync(path.join(directory, 'src'))
    fs.copyFileSync(path.join(import.meta.dir, '../scripts/update-build-hash.js'), script)
    for (const content of [
      '',
      '   \n',
      "window.CONFIG = { version: 'custom-version', buildHash: 'old', extra: true };\n",
    ]) {
      fs.writeFileSync(config, content)
      const child = Bun.spawn(['bun', script], { cwd: directory, stdout: 'ignore', stderr: 'pipe' })
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
      const result = fs.readFileSync(config, 'utf8')
      expect(result).toContain('window.CONFIG')
      expect(result).toMatch(/buildHash:\s*'[a-f0-9]{7}'/)
      if (content.trim()) {
        expect(result).toContain("version: 'custom-version'")
        expect(result).toContain('extra: true')
      } else expect(result).toContain("version: 'v2.0.0'")
    }
  } finally {
    const relative = path.relative(os.tmpdir(), directory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup path')
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('build metadata is stable when generated assets are unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-build-hash-stability-'))
  const script = path.join(directory, 'scripts', 'update-build-hash.js')
  const config = path.join(directory, 'public', 'js', 'config.js')
  const source = path.join(directory, 'src', 'index.ts')
  const frontend = path.join(directory, 'frontend', 'app.ts')
  const run = async () => {
    const child = Bun.spawn(['bun', script], { cwd: directory, stdout: 'ignore', stderr: 'pipe' })
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
    return fs.readFileSync(config, 'utf8').match(/buildHash:\s*'([a-f0-9]{7})'/)?.[1]
  }

  try {
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.mkdirSync(path.dirname(frontend), { recursive: true })
    fs.copyFileSync(path.join(import.meta.dir, '../scripts/update-build-hash.js'), script)
    fs.writeFileSync(config, "window.CONFIG = { version: 'v2.0.0', buildHash: 'old' };\n")
    fs.writeFileSync(source, 'export const value = 1\n')
    fs.writeFileSync(frontend, 'export const view = 1\n')

    const first = await run()
    const second = await run()
    expect(first).toBeTruthy()
    expect(second).toBe(first)

    fs.writeFileSync(frontend, 'export const view = 2\n')
    expect(await run()).not.toBe(first)
  } finally {
    const relative = path.relative(os.tmpdir(), directory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup path')
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
