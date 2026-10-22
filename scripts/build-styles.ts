import path from 'node:path'
import fs from 'node:fs'

const root = path.join(import.meta.dir, '..')

async function buildStyle(input: string, output: string) {
  const inputPath = path.join(root, input)
  const outputPath = path.join(root, output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

  const childProcess = Bun.spawn(
    [process.execPath, 'x', '@tailwindcss/cli', '--input', inputPath, '--output', outputPath, '--minify'],
    {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  )

  const exitCode = await childProcess.exited
  if (exitCode !== 0) {
    throw new Error(`Tailwind build failed for ${input} (exit code ${exitCode})`)
  }
}

function copyStyle(input: string, output: string) {
  const source = path.join(root, input)
  const target = path.join(root, output)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

await Promise.all([
  buildStyle('frontend/styles/admin.css', 'public/tailwind.generated.css'),
  buildStyle('frontend/styles/player.css', 'public/music/css/tailwind.generated.css'),
  Promise.resolve(copyStyle('frontend/styles/player-theme.css', 'public/music/css/theme_variables.css')),
])
