import path from 'node:path'

const FORMAT_TARGETS = [
  'src/**/*.ts',
  'frontend/**/*.ts',
  'frontend/**/*.tsx',
  'frontend/**/*.css',
  'frontend/**/*.html',
  'frontend/**/*.js',
  'frontend/**/*.json',
  'scripts/**/*.ts',
  'scripts/**/*.js',
  'tests/**/*.ts',
  'index.js',
  'ecosystem.config.js',
  'tailwind.admin.config.cjs',
  'tailwind.player.config.cjs',
  'package.json',
  'tsconfig.json',
  'bunfig.toml',
]

const extraArgs = process.argv.slice(2)
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toLowerCase().startsWith('npm_') && !key.toLowerCase().startsWith('bun_'),
  ),
)
// `bun run` prepends node_modules/.bin to PATH, which can shadow the system Bun (with `bun fmt`) with an older bundled `bun` package.
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
const cleanPath = (env[pathKey] || '')
  .split(path.delimiter)
  .filter(entry => entry && !entry.split(path.sep).includes('node_modules'))
  .join(path.delimiter)
if (cleanPath) env[pathKey] = cleanPath
const bunBin = (cleanPath ? Bun.which('bun', { PATH: cleanPath }) : null) || process.execPath

const result = Bun.spawnSync([bunBin, 'fmt', '--no-script', ...extraArgs, ...FORMAT_TARGETS], {
  cwd: process.cwd(),
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(result.exitCode ?? 1)
