import { describe, test, expect } from 'bun:test'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { parseConfigFile } from '../src/utils/configLoader'

describe('parseConfigFile (Safe Config Loader without require)', () => {
  const tmpDir = path.join(os.tmpdir(), `config-test-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  test('parses module.exports with JSON-compatible object', () => {
    const file = path.join(tmpDir, 'test1.js')
    fs.writeFileSync(file, 'module.exports = {\n  "serverName": "custom-name",\n  "port": 9527\n}\n')
    const parsed = parseConfigFile(file)
    expect(parsed.serverName).toBe('custom-name')
    expect(parsed.port).toBe(9527)
  })

  test('parses module.exports with JavaScript comments and expressions', () => {
    const file = path.join(tmpDir, 'test2.js')
    fs.writeFileSync(file, '// Some comment\nmodule.exports = {\n  port: 8000 + 100,\n  name: "evaled"\n};\n')
    const parsed = parseConfigFile(file)
    expect(parsed.port).toBe(8100)
    expect(parsed.name).toBe('evaled')
  })

  test('parses .json file', () => {
    const file = path.join(tmpDir, 'test3.json')
    fs.writeFileSync(file, JSON.stringify({ serverName: 'json-name', maxSnapshotNum: 5 }))
    const parsed = parseConfigFile(file)
    expect(parsed.serverName).toBe('json-name')
    expect(parsed.maxSnapshotNum).toBe(5)
  })

  test('parses module.exports with default export', () => {
    const file = path.join(tmpDir, 'test4.js')
    fs.writeFileSync(file, 'module.exports = { default: { serverName: "default-name" } };')
    const parsed = parseConfigFile(file)
    expect(parsed.serverName).toBe('default-name')
  })

  test('throws on invalid syntax', () => {
    const file = path.join(tmpDir, 'test5.js')
    fs.writeFileSync(file, 'module.exports = { broken... }')
    expect(() => parseConfigFile(file)).toThrow()
  })
})
