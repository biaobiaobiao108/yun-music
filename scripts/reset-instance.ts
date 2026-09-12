import fs from 'node:fs'
import path from 'node:path'

const targets = ['data', 'cache', 'music', 'cover_cache']
const workspace = path.resolve(process.cwd())

if (!process.argv.includes('--confirm')) {
  console.error('此操作会删除当前实例目录：data/、cache/、music/、cover_cache/。如需继续，请执行：bun run reset:instance -- --confirm')
  process.exit(1)
}

for (const relativeTarget of targets) {
  const target = path.resolve(workspace, relativeTarget)
  const parent = path.dirname(target)
  if (parent !== workspace || path.basename(target) !== relativeTarget) {
    throw new Error(`拒绝清理未验证的实例路径：${target}`)
  }
  if (!fs.existsSync(target)) continue
  fs.rmSync(target, { recursive: true, force: true })
  console.log(`已清理 ${relativeTarget}/`)
}

console.log('实例目录清理完成；服务启动时不会自动删除这些目录。')
