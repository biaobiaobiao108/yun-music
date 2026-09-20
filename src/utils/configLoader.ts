import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 纯净解析配置文件（.js 或 .json），避免通过 require() 加载导致 bun --watch 追踪该文件。
 * 当用户在后台保存配置时，写盘不会误触发 bun --watch 导致服务意外重启或中断正在传输的响应。
 */
export const parseConfigFile = (filePath: string): any => {
  const content = fs.readFileSync(filePath, 'utf8')
  if (path.extname(filePath) === '.json') {
    return JSON.parse(content)
  }
  const trimmed = content.trim()
  if (trimmed.startsWith('module.exports =') || trimmed.startsWith('module.exports=')) {
    const raw = trimmed.replace(/^module\.exports\s*=\s*/, '').replace(/;\s*$/, '').trim()
    try {
      return JSON.parse(raw)
    } catch {
      // JSON 解析失败则回退至 VM 执行
    }
  }
  const sandbox = {
    module: { exports: {} as any },
    exports: {} as any,
    process: { env: { ...process.env } },
    console,
  }
  vm.runInNewContext(content, sandbox, { timeout: 2000 })
  const result = sandbox.module.exports || sandbox.exports
  return (result && typeof result === 'object' && 'default' in result && result.default) ? result.default : result
}
