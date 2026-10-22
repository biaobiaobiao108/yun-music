# 项目开发约定

本项目使用 Bun、TypeScript、`bun:sqlite`，前端使用 React、Zustand 和 Bun Bundler。优先沿用现有模块与依赖，避免为了抽象而增加层次。

## 目录边界

- `src/server/core/`：HTTP 路由与上下文；业务路由位于 `src/server/routes/`，服务实现位于 `src/server/`。
- `src/database/`：SQLite 结构化数据访问；`src/modules/snapshotStorage.ts`：歌单与黑名单快照。
- `frontend/`：前端源码；`public/`：构建产物，禁止手动修改。
- 前端状态、请求和播放边界详见 [`docs/frontend-react.md`](docs/frontend-react.md)。部署与实例限制详见 [`README.md`](README.md)。

## 修改与验证

- JavaScript/TypeScript 的安装、运行和检查使用 Bun；不要使用 npm、yarn、pnpm 或 Node.js。
- 代码修改后运行 `bun check`。修改核心逻辑或修复缺陷后运行 `bun test --check`；测试范围应与改动相符。
- 修改 `frontend/` 或 `frontend/styles/` 后运行 `bun run build:frontend`；改动发布资源引用时再运行 `bun run check:frontend-assets`。
- 新功能或缺陷修复验证通过后提交，使用语义化前缀和中文说明，例如 `fix: 修复缓存路径校验`。
- 不要为未提出的需求扩展范围，也不要新增未经评估的重型依赖。

## 关键实现约束

- HTTP 使用项目自有 `Router` / `HttpContext` 和 Web 标准 `Request`、`Response`；CORS 由全局中间件处理。
- 账户、会话、配置、快照和缓存索引等结构化数据通过 SQLite 管理；媒体、封面和歌词文件保存在文件系统。快照读写遵循 `snapshotStorage` 的单条、数量和总量限制。
- 缓存可能位于应用根目录和 `DATA_PATH` 两处。统计、清理、账号删除或改名需同步处理两处文件及索引；用户主动下载到 `music/` 的文件不受缓存 LRU 清理。
- 服务端写回配置前先比较内容；无变化时不要写盘，以免触发 `bun --watch` 重启循环。
- 对静态文件和媒体路径做基准目录边界校验；鉴权不得接受空密码；日志和响应不得泄露密码、令牌或密钥。
- 自定义音源脚本按可信代码处理：当前 VM 不是安全沙箱。部署与信任边界变化时重新评估；生产容器应以非 root 用户运行。
- 部署按单进程、单实例设计；不要让多个实例共用数据、缓存或音乐目录。详见 README 的部署说明。

## 播放与缓存约束

- 播放触发的后台缓存统一进入 `serverDownloadQueue`，按用户、歌曲和音质去重；远程签名 URL 不写入持久化队列。
- 上游缓冲、媒体中继和下载遵循共享 `resourceBudget`。音频流式写盘；标签等重型原生处理使用共享并发限制，并在成功、失败和取消时释放资源。
- 静默预读只解析播放 URL，不启动服务端缓存；实际播放成功后再缓存。隐藏音频预加载器使用 `preload="metadata"`。
- 处理第三方歌曲 ID 时先转成字符串。歌曲实体使用 `albumName`；`songmid`、`songId`、`albumId` 等协议字段按现有约定保留。组装歌词优先使用 `buildLyrics(result)`。

## 前端约束

- 修改源码而非 `public/` 产物。播放器和管理后台沿用共享主题 token、语义控件与现有请求/状态边界；动效支持 `prefers-reduced-motion`。
- 首要适配目标为最新正式版 macOS Safari；优先使用标准 Web API，使用新浏览器能力时提供特性检测和可用回退。
