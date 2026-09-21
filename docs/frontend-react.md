# 云音 React 前端架构说明

本文档记录前端全面迁移后的工程边界，帮助维护者区分源码、发布产物和仍然保留的浏览器底层能力。

## 入口与构建

前端继续使用 Bun Bundler，不切换 Vite：

- `frontend/player/src/react/index.tsx`：播放器主入口。
- `frontend/player/src/react/login.tsx`：播放器访问密码登录入口。
- `frontend/admin/src/react/index.tsx`：管理后台入口。
- `frontend/styles/`：设计令牌、共享主题、播放器和后台样式源文件。
- `scripts/build-frontend.ts`：构建 hash 入口、代码分割 chunk、Service Worker 引用和发布 HTML。

迁移清理边界：当前发布链路只构建三个 React 入口（播放器、播放器登录页、管理后台）。旧命令式播放器入口、旧管理后台 feature 模块、播放器旧管理器、vendor bridge、频谱/音效/变调工作线程及其资源已移除；`player_history.ts` 已归档到 React 目录，因为它仍被当前导航状态使用。构建脚本会清理本地遗留的旧 bundle，资源检查会阻止这些文件重新进入 HTML、Service Worker 或懒加载引用。仍被共享 Markdown 服务使用的 `marked` 等依赖不会因“旧代码”标签误删。

修改 `frontend/` 或 `frontend/styles/` 后必须运行：

```bash
bun run build:frontend
bun run check:frontend-assets
```

不要直接编辑 `public/` 下的 hash JavaScript、CSS 或 HTML 编译产物。

## 状态边界

播放器状态按领域拆分在 `frontend/player/src/react/store/`，`store.ts` 只作为兼容导出层：

- `auth.ts`：播放器/用户认证、会话失效时的请求缓存清理。
- `settings.ts`：`lx_settings` 迁移、主题应用和播放质量同步。
- `ui.ts`：当前页面、详情、抽屉、对话框、沉浸式歌词和通知；不直接写浏览器 URL。
- `search.ts`：搜索分页、热门搜索、请求取消、短期结果缓存和失效。
- `library.ts`：`loveList`、`userList` 和兼容保留的 `defaultList`；歌单变更会失效并强制刷新。
- `media_library.ts`：专辑/歌手媒体库的并发请求、取消、60 秒读取缓存和失效。
- `playback.ts`：当前歌曲、队列、进度、音量、静音、播放模式、质量和 `lx_playback_state`。
- `recent.ts`：只在音频真正触发 `play` 后写入 `play_history`，最多保留 50 首。
- `lyric.ts`、`comments.ts`、`cache.ts`、`sleep.ts`：各自负责领域请求或计时器生命周期。

组件通过领域 selector 读取状态；事件回调只读取稳定 action，音频运行时的高频快照读取属于命令式服务边界。组件不应直接调用 `useLibraryStore.getState()` 或订阅整个 store；列表、收藏和歌单优先复用 `selectLoveList`、`selectUserLists` 等稳定 selector。

## API 请求边界

`frontend/player/src/react/data/request.ts` 是播放器 API 的统一入口，`api.ts` 只负责类型化接口和响应形状转换。请求层统一处理：

- 同源 Cookie、JSON 请求头、204/空响应和安全错误消息。
- `ApiRequestError`（HTTP 状态、端点和响应体）及 `isAbortError`。
- `AbortSignal` 取消；同一 `cacheKey` 的并发读取去重。
- 内存短 TTL 缓存、按 key/前缀失效和强制刷新；失效时同步取消对应的在途请求，避免旧用户响应重新回填缓存；不把会话数据写入持久化存储。

搜索、歌单和媒体库使用明确策略：搜索结果 30 秒、歌单 30 秒、媒体库 60 秒；添加/移除/新建/重命名/删除歌单会失效歌单缓存，登录/退出会清空全部请求缓存。缓存/下载任务使用更短的 5 秒读取窗口，并在写操作后强制刷新。页面级请求可通过 `useRequestResource` 复用相同的 loading、refreshing、error 和取消语义。

## 播放服务事件

