/**
 * 歌手信息助手
 * 支持从 TX (QQ音乐) 和 WY (网易云音乐) 源获取歌手详细信息
 */

import { getBuiltinSource } from '@/modules/utils/musicSdk'
import { NativeLruCache } from '@/utils/nativeLru'

export interface SingerDetail {
    name: string
    mid: string
    source: 'tx' | 'wy'
    pic: string
    desc: string
}

const singerCache = new NativeLruCache<string, SingerDetail>({
    max: 512,
    ttl: 30 * 60 * 1000,
})

/**
 * 根据歌手名称检索其在指定源或最优源的 MID
 */
export async function getSingerMid(singerName: string, sourcePriority?: Array<'tx' | 'wy'>): Promise<string | null> {
    const detail = await getSingerDetail(singerName, sourcePriority)
    return detail?.mid || null
}

/**
 * 获取歌手照片链接
 */
export async function getSingerPic(singerName: string, sourcePriority?: Array<'tx' | 'wy'>): Promise<string | null> {
    const detail = await getSingerDetail(singerName, sourcePriority)
    return detail?.pic || null
}

/**
 * 获取歌手详细信息
 * @param singerName 歌手名
 * @param sourcePriority 优选顺序，默认从全局配置获取
 */
export async function getSingerDetail(singerName: string, sourcePriority?: Array<'tx' | 'wy'>): Promise<SingerDetail | null> {
    const priority = sourcePriority || global.lx.config['singer.sourcePriority'] || ['tx', 'wy']
    const cacheKey = `${singerName}_${priority.join('_')}`
    const cached = singerCache.get(cacheKey)
    if (cached) return cached

    // 尝试每一个平台
    for (const source of priority) {
        try {
            const sdk = getBuiltinSource(source)
            if (!sdk?.extendSearch?.searchSinger) continue

            // 1. 搜索歌手
            const searchResult = await sdk.extendSearch.searchSinger(singerName, 1, 5)
            const singerList = searchResult?.list || []
            if (singerList.length === 0) continue

            // 寻找名字对应最紧密的歌手
            let matched = singerList.find((s: any) => s.name === singerName)
            if (!matched) matched = singerList[0]

            const mid = String(matched.mid || matched.id)
            if (!mid) continue

            // 2. 调用通用的 extendDetail.getArtistDetail 获取简介和头像
            let desc = matched.alias?.[0] || ''
            let pic = matched.picUrl || matched.img || matched.avatar || ''

            if (sdk.extendDetail?.getArtistDetail) {
                const detail = await sdk.extendDetail.getArtistDetail(mid).catch(() => null)
                if (detail) {
                    desc = detail.desc || desc
                    pic = detail.avatar || detail.pic || pic
                }
            }

            // 兜底补全头像 (TX 特有规则)
            if (!pic && source === 'tx' && mid) {
                pic = `https://y.gtimg.cn/music/photo_new/T001R500x500M000${mid}.jpg`
            }

            const detail: SingerDetail = {
                name: singerName,
                mid,
                source,
                pic,
                desc,
            }

            singerCache.set(cacheKey, detail)
            return detail

        } catch (err) {
            console.warn(`[SingerUtils] 从 ${source} 获取歌手 [${singerName}] 失败:`, err)
            continue
        }
    }

    return null
}
