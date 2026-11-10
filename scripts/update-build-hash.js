const fs = require('fs')
const path = require('path')

async function getDirectoryHash(dir, exclude = [], extensions = []) {
  if (!fs.existsSync(dir)) return ''
  const files = [...new Bun.Glob('**/*').scanSync({ cwd: dir, absolute: true, dot: true })].filter(file => {
    const relPath = path.relative(dir, file).replace(/\\/g, '/')
    const fileName = path.basename(file)
    return (
      !exclude.some(ex => relPath.startsWith(ex) || fileName === ex) &&
      !/\.(?:db(?:[-.].*)?|sqlite(?:3)?|wal|shm|log)$/i.test(fileName) &&
      (extensions.length === 0 || extensions.some(ext => fileName.endsWith(ext)))
    )
  })

  // Sort files to ensure stable hash
  files.sort()

  const hash = new Bun.CryptoHasher('md5')
  for (const file of files) {
    const content = await Bun.file(file).bytes()
    const ext = path.extname(file).toLowerCase()
    const textExtensions = [
      '.js',
      '.ts',
      '.json',
      '.html',
      '.css',
      '.md',
      '.svg',
      '.txt',
      '.cjs',
      '.mjs',
      '.xml',
      '.yaml',
      '.yml',
    ]

    if (textExtensions.includes(ext)) {
      // 统一将 CRLF 转换为 LF 再计算 Hash，确保跨平台一致性
      const text = new TextDecoder().decode(content).replace(/\r\n/g, '\n')
      hash.update(text)
    } else {
      hash.update(content)
    }
  }

  return hash.digest('hex')
}

const targetDir = path.resolve(__dirname, '../')

// Hash inputs instead of the whole public directory. Generated bundles are
// retained for up to 30 days, so including them makes identical builds produce
// different hashes over time.
const publicHash = await getDirectoryHash(
  path.join(targetDir, 'public'),
  [
    'app.js',
    'app-',
    'index.html',
    'js/config.js',
    'js/page-runtime.js',
    'js/chunks',
    'music/app.js',
    'music/app-',
    'music/index.html',
    'music/login.html',
    'music/login-',
    'music/js/chunks',
    'tailwind.generated.css',
    'music/css/tailwind.generated.css',
    'music/bin',
  ],
  [],
)
const srcHash = await getDirectoryHash(path.join(targetDir, 'src'), [], [])
const frontendHash = await getDirectoryHash(path.join(targetDir, 'frontend'), [], [])
const scriptsHash = await getDirectoryHash(path.join(targetDir, 'scripts'), [], [])
const assetHash = await getDirectoryHash(path.join(targetDir, 'docs/assets'), ['screenshots'], [])
async function getFileHash(filePath) {
  if (!fs.existsSync(filePath)) return ''
  return new Bun.CryptoHasher('md5').update(await Bun.file(filePath).bytes()).digest('hex')
}
const dependencyHash = new Bun.CryptoHasher('md5')
  .update(await getFileHash(path.join(targetDir, 'package.json')))
  .update(await getFileHash(path.join(targetDir, 'bun.lock')))
  .digest('hex')

const finalHash = new Bun.CryptoHasher('md5')
  .update([publicHash, srcHash, frontendHash, scriptsHash, assetHash, dependencyHash].join(':'))
  .digest('hex')
  .substring(0, 7)

// Update config.js using Bun native I/O
const configPath = path.join(targetDir, 'public', 'js', 'config.js')
const configFile = Bun.file(configPath)
let configContent = `// 此文件中仅版本号为静态写死值
// 其余配置由服务端在运行时动态注入 (环境变量 > config.js > defaultConfig.ts)
// 服务端拦截 /js/config.js 请求, 读取此处版本号并合并服务端配置后返回
window.CONFIG = {
    buildHash: '${finalHash}',
    version: 'v2.0.0',
};
`

if (await configFile.exists()) {
  // Concurrent watch builds can leave an empty file after an interrupted
  // write. Regenerate the template instead of preserving that empty output.
  const existingContent = await configFile.text()
  if (existingContent.trim()) configContent = existingContent

  if (configContent.includes('buildHash:')) {
    configContent = configContent.replace(/buildHash:\s*['"][^'"]*['"]/, `buildHash: '${finalHash}'`)
  } else {
    configContent = configContent.replace(/(window\.CONFIG\s*=\s*\{)/, `$1\n    buildHash: '${finalHash}',`)
  }
}

await Bun.write(configPath, configContent)

console.log(`Build hash updated to ${finalHash} in config.js`)
