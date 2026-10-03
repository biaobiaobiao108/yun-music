import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'

test('external config reload preserves SQLite users and subsequent account writes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yun-config-reload-'))
  const configPath = path.join(directory, 'config.js')
  const password = crypto.randomUUID()
  fs.writeFileSync(configPath, `module.exports = ${JSON.stringify({ users: [{ name: 'original', password: crypto.randomUUID() }] })}`)
  const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = listener.port!
  listener.stop(true)
  const project = path.resolve(import.meta.dir, '..')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LX_USER_')))
  const child = Bun.spawn(['bun', path.join(project, 'src/index.ts')], {
    cwd: directory,
    env: { ...environment, DATA_PATH: directory, CONFIG_PATH: configPath, LOG_PATH: path.join(directory, 'logs'), STATIC_PATH: path.join(project, 'public'), FRONTEND_PASSWORD: password, PORT: String(port), BIND_IP: '127.0.0.1', DISABLE_TELEMETRY: 'true' },
    stdout: 'ignore', stderr: 'ignore',
  })
  try {
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break } } catch { }
      await Bun.sleep(50)
    }
    expect(ready).toBe(true)
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const users = async () => await (await fetch(`${base}/api/users`, { headers: { cookie } })).json() as Array<{ name: string }>
    expect((await users()).map(user => user.name)).toEqual(['original'])
    const saved = fs.readFileSync(configPath, 'utf8')
    expect(saved).toContain('"users": []')
    fs.writeFileSync(configPath, saved.replace('"serverName": "yun-yin"', '"serverName": "reloaded"'))
    await Bun.sleep(900)
    expect((await users()).map(user => user.name)).toEqual(['original'])
    const created = await fetch(`${base}/api/users`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'new_user', password: crypto.randomUUID() }) })
    expect(created.status).toBe(200)
    const db = new Database(path.join(directory, 'yun-yin.db'), { readonly: true })
    try { expect(db.query<{ name: string }, []>('SELECT name FROM users ORDER BY name').all().map(user => user.name)).toEqual(['new_user', 'original']) } finally { db.close() }
  } finally {
    child.kill('SIGTERM')
    await child.exited
    await Bun.sleep(200)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)
