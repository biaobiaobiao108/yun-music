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

function cleanupStaleEntryBundles(directory: string, pattern: RegExp, keepName: string): void {
  if (!fs.existsSync(directory)) return
  for (const filename of fs.readdirSync(directory)) {
    if (pattern.test(filename) && filename !== keepName) {
      fs.rmSync(path.join(directory, filename), { force: true })
    }
  }
}

function cleanupStaleChunks(directory: string, keepPaths: Set<string>): void {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      cleanupStaleChunks(entryPath, keepPaths)
      if (fs.readdirSync(entryPath).length === 0) fs.rmSync(entryPath, { recursive: true, force: true })
      continue
    }
    if (/\.(?:js|map)$/i.test(entry.name) && !keepPaths.has(path.resolve(entryPath))) {
      fs.rmSync(entryPath, { force: true })
    }
  }
}

async function build() {
  const startTime = performance.now()
  const adminEntry = path.join(import.meta.dir, '../frontend/admin/src/react/index.tsx')
  const playerEntry = path.join(import.meta.dir, '../frontend/player/src/react/index.tsx')
  const playerLoginEntry = path.join(import.meta.dir, '../frontend/player/src/react/login.tsx')
  const adminHtmlSource = path.join(import.meta.dir, '../frontend/admin/index.html')
  const playerHtmlSource = path.join(import.meta.dir, '../frontend/player/index.html')
  const playerLoginSource = path.join(import.meta.dir, '../frontend/player/login.html')
  const pageRuntimeSource = path.join(import.meta.dir, '../frontend/shared/src/page-runtime.js')
  const pageRuntimeTarget = path.join(publicRoot, 'js/page-runtime.js')
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

  const iconSubsetProcess = Bun.spawn(['bun', 'run', path.join(import.meta.dir, 'build-fontawesome-subset.ts')], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const iconSubsetExitCode = await iconSubsetProcess.exited
  if (iconSubsetExitCode !== 0) {
    console.error('[Font Awesome] Icon subset build failed')
    if (!isWatch) process.exit(1)
    return
  }
  fs.mkdirSync(path.dirname(pageRuntimeTarget), { recursive: true })
  fs.copyFileSync(pageRuntimeSource, pageRuntimeTarget)

  // These files belonged to the retired command-driven player. Remove stale
  // local build output so a previous build cannot keep shipping dead runtime
  // resources after the React-only migration.
  for (const stalePath of [
    path.join(publicMusicRoot, 'js/vendor-bridge.js'),
    path.join(publicMusicRoot, 'js/wave.js'),
    path.join(publicMusicRoot, 'js/pitch-shifter'),
  ]) {
    if (fs.existsSync(stalePath)) fs.rmSync(stalePath, { recursive: true, force: true })
  }

  // 1. Build Admin Panel
  const adminChunkDir = path.join(publicRoot, 'js/chunks')
  const adminResult = await Bun.build({
    entrypoints: [adminEntry],
    outdir: publicRoot,
    format: 'esm',
    splitting: true,
    naming: {
      entry: 'app-[hash].[ext]',
      chunk: 'js/chunks/[name]-[hash].[ext]',
    },
    minify: shouldMinify,
    target: 'browser',
    define: {
      'process.env.NODE_ENV': JSON.stringify(shouldMinify ? 'production' : 'development'),
    },
    sourcemap: isWatch ? 'inline' : 'none',
  })
  if (!adminResult.success) {
    console.error('[Bun Bundler] Admin build failed:', adminResult.logs)
    if (!isWatch) process.exit(1)
    return
  }

  const adminOutput = adminResult.outputs.find(output => output.path.endsWith('.js') && !output.path.includes(`${path.sep}chunks${path.sep}`))
  if (!adminOutput) throw new Error('Admin entry output was not generated')

  // 2. Build Music Player
  const playerOutdir = publicMusicRoot
  const playerChunkDir = path.join(playerOutdir, 'js/chunks')
  for (const filename of ['songlist_manager.js', 'download_manager.js']) {
    const staleBundle = path.join(playerOutdir, 'js', filename)
    if (fs.existsSync(staleBundle)) fs.rmSync(staleBundle, { force: true })
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
    define: {
      'process.env.NODE_ENV': JSON.stringify(shouldMinify ? 'production' : 'development'),
    },
    sourcemap: isWatch ? 'inline' : 'none',
  })
  if (!playerResult.success) {
    console.error('[Bun Bundler] Player build failed:', playerResult.logs)
    if (!isWatch) process.exit(1)
    return
  }

  const playerOutput = playerResult.outputs.find(output => output.path.endsWith('.js') && !output.path.includes(`${path.sep}chunks${path.sep}`))
  if (!playerOutput) throw new Error('Player entry output was not generated')

  // 3. Build the dedicated React authentication entry. It intentionally has
  // its own hash so login can be cached independently from the main player.
  const loginResult = await Bun.build({
    entrypoints: [playerLoginEntry],
    outdir: publicMusicRoot,
    naming: 'login-[hash].[ext]',
    format: 'esm',
    minify: shouldMinify,
    target: 'browser',
    define: {
      'process.env.NODE_ENV': JSON.stringify(shouldMinify ? 'production' : 'development'),
    },
    sourcemap: isWatch ? 'inline' : 'none',
  })
  if (!loginResult.success) {
    console.error('[Bun Bundler] Player login build failed:', loginResult.logs)
    if (!isWatch) process.exit(1)
    return
  }
  const loginOutput = loginResult.outputs.find(output => output.path.endsWith('.js'))
  if (!loginOutput) throw new Error('Player login output was not generated')

  const adminFileName = path.basename(adminOutput.path)
  const playerFileName = path.basename(playerOutput.path)
  const loginFileName = path.basename(loginOutput.path)
  copyHtml(adminHtmlSource, path.join(publicRoot, 'index.html'), adminFileName)
  copyHtml(playerHtmlSource, path.join(publicMusicRoot, 'index.html'), playerFileName)
  copyHtml(playerLoginSource, path.join(publicMusicRoot, 'login.html'), loginFileName)

  // Keep old assets available until every new bundle and HTML reference has
  // been written. Only then remove stale outputs, so a watch rebuild cannot
  // briefly make the active player or lyric page reference a missing file.
  cleanupStaleEntryBundles(publicRoot, /^app(?:-[a-z0-9]+)?\.js$/i, adminFileName)
  cleanupStaleEntryBundles(publicMusicRoot, /^app(?:-[a-z0-9]+)?\.js$/i, playerFileName)
  cleanupStaleEntryBundles(publicMusicRoot, /^login(?:-[a-z0-9]+)?\.js$/i, loginFileName)
  cleanupStaleChunks(adminChunkDir, new Set(adminResult.outputs.map(output => path.resolve(output.path))))
  cleanupStaleChunks(playerChunkDir, new Set(playerResult.outputs.map(output => path.resolve(output.path))))

  const duration = (performance.now() - startTime).toFixed(1)
  const adminSize = (fs.statSync(adminOutput.path).size / 1024).toFixed(1)
  const playerSize = (fs.statSync(playerOutput.path).size / 1024).toFixed(1)
  const loginSize = (fs.statSync(loginOutput.path).size / 1024).toFixed(1)
  console.log(`[Bun Bundler] Frontend build completed in ${duration}ms (admin: ${adminFileName} ${adminSize}KB, player: ${playerFileName} ${playerSize}KB, login: ${loginFileName} ${loginSize}KB, minified: ${shouldMinify})`)

  const updateHashProcess = Bun.spawn(['bun', 'run', path.join(import.meta.dir, 'update-build-hash.js')], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await updateHashProcess.exited
}

async function main() {
  console.log(`[Bun Bundler] Building frontend assets... ${isWatch ? '(watch mode)' : ''}`)
  const skipInitialBuild = isWatch && process.env.FRONTEND_SKIP_INITIAL_BUILD === '1'
  if (skipInitialBuild) console.log('[Bun Bundler] Initial build already completed by the dev coordinator.')
  else await build()

  if (isWatch) {
    const watchRoots = [
      path.join(import.meta.dir, '../frontend/admin/src'),
      path.join(import.meta.dir, '../frontend/player/src'),
      path.join(import.meta.dir, '../frontend/shared'),
      path.join(import.meta.dir, '../frontend/styles'),
    ]
    let debounceTimer: Timer | null = null
    let buildInProgress = false
    let rebuildQueued = false

    const scheduleBuild = (filename: string | null) => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (buildInProgress) {
          rebuildQueued = true
          return
        }
        buildInProgress = true
        console.log(`[Bun Bundler] File changed: ${filename || 'unknown'}, rebuilding...`)
        void build().catch(error => console.error('[Bun Bundler] Watch build failed:', error)).finally(() => {
          buildInProgress = false
          if (rebuildQueued) {
            rebuildQueued = false
            scheduleBuild('queued changes')
          }
        })
      }, 100)
    }

    const onChange = (filename: string | null) => {
      scheduleBuild(filename)
    }

    for (const watchRoot of watchRoots) {
      if (fs.existsSync(watchRoot)) fs.watch(watchRoot, { recursive: true }, (_, f) => onChange(f))
    }
    console.log('[Bun Bundler] Watching for changes in frontend/ ...')
  }
}

main().catch(err => {
  console.error('[Bun Bundler] Error:', err)
  process.exit(1)
})
