# 云音（云鹿音乐）代码审查报告

| 项目 | 内容 |
| :--- | :--- |
| 审查日期 | 2026-10-18 |
| 代码版本 | `6d99b22`（style: 规范化前端动效与主题色彩…），审查后工作区仅新增本文件 |
| 代码规模 | 后端 `src/` 24,062 行 · 前端 `frontend/` 8,204 行 · 测试 `tests/` 8,490 行 |
| 审查方式 | 静态通读 + `bun check` + 全量测试 + 隔离环境端到端冒烟 + 针对性攻击验证 + 关键指控实证复现 |

> **历史报告，已被后续代码变更部分取代。** 本文结论针对 `6d99b22`，不代表当前版本。正文中的两项 P0 已在后续代码中修复：用户删除流程现在由 `purgeDataFor` 控制是否删除歌单与设置；快照导入使用独立的 `stored_at` 排序并保护本次写入的快照。其他发现也需对照当前代码重新验证，不能直接当作当前缺陷清单。

---

## 一、总体结论

工程底子很扎实——安全边界（鉴权、路径穿越、SSRF、会话、备份防投毒）写得比绝大多数自建音乐服务都严谨，冒烟测试里所有攻击尝试都没打进去。

但**数据层有两个 P0**，都是"静默丢数据"这一类：用户看到的提示与系统实际行为相反，且都不会报错。

评级：**B（可用，但需先修 P0）**。

| # | 级别 | 问题 | 后果 |
| :- | :-- | :--- | :--- |
| 1 | **P0** | 删除用户时，未勾选"同时删除用户数据"仍会清空歌单/收藏/设置 | 管理员以为保留，实际全丢，且不可恢复 |
| 2 | **P0** | 导入时间戳较旧的历史快照，会被自己的裁剪逻辑立即删除并返回成功 | 用户以为导入成功，刷新后快照消失 |
| 3 | P1 | 自定义音源 VM 沙箱可一行代码逃逸 + 容器 `USER root` | 第三方音源脚本 = 宿主 root 执行 |
| 4 | P1 | `bun test` 写入真实 `data/yun-yin.db` | 测试污染开发库，存在误清风险 |
| 5 | P1 | 备份上传在内存中同时持有 3 份完整副本 | 256MiB 容器上传大备份时 OOM |
| 6 | P1 | 32MiB 以内的文本响应走 `gzipSync` 同步压缩 | 大 JSON 导出期间事件循环被阻塞 |
| 7 | P1 | 原子写临时文件无孤儿清理 | 进程被强杀后 `.tmp` 永久残留 |
| 8 | P1 | `formatDuration` 对 >1000 秒的时长按毫秒处理 | 16:41~49:59 的音频显示成 `00:01`~`00:02` |
| 9 | P1 | `/api/music/download` 默认匿名可用且不限制目标 host | 公开部署变成开放代理，带宽/磁盘被白用 |
| 10–16 | P2 | 见第五节 | 加固与可维护性 |

---

## 二、验证基线（可复现）

| 检查项 | 方式 | 结果 |
| :--- | :--- | :--- |
| 静态类型 | `bun check` | ✅ 0 错误（156 文件 / 1119ms） |
| 自动化测试 | `bun test` | ✅ 348 pass / 0 fail / 1895 断言 / 无 skip |
| 前端产物同步 | 比对 `public/*.html` 与磁盘 hash 文件名 | ✅ `app-n6k1r7tf.js`、`app-c63kzwdc.js`、`login-py6vgjwy.js` 引用一致 |
| 前后端契约 | 抽取前端 70 个 API 路径 vs 后端注册 | ✅ 70/70 均有对应路由 |
| 服务启动 | 隔离 `DATA_PATH`/`CONFIG_PATH` + env 密码 | ✅ 启动正常，`/healthz`、`/readyz` 200 |
| 未授权访问 | 未登录请求 `/api/config`、`/api/stats` | ✅ 均 401 |
| 路径穿越 | `../`、`%2e%2e`、`%2f` 编码三种变体 | ✅ 404 / 403，无一得手 |
| 跨站请求 | `Origin: https://evil.com`（含 OPTIONS 预检） | ✅ 403 |
| SSRF | `/api/music/url` 注入 `127.0.0.1`、`169.254.169.254` | ✅ 均被拒，文案不泄露内部细节 |
| 配置脱敏 | 登录后读 `/api/config` | ✅ 仅 `passwordConfigured: true/false`，无 hash |
| 安全响应头 | `curl -D -` | ✅ CSP（`script-src 'self'`）、`X-Frame-Options: DENY`、`nosniff` 齐全 |

