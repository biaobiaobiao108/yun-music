type DevService = {
  name: string
  command: string[]
}

const services: DevService[] = [
  { name: 'server', command: ['bun', '--watch', 'src/index.ts'] },
  { name: 'frontend', command: ['bun', 'scripts/build-frontend.ts', '--watch'] },
]

const runInitialFrontendBuild = async (): Promise<void> => {
  console.log('[dev] Building frontend before starting the server...')
  const buildProcess = Bun.spawn(['bun', 'scripts/build-frontend.ts'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await buildProcess.exited
  if (exitCode !== 0) throw new Error(`frontend build failed with code ${exitCode}`)
}

await runInitialFrontendBuild().catch(error => {
  console.error('[dev] Unable to prepare frontend assets:', error instanceof Error ? error.message : error)
  process.exit(1)
})

const children = services.map(service => ({
  ...service,
  process: Bun.spawn(service.command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: service.name === 'frontend'
      ? { ...process.env, FRONTEND_SKIP_INITIAL_BUILD: '1' }
      : undefined,
  }),
}))

let shuttingDown = false
let shutdownRequestedByUser = false
let forceKillTimer: Timer | null = null

const stopChildren = (requestedByUser = false): void => {
  if (requestedByUser) {
    shutdownRequestedByUser = true
    process.exitCode = 0
  }
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
  forceKillTimer = setTimeout(() => {
    for (const child of children) {
      try { child.process.kill('SIGKILL') } catch { }
    }
    forceKillTimer = null
  }, 1500)
}

process.on('SIGINT', () => stopChildren(true))
process.on('SIGTERM', () => stopChildren(true))

const firstExit = await Promise.race(children.map(async child => ({
  name: child.name,
  code: await child.process.exited,
})))

if (!shuttingDown) {
  console.error(`[dev] ${firstExit.name} process exited with code ${firstExit.code}; stopping the other development process.`)
  stopChildren()
}

await Promise.all(children.map(child => child.process.exited))
if (forceKillTimer) clearTimeout(forceKillTimer)
// Depending on the platform, Ctrl+C may be delivered to a child before this
// coordinator receives the signal. Treat the conventional SIGINT and Windows
// console-control exit codes as an intentional developer shutdown as well.
const interruptExit = firstExit.code === 130 || firstExit.code === 3221225786 || firstExit.code === -2
if (shutdownRequestedByUser || interruptExit) {
  process.exit(0)
}
process.exitCode = firstExit.code === 0 ? 0 : firstExit.code || 1
