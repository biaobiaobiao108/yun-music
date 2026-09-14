import * as fs from 'fs'
import * as path from 'path'
import { extractMetadata, loadUserApi, initUserApis, getApiStatus } from './userApi'
import type { HttpContext } from './core'
import { verifyAdminAuth } from './auth'
import { verifyUserAuth } from './routes/auth'
import { assertSafePathSegment } from '@/utils/pathSecurity'
import { assertSafeRemoteHttpUrl } from './networkSecurity'

// 读取请求体
async function readBody(ctx: HttpContext): Promise<string> {
    return ctx.bodyText()
}

const getRequestedOwner = (ctx: HttpContext, requested?: string): string => {
    const admin = verifyAdminAuth(ctx.request)
    const tokenUser = verifyUserAuth(ctx)
    const value = typeof requested === 'string' ? requested.trim() : ''

    if (value === 'open' || value === '_open') {
        if (!admin) throw new Error('管理员权限不足')
        return 'open'
    }
    if (!value || value === 'default') {
        if (tokenUser) return tokenUser
        if (admin) return 'open'
        throw new Error('请先登录')
    }
    if (admin || tokenUser === value) {
        assertSafePathSegment(value, 'username')
        return value
    }
    throw new Error('无权操作其他用户的自定义源')
}

const requireAdmin = (ctx: HttpContext): void => {
    if (!verifyAdminAuth(ctx.request)) throw new Error('管理员权限不足')
}

const sourceMutationTails = new Map<string, Promise<void>>()

async function withSourceMutationLock<T>(owner: string, operation: () => Promise<T>): Promise<T> {
    const previous = sourceMutationTails.get(owner) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    sourceMutationTails.set(owner, current)
    await previous
    try {
        return await operation()
    } finally {
        release()
        if (sourceMutationTails.get(owner) === current) sourceMutationTails.delete(owner)
    }
}

async function withSourceMutationLocks<T>(owners: string[], operation: () => Promise<T>): Promise<T> {
    const uniqueOwners = [...new Set(owners)].sort()
    const acquire = async (index: number): Promise<T> => {
        if (index >= uniqueOwners.length) return operation()
        return withSourceMutationLock(uniqueOwners[index], () => acquire(index + 1))
    }
    return acquire(0)
}

function writeTextFileAtomic(filePath: string, content: string): void {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    try {
        fs.writeFileSync(tempPath, content, 'utf-8')
        fs.renameSync(tempPath, filePath)
    } finally {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath) } catch { }
        }
    }
}

function writeJsonFileAtomic(filePath: string, value: unknown): void {
    writeTextFileAtomic(filePath, JSON.stringify(value, null, 2))
}

// 验证脚本
export async function handleValidate(ctx: HttpContext): Promise<Response> {
    try {
        const body = await readBody(ctx)
        const { script, username } = JSON.parse(body)

        const targetOwner = (username && username !== 'default') ? getRequestedOwner(ctx, username) : (verifyUserAuth(ctx) || (requireAdmin(ctx), 'open'))

        if (!script || typeof script !== 'string') {
            throw new Error('Invalid script content')
        }

        const metadata = extractMetadata(script)

        // 尝试加载验证
        const result = await loadUserApi({
            id: 'temp_validation',
            script,
            enabled: false,
            ...metadata,
            owner: 'temp', // 临时验证 owner
            persist: false,
        } as any)

        try {
            if (result.success) {
                // 检查是否注册了任何源
                const api = result.apiInstance
                const sources = api?.info?.sources || {}
                const sourcesCount = Object.keys(sources).length

                if (sourcesCount === 0) {
                    throw new Error('脚本没有注册任何音源。请确保脚本正确调用了 lx.send("inited", { sources: {...} })')
                }

                return ctx.json({
                    valid: true,
                    metadata,
                    sources: Object.keys(sources),
                    sourcesCount
                })
            } else {
                return ctx.json({
                    valid: false,
                    error: result.error,
                    metadata // 即使验证失败也返回元数据，方便前端展示
                })
            }
        } finally {
            if (result.success) await result.apiInstance?.dispose?.()
        }
    } catch (err: any) {
        return ctx.json({ valid: false, error: err.message }, 400)
    }
}