---

## 三、P0：静默丢数据

### P0-1 · 未勾选"同时删除用户数据"，歌单与设置仍被清空

**位置**：`src/server/routes/user.ts:305-341`（删除流程）、`src/server/routes/user.ts:63` + `src/user/data.ts:88-96`（落库）

删除用户的路径是：

```ts
global.lx.config.users.splice(idx, 1)   // user.ts:318
saveUsers()                             // user.ts:322 → syncUsersToDatabase(users, { removeMissing: true })
...
if (body.deleteData && user.dataPath && fs.existsSync(user.dataPath)) {   // user.ts:335
  fs.rmSync(user.dataPath, { recursive: true, force: true })
}
```

`deleteData` 唯一的作用是**删不删物理目录**。而 `syncUsersToDatabase({ removeMissing: true })` 在事务里把该用户的 `snapshots`、`snapshot_meta`、`user_settings`、`user_sessions`、`cache_index`、`users` 行**全部 DELETE**（`data.ts:88-96`）。

前端文案（`frontend/admin/src/react/views.tsx:87`）：

```ts
message: `确定删除 ${names.length} 个用户吗？${deleteData ? '同时删除用户数据。' : ''}`
```

未勾选时这句话整个不出现——管理员读到的语义是"只删账号，数据留着"。

**实测**（内存库，直接调用生产代码）：

```
B1 删除前 bob 快照数: 1 | 设置数: 1
B2 未勾选"删除用户数据"后 bob 快照数: 0 | 设置数: 0 | users 行: 0
```

**额外风险（同一条链）**：`saveUsers()` 在任何用户增删改时都会带 `removeMissing: true`。这意味着如果管理员只是从 `config.js` 手工移除某个用户条目（比如临时停用），该用户的数据此刻还在；但**下一次任何用户变更操作都会把它们静默清空**。这个副作用目前没有任何提示。

**修复建议**（三选一，推荐第 1 条）：

1. **澄清语义**（改动最小）：把参数改名为 `deleteFiles`，UI 文案改为「同时删除用户数据目录；歌单、收藏与设置将始终被清除」。承认现状即产品意图，消除误导。
2. **真保留**：`deleteData=false` 时不动 DB 行，仅删 `users` 行会让外键悬空——需要同时决定"同名用户重建是否恢复旧数据"。这会引入"换密码重建同名账号即继承旧歌单"的语义争议，需谨慎。
3. 折中：保留 `snapshots`/`user_settings` 到归档表（如 `deleted_user_data`），提供管理员导出入口。

无论选哪条，`syncUsersToDatabase` 的 `removeMissing` 都应该区分「显式删除账号」和「配置项消失」两种来源，否则第 2 种情况下的静默清空无法避免。

---

### P0-2 · 导入旧备份被自身裁剪逻辑秒删，接口仍返回成功

**位置**：`src/modules/list/snapshotDataManage.ts:60-69`、`src/modules/snapshotStorage.ts:73-117`

```ts
saveSnapshotWithTime = async (name, data, time) => {
  // …INSERT 的 created_at 用的是调用方传入的 time（通常来自备份文件 mtime）
  getDb().run('INSERT OR REPLACE INTO snapshots (id, user_name, module, data, size, created_at) VALUES (?,?,?,?,?,?)',
    [name, userName, module, data, Buffer.byteLength(data), time || Date.now()])
  pruneSnapshots(userName, module)   // ← 紧接着裁剪
}
```

`pruneSnapshots` 按 `ORDER BY created_at DESC, id DESC` 保留最近的 `maxSnapshots` 条（`snapshotStorage.ts:35-37`、`101-105`）。

当历史快照数量已达上限时，导入一条 `created_at` 很旧的行 → 它排在最后 → 当场被自己触发的 prune 删掉。

**实测**：

