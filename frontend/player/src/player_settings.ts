export const DEFAULT_SETTINGS = {
    itemsPerPage: 20, // Default 20 items per page, can be 'all'
    defaultEntry: 'favorites', // 默认入口: 'search' | 'songlist' | 'leaderboard' | 'favorites' | 'localmusic'
    preferredQuality: 'flac', // 默认播放音质偏好
    defaultDownloadTarget: 'server', // 默认下载目标: server | browser
    defaultDownloadQuality: 'flac', // 默认下载音质
    enablePublicSources: true, // 是否显示公开源
    enableProxyPlayback: false, // 播放音乐代理
    enableProxyDownload: false, // 下载音乐代理
    enableAutoProxy: true, // 自动代理
    enableCustomProxy: false, // 是否启用自定义代理
    customProxyUrl: '', // 自定义代理URL模板，使用 {url} 作为原始URL占位符
    enableOnlyDownloadMode: true, // 仅下载模式
    downloadConcurrency: 3, // 缓存并发量 (1-5)
    hotSearchLimit: 20, // 热搜显示数量
    lyricFontSize: 1.25, // 歌词字体大小 (rem)
    lyricFontFamily: '', // 词字体
    switchPlaylistOnSearchPlay: true, // 播放搜索歌曲时切换歌单 (默认开启)
    switchPlaylistOnSongListPlay: true, // 播放歌单/排行榜歌曲时切换歌单 (默认开启)
    autoResume: true, // 自动恢复进度 (默认开启)
    showSidebarSongInfo: false, // 展示侧边栏封面
    enableCrossfade: true, // 音频淡入淡出
    keepScreenAwake: true, // 保持屏幕唤醒设置
    enableKeyboardShortcuts: true, // 按键快捷方式 (默认开启)
    showLyricTranslation: true, // 显示歌词翻译
    showLyricRoma: false, // 显示歌词罗马音
    swapLyricTransRoma: false, // 交换翻译与罗马音位置
    autoCompactPlaybar: true, // 自动精简控制栏
    enableAutoSwitchSource: true, // 自动尝试换源
    enableAutoSwitchApiSource: true, // 自动解析换源
    enableAutoSkipOnError: true, // 失败自动下一曲
    enableAutoDegradeQuality: true, // 自动降低音质
    playbackErrorPriority: 'platform,quality,next', // 播放失败处理优先级
    enablePreloader: true, // 预读机制
    enableSmtcLyric: true, // SMTC 歌词显示
    showFooterVisualizer: true,
    footerVisualizerStyle: 'bars',
    showDetailVisualizer: false,
    detailVisualizerStyle: 'pulse',
    visualizerOpacity: 0.5,
    visualizerGlobalStyle: 'blocks',
    enableServerCache: true, // 开启服务器缓存
    enableServerLyricCache: true, // 开启服务器歌词文件缓存
    embedLyricToFile: true, // 下载时将歌词嵌入文件（标签+.lrc）
    serverCacheLocation: 'root', // 缓存位置: 'data' (application data) or 'root' (local)
    serverCacheNamingPattern: 'simple', // 缓存命名规则: standard | simple
    enableRemaster: false, // 启用下载目录歌曲洗版
    enableLyricCache: true,
    enableSongUrlCache: true,
    enableLyricGlow: true, // 歌词荧光效果 (默认开启)
    playerBackground: 'blur', // 播放页背景: 'blur', 'solid', 'dark'
    saveAccountSettingsToFile: true, // 登录后保存账号设置到服务器
    autoUpdateNetworkList: false, // 自动更新网络歌单（默认关闭）
    networkListAutoCheckInterval: '6h', // 网络歌单自动检测间隔
    favoriteSidebarOrder: [], // 我的收藏侧边栏子项排序
    preferServerCache: true, // 优先播放缓存歌曲 (默认开启)
    deduplicatePlaylistByQuality: true, // 同 ID 歌曲仅加入最高音质 (默认开启)
};

export function normalizeDownloadConcurrency(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.downloadConcurrency;
    return Math.min(5, Math.max(1, parsed));
}

export function normalizeStoredSettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return nextSettings;
    delete nextSettings.remasterRetryManifest;
    if (!['server', 'browser'].includes(nextSettings.defaultDownloadTarget)) {
        nextSettings.defaultDownloadTarget = DEFAULT_SETTINGS.defaultDownloadTarget;
    }
    if (!['128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master'].includes(nextSettings.defaultDownloadQuality)) {
        nextSettings.defaultDownloadQuality = DEFAULT_SETTINGS.defaultDownloadQuality;
    }
    if (nextSettings.downloadConcurrency !== undefined) {
        nextSettings.downloadConcurrency = normalizeDownloadConcurrency(nextSettings.downloadConcurrency);
    }
    nextSettings.serverCacheNamingPattern = nextSettings.serverCacheNamingPattern === 'standard'
        ? 'standard'
        : 'simple';
    return nextSettings;
}