// 辅助函数：获取脚本信息（元数据和支持的源）
async function getScriptInfo(scriptContent: string) {
    const metadata = extractMetadata(scriptContent)

    // 试运行脚本以获取支持的源
    let supportedSources: string[] = []
    try {
        const result = await loadUserApi({
            id: 'temp_analysis_' + Date.now(),
            script: scriptContent,
            enabled: false,
            ...metadata,
            owner: 'temp',
            persist: false,
        } as any)

        try {
            if (result.success && result.apiInstance?.info?.sources) {
                supportedSources = Object.keys(result.apiInstance.info.sources)
            }
        } finally {
            if (result.success) await result.apiInstance?.dispose?.()
        }
    } catch (e: any) {
        console.warn('[CustomSource] 分析脚本支持源失败:', e.message)
    }

    return { metadata, supportedSources }
}

// 辅助函数：获取源存储目录
function getSourceDir(username?: string) {
    const dataPath = global.lx?.dataPath || process.env.DATA_PATH || path.join(process.cwd(), 'data')
    const root = path.join(dataPath, 'users', 'source')
    // 如果 username 是 'open' 或 'default' 或空，则映射到 '_open'
    const targetDirName = (username && username !== 'default' && username !== 'open') ? assertSafePathSegment(username, 'username') : '_open'
    return path.join(root, targetDirName)
}