```
A1 导入前快照数: 10
A2 导入旧 mtime 后，imported-old-backup 是否还在: false | 剩余: 10
A3 对照组（created_at=now）是否还在: true
```

用户视角：上传一个旧备份 → 接口 200 → 列表里没有 → 再传一次还是"成功"。

**修复建议**：

- 导入路径不要复用"按时间排序"的裁剪。给 `saveSnapshotWithTime` 加一个 `{ protect: true }` 选项，让 `pruneSnapshots` 跳过本次插入的 id（`latest_id` 已有类似保护，`snapshotStorage.ts:97-99`）。
- 或者：把 `created_at` 与"导入时间"分离（新增 `imported_at` 列），排序键改用 `created_at`，裁剪键用 `imported_at`。
- 至少要校验删除结果：`pruneSnapshots` 后检查本次 id 是否仍存在，不存在则返回明确失败。

---

## 四、P1

### P1-1 · 自定义音源沙箱可零成本逃逸

**位置**：`src/server/userApi.ts:559-598`、`Dockerfile:59`

注释写着「Do not expose the host crypto module or other native capabilities」（`userApi.ts:587`），`codeGeneration: { strings: false, wasm: false }` 也给人已隔离的印象。但 `vm` 的隔离在 Bun/Node 里不成立于"宿主函数对象"这一层——`console.*`、`Buffer`、`atob`、`lx.*` 全是宿主对象，其 `.constructor` 就是宿主 realm 的 `Function`。

**实测**（与 `userApi.ts` 相同的 sandbox 构造）：

```
Function via host fn constructor => object    # console.log.constructor("return process")()
process.env dump => 215                       # 宿主环境变量数量
require via Buffer => object                  # Buffer.constructor("return process")().mainModule
globalThis escape => object
```

AGENTS.md 已把"VM 可取得宿主能力"列为接受风险，但那段措辞暗示需要费些力气；实际是**复制一行代码**。叠加 `Dockerfile:59` 的 `USER root`，后果从"沙箱失效"变成"root 级代码执行"。

**建议**：

1. **容器降权**（30 分钟，收益最大）：`runner` 建非 root 用户并 `USER`，`--read-only` 根文件系统 + 四个数据卷可写。
2. 不再投喂 `Buffer`：脚本若需要二进制，用 base64 字符串过边界。能把"一行逃逸"抬到不显然的门槛（但仍不是隔离）。
3. 至少改掉 `userApi.ts:587` 那行注释——它会误导后续维护者。
4. 文档表述改为「安装自定义音源 = 授予该脚本服务器完全控制权」，让使用者自己决定是否信任。

### P1-2 · `bun test` 写入真实 `data/` 目录

**位置**：`tests/cache_routes.test.ts:30-32`

```ts
logPath: process.cwd(),
dataPath: process.cwd(),   // ← 根因
userPath: process.cwd(),
```

`beforeEach` 确实调了 `initDatabase(':memory:')`，但 `getDb()` 在单例被 `closeDb()` 后再被调用会走无参路径 → `getDbPath()` → `${global.lx.dataPath}/yun-yin.db` = 仓库内真实库。

**实测**（三次独立复现）：

```
全量 bun test:                       6ef58f3a… → 4911005e…
仅 tests/cache_routes.test.ts:       4911005e… → edb82822…   ← 单文件即复现
对照 tests/user_routes.test.ts:      edb82822… → edb82822…   ← 无变化
```

实际污染：`admin_sessions` 30 → 31（多一条测试签发的管理员会话），`users`/`snapshots`/`cache_index` 未丢。

按 P1 而非 P2 处理，因为机制上只差一个用例：`database.test.ts` 的 `restoreDatabaseSnapshot` 会 `DELETE FROM` 全表再灌入备份——一旦某次重构让它落到默认库，开发者本地数据会被直接清空。

**建议**：fixture 改用 `fs.mkdtempSync`（同文件第 486 行已这么做，只是 fixture 没跟上）；再在 `initDatabase()` 加 `NODE_ENV === 'test'` 守卫，拒绝打开非 `:memory:`、非临时目录的库，让污染变成响亮的失败。

### P1-3 · 备份上传在内存中持有 3 份完整副本

