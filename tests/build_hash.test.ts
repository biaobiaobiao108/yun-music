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
    for (const content of ['', '   \n', "window.CONFIG = { version: 'custom-version', buildHash: 'old', extra: true };\n"]) {
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
