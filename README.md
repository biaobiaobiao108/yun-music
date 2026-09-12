# 云音

云音是一个面向现代浏览器的 Web 音乐播放器与管理后台。项目使用 Bun、TypeScript、原生 DOM 和 SQLite，提供搜索、播放、歌词、歌单、收藏、缓存、本地音乐、自定义音源、用户管理、快照、配置、日志和服务状态。

项目已经收敛为 Web-only 产品，不再支持 LX 桌面/移动端同步协议、WebSocket 同步、Subsonic、WebDAV 或其他旧第三方接口。旧接口会返回明确的 `404` 或 `410`，旧数据库不会自动迁移。

## 特性

- 原生 `Bun.serve`、Web 标准 `Request` / `Response` 和同源 HTTP API。
- Web 播放器：音乐搜索、在线播放、歌词、队列、歌单、收藏、缓存、本地音乐和自定义音源。
- 管理后台：用户、数据、快照、本地备份、配置、日志和运行状态。
- SQLite WAL：用户、会话、设置、快照元数据和缓存索引使用结构化存储。
- Cookie 会话：认证使用 HttpOnly、SameSite Cookie；密码以 scrypt 哈希保存，不写入浏览器存储或日志。
- 安全边界：同源策略、安全响应头、请求 ID、路径穿越防护、媒体 Range、流式下载和远程 URL 校验。
- Docker Alpine 多阶段镜像，生产进程按 root 用户运行。

## 快速开始

### Docker Compose

```yaml
services:
  yun-yin:
    image: ghcr.io/biaobiaobiao108/lxserver:latest
    container_name: yun-yin
    restart: always
    ports:
      - "9527:9527"
    volumes:
      - ./data:/server/data
      - ./cache:/server/cache
      - ./music:/server/music
      - ./cover_cache:/server/cover_cache
    environment:
      NODE_ENV: production
      FRONTEND_PASSWORD: replace-with-a-strong-admin-password
      LX_USER_admin: replace-with-a-strong-user-password
```

启动并查看日志：

```bash
docker compose up -d
docker compose logs -f yun-yin
```

容器按 root 用户运行，可直接使用宿主机挂载目录的权限。生产环境建议同时使用只读根文件系统，并仅将 `/server/data`、`/server/cache`、`/server/music` 和 `/server/cover_cache` 作为可写目录挂载。

### Bun 源码运行

```bash
bun install
bun run build:frontend
bun start
```

开发模式：

```bash
bun run dev
bun run dev:frontend
```

默认地址：

- 管理后台：`http://localhost:9527/`
- Web 播放器：`http://localhost:9527/music`
- 健康检查：`http://localhost:9527/healthz`
- 就绪检查：`http://localhost:9527/readyz`

## 配置

管理密码必须通过 `FRONTEND_PASSWORD` 或运行时配置设置，不能是空密码或示例弱密码。首次初始化用户可使用 `LX_USER_<username>` 环境变量，例如：

```dotenv
FRONTEND_PASSWORD=replace-with-a-strong-admin-password
LX_USER_alice=replace-with-a-strong-user-password
PORT=9527
BIND_IP=0.0.0.0
DATA_PATH=/server/data
PLAYER_PATH=/music
ADMIN_PATH=
SERVER_NAME=yun-yin
SINGER_SOURCE_PRIORITY=tx,wy
```

可用配置类别包括：网络监听、数据目录、管理员与用户认证、播放器访问控制、公开访问限制、缓存限制、快照数量、代理和音源优先级。`config.js` 可由实例挂载到 `DATA_PATH`，用户列表不写入该文件，而是由 SQLite 管理。

播放器与管理后台均为同源应用，浏览器请求不需要也不接受 `x-user-password`、`x-user-token`、`x-frontend-auth` 或旧同步 Token。

## 数据与实例重置

实例首次启动会创建全新 SQLite schema（当前版本 3），不迁移旧数据库。若目录中检测到旧 schema，服务会停止并提示重置；不会在启动时静默删除用户数据。

显式重置只允许清理以下四个实例目录：`data/`、`cache/`、`music/`、`cover_cache/`。确认前请停止服务并做好备份：

```bash
bun run reset:instance -- --confirm
```

本地备份下载/上传属于管理后台能力，备份文件不依赖 WebDAV。备份包含配置、用户数据和数据库相关文件；请将备份存放在受控位置。

## HTTP API 边界

浏览器业务 API 保留在 `/api/` 下，并由同源 Cookie 会话保护。服务不再提供：

- LX 客户端同步握手和 WebSocket 升级；
- `/rest/*` Subsonic / OpenSubsonic；
- `/api/webdav/*`、WebDAV 自动同步和远程备份任务；
- 旧的密码请求头、同步 Token 和设备密钥接口。

媒体文件继续支持受保护的 Range 请求、流式传输和缓存队列。静态 hash 资源使用长期 immutable 缓存，HTML 与运行时配置使用 no-cache，并支持 ETag / 304 / HEAD。

## 开发检查

```bash
bun run tsc --noEmit
bun test
bun run build:frontend
bun run check:frontend-assets
bun run build
```

前端源码位于 `frontend/`，`public/` 只保存服务发布产物；不要手工修改 JavaScript/CSS 编译文件。前端使用原生 DOM，不引入 React、Vue 或运行时 Web 框架。

## 部署建议

- 使用 HTTPS 反向代理，并透传 `Host`、真实 IP 和 `X-Forwarded-Proto`。
- 管理后台和用户密码使用密码管理器生成的高强度随机值。
- 将 `data/`、`cache/`、`music/`、`cover_cache/` 分开备份，并限制宿主机权限。
- 容器运行时按 root 用户运行，并启用只读根文件系统和受限临时目录；需要写入的目录显式挂载。
- 不要把数据库、配置文件、会话 Cookie 或日志暴露到公共静态目录。

## 许可证

本项目基于 [Apache-2.0 License](./LICENSE) 协议分发。