**位置**：`src/server/core/context.ts:323-337`、`src/server/routes/system.ts:688`

`formData()` 的实现是：读出完整 `bytes` → 塞进 `new Request(..., { body: bytes }).formData()` → 平台解析再持有一份 → handler 里 `file.arrayBuffer()` 第三份。

`maxRequestBodySize` 是 100MB（`server.ts:19`），而容器内存预算按 256MiB 档计算（`resourceBudget.ts:6-15`）。一次 100MB 备份上传的峰值接近 300MB，256MB 容器会先 OOM 而不是先拒绝。

**建议**：备份上传改流式落盘（`Bun.file` 的 `writer` + 边读边写临时文件），或者把该路由的 `maxBytes` 压到容器额度的 1/4 并在文档里写明上限。

### P1-4 · `gzipSync` 同步压缩阻塞事件循环

**位置**：`src/server/core/index.ts:180-205`

```ts
if (!canBuffer) { /* 流式 gzip —— 正确 */ }
const body = new Uint8Array(await response.arrayBuffer())
const compressed = Bun.gzipSync(body)          // ← 同步，最大 32MiB
```

`COMPRESS_MAX_BUFFER_BYTES = 32MiB`，走 `gzipSync` 同步压缩。一个 16MiB 的 JSON 导出足以让事件循环停住数百毫秒，期间所有请求（包括 SSE 心跳与播放中继）都会卡住。

（音频不受影响：`COMPRESSIBLE_TYPE` 只覆盖 `text/`、`application/json|javascript|xml`、`image/svg+xml`，`audio/*` 不在其中——这一点是正确的。）

**建议**：把缓冲压缩上限降到 1–2MiB（超过就直接流式），或改用 `Bun.gzip` 异步版本。

### P1-5 · 原子写临时文件无孤儿清理

**位置**：`src/server/serverDownloadQueue.ts:334-342`

`unlink(tempFile)` 只在 catch 分支执行。进程被 `SIGKILL`、OOM Killer 杀或断电时，临时文件永久留下；全仓没有任何 `readdir` + `endsWith('.tmp')` 的清理逻辑。

现场证据：`data/server-download-queue.json.33292.1791039201827.b457eee26c1.tmp`，0 字节，时间 10-03，至今仍在。

**建议**：`loadTasks()` 之前扫同目录下 `${basename}.*.tmp` 并删除。

### P1-6 · `formatDuration` 把 1001~4999 秒当成毫秒

**位置**：`frontend/shared/src/runtime.ts:51-56`

```ts
const totalSeconds = Math.floor(numeric > 1000 ? numeric / 1000 : numeric)
```

阈值是 `> 1000` 而非 `>= 1000`，且假设"大于 1000 一定是毫秒"。

**实测**：

```
   999 => 16:39     ✅
  1000 => 16:40     ✅
  1001 => 00:01     ❌ 应为 16:41
  1500 => 00:01     ❌ 应为 25:00
  2500 => 00:02     ❌ 应为 41:40
 60000 => 01:00     ✅（毫秒）
```

影响所有 16:41 以上时长的音频——播客、有声书、长现场版。这个函数被时长列、进度、总时长共用（`components.tsx:132,452`、`heavy_views.tsx:288`、`types.ts:165`）。

**建议**：改用显式单位参数，或在调用方归一化。若必须保留启发式，阈值提到 `>= 3600 * 1000`（一小时以上才可能是毫秒），并把 `>= 1000` 修掉。

### P1-7 · 默认配置下 `/api/music/download` 是匿名的任意公网 URL 中继

**位置**：`src/server/routes/cache.ts:1488-1497`、`src/defaultConfig.ts:38`、`src/server/routes/index.ts:27`

```ts
router.get('/api/music/download', (ctx) => {
  const urlStr = ctx.query.get('url')              // ← 任意公网 URL
  const filename = (ctx.query.get('filename') || 'download.mp3').slice(0, 255)
  // 没有任何 verifyUserAuth / verifyAdminAuth
```

该端点唯一的门是 `/api/music` 前缀的播放器鉴权中间件，而它在 `player.enableAuth` 为 false 时直接 `next()`——`defaultConfig.ts:38` 里这个开关**默认就是 false**。SSRF 防护（`assertSafeRemoteHttpUrl`）只拦内网，不限制目标域名。

