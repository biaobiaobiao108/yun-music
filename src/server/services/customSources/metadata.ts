export interface UserApiInfo {
  id: string
  name: string
  description: string
  version: number | string
  author: string
  homepage: string
  script: string
  sources: Record<string, any>
  enabled: boolean
  owner: string // 'open' or username
  persist?: boolean
}

// 从脚本注释中提取元数据
export function extractMetadata(script: string): Partial<UserApiInfo> {
  const meta: any = {}

  // 匹配 JSDoc 风格的注释 (支持 /*! 和 /**)
  const commentMatch = script.match(/\/\*[*!]([\s\S]*?)\*\//)
  if (commentMatch) {
    const comment = commentMatch[1]

    // @name
    const nameMatch = comment.match(/@name\s+(.+)/)
    if (nameMatch) meta.name = nameMatch[1].trim()

    // @description
    const descMatch = comment.match(/@description\s+(.+)/)
    if (descMatch) meta.description = descMatch[1].trim()

    // @version
    const verMatch = comment.match(/@version\s+(.+)/)
    if (verMatch) meta.version = verMatch[1].trim()

    // @author
    const authorMatch = comment.match(/@author\s+(.+)/)
    if (authorMatch) meta.author = authorMatch[1].trim()

    // @repository or @homepage
    const repoMatch = comment.match(/@(?:repository|homepage)\s+(.+)/)
    if (repoMatch) meta.homepage = repoMatch[1].trim()
  }

  return meta
}
