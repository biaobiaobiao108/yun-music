# AGENTS.md

本文档为 AI Agent 及开发者在维护和开发本项目时的核心工程指南，包含项目当前架构概览、设计规范、工具链命令及关键注意事项。

---

## 1. 项目概览与架构

本项目为 **云音 Web 播放器与管理后台服务端**。后端全面基于 **全栈 Bun (1.1+) + TypeScript 7.0+** 原生架构，彻底移除了遗留的 Express 依赖，前端使用 **原生 Bun Bundler** 毫秒级打包，专注于 **Docker (Alpine)** 云端与私有化容器部署。

### 核心架构层级
- **后端服务 (`src/`)**：
  - **网络与核心运行时 (`src/server/core/`)**：
    - 完全基于原生 **`Bun.serve`** 与 Web 标准 Request/Response 抽象。
    - 自研轻量级高性能洋葱模型路由器 (`Router`) 与上下文 (`HttpContext`)，无任何外部 Node.js Web 框架开销。
  - **Web 播放与数据服务 (`src/server/services/`)**：
    - 负责搜索、播放、歌词、缓存、快照和自定义音源等浏览器业务能力；服务端不再承载旧客户端同步协议。
  - **结构化持久化存储 (`src/database/`)**：
    - 全面采用 **`bun:sqlite`** 原生数据库引擎，开启 WAL 模式与外键约束。
    - 结构化管理账户（`users`）、会话（`user_sessions`/`player_sessions`）、列表/黑名单快照（`snapshots`）、用户级设置（`user_settings`）及缓存索引（`cache_index`）。
  - **业务领域路由模块 (`src/server/routes/`)**：
    - 采用领域驱动划分：`auth`（鉴权与 Session）、`system`（系统信息与配置）、`user`（用户增删改查）、`customSource`（自定义音源管理）、`elfinder`（文件管理器后端）、`music`（聚合搜索、音源解析、歌词服务）、`cache`（歌曲下载、音质转码与 USLT 歌词内嵌）、`static`（前端与 SPA 兜底静态资源分发）。
  - **服务组装入口 (`src/server/server.ts` & `src/server/routes/index.ts`)**：
    - 精简至 70 余行的纯组装器，职责单一，纯净解耦。
- **前端工程 (`frontend/`)**：
  - 源码与发布产物严格分离，采用 **React + TypeScript + Zustand** 和 **原生 Bun Bundler (`scripts/build-frontend.ts`)** 构建：
    - `frontend/admin/src/react/index.tsx` ➡️ 输出至 `public/app-<hash>.js`（管理后台）
    - `frontend/player/src/react/index.tsx` ➡️ 输出至 `public/music/app-<hash>.js`（Web 网页播放器）
    - `frontend/player/src/react/login.tsx` ➡️ 输出至 `public/music/login-<hash>.js`（播放器登录页）
  - `frontend/styles/` 保存主题与播放器样式源文件；`public/` 只保存构建产物。旧版命令式业务模块不再作为页面入口，只保留被音频工作线程或兼容服务明确引用的底层模块。
  - 构建耗时仅数十毫秒，开箱即用代码混淆与压缩。
- **Docker 容器化 (`Dockerfile`)**：
  - 基于 `oven/bun:1-alpine` 的多阶段极简构建（`builder` ➡️ `prod-deps` ➡️ `runner`）。
  - 内置原生音频库 `chromaprint` 与 `gcompat`，生产镜像彻底剔除源码、TS 编译器及开发依赖，专攻极致的小体积与秒级启动。