**影响**：公开部署的实例会变成一台开放代理。匿名者可以让服务器以自己的 IP 下载任意公网资源（单请求上限 500MB），用于绕过目标站对攻击者 IP 的封禁、白嫖带宽与磁盘。配额是 per-IP 4 并发 / 240 请求 / 2GB per 10min、全局 64 / 1200 / 8GB——这挡住了"打爆"，但没挡住"长期白用"，而且会挤占正常用户的下载额度。

`inline=1` 分支只允许 audio/video/image 且带 `CSP: sandbox; default-src 'none'` + `nosniff`，所以不构成存储型 XSS，这一点是正确的。

**建议**：给该端点加"已登录用户或一次性签名"，把 `url` 限制为服务端刚解析出的歌曲地址（下发短时 token 绑定 songmid），或至少做音源 CDN 域名白名单。这是代理型端点的标准做法，不影响正常播放链路。

> `/api/config/test-proxy`（`system.ts:622-645`）有同类缺口：`normalizeProxyAddress`（`:139-159`）只校验协议和形状，允许 `http://127.0.0.1:6379`、`socks5://10.0.0.5:1080`，管理员可以让服务器连接内网地址并回显状态码/耗时。因为前置条件是 admin session（且 admin 本就能改 `proxy.all.address`），只算纵深缺口，列入 P2。

---

## 五、P2

| 位置 | 问题 | 建议 |
| :--- | :--- | :--- |
| `src/server/core/index.ts:147` | 压缩缓存 key 只含 `pathname + etag`，不含 query；`?folder=cache` / `?folder=music` 理论上可撞 key（用户身份在路径里，不会跨用户串号） | key 里加 `ctx.url.search` |
| `src/server/core/context.ts:129-141` | 反代漏传 `X-Forwarded-Proto` 时静默降级为无 `Secure` 的 session cookie | 启动时若 `BIND_IP=0.0.0.0` 且未配 `proxy.trustedAddresses`，打印明确提示 |
| `frontend/styles/player.css` `admin.css` | `player.css` 13,031 行 / 396KB，`:root` 定义 7 次、`.react-player-footer#player-footer` 9 次；61 处纯硬编码颜色（player 40 / admin 21），其中 `.admin-react-*` 区块的 `rgba(255,255,255,.42)`、`#0f6b4a` 是 React 实际在用的 | 合并 `:root` 为单层 token，再替换灰度硬编码 |
| `frontend/player/src/react/store/sleep.ts:25-36` | `remaining > 0` 分支不重排 `setTimeout`；系统时间回拨或定时器提前触发时，睡眠定时器静默失效（正常路径由一次性定时器兜底，能暂停） | 该分支重新调度，或把倒计时移出对话框组件（现在 interval 在 `SleepTimerDialog` 内，关闭后剩余时间不再刷新） |
| `.gitignore` 倒数第 2 行 | 原始字节为 `b u i l d / `（字符间与行尾有空格），匹配不到任何东西，推测本意 `build/` | 改为 `build/` |
| `src/modules/snapshotStorage.ts:102` | keep 已满后用 `continue` 而非 `break`，多余迭代（结果正确） | 改 `break` |
| `src/index.ts:430` | ESM 模块里用 `require('@/user')`，能跑但风格割裂 | 改 `await import` |
| `src/server/routes/system.ts:139-159` | `normalizeProxyAddress` 无私网校验，admin 可探测内网端口（详见 P1-7 附注） | 复用 `isPrivateAddress` 校验，内网需显式开关 |
| `src/server/routes/system.ts:256-264` | `require(configPath)` 直接执行 data 目录下的 JS；`configLoader.ts:26` 的 vm 沙箱注入完整 `process.env` | 统一走 `JSON.parse`；沙箱不要注入 `process.env` |
| `src/server/networkSecurity.ts:65-89` | 「合成 DNS 地址」（198.18/15、2001:2::/48）无条件放行，直连模式下也放行，是过滤规则的缺口 | 仅当确实走代理时才允许 |
| `src/server/core/index.ts:47-66` | 安全头齐全但没有 HSTS | 由 Bun 终止 TLS 时加 `max-age=31536000` |
| `src/server/routes/auth.ts:191-197` | 用户名不存在时不跑 scrypt，响应时间可区分用户名是否存在（限流已大幅缓解） | 统一先做一次 dummy scrypt |
| 测试覆盖 | 后端路由/安全/资源预算扎实（39 文件）；前端以数据层与生命周期为主，**动效与视觉规范没有自动化断言** | 规范目前只能靠 review 守住 |