// 辅助函数：生成可读且唯一的 ID/文件名
function generateId(name?: string, fallbackFilename?: string): string {
    let input = name || fallbackFilename || 'source'

    // 尝试解码，防止输入已经是 URL 编码的状态
    try {
        input = decodeURIComponent(input)
    } catch (e) {
        // 忽略解码错误（例如包含不合法的 % 字符）
    }

    // 如果是路径，只取最后一部分
    let base = path.basename(input)

    // 统一移除 .js 后缀，后面再补上，确保一致性
    if (base.toLowerCase().endsWith('.js')) {
        base = base.slice(0, -3)
    }

    // 过滤掉文件系统非法字符，保持中文等字符可读
    const clean = base.replace(/[\\/:*?"<>|]/g, '_').trim()

    return `${clean || 'source'}.js`
}

// 上传脚本
export async function handleUpload(ctx: HttpContext): Promise<Response> {
    try {
        const body = await readBody(ctx)
        const { filename, content, username } = JSON.parse(body)

        // 确定 owner 用于后续标识
        const targetOwner = getRequestedOwner(ctx, username)

        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
            throw new Error('Script content is missing or too large')
        }

        // 获取脚本信息
        const { metadata, supportedSources } = await getScriptInfo(content)

        let id = ''
        await withSourceMutationLock(targetOwner, async () => {
            const sourcesDir = getSourceDir(targetOwner)
            const metaPath = path.join(sourcesDir, 'sources.json')
            if (!fs.existsSync(sourcesDir)) fs.mkdirSync(sourcesDir, { recursive: true })

            // 生成唯一ID（可读的文件名）
            id = generateId(metadata.name, filename)
            assertSafePathSegment(id, 'source filename')
            const scriptPath = path.join(sourcesDir, id)

            let sources: any[] = []
            if (fs.existsSync(metaPath)) sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            if (sources.find(s => s.id === id)) {
                throw new Error(`源 "${metadata.name || filename}" 已存在于 [${targetOwner}]`)
            }

            writeTextFileAtomic(scriptPath, content)
            try {
                sources.push({
                    id,
                    name: metadata.name || filename,
                    version: metadata.version || '1.0.0',
                    author: metadata.author || '未知',
                    description: metadata.description || '',
                    homepage: metadata.homepage || '',
                    size: Buffer.byteLength(content, 'utf-8'),
                    supportedSources,
                    enabled: false,
                    uploadTime: new Date().toISOString(),
                })
                writeJsonFileAtomic(metaPath, sources)
            } catch (error) {
                try { fs.unlinkSync(scriptPath) } catch { }
                throw error
            }

            await initUserApis(targetOwner)
        })

        return ctx.json({ success: true, id, metadata, supportedSources, owner: targetOwner })
    } catch (err: any) {
        console.error('[CustomSource] Upload error:', err)
        return ctx.json({ success: false, error: err.message }, 500)
    }
}

// 从远程URL导入脚本
export async function handleImport(ctx: HttpContext): Promise<Response> {
    try {
        const body = await readBody(ctx)
        const { url, filename, username } = JSON.parse(body)

        if (!url) {
            throw new Error('Missing URL')
        }

        // 前置身份与权限校验，防止无权限用户滥用服务器带宽发起外部请求
        const targetOwner = getRequestedOwner(ctx, username)

        // 辅助函数：使用 Bun 原生 fetch 实现具备超时保护、SSRF 防御与流式字节限制的下载
        const download = async (targetUrl: string, depth = 0): Promise<string> => {
            if (depth > 5) throw new Error('Too many redirects')
            const safeUrl = await assertSafeRemoteHttpUrl(targetUrl)

            const response = await fetch(safeUrl.href, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(10000),
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
            })

            // 手动处理重定向，确保逐跳经过 assertSafeRemoteHttpUrl 校验防止 SSRF 绕过
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location')
                if (location) {
                    const redirectUrl = new URL(location, safeUrl).toString()
                    return download(redirectUrl, depth + 1)
                }
            }

            if (!response.ok) {
                throw new Error(`Failed to download: status code ${response.status}`)
            }

            const maxBytes = 5 * 1024 * 1024
            const declaredLength = Number(response.headers.get('content-length') || 0)
            if (declaredLength > maxBytes) {
                throw new Error('Remote script is too large')
            }

            // 使用 Web Streams 流式读取并限制最大尺寸，超限立即 cancel 中止底层连接
            const reader = response.body?.getReader()
            if (!reader) {
                const text = await response.text()
                if (Buffer.byteLength(text, 'utf8') > maxBytes) {
                    throw new Error('Remote script is too large')
                }
                return text
            }

            const chunks: Uint8Array[] = []
            let totalBytes = 0
            while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value) {
                    totalBytes += value.byteLength
                    if (totalBytes > maxBytes) {
                        await reader.cancel('Remote script is too large')
                        throw new Error('Remote script is too large')
                    }
                    chunks.push(value)
                }
            }

            return Buffer.concat(chunks).toString('utf-8')
        }

        const content = await download(url)

        // 获取脚本信息
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
            throw new Error('Script content is missing or too large')
        }
        const { metadata, supportedSources } = await getScriptInfo(content)

        // 生成唯一ID（可读的文件名）
        const displayName = metadata.name || filename || 'unknown_source'
        let id = ''
        await withSourceMutationLock(targetOwner, async () => {
            const sourcesDir = getSourceDir(targetOwner)
            const metaPath = path.join(sourcesDir, 'sources.json')
            if (!fs.existsSync(sourcesDir)) fs.mkdirSync(sourcesDir, { recursive: true })

            id = generateId(metadata.name, filename || 'unknown_source')
            assertSafePathSegment(id, 'source filename')
            const scriptPath = path.join(sourcesDir, id)

            let sources: any[] = []
            if (fs.existsSync(metaPath)) sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            if (sources.find(s => s.id === id)) {
                throw new Error(`源 "${displayName}" 已存在于 [${targetOwner}]`)
            }

            writeTextFileAtomic(scriptPath, content)
            try {
                sources.push({
                    id,
                    name: metadata.name || filename,
                    version: metadata.version || '1.0.0',
                    author: metadata.author || '未知',
                    description: metadata.description || '',
                    homepage: metadata.homepage || '',
                    size: Buffer.byteLength(content, 'utf-8'),
                    supportedSources,
                    enabled: false,
                    uploadTime: new Date().toISOString(),
                    sourceUrl: url,
                })
                writeJsonFileAtomic(metaPath, sources)
            } catch (error) {
                try { fs.unlinkSync(scriptPath) } catch { }
                throw error
            }

            await initUserApis(targetOwner)
        })

        return ctx.json({ success: true, filename: displayName, id, metadata, supportedSources, owner: targetOwner })
    } catch (err: any) {
        console.error('[CustomSource] Import error:', err)
        return ctx.json({ success: false, error: err.message }, 500)
    }
}

