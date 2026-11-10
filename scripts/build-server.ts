import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const outputDirectory = path.join(root, 'server')
const outputPath = path.join(outputDirectory, 'index.js')

const build = Bun.spawn(
  [
    'bun',
    'build',
    path.join(root, 'src/index.ts'),
    '--outdir',
    outputDirectory,
    '--target',
    'bun',
    '--packages=external',
    '--production',
  ],
  {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

const exitCode = await build.exited
if (exitCode !== 0) process.exit(exitCode)

const bundle = fs.readFileSync(outputPath, 'utf8')
if (!bundle.includes('in ${"production"}') || bundle.includes('in ${"development"}')) {
  throw new Error('Server bundle was not compiled with NODE_ENV=production')
}

console.log(`Verified production server bundle: ${path.relative(root, outputPath)}`)