---

## 六、做对了什么（建议保留）

以下每条都对应一处常见项目的真实漏洞，这里都做了正确选择：

1. **路径安全双层**。`src/utils/pathSecurity.ts:29-83` 词法边界 + 对"最近的已存在祖先"逐级 `realpath`，专门堵符号链接；静态资源另有一道敏感文件黑名单（`static.ts:17-22`）。
2. **SSRF 是"钉扎"级的**。`networkSecurity.ts:436-475` 解析一次 DNS 并把结果固定进自定义 `lookup`，防重绑定；重定向逐跳重新校验、上限 5 次（`music.ts:127-165`）；私网段覆盖 CGNAT、benchmark、6to4、IPv4-mapped IPv6；响应同时限制线上字节与解压后字节，挡解压炸弹。
3. **会话不存明文**。三个域都只落 `sha256(sessionId)`，且坚持 SQLite 为准、进程缓存不作授权依据；数据库异常时 **fail closed**。
4. **密码与限流**。scrypt + `timingSafeEqual`；登录失败按 IP + 域限流，主存储走 SQLite（多实例共享），内存 Map 仅作兜底，并有两级上限。
5. **备份恢复防投毒**。`database/index.ts:273-351` 不只 `quick_check`，还校验 schema 方向、用户名的路径安全、`password_hash` 的 scrypt 形状、配置值范围；恢复后主动清空全部 session，防止旧备份复活已登出的凭据。
6. **请求体预算**。全局 128MB 缓冲额度 + 路由级 `maxBytes`，超限立刻 `reader.cancel()` 并归还额度；`formData` 也走同一条受限通道。
7. **快照上限用字节**。`snapshotStorage.ts:30` 用 `Buffer.byteLength`，中文不会被少算 3 倍；数量 + 总量双上限，且永不裁剪 `latest` 指针。
8. **前端规范执行度高**。全仓 0 处 `transition: all`、0 处 `key={index}`，`prefers-reduced-motion` 覆盖 4 个样式入口，聚焦提示统一 `inset 0 0 0 1px`。

---

## 七、建议执行顺序

| 顺序 | 动作 | 预期耗时 |
| :-- | :--- | :--- |
| 1 | P0-1：澄清 `deleteData` 语义 + 修 UI 文案（或改造为真保留） | 1–3 h |
| 2 | P0-2：导入快照豁免本次裁剪，并校验删除结果 | 1 h |
| 3 | P1-6：修 `formatDuration` 阈值（1 行） | 10 min |
| 4 | P1-2：测试 fixture 改临时目录 + `initDatabase` 测试守卫 | 20 min |
| 5 | P1-1：容器改非 root + 可写目录白名单；改掉误导注释 | 40 min |
| 6 | P1-5：启动清理孤儿 `.tmp` | 15 min |
| 7 | P1-3 / P1-4：备份上传流式化、压缩上限下调 | 2 h |
| 8 | P1-7：`/api/music/download` 加签名或域名白名单 | 2 h |
| 9 | P2 各项（`test-proxy` 内网校验、配置读取去 `require` 优先） | 按需 |

---

## 八、一句话评价

这是一个"作者知道自己每个决定为什么这么做"的项目——`context.ts` 里请求体预算的注释、`networkSecurity.ts` 里合成 DNS 地址的注释、`database/index.ts` 里备份投毒的注释，都在解释**为什么**而不只是**是什么**，这在自建项目里很少见。

两个 P0 也都不是"写错了"，而是**参数语义与产品承诺脱节**：`deleteData` 叫"删数据"却只删目录；`created_at` 承担了"历史顺序"与"导入文件时间"两个互相冲突的职责。修它们不需要重构，只需要重新确认这两个名字到底该代表什么。