// 获取列表
// 如果提供了 username，返回 open + username 的源
// 如果没提供，只返回 open 的源
export async function handleList(ctx: HttpContext, username: string): Promise<Response> {
    const openSources: any[] = []
    const userSources: any[] = []

    // 1. 读取 Open 源
    const openSourcesDir = getSourceDir('open') // -> .../_open
    const openMetaPath = path.join(openSourcesDir, 'sources.json')

    if (fs.existsSync(openMetaPath)) {
        try {
            const parsedOpenSources = JSON.parse(fs.readFileSync(openMetaPath, 'utf-8'))
            parsedOpenSources.forEach((s: any) => {
                s.owner = 'open'
                s.isPublic = true
                openSources.push(s)
            })
        } catch (e) { }
    }

    // 2. 读取 User 源 (如果有)
    let userStates: Record<string, any> = {}
    if (username && username !== 'default') {
        const userSourcesDir = getSourceDir(username)
        const userMetaPath = path.join(userSourcesDir, 'sources.json')
        const userStatesPath = path.join(userSourcesDir, 'states.json')

        if (fs.existsSync(userStatesPath)) {
            try {
                userStates = JSON.parse(fs.readFileSync(userStatesPath, 'utf-8'))
            } catch (e) { }
        }

        if (fs.existsSync(userMetaPath)) {
            try {
                const parsedUserSources = JSON.parse(fs.readFileSync(userMetaPath, 'utf-8'))
                parsedUserSources.forEach((s: any) => {
                    s.owner = username
                    s.isPublic = false
                    userSources.push(s)
                })
            } catch (e) { }
        }
    }

    // 合并列表：如果公开源和用户源存在相同ID，则排除公开源
    const allSources: any[] = []
    const userSourceIds = new Set(userSources.map(s => s.id))

    openSources.forEach((s: any) => {
        if (!userSourceIds.has(s.id)) {
            if (userStates[s.id] && typeof userStates[s.id].enabled === 'boolean') {
                s.enabled = userStates[s.id].enabled
            }
            allSources.push(s)
        }
    })

    allSources.push(...userSources)

    // 补充运行时状态
    const enrichedSources = allSources.map((source: any) => {
        // 合并运行时状态
        const status = getApiStatus(source.owner, source.id)
        if (status) {
            source.status = status.status
            source.error = status.error
        }
        return source
    })

    // ===== 自定义合并后的排序逻辑 =====
    let targetOwner = username && username !== 'default' ? assertSafePathSegment(username, 'username') : 'open'
    let orderPath = path.join(getSourceDir(targetOwner), 'order.json')
    let order: string[] = []

    if (!fs.existsSync(orderPath) && targetOwner !== 'open') {
        // 未保存私有排序则尝试获取公开排序
        orderPath = path.join(getSourceDir('open'), 'order.json')
    }

    if (fs.existsSync(orderPath)) {
        try {
            order = JSON.parse(fs.readFileSync(orderPath, 'utf-8'))
        } catch (e) { }
    }

    if (order.length > 0) {
        const idToIndex = new Map(order.map((id, index) => [id, index]))
        enrichedSources.sort((a, b) => {
            // 永远保持“已启用”在前的分组逻辑
            if (a.enabled !== b.enabled) {
                return a.enabled ? -1 : 1
            }

            // 同组内根据保存的绝对顺序排序
            const indexA = idToIndex.has(a.id) ? idToIndex.get(a.id)! : 999999
            const indexB = idToIndex.has(b.id) ? idToIndex.get(b.id)! : 999999

            if (indexA !== indexB) {
                return indexA - indexB
            }
            return 0
        })
    } else {
        // 默认让启用的在前，禁用的在后
        enrichedSources.sort((a, b) => {
            if (a.enabled !== b.enabled) {
                return a.enabled ? -1 : 1
            }
            return 0
        })
    }

    return ctx.json(enrichedSources)
}

