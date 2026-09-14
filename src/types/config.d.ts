declare namespace LX {
  type AddMusicLocationType = 'top' | 'bottom'

  interface User {
    /**
     * 用户名
     */
    name: string

    /**
     * 连接密码
     */
    password: string

    /** SQLite 中保存的密码哈希；仅作为运行时凭据，不写入配置文件。 */
    passwordHash?: string

    /**
     * 最大备份快照数
     */
    maxSnapshotNum?: number

    /**
     * 添加歌曲到我的列表时的方式
     */
    'list.addMusicLocationType'?: AddMusicLocationType
  }

  interface UserConfig extends User {
    dataPath: string
  }

  interface Config {
    /**
     * Web 服务名称
     */
    'serverName': string

    /**
     * 是否使用代理转发请求到本服务器
     */
    'proxy.enabled': boolean

    /**
     * 代理转发的请求头 原始IP
     */
    'proxy.header': string

    /**
     * 绑定IP
     */
    bindIP: string

    /**
     * 端口
     */
    port: number

    /**
     * 是否开启用户路径 /<userName>
     */

    /**
     * 是否开启用户路径 /<userName>
     */
    'user.enablePath'?: boolean

    /**
     * 是否开启根路径 /
     */
    'user.enableRoot'?: boolean

    /**
     * 是否启用公开用户权限限制
     */
    'user.enablePublicRestriction'?: boolean

    /**
     * 是否开启非管理员访问本地音乐
     */
    'user.enablePublicNonAdminLocalMusic'?: boolean

    /**
     * 是否开启公开收藏和歌曲
     */
    'user.enablePublicFavorites'?: boolean

    /**
     * 是否开启非管理员访问公开收藏和歌曲
     */
    'user.enablePublicNonAdminAccess'?: boolean

    /**
     * 是否启用登录用户缓存限制
     */
    'user.enableLoginCacheRestriction'?: boolean
    /**
     * 是否启用缓存空间限制
     */
    'user.enableCacheSizeLimit'?: boolean
    /**
     * 缓存空间限制大小 (MB)
     */
    'user.cacheSizeLimit'?: number

    /**
     * 公共最大备份快照数
     */
    maxSnapshotNum: number

    /**
     * 公共添加歌曲到我的列表时的方式 top | bottom，参考客户端的设置-列表设置-添加歌曲到我的列表时的方式
     */
    'list.addMusicLocationType': AddMusicLocationType

    /**
     * Web 用户
     */
    users: UserConfig[]

    /**
     * 前端访问密码
     */
    'frontend.password'?: string

    /**
     * 是否开启Web播放器访问密码
     */
    'player.enableAuth'?: boolean

    /**
     * Web播放器访问密码
     */
    'player.password'?: string

    /**
     * 是否启用针对所有外发请求的代理 (目前主要用于 Music SDK)
     */
    'proxy.all.enabled'?: boolean

    /**
     * 代理地址 (支持 http:// 或 socks5://)
     */
    'proxy.all.address'?: string

    /**
     * 是否禁用数据收集
     */
    disableTelemetry?: boolean

    /**
     * 后台管理界面访问路径，默认为空字符串（表示根路径 /）
     */
    'admin.path'?: string

    /**
     * Web播放器访问路径，默认为 /music
     */
    'player.path'?: string

    /**
     * 歌手信息源优先级
     */
    'singer.sourcePriority': Array<'tx' | 'wy'>
    /**
     * 歌手歌曲最大抓取页数
     */
    'artist.maxFetchPages'?: number
    /**
     * 缓存命名规则
     */
    'cache.namingPattern'?: string
    /**
     * 缓存存储位置
     */
    serverCacheLocation?: string
  }
}
