
const config: LX.Config = {
  serverName: 'yun-yin', // Web 服务名称
  'proxy.enabled': false, // 是否使用代理转发请求到本服务器
  'proxy.header': 'x-real-ip', // 代理转发的请求头 原始IP
  'proxy.trustedAddresses': ['127.0.0.1', '::1'], // 只有来自这些地址的连接才可信任转发头
  bindIP: '0.0.0.0', // 绑定IP
  port: 9527, // 端口
  'user.enablePath': true, // 是否开启用户路径
  'user.enableRoot': false, // 是否开启根路径
  'user.enablePublicRestriction': true, // 是否启用公开用户权限限制
  'user.enablePublicNonAdminLocalMusic': false, // 是否开启非管理员访问本地音乐
  'user.enablePublicFavorites': false, // 是否开启公开收藏和歌曲
  'user.enablePublicNonAdminAccess': false, // 是否开启非管理员访问公开收藏和歌曲
  'user.enableLoginCacheRestriction': false, // 是否启用登录用户缓存限制
  'user.enableCacheSizeLimit': false, // 是否启用缓存空间限制
  'user.cacheSizeLimit': 2000, // 缓存空间限制大小 (MB)

  maxSnapshotNum: 10, // 公共最大备份快照数
  'list.addMusicLocationType': 'top', // 公共添加歌曲到我的列表时的位置 top | bottom，参考客户端的「设置 → 列表设置 → 添加歌曲到列表时的位置」
  disableTelemetry: false, // 是否禁用数据收集（仅用于开源项目改进，不含敏感信息）

  users: [
    // 用户配置例子
    // {
    //   name: 'user1', // 用户名，必须，不能与其他用户名重复
    //   password: '123.def', // 是连接密码，必须，不能与其他用户密码重复，若在外网，务必增加密码复杂度
    //   maxSnapshotNum: 10, // 可选，最大备份快照数
    //   'list.addMusicLocationType': 'top', // 可选，添加歌曲到我的列表时的位置 top | bottom，参考客户端的「设置 → 列表设置 → 添加歌曲到列表时的位置」
    // },
  ],

  // 必须由部署者显式设置；禁止使用空密码或示例密码启动。
  'frontend.password': '',

  // Web播放器配置
  'player.enableAuth': false,
  'player.password': '',

  // 代理配置
  'proxy.all.enabled': false,
  'proxy.all.address': '',

  // 访问路径配置
  'admin.path': '', // 后台管理路径，默认为根路径 /
  'player.path': '/music', // 播放器路径
  'singer.sourcePriority': ['tx', 'wy'], // 歌手信息源优先级
  'artist.maxFetchPages': 20, // 歌手歌曲最大抓取页数
  'cache.namingPattern': 'simple', // 缓存命名规则
}

export default config