// 启用/禁用
// 启用/禁用
export async function handleToggle(ctx: HttpContext): Promise<Response> {
    try {
        const body = await readBody(ctx)
        const { id, sourceId, enabled, username } = JSON.parse(body)
        const targetId = id || sourceId
        assertSafePathSegment(targetId, 'source id')

        let targetOwner = getRequestedOwner(ctx, username)

        // 检查权限限制
        if (targetOwner === 'open') {
            if (!verifyAdminAuth(ctx.request)) {
                return ctx.json({ success: false, error: '公共源状态切换已受限，仅管理员可操作。' }, 403)
            }
        }

        return await withSourceMutationLocks([targetOwner, 'open'], async () => {
        let sourcesDir = getSourceDir(targetOwner)
        let metaPath = path.join(sourcesDir, 'sources.json')

        let target: any = null
        let sources: any[] = []
        let isPublicSourceToggle = false

        if (!fs.existsSync(sourcesDir)) {
            fs.mkdirSync(sourcesDir, { recursive: true })
        }

        if (fs.existsSync(metaPath)) {
            sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            target = sources.find((s: any) => s.id === targetId)
        }

        if (!target && targetOwner !== 'open') {
            // 尝试看看是否是普通用户在切换公共源
            const openSourcesDir = getSourceDir('open')
            const openMetaPath = path.join(openSourcesDir, 'sources.json')
            if (fs.existsSync(openMetaPath)) {
                const openSources = JSON.parse(fs.readFileSync(openMetaPath, 'utf-8'))
                const openTarget = openSources.find((s: any) => s.id === targetId)
                if (openTarget) {
                    target = openTarget
                    isPublicSourceToggle = true
                }
            }
        }

        if (!target) {
            throw new Error('源不存在')
        }

        // 核心安全逻辑：
        // 1. 如果正在执行的是公共源个人状态切换 (isPublicSourceToggle === true)
        //    则只需在 server.ts 层面保证用户已登录即可，不需要额外的管理员密码。
        // 2. 如果正在修改的是全局公共源 (targetOwner === 'open')
        //    则必须校验管理员密码。
        if (targetOwner === 'open') {
            if (!verifyAdminAuth(ctx.request)) {
                return ctx.json({ success: false, error: '权限不足：管理全局公开自定义源需要验证管理员身份。' }, 403)
            }
        }

        if (isPublicSourceToggle) {
            // 普通用户独立记录公开源的开启/关闭状态，不修改公开源属性
            const userStatesPath = path.join(sourcesDir, 'states.json')
            let states: any = {}
            if (fs.existsSync(userStatesPath)) {
                try { states = JSON.parse(fs.readFileSync(userStatesPath, 'utf-8')) } catch (e) { }
            }
            if (!states[targetId]) states[targetId] = {}
            states[targetId].enabled = enabled !== undefined ? enabled : !(states[targetId].enabled ?? target.enabled)
            writeJsonFileAtomic(userStatesPath, states)

            return ctx.json({ success: true, enabled: states[targetId].enabled })
        }

        target.enabled = enabled !== undefined ? enabled : !target.enabled

        writeJsonFileAtomic(metaPath, sources)

        await initUserApis(targetOwner)
        return ctx.json({ success: true, enabled: target.enabled })
        })
    } catch (err: any) {
        console.error('[CustomSource] Toggle error:', err)
        return ctx.text(err.message, 500)
    }
}

