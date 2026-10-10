# 云鹿音乐

云鹿音乐是一套部署在自己服务器上的 Web 音乐播放器。打开浏览器即可搜索并播放音乐、查看歌词、整理歌单与收藏，也可以访问服务器上的本地音乐；管理员通过配套后台管理账户、音源与实例设置。

播放器和管理后台作为同一个实例运行，账户与播放数据由实例保存。项目当前面向浏览器使用，不提供旧版 LX 客户端同步、WebSocket 同步、Subsonic / OpenSubsonic 或 WebDAV 服务。

## 产品界面

以下为已部署 Web 播放器的真实页面截图。桌面页面保留左侧功能导航和底部播放器；播放列表、下载任务以侧边面板呈现，歌词页提供独立的沉浸式视图。

![云鹿音乐首页，展示最近播放内容、左侧功能导航和底部播放器](docs/assets/screenshots/home.jpg)

| 发现歌单 | 音乐搜索 |
| --- | --- |
| ![歌单广场页面，展示可发现的歌单](docs/assets/screenshots/discover.jpg) | ![音乐搜索页面，包含搜索框、音源选择和热门搜索](docs/assets/screenshots/search.jpg) |

| 排行榜 | 我的收藏 |
| --- | --- |
| ![排行榜页面，展示歌曲排名与专辑信息](docs/assets/screenshots/leaderboard.jpg) | ![我喜欢的音乐页面，展示已收藏歌曲](docs/assets/screenshots/favorites.jpg) |

| 服务器本地音乐 | 缓存与下载 |
| --- | --- |
| ![本地音乐库，展示歌曲时长、文件大小和格式](docs/assets/screenshots/local-music.jpg) | ![缓存与下载侧边面板，展示歌曲任务和下载进度](docs/assets/screenshots/downloads.jpg) |

| 播放队列 | 沉浸式歌词 |
| --- | --- |
| ![播放列表侧边面板，展示当前歌曲队列](docs/assets/screenshots/queue.jpg) | ![全屏歌词页面，展示歌曲封面、播放控制和歌词](docs/assets/screenshots/lyrics.jpg) |

## 听音乐与管理资料

- **搜索与播放**：在已分配且启用的音源中搜索歌曲，在线播放并查看歌词。
- **整理个人音乐**：维护歌单、收藏、最近播放与播放队列。
- **本地音乐**：播放服务器上的本地音乐，并管理主动下载到本地库的歌曲。
- **管理实例**：在管理后台维护用户、音源、配置、快照、本地备份、日志和服务状态。
- **自托管**：使用 Docker Compose 部署，数据目录由你选择和管理。

## 部署

准备 Docker Compose 文件：

```yaml
services:
  yun-yin:
    image: ghcr.io/biaobiaobiao108/yun-music:latest
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

启动服务并查看日志：

```bash
docker compose up -d
docker compose logs -f yun-yin
```

访问地址：

- 播放器：`http://服务器地址:9527/music`
- 管理后台：`http://服务器地址:9527/`
- 健康检查：`http://服务器地址:9527/healthz`

`FRONTEND_PASSWORD` 是必填的管理员密码，请替换成高强度随机值。`LX_USER_admin` 会创建初始播放器账户，同样应换成独立的强密码。也可以在 `.env` 中设置 `PUID` 和 `PGID`，让容器使用专用的宿主机 UID/GID；请确保挂载目录对该身份可读写。生产环境建议经由 HTTPS 反向代理访问。

## 数据由你保存

Compose 将应用数据分别挂载到宿主机目录，便于按需备份或迁移：

| 目录 | 内容 |
| --- | --- |
| `data/` | SQLite 数据库与实例配置 |
| `cache/` | 可重新获取的播放缓存与歌词 |
| `music/` | 主动下载或整理的本地音乐，不受缓存清理策略影响 |
| `cover_cache/` | 封面缓存 |

用户、会话、设置、歌单/黑名单快照元数据和缓存索引保存在 SQLite 中。密码以 scrypt 哈希保存；浏览器认证使用 HttpOnly、SameSite Cookie。备份和实例目录应放在受控位置，不要公开数据库、配置、会话 Cookie 或日志。

## 当前产品范围

云鹿音乐当前提供浏览器播放器和管理后台。旧的 LX 设备同步、Subsonic / OpenSubsonic、WebDAV、同步 Token 和旧密码请求头接口已移除，不要将本项目配置为这些旧客户端或协议的服务端。

## 从源码运行

需要 Bun 1.4.3 或更新版本：

```bash
bun install
bun run build:frontend
bun start
```

开发时可以运行：

```bash
bun run dev
bun run dev:frontend
```

前端源码位于 `frontend/`，由 Bun Bundler 编译到 `public/`。播放器和管理后台使用 React、TypeScript 与 Zustand，服务端使用 Bun、TypeScript 和 `bun:sqlite`。

## 许可证

本项目基于 [Apache-2.0 License](./LICENSE) 协议分发。
