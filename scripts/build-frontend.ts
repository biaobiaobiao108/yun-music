import path from 'path'
import fs from 'fs'

const isWatch = process.argv.includes('--watch')
const publicRoot = path.join(import.meta.dir, '../public')
const publicMusicRoot = path.join(publicRoot, 'music')

function copyHtml(source: string, target: string, entryName?: string): void {
  let content = fs.readFileSync(source, 'utf8')
  if (entryName) content = content.replaceAll('app.js', entryName)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

async function build() {
  const startTime = performance.now()
  const adminEntry = path.join(import.meta.dir, '../frontend/admin/src/index.ts')
  const playerEntry = path.join(import.meta.dir, '../frontend/player/src/index.ts')
  const adminHtmlSource = path.join(import.meta.dir, '../frontend/admin/index.html')
  const playerHtmlSource = path.join(import.meta.dir, '../frontend/player/index.html')
  const playerLoginSource = path.join(import.meta.dir, '../frontend/player/login.html')
  const playerVendorEntry = path.join(import.meta.dir, '../frontend/player/src/vendor_bridge.ts')
  const playerWorkletEntry = path.join(import.meta.dir, '../frontend/player/src/legacy/pitch_shifter/phase_vocoder.ts')
  const shouldMinify = process.env.NODE_ENV === 'production' || !isWatch

  const stylesProcess = Bun.spawn(['bun', 'run', 'scripts/build-styles.ts'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const stylesExitCode = await stylesProcess.exited
  if (stylesExitCode !== 0) {
    console.error('[Tailwind] Style build failed')
    if (!isWatch) process.exit(1)
    return
  }

  const vendorResult = await Bun.build({
    entrypoints: [playerVendorEntry],
    outdir: path.join(publicMusicRoot, 'js'),
    naming: 'vendor-bridge.js',
    format: 'iife',
    minify: shouldMinify,
    target: 'browser',
    sourcemap: isWatch ? 'inline' : 'none',
  })
  if (!vendorResult.success) {
    console.error('[Bun Bundler] Player vendor build failed:', vendorResult.logs)
    if (!isWatch) process.exit(1)
    return
  }

  const workletResult = await Bun.build({
    entrypoints: [playerWorkletEntry],
    outdir: path.join(publicMusicRoot, 'js/pitch-shifter'),
    naming: 'phase-vocoder.js',
    format: 'esm',
    minify: shouldMinify,
    target: 'browser',
    sourcemap: isWatch ? 'inline' : 'none',
  })
  if (!workletResult.success) {
    console.error('[Bun Bundler] Player audio worklet build failed:', workletResult.logs)
    if (!isWatch) process.exit(1)
    return
  }

  // Remove only previous generated entry bundles; source HTML and data are never touched here.
  for (const [directory, pattern] of [[publicRoot, /^app(?:-[a-z0-9]+)?\.js$/i], [publicMusicRoot, /^app(?:-[a-z0-9]+)?\.js$/i]] as const) {
    for (const filename of fs.readdirSync(directory)) {
      if (pattern.test(filename)) fs.rmSync(path.join(directory, filename), { force: true })
    }
  }

  // 1. Build Admin Panel
  const adminResult = await Bun.build({
    entrypoints: [adminEntry],
    outdir: publicRoot,
    naming: 'app-[hash].[ext]',
    minify: shouldMinify,
    target: 'browser',
    sourcemap: isWatch ? 'inline' : 'none',
  })
  if (!adminResult.success) {
    console.error('[Bun Bundler] Admin build failed:', adminResult.logs)
    if (!isWatch) process.exit(1)
    return
  }

  const adminOutput = adminResult.outputs.find(output => output.path.endsWith('.js'))
  if (!adminOutput) throw new Error('Admin entry output was not generated')

  // 2. Build Music Player
  const playerOutdir = publicMusicRoot
  const playerChunkDir = path.join(playerOutdir, 'js/chunks')
  for (const filename of ['songlist_manager.js', 'download_manager.js']) {
    const staleBundle = path.join(playerOutdir, 'js', filename)
    if (fs.existsSync(staleBundle)) fs.rmSync(staleBundle, { force: true })
  }
  if (fs.existsSync(playerChunkDir)) fs.rmSync(playerChunkDir, { recursive: true, force: true })
  for (const filename of fs.readdirSync(playerOutdir)) {
    if (filename.startsWith('chunk-') && filename.endsWith('.js')) {
      fs.rmSync(path.join(playerOutdir, filename), { force: true })
    }
  }

  const playerResult = await Bun.build({
    entrypoints: [playerEntry],
    outdir: playerOutdir,
    naming: {
      entry: 'app-[hash].[ext]',
      chunk: 'js/chunks/[name]-[hash].[ext]',
    },
    format: 'esm',
    splitting: true,
    minify: shouldMinify,
    target: 'browser',
    sourcemap: isWatch ? 'inline' : 'none',
  })
  if (!playerResult.success) {
    console.error('[Bun Bundler] Player build failed:', playerResult.logs)
    if (!isWatch) process.exit(1)
    return
  }

  const playerOutput = playerResult.outputs.find(output => output.path.endsWith('.js') && !output.path.includes(`${path.sep}chunks${path.sep}`))
  if (!playerOutput) throw new Error('Player entry output was not generated')

  const adminFileName = path.basename(adminOutput.path)
  const playerFileName = path.basename(playerOutput.path)
  copyHtml(adminHtmlSource, path.join(publicRoot, 'index.html'), adminFileName)
  copyHtml(playerHtmlSource, path.join(publicMusicRoot, 'index.html'), playerFileName)
  copyHtml(playerLoginSource, path.join(publicMusicRoot, 'login.html'))

  const duration = (performance.now() - startTime).toFixed(1)
  const adminSize = (fs.statSync(adminOutput.path).size / 1024).toFixed(1)
  const playerSize = (fs.statSync(playerOutput.path).size / 1024).toFixed(1)
  console.log(`[Bun Bundler] Frontend build completed in ${duration}ms (admin: ${adminFileName} ${adminSize}KB, player: ${playerFileName} ${playerSize}KB, minified: ${shouldMinify})`)
}

async function main() {
  console.log(`[Bun Bundler] Building frontend assets... ${isWatch ? '(watch mode)' : ''}`)
  await build()

  if (isWatch) {
    const adminSrc = path.join(import.meta.dir, '../frontend/admin/src')
    const playerSrc = path.join(import.meta.dir, '../frontend/player/src')
    let debounceTimer: Timer | null = null

    const onChange = (filename: string | null) => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(async () => {
        console.log(`[Bun Bundler] File changed: ${filename || 'unknown'}, rebuilding...`)
        await build()
      }, 100)
    }

    if (fs.existsSync(adminSrc)) fs.watch(adminSrc, { recursive: true }, (_, f) => onChange(f))
    if (fs.existsSync(playerSrc)) fs.watch(playerSrc, { recursive: true }, (_, f) => onChange(f))
    console.log('[Bun Bundler] Watching for changes in frontend/ ...')
  }
}

main().catch(err => {
  console.error('[Bun Bundler] Error:', err)
  process.exit(1)
})