// 拖拽排序，更新 sources.json 中源的顺序
export async function handleReorder(ctx: HttpContext): Promise<Response> {
    try {
        const body = await readBody(ctx)
        const { username, sourceIds } = JSON.parse(body)

        if (!Array.isArray(sourceIds) || sourceIds.length > 500 || sourceIds.some(id => typeof id !== 'string' || id.length > 128)) {
            throw new Error('sourceIds must be an array')
        }

        let targetOwner = getRequestedOwner(ctx, username)

        // 检查权限限制 (公开源排序)
        if (targetOwner === 'open') {
            if (!verifyAdminAuth(ctx.request)) {
                return ctx.json({ success: false, error: '公共源排序已受限，仅管理员可操作。' }, 403)
            }
        }

        return await withSourceMutationLock(targetOwner, async () => {
        let sourcesDir = getSourceDir(targetOwner)
        let metaPath = path.join(sourcesDir, 'sources.json')
        let orderPath = path.join(sourcesDir, 'order.json')

        if (!fs.existsSync(sourcesDir)) {
            fs.mkdirSync(sourcesDir, { recursive: true })
        }

        // 保存混合列表的绝对顺序到 order.json（用于 handleList 展示排序）
        writeJsonFileAtomic(orderPath, sourceIds)

        if (fs.existsSync(metaPath)) {
            const sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            const currentSourcesMap = new Map(sources.map((s: any) => [s.id, s]))
            const newSources: any[] = []

            for (const id of sourceIds) {
                if (currentSourcesMap.has(id)) {
                    newSources.push(currentSourcesMap.get(id))
                    currentSourcesMap.delete(id)
                }
            }
            for (const [id, source] of currentSourcesMap) {
                newSources.push(source)
            }
            writeJsonFileAtomic(metaPath, newSources)
        }

        // 重新加载 API，使新顺序立即生效于解析优先级
        await initUserApis(targetOwner)

        return ctx.json({ success: true })
        })
    } catch (err: any) {
        console.error('[CustomSource] Reorder error:', err)
        return ctx.text(err.message, 500)
    }
}

// 删除
export async function handleDelete(ctx: HttpContext): Promise<Response> {
    try {
        const body = await readBody(ctx)
        const { id, sourceId, username } = JSON.parse(body)
        const targetId = id || sourceId
        assertSafePathSegment(targetId, 'source id')

        // 查找逻辑同 Toggle
        let targetOwner = getRequestedOwner(ctx, username)

        // 检查权限限制
        if (targetOwner === 'open') {
            if (!verifyAdminAuth(ctx.request)) {
                return ctx.json({ success: false, error: '公共源删除已受限，仅管理员可操作。' }, 403)
            }
        }

        return await withSourceMutationLocks([targetOwner, 'open'], async () => {
        let sourcesDir = getSourceDir(targetOwner)
        let metaPath = path.join(sourcesDir, 'sources.json')

        // 尝试定位源
        let found = false
        let sources = []

        if (fs.existsSync(metaPath)) {
            sources = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            if (sources.find((s: any) => s.id === targetId)) {
                found = true
            }
        }

        if (!found && targetOwner !== 'open') {
            const openSourcesDir = getSourceDir('open')
            const openMetaPath = path.join(openSourcesDir, 'sources.json')

            if (fs.existsSync(openMetaPath)) {
                const openSources = JSON.parse(fs.readFileSync(openMetaPath, 'utf-8'))
                if (openSources.find((s: any) => s.id === targetId)) {
                    targetOwner = 'open'
                    sourcesDir = openSourcesDir
                    metaPath = openMetaPath
                    sources = openSources
                    found = true
                }
            }
        }

        if (!found) {
            throw new Error('源不存在')
        }

        // 核心安全逻辑：删除全局公开源必须校验管理员权限
        if (targetOwner === 'open') {
            if (!verifyAdminAuth(ctx.request)) {
                return ctx.json({ success: false, error: '权限不足：删除全局公共源需要验证管理员身份。' }, 403)
            }
        }

        const scriptPath = path.join(sourcesDir, targetId)
        sources = sources.filter((s: any) => s.id !== targetId)

        // 先原子提交元数据，再删除脚本；元数据写失败时保留脚本，避免数据丢失。
        writeJsonFileAtomic(metaPath, sources)
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath)

        // 重新初始化
        await initUserApis(targetOwner)

        return ctx.json({ success: true })
        })
    } catch (err: any) {
        console.error('[CustomSource] Delete error:', err)
        return ctx.text(err.message, 500)
    }
}
