# 云音 React 前端架构说明

本文档记录前端全面迁移后的工程边界，帮助维护者区分源码、发布产物和仍然保留的浏览器底层能力。

## 入口与构建

前端继续使用 Bun Bundler，不切换 Vite：

- `frontend/player/src/react/index.tsx`：播放器主入口。
- `frontend/player/src/react/login.tsx`：播放器访问密码登录入口。
- `frontend/admin/src/react/index.tsx`：管理后台入口。
- `frontend/styles/`：设计令牌、共享主题、播放器和后台样式源文件。
- `scripts/build-frontend.ts`：构建 hash 入口、代码分割 chunk、Service Worker 引用和发布 HTML。

修改 `frontend/` 或 `frontend/styles/` 后必须运行：

```bash
bun run build:frontend
bun run check:frontend-assets
```

不要直接编辑 `public/` 下的 hash JavaScript、CSS 或 HTML 编译产物。

## 状态边界

播放器状态按领域拆分在 `frontend/player/src/react/store.ts`：

- 认证、设置、歌单和媒体库：负责登录状态、`lx_settings` 兼容、歌单及专辑/歌手库。
- 播放与队列：负责当前歌曲、进度、音量、静音、播放模式、质量和 `lx_playback_state`。
- 最近播放：只在音频真正触发 `play` 后写入 `play_history`，最多保留 50 首。
- 歌词、评论、缓存和睡眠定时器：各自负责请求取消、任务状态和生命周期。
- UI：负责 hash 路由、详情、抽屉、对话框、沉浸式歌词和通知；业务动作不再挂到 `window`。

组件读取 Zustand 时应优先使用 selector，例如 `usePlaybackStore(state => state.currentSong)`，不要在高频播放进度变化时订阅整个 store。长列表使用稳定的行结构、图片懒加载和滚动容器的 `content-visibility` 防止整页重排。

## 播放链路与配额约束

`AudioRuntime` 是唯一的音频命令式桥接层：

1. 当前歌曲真正开始播放前只解析一次播放 URL。
2. 播放成功后才记录历史，并把同一次解析得到的 URL 交给服务器缓存队列，避免再次消耗自定义源次数。
3. 播放进度达到 80% 时只为下一首解析 URL；自动切歌优先复用预载 URL。
4. 音频元素使用 `preload="metadata"`，切换歌曲时暂停、移除旧源并释放资源。

队列移除当前歌曲时会立即交给同一套 `playSong` 链路切换到下一首；队列清空会暂停音频并清除当前歌曲，避免 React 状态与实际 `HTMLAudioElement` 脱节。歌手详情的歌曲列表按 40 首分页，请求取消、重复触发保护和滚动哨兵重置均由详情组件管理。

播放器底部栏和沉浸式歌词页是两个独立的 React 组件。普通底部栏负责歌曲菜单、播放控制和抽屉入口；歌词页使用独立 footer，不复用普通胶囊栏的布局，也不保留黑胶唱片或关闭后的占位节点。

## 路由与历史

React 继续兼容以下 hash 地址：

`#search`、`#songlist`、`#leaderboard`、`#favorites`、`#localmusic`、`#settings`、`#about`，以及首页、最近、专辑、歌手、风格和音乐库入口。

收藏与自定义歌单使用同一组兼容路由：`#favorites` 固定表示“我喜欢的音乐”；自定义歌单使用 `#favorites?listId=<id>`，历史状态中的 `listId` 也会被恢复。侧栏只展示 `userList`，旧 `defaultList` 仍随歌单数据和快照保存，但不作为用户可见导航项。首页可以提供歌单快捷入口，但不会把自定义歌单嵌入收藏页。

`frontend/player/src/features/player_history.ts` 只管理浏览器 History API 的序列化状态；详情状态包含页面、实体类型、来源、ID，并保留名称和封面作为返回时的即时展示数据。组件通过 `setTabFromHistory` 恢复界面，不直接拼接 HTML。

## 存储与 API 兼容

迁移没有改变后端接口、同源 Cookie、PWA 路径或旧存储键。以下键继续由 React 服务层读写或迁移：

`lx_settings`、`lx_playback_state`、`lx_volume`、`lx_play_mode`、`lx_user_name`、`lx_download_tasks`、`play_history` 以及歌词和 IndexedDB 缓存。

自定义音源、缓存/下载、歌词翻译与罗马音、歌单切换加入/移除、管理员存储统计均通过既有 API 客户端调用。新 UI 不应新增第二套播放、缓存或认证协议。

歌曲列表页面统一复用密集列表组件：歌曲封面、歌曲/歌手、专辑、收藏、时长、大小、格式和行操作保持稳定列结构；收藏动作始终针对 `loveList`，自定义歌单的移除动作位于行操作和批量操作中。新建歌单完成后，普通创建流程会进入新歌单页；从“添加到歌单”流程创建时会保留待添加歌曲。

缓存统计接口当前返回 `cache` / `music` 两个分组，分别包含 `fileCount` 和 `totalSize`；播放器缓存抽屉与后台仪表盘都按分组读取，同时兼容旧版扁平字段。歌曲下载链接必须挂载到 `document.body` 后触发，避免浏览器忽略脱离文档的锚点点击。

## 可访问性与弹层约定

- 可操作元素使用 `button`、`a`、`form`、`dialog` 等原生语义元素。
- 对话框使用原生 `dialog.showModal()`，打开时保存焦点，关闭后恢复焦点；Escape 和点击外部关闭必须清理临时状态。
- 歌曲更多菜单使用 Portal 渲染到 `document.body`，固定定位并限制在视口内，避免被底部栏裁切。
- 普通底部栏隐藏后不参与歌词页布局；歌词页关闭时优先恢复打开它的封面按钮，找不到原节点时回退到主内容区域。
- 所有图片提供稳定尺寸、懒加载和错误占位；动画遵守 `prefers-reduced-motion`。
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