### 核心目录指引
```text
yun-music/
├── src/                    # 服务端核心 TypeScript 源码
│   ├── server/             # HTTP 服务、路由、中间件与业务服务
│   │   ├── core/           # Bun.serve 原生路由引擎、HttpContext、洋葱模型中间件
│   │   ├── routes/         # 拆分的各领域业务路由 (auth, music, cache 等)
│   │   ├── services/       # 音乐子系统服务、歌词钩子注入、解析服务
│   │   └── server.ts       # 原生 Bun.serve 极简服务启动与组装入口 (≤80行)
│   ├── database/           # 基于 bun:sqlite 的持久化数据库层 (WAL 模式)
│   ├── modules/            # 核心业务模块、缓存、音源 SDK、Store
│   ├── common/             # 通用主题、工具函数、常量定义
│   └── index.ts            # 服务端 CLI 与参数解析主入口
├── frontend/               # 前端工程源码（禁止直接手动修改 public/ 编译产物）
│   ├── admin/src/          # 管理后台前端源码
│   └── player/src/         # Web 网页播放器前端源码
├── public/                 # 前端发布产物与静态资源托管目录
├── scripts/                # 构建与维护脚本 (build-frontend.ts, update-build-hash.js 等)
├── tests/                  # 基于 bun:test 的全栈自动化测试套件
├── config.js               # 服务端运行时配置文件 (用户可挂载/覆写)
├── Dockerfile              # 生产级 Alpine + Bun 多阶段镜像配置
├── tsconfig.json           # 全局 TypeScript 编译器配置 (TS 7.0+)
└── package.json            # 项目元信息、纯净依赖与 bun scripts
```

---

## 2. 核心原则与开发规范

### 核心原则
- **信息足够后立即行动**：需求明确后直接实施，不做无意义的重复调研。
- **不确定时明确说明**：基于实际代码和事实说话，不编造、不臆测。
- **直面判断**：发现逻辑矛盾、隐式类型缺陷或潜在安全风险时直接指出并纠正。
- **最小改动与复用原则**：遵循现有代码风格和设计模式，优先复用现有函数与类型；严禁引入未通过评估的第三方重型依赖。

### Git 规范（强制要求）
- **每次实现一个新功能或者修复一个 bug 并验证通过后，必须执行一次 `git commit`**。
- 提交信息必须规范清晰，遵循语义化格式（如 `feat:`, `fix:`, `refactor:`, `test:`, `docs:` 等），并且用中文。

### 工具链规范
- **全栈纯 Bun**：本项目为纯 Bun 工程，**严禁**使用 `npm`, `yarn`, `pnpm` 或 `node` 执行安装与启动。
- **前端编译同步**：若修改了 `frontend/` 中的代码，**必须**运行 `bun run build:frontend` 同步编译生成 `public/` 静态产物。
- **静态类型安全**：全栈推进严格 TypeScript。每次代码改动后，需执行 `bun run tsc --noEmit` 确保 0 错误。
- **自动化测试验证**：改动核心逻辑或修复问题后，需运行 `bun test` 确保所有用例通过。

---

## 3. 注意事项与避坑指南

### 1. 原生 `Bun.serve` 与 Web 标准 API
- 项目已彻底告别 Express，请求上下文全部使用 Web 标准 `Request`、`Response` 及自研 `HttpContext`。
- 新增路由或中间件时，返回类型统一为 Web 标准 `Response`（例如 `ctx.json()`, `ctx.text()`, `ctx.html()` 或直接 `new Response()`）。
- 跨域预检（OPTIONS）统一由全局 `corsMiddleware` 拦截处理，无需在子路由中重复编写。

### 2. 数据库与存储安全 (`bun:sqlite`)
- 所有结构化数据（用户账户、会话、歌单快照、配置信息）必须通过 `src/database/` 中的 SQLite 接口读写，严禁绕过外键约束或直接操作无保护的 JSON 文件。
- 音频媒体文件、封面与歌词等大文件继续保留在文件系统/缓存目录中。
- 歌单与黑名单快照统一通过 `src/modules/snapshotStorage.ts` 管理；单条数据最大 20 MiB，每个用户/模块最多保留配置数量，同时受 100 条和 50 MiB 总量硬上限约束。新增写入、导入和读取历史列表都必须保持这套清理策略。
- SQLite 删除记录后主文件不会自动缩小，这是 SQLite 空闲页复用机制的正常表现。需要回收磁盘空间时使用管理员接口 `GET /api/admin/database/stats` 检查 `freelistCount`/`freeBytes`，再按需调用 `POST /api/admin/database/vacuum`；不要在普通写请求后自动执行 VACUUM。
- `cache/`、`music/`、`cover_cache/` 可能同时存在于应用根目录和 `DATA_PATH` 下。缓存统计、清理、账号删除和账号改名必须覆盖两套位置，并同步维护 `cache_index`；`music/` 是用户明确下载的媒体，不应被缓存 LRU 限制误删。

