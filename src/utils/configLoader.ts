import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

export const MAX_CACHE_SIZE_LIMIT_MB = 1024 * 1024

/**
 * 解析并校验缓存容量上限（单位 MB），拒绝非正数或非法输入并限制上限为 1 TB。
 */
export const parseCacheSizeLimitMb = (value: unknown, fallback = 2000): number => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || !/^\d+$/.test(trimmed)) return fallback
    const parsed = Number.parseInt(trimmed, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback
    return Math.min(parsed, MAX_CACHE_SIZE_LIMIT_MB)
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return Math.min(value, MAX_CACHE_SIZE_LIMIT_MB)
  }
  return fallback
}

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
    const raw = trimmed
      .replace(/^module\.exports\s*=\s*/, '')
      .replace(/;\s*$/, '')
      .trim()
    try {
      return JSON.parse(raw)
    } catch {
      // JSON 解析失败则回退至 VM 执行
    }
  }
  const sandbox = {
    module: { exports: {} as any },
    exports: {} as any,
    // No `process`/`console`: a config file should be data. Exposing process.env
    // handed DB paths and proxy credentials to anything that could write here.
  }
  vm.runInNewContext(content, sandbox, { timeout: 2000 })
  const result = sandbox.module.exports || sandbox.exports
  return result && typeof result === 'object' && 'default' in result && result.default ? result.default : result
}