`playback_service.ts` 提供类型化的 `play`、`pause`、`progress`、`loaded` 和 `error` 事件总线。`AudioRuntime` 只负责 HTMLAudioElement、预载、音效和 MediaSession 等命令式能力；它发出事件，不直接驱动各个 React 组件。`connectPlaybackServiceStore()` 将事件集中同步到播放 Store，因此音频状态只有一条同步路径，组件仍通过细粒度 selector 订阅。

组件读取 Zustand 时应优先使用 selector，例如 `usePlaybackStore(state => state.currentSong)`，不要在高频播放进度变化时订阅整个 store。长列表使用稳定的行结构、图片懒加载和滚动容器的 `content-visibility` 防止整页重排。

## 播放链路与配额约束

`AudioRuntime` 是唯一的音频命令式桥接层：

1. 当前歌曲真正开始播放前只解析一次播放 URL。
2. 播放成功后才记录历史，并把同一次解析得到的 URL 交给服务器缓存队列，避免再次消耗自定义源次数。
3. 播放进度达到 80% 时只为下一首解析 URL；自动切歌优先复用预载 URL。
4. 音频元素使用 `preload="metadata"`，切换歌曲时暂停、移除旧源并释放资源。

队列移除当前歌曲时会立即交给同一套 `playSong` 链路切换到下一首；队列清空会暂停音频并清除当前歌曲，避免 React 状态与实际 `HTMLAudioElement` 脱节。歌手详情的歌曲列表按 40 首分页，请求取消、重复触发保护和滚动哨兵重置均由详情组件管理。

播放器底部栏和沉浸式歌词页各自拥有一个持续挂载的 `PlayerFooterBar` 宿主，但只有当前可见宿主使用公开的 `player-footer` ID；另一个宿主切换为隐藏 ID 并置于 `inert` 状态，且脱离布局流，避免进入/退出歌词页时卸载、重建、占位或产生重复 ID。`PlayerShell` 使用 `immersiveFooterHost` 做交接：打开时先保留普通栏，原生 `dialog.showModal()` 完成后再切换到歌词栏；关闭时保持歌词栏直到退出动画和 `dialog.close()` 完成，再恢复普通栏。两者复用同一套胶囊结构与尺寸 token，歌词页保留三个点的位置但隐藏菜单，以保证模式、喜欢、队列和音量不位移；评论、下载、睡眠定时器收纳到播放栏上方的小型工具胶囊中。这样可避免播放栏在歌词页进出时闪烁、变形或出现空位。

## 路由与历史

React 继续兼容以下 hash 地址：

`#search`、`#songlist`、`#leaderboard`、`#favorites`、`#localmusic`、`#settings`，以及首页、最近、专辑、歌手和音乐库入口。旧的 `#about` 会按未知地址回退到首页；旧的 `#genres` 仍可被解析以兼容历史链接，但不再出现在侧栏，也不作为新入口。

收藏与自定义歌单使用同一组兼容路由：`#favorites` 固定表示“我喜欢的音乐”；自定义歌单使用 `#favorites?listId=<id>`，历史状态中的 `listId` 也会被恢复。侧栏只展示 `userList`，旧 `defaultList` 仍随歌单数据和快照保存，但不作为用户可见导航项。首页可以提供歌单快捷入口，但不会把自定义歌单嵌入收藏页。

`frontend/player/src/react/route_state.ts` 只负责 hash 解析、路由序列化和 UI 路由意图；`frontend/player/src/react/player_history.ts` 只管理浏览器 History API 的序列号、方向和 payload。`PlayerShell` 把两者连接起来：UI store 发出 route intent，Shell 写入 History；popstate/hashchange 再把 payload 恢复到 UI store。详情状态包含页面、实体类型、来源、ID，并保留名称和封面作为返回时的即时展示数据。组件通过 `setTabFromHistory` 恢复界面，不直接拼接 URL。

## 存储与 API 兼容

迁移没有改变后端接口、同源 Cookie、PWA 路径或旧存储键。以下键继续由 React 服务层读写或迁移：

`lx_settings`、`lx_playback_state`、`lx_volume`、`lx_play_mode`、`lx_user_name`、`lx_download_tasks`、`play_history` 以及歌词和 IndexedDB 缓存。