### 3. 避免 `bun --watch` 触发死循环闪烁
- `bun run dev` 底层使用 `bun --watch`，会自动监听入口及动态加载的文件。
- **禁忌**：严禁在服务端启动时无条件覆写被引用的运行时文件（如 `config.js`），否则会诱发“启动 -> 改写依赖文件 -> 触发 watch 重启 -> 再次启动”的死循环。
- **处理方式**：写回配置的操作（如 `saveConfigToFile`）必须先比对内存内容与磁盘内容（哈希/字符串比对），内容未变时严禁写盘。

### 4. 安全红线
- **目录穿越防护**：静态文件伺服与媒体缓存处理必须对路径做严格边界检查（如基于 `isPathInside` 比对基准目录），彻底杜绝 `../` 越界攻击。
- **鉴权安全**：管理后台接口鉴权必须强制校验密码存在且非空，禁止空密码或未配置密码的等值绕过。
- **数据脱敏**：严禁在控制台日志与网络响应中明文输出用户密码、Token 密钥等敏感信息。

### 5. 歌词与多音源数据类型防坑
- 外部音源（如网易云 `wy`）可能返回数值类型的歌曲 ID，处理 `songInfo.id`、`songmid` 前必须显式转换为字符串（`String(...)`），防止直接调用 `.startsWith()` 抛出类型异常。
- 组装与嵌入歌词时，优先使用 `buildLyrics(result)` 保留翻译歌词、罗马音及逐字（`awlrc`）完整数据。

### 6. 前端动效规范
- 动效目标是简洁、克制、服务于层级和反馈；禁止为装饰堆叠动画、弹跳、长距离位移、视差或持续闪烁。
- 优先复用 `--app-motion-fast`（约 140ms）和 `--app-motion`（约 220ms）；页面/面板进入动画控制在 260–320ms 内，使用平滑缓动。
- 进入、退出和列表出现只动画 `opacity` 与 `transform`；避免动画 `width`、`height`、`top`、`left`、`margin` 等布局属性。交互颜色、边框和阴影可做短过渡，禁止使用 `transition: all`。
- 悬停/聚焦反馈保持轻微：位移不超过 3px，缩放不超过 1%；歌曲密集列表不逐行播放入场动画，只允许首屏卡片或面板做有限错峰。
- 必须实现 `@media (prefers-reduced-motion: reduce)`：关闭关键帧、位移和非必要过渡，不影响操作、焦点恢复、弹层关闭或播放控制。
- 动效不能阻塞输入和内容加载；使用 View Transitions 或其他新能力时必须特性检测，并提供无动画降级路径。

### 7. 前端 UI 规范
- 播放器与管理后台共用主题变量、字体层级、间距、圆角和边框；深色/浅色/system 与强调色必须通过现有 token 控制，禁止在组件内散落硬编码颜色。
- **Safari 优先适配**：以最新正式版 macOS Safari 为首要浏览器目标；优先使用标准 Web API/CSS。
- 页面保持清晰层级：侧栏负责导航，主内容负责滚动，底部播放器只占内容区；避免重复标题、空白占位、方框残留和过度阴影。密集歌曲列表优先使用语义表格/列表、稳定列宽、懒加载封面和明确的加载/错误/空状态。
- 交互优先使用 `button`、`a`、`form`、`dialog` 等语义元素；下拉菜单使用项目内 Select/Popover，不使用浏览器原生菜单或可点击 `div`。控件高度、触摸区域和移动端安全区保持一致。
- 鼠标点击聚焦不显示外部高亮框或光晕；键盘聚焦保留 1px 内嵌强调色提示，不使用 `outline-offset` 外扩描边或 `0 0 0` 外圈阴影。必须兼容 `:focus-visible`、强制颜色模式和 `prefers-reduced-motion`。
- 所有弹层支持 Escape、点击外部关闭、焦点恢复和必要的 `inert`；禁止用动画布局属性制造跳动。动画仅服务于进入、退出、悬停和状态反馈，并遵守本节与动效规范。
- React 播放器歌曲实体使用规范字段 `albumName`；`songmid`、`songId`、`albumId` 等音源/播放协议字段不得擅自删除或改名。发布资源由构建脚本生成，禁止手改 `public/`。

