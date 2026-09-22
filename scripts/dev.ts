type DevService = {
  name: string
  command: string[]
}

const services: DevService[] = [
  { name: 'server', command: ['bun', 'run', 'dev:server'] },
  { name: 'frontend', command: ['bun', 'run', 'dev:frontend'] },
]

const children = services.map(service => ({
  ...service,
  process: Bun.spawn(service.command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }),
}))

let shuttingDown = false

const stopChildren = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try { child.process.kill('SIGINT') } catch {
      try { child.process.kill('SIGTERM') } catch { }
    }
  }
  // Bun's watch process can outlive the parent on Windows when it is attached
  // to the same console. Keep Ctrl+C graceful first, then prevent orphaned
  // watchers if a child ignores the signal.
  setTimeout(() => {
    for (const child of children) {
      try { child.process.kill('SIGKILL') } catch { }
    }
  }, 1500)
}

process.on('SIGINT', stopChildren)
process.on('SIGTERM', stopChildren)

const firstExit = await Promise.race(children.map(async child => ({
  name: child.name,
  code: await child.process.exited,
})))

if (!shuttingDown) {
  console.error(`[dev] ${firstExit.name} process exited with code ${firstExit.code}; stopping the other development process.`)
  stopChildren()
}

await Promise.all(children.map(child => child.process.exited))
process.exitCode = firstExit.code === 0 ? 0 : firstExit.code || 1
