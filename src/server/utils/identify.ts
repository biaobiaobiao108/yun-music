import path from 'path'
import os from 'os'
import fs from 'fs'
import { execFile } from 'node:child_process'

/**
 * AcoustID 歌曲识别工具类
 */

// AcoustID 配置
const API_KEY = 'Ti0HHLDf9O'
const API_URL = 'https://api.acoustid.org/v2/lookup'

/**
 * 获取 fpcalc 二进制路径
 */
function getFpcalcPath(): string | null {
    // 1. 检查 PATH 中是否已存在 (例如 Linux/Docker 环境下安装了 chromaprint)
    const globalPath = Bun.which('fpcalc')
    if (globalPath) return globalPath

    // 2. 检查本地打包目录
    const platform = os.platform() // win32, linux, darwin
    const arch = os.arch()         // x64, arm64

    // 构造可能的平台特定文件名
    let platformBinaryName = ''
    if (platform === 'win32') {
        platformBinaryName = `fpcalc-win-${arch === 'arm64' ? 'arm64' : 'x64'}.exe`
    } else if (platform === 'linux') {
        if (arch === 'arm64') platformBinaryName = 'fpcalc-linux-arm64'
        else if (arch === 'arm') platformBinaryName = 'fpcalc-linux-arm'
        else platformBinaryName = 'fpcalc-linux-x64'
    } else if (platform === 'darwin') {
        platformBinaryName = 'fpcalc-macos'
    }

    const binDir = path.join(process.cwd(), 'public/music/bin')

    // 优先匹配带平台的名称
    if (platformBinaryName) {
        const platformPath = path.join(binDir, platformBinaryName)
        if (fs.existsSync(platformPath)) return platformPath
    }

    // 次优先匹配通用名称 (兼容旧版或手动放置)
    const genericName = platform === 'win32' ? 'fpcalc.exe' : 'fpcalc'
    const genericPath = path.join(binDir, genericName)
    if (fs.existsSync(genericPath)) return genericPath

    return null
}

/**
 * 提取音频指纹
 */
export async function getFingerprint(filePath: string): Promise<{ fingerprint: string; duration: number }> {
    const fpcalcPath = getFpcalcPath()
    if (!fpcalcPath) {
        throw new Error('未找到 fpcalc 二进制文件。Docker 环境请安装 chromaprint (apk add chromaprint)')
    }

    try {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(fpcalcPath, ['-json', filePath], {
                timeout: 30_000,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
            }, (error, output) => error ? reject(error) : resolve(output))
        })
        const result = JSON.parse(stdout)
        if (typeof result.fingerprint !== 'string' || !result.fingerprint || !Number.isFinite(result.duration) || result.duration <= 0) {
            throw new Error('无效的音频指纹结果')
        }
        return result
    } catch (error: any) {
        throw new Error(error.killed ? '音频指纹提取超时' : `fpcalc 报错: ${error.message}`)
    }
}

/**
 * 查询 AcoustID
 */
export async function lookupSong(fingerprint: string, duration: number): Promise<any> {
    const params = new URLSearchParams({
        format: 'json',
        client: API_KEY,
        duration: String(Math.floor(duration)),
        fingerprint: fingerprint,
        meta: 'recordings releasegroups releases tracks'
    })

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            body: params,
            signal: AbortSignal.timeout(10000),
        })

        if (!response.ok) {
            throw new Error(`AcoustID API 返回状态码 ${response.status}`)
        }

        return await response.json()
    } catch (error: any) {
        throw new Error(`AcoustID 查询失败: ${error.message}`)
    }
}

/**
 * 识别本地歌曲并返回格式化的结果
 */
export async function identifyLocalSong(filePath: string) {
    const { fingerprint, duration } = await getFingerprint(filePath)
    const data = await lookupSong(fingerprint, duration)

    if (!data.results || data.results.length === 0) {
        return []
    }

    // 转换成统一格式
    const formattedResults = data.results.map((result: any) => {
        if (!result.recordings || result.recordings.length === 0) {
            return null
        }

        const rec = result.recordings[0]
        const artists = rec.artists ? rec.artists.map((a: any) => a.name).join(', ') : '未知歌手'
        const album = (rec.releasegroups && rec.releasegroups.length > 0) ? rec.releasegroups[0].title : ''

        return {
            name: rec.title,
            singer: artists,
            album: album,
            score: result.score
        }
    }).filter(Boolean)

    // 按得分排序
    return formattedResults.sort((a: any, b: any) => b.score - a.score)
}