自定义音源的写操作只在管理后台进行，使用类型化的后台 API 客户端调用；播放器端只调用 `/api/custom-source/list` 读取当前用户可用的公共源与账户专属源。`open` 对应 `users/source/_open` 公共目录，用户名对应账户专属目录；管理员转移音源时由服务端加锁、检查 ID 冲突、迁移脚本和元数据并重新加载运行时 API。历史 `states.json` 文件保留，但不再允许播放器用户覆盖公共源的全局启用状态。缓存/下载、歌词翻译与罗马音、歌单切换加入/移除、管理员存储统计均通过既有 API 客户端调用。歌曲实体和缓存索引统一使用 `albumName`；音频标签的 `album`、第三方 SDK 的原始 `album` 对象不属于用户歌曲快照字段，只在边界解析处保留。新 UI 不应新增第二套播放、缓存或认证协议。

## 自定义音源管理边界

`frontend/admin/src/react/custom-sources-view.tsx` 是唯一的音源管理页面。页面按作用域加载列表，作用域切换会取消旧请求并以新作用域作为缓存/请求边界；上传、远程导入、启用/停用、删除、排序和归属转移成功后重新加载当前作用域，过期请求结果不会回填界面。所有写接口（包括脚本校验）都要求管理员会话，未授权请求在远程下载或文件写入前返回 `403`。

播放器设置页不再出现音源管理表单。播放器仍会通过读取接口获得公共音源和当前账户专属音源，并把“没有可用音源”的错误提示指向管理员配置；播放器不会改变音源状态、排序或归属。

## 管理后台迁移边界

管理后台的 React 页面不是旧模板的静态外壳，而是对旧管理能力的语义化重组：

- `frontend/admin/src/react/data-view.tsx` 负责用户数据查看。接口返回的 `defaultList`、`loveList`、`userList` 会先经过 `normalizeAdminData`，歌曲展示字段统一读取顶层 `id`、`name`、`singer`、`albumName`、`img` 和 `interval`；`meta` 只保留播放协议仍需要的标识与音源信息，不再读取或写回顶层旧 `album` 字段。当前测试数据已清空，不再提供旧快照字段迁移。自定义歌单保留重命名、删除、单曲删除和批量删除；系统列表保留单曲移除。
- `frontend/admin/src/react/storage-view.tsx` 负责缓存与下载音乐，保留搜索、排序、试听、移动、批量删除、批量移动和清空缓存。试听使用元数据预加载，不把文件读入 React 状态；移动仍调用原 `/api/music/cache/move` 接口。
- `frontend/admin/src/react/config-view.tsx` 覆盖旧配置页的基础路径、歌单加入位置、代理、用户访问限制、缓存上限、音源优先级、管理员密码和播放器认证字段。密码只提交用户主动填写的新值，服务端返回的 `*passwordConfigured` 只用于提示，不回显密文。
- 日志类型由后台 store 的 `logType` 管理，应用、访问、登录和错误日志复用同一张安全文本表；用户、快照、备份、重启和仪表盘存储统计继续走原有接口。

后台列表采用“侧边列表导航 + 右侧密集表格”的结构。歌曲实体显示会优先使用归一化后的封面、歌手、专辑、ID、时长和格式；没有封面时使用本地云音占位图。数据查看的表格使用固定列比例、`min-width: 0`、稳定行高、`content-visibility` 和 `scrollbar-gutter`，在可用宽度内压缩显示，不制造页面级横向滚动；窄屏隐藏重复的来源/文件元数据列，保留歌曲、专辑、时长和操作。后台所有滚动容器复用播放器的 6px 半透明圆角滚动条，侧栏仍保持可滚动但不显示滚动条。按钮统一为紧凑语义按钮，避免旧模板的巨大按钮和低对比度文字覆盖 React 组件。

快照管理和自定义源管理使用统一的主题文件选择器：原生文件控件只作为隐藏输入保留，用户可点击带图标、圆角、截断文件名的项目内控件选择文件；工具栏在宽屏使用稳定网格对齐，窄屏按操作组折行。