---

## 已接受的部署边界风险

- **自定义音源脚本沙箱**：项目仅使用可信自定义音源，生产环境以容器部署；接受 `src/server/userApi.ts` 中 VM 脚本可取得宿主能力的风险，不为此引入额外进程/容器沙箱复杂度。若音源信任模型或部署隔离边界改变，必须重新评估。

## 4. 播放器与服务端缓存内存规范

- **统一下载入口**：播放触发的后台缓存必须进入 `serverDownloadQueue`，禁止绕过队列直接下载；后台缓存全局最多并发 1 个，明确下载继续遵循用户配置的并发数，且明确下载优先。
- **任务去重与持久化**：按“用户 + 歌曲 + 音质”去重，覆盖等待、执行和已完成状态；远程签名 URL 只作为短期运行时数据，禁止写入持久化队列文件。
- **流式处理大文件**：音频必须流式写盘，禁止将整首音频读入 JavaScript 内存；标签、封面和歌词等原生重型处理统一使用共享信号量，默认最多并发 1 个。
- **及时释放资源**：处理完成后尽早释放封面等大 `Buffer` 引用；所有成功、异常和取消路径都必须释放信号量、清理任务状态。
- **控制播放器预加载**：静默预读只解析播放 URL，不触发服务器缓存；实际播放成功后才触发缓存；隐藏 `Audio` 预加载器使用 `metadata`，禁止使用 `auto` 预缓冲整曲。
- **内存观测与判断**：缓存任务开始、结束记录低频 RSS/并发日志；RSS 超过约 256 MiB 且距离上次完整 GC 超过 30 秒时才条件调用 `Bun.gc(true)`。排查容器内存时同时查看 `anon` 与 `file`，其中 `file` 多为可回收页缓存，不能直接判定为内存泄漏。
- **缓存生命周期**：清空缓存时同时清理音频、歌词、封面和 SQLite 索引；删除用户时清理该用户的可再生缓存，保留用户数据目录的行为仍由删除接口的 `deleteData` 参数控制；重命名用户时必须可回滚地迁移两套物理缓存目录。

---

## 5. 常用开发与构建命令

| 操作 | 命令 | 说明 |
| :--- | :--- | :--- |
| **安装依赖** | `bun install` | 安装项目依赖并更新 `bun.lock` |
| **静态类型检查** | `bun run tsc --noEmit` | 验证全项目 TypeScript 类型正确性（0 错误要求） |
| **自动化单元测试** | `bun test` | 运行基于 `bun:test` 的自动化测试套件 |
| **前端开发监听重载** | `bun run dev:frontend` | 监听前端源码改动并极速增量重编 |
| **前端编译打包** | `bun run build:frontend` | 使用 Bun 原生 Bundler 编译前端至 `public/` |
| **服务端开发热重载** | `bun run dev` | 基于 `bun --watch` 启动开发服务，支持文件热重载 |
| **服务端源码启动** | `bun start` | 直接以源码模式启动服务端入口 |
| **服务端独立构建** | `bun run build` | 将服务端核心打包为单文件 `./server/index.js` |
| **代码提交** | `git commit -m "<type>: <message>"` | 每次代码改动并通过测试后必须执行提交 |