歌曲列表页面统一复用密集列表组件：歌曲封面、歌曲/歌手、专辑、收藏、时长、大小、格式和行操作保持稳定列结构；收藏动作始终针对 `loveList`，自定义歌单的移除动作位于行操作和批量操作中。在线搜索的歌手、专辑和歌单卡片/详情页也复用同一收藏状态；实体缺少 ID 时回退到名称搜索。新建歌单完成后，普通创建流程会进入新歌单页；从“添加到歌单”流程创建时会保留待添加歌曲。

缓存统计接口当前返回 `cache` / `music` 两个分组，分别包含 `fileCount` 和 `totalSize`；播放器缓存抽屉与后台仪表盘都按分组读取，同时兼容旧版扁平字段。歌曲下载链接必须挂载到 `document.body` 后触发，避免浏览器忽略脱离文档的锚点点击。

## 可访问性与弹层约定

- 可操作元素使用 `button`、`a`、`form`、`dialog` 等原生语义元素。
- 对话框使用原生 `dialog.showModal()`，打开时保存焦点，关闭后恢复焦点；Escape 和点击外部关闭必须清理临时状态。
- 歌曲更多菜单使用 Portal 渲染到 `document.body`，固定定位并限制在视口内，避免被底部栏裁切。
- 搜索、排行榜、歌单广场、音乐库和设置中的筛选项使用 React 语义下拉控件，支持键盘方向键、Home/End、Enter/Space、Escape 和焦点恢复，不依赖浏览器原生下拉外观。
- 底部播放栏不再挂载频谱/可视化节点；`showFooterVisualizer` 等旧设置键只作为读取兼容保留，不影响新的页面布局。
- 普通底部栏和歌词页底部栏始终保持挂载，通过活动宿主 ID、`aria-hidden` 和 `inert` 切换可见性；两者使用相同的封面尺寸、进度条、透明毛玻璃和响应式间距，避免进入歌词页时发生尺寸跳变或闪烁。交接期间不可见 footer 使用零尺寸绝对定位，不影响主内容高度。歌词页关闭时优先恢复打开它的封面按钮，找不到原节点时回退到主内容区域。通用 `dialog` 统一使用视口边界、`border-box` 和横向裁剪，避免登录、歌单和评论弹窗出现水平滚动条。
- 顶栏只保留左右两个悬浮胶囊，顶栏本身不再绘制全宽背景层或占用独立内容遮盖区；主内容保留安全上边距，确保胶囊不会遮挡页面标题。
- 首页“最近播放”是固定单行横向轨道：桌面端展示稳定卡片宽度，窄屏允许横向滚动，不允许换行撑高页面。
- 所有图片提供稳定尺寸、懒加载和错误占位；动画遵守 `prefers-reduced-motion`。
- 歌单广场与歌单详情共用 `songImage` 的多形状封面解析：优先读取列表项或详情 `info` 中的封面，详情路由再使用历史状态里的封面作为回退，避免进入详情后退回系统图标。
- 详情页使用 `ViewFrame` 的 `hideHeader` 将实体名称只保留在封面信息区，避免通用页面标题与详情标题重复；歌手、专辑和歌单详情遵循同一约定。
- React 页面使用轻量的进入、面板和首屏网格动效，只动画 `opacity`/`transform` 等合成属性；密集歌曲列表保持稳定，`prefers-reduced-motion` 下完全关闭这些动效。
- 错误和加载状态使用明确的页面区域或有限的 live region，不用高频进度更新污染辅助技术播报。
- 通用 `Button` 默认使用 `type="button"`，所有表单提交按钮显式声明 `type="submit"`，避免迁移后误提交。

## 验证命令

提交前运行完整检查：

```bash
bun run tsc --noEmit
bun run build:frontend
bun run check:frontend-assets
bun test
```

浏览器验收至少覆盖桌面和 `390×844` 移动视口：登录、搜索、播放/暂停、队列、歌词、歌手详情分页、歌单、排行榜、音乐库、自定义源、主题切换、普通底部栏菜单和管理后台核心页面。检查控制台没有新增异常，并确认 Escape 关闭和焦点恢复行为。
